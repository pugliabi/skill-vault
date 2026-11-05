import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The vault and adoption modules read the CLI config path at import time:
// point HOME at a temp folder before the first import.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-vskill-"));
process.env.USERPROFILE = path.join(root, "home");
process.env.HOME = path.join(root, "home");

type Mod = typeof import("./vaultSkill.ts");
let m: Mod;
let initVault: (p: string) => void;
const SKILL_MD = "---\nname: skill-vault\ndescription: test copy of the bundled skill for the shared service\n---\n\nBody\n";
let n = 0;

before(async () => {
  m = await import("./vaultSkill.ts");
  ({ initVault } = await import("../vault.ts"));
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

function fresh() {
  const dir = path.join(root, `case-${++n}`);
  const appRoot = path.join(dir, "app");
  const vault = path.join(dir, "vault");
  const tool = path.join(dir, "tool");
  fs.mkdirSync(path.join(appRoot, "bundled-skills", "skill-vault"), { recursive: true });
  fs.writeFileSync(path.join(appRoot, "bundled-skills", "skill-vault", "SKILL.md"), SKILL_MD);
  fs.mkdirSync(tool, { recursive: true });
  initVault(vault);
  return { appRoot, vault, tool, provider: { id: "claude", path: tool } };
}
const manifest = (vault: string) => JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf-8")).skills as Record<string, any>;

test("add when missing: imports with a dir origin, then reports already", () => {
  const c = fresh();
  assert.equal(m.bundledSkillState(c.appRoot, c.vault).state, "not_in_vault");
  assert.equal(m.addBundledSkillIfMissing(c.appRoot, c.vault), "added");
  assert.equal(manifest(c.vault)["skill-vault"].origin.type, "dir");
  assert.equal(m.bundledSkillState(c.appRoot, c.vault).state, "in_vault");
  assert.equal(m.addBundledSkillIfMissing(c.appRoot, c.vault), "already");
});

test("an outdated copy of ours is left alone (the guide never overwrites)", () => {
  const c = fresh();
  m.addBundledSkillIfMissing(c.appRoot, c.vault);
  fs.writeFileSync(path.join(c.appRoot, "bundled-skills", "skill-vault", "SKILL.md"), SKILL_MD + "\nNewer\n");
  assert.equal(m.bundledSkillState(c.appRoot, c.vault).state, "update_available");
  assert.equal(m.addBundledSkillIfMissing(c.appRoot, c.vault), "already");
  assert.ok(!fs.readFileSync(path.join(c.vault, "skills", "skill-vault", "SKILL.md"), "utf-8").includes("Newer"));
});

test("someone else's skill-vault is refused with a rename hint", () => {
  const c = fresh();
  fs.mkdirSync(path.join(c.vault, "skills", "skill-vault"), { recursive: true });
  fs.writeFileSync(path.join(c.vault, "skills", "skill-vault", "SKILL.md"), "mine");
  assert.equal(m.bundledSkillState(c.appRoot, c.vault).state, "name_taken");
  assert.throws(() => m.addBundledSkillIfMissing(c.appRoot, c.vault), { message: m.NAME_TAKEN });
});

test("a missing bundled folder is refused", () => {
  const c = fresh();
  fs.rmSync(path.join(c.appRoot, "bundled-skills"), { recursive: true, force: true });
  assert.throws(() => m.addBundledSkillIfMissing(c.appRoot, c.vault), { message: m.BUNDLED_MISSING });
});

test("push: needs the vault copy, pushes into an empty spot, re-pushes through our own link", () => {
  const c = fresh();
  assert.throws(() => m.pushBundledSkill(c.vault, c.provider), { message: m.NOT_IN_VAULT_YET });
  m.addBundledSkillIfMissing(c.appRoot, c.vault);
  m.pushBundledSkill(c.vault, c.provider);
  assert.ok(fs.existsSync(path.join(c.tool, "skill-vault", "SKILL.md")));
  m.pushBundledSkill(c.vault, c.provider);
  assert.ok(fs.existsSync(path.join(c.tool, "skill-vault", "SKILL.md")));
});

test("push: a tool's own skill-vault folder is never overwritten", () => {
  const c = fresh();
  m.addBundledSkillIfMissing(c.appRoot, c.vault);
  const theirs = path.join(c.tool, "skill-vault");
  fs.mkdirSync(theirs);
  fs.writeFileSync(path.join(theirs, "SKILL.md"), "mine");
  assert.throws(() => m.pushBundledSkill(c.vault, c.provider), { message: m.foreignFolderMessage(theirs) });
  assert.match(m.foreignFolderMessage(theirs), /isn't from your vault.*rename or remove it first/);
  assert.equal(fs.readFileSync(path.join(theirs, "SKILL.md"), "utf-8"), "mine");
});
