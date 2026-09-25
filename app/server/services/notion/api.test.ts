import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseParentDataSource, parseSchemaProperties, rowFromSql, pageIdFromUrl, NotionApi,
} from "./api.ts";

const PAGE_TEXT = `<page url="https://app.notion.com/p/aaaaaaaabbbbccccddddeeeeeeeeeeee">
<ancestor-path>
<parent-data-source url="collection://11111111-2222-3333-4444-555555555555" name="Skills"/>
</ancestor-path>
</page>`;

const DS_TEXT = `<data-source url="{{collection://11111111-2222-3333-4444-555555555555}}">
<data-source-state>
{"name":"Skills","schema":{"Skill name":{"name":"Skill name","type":"title"},"Last edited":{"name":"Last edited","type":"last_edited_time"},"Files":{"name":"Files","type":"file"}}}
</data-source-state>
</data-source>`;

test("parses parent data source and schema", () => {
  assert.deepEqual(parseParentDataSource(PAGE_TEXT), {
    url: "collection://11111111-2222-3333-4444-555555555555",
    id: "11111111-2222-3333-4444-555555555555",
    name: "Skills",
  });
  assert.equal(parseSchemaProperties(DS_TEXT)["Last edited"].type, "last_edited_time");
  assert.equal(parseParentDataSource("<page/>"), null);
});

test("page ids and SQL rows", () => {
  assert.equal(pageIdFromUrl("https://app.notion.com/aaaaaaaabbbbccccddddeeeeeeeeeeee"), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(
    pageIdFromUrl("https://app.notion.com/p/aaaaaaaabbbbccccddddeeeeeeeeeeee?mcpSkillSearchRequestId=11111111-2222-3333-4444-555555555555"),
    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  );
  assert.equal(
    pageIdFromUrl("https://app.notion.com/p/aaaaaaaabbbbccccddddeeeeeeeeeeee?pvs=204"),
    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  );
  assert.equal(
    pageIdFromUrl("https://app.notion.com/p/My-Page-Title-aaaaaaaabbbbccccddddeeeeeeeeeeee"),
    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  );
  assert.equal(
    pageIdFromUrl("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  );
  const row = rowFromSql(
    {
      url: "https://app.notion.com/aaaaaaaabbbbccccddddeeeeeeeeeeee",
      "Skill name": "demo-skill",
      Description: "d",
      Tags: '["Fabric","CLI"]',
      Files: '["<folder url=\\"x\\">references</folder>"]',
      "Last edited": "2026-01-02T03:04:05.000Z",
    },
    "Last edited",
  );
  assert.deepEqual(row, {
    page_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    title: "demo-skill",
    description: "d",
    tags: ["Fabric", "CLI"],
    has_files: true,
    edited_at: "2026-01-02T03:04:05.000Z",
  });
  assert.equal(rowFromSql({ url: "https://app.notion.com/aaaaaaaabbbbccccddddeeeeeeeeeeee", "Skill name": "x", Files: null, Tags: null }, null).has_files, false);
});

test("listRows pages through SQL results 100 at a time", async () => {
  const calls: any[] = [];
  const mk = (n: number, off: number) =>
    Array.from({ length: n }, (_, i) => ({
      url: `https://app.notion.com/${(off + i).toString(16).padStart(32, "0")}`,
      "Skill name": `s${off + i}`,
    }));
  const api = new NotionApi(async (name, args) => {
    calls.push({ name, args });
    const off = Number(/OFFSET (\d+)/.exec(String(args.data && (args.data as any).query))?.[1] ?? 0);
    return { results: off === 0 ? mk(100, 0) : mk(38, 100), has_more: false };
  });
  const rows = await api.listRows("ds", null);
  assert.equal(rows.length, 138);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, "notion-query-data-sources");
  assert.deepEqual(calls[0].args.data.data_source_urls, ["collection://ds"]);
});

const fullPage = (off: number) =>
  Array.from({ length: 100 }, (_, i) => ({
    url: `https://app.notion.com/${(off + i).toString(16).padStart(32, "0")}`,
    "Skill name": `s${off + i}`,
  }));

test("listRows throws when the tool returns no results array", async () => {
  for (const reply of [{}, { results: "nope" }, { text: "error text" }, null]) {
    const api = new NotionApi(async () => reply);
    await assert.rejects(api.listRows("ds", null), /no results array/);
  }
});

test("listRows stops when OFFSET is ignored (same first url twice)", async () => {
  let calls = 0;
  const api = new NotionApi(async () => {
    calls++;
    return { results: fullPage(0) };
  });
  const rows = await api.listRows("ds", null);
  assert.equal(calls, 2);
  assert.equal(rows.length, 100);
});

test("listRows caps at 100 pages", async () => {
  let calls = 0;
  const api = new NotionApi(async (_name, args) => {
    calls++;
    const off = Number(/OFFSET (\d+)/.exec(String((args.data as any).query))?.[1] ?? 0);
    return { results: fullPage(off) };
  });
  const rows = await api.listRows("ds", null);
  assert.equal(calls, 100);
  assert.equal(rows.length, 10000);
});

test("listRows skips rows without a usable url", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const api = new NotionApi(async () => ({
      results: [
        { url: "https://app.notion.com/aaaaaaaabbbbccccddddeeeeeeeeeeee", "Skill name": "ok" },
        { "Skill name": "no-url" },
        { url: "https://app.notion.com/not-an-id", "Skill name": "bad-url" },
        { url: 42, "Skill name": "numeric" },
      ],
    }));
    const rows = await api.listRows("ds", null);
    assert.deepEqual(rows.map((r) => r.title), ["ok"]);
  } finally {
    console.warn = warn;
  }
});

test("detects distinct Skills data sources from search results", async () => {
  const api = new NotionApi(async (name) => {
    if (name === "notion-search-skills") return { results: [{ name: "a", url: "u1" }, { name: "b", url: "u2" }] };
    if (name === "notion-fetch") return { text: PAGE_TEXT };
    throw new Error(name);
  });
  assert.deepEqual(await api.detectSkillsDataSources(), [
    { id: "11111111-2222-3333-4444-555555555555", name: "Skills" },
  ]);
});

test("downloadSkill and addLastEditedProperty call the right tools", async () => {
  const seen: any[] = [];
  const api = new NotionApi(async (name, args) => {
    seen.push({ name, args });
    if (name === "notion-download-skill") return { id: "p", version_id: "v1", url: "https://x.test/a.tar.gz" };
    return {};
  });
  assert.deepEqual(await api.downloadSkill("p"), { versionId: "v1", url: "https://x.test/a.tar.gz" });
  await api.addLastEditedProperty("ds", "Last edited");
  assert.deepEqual(seen[1], {
    name: "notion-update-data-source",
    args: { data_source_id: "ds", statements: 'ADD COLUMN "Last edited" LAST_EDITED_TIME' },
  });
});
