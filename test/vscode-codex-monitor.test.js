const { describe, it } = require("node:test");
const assert = require("node:assert");
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
});
