import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../../assistant-mcp/bridge.ts";
import { frontmatterValueOf } from "../skillNames.ts";
import { BUNDLED_SKILL_NAME, bundledSkillDir, installPrompt, readBundledSkillMd } from "./bundledSkill.ts";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const md = readBundledSkillMd(APP_ROOT);

test("the bundled skill is a single SKILL.md named skill-vault", () => {
  assert.equal(BUNDLED_SKILL_NAME, "skill-vault");
  assert.deepEqual(fs.readdirSync(bundledSkillDir(APP_ROOT)), ["SKILL.md"]);
  assert.equal(frontmatterValueOf(md, "name"), "skill-vault");
  assert.ok((frontmatterValueOf(md, "description") ?? "").length > 80);
});

test("the bundled skill holds nothing personal", () => {
  assert.doesNotMatch(md, /[A-Za-z]:\\Users\\/);
  assert.doesNotMatch(md, /\/Users\/|\/home\//);
  assert.doesNotMatch(md, /[\w.+-]+@[\w-]+\.[\w.]+/);
});

test("every tool the skill names exists in the bridge", () => {
  const named = [
    "list_skills", "search_skills", "get_skill", "read_skill_files", "save_skill", "get_config",
    "push_to_provider", "pull_from_provider", "package_for_desktop", "notion_status", "notion_plan",
    "notion_run", "notion_push", "check_updates", "apply_update", "audit_vault",
  ];
  for (const name of named) {
    assert.ok(md.includes(`\`${name}`), `SKILL.md should mention ${name}`);
    assert.ok(name in TOOLS, `bridge should have ${name}`);
  }
  // Every backticked snake_case identifier must be a real tool, so a typo or a stale name fails.
  const identifiers = [...md.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]);
  assert.ok(identifiers.length > 0);
  for (const id of identifiers) {
    assert.ok(Object.hasOwn(TOOLS, id), `SKILL.md names \`${id}\`, which is not a bridge tool`);
  }
});

test("the install prompt carries SKILL.md verbatim inside a fence it can't break", () => {
  const prompt = installPrompt(md);
  assert.ok(prompt.includes(md.trimEnd()));
  assert.match(prompt, /^Please install this as a Claude skill/);
  assert.ok(prompt.includes("````markdown\n"));
});
