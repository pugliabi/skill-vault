import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pushSkillToProvider } from "./pushSkill.ts";

test("links the skill into the provider and records the target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-push-"));
  try {
    const vault = path.join(root, "vault");
    fs.mkdirSync(path.join(vault, "skills", "a"), { recursive: true });
    fs.writeFileSync(path.join(vault, "skills", "a", "SKILL.md"), "---\nname: a\n---\n");
    fs.writeFileSync(path.join(vault, "skills.json"), JSON.stringify({ skills: { a: { targets: [] } } }));
    const provider = { id: "claude", path: path.join(root, "claude") };
    fs.mkdirSync(provider.path);
    const r = pushSkillToProvider(vault, "a", provider);
    assert.equal(r.skill, "a");
    assert.ok(fs.existsSync(path.join(provider.path, "a", "SKILL.md")));
    const manifest = JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf8"));
    assert.deepEqual(manifest.skills.a.targets, ["claude"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
