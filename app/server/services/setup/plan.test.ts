import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { effectiveTargets, planSkills } from "./plan.ts";
import { startDraft } from "./draft.ts";

const skill = (dir: string, name: string, body = "A") => {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\n---\n${body}\n`);
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-plan-"));
  const vault = path.join(root, "vault");
  const vs = path.join(vault, "skills");
  const t1 = path.join(root, "t1");
  const t2 = path.join(root, "t2");
  for (const d of [vs, t1, t2]) fs.mkdirSync(d, { recursive: true });
  skill(vs, "linked");
  fs.symlinkSync(path.join(vs, "linked"), path.join(t1, "linked"), "junction");
  skill(vs, "same");
  skill(t1, "same");
  skill(vs, "changed", "A");
  skill(t1, "changed", "B");
  skill(t1, "newone");
  skill(t2, "newone");
  skill(t1, "split", "A");
  skill(t2, "split", "B");
  skill(vs, "vaultonly");
  return { root, vault, t1, t2 };
}

test("existing vault: linked and identical skills are left alone", () => {
  const f = fixture();
  try {
    const plan = planSkills({
      vault: { mode: "existing", path: f.vault },
      targets: [
        { id: "t1", path: f.t1, is_default: true },
        { id: "t2", path: f.t2, is_default: false },
      ],
    });
    assert.deepEqual(plan.adopt, [{ name: "newone", from: "t1", path: path.join(f.t1, "newone") }]);
    assert.deepEqual(plan.adopt_conflicts, [{ name: "split", targets: ["t1", "t2"] }]);
    assert.deepEqual(plan.differs, [{ name: "changed", target: "t1", unknown: false }]);
    assert.deepEqual(plan.push, [{ name: "vaultonly", missing_in: ["t1"] }]);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("new vault: everything in the targets is adoptable", () => {
  const f = fixture();
  try {
    const plan = planSkills({ vault: { mode: "new", path: path.join(f.root, "fresh") }, targets: [{ id: "t1", path: f.t1, is_default: true }] });
    assert.deepEqual(plan.adopt.map((a) => a.name), ["changed", "linked", "newone", "same", "split"]);
    assert.deepEqual(plan.push, []);
    assert.deepEqual(plan.differs, []);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("clone: same-name skills can't be compared yet", () => {
  const f = fixture();
  try {
    const plan = planSkills({
      vault: { mode: "clone", path: path.join(f.root, "clone"), clone_skill_names: ["changed", "x"] },
      targets: [{ id: "t1", path: f.t1, is_default: true }],
    });
    assert.deepEqual(plan.differs, [{ name: "changed", target: "t1", unknown: true }]);
    assert.deepEqual(plan.push, [{ name: "x", missing_in: ["t1"] }]);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("effectiveTargets: draft targets when chosen, else the config's", () => {
  const draft = startDraft({ vault_path: "C:\\v", agent_locations: {}, default_targets: [], machine_id: null, repo_url: null });
  const cfg = { vault_path: "C:\\v", providers: [{ id: "claude", path: "C:\\c" }, { id: "cursor", path: "C:\\u" }], default_targets: ["cursor"] };
  assert.deepEqual(effectiveTargets(draft, cfg), [
    { id: "claude", path: "C:\\c", is_default: false },
    { id: "cursor", path: "C:\\u", is_default: true },
  ]);
  const chosen = { ...draft, targets: [{ id: "a", path: "C:\\a", enabled: true, is_default: true, known: false }, { id: "b", path: "C:\\b", enabled: false, is_default: false, known: false }] };
  assert.deepEqual(effectiveTargets(chosen, cfg), [{ id: "a", path: "C:\\a", is_default: true }]);
});
