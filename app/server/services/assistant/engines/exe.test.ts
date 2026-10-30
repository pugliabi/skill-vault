import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { knownInstallDirs, parseCmdShim, parseRegQueryPath, resolveTarget, type ResolveDeps } from "./exe.ts";

// npm's cmd-shim template, as written for `npm install -g @openai/codex`.
const NPM_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join("\r\n");

test("parseCmdShim: an npm node-script shim resolves to the script, never node.exe", () => {
  assert.deepEqual(parseCmdShim(NPM_SHIM, "C:\\nvm4w\\nodejs"), {
    kind: "node",
    script: path.resolve("C:\\nvm4w\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js"),
  });
});

test("parseCmdShim: a shim wrapping a real exe resolves to that exe", () => {
  const text = '@ECHO off\r\n"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
  assert.deepEqual(parseCmdShim(text, "C:\\npm"), {
    kind: "exe",
    path: path.resolve("C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"),
  });
});

test("parseCmdShim: text that isn't a shim → null", () => {
  assert.equal(parseCmdShim("echo hi", "C:\\x"), null);
});

function fakeDeps(files: Record<string, string>, extra: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    platform: "win32",
    pathDirs: () => ["C:\\a", "C:\\b"],
    registryPathDirs: () => ["C:\\reg"],
    knownDirs: ["C:\\known"],
    exists: (p) => p in files,
    readFile: (p) => files[p] ?? "",
    nodePath: "C:\\node\\node.exe",
    ...extra,
  };
}

test("resolveTarget: a real exe on PATH is spawned directly", () => {
  assert.deepEqual(resolveTarget("codex", "codex CLI", fakeDeps({ "C:\\b\\codex.exe": "" })), {
    command: "C:\\b\\codex.exe",
    prefixArgs: [],
    label: "codex CLI",
  });
});

test("resolveTarget: an npm shim runs its script with the app's node", () => {
  const script = path.resolve("C:\\a\\node_modules\\@openai\\codex\\bin\\codex.js");
  assert.deepEqual(resolveTarget("codex", "codex CLI", fakeDeps({ "C:\\a\\codex.cmd": NPM_SHIM, [script]: "" })), {
    command: "C:\\node\\node.exe",
    prefixArgs: [script],
    label: "codex CLI",
  });
});

test("resolveTarget: PATH, then known install folders; the registry PATH is read only when both miss", () => {
  let regReads = 0;
  const counting = (files: Record<string, string>) => fakeDeps(files, { registryPathDirs: () => (regReads++, ["C:\\reg"]) });
  const both = { "C:\\b\\grok.exe": "", "C:\\known\\grok.exe": "", "C:\\reg\\grok.exe": "" };
  assert.equal(resolveTarget("grok", "grok CLI", counting(both))?.command, "C:\\b\\grok.exe");
  assert.equal(resolveTarget("grok", "grok CLI", counting({ "C:\\known\\grok.exe": "", "C:\\reg\\grok.exe": "" }))?.command, "C:\\known\\grok.exe");
  assert.equal(regReads, 0, "found without the registry: no reg query");
  assert.equal(resolveTarget("grok", "grok CLI", counting({ "C:\\reg\\grok.exe": "" }))?.command, "C:\\reg\\grok.exe");
  assert.equal(regReads, 1);
});

test("resolveTarget: a shim whose target is missing is skipped; nothing found → null", () => {
  assert.equal(resolveTarget("codex", "codex CLI", fakeDeps({ "C:\\a\\codex.cmd": NPM_SHIM })), null);
  assert.equal(resolveTarget("codex", "codex CLI", fakeDeps({})), null);
});

test("parseRegQueryPath: reads the Path value and expands %VARS%", () => {
  const out = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;C:\\Tools;;\r\n\r\n";
  assert.deepEqual(parseRegQueryPath(out, { USERPROFILE: "C:\\Users\\me" }), ["C:\\Users\\me\\.local\\bin", "C:\\Tools"]);
  assert.deepEqual(parseRegQueryPath("ERROR: not found", {}), []);
});

test("knownInstallDirs: node's folder, the npm prefix, ~/.local/bin and Grok's folder", () => {
  const dirs = knownInstallDirs({ APPDATA: "C:\\Users\\me\\AppData\\Roaming", USERPROFILE: "C:\\Users\\me" }, "C:\\nvm4w\\nodejs\\node.exe");
  assert.deepEqual(dirs, [
    "C:\\nvm4w\\nodejs",
    path.join("C:\\Users\\me\\AppData\\Roaming", "npm"),
    path.join("C:\\Users\\me", ".local", "bin"),
    path.join("C:\\Users\\me", ".grok", "bin"),
  ]);
});
