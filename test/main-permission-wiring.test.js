"use strict";

const { it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const MAIN_JS = path.join(__dirname, "..", "src", "main.js");

it("binds Codex notify bubble helper before passing it into server context", () => {
  const source = fs.readFileSync(MAIN_JS, "utf8");
  const destructureMatch = source.match(/const\s*\{([^}]+)\}\s*=\s*_perm;/);

  assert.ok(destructureMatch, "main.js should destructure permission runtime helpers from _perm");
  assert.match(
    destructureMatch[1],
    /\bshowCodexNotifyBubble\b/,
    "main.js should bind showCodexNotifyBubble from _perm before using it in _serverCtx"
  );
  assert.match(source, /\bshowCodexNotifyBubble,\s*\n\s*clearCodexNotifyBubbles,/);
});
