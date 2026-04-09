const vscode = require("vscode");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Port range for Clawd terminal-focus extension instances.
// Each editor window gets its own extension host -> each needs a unique port.
// main.js broadcasts to all ports; only the one with the matching PID responds 200.
const PORT_BASE = 23456;
const PORT_RANGE = 5;

const CLAWD_PORT_BASE = 23333;
const CLAWD_PORT_RANGE = 5;
const CLAWD_RUNTIME_CONFIG_PATH = path.join(os.homedir(), ".clawd", "runtime.json");
const CLAWD_LOG_DIR = path.join(os.homedir(), ".clawd");
const CLAWD_VSCODE_LOG_PATH = path.join(CLAWD_LOG_DIR, "vscode-bridge.log");
const UI_FORWARD_STATE_COMMAND = "clawd.internal.forwardStateToApp";
const UI_BRIDGE_LOG_COMMAND = "clawd.internal.bridgeLog";
const UI_SHOW_STATUS_COMMAND = "clawd.showBridgeStatus";

let server = null;
let output = null;
let cachedClawdPort = null;
let lastBridgeStatus = "not-started";

function log(line) {
  const message = `[${new Date().toISOString()}] ${line}`;
  if (output) output.appendLine(message);
  try {
    fs.mkdirSync(CLAWD_LOG_DIR, { recursive: true });
    fs.appendFileSync(CLAWD_VSCODE_LOG_PATH, message + "\n", "utf8");
  } catch {}
}

async function focusTerminalByPids(pids) {
  for (const terminal of vscode.window.terminals) {
    const termPid = await terminal.processId;
    if (termPid && pids.includes(termPid)) {
      terminal.show(true); // true = preserveFocus, switch tab without stealing focus
      return true;
    }
  }
  return false;
}

function readRuntimePort() {
  try {
    const raw = JSON.parse(fs.readFileSync(CLAWD_RUNTIME_CONFIG_PATH, "utf8"));
    const port = Number(raw && raw.port);
    if (Number.isInteger(port) && port >= CLAWD_PORT_BASE && port < CLAWD_PORT_BASE + CLAWD_PORT_RANGE) {
      return port;
    }
  } catch {}
  return null;
}

function getClawdPortCandidates() {
  const ports = [];
  const seen = new Set();
  const add = (port) => {
    if (!Number.isInteger(port) || seen.has(port)) return;
    seen.add(port);
    ports.push(port);
  };

  add(cachedClawdPort);
  add(readRuntimePort());
  for (let i = 0; i < CLAWD_PORT_RANGE; i++) add(CLAWD_PORT_BASE + i);
  return ports;
}

function postJson(port, requestPath, payload, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end(payload);
  });
}

async function postStateToClawd(body) {
  const payload = JSON.stringify(body);
  const ports = getClawdPortCandidates();
  log(`forwarding state to Clawd candidates=${ports.join(",")} state=${body.state} sid=${body.session_id}`);
  for (const port of ports) {
    const ok = await postJson(port, "/state", payload, 300);
    if (ok) {
      cachedClawdPort = port;
      lastBridgeStatus = `forwarded port=${port} state=${body.state}`;
      log(`forwarded state to Clawd port=${port} state=${body.state} sid=${body.session_id}`);
      return true;
    }
  }
  lastBridgeStatus = `forward-failed state=${body.state}`;
  log(`failed to forward state to any Clawd port state=${body.state} sid=${body.session_id}`);
  return false;
}

async function handleForwardState(payload) {
  if (!payload || typeof payload !== "object") {
    lastBridgeStatus = "invalid-payload";
    log("received invalid bridge payload");
    return false;
  }
  lastBridgeStatus = `received state=${payload.state || "-"} sid=${payload.session_id || "-"}`;
  log(`bridge payload from remote state=${payload.state || "-"} sid=${payload.session_id || "-"} event=${payload.event || "-"}`);
  return postStateToClawd(payload);
}

function tryListen(port, maxPort) {
  if (port > maxPort) {
    log("focus server: all ports in use, HTTP server disabled");
    return;
  }

  server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/focus-tab") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const data = JSON.parse(body);
          const pids = Array.isArray(data.pids) ? data.pids.filter(Number.isFinite) : [];
          if (pids.length) {
            focusTerminalByPids(pids).then((found) => {
              res.writeHead(found ? 200 : 404);
              res.end(found ? "ok" : "not found");
            });
          } else {
            res.writeHead(400);
            res.end("no pids");
          }
        } catch {
          res.writeHead(400);
          res.end("bad json");
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log(`focus server port in use: ${port}, trying ${port + 1}`);
      server = null;
      tryListen(port + 1, maxPort);
    }
  });

  server.listen(port, "127.0.0.1", () => {
    log(`focus server listening on 127.0.0.1:${port}`);
  });
}

function activate(context) {
  output = vscode.window.createOutputChannel("Clawd");
  context.subscriptions.push(output);
  log(`activate remoteName=${vscode.env.remoteName || "none"} log=${CLAWD_VSCODE_LOG_PATH}`);
  try {
    const rawPkg = fs.readFileSync(path.join(__dirname, "package.json"), "utf8");
    const pkg = JSON.parse(rawPkg);
    log(`extension version=${pkg.version}`);
  } catch {}

  tryListen(PORT_BASE, PORT_BASE + PORT_RANGE - 1);

  context.subscriptions.push(
    vscode.commands.registerCommand(UI_FORWARD_STATE_COMMAND, handleForwardState)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(UI_BRIDGE_LOG_COMMAND, (message) => {
      lastBridgeStatus = "remote-log";
      log(`remote-helper ${typeof message === "string" ? message : JSON.stringify(message)}`);
      return true;
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(UI_SHOW_STATUS_COMMAND, async () => {
      const message = [
        `status=${lastBridgeStatus}`,
        `runtimePort=${readRuntimePort() || "-"}`,
        `cachedPort=${cachedClawdPort || "-"}`,
        `log=${CLAWD_VSCODE_LOG_PATH}`,
      ].join("\n");
      log(`showBridgeStatus invoked\n${message}`);
      await vscode.window.showInformationMessage("Clawd local bridge status copied to Output");
      output.show(true);
      return message;
    })
  );

  lastBridgeStatus = "commands-registered";
  log(`registered commands: ${UI_FORWARD_STATE_COMMAND}, ${UI_BRIDGE_LOG_COMMAND}, ${UI_SHOW_STATUS_COMMAND}`);

  // URI handler kept as fallback for manual testing:
  // vscode://clawd.clawd-terminal-focus?pids=1234,5678
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri) {
        const params = new URLSearchParams(uri.query);
        const raw = params.get("pids") || params.get("pid") || "";
        const pids = raw.split(",").map(Number).filter(Boolean);
        if (pids.length) focusTerminalByPids(pids);
      },
    })
  );
}

function deactivate() {
  log("deactivate");
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = {
  UI_BRIDGE_LOG_COMMAND,
  UI_FORWARD_STATE_COMMAND,
  activate,
  deactivate,
};
