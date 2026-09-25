import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidSkillName, normalizeName, matchSkills, normalizeSkillMd, contentFingerprint, skillDirsEquivalent,
  isLegacyConversion, isNotionNative, computeNotionStatus,
} from "./matching.ts";

const row = (title: string, id = title) => ({
  page_id: id, title, description: "", tags: [], has_files: false,
});

test("names", () => {
  assert.equal(isValidSkillName("using-duckdb"), true);
  assert.equal(isValidSkillName("Reformat with headers"), false);
  assert.equal(normalizeName("Writing FooBar Articles"), "writing-foobar-articles");
  assert.equal(normalizeName("Sample Skill — Part Two"), "sample-skill-part-two");
});

test("matching prefers page id, then exact, then normalized; unlinked stays out", () => {
  const r = matchSkills(
    [
      { name: "alpha", link: { page_id: "p-renamed", state: "linked", linked_at: "t" } },
      { name: "beta" },
      { name: "no-ai-slop" },
      { name: "gamma", link: { page_id: "p-x", state: "unlinked", linked_at: "t" } },
      { name: "delta" },
    ],
    [row("Alpha Renamed", "p-renamed"), row("beta"), row("No AI Slop"), row("gamma"), row("Only Notion")],
  );
  assert.deepEqual(
    r.pairs.map((p) => [p.vault, p.row.page_id, p.how]),
    [["alpha", "p-renamed", "id"], ["beta", "beta", "exact"], ["no-ai-slop", "No AI Slop", "normalized"]],
  );
  assert.deepEqual(r.vaultOnly.sort(), ["delta", "gamma"]);
  assert.deepEqual(r.notionOnly.map((x) => x.title).sort(), ["Only Notion", "gamma"]);
});

test("two vault skills sharing a page_id: first wins the id pair, second falls to vaultOnly", () => {
  const r = matchSkills(
    [
      { name: "first", link: { page_id: "shared", state: "linked", linked_at: "t" } },
      { name: "second", link: { page_id: "shared", state: "linked", linked_at: "t" } },
    ],
    [row("shared", "shared")],
  );
  assert.deepEqual(r.pairs.map((p) => [p.vault, p.row.page_id, p.how]), [["first", "shared", "id"]]);
  assert.deepEqual(r.vaultOnly, ["second"]);
  assert.deepEqual(r.notionOnly, []);
});

// Synthetic pair mirroring Notion's regeneration of SKILL.md.
const VAULT_MD = [
  "---",
  "name: demo",
  "description: Query things. Use when asked.",
  "license: MIT",
  "---",
  "",
  "# Demo",
  "",
  "| Mode | Where |",
  "|------|-------|",
  "| a | b |",
  "",
  "```python",
  "print(1)",
  "```",
  "",
  "```",
  "plain",
  "```",
  "",
  "- [my_repo](https://example.test/my_repo) -- note",
  "",
].join("\r\n");

const NOTION_MD = [
  "---",
  "name: |-",
  "  demo",
  "description: |-",
  "  Query things. Use when asked.",
  "notion_page_id: 11111111-2222-3333-4444-555555555555",
  "---",
  "# Demo",
  "| Mode | Where |",
  "| --- | --- |",
  "| a | b |",
  "```py",
  "print(1)",
  "```",
  "```javascript",
  "plain",
  "```",
  "- [my\\_repo](https://example.test/my_repo) -- note",
].join("\n");

test("SKILL.md equivalence ignores Notion's regeneration artifacts", () => {
  assert.equal(normalizeSkillMd(VAULT_MD), normalizeSkillMd(NOTION_MD));
  assert.notEqual(normalizeSkillMd(VAULT_MD), normalizeSkillMd(NOTION_MD.replace("print(1)", "print(2)")));
  assert.notEqual(
    normalizeSkillMd(VAULT_MD),
    normalizeSkillMd(NOTION_MD.replace("Query things.", "Query other things.")),
  );
});

// normalizeSkillMd now compares content, not formatting: neither a hr line
// nor a table separator row contributes any letters/digits, so a document
// that differs only in which of the two it uses is content-identical. The
// old test asserted these stayed distinct at the formatting level; that
// assertion no longer applies once we're fingerprinting by content.
test("normalizeSkillMd ignores formatting-only lines like hr/table separators", () => {
  const withHr = ["# Demo", "", "Some text.", "", "---", "", "More text."].join("\n");
  const withTableSep = ["# Demo", "", "Some text.", "", "| --- |", "", "More text."].join("\n");
  assert.equal(normalizeSkillMd(withHr), normalizeSkillMd(withTableSep));
});

test("normalizeSkillMd ignores each measured Notion regeneration artifact", () => {
  const base = normalizeSkillMd(["---", "name: demo", "description: d", "---", "- one", "- two"].join("\n"));

  // HTML inserted around list items / bold+code mixes.
  assert.equal(
    base,
    normalizeSkillMd(["---", "name: demo", "description: d", "---", "<p>- one</p>", "- <b>two</b>"].join("\n")),
  );

  // Link split/reordered: "[`dax` skill](../dax/)" -> "[`dax`](../dax/)[ skill](../dax/)".
  assert.equal(
    normalizeSkillMd(["---", "name: demo", "description: d", "---", "See the [`dax` skill](../dax/)."].join("\n")),
    normalizeSkillMd(
      ["---", "name: demo", "description: d", "---", "See the [`dax`](../dax/)[ skill](../dax/)."].join("\n"),
    ),
  );

  // Bold link reordered: "**[x](u)**" -> "[**x**](u)".
  assert.equal(
    normalizeSkillMd(["---", "name: demo", "description: d", "---", "**[x](https://e.test)**"].join("\n")),
    normalizeSkillMd(["---", "name: demo", "description: d", "---", "[**x**](https://e.test)"].join("\n")),
  );

  // Bare word autolinked: "TOM/ADOMD.NET" -> "TOM/[ADOMD.NET](http://ADOMD.NET)".
  assert.equal(
    normalizeSkillMd(["---", "name: demo", "description: d", "---", "Uses TOM/ADOMD.NET for access."].join("\n")),
    normalizeSkillMd(
      ["---", "name: demo", "description: d", "---", "Uses TOM/[ADOMD.NET](http://ADOMD.NET) for access."].join(
        "\n",
      ),
    ),
  );

  // Fence language changed/added: python -> py, text/dax/tmdl/bare -> javascript.
  assert.equal(
    normalizeSkillMd(["---", "name: demo", "description: d", "---", "```python", "print(1)", "```"].join("\n")),
    normalizeSkillMd(["---", "name: demo", "description: d", "---", "```py", "print(1)", "```"].join("\n")),
  );
  assert.equal(
    normalizeSkillMd(["---", "name: demo", "description: d", "---", "```text", "raw", "```"].join("\n")),
    normalizeSkillMd(["---", "name: demo", "description: d", "---", "```javascript", "raw", "```"].join("\n")),
  );

  // Bullets +/-/* -> •, and ordered lists renumbered (0. -> 1.).
  assert.equal(
    normalizeSkillMd(["---", "name: demo", "description: d", "---", "+ one", "* two", "- three"].join("\n")),
    normalizeSkillMd(["---", "name: demo", "description: d", "---", "• one", "• two", "• three"].join("\n")),
  );
  assert.equal(
    normalizeSkillMd(["---", "name: demo", "description: d", "---", "0. one", "1. two"].join("\n")),
    normalizeSkillMd(["---", "name: demo", "description: d", "---", "1. one", "2. two"].join("\n")),
  );

  // Backslashes and quote characters added/removed, spacing around punctuation changed.
  assert.equal(
    normalizeSkillMd(["---", "name: demo", "description: d", "---", "See CORE.md ) and DAX.guide ,"].join("\n")),
    normalizeSkillMd(["---", "name: demo", "description: d", "---", "See \\CORE.md) and DAX.guide,"].join("\n")),
  );

  // Frontmatter name slugged differently: e2e-medallion-architecture -> e-2-e-medallion-architecture.
  assert.equal(
    normalizeSkillMd(["---", "name: e2e-medallion-architecture", "description: d", "---", "x"].join("\n")),
    normalizeSkillMd(["---", "name: e-2-e-medallion-architecture", "description: d", "---", "x"].join("\n")),
  );
});

test("contentFingerprint only strips real HTML tags, not generics", () => {
  assert.notEqual(contentFingerprint("List<string> x;"), contentFingerprint("List<int> x;"));
  assert.equal(contentFingerprint("<p>text</p>"), contentFingerprint("text"));
  assert.equal(contentFingerprint("<b>x</b>"), contentFingerprint("x"));
});

test("normalizeSkillMd still differs on real content changes", () => {
  const original = ["---", "name: demo", "description: d", "---", "- one", "- two", "Some sentence."].join("\n");
  const addedSentence = ["---", "name: demo", "description: d", "---", "- one", "- two", "Some sentence. Extra."].join(
    "\n",
  );
  const removedListItem = ["---", "name: demo", "description: d", "---", "- one", "Some sentence."].join("\n");
  assert.notEqual(normalizeSkillMd(original), normalizeSkillMd(addedSentence));
  assert.notEqual(normalizeSkillMd(original), normalizeSkillMd(removedListItem));
});

test("directory equivalence", () => {
  const v = new Map([["SKILL.md", Buffer.from(VAULT_MD)], ["references/a.md", Buffer.from("a\r\n")]]);
  const n = new Map([["SKILL.md", Buffer.from(NOTION_MD)], ["references/a.md", Buffer.from("a\n")]]);
  assert.deepEqual(skillDirsEquivalent(v, n), { equivalent: true, differing: [] });
  n.set("references/b.md", Buffer.from("b"));
  assert.deepEqual(skillDirsEquivalent(v, n), { equivalent: false, differing: ["references/b.md"] });
});

test("legacy detection", () => {
  const base = { vaultName: "axelrod", notionTitle: "Axelrod", notionHasFiles: false, vaultHasSupportingFiles: true, notionSkillMd: "x" };
  assert.equal(isLegacyConversion(base), true);
  assert.equal(isLegacyConversion({ ...base, notionTitle: "axelrod" }), false);
  assert.equal(isLegacyConversion({ ...base, vaultHasSupportingFiles: false }), false);
  assert.equal(isLegacyConversion({ ...base, vaultHasSupportingFiles: false, notionSkillMd: "## What Claude automates" }), true);
  assert.equal(isLegacyConversion({ ...base, notionTitle: "Something Else" }), false);
});

test("notion-native", () => {
  assert.equal(isNotionNative(row("Reformat with headers")), true);
  assert.equal(isNotionNative(row("fabric-deploy")), false);
});

test("status", () => {
  const link = { page_id: "p", state: "linked" as const, linked_at: "t", synced_at: "t", vault_hash: "h1", notion_version_id: "v1" };
  const cache = { ...row("x", "p"), version_id: "v1" };
  const ok = { connected: true, cacheValid: true };
  assert.equal(computeNotionStatus({ connected: false, cacheValid: true, vaultHash: "h1", link }), undefined);
  assert.equal(computeNotionStatus({ ...ok, vaultHash: "h1" }), "not-in-notion");
  assert.equal(computeNotionStatus({ ...ok, vaultHash: "h1", link, cacheRow: cache }), "synced");
  assert.equal(computeNotionStatus({ ...ok, vaultHash: "h2", link, cacheRow: cache }), "changed-vault");
  assert.equal(computeNotionStatus({ ...ok, vaultHash: "h1", link, cacheRow: { ...cache, version_id: "v2" } }), "changed-notion");
  assert.equal(computeNotionStatus({ ...ok, vaultHash: "h2", link, cacheRow: { ...cache, version_id: "v2" } }), "conflict");
  assert.equal(computeNotionStatus({ ...ok, vaultHash: "h1", link: { ...link, synced_at: undefined } }), "conflict");
  assert.equal(computeNotionStatus({ ...ok, vaultHash: "h1", link: { ...link, state: "legacy" } }), "legacy");
  assert.equal(computeNotionStatus({ ...ok, vaultHash: "h1", link: { ...link, state: "vault-only" } }), "vault-only");
  assert.equal(computeNotionStatus({ ...ok, vaultHash: "h1", link: { ...link, state: "unlinked" } }), "unlinked");
});

test("status: an unchecked or foreign cache never reports synced", () => {
  const link = { page_id: "p", state: "linked" as const, linked_at: "t", synced_at: "t", vault_hash: "h1", notion_version_id: "v1" };
  const cache = { ...row("x", "p"), version_id: "v1" };
  // Cache invalid (never checked / other data source) → unchecked, even with a matching row.
  assert.equal(computeNotionStatus({ connected: true, cacheValid: false, vaultHash: "h1", link }), "unchecked");
  assert.equal(computeNotionStatus({ connected: true, cacheValid: false, vaultHash: "h1", link, cacheRow: cache }), "unchecked");
  // Conflict (never synced) is still reported without a valid cache.
  assert.equal(
    computeNotionStatus({ connected: true, cacheValid: false, vaultHash: "h1", link: { ...link, synced_at: undefined } }),
    "conflict",
  );
  // Valid cache but no row for the linked page → missing in Notion.
  assert.equal(computeNotionStatus({ connected: true, cacheValid: true, vaultHash: "h1", link }), "missing-in-notion");
  assert.equal(computeNotionStatus({ connected: true, cacheValid: true, vaultHash: "h2", link }), "missing-in-notion");
  // Row exists but has no version_id → unchecked, unless the vault changed.
  const noVersion = row("x", "p");
  assert.equal(computeNotionStatus({ connected: true, cacheValid: true, vaultHash: "h1", link, cacheRow: noVersion }), "unchecked");
  assert.equal(computeNotionStatus({ connected: true, cacheValid: true, vaultHash: "h2", link, cacheRow: noVersion }), "changed-vault");
});
