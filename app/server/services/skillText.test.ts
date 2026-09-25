import { test } from "node:test";
import assert from "node:assert/strict";
import { bodyExcerpt, frontmatterDescription, stripFrontmatter } from "./skillText.ts";

test("one-line and quoted descriptions", () => {
  assert.equal(frontmatterDescription("---\nname: a\ndescription: Does X.\n---\nbody"), "Does X.");
  assert.equal(frontmatterDescription('---\ndescription: "Quoted: yes"\n---\n'), "Quoted: yes");
});

test("folded and literal block-scalar descriptions are joined", () => {
  const folded = "---\nname: a\ndescription: >\n  Author Fabric\n  dataflows.\nlicense: MIT\n---\n";
  assert.equal(frontmatterDescription(folded), "Author Fabric dataflows.");
  const literal = "---\r\ndescription: |-\r\n  line one\r\n\r\n  line two\r\n---\r\nbody";
  assert.equal(frontmatterDescription(literal), "line one line two");
});

test("no frontmatter or no description gives empty string", () => {
  assert.equal(frontmatterDescription("# Title\n\ndescription: nope"), "");
  assert.equal(frontmatterDescription("---\nname: a\n---\n"), "");
});

test("excerpt drops frontmatter and code, collapses whitespace, caps length", () => {
  const md = "---\nname: a\n---\n# Title\n\nSome   text\n\n```js\nconst x = 1;\n```\nmore <!-- hidden --> text";
  assert.equal(stripFrontmatter(md).startsWith("# Title"), true);
  assert.equal(bodyExcerpt(md), "# Title Some text more text");
  const long = bodyExcerpt(`---\na: b\n---\n${"alpha ".repeat(100)}`, 50);
  assert.ok(long.length <= 51 && long.endsWith("…"));
});
