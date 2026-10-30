import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DesktopConfigError, bridgeEntry, desktopConfigPath, entryState, getEntry, isOurEntry,
  readDesktopConfig, withEntry, withoutEntry, writeDesktopConfig, type PathEnv,
} from "./desktopConfig.ts";

const ours = bridgeEntry("C:/node/node.exe", "C:/apps/skill-vault/app/dist/assistant-mcp.js", "claude-desktop");
const foreign = { command: "npx", args: ["some-other-server"] };

function env(over: Partial<PathEnv> & { dirs?: string[]; listing?: Record<string, string[]> }): PathEnv {
  const dirs = new Set(over.dirs ?? []);
  return {
    platform: "win32",
    appData: "R",
    localAppData: "L",
    home: "H",
    exists: (p) => dirs.has(p),
    list: (d) => over.listing?.[d] ?? [],
    ...over,
  };
}

test("desktopConfigPath prefers %APPDATA%\\Claude", () => {
  assert.equal(
    desktopConfigPath(env({ dirs: [path.join("R", "Claude")] })),
    path.join("R", "Claude", "claude_desktop_config.json"),
  );
});

test("desktopConfigPath falls back to a Microsoft Store install", () => {
  const store = path.join("L", "Packages", "Claude_abc123", "LocalCache", "Roaming", "Claude");
  assert.equal(
    desktopConfigPath(env({ dirs: [store], listing: { [path.join("L", "Packages")]: ["Other_x", "Claude_abc123"] } })),
    path.join(store, "claude_desktop_config.json"),
  );
});

test("desktopConfigPath is null when Claude Desktop isn't installed, and knows macOS", () => {
  assert.equal(desktopConfigPath(env({})), null);
  const mac = path.join("H", "Library", "Application Support", "Claude");
  assert.equal(desktopConfigPath(env({ platform: "darwin", dirs: [mac] })), path.join(mac, "claude_desktop_config.json"));
  assert.equal(desktopConfigPath(env({ platform: "linux" })), null);
});

test("withEntry adds our server and keeps every other key and server in order", () => {
  const before = { mcpServers: { a: foreign }, preferences: { x: 1 }, other: "keep" };
  const after = withEntry(before, ours);
  assert.deepEqual(Object.keys(after), ["mcpServers", "preferences", "other"]);
  assert.deepEqual(after.mcpServers, { a: foreign, "skill-vault": ours });
  assert.deepEqual(withEntry(after, ours), after);
  assert.deepEqual(withEntry({}, ours), { mcpServers: { "skill-vault": ours } });
  assert.deepEqual(before.mcpServers, { a: foreign }, "input is not mutated");
});

test("withEntry refuses a foreign skill-vault entry and a non-object mcpServers", () => {
  assert.throws(() => withEntry({ mcpServers: { "skill-vault": foreign } }, ours), DesktopConfigError);
  assert.throws(() => withEntry({ mcpServers: [] }, ours), DesktopConfigError);
});

test("withoutEntry removes only our entry", () => {
  assert.deepEqual(withoutEntry({ mcpServers: { a: foreign, "skill-vault": ours }, p: 1 }), { mcpServers: { a: foreign }, p: 1 });
  const theirs = { mcpServers: { "skill-vault": foreign } };
  assert.deepEqual(withoutEntry(theirs), theirs);
  assert.deepEqual(withoutEntry({ p: 1 }), { p: 1 });
});

test("isOurEntry and entryState", () => {
  assert.equal(isOurEntry(ours), true);
  assert.equal(isOurEntry({ command: "node", args: ["C:\\x\\dist\\assistant-mcp.js"] }), true);
  assert.equal(isOurEntry(foreign), false);
  const all = () => true;
  assert.equal(entryState(undefined, all), "not_connected");
  assert.equal(entryState(foreign, all), "name_taken");
  assert.equal(entryState(ours, all), "connected");
  assert.equal(entryState(ours, (p) => p !== ours.command), "broken");
  assert.equal(getEntry({ mcpServers: { "skill-vault": ours } }), ours);
});

test("readDesktopConfig: missing or empty file is {}, a BOM is fine, bad JSON and non-objects are refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-desk-"));
  try {
    const f = path.join(dir, "claude_desktop_config.json");
    assert.deepEqual(readDesktopConfig(f), {});
    fs.writeFileSync(f, "");
    assert.deepEqual(readDesktopConfig(f), {});
    fs.writeFileSync(f, '\uFEFF{"a":1}');
    assert.deepEqual(readDesktopConfig(f), { a: 1 });
    fs.writeFileSync(f, "{ nope");
    assert.throws(() => readDesktopConfig(f), (e: unknown) => e instanceof DesktopConfigError && /valid JSON/.test(e.message));
    fs.writeFileSync(f, "[1]");
    assert.throws(() => readDesktopConfig(f), DesktopConfigError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeDesktopConfig backs up the old file and writes atomically", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-desk-"));
  try {
    const f = path.join(dir, "claude_desktop_config.json");
    fs.writeFileSync(f, '{"old":true}');
    writeDesktopConfig(f, { new: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf-8")), { new: true });
    assert.equal(fs.readFileSync(`${f}.skill-vault.bak`, "utf-8"), '{"old":true}');
    assert.deepEqual(fs.readdirSync(dir).sort(), ["claude_desktop_config.json", "claude_desktop_config.json.skill-vault.bak"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeDesktopConfig leaves the config untouched when the backup fails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-desk-"));
  try {
    const f = path.join(dir, "claude_desktop_config.json");
    fs.writeFileSync(f, '{"old":true}');
    fs.mkdirSync(`${f}.skill-vault.bak`); // a directory where the backup file must go: the copy fails
    assert.throws(() => writeDesktopConfig(f, { new: true }), (e: unknown) => e instanceof DesktopConfigError && /back up/.test(e.message));
    assert.equal(fs.readFileSync(f, "utf-8"), '{"old":true}');
    assert.equal(fs.existsSync(`${f}.skill-vault.tmp`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
