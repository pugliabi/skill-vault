import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let home: string;
let vault: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sv-nhome-"));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "sv-nvault-"));
  fs.writeFileSync(
    path.join(vault, "skills.json"),
    JSON.stringify({ version: "1.0", skills: { demo: { targets: ["claude"], tags: ["x"], extra: 1 } } }),
  );
});

const load = () => import("./store.ts");

test("notion.json round-trips and preserves unknown keys", async () => {
  const s = await load();
  assert.deepEqual(s.readNotionSettings(vault), {});
  fs.writeFileSync(path.join(vault, "notion.json"), JSON.stringify({ future: true }));
  s.writeNotionSettings(vault, { ...s.readNotionSettings(vault), data_source_id: "ds-1" });
  const raw = JSON.parse(fs.readFileSync(path.join(vault, "notion.json"), "utf8"));
  assert.equal(raw.future, true);
  assert.equal(raw.data_source_id, "ds-1");
});

test("auth and cache live under the home dir resolved at call time", async () => {
  const s = await load();
  s.writeNotionAuth({ code_verifier: "v" });
  assert.equal(s.readNotionAuth().code_verifier, "v");
  assert.ok(fs.existsSync(path.join(home, ".skill-vault", "notion-auth.json")));
  s.clearNotionAuth();
  assert.deepEqual(s.readNotionAuth(), {});
  assert.deepEqual(s.readNotionCache(), { rows: [] });
  s.writeNotionCache({ checked_at: "t", rows: [{ page_id: "p", title: "a", description: "", tags: [], has_files: false }] });
  assert.equal(s.readNotionCache().rows.length, 1);
});

test("setNotionLink patches one entry and keeps other fields", async () => {
  const s = await load();
  s.setNotionLink(vault, "demo", { page_id: "p1", state: "linked", linked_at: "t" });
  const m = JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf8"));
  assert.equal(m.version, "1.0");
  assert.deepEqual(m.skills.demo.targets, ["claude"]);
  assert.equal(m.skills.demo.extra, 1);
  assert.equal(m.skills.demo.notion.page_id, "p1");
  s.setNotionLink(vault, "demo", undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf8")).skills.demo.notion, undefined);
  assert.throws(() => s.setNotionLink(vault, "ghost", { page_id: "p", state: "linked", linked_at: "t" }));
});
