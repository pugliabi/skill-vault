import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";

let root: string;
let fakeHome: string;
let vault: string;
let appRoot: string;
let claudeDir: string;
let providerDir: string;
let stageDir: string;
let server: Server;
let url: string;
let ccEntry: unknown;
let desktopInstalled = true;
let claudeInstalled = true;
const ccCalls: string[][] = [];
const opened: string[] = [];

const SKILL_MD = "---\nname: skill-vault\ndescription: test skill for the agent access routes\n---\n\nBody\n";

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-agent-"));
  fakeHome = path.join(root, "home");
  vault = path.join(root, "vault");
  appRoot = path.join(root, "app");
  claudeDir = path.join(root, "appdata", "Claude");
  providerDir = path.join(root, "claude-skills");
  stageDir = path.join(root, "stage");
  for (const d of [fakeHome, vault, claudeDir, providerDir, path.join(appRoot, "bundled-skills", "skill-vault"), path.join(appRoot, "dist")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(path.join(appRoot, "bundled-skills", "skill-vault", "SKILL.md"), SKILL_MD);
  fs.writeFileSync(path.join(appRoot, "dist", "assistant-mcp.js"), "// bridge");
  fs.mkdirSync(path.join(fakeHome, ".skill-vault"), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, ".skill-vault", "config.json"),
    JSON.stringify({ vault_path: vault, agent_locations: { claude: providerDir }, default_targets: ["claude"], claude_desktop_stage: stageDir }) + "\n",
  );
  fs.writeFileSync(path.join(claudeDir, "claude_desktop_config.json"), JSON.stringify({ mcpServers: { other: { command: "x", args: [] } }, preferences: { a: 1 } }));
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;

  const express = (await import("express")).default;
  const { agentAccessRouter } = await import("./agentAccess.ts");
  const { initVault } = await import("../services/vault.ts");
  initVault(vault);

  const app = express();
  app.use(express.json());
  app.use(
    "/api/agent-access",
    agentAccessRouter({
      appRoot,
      nodePath: process.execPath,
      pathEnv: () => ({
        platform: "win32",
        appData: path.dirname(claudeDir),
        home: fakeHome,
        exists: (p) => desktopInstalled && fs.existsSync(p),
        list: () => [],
      }),
      claudeAvailable: async () => (claudeInstalled ? { available: true } : { available: false, reason: "no claude" }),
      claudeCodeEntry: () => ccEntry,
      claudeRunner: async (args) => {
        ccCalls.push(args);
        if (args[1] === "add") ccEntry = { command: args[6], args: args.slice(7) };
        if (args[1] === "remove") ccEntry = undefined;
        return { stdout: "", stderr: "", code: 0 };
      },
      openFolder: async (dir) => {
        opened.push(dir);
      },
    }),
  );
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api/agent-access`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

const get = async () => (await fetch(url)).json() as Promise<Record<string, any>>;
const post = (p: string, headers: Record<string, string> = {}) => fetch(`${url}${p}`, { method: "POST", headers });

test("status before anything is connected", async () => {
  const s = await get();
  assert.equal(s.bridge_built, true);
  assert.equal(s.skill.state, "not_in_vault");
  assert.equal(s.claude_desktop.state, "not_connected");
  assert.equal(s.claude_code.state, "not_connected");
  assert.match(s.command.windows, /skill-vault\.cmd$/);
  assert.equal(s.command.posix, "~/.skill-vault/bin/skill-vault");
});

test("add to vault adopts the bundled skill with a dir origin and pushes it to the default targets", async () => {
  const res = await post("/skill/add");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { pushed: string[] };
  assert.deepEqual(body.pushed, ["claude"]);
  const entry = JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf-8")).skills["skill-vault"];
  assert.equal(entry.origin.type, "dir");
  assert.equal(entry.origin.subpath, "skill-vault");
  assert.ok(fs.existsSync(path.join(providerDir, "skill-vault", "SKILL.md")));
  assert.equal((await get()).skill.state, "in_vault");
});

test("a changed bundled copy shows update available, and add refreshes it", async () => {
  fs.writeFileSync(path.join(appRoot, "bundled-skills", "skill-vault", "SKILL.md"), SKILL_MD + "\nMore\n");
  assert.equal((await get()).skill.state, "update_available");
  assert.equal((await post("/skill/add")).status, 200);
  const s = await get();
  assert.equal(s.skill.state, "in_vault");
  assert.deepEqual(s.skill.targets, ["claude"]);
});

test("the prompt carries the bundled SKILL.md", async () => {
  const { prompt } = (await (await fetch(`${url}/skill/prompt`)).json()) as { prompt: string };
  assert.ok(prompt.includes("name: skill-vault"));
});

test("zip builds skill-vault.zip in the staging folder and opens it", async () => {
  const res = await post("/skill/zip");
  assert.equal(res.status, 200);
  assert.ok(fs.existsSync(path.join(stageDir, "skill-vault.zip")));
  assert.deepEqual(opened, [stageDir]);
});

test("Claude Desktop connect and disconnect keep the rest of the config", async () => {
  const file = path.join(claudeDir, "claude_desktop_config.json");
  assert.equal((await post("/desktop/connect")).status, 200);
  const cfg = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.deepEqual(Object.keys(cfg.mcpServers), ["other", "skill-vault"]);
  assert.deepEqual(cfg.preferences, { a: 1 });
  assert.equal(cfg.mcpServers["skill-vault"].args[1], "--client");
  assert.ok(fs.existsSync(`${file}.skill-vault.bak`));
  assert.equal((await get()).claude_desktop.state, "connected");
  assert.equal((await post("/desktop/disconnect")).status, 200);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf-8")).mcpServers), ["other"]);
});

test("Claude Desktop connect refuses a broken config and leaves it alone", async () => {
  const file = path.join(claudeDir, "claude_desktop_config.json");
  const good = fs.readFileSync(file, "utf-8");
  fs.writeFileSync(file, "{ broken");
  const res = await post("/desktop/connect");
  assert.equal(res.status, 409);
  assert.equal(fs.readFileSync(file, "utf-8"), "{ broken");
  assert.equal((await get()).claude_desktop.state, "unreadable");
  fs.writeFileSync(file, good);
});

test("Claude Code connect runs claude mcp add, disconnect runs remove", async () => {
  assert.equal((await post("/claude-code/connect")).status, 200);
  assert.deepEqual(ccCalls[0].slice(0, 6), ["mcp", "add", "--scope", "user", "skill-vault", "--"]);
  assert.equal((await get()).claude_code.state, "connected");
  assert.equal((await post("/claude-code/disconnect")).status, 200);
  assert.deepEqual(ccCalls[1], ["mcp", "remove", "--scope", "user", "skill-vault"]);
});

test("Claude Desktop connect turns a raw write failure into a 409 naming the file", async () => {
  const file = path.join(claudeDir, "claude_desktop_config.json");
  const tmp = `${file}.skill-vault.tmp`;
  fs.mkdirSync(tmp);
  try {
    const res = await post("/desktop/connect");
    assert.equal(res.status, 409);
    assert.ok(((await res.json()) as { error: string }).error.includes(file));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("status rows: Claude Desktop not installed, broken, name taken", async () => {
  const file = path.join(claudeDir, "claude_desktop_config.json");
  const good = fs.readFileSync(file, "utf-8");
  desktopInstalled = false;
  const gone = (await get()).claude_desktop;
  desktopInstalled = true;
  assert.equal(gone.state, "not_installed");
  assert.equal(gone.config_path, null);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { "skill-vault": { command: process.execPath, args: [path.join(root, "gone", "dist", "assistant-mcp.js")] } } }));
  assert.equal((await get()).claude_desktop.state, "broken");
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { "skill-vault": { command: "other", args: ["x"] } } }));
  assert.equal((await get()).claude_desktop.state, "name_taken");
  fs.writeFileSync(file, good);
});

test("status rows: Claude Code cli missing, broken, name taken", async () => {
  claudeInstalled = false;
  const missing = (await get()).claude_code;
  claudeInstalled = true;
  assert.equal(missing.state, "cli_missing");
  ccEntry = { command: process.execPath, args: [path.join(root, "gone", "dist", "assistant-mcp.js")] };
  assert.equal((await get()).claude_code.state, "broken");
  ccEntry = { command: "other", args: ["x"] };
  assert.equal((await get()).claude_code.state, "name_taken");
  ccEntry = undefined;
});

test("a locally edited vault copy is not offered a one-click overwrite", async () => {
  fs.writeFileSync(path.join(appRoot, "bundled-skills", "skill-vault", "SKILL.md"), SKILL_MD + "\nNewer\n");
  const edited = path.join(vault, "skills", "skill-vault", "SKILL.md");
  fs.writeFileSync(edited, SKILL_MD + "\nMine\n");
  assert.equal((await get()).skill.state, "in_vault");
  const res = await post("/skill/add");
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /local changes/);
  assert.ok(fs.readFileSync(edited, "utf-8").includes("Mine"));
});

test("cross-site writes are refused", async () => {
  assert.equal((await post("/desktop/connect", { origin: "https://evil.example" })).status, 403);
});

test("a vault skill named skill-vault from elsewhere blocks add", async () => {
  const manifestFile = path.join(vault, "skills.json");
  const m = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
  delete m.skills["skill-vault"].origin;
  fs.writeFileSync(manifestFile, JSON.stringify(m));
  assert.equal((await get()).skill.state, "name_taken");
  assert.equal((await post("/skill/add")).status, 409);
});

const manifestSkills = () => JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf-8")).skills as Record<string, any>;
const dropFromVault = () => {
  const m = JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf-8"));
  delete m.skills["skill-vault"];
  fs.writeFileSync(path.join(vault, "skills.json"), JSON.stringify(m));
  fs.rmSync(path.join(vault, "skills", "skill-vault"), { recursive: true, force: true });
};
const bundledMd = () => path.join(appRoot, "bundled-skills", "skill-vault", "SKILL.md");
const zipSkillMd = async () => {
  const AdmZip = (await import("adm-zip")).default;
  return new AdmZip(path.join(stageDir, "skill-vault.zip")).readAsText("skill-vault/SKILL.md");
};

test("zip outside the vault packages the bundled copy and records nothing", async () => {
  dropFromVault();
  fs.writeFileSync(bundledMd(), SKILL_MD + "\nBundled\n");
  const body = (await (await post("/skill/zip")).json()) as { from_vault: boolean };
  assert.equal(body.from_vault, false);
  assert.ok((await zipSkillMd()).includes("Bundled"));
  assert.equal(manifestSkills()["skill-vault"], undefined);
});

test("a skipped import (bundled folder missing) is a 409 and leaves the vault alone", async () => {
  const dir = path.join(appRoot, "bundled-skills");
  const moved = path.join(root, "bundled-moved");
  fs.renameSync(dir, moved);
  try {
    const res = await post("/skill/add");
    assert.equal(res.status, 409);
    assert.equal(manifestSkills()["skill-vault"], undefined);
  } finally {
    fs.renameSync(moved, dir);
  }
});

test("adding when already up to date succeeds without changes; zip then packages the vault copy", async () => {
  assert.equal((await post("/skill/add")).status, 200);
  assert.equal(((await (await post("/skill/add")).json()) as { updated: string[] }).updated.length, 0);
  const edited = path.join(vault, "skills", "skill-vault", "SKILL.md");
  fs.writeFileSync(edited, SKILL_MD + "\nVaultCopy\n");
  const body = (await (await post("/skill/zip")).json()) as { from_vault: boolean };
  assert.equal(body.from_vault, true);
  assert.ok((await zipSkillMd()).includes("VaultCopy"));
  const { hashSkillDirNormalized } = await import("../services/skillHash.ts");
  assert.equal(manifestSkills()["skill-vault"].desktop_package.content_hash, hashSkillDirNormalized(path.join(vault, "skills", "skill-vault")));
});
