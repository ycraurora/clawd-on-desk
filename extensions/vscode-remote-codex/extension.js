const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { CodexBridgeMonitor, buildSessionRootCandidates } = require("./codex-monitor");

const UI_FORWARD_STATE_COMMAND = "clawd.internal.forwardStateToApp";
const UI_BRIDGE_LOG_COMMAND = "clawd.internal.bridgeLog";
const REMOTE_LOG_PATH = path.join(os.homedir(), ".clawd-remote-codex.log");

let output = null;
let remoteMonitor = null;
let remoteMonitorKey = "";
let lastStatus = "not-started";

function localLog(line) {
  const message = `[${new Date().toISOString()}] ${line}`;
  if (output) output.appendLine(message);
  try {
    fs.appendFileSync(REMOTE_LOG_PATH, message + "\n", "utf8");
  } catch {}
}

function bridgeLog(line) {
  localLog(line);
  void vscode.commands.executeCommand(UI_BRIDGE_LOG_COMMAND, line).catch(() => {});
}

function getRemoteCodexConfig() {
  const config = vscode.workspace.getConfiguration("clawd.remoteCodex");
  const pollIntervalMs = Math.max(500, Number(config.get("pollIntervalMs", 1500)) || 1500);
  const sessionDirCandidates = config.get("sessionDirCandidates", []);
  return {
    enabled: config.get("enabled", true) !== false,
    pollIntervalMs,
    sessionDirCandidates: Array.isArray(sessionDirCandidates) ? sessionDirCandidates : [],
  };
}

function sanitizeSessionPrefixPart(input) {
  return String(input || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "remote";
}

function getRemoteIdentity() {
  const folders = vscode.workspace.workspaceFolders || [];
  const firstFolder = folders[0] || null;
  const workspaceName = firstFolder ? firstFolder.name : (vscode.workspace.name || "remote");
  const remoteName = vscode.env.remoteName || "workspace";
  const authority = firstFolder && firstFolder.uri ? firstFolder.uri.authority : remoteName;
  return {
    remoteName,
    authority,
    workspaceName,
  };
}

function stopRemoteMonitor() {
  if (remoteMonitor) {
    bridgeLog("stopping remote Codex monitor");
    remoteMonitor.stop();
    remoteMonitor = null;
  }
  remoteMonitorKey = "";
  lastStatus = "stopped";
}

function ensureRemoteMonitor() {
  const identity = getRemoteIdentity();
  const config = getRemoteCodexConfig();
  const defaultRoots = buildSessionRootCandidates(config.sessionDirCandidates, { preferredHome: os.homedir() });
  bridgeLog(`ensureRemoteMonitor remote=${identity.remoteName} authority=${identity.authority || "-"} enabled=${config.enabled} poll=${config.pollIntervalMs}ms roots=${defaultRoots.join(",")}`);

  if (!config.enabled) {
    bridgeLog("remote Codex monitor disabled by settings");
    stopRemoteMonitor();
    lastStatus = "disabled";
    return;
  }

  const nextKey = [
    identity.remoteName,
    identity.authority,
    config.pollIntervalMs,
    config.sessionDirCandidates.join("|"),
  ].join("::");
  if (remoteMonitor && remoteMonitorKey === nextKey) return;

  stopRemoteMonitor();

  const hostLabel = `${identity.remoteName}:${identity.workspaceName}`;
  const sessionIdPrefix = `codex:vscode:${sanitizeSessionPrefixPart(identity.authority || identity.remoteName)}`;
  remoteMonitor = new CodexBridgeMonitor({
    readDir: async (dir) => fs.promises.readdir(dir, { withFileTypes: true }),
    stat: async (filePath) => {
      const stat = await fs.promises.stat(filePath);
      return { size: stat.size, mtimeMs: stat.mtimeMs };
    },
    readFile: async (filePath) => fs.promises.readFile(filePath),
    sessionRoots: defaultRoots,
    pollIntervalMs: config.pollIntervalMs,
    sessionIdPrefix,
    log: bridgeLog,
    postState: (sessionId, state, event, extra) => {
      const payload = {
        state,
        session_id: sessionId,
        event,
        agent_id: "codex",
        cwd: extra && typeof extra.cwd === "string" ? extra.cwd : "",
        host: hostLabel,
      };
      if (extra && extra.permissionDetail && typeof extra.permissionDetail === "object") {
        payload.permissionDetail = extra.permissionDetail;
      }
      bridgeLog(`forwarding via command state=${payload.state} sid=${payload.session_id} event=${payload.event}`);
      void vscode.commands.executeCommand(UI_FORWARD_STATE_COMMAND, payload)
        .then((ok) => {
          bridgeLog(`forward result sid=${payload.session_id} state=${payload.state} ok=${ok === true}`);
        })
        .catch((err) => {
          bridgeLog(`forward command failed sid=${payload.session_id} state=${payload.state} err=${err && err.message ? err.message : err}`);
        });
    },
  });
  remoteMonitor.start();
  remoteMonitorKey = nextKey;
  bridgeLog(`remote Codex monitor started host=${hostLabel} prefix=${sessionIdPrefix}`);
  lastStatus = `running host=${hostLabel}`;
}

function activate(context) {
  output = vscode.window.createOutputChannel("Clawd Remote Codex");
  context.subscriptions.push(output);
  bridgeLog(`activate remoteName=${vscode.env.remoteName || "none"} log=${REMOTE_LOG_PATH}`);
  try {
    const rawPkg = fs.readFileSync(path.join(__dirname, "package.json"), "utf8");
    const pkg = JSON.parse(rawPkg);
    bridgeLog(`extension version=${pkg.version}`);
  } catch {}

  if (!vscode.env.remoteName) {
    bridgeLog("no remoteName detected; remote helper staying idle");
    lastStatus = "idle-local-window";
    return;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("clawd.remoteCodex.showStatus", async () => {
      const identity = getRemoteIdentity();
      const config = getRemoteCodexConfig();
      const roots = buildSessionRootCandidates(config.sessionDirCandidates, { preferredHome: os.homedir() });
      const message = [
        `status=${lastStatus}`,
        `remoteName=${vscode.env.remoteName || "none"}`,
        `authority=${identity.authority || "-"}`,
        `home=${os.homedir()}`,
        `roots=${roots.join(", ")}`,
      ].join("\n");
      bridgeLog(`showStatus invoked\n${message}`);
      await vscode.window.showInformationMessage("Clawd remote helper status copied to Output");
      output.show(true);
      return message;
    })
  );

  ensureRemoteMonitor();
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      bridgeLog("workspace folders changed");
      ensureRemoteMonitor();
    })
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("clawd.remoteCodex")) {
        bridgeLog("remote Codex configuration changed");
        ensureRemoteMonitor();
      }
    })
  );
}

function deactivate() {
  bridgeLog("deactivate");
  stopRemoteMonitor();
}

module.exports = { activate, deactivate };
