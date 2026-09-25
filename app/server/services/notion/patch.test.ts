import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSkillMd, overlayNotionSkillMd, stripNotionPageId } from "./patch.ts";

const body = (lines: string[]) => lines.join("\n") + "\n";
const FM = "---\nname: demo\ndescription: old\n---\n";
const NOTION_FM = "---\nname: |-\n  demo\ndescription: |-\n  old\nnotion_page_id: p-1\n---\n";

test("non-overlapping edits on both sides merge", () => {
  const base = NOTION_FM + body(["a", "b", "c", "d", "e"]);
  const notion = NOTION_FM + body(["a", "B from notion", "c", "d", "e"]);
  const vault = FM + body(["a", "b", "c", "d", "E from vault"]);
  const r = mergeSkillMd(base, notion, vault);
  assert.ok(r.ok, !r.ok ? r.reason : "");
  assert.equal(r.text, FM + body(["a", "B from notion", "c", "d", "E from vault"]));
});

test("same-line edits on both sides do not merge", () => {
  const base = NOTION_FM + body(["a", "b", "c"]);
  const notion = NOTION_FM + body(["a", "notion b", "c"]);
  const vault = FM + body(["a", "vault b", "c"]);
  const r = mergeSkillMd(base, notion, vault);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /SKILL\.md/);
});

test("vault-only frontmatter fields are preserved and notion_page_id is never written", () => {
  const vault = "---\nname: demo\ndescription: old\nlicense: MIT\nallowed-tools:\n  - Read\n  - Bash\n---\nbody\n";
  const base = NOTION_FM + "body\n";
  const notion = NOTION_FM + "body\nmore\n";
  const r = mergeSkillMd(base, notion, vault);
  assert.ok(r.ok);
  assert.equal(r.text, "---\nname: demo\ndescription: old\nlicense: MIT\nallowed-tools:\n  - Read\n  - Bash\n---\nbody\nmore\n");
  assert.doesNotMatch(r.text, /notion_page_id/);
});

test("a vault notion_page_id line is dropped too", () => {
  const vault = "---\nname: demo\ndescription: old\nnotion_page_id: p-1\n---\nbody\n";
  const r = mergeSkillMd(NOTION_FM + "body\n", NOTION_FM + "body\n", vault);
  assert.ok(r.ok);
  assert.equal(r.text, FM + "body\n");
});

test("a Notion description change is applied; an unchanged one keeps the vault formatting", () => {
  const vault = "---\nname: demo\ndescription: \"old\"\nlicense: MIT\n---\nbody\n";
  const notion = "---\nname: |-\n  demo\ndescription: |-\n  new: with a colon\nnotion_page_id: p-1\n---\nbody\n";
  const r = mergeSkillMd(NOTION_FM + "body\n", notion, vault);
  assert.ok(r.ok);
  assert.equal(r.text, "---\nname: demo\ndescription: \"new: with a colon\"\nlicense: MIT\n---\nbody\n");

  const same = mergeSkillMd(NOTION_FM + "body\n", NOTION_FM + "body\n", vault);
  assert.ok(same.ok);
  assert.equal(same.text, vault);
});

test("both sides changing the description differently is a conflict", () => {
  const vault = "---\nname: demo\ndescription: vault wording\n---\nbody\n";
  const notion = "---\nname: demo\ndescription: notion wording\n---\nbody\n";
  const r = mergeSkillMd(NOTION_FM + "body\n", notion, vault);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /description/);
});

test("vault CRLF line endings are preserved", () => {
  const vault = (FM + body(["a", "b", "c"])).replace(/\n/g, "\r\n");
  const base = NOTION_FM + body(["a", "b", "c"]);
  const notion = NOTION_FM + body(["a", "b2", "c"]);
  const r = mergeSkillMd(base, notion, vault);
  assert.ok(r.ok);
  assert.equal(r.text, (FM + body(["a", "b2", "c"])).replace(/\n/g, "\r\n"));
});

test("trailing/leading blank-line differences do not block a Notion append", () => {
  const base = NOTION_FM + "a\nb"; // Notion drops the final newline
  const notion = NOTION_FM + "a\nb\nc";
  const vault = FM + "\na\nb\n";
  const r = mergeSkillMd(base, notion, vault);
  assert.ok(r.ok, !r.ok ? r.reason : "");
  assert.equal(r.text, FM + "\na\nb\nc\n");
});

test("stripNotionPageId removes only the frontmatter key", () => {
  assert.equal(stripNotionPageId(NOTION_FM + "notion_page_id: in body\n"), "---\nname: |-\n  demo\ndescription: |-\n  old\n---\nnotion_page_id: in body\n");
  const plain = "---\nname: demo\n---\nbody";
  assert.equal(stripNotionPageId(plain), plain);
  assert.equal(stripNotionPageId("no frontmatter"), "no frontmatter");
});

test("overlayNotionSkillMd takes Notion's body and name/description, keeps vault extras", () => {
  const vault = "---\r\nname: demo\r\ndescription: old\r\nlicense: MIT\r\n---\r\nvault body\r\n";
  const notion = "---\nname: |-\n  demo\ndescription: |-\n  fresh\nnotion_page_id: p-1\n---\nnotion body\n";
  assert.equal(
    overlayNotionSkillMd(notion, vault),
    "---\r\nname: demo\r\ndescription: fresh\r\nlicense: MIT\r\n---\r\nnotion body\r\n",
  );
  assert.equal(overlayNotionSkillMd(notion, null), "---\nname: |-\n  demo\ndescription: |-\n  fresh\n---\nnotion body\n");
});

test("a Notion punctuation-only description change is applied when the vault didn't change it", () => {
  const base = "---\nname: demo\ndescription: Use this, then that\n---\nbody\n";
  const notion = "---\nname: demo\ndescription: Use this; then that.\nnotion_page_id: p-1\n---\nbody\n";
  const vault = "---\nname: demo\ndescription: Use this, then that\nlicense: MIT\n---\nbody\n";
  const r = mergeSkillMd(base, notion, vault);
  assert.ok(r.ok, !r.ok ? r.reason : "");
  assert.equal(r.text, "---\nname: demo\ndescription: Use this; then that.\nlicense: MIT\n---\nbody\n");
});
