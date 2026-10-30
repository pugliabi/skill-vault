import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// What launch.ps1 needs from dist/launcher.js (a lock and a health answer), plus a record of its PATH.
const STUB_SERVER = `
const fs = require("fs"), http = require("http"), os = require("os"), path = require("path");
fs.writeFileSync(path.join(__dirname, "..", "server-path.txt"), process.env.PATH);
const server = http.createServer((_q, r) => r.end(JSON.stringify({ ok: true, pid: process.pid })));
server.listen(0, "127.0.0.1", () => {
  const lock = { pid: process.pid, port: server.address().port, started_at: new Date().toISOString(), version: "stub", mode: "production" };
  fs.writeFileSync(path.join(os.homedir(), ".skill-vault", "app.lock"), JSON.stringify(lock));
});
setTimeout(() => process.exit(0), 20000);
`;

// A real launch.ps1 run: mocking this script is how the background-start bug got through.
test("launch.ps1 -Headless keeps this launch's node folder and nothing else from the caller's PATH", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-launch-"));
  const home = path.join(root, "home");
  const appDir = path.join(root, "app");
  const sessionNode = path.join(root, "session-node");
  const agentOnly = path.join(root, "agent-only");
  fs.mkdirSync(path.join(home, ".skill-vault"), { recursive: true });
  fs.mkdirSync(path.join(appDir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(appDir, "dist"));
  fs.mkdirSync(agentOnly);
  fs.copyFileSync(path.join(APP, "scripts", "launch.ps1"), path.join(appDir, "scripts", "launch.ps1"));
  fs.writeFileSync(path.join(appDir, "scripts", "build-state.mjs"), "process.exit(0);\n");
  fs.writeFileSync(path.join(appDir, "dist", "launcher.js"), STUB_SERVER);
  // A junction, so a node that's on no Machine or User PATH without copying node.exe.
  fs.symlinkSync(path.dirname(fs.realpathSync(process.execPath)), sessionNode, "junction");
  let pid: number | undefined;
  try {
    const sys = process.env.SystemRoot ?? "C:\\Windows";
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(appDir, "scripts", "launch.ps1"), "-Headless"],
      {
        env: { ...process.env, USERPROFILE: home, HOME: home, PATH: [agentOnly, sessionNode, path.join(sys, "System32"), path.join(sys, "System32", "WindowsPowerShell", "v1.0")].join(";") },
        stdio: "ignore",
        timeout: 60_000,
      },
    );
    const log = path.join(home, ".skill-vault", "logs", "launch.log");
    assert.equal(r.status, 0, fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "launch.ps1 wrote no log");
    pid = (JSON.parse(fs.readFileSync(path.join(home, ".skill-vault", "app.lock"), "utf8")) as { pid: number }).pid;
    const entries = fs.readFileSync(path.join(appDir, "server-path.txt"), "utf8").toLowerCase().split(";");
    assert.ok(entries.includes(sessionNode.toLowerCase()), "the folder of the node that ran the launch was dropped");
    assert.ok(!entries.includes(agentOnly.toLowerCase()), "the rest of the caller's PATH came back");
    assert.ok(entries.includes(path.join(sys, "System32").toLowerCase()), "the Machine PATH is gone");
  } finally {
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
    // Remove the junction on its own first: a recursive delete must never walk into the real node folder.
    fs.unlinkSync(sessionNode);
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* the stopped server can hold its folder for a moment; a temp leftover mustn't hide the result */
    }
  }
});
