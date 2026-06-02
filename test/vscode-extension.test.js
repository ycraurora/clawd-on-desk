"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");

test("terminal-focus extension activates on startup and focuses terminal input", () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(repoRoot, "extensions", "vscode", "package.json"),
    "utf8"
  ));
  const source = fs.readFileSync(
    path.join(repoRoot, "extensions", "vscode", "extension.js"),
    "utf8"
  );
  const main = fs.readFileSync(path.join(repoRoot, "src", "main.js"), "utf8");

  assert.equal(manifest.version, "3.3.0");
  assert.match(main, /const EXT_VERSION = "3\.3\.0"/);
  assert.ok(manifest.activationEvents.includes("onStartupFinished"));
  assert.ok(manifest.activationEvents.includes("onUri"));
  assert.ok(manifest.activationEvents.includes("onCommand:clawd.internal.forwardStateToApp"));
  assert.ok(manifest.activationEvents.includes("onCommand:clawd.internal.bridgeLog"));
  assert.ok(manifest.activationEvents.includes("onCommand:clawd.showBridgeStatus"));
  assert.match(source, /terminal\.show\(false\)/);
  assert.doesNotMatch(source, /terminal\.show\(true\)/);
});

test("remote Codex helper keeps an independent workspace extension version", () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(repoRoot, "extensions", "vscode-remote-codex", "package.json"),
    "utf8"
  ));

  assert.equal(manifest.name, "clawd-remote-codex");
  assert.equal(manifest.version, "1.1.0");
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
});
