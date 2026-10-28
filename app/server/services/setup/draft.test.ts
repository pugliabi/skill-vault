import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DraftError,
  configFingerprint,
  deleteDraft,
  draftPath,
  normalizeDraft,
  readDraft,
  startDraft,
  writeDraft,
} from "./draft.ts";
import type { SetupBase } from "./types.ts";

const base: SetupBase = {
  vault_path: "C:\\v",
  agent_locations: { claude: "C:\\h\\.claude\\skills", cursor: "C:\\h\\.cursor\\skills" },
  default_targets: ["claude"],
  machine_id: "PC1",
  repo_url: "https://github.com/me/vault.git",
};
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "sv-draft-"));

test("startDraft fills in from config", () => {
  const d = startDraft(base, new Date("2026-10-28T00:00:00Z"));
  assert.equal(d.started_at, "2026-10-28T00:00:00.000Z");
  assert.equal(d.step, "vault");
  assert.deepEqual(d.vault, { mode: "existing", path: "C:\\v", repo_url: "https://github.com/me/vault.git" });
  assert.equal(d.machine_id, "PC1");
  assert.equal(d.targets, null);
  assert.equal(d.notion, null);
  assert.equal(d.assistant, null);
  assert.deepEqual(d.skills, { adopt: [], push: [] });
  assert.equal(d.base, configFingerprint(base));
});

test("startDraft on first run has no vault and uses the computer name", () => {
  const d = startDraft({ vault_path: null, agent_locations: {}, default_targets: [], machine_id: null, repo_url: null });
  assert.equal(d.vault, null);
  assert.equal(d.machine_id, os.hostname());
});

test("fingerprint ignores key order but sees target changes", () => {
  const reordered = { ...base, agent_locations: { cursor: base.agent_locations.cursor, claude: base.agent_locations.claude } };
  assert.equal(configFingerprint(reordered), configFingerprint(base));
  assert.notEqual(configFingerprint({ ...base, default_targets: ["cursor"] }), configFingerprint(base));
});

test("normalizeDraft strips secrets and unknown keys", () => {
  const raw = { ...startDraft(base), assistant: { auth: "api_key", workspace_id: "w", api_key: "sk-secret" }, extra: 1 };
  const d = normalizeDraft(raw);
  assert.deepEqual(d.assistant, { auth: "api_key", workspace_id: "w" });
  assert.ok(!JSON.stringify(d).includes("sk-secret"));
  assert.ok(!("extra" in d));
});

test("normalizeDraft derives a clone's vault path from dest + subdir", () => {
  const d = normalizeDraft({
    ...startDraft(base),
    vault: {
      mode: "clone",
      path: "ignored",
      clone: { url: "https://github.com/me/v.git", dest: path.join("C:", "x", "v"), subdir: "skills", skill_names: ["a", 3], notion: null },
    },
  });
  assert.equal(d.vault?.path, path.join("C:", "x", "v", "skills"));
  assert.deepEqual(d.vault?.clone?.skill_names, ["a"]);
});

test("normalizeDraft keeps targets with spaces and rejects bad shapes", () => {
  const ok = normalizeDraft({ ...startDraft(base), targets: [{ id: "Prompting BI", path: "C:\\p", enabled: true, is_default: true, known: false }] });
  assert.equal(ok.targets?.[0].id, "Prompting BI");
  assert.throws(() => normalizeDraft({ version: 2 }), DraftError);
  assert.throws(() => normalizeDraft({ ...startDraft(base), targets: [{ id: "a/b", path: "C:\\p" }] }), DraftError);
  assert.throws(
    () => normalizeDraft({ ...startDraft(base), targets: [{ id: "a", path: "C:\\p" }, { id: "a", path: "C:\\q" }] }),
    DraftError,
  );
  assert.throws(() => normalizeDraft({ ...startDraft(base), notion: { data_source_id: "nope", data_source_name: "x" } }), DraftError);
  assert.throws(() => normalizeDraft({ ...startDraft(base), skills: { adopt: [{ name: "..", from: "claude" }], push: [] } }), DraftError);
});

test("a default target must be enabled", () => {
  const d = normalizeDraft({ ...startDraft(base), targets: [{ id: "a", path: "C:\\p", enabled: false, is_default: true }] });
  assert.equal(d.targets?.[0].is_default, false);
});

test("write, read and delete round-trip; a corrupt file reads as none", () => {
  const home = tmpHome();
  try {
    assert.equal(readDraft(home), null);
    const d = startDraft(base);
    writeDraft(d, home);
    assert.deepEqual(readDraft(home), d);
    deleteDraft(home);
    assert.equal(readDraft(home), null);
    deleteDraft(home); // no file: no throw
    fs.mkdirSync(path.dirname(draftPath(home)), { recursive: true });
    fs.writeFileSync(draftPath(home), "{not json");
    assert.equal(readDraft(home), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
