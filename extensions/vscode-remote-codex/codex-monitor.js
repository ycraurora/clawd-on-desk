const path = require("path");

const APPROVAL_HEURISTIC_MS = 2000;
const MAX_TRACKED_FILES = 50;
const MAX_PARTIAL_BYTES = 65536;
const FALLBACK_HOME_CANDIDATES = [
  "/root",
  "/home/vscode",
  "/home/node",
  "/home/coder",
  "/home/codespace",
  "/home/gitpod",
  "/home/openai",
];

const LOG_EVENT_MAP = {
  "session_meta": "idle",
  "event_msg:task_started": "thinking",
  "event_msg:user_message": "thinking",
  "event_msg:agent_message": null,
  "event_msg:exec_command_end": "working",
  "event_msg:patch_apply_end": "working",
  "event_msg:custom_tool_call_output": "working",
  "response_item:function_call": "working",
  "response_item:custom_tool_call": "working",
  "response_item:web_search_call": "working",
  "event_msg:task_complete": "codex-turn-end",
  "event_msg:context_compacted": "sweeping",
  "event_msg:turn_aborted": "idle",
};

function normalizePosixDir(input) {
  if (typeof input !== "string") return "";
  const trimmed = input.trim();
  if (!trimmed) return "";
  const normalized = trimmed.replace(/\\/g, "/");
  return normalized.startsWith("/") ? normalized.replace(/\/+$/, "") : `/${normalized.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

function buildSessionRootCandidates(overrides, options = {}) {
  const seen = new Set();
  const roots = [];
  const preferredHome = normalizePosixDir(options.preferredHome || "");
  const add = (value) => {
    const normalized = normalizePosixDir(value);
    if (!normalized) return;
    const full = normalized.endsWith("/.codex/sessions") ? normalized : `${normalized}/.codex/sessions`;
    if (seen.has(full)) return;
    seen.add(full);
    roots.push(full);
  };

  add(preferredHome);
  if (Array.isArray(overrides)) {
    for (const entry of overrides) add(entry);
  }
  for (const home of FALLBACK_HOME_CANDIDATES) add(home);
  return roots;
}

function extractSessionId(fileName) {
  const base = String(fileName || "").replace(/\.jsonl$/i, "");
  const parts = base.split("-");
  if (parts.length < 10) return null;
  return parts.slice(-5).join("-");
}

function getRecentDateParts(now = new Date(), count = 3) {
  const result = [];
  for (let daysAgo = 0; daysAgo < count; daysAgo++) {
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    result.push({
      yyyy: String(d.getFullYear()),
      mm: String(d.getMonth() + 1).padStart(2, "0"),
      dd: String(d.getDate()).padStart(2, "0"),
    });
  }
  return result;
}

class CodexBridgeMonitor {
  constructor(options) {
    this._readDir = options.readDir;
    this._stat = options.stat;
    this._readFile = options.readFile;
    this._postState = options.postState;
    this._log = options.log || (() => {});
    this._sessionRoots = Array.isArray(options.sessionRoots) ? options.sessionRoots.slice() : [];
    this._pollIntervalMs = options.pollIntervalMs || 1500;
    this._sessionIdPrefix = options.sessionIdPrefix || "codex:vscode";
    this._startedAtMs = Date.now();
    this._interval = null;
    this._tracked = new Map();
    this._activeRoot = null;
    this._lastNoRootLogAt = 0;
    this._hasLoggedSuccessfulPoll = false;
  }

  start() {
    if (this._interval) return;
    this._startedAtMs = Date.now();
    this._log(`remote-codex monitor start interval=${this._pollIntervalMs}ms roots=${this._sessionRoots.join(", ")}`);
    this._poll().catch(() => {});
    this._interval = setInterval(() => {
      this._poll().catch(() => {});
    }, this._pollIntervalMs);
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    for (const tracked of this._tracked.values()) {
      if (tracked.approvalTimer) clearTimeout(tracked.approvalTimer);
    }
    this._tracked.clear();
    this._log("remote-codex monitor stopped");
  }

  async _poll() {
    const root = await this._resolveSessionRoot();
    if (!root) {
      const now = Date.now();
      if (now - this._lastNoRootLogAt > 30000) {
        this._lastNoRootLogAt = now;
        this._log(`remote-codex session root not found yet; probed ${this._sessionRoots.length} candidates`);
      }
      return;
    }

    const dayDirs = getRecentDateParts(new Date(), 3)
      .map(({ yyyy, mm, dd }) => path.posix.join(root, yyyy, mm, dd));

    let sawAnyTrackedFile = false;
    for (const dir of dayDirs) {
      let files;
      try {
        files = await this._readDir(dir);
      } catch {
        continue;
      }
      const now = Date.now();
      for (const file of files) {
        const name = typeof file === "string" ? file : file && file.name;
        if (!name || !name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
        sawAnyTrackedFile = true;
        const filePath = path.posix.join(dir, name);
        if (!this._tracked.has(filePath)) {
          try {
            const stat = await this._stat(filePath);
            if (now - stat.mtimeMs > 120000) continue;
          } catch {
            continue;
          }
        }
        await this._pollFile(filePath, name);
      }
    }

    if (sawAnyTrackedFile && !this._hasLoggedSuccessfulPoll) {
      this._hasLoggedSuccessfulPoll = true;
      this._log(`remote-codex found rollout files under ${root}`);
    }
    this._cleanStaleFiles();
  }

  async _resolveSessionRoot() {
    if (this._activeRoot) return this._activeRoot;
    for (const candidate of this._sessionRoots) {
      try {
        this._log(`remote-codex probing root: ${candidate}`);
        await this._readDir(candidate);
        this._activeRoot = candidate;
        this._log(`remote-codex root detected: ${candidate}`);
        return candidate;
      } catch (err) {
        this._log(`remote-codex root miss: ${candidate} (${err && err.message ? err.message : "unavailable"})`);
      }
    }
    return null;
  }

  async _pollFile(filePath, fileName) {
    let tracked = this._tracked.get(filePath);
    if (!tracked) {
      const sessionId = extractSessionId(fileName);
      if (!sessionId) return;
      if (this._tracked.size >= MAX_TRACKED_FILES) {
        this._cleanStaleFiles();
        if (this._tracked.size >= MAX_TRACKED_FILES) return;
      }
      tracked = {
        offset: 0,
        sessionId: `${this._sessionIdPrefix}:${sessionId}`,
        cwd: "",
        lastEventTime: Date.now(),
        lastState: null,
        partial: "",
        hadToolUse: false,
      };
      this._tracked.set(filePath, tracked);
      this._log(`remote-codex tracking file: ${filePath} -> ${tracked.sessionId}`);
    }

    let buf;
    try {
      buf = Buffer.from(await this._readFile(filePath));
    } catch {
      return;
    }
    if (buf.length <= tracked.offset) return;

    const text = tracked.partial + buf.slice(tracked.offset).toString("utf8");
    tracked.offset = buf.length;
    const lines = text.split("\n");
    const remainder = lines.pop() || "";
    tracked.partial = remainder.length > MAX_PARTIAL_BYTES ? "" : remainder;

    for (const line of lines) {
      if (!line.trim()) continue;
      this._processLine(line, tracked);
    }
  }

  _processLine(line, tracked) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }

    if (obj && typeof obj.timestamp === "string") {
      const ts = Date.parse(obj.timestamp);
      if (Number.isFinite(ts) && ts < this._startedAtMs - 1500) return;
    }

    const type = obj.type;
    const payload = obj.payload;
    const subtype = payload && typeof payload === "object" ? payload.type || "" : "";
    const key = subtype ? `${type}:${subtype}` : type;

    if (type === "session_meta" && payload) {
      tracked.cwd = payload.cwd || tracked.cwd || "";
    }

    if (key === "event_msg:exec_command_end" || key === "response_item:function_call_output") {
      if (tracked.approvalTimer) {
        clearTimeout(tracked.approvalTimer);
        tracked.approvalTimer = null;
      }
    }

    const state = LOG_EVENT_MAP[key];
    if (state === undefined || state === null) return;

    if (key === "event_msg:task_started") tracked.hadToolUse = false;
    if (key === "response_item:function_call") tracked.hadToolUse = true;

    if (state === "codex-turn-end") {
      if (tracked.approvalTimer) {
        clearTimeout(tracked.approvalTimer);
        tracked.approvalTimer = null;
      }
      const resolved = tracked.hadToolUse ? "attention" : "idle";
      tracked.hadToolUse = false;
      tracked.lastState = resolved;
      tracked.lastEventTime = Date.now();
      this._log(`remote-codex state ${tracked.sessionId}: ${resolved} via ${key} cwd=${tracked.cwd || "-"}`);
      this._postState(tracked.sessionId, resolved, key, {
        cwd: tracked.cwd,
      });
      return;
    }

    if (key === "response_item:function_call") {
      if (tracked.approvalTimer) clearTimeout(tracked.approvalTimer);
      const cmd = this._extractShellCommand(payload);
      if (cmd) {
        if (this._isExplicitApprovalRequest(payload)) {
          tracked.lastEventTime = Date.now();
          this._log(`remote-codex permission ${tracked.sessionId}: immediate notification command=${cmd}`);
          this._postState(tracked.sessionId, "notification", "codex-permission", {
            cwd: tracked.cwd,
            permissionDetail: { command: cmd, rawPayload: payload },
          });
          return;
        }
        tracked.approvalTimer = setTimeout(() => {
          tracked.approvalTimer = null;
          tracked.lastEventTime = Date.now();
          this._log(`remote-codex permission ${tracked.sessionId}: heuristic notification command=${cmd}`);
          this._postState(tracked.sessionId, "notification", "codex-permission", {
            cwd: tracked.cwd,
            permissionDetail: { command: cmd, rawPayload: payload },
          });
        }, APPROVAL_HEURISTIC_MS);
      }
    }

    if (state === tracked.lastState && state === "working") return;
    tracked.lastState = state;
    tracked.lastEventTime = Date.now();
    this._log(`remote-codex state ${tracked.sessionId}: ${state} via ${key} cwd=${tracked.cwd || "-"}`);
    this._postState(tracked.sessionId, state, key, {
      cwd: tracked.cwd,
    });
  }

  _cleanStaleFiles() {
    const now = Date.now();
    for (const [filePath, tracked] of this._tracked) {
      if (now - tracked.lastEventTime > 300000) {
        if (tracked.approvalTimer) clearTimeout(tracked.approvalTimer);
        this._tracked.delete(filePath);
        this._log(`remote-codex stale cleanup: ${tracked.sessionId} from ${filePath}`);
      }
    }
  }

  _extractShellCommand(payload) {
    if (!payload || typeof payload !== "object") return "";
    const name = String(payload.name || "");
    if (name !== "shell_command" && name !== "exec_command") return "";
    const args = payload.arguments;
    let parsed = args;
    if (typeof args === "string") {
      try {
        parsed = JSON.parse(args);
      } catch {
        return "";
      }
    }
    if (!parsed || typeof parsed !== "object") return "";
    if (typeof parsed.command === "string" && parsed.command) return parsed.command;
    if (typeof parsed.cmd === "string" && parsed.cmd) return parsed.cmd;
    return "";
  }

  _isExplicitApprovalRequest(payload) {
    if (!payload || typeof payload !== "object") return false;
    let args = payload.arguments;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        return false;
      }
    }
    if (!args || typeof args !== "object") return false;
    return args.sandbox_permissions === "require_escalated" || typeof args.justification === "string";
  }
}

module.exports = {
  APPROVAL_HEURISTIC_MS,
  FALLBACK_HOME_CANDIDATES,
  LOG_EVENT_MAP,
  CodexBridgeMonitor,
  buildSessionRootCandidates,
  extractSessionId,
  getRecentDateParts,
  normalizePosixDir,
};
