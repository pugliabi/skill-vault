import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installAssistantSkills, listPluginSkills } from "./installer.ts";
import { __resetActivityForTests } from "../activity.ts";

let vault: string;
let plugin: string;
let agentsDir: string;

beforeEach(() => {
  __resetActivityForTests();
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "sv-inst-vault-"));
  plugin = fs.mkdtempSync(path.join(os.tmpdir(), "sv-inst-plugin-"));
  agentsDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sv-inst-agents-")), "agents");
  fs.writeFileSync(path.join(vault, "skills.json"), JSON.stringify({ skills: {} }));
  for (const name of ["vault-format", "syncing-from-github"]) {
    const dir = path.join(plugin, "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
  }
  // A non-skill directory must be ignored.
  fs.mkdirSync(path.join(plugin, "skills", "not-a-skill"), { recursive: true });
  fs.mkdirSync(path.join(plugin, "agents"), { recursive: true });
  fs.writeFileSync(path.join(plugin, "agents", "repo-hunter.md"), "---\nname: repo-hunter\n---\nx\n");
});

test("listPluginSkills returns only folders with a SKILL.md", () => {
  assert.deepEqual(listPluginSkills(plugin), ["syncing-from-github", "vault-format"]);
});

test("install copies skills, records a dir origin at the plugin, and installs agents", () => {
  const result = installAssistantSkills({ vaultPath: vault, pluginDir: plugin, agentsDir });
  assert.deepEqual(result.installed_skills, ["syncing-from-github", "vault-format"]);
  assert.deepEqual(result.installed_agents, ["repo-hunter.md"]);

  assert.ok(fs.existsSync(path.join(vault, "skills", "vault-format", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(agentsDir, "repo-hunter.md")));

  const manifest = JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf-8"));
  const entry = manifest.skills["vault-format"];
  assert.equal(entry.source, "installed from Skill Vault assistant");
  assert.equal(entry.origin.type, "dir");
  assert.equal(entry.origin.path, plugin);
  assert.equal(entry.origin.subpath, "skills/vault-format");
  assert.ok(entry.origin.content_hash.length > 0);
});

test("existing skills and agents are skipped without overwrite, replaced with it", () => {
  installAssistantSkills({ vaultPath: vault, pluginDir: plugin, agentsDir });
  // Local edit that must not be clobbered silently.
  fs.writeFileSync(path.join(vault, "skills", "vault-format", "SKILL.md"), "edited\n");

  const second = installAssistantSkills({ vaultPath: vault, pluginDir: plugin, agentsDir });
  assert.deepEqual(second.installed_skills, []);
  assert.equal(second.skipped_skills.length, 2);
  assert.equal(fs.readFileSync(path.join(vault, "skills", "vault-format", "SKILL.md"), "utf-8"), "edited\n");
  assert.equal(second.skipped_agents.length, 1);

  const third = installAssistantSkills({ vaultPath: vault, pluginDir: plugin, skills: ["vault-format"], overwrite: true });
  assert.deepEqual(third.installed_skills, ["vault-format"]);
  assert.match(fs.readFileSync(path.join(vault, "skills", "vault-format", "SKILL.md"), "utf-8"), /name: vault-format/);
});

test("unknown requested skills are reported, not errored", () => {
  const result = installAssistantSkills({ vaultPath: vault, pluginDir: plugin, skills: ["nope"] });
  assert.deepEqual(result.installed_skills, []);
  assert.deepEqual(result.skipped_skills, [{ name: "nope", reason: "not in the plugin bundle" }]);
});
