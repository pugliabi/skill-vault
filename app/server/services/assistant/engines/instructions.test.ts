import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { composeInstructions, composePrompt, engineNote, skillsIndex } from "./instructions.ts";

function fixturePlugin(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-plugin-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "vault-assistant.md"), "---\nname: vault-assistant\n---\n\nYou run the vault.\n");
  for (const [name, desc] of [["vault-operations", "Push, pull and update."], ["vault-format", "The skills.json format."]]) {
    fs.mkdirSync(path.join(dir, "skills", name), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n\nBody.\n`);
  }
  return dir;
}

test("skillsIndex lists each skill with its description and absolute SKILL.md path", () => {
  const dir = fixturePlugin();
  const index = skillsIndex(dir);
  assert.match(index, /^## Skills/);
  assert.ok(index.includes(`- vault-format — The skills.json format. Read: ${path.join(dir, "skills", "vault-format", "SKILL.md")}`));
  assert.ok(index.includes("- vault-operations — Push, pull and update."));
});

test("engineNote says whether subagents and a shell exist", () => {
  const codex = engineNote({ label: "OpenAI Codex", vaultToolSpelling: "vault.<tool>", subagents: false, shell: "sandboxed" });
  assert.match(codex, /running on OpenAI Codex/);
  assert.match(codex, /aren't available here/);
  assert.match(codex, /runs in a sandbox/);
  assert.doesNotMatch(codex, /only git commands are allowed/);
  const grok = engineNote({ label: "Grok Build", vaultToolSpelling: "vault__<tool>", subagents: false, shell: "git" });
  assert.match(grok, /only git commands are allowed/);
  const copilot = engineNote({ label: "GitHub Copilot CLI", vaultToolSpelling: "vault-<tool>", subagents: true, shell: "none" });
  assert.match(copilot, /Subagents work as described/);
  assert.match(copilot, /There is no shell tool here/);
  assert.match(copilot, /can't run git/);
  assert.doesNotMatch(copilot, /only git commands are allowed/);
  assert.match(copilot, /"Read", "Edit", "Write"/, "file edits exist by default");
  assert.doesNotMatch(copilot, /can't edit or create files/);
});

test("engineNote with writes: false says there are no file edits, only the vault tools", () => {
  const grok = engineNote({ label: "Grok Build", vaultToolSpelling: "vault__<tool>", subagents: false, shell: "none", writes: false });
  assert.match(grok, /can't edit or create files directly here/);
  assert.match(grok, /through the vault tools/);
  assert.match(grok, /"Read", "Glob", "Grep", "WebSearch" and "WebFetch" are your equivalent tools/);
  assert.doesNotMatch(grok, /"Edit", "Write"/);
  assert.match(grok, /There is no shell tool here/);
});

test("composeInstructions: lead body (frontmatter stripped) + note + skills; or note only", () => {
  const dir = fixturePlugin();
  const note = { label: "Grok Build", vaultToolSpelling: "vault__<tool>", subagents: false, shell: "git" as const };
  const full = composeInstructions({ pluginDir: dir, lead: "vault-assistant", note, includeLead: true });
  assert.ok(full.startsWith("You run the vault."));
  assert.ok(!full.includes("name: vault-assistant"));
  assert.match(full, /running on Grok Build/);
  assert.match(full, /## Skills/);
  const noteOnly = composeInstructions({ pluginDir: dir, lead: "vault-assistant", note, includeLead: false });
  assert.ok(!noteOnly.includes("You run the vault."));
  assert.ok(!noteOnly.includes("## Skills"));
});

test("composePrompt: instructions, then context, then the message", () => {
  assert.equal(
    composePrompt({ instructions: "I", context: "C", message: "hi" }),
    "<skill-vault-instructions>\nI\n</skill-vault-instructions>\n\n<skill-vault-context>\nC\n</skill-vault-context>\n\nhi",
  );
  assert.equal(composePrompt({ context: "C", message: "hi" }), "<skill-vault-context>\nC\n</skill-vault-context>\n\nhi");
  assert.equal(composePrompt({ context: "  ", message: "hi" }), "hi");
});
