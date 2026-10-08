import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OriginError, setSkillOrigin } from "./origin.ts";
import { __resetActivityForTests, listActivity } from "./activity.ts";
import type { UpdateCheckResult } from "../types/vault.ts";

let vault: string;

beforeEach(() => {
  __resetActivityForTests();
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "sv-origin-"));
  const dir = path.join(vault, "skills", "pdf-tools");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: pdf-tools\ndescription: d\n---\nbody\n");
  fs.writeFileSync(
    path.join(vault, "skills.json"),
    JSON.stringify({
      skills: {
        "pdf-tools": {
          targets: ["claude"],
          source: "adopted",
          origin: {
            type: "dir",
            path: "C:\\old\\clone",
            subpath: "skills/pdf-tools",
            adopted_at: "2026-01-01T00:00:00Z",
            content_hash: "oldhash",
            vendor_note: "keep me", // unknown key — must round-trip
          },
        },
      },
    }),
  );
});

function readEntry(): Record<string, unknown> {
  const manifest = JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf-8"));
  return manifest.skills["pdf-tools"];
}

test("setSkillOrigin replaces location fields wholesale, stamps adopted_at/content_hash, keeps unknown keys", async () => {
  const before = Date.now();
  const { entry } = await setSkillOrigin(vault, "pdf-tools", {
    type: "git",
    url: "https://github.com/x/skills.git",
    subpath: "skills/pdf-tools",
    ref: "main",
  });

  const origin = entry.origin as unknown as Record<string, unknown>;
  assert.equal(origin.type, "git");
  assert.equal(origin.url, "https://github.com/x/skills.git");
  assert.equal(origin.subpath, "skills/pdf-tools");
  assert.equal(origin.ref, "main");
  assert.equal(origin.path, undefined, "stale dir path must not survive a type switch");
  assert.equal(origin.vendor_note, "keep me");
  assert.notEqual(origin.content_hash, "oldhash");
  assert.ok(typeof origin.content_hash === "string" && (origin.content_hash as string).length > 0);
  assert.ok(Date.parse(origin.adopted_at as string) >= before - 1000);

  // Persisted, not just returned — and sibling manifest fields untouched.
  const onDisk = readEntry();
  assert.deepEqual((onDisk.origin as Record<string, unknown>).url, "https://github.com/x/skills.git");
  assert.deepEqual(onDisk.targets, ["claude"]);
  assert.equal(onDisk.source, "adopted");

  const acts = listActivity();
  assert.equal(acts.length, 1);
  assert.equal(acts[0].kind, "update");
  assert.equal(acts[0].ok, true);
  assert.match(acts[0].message ?? "", /origin set: git https:\/\/github\.com\/x\/skills\.git @ skills\/pdf-tools \(main\)/);
});

test("content_hash falls back to 'empty' when the vault copy has no hashable files", async () => {
  const dir = path.join(vault, "skills", "pdf-tools");
  fs.rmSync(path.join(dir, "SKILL.md"));
  const { entry } = await setSkillOrigin(vault, "pdf-tools", { type: "dir", path: "C:\\somewhere" });
  assert.equal((entry.origin as unknown as Record<string, unknown>).content_hash, "empty");
});

test("verify runs an injected update check and reports its status in the result and activity log", async () => {
  const fakeResult: UpdateCheckResult = {
    name: "pdf-tools",
    status: "update_available",
  } as UpdateCheckResult;
  const seen: Array<{ vault: string; names?: string[] }> = [];
  const { check } = await setSkillOrigin(
    vault,
    "pdf-tools",
    { type: "git", url: "https://github.com/x/skills.git", subpath: "skills/pdf-tools" },
    {
      verify: true,
      check: async (v, names) => {
        seen.push({ vault: v, names });
        return [fakeResult];
      },
    },
  );
  assert.deepEqual(seen, [{ vault, names: ["pdf-tools"] }]);
  assert.equal(check?.status, "update_available");
  assert.match(listActivity()[0].message ?? "", /recheck: update_available/);
  assert.equal(listActivity()[0].ok, true);
});

test("verify marks the activity entry not-ok when the recheck still can't find the upstream", async () => {
  await setSkillOrigin(
    vault,
    "pdf-tools",
    { type: "git", url: "https://github.com/x/skills.git" },
    {
      verify: true,
      check: async () => [{ name: "pdf-tools", status: "upstream_missing" } as UpdateCheckResult],
    },
  );
  assert.equal(listActivity()[0].ok, false);
});

test("validation: missing skill 404s; bad shapes 400 before any write", async () => {
  await assert.rejects(setSkillOrigin(vault, "nope", { type: "dir", path: "C:\\x" }), (err) => {
    assert.ok(err instanceof OriginError);
    assert.equal(err.status, 404);
    return true;
  });

  const badInputs = [
    { type: "ftp", path: "C:\\x" },
    { type: "git" }, // no url, no path
    { type: "dir" }, // no path
    { type: "provider" }, // no provider_id
    { type: "dir", path: "C:\\x", subpath: "/abs" },
    { type: "dir", path: "C:\\x", subpath: "a\\b" },
    { type: "dir", path: "C:\\x", subpath: "a/../b" },
  ] as const;
  for (const input of badInputs) {
    await assert.rejects(
      setSkillOrigin(vault, "pdf-tools", input as Parameters<typeof setSkillOrigin>[2]),
      (err) => err instanceof OriginError && err.status === 400,
      `expected 400 for ${JSON.stringify(input)}`,
    );
  }
  assert.equal((readEntry().origin as Record<string, unknown>).content_hash, "oldhash", "no write on validation failure");
  assert.equal(listActivity().length, 0);
});

test("clearSkillOrigin removes the origin, keeps the rest of the entry, and logs activity", async () => {
  const { clearSkillOrigin } = await import("./origin.ts");
  const entry = clearSkillOrigin(vault, "pdf-tools");
  assert.equal(entry.origin, undefined);
  assert.deepEqual(entry.targets, ["claude"]);
  const onDisk = readEntry();
  assert.ok(!("origin" in onDisk), "origin removed from skills.json");
  assert.equal(onDisk.source, "adopted", "sibling fields untouched");
  const acts = listActivity();
  assert.match(acts.at(-1)?.message ?? "", /origin cleared/);
  await assert.rejects(async () => clearSkillOrigin(vault, "nope"), (err) => err instanceof OriginError && err.status === 404);
});
