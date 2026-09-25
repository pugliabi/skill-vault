import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMergePrompt,
  HUNK_PAYLOAD_CAP_BYTES,
  MERGE_TIMEOUT_MS,
  mergeWithClaude,
  toggleDecision,
  TooLargeError,
  type MergeInput,
  type MergeResult,
} from "./merge.ts";
import { ClaudeError, type ClaudeRunner } from "./cli.ts";

interface Answer {
  choice: "vault" | "notion" | "both" | "custom";
  custom_text?: string;
  overlapping?: boolean;
}

/**
 * A fake CLI: records stdin + timeout, reads the hunk ids out of the prompt
 * and answers each with `answers[id]` (default `fallback`).
 */
function fakeRunner(answers: Record<string, Answer> = {}, fallback: Answer = { choice: "notion" }) {
  const calls: Array<{ stdin: string; timeoutMs: number }> = [];
  const runner: ClaudeRunner = async (_args, stdin, opts) => {
    calls.push({ stdin, timeoutMs: opts.timeoutMs });
    const ids = [...stdin.matchAll(/^--- Hunk (h\d+) /gm)].map((m) => m[1]);
    const hunks = ids.map((id) => {
      const a = answers[id] ?? fallback;
      return { id, summary: `region ${id}`, overlapping: a.overlapping ?? true, choice: a.choice, ...(a.custom_text !== undefined ? { custom_text: a.custom_text } : {}) };
    });
    return {
      stdout: JSON.stringify({
        is_error: false,
        subtype: "success",
        structured_output: { explanation: "merged", vault_changes: ["v"], notion_changes: ["n"], hunks },
        total_cost_usd: 0.02,
      }),
      stderr: "",
      code: 0,
    };
  };
  return { runner, calls };
}

const baseInput: MergeInput = {
  skill: "demo-skill",
  vaultEditedAt: "2026-09-20T00:00:00Z",
  notionEditedAt: "2026-09-24T00:00:00Z",
  files: [
    {
      path: "SKILL.md",
      base: "---\nname: demo-skill\n---\n# Demo\nHello.\n",
      vault: "---\nname: demo-skill\n---\n# Demo\nHello vault.\n",
      notion: "---\nname: demo-skill\n---\n# Demo\nHello notion.\n",
    },
  ],
};

/** A ~800-line skill with paragraphs under headings. */
function bigDoc(): string[] {
  const lines = ["---", "name: big", "description: a big skill", "---"];
  for (let s = 1; s <= 40; s++) {
    lines.push(`## Section ${s}`, "");
    for (let p = 1; p <= 18; p++) lines.push(`Section ${s} paragraph ${p} explains a distinct rule about topic ${s}.${p}.`);
    lines.push("");
  }
  return lines;
}

test("buildMergePrompt includes the hunk, base, both edit dates and an outline", () => {
  const { system, user, schema } = buildMergePrompt(baseInput);
  assert.match(system, /merging two independently edited copies/i);
  assert.match(user, /Skill: demo-skill/);
  assert.match(user, /vaultEditedAt: 2026-09-20T00:00:00Z/);
  assert.match(user, /notionEditedAt: 2026-09-24T00:00:00Z/);
  assert.match(user, /=== File: SKILL\.md/);
  assert.match(user, /L4 # Demo/);
  assert.match(user, /--- Hunk h1 · SKILL\.md · vault lines 5-5 · notion lines 5-5 · changed on: both ---/);
  assert.match(user, /Base:\n"""\nHello\.\n"""/);
  assert.match(user, /Vault:\n"""\nHello vault\.\n"""/);
  assert.match(user, /Notion:\n"""\nHello notion\.\n"""/);
  assert.match(user, /Context before:\n"""\nname: demo-skill\n---\n# Demo\n"""/);
  const s = schema as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(s.required, ["explanation", "vault_changes", "notion_changes", "hunks"]);
});

test("a large file with 3 small differing regions sends only those regions, with a 600 s timeout", async () => {
  const doc = bigDoc();
  const vault = [...doc];
  const notion = [...doc];
  vault[100] = "Vault rewrote this rule entirely.";
  notion[400] = "Notion rewrote this rule entirely.";
  notion.splice(700, 0, "Notion added a brand-new rule here.");
  const input: MergeInput = {
    skill: "big",
    files: [{ path: "SKILL.md", base: doc.join("\n") + "\n", vault: vault.join("\n") + "\n", notion: notion.join("\n") + "\n" }],
  };
  const fileBytes = Buffer.byteLength(input.files[0].vault!);
  assert.ok(doc.length > 750);

  const { runner, calls } = fakeRunner({ h1: { choice: "vault", overlapping: false }, h2: { choice: "notion", overlapping: false }, h3: { choice: "notion", overlapping: false } });
  const result = await mergeWithClaude(input, runner);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeoutMs, MERGE_TIMEOUT_MS);
  assert.equal(MERGE_TIMEOUT_MS, 600_000);
  const hunkIds = [...calls[0].stdin.matchAll(/^--- Hunk (h\d+) /gm)].map((m) => m[1]);
  assert.deepEqual(hunkIds, ["h1", "h2", "h3"]);
  // Only the changed regions (+ context + outline) — a small fraction of the file.
  const promptBytes = Buffer.byteLength(calls[0].stdin);
  assert.ok(promptBytes < 6_000, `prompt is ${promptBytes} bytes`);
  assert.ok(promptBytes < fileBytes / 8, `prompt ${promptBytes} vs file ${fileBytes}`);
  assert.doesNotMatch(calls[0].stdin, /Section 20 paragraph 9 /);
  assert.match(calls[0].stdin, /changed on: vault/);
  assert.match(calls[0].stdin, /changed on: notion/);

  const expected = [...doc];
  expected[100] = "Vault rewrote this rule entirely.";
  expected[400] = "Notion rewrote this rule entirely.";
  expected.splice(700, 0, "Notion added a brand-new rule here.");
  assert.equal(result.files[0].content, expected.join("\n") + "\n");
  assert.deepEqual(result.decisions.map((d) => [d.id, d.chosen]), [["h1", "vault"], ["h2", "notion"], ["h3", "notion"]]);
  assert.equal(result.cost_usd, 0.02);
  assert.deepEqual(result.warnings, []);
});

function fourRegionInput(): MergeInput {
  const common = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  const v = [...common];
  const n = [...common];
  v[5] = "vault five";
  n[5] = "notion five";
  v[15] = "vault fifteen";
  n[15] = "notion fifteen";
  v[35] = "vault thirty-six";
  n[35] = "notion thirty-six";
  n.splice(26, 0, "notion extra");
  return { skill: "s", files: [{ path: "a.md", base: null, vault: v.join("\n") + "\n", notion: n.join("\n") + "\n" }] };
}

test("rebuild honours vault / notion / both / custom per hunk", async () => {
  const { runner } = fakeRunner({
    h1: { choice: "vault" },
    h2: { choice: "notion" },
    h3: { choice: "both" },
    h4: { choice: "custom", custom_text: "vault thirty-six\nnotion thirty-six" },
  });
  const result = await mergeWithClaude(fourRegionInput(), runner);
  const lines = result.files[0].content.split("\n");
  assert.equal(lines[5], "vault five");
  assert.equal(lines[15], "notion fifteen");
  assert.equal(lines[26], "notion extra", "both on a pure insertion keeps the Notion line");
  assert.equal(lines[27], "line 27");
  assert.deepEqual(lines.slice(36, 38), ["vault thirty-six", "notion thirty-six"]);
  assert.equal(lines.length, 43, "40 lines + insertion + custom extra line + trailing empty");
  assert.deepEqual(result.decisions.map((d) => d.chosen), ["vault", "notion", "both", "both"]);
  for (const d of result.decisions) {
    assert.notEqual(d.toggleable, false, d.id);
    assert.ok(result.files[0].content.includes(d.merged_text), d.id);
  }
});

test("both de-duplicates Notion lines the vault lines already have", async () => {
  const input: MergeInput = {
    skill: "s",
    files: [{ path: "a.md", base: null, vault: "a\nshared\nvault only\nz\n", notion: "a\nshared\nnotion only\nz\n" }],
  };
  // Hunk is just line 3 ("vault only" vs "notion only"); make it wider so "shared" is in both sides.
  input.files[0].notion = "a\nshared!\nnotion only\nshared\nz\n";
  const { runner } = fakeRunner({}, { choice: "both" });
  const result = await mergeWithClaude(input, runner);
  const c = result.files[0].content;
  assert.equal(c.split("\n").filter((l) => l === "shared").length, 1, c);
  assert.match(c, /vault only/);
  assert.match(c, /notion only/);
});

test("formatting-only hunks are resolved to the vault side and never sent", async () => {
  const input: MergeInput = {
    skill: "s",
    files: [
      {
        path: "SKILL.md",
        base: null,
        vault: "# T\n\n- item one\n- item two\n\n" + "filler\n".repeat(10) + "Real vault text.\n",
        notion: "# T\n\n* item one\n* item   two\n\n" + "filler\n".repeat(10) + "Real notion text.\n",
      },
    ],
  };
  const { runner, calls } = fakeRunner({}, { choice: "notion" });
  const result = await mergeWithClaude(input, runner);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].stdin, /item one/, "the list-marker-only hunk isn't in the prompt");
  assert.match(calls[0].stdin, /Real notion text\./);
  assert.match(result.files[0].content, /- item one\n- item two\n/);
  assert.match(result.files[0].content, /Real notion text\.\n$/);
  assert.equal(result.decisions.length, 1);
  assert.match(result.explanation, /1 formatting-only difference was kept as in the vault/);

  // Only formatting differences → no Claude call at all.
  const only: MergeInput = { skill: "s", files: [{ path: "a.md", base: null, vault: "- x\n", notion: "* x\n" }] };
  const r2 = await mergeWithClaude(only, runner);
  assert.equal(calls.length, 1);
  assert.equal(r2.files[0].content, "- x\n");
  assert.equal(r2.decisions.length, 0);
});

test("a missing Claude answer keeps one side and warns; unknown ids are ignored", async () => {
  const runner: ClaudeRunner = async () => ({
    stdout: JSON.stringify({
      is_error: false,
      structured_output: { explanation: "e", vault_changes: [], notion_changes: [], hunks: [{ id: "h99", choice: "notion", summary: "x", overlapping: false }] },
    }),
    stderr: "",
    code: 0,
  });
  const result = await mergeWithClaude(baseInput, runner);
  assert.match(result.files[0].content, /Hello vault\./);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /SKILL\.md/);
  assert.equal(result.decisions.length, 1);
});

test("files that exist on one side only are merged too", async () => {
  const input: MergeInput = { skill: "s", files: [{ path: "new.md", base: null, vault: null, notion: "fresh\ncontent\n" }] };
  const { runner } = fakeRunner({}, { choice: "notion" });
  const r = await mergeWithClaude(input, runner);
  assert.equal(r.files[0].content, "fresh\ncontent\n");
  const r2 = await mergeWithClaude(input, fakeRunner({}, { choice: "vault" }).runner);
  assert.equal(r2.files[0].content, "");
});

test("CRLF vault files keep their line endings", async () => {
  const input: MergeInput = { skill: "s", files: [{ path: "a.md", base: null, vault: "a\r\nb\r\nc\r\n", notion: "a\nB changed\nc\n" }] };
  const r = await mergeWithClaude(input, fakeRunner({}, { choice: "notion" }).runner);
  assert.equal(r.files[0].content, "a\r\nB changed\r\nc\r\n");
});

test("mergeWithClaude throws TooLargeError before calling Claude when the hunk payload exceeds the cap", async () => {
  let called = false;
  const runner: ClaudeRunner = async () => {
    called = true;
    return { stdout: "{}", stderr: "", code: 0 };
  };
  const v = Array.from({ length: 2000 }, (_, i) => `vault line ${i} ${"x".repeat(40)}`).join("\n");
  const n = Array.from({ length: 2000 }, (_, i) => `notion line ${i} ${"y".repeat(40)}`).join("\n");
  assert.ok(v.length + n.length > HUNK_PAYLOAD_CAP_BYTES);
  await assert.rejects(mergeWithClaude({ skill: "big", files: [{ path: "a.md", base: null, vault: v, notion: n }] }, runner), TooLargeError);
  assert.equal(called, false, "the CLI must never be invoked once the size cap is exceeded");

  // A huge but mostly identical file is fine: only the differing region counts.
  const same = "z".repeat(60) + "\n";
  const big = same.repeat(3000);
  const r = await mergeWithClaude(
    { skill: "big2", files: [{ path: "a.md", base: big, vault: big + "vault tail\n", notion: big + "notion tail\n" }] },
    fakeRunner().runner,
  );
  assert.match(r.files[0].content, /notion tail\n$/);
});

test("mergeWithClaude surfaces CLI errors as ClaudeError", async () => {
  const runner: ClaudeRunner = async () => ({ stdout: JSON.stringify({ is_error: true, result: "boom" }), stderr: "", code: 1 });
  await assert.rejects(mergeWithClaude(baseInput, runner), ClaudeError);
});

test("toggling any decision rewrites exactly its hunk, and round-trips", async () => {
  const input = fourRegionInput();
  const { runner } = fakeRunner({}, { choice: "notion" });
  const result = await mergeWithClaude(input, runner);
  assert.equal(result.decisions.length, 4);
  let r = result;
  for (const d of result.decisions) r = toggleDecision(r, d.id, "vault");
  // All flipped to vault → the vault copy exactly.
  assert.equal(r.files[0].content, input.files[0].vault);
  for (const d of result.decisions) r = toggleDecision(r, d.id, "notion");
  assert.equal(r.files[0].content, input.files[0].notion);
});

test("a pure insertion stays toggleable (texts are anchored on a context line)", async () => {
  const input: MergeInput = { skill: "s", files: [{ path: "a.md", base: null, vault: "a\nb\nc\n", notion: "a\nb\nnew\nc\n" }] };
  const r = await mergeWithClaude(input, fakeRunner({}, { choice: "vault" }).runner);
  const d = r.decisions[0];
  assert.notEqual(d.toggleable, false);
  assert.ok(d.merged_text.length > 0);
  assert.equal(toggleDecision(r, d.id, "notion").files[0].content, "a\nb\nnew\nc\n");
});

test("a decision whose text can't be made unique is marked non-toggleable and toggle is a no-op", async () => {
  // Identical repeated blocks: the changed line and all its context repeat elsewhere.
  const blockLines = ["x", "x", "x", "x"];
  const v = [...blockLines, "same", ...blockLines, "same", ...blockLines].join("\n") + "\n";
  const n = [...blockLines, "same", ...blockLines, "other", ...blockLines].join("\n") + "\n";
  const r = await mergeWithClaude({ skill: "s", files: [{ path: "a.md", base: null, vault: v, notion: n }] }, fakeRunner({}, { choice: "vault" }).runner);
  assert.equal(r.decisions.length, 1);
  assert.equal(r.decisions[0].toggleable, false);
  assert.equal(r.warnings.length, 1);
  assert.deepEqual(toggleDecision(r, r.decisions[0].id, "notion"), r);
});

function goodResult(): MergeResult {
  return {
    explanation: "merged one overlapping line",
    vault_changes: [],
    notion_changes: [],
    files: [{ path: "SKILL.md", content: "---\nname: demo-skill\n---\nHello notion.\n" }],
    decisions: [
      { id: "d1", file: "SKILL.md", summary: "s", chosen: "notion", vault_text: "Hello vault.", notion_text: "Hello notion.", merged_text: "Hello notion.", overlapping: true },
    ],
    warnings: [],
  };
}

test("toggleDecision swaps merged_text to the other side's text and updates chosen", () => {
  const result = goodResult();
  const toggled = toggleDecision(result, "d1", "vault");
  assert.equal(toggled.decisions[0].chosen, "vault");
  assert.equal(toggled.decisions[0].merged_text, "Hello vault.");
  assert.equal(toggled.files[0].content, "---\nname: demo-skill\n---\nHello vault.\n");
  assert.equal(result.files[0].content, "---\nname: demo-skill\n---\nHello notion.\n");
});

test("toggleDecision is a no-op when the id is unknown", () => {
  const result = goodResult();
  assert.deepEqual(toggleDecision(result, "does-not-exist", "vault"), result);
});

/** Merge one hunk (surrounded by unchanged lines) and report whether it went to Claude. */
async function sentToClaude(vaultLines: string[], notionLines: string[]): Promise<boolean> {
  const pad = ["# Title", "", "intro para", ""];
  const tail = ["", "outro para"];
  const { runner, calls } = fakeRunner({}, { choice: "vault" });
  await mergeWithClaude(
    { skill: "s", files: [{ path: "a.md", base: null, vault: [...pad, ...vaultLines, ...tail].join("\n") + "\n", notion: [...pad, ...notionLines, ...tail].join("\n") + "\n" }] },
    runner,
  );
  return calls.length > 0;
}

test("formatting-only auto-resolve never swallows real content changes", async () => {
  // Real changes → sent.
  assert.equal(await sentToClaude(["See [docs](https://a.example/v1)."], ["See [docs](https://a.example/v2)."]), true, "link URL change");
  assert.equal(await sentToClaude(["Run `npm test` first."], ["Run `npm tests` first."]), true, "code span change");
  assert.equal(await sentToClaude(["Use foo_bar."], ["Use foobar."]), true, "underscore removed");
  assert.equal(await sentToClaude(["Stop."], ["Stop!"]), true, "punctuation change");
  assert.equal(await sentToClaude(["```js", "a - b", "```"], ["```js", "a + b", "```"]), true, "fenced code change");
  // True formatting → auto.
  assert.equal(await sentToClaude(["Use foo\_bar."], ["Use foo_bar."]), false, "backslash escape");
  assert.equal(await sentToClaude(["- one", "- two"], ["* one", "+ two"]), false, "bullet style");
  assert.equal(await sentToClaude(["1. one", "2. two"], ["1. one", "1. two"]), false, "renumbering");
  assert.equal(await sentToClaude(["It is <b>x</b> now."], ["It is **x** now."]), false, "HTML bold vs Markdown");
  assert.equal(await sentToClaude(["```python", "x = 1", "```"], ["```", "x = 1", "```"]), false, "fence language label");
  assert.equal(await sentToClaude(["| a | b |", "|---|---|", "| 1 | 2 |"], ["|a|b|", "| :-- | --: |", "|1|2|"]), false, "table separator + spacing");
  assert.equal(await sentToClaude(["some   words  here"], ["some words here"]), false, "whitespace");
});

test("an unknown choice from Claude is treated like a missing answer (fallback + warning)", async () => {
  const runner: ClaudeRunner = async () => ({
    stdout: JSON.stringify({
      is_error: false,
      structured_output: {
        explanation: "e",
        vault_changes: ["ok", 5, null],
        notion_changes: "not an array",
        hunks: [{ id: "h1", choice: "neither", summary: "x", overlapping: false }],
      },
    }),
    stderr: "",
    code: 0,
  });
  const result = await mergeWithClaude(baseInput, runner);
  assert.match(result.files[0].content, /Hello vault\./, "the region is never emptied");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /didn't decide/);
  assert.equal(result.decisions[0].chosen, "vault");
  assert.deepEqual(result.vault_changes, ["ok"]);
  assert.deepEqual(result.notion_changes, []);
});
