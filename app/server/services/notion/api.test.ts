import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSkillsSchema, parseDataSourceIds, parseDataSourceName, parseSchemaProperties, rowFromSql, pageIdFromUrl, NotionApi,
} from "./api.ts";

const SKILLS_DS = "11111111-2222-3333-4444-555555555555";
const TEAM_DS = "66666666-7777-8888-9999-000000000000";
const OTHER_DS = "aaaaaaaa-0000-0000-0000-bbbbbbbbbbbb";
const SKILLS_DB = "cccccccc-0000-0000-0000-dddddddddddd";

/** A data source as notion-fetch returns it (state JSON inside <data-source-state>). */
const dsText = (id: string, name: string, schema: Record<string, { type: string }>) =>
  `<data-source url="{{collection://${id}}}">
The title of this Data Source is: ${name}
<data-source-state>
${JSON.stringify({ name, schema, url: `collection://${id}` })}
</data-source-state>
</data-source>`;

const SKILLS_SCHEMA = {
  "Skill name": { type: "title" },
  Description: { type: "text" },
  Files: { type: "file" },
  "Last edited": { type: "last_edited_time" },
};
const DS_TEXT = dsText(SKILLS_DS, "Skills", SKILLS_SCHEMA);

/** A database as notion-fetch returns it: its data sources in <data-source url="{{collection://…}}"> tags. */
const DB_TEXT = `<database url="{{https://app.notion.com/p/ccccccccdddddddd0000000000000000}}">
The title of this Database is: Skills
<data-sources>
${DS_TEXT}
</data-sources>
</database>`;

test("parses schema, data source name, and a database's data source ids", () => {
  assert.equal(parseSchemaProperties(DS_TEXT)["Last edited"].type, "last_edited_time");
  assert.equal(parseDataSourceName(DS_TEXT), "Skills");
  assert.equal(parseDataSourceName("<page/>"), null);
  assert.deepEqual(parseDataSourceIds(DB_TEXT), [SKILLS_DS]);
  assert.deepEqual(parseDataSourceIds(`<parent-data-source url="collection://${SKILLS_DS}" name="Skills"/>`), []);
});

test("a Skills schema has Skill name (title), Description (text) and Files (file)", () => {
  assert.equal(isSkillsSchema(SKILLS_SCHEMA), true);
  assert.equal(isSkillsSchema({ Name: { type: "title" }, Files: { type: "file" } }), false);
  assert.equal(isSkillsSchema({ ...SKILLS_SCHEMA, Files: { type: "url" } }), false);
  assert.equal(isSkillsSchema({}), false);
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

test("detects Skills data sources from notion-search: databases and skill pages' parents, skills-shaped only", async () => {
  const searches: Array<Record<string, unknown>> = [];
  const fetched: string[] = [];
  const api = new NotionApi(async (name, args) => {
    if (name === "notion-search") {
      searches.push(args);
      return {
        results: [
          { id: SKILLS_DB, title: "Skills", url: "https://app.notion.com/p/x?pvs=204", type: "database" },
          { id: "p1", title: "skill-creator", type: "page", parent_data_source_url: `collection://${SKILLS_DS}` },
          { id: "p2", title: "Skills for Claude!", type: "page", parent_data_source_url: `collection://${OTHER_DS}` },
          { id: "p3", title: "Team skill", type: "page", parent_data_source_url: `collection://${TEAM_DS}` },
          { id: "p4", title: "Loose page about skills", type: "page" },
        ],
      };
    }
    if (name === "notion-fetch") {
      const id = String(args.id);
      fetched.push(id);
      if (id === SKILLS_DB) return { text: DB_TEXT };
      if (id === `collection://${SKILLS_DS}`) return { text: DS_TEXT };
      if (id === `collection://${TEAM_DS}`) return { text: dsText(TEAM_DS, "Team skills", SKILLS_SCHEMA) };
      if (id === `collection://${OTHER_DS}`) {
        return { text: dsText(OTHER_DS, "Claude and DEV", { Name: { type: "title" }, URL: { type: "url" } }) };
      }
    }
    throw new Error(`unexpected tool call ${name} ${JSON.stringify(args)}`);
  });
  assert.deepEqual(await api.detectSkillsDataSources(), [
    { id: SKILLS_DS, name: "Skills" },
    { id: TEAM_DS, name: "Team skills" },
  ]);
  assert.equal(searches.length, 1);
  assert.ok(String(searches[0].query).trim(), "search needs a non-empty query");
  // Each candidate data source is checked once, despite appearing twice (database + page parent).
  assert.equal(fetched.filter((f) => f === `collection://${SKILLS_DS}`).length, 1);
});

test("detectSkillsDataSources finds an empty Skills database (no skill pages yet)", async () => {
  const api = new NotionApi(async (name, args) => {
    if (name === "notion-search") return { results: [{ id: SKILLS_DB, title: "Skills", type: "database" }] };
    if (name === "notion-fetch" && args.id === SKILLS_DB) return { text: DB_TEXT };
    if (name === "notion-fetch" && args.id === `collection://${SKILLS_DS}`) return { text: DS_TEXT };
    throw new Error(`unexpected tool call ${name}`);
  });
  assert.deepEqual(await api.detectSkillsDataSources(), [{ id: SKILLS_DS, name: "Skills" }]);
});

test("detectSkillsDataSources returns none when search finds nothing, and throws on a malformed result", async () => {
  const empty = new NotionApi(async () => ({ results: [] }));
  assert.deepEqual(await empty.detectSkillsDataSources(), []);
  const malformed = new NotionApi(async () => ({ text: "something else" }));
  await assert.rejects(malformed.detectSkillsDataSources(), /notion-search returned no results array/);
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

test("downloadSkill accepts a single-file skill returned inline (markdown, no archive url)", async () => {
  const md = "---\nname: |-\n  x\nnotion_page_id: p\n---\nbody\n";
  const api = new NotionApi(async () => ({ id: "p", version_id: "v1", markdown: md }));
  assert.deepEqual(await api.downloadSkill("p"), { versionId: "v1", markdown: md });
});

test("downloadSkill rejects a response with neither an archive url nor inline markdown", async () => {
  const api = new NotionApi(async () => ({ id: "p", version_id: "v1" }));
  await assert.rejects(api.downloadSkill("p"), /no archive or inline SKILL\.md for p/);
});

test("isBlankPage is true only when notion-fetch reports the blank-page marker", async () => {
  const texts: Record<string, string> = {
    "p-blank": "<page><blank-page>This page is blank and has no content.</blank-page></page>",
    "p-text": "<page><content>Some notes, no files</content></page>",
  };
  const seen: string[] = [];
  const api = new NotionApi(async (name, args) => {
    seen.push(name);
    return { text: texts[String(args.id)] };
  });
  assert.equal(await api.isBlankPage("p-blank"), true);
  assert.equal(await api.isBlankPage("p-text"), false);
  assert.deepEqual(seen, ["notion-fetch", "notion-fetch"]);
});
