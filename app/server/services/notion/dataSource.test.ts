import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LAST_EDITED_PROPERTY, chooseDataSource } from "./dataSource.ts";

const ID = "11111111-2222-3333-4444-555555555555";

test("adds the Last edited property when asked and saves the choice", async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "sv-ds-"));
  try {
    let added = false;
    const api = {
      hasProperty: async () => added,
      addLastEditedProperty: async () => {
        added = true;
      },
    };
    const r = await chooseDataSource(api, vault, { id: ID, name: "Skills", add_last_edited: true });
    assert.deepEqual(r, { last_edited_property: LAST_EDITED_PROPERTY });
    const saved = JSON.parse(fs.readFileSync(path.join(vault, "notion.json"), "utf8"));
    assert.equal(saved.data_source_id, ID);
    assert.equal(saved.data_source_name, "Skills");
    assert.equal(saved.last_edited_property, LAST_EDITED_PROPERTY);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test("without the property and not asked: null, plus a warning when adding fails", async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "sv-ds-"));
  try {
    const none = { hasProperty: async () => false, addLastEditedProperty: async () => {} };
    assert.deepEqual(await chooseDataSource(none, vault, { id: ID, name: "", add_last_edited: false }), { last_edited_property: null });
    const broken = { hasProperty: async () => false, addLastEditedProperty: async () => { throw new Error("no access"); } };
    const r = await chooseDataSource(broken, vault, { id: ID, name: "", add_last_edited: true });
    assert.equal(r.last_edited_property, null);
    assert.match(r.warning ?? "", /no access/);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});
