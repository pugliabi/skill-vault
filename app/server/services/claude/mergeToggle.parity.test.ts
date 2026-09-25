import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeWithClaude, toggleDecision as serverToggle, type MergeResult } from "./merge.ts";
import type { ClaudeRunner } from "./cli.ts";
import { toggleDecision as clientToggle } from "../../../client/src/lib/mergeToggle.ts";

// The Conflicts page toggles Claude's decisions with a pure client port of
// toggleDecision; it must behave exactly like the server's.

function result(): MergeResult {
  return {
    explanation: "",
    vault_changes: [],
    notion_changes: [],
    files: [
      { path: "SKILL.md", content: "intro\nmerged line\nmiddle\nmerged line\n" },
      { path: "b.md", content: "x" },
    ],
    decisions: [
      { id: "d1", file: "SKILL.md", summary: "s", chosen: "both", vault_text: "vault line", notion_text: "notion line", merged_text: "merged line", overlapping: true },
      { id: "d2", file: "missing.md", summary: "s", chosen: "vault", vault_text: "a", notion_text: "b", merged_text: "a", overlapping: false },
      { id: "d3", file: "b.md", summary: "s", chosen: "vault", vault_text: "x", notion_text: "", merged_text: "x", overlapping: true },
      { id: "d4", file: "SKILL.md", summary: "s", chosen: "vault", vault_text: "intro", notion_text: "INTRO", merged_text: "intro", overlapping: true, toggleable: false },
    ],
    warnings: [],
  };
}

test("client toggleDecision matches the server's on every case", () => {
  const cases: Array<[string, "vault" | "notion"]> = [
    ["d1", "vault"],
    ["d1", "notion"],
    ["d2", "notion"],
    ["d3", "notion"],
    ["d4", "notion"],
    ["nope", "vault"],
  ];
  for (const [id, side] of cases) {
    assert.deepEqual(clientToggle(result(), id, side), serverToggle(result(), id, side), `${id}/${side}`);
  }
  // Round trip: vault → notion → vault ends where the vault choice was.
  const s = serverToggle(serverToggle(serverToggle(result(), "d1", "vault"), "d1", "notion"), "d1", "vault");
  const c = clientToggle(clientToggle(clientToggle(result(), "d1", "vault"), "d1", "notion"), "d1", "vault");
  assert.deepEqual(c, s);
  assert.equal(c.files[0].content, "intro\nvault line\nmiddle\nmerged line\n");
});

test("toggleable:false decisions are never flipped, on either side", () => {
  assert.deepEqual(clientToggle(result(), "d4", "notion"), result());
  assert.deepEqual(serverToggle(result(), "d4", "notion"), result());
});

test("client and server agree on a real hunk-based merge result", async () => {
  const v = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"].join("\n") + "\n";
  const n = ["a", "B", "c", "d", "e", "f", "g", "h", "i", "new", "j", "k"].join("\n") + "\n";
  const runner: ClaudeRunner = async (_a, stdin) => {
    const ids = [...stdin.matchAll(/^--- Hunk (h\d+) /gm)].map((m) => m[1]);
    const hunks = ids.map((id) => ({ id, choice: "notion", summary: id, overlapping: true }));
    return {
      stdout: JSON.stringify({ is_error: false, structured_output: { explanation: "", vault_changes: [], notion_changes: [], hunks } }),
      stderr: "",
      code: 0,
    };
  };
  const merged = await mergeWithClaude({ skill: "s", files: [{ path: "a.md", base: null, vault: v, notion: n }] }, runner);
  assert.equal(merged.files[0].content, n);
  assert.equal(merged.decisions.length, 2);
  let s = merged;
  let c = merged;
  for (const d of merged.decisions) {
    s = serverToggle(s, d.id, "vault");
    c = clientToggle(c, d.id, "vault");
    assert.deepEqual(c, s);
  }
  assert.equal(s.files[0].content, v);
});
