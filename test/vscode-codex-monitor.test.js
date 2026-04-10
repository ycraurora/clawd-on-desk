const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const {
  CodexBridgeMonitor,
  buildSessionRootCandidates,
  extractSessionId,
  normalizePosixDir,
} = require("../extensions/vscode/codex-monitor");

describe("vscode codex monitor helpers", () => {
  it("normalizes posix directories", () => {
    assert.strictEqual(normalizePosixDir(" /home/vscode/ "), "/home/vscode");
    assert.strictEqual(normalizePosixDir("root"), "/root");
    assert.strictEqual(normalizePosixDir(""), "");
  });

  it("builds unique session root candidates", () => {
    const roots = buildSessionRootCandidates(
      ["/custom/home", "/custom/home/.codex/sessions"],
      { preferredHome: "/real/home" }
    );
    assert.strictEqual(roots[0], "/real/home/.codex/sessions");
    assert.strictEqual(roots[1], "/custom/home/.codex/sessions");
    assert.strictEqual(roots.filter((r) => r === "/custom/home/.codex/sessions").length, 1);
    assert.ok(roots.includes("/root/.codex/sessions"));
  });

  it("keeps fallback homes only as backup candidates", () => {
    const roots = buildSessionRootCandidates([], { preferredHome: "/actual/user" });
    assert.strictEqual(roots[0], "/actual/user/.codex/sessions");
    assert.ok(roots.includes("/home/vscode/.codex/sessions"));
    assert.strictEqual(roots.filter((r) => r === "/home/vscode/.codex/sessions").length, 1);
  });

  it("extracts codex session ids from rollout filenames", () => {
    assert.strictEqual(
      extractSessionId("rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl"),
      "019d23d4-f1a9-7633-b9c7-758327137228"
    );
    assert.strictEqual(extractSessionId("bad.jsonl"), null);
  });
});

describe("CodexBridgeMonitor parsing", () => {
  it("maps task completion to attention after tool use", () => {
    const events = [];
    const monitor = new CodexBridgeMonitor({
      sessionRoots: [],
      readDir: async () => [],
      stat: async () => ({ mtimeMs: Date.now() }),
      readFile: async () => Buffer.alloc(0),
      postState: (sid, state, event, extra) => events.push({ sid, state, event, extra }),
    });
    const tracked = {
      sessionId: "codex:vscode:test",
      cwd: "/workspace",
      hadToolUse: false,
      lastState: null,
      lastEventTime: 0,
      partial: "",
    };

    monitor._processLine('{"type":"event_msg","payload":{"type":"task_started"}}', tracked);
    monitor._processLine('{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"git status\\"}"}}', tracked);
    monitor._processLine('{"type":"event_msg","payload":{"type":"exec_command_end"}}', tracked);
    monitor._processLine('{"type":"event_msg","payload":{"type":"task_complete"}}', tracked);

    assert.deepStrictEqual(
      events.map((event) => event.state),
      ["thinking", "working", "attention"]
    );
  });

  it("emits notification immediately for explicit escalated requests", () => {
    const events = [];
    const monitor = new CodexBridgeMonitor({
      sessionRoots: [],
      readDir: async () => [],
      stat: async () => ({ mtimeMs: Date.now() }),
      readFile: async () => Buffer.alloc(0),
      postState: (sid, state, event, extra) => events.push({ sid, state, event, extra }),
    });
    const tracked = {
      sessionId: "codex:vscode:test",
      cwd: "/workspace",
      hadToolUse: false,
      lastState: null,
      lastEventTime: 0,
      partial: "",
    };

    monitor._processLine(
      '{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"git push\\",\\"sandbox_permissions\\":\\"require_escalated\\",\\"justification\\":\\"network\\"}"}}',
      tracked
    );

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].state, "notification");
    assert.strictEqual(events[0].extra.permissionDetail.command, "git push");
  });

  it("includes older existing day dirs beyond the last 3 calendar days", async () => {
    const seenDirs = [];
    const oldDir = "/home/stella/.codex/sessions/2026/04/07";
    const monitor = new CodexBridgeMonitor({
      sessionRoots: ["/home/stella/.codex/sessions"],
      readDir: async (dir) => {
        seenDirs.push(dir);
        if (dir === "/home/stella/.codex/sessions") {
          return [{ name: "2026", isDirectory: () => true }];
        }
        if (dir === "/home/stella/.codex/sessions/2026") {
          return [{ name: "04", isDirectory: () => true }];
        }
        if (dir === "/home/stella/.codex/sessions/2026/04") {
          return [
            { name: "10", isDirectory: () => true },
            { name: "09", isDirectory: () => true },
            { name: "08", isDirectory: () => true },
            { name: "07", isDirectory: () => true },
          ];
        }
        if (dir === oldDir) {
          return ["rollout-2026-04-07T13-25-50-019d6667-7a44-75a1-a782-2c578927b10b.jsonl"];
        }
        return [];
      },
      stat: async () => ({ mtimeMs: Date.now() }),
      readFile: async () => Buffer.from('{"type":"session_meta","payload":{"cwd":"/workspace"}}\n'),
      postState: () => {},
      log: () => {},
    });

    monitor._activeRoot = "/home/stella/.codex/sessions";
    await monitor._poll();

    assert.ok(seenDirs.includes(oldDir), "expected poll to include older existing day dir");
    assert.ok(
      monitor._tracked.has(path.posix.join(oldDir, "rollout-2026-04-07T13-25-50-019d6667-7a44-75a1-a782-2c578927b10b.jsonl"))
    );
  });
});
