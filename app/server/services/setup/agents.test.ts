import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDraft } from "./draft.ts";
import { agentsStatus, skillInDraftVault } from "./agents.ts";
import type { SetupDraft } from "./types.ts";

const emptyBase = { vault_path: null, agent_locations: {}, default_targets: [], machine_id: "PC", repo_url: null };
const draftWith = (patch: Partial<SetupDraft>): SetupDraft => ({ ...startDraft(emptyBase), ...patch });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sv-agents-"));

test("skill state: new, clone listed or not, adopting", () => {
  assert.deepEqual(skillInDraftVault(draftWith({ vault: { mode: "new", path: "C:\\v" } })), { state: "not_in_vault" });
  const clone = (names: string[]) =>
    draftWith({ vault: { mode: "clone", path: "C:\\c", clone: { url: "https://github.com/me/v.git", dest: "C:\\c", subdir: "", skill_names: names, notion: null } } });
  assert.deepEqual(skillInDraftVault(clone(["skill-vault", "x"])), { state: "in_vault" });
  assert.deepEqual(skillInDraftVault(clone(["x"])), { state: "not_in_vault" });
  const adopting = draftWith({ vault: { mode: "new", path: "C:\\v" }, skills: { adopt: [{ name: "skill-vault", from: "cursor" }], push: [] } });
  assert.deepEqual(skillInDraftVault(adopting), { state: "adopting", adopting_from: "cursor" });
});

test("skill state for an existing vault: manifest entry, folder alone, neither", () => {
  const root = tmp();
  try {
    const v = (p: string) => draftWith({ vault: { mode: "existing", path: p } });
    const byManifest = path.join(root, "a");
    fs.mkdirSync(byManifest);
    fs.writeFileSync(path.join(byManifest, "skills.json"), JSON.stringify({ skills: { "skill-vault": { targets: [] } } }));
    assert.equal(skillInDraftVault(v(byManifest)).state, "in_vault");

    const byFolder = path.join(root, "b");
    fs.mkdirSync(path.join(byFolder, "skills", "skill-vault"), { recursive: true });
    fs.writeFileSync(path.join(byFolder, "skills.json"), "{not json");
    assert.equal(skillInDraftVault(v(byFolder)).state, "in_vault");

    const none = path.join(root, "c");
    fs.mkdirSync(none);
    fs.writeFileSync(path.join(none, "skills.json"), JSON.stringify({ skills: { other: { targets: [] } } }));
    assert.equal(skillInDraftVault(v(none)).state, "not_in_vault");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("status: bridge, Desktop and the draft's default tools", () => {
  const root = tmp();
  try {
    const bridge = path.join(root, "dist", "assistant-mcp.js");
    fs.mkdirSync(path.dirname(bridge), { recursive: true });
    fs.writeFileSync(bridge, "//");
    const env = { platform: "win32" as const, appData: path.join(root, "appdata"), home: root, exists: (p: string) => fs.existsSync(p), list: () => [] };
    const draft = draftWith({
      vault: { mode: "new", path: path.join(root, "vault") },
      targets: [
        { id: "claude", path: path.join(root, "c"), enabled: true, is_default: true, known: true },
        { id: "cursor", path: path.join(root, "u"), enabled: true, is_default: false, known: true },
      ],
    });
    const config = { providers: [], default_targets: [] };
    const st = agentsStatus(draft, { config, env, bridgePath: bridge });
    assert.equal(st.bridge_built, true);
    assert.deepEqual(st.desktop, { state: "not_installed", config_path: null });
    assert.deepEqual(st.default_targets, ["claude"]);
    assert.equal(st.vault_path, path.join(root, "vault"));
    assert.equal(agentsStatus(draft, { config, env, bridgePath: null }).bridge_built, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
