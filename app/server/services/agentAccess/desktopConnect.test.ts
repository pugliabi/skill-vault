import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DesktopConfigError, type PathEnv } from "./desktopConfig.ts";
import { BRIDGE_NOT_BUILT, DESKTOP_NOT_INSTALLED, DesktopConnectError, connectDesktop, desktopStatus } from "./desktopConnect.ts";

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-desktop-"));
  const appData = path.join(root, "appdata");
  const claudeDir = path.join(appData, "Claude");
  const bridgePath = path.join(root, "app", "dist", "assistant-mcp.js");
  fs.mkdirSync(path.dirname(bridgePath), { recursive: true });
  fs.writeFileSync(bridgePath, "// bridge");
  const env: PathEnv = { platform: "win32", appData, home: root, exists: (p) => fs.existsSync(p), list: () => [] };
  const file = path.join(claudeDir, "claude_desktop_config.json");
  return { root, claudeDir, bridgePath, env, file, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("status: not installed until Claude's folder exists, then not connected", () => {
  const s = sandbox();
  try {
    assert.deepEqual(desktopStatus(s.env), { state: "not_installed", config_path: null });
    fs.mkdirSync(s.claudeDir, { recursive: true });
    assert.deepEqual(desktopStatus(s.env), { state: "not_connected", config_path: s.file });
  } finally {
    s.done();
  }
});

test("connect keeps every other key, backs the file up and reads as connected", () => {
  const s = sandbox();
  try {
    fs.mkdirSync(s.claudeDir, { recursive: true });
    const original = JSON.stringify({ mcpServers: { other: { command: "x", args: ["y"] } }, preferences: { a: 1 } }, null, 2);
    fs.writeFileSync(s.file, original);
    assert.equal(connectDesktop({ env: s.env, nodePath: process.execPath, bridgePath: s.bridgePath }), s.file);
    const cfg = JSON.parse(fs.readFileSync(s.file, "utf-8"));
    assert.deepEqual(cfg.mcpServers.other, { command: "x", args: ["y"] });
    assert.deepEqual(cfg.preferences, { a: 1 });
    assert.deepEqual(cfg.mcpServers["skill-vault"], { command: process.execPath, args: [s.bridgePath, "--client", "claude-desktop"] });
    assert.equal(fs.readFileSync(`${s.file}.skill-vault.bak`, "utf-8"), original);
    assert.equal(desktopStatus(s.env).state, "connected");
    // Connecting again just rewrites our own entry.
    connectDesktop({ env: s.env, nodePath: process.execPath, bridgePath: s.bridgePath });
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(s.file, "utf-8")).mcpServers), ["other", "skill-vault"]);
  } finally {
    s.done();
  }
});

test("connect refuses invalid JSON and leaves the file alone; status says unreadable", () => {
  const s = sandbox();
  try {
    fs.mkdirSync(s.claudeDir, { recursive: true });
    fs.writeFileSync(s.file, "{ broken");
    assert.throws(() => connectDesktop({ env: s.env, nodePath: process.execPath, bridgePath: s.bridgePath }), DesktopConfigError);
    assert.equal(fs.readFileSync(s.file, "utf-8"), "{ broken");
    const st = desktopStatus(s.env);
    assert.equal(st.state, "unreadable");
    assert.match(st.error ?? "", /isn't valid JSON/);
  } finally {
    s.done();
  }
});

test("connect refuses a server of someone else's named skill-vault", () => {
  const s = sandbox();
  try {
    fs.mkdirSync(s.claudeDir, { recursive: true });
    fs.writeFileSync(s.file, JSON.stringify({ mcpServers: { "skill-vault": { command: "other", args: ["x"] } } }));
    assert.equal(desktopStatus(s.env).state, "name_taken");
    assert.throws(() => connectDesktop({ env: s.env, nodePath: process.execPath, bridgePath: s.bridgePath }), /isn't from Skill Vault/);
  } finally {
    s.done();
  }
});

test("connect needs the bridge and an installed Claude Desktop", () => {
  const s = sandbox();
  try {
    assert.throws(() => connectDesktop({ env: s.env, nodePath: process.execPath, bridgePath: s.bridgePath }), (e: unknown) => e instanceof DesktopConnectError && e.message === DESKTOP_NOT_INSTALLED);
    fs.mkdirSync(s.claudeDir, { recursive: true });
    const missing = path.join(s.root, "nope", "assistant-mcp.js");
    assert.throws(() => connectDesktop({ env: s.env, nodePath: process.execPath, bridgePath: missing }), (e: unknown) => e instanceof DesktopConnectError && e.message === BRIDGE_NOT_BUILT);
    assert.equal(fs.existsSync(s.file), false);
  } finally {
    s.done();
  }
});
