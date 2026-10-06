import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkUpdates } from "./updates.ts";

/**
 * The pull flag: with `pull:false` a local git-checkout origin is compared
 * as-is — no `git pull` attempt at all. With the default (pull on), the
 * pull runs and, against this fake .git dir, degrades to the documented
 * "compared without pull" message. Proves the flag gates the pull branch.
 */
test("checkUpdates pull:false skips the ff-pull for local git-checkout origins", async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "sv-upd-vault-"));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "sv-upd-src-"));
  // Identical content on both sides → up_to_date either way.
  for (const root of [path.join(vault, "skills", "s"), path.join(source, "s")]) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "SKILL.md"), "---\nname: s\n---\nbody\n");
  }
  fs.mkdirSync(path.join(source, ".git")); // looks like a checkout; not a real repo
  fs.writeFileSync(
    path.join(vault, "skills.json"),
    JSON.stringify({
      skills: {
        s: {
          targets: [],
          origin: { type: "dir", path: source, subpath: "s", adopted_at: "2026-01-01T00:00:00Z", content_hash: "x" },
        },
      },
    }),
  );

  const [noPull] = await checkUpdates(vault, ["s"], { pull: false });
  assert.equal(noPull.status, "up_to_date");
  assert.equal(noPull.git_pulled, undefined, "pull must not even be attempted");
  assert.equal(noPull.message, undefined);

  const [withPull] = await checkUpdates(vault, ["s"]);
  assert.equal(withPull.status, "up_to_date");
  assert.equal(withPull.git_pulled, false, "default still tries the pull (and degrades here)");
  assert.match(withPull.message ?? "", /compared without pull/);
});
