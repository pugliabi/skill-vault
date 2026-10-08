import { test } from "node:test";
import assert from "node:assert/strict";
import { labelForTool, parseStreamJsonLine } from "./streamEvents.ts";

test("system init maps to a session event; other system subtypes are dropped", () => {
  assert.deepEqual(parseStreamJsonLine(JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123" })), [
    { type: "session", session_id: "abc-123" },
  ]);
  assert.deepEqual(parseStreamJsonLine(JSON.stringify({ type: "system", subtype: "status" })), []);
});

test("stream_event text and thinking deltas map; other stream events are dropped", () => {
  assert.deepEqual(
    parseStreamJsonLine(
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } }),
    ),
    [{ type: "text_delta", text: "Hel" }],
  );
  assert.deepEqual(
    parseStreamJsonLine(
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hm" } } }),
    ),
    [{ type: "thinking_delta", text: "hm" }],
  );
  assert.deepEqual(parseStreamJsonLine(JSON.stringify({ type: "stream_event", event: { type: "message_start" } })), []);
  assert.deepEqual(
    parseStreamJsonLine(
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } } }),
    ),
    [],
  );
});

test("subagent-internal events (parent_tool_use_id set) are skipped entirely", () => {
  const line = JSON.stringify({
    type: "stream_event",
    parent_tool_use_id: "toolu_parent",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "inner" } },
  });
  assert.deepEqual(parseStreamJsonLine(line), []);
});

test("assistant messages yield one tool_start per tool_use block, text blocks are NOT re-emitted", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "git log --oneline -5\nextra" } },
        { type: "tool_use", id: "toolu_2", name: "mcp__vault__check_updates", input: { skills: ["pdf"] } },
      ],
    },
  });
  const events = parseStreamJsonLine(line);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    type: "tool_start",
    tool_use_id: "toolu_1",
    name: "Bash",
    label: "Running: git log --oneline -5",
    input_preview: JSON.stringify({ command: "git log --oneline -5\nextra" }),
  });
  assert.equal(events[1].type, "tool_start");
  assert.equal((events[1] as { label: string }).label, "vault: check_updates");
});

test("empty tool input omits input_preview", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t", name: "TodoWrite", input: {} }] },
  });
  const [ev] = parseStreamJsonLine(line);
  assert.equal(ev.type, "tool_start");
  assert.equal((ev as { input_preview?: string }).input_preview, undefined);
});

test("user tool_result blocks map with ok inverted from is_error and a text preview", () => {
  const line = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "3 files changed" }] },
        { type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: "boom" },
      ],
    },
  });
  const events = parseStreamJsonLine(line);
  assert.deepEqual(events[0], { type: "tool_result", tool_use_id: "toolu_1", ok: true, output_preview: "3 files changed" });
  assert.deepEqual(events[1], { type: "tool_result", tool_use_id: "toolu_2", ok: false, output_preview: "boom" });
});

test("long previews are truncated with an ellipsis", () => {
  const big = "x".repeat(1000);
  const line = JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t", content: big }] },
  });
  const [ev] = parseStreamJsonLine(line);
  const preview = (ev as { output_preview: string }).output_preview;
  assert.equal(preview.length, 400);
  assert.ok(preview.endsWith("…"));
});

test("result success maps to turn_end with cost and duration; is_error maps to error", () => {
  assert.deepEqual(
    parseStreamJsonLine(JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.042, duration_ms: 18000 })),
    [{ type: "turn_end", cost_usd: 0.042, duration_ms: 18000 }],
  );
  assert.deepEqual(
    parseStreamJsonLine(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "ran out of road" })),
    [{ type: "error", message: "ran out of road" }],
  );
  assert.deepEqual(parseStreamJsonLine(JSON.stringify({ type: "result", is_error: true })), [
    { type: "error", message: "claude CLI reported an error" },
  ]);
});

test("noise and malformed lines are dropped, never thrown", () => {
  assert.deepEqual(parseStreamJsonLine(JSON.stringify({ type: "rate_limit_event" })), []);
  assert.deepEqual(parseStreamJsonLine("not json {"), []);
  assert.deepEqual(parseStreamJsonLine("null"), []);
  assert.deepEqual(parseStreamJsonLine(JSON.stringify({ type: "mystery_future_type", payload: 1 })), []);
});

test("labelForTool renders scannable action lines per tool", () => {
  assert.equal(labelForTool("WebSearch", { query: "powerbi-report-authoring moved repo" }), "Searching web: powerbi-report-authoring moved repo");
  assert.equal(labelForTool("WebFetch", { url: "https://github.com/microsoft/skills-for-fabric" }), "Fetching: https://github.com/microsoft/skills-for-fabric");
  assert.equal(labelForTool("Read", { file_path: "C:\\vault\\skills\\pdf\\SKILL.md" }), "Reading skills/pdf/SKILL.md");
  assert.equal(labelForTool("Edit", { file_path: "/v/skills/pdf/SKILL.md" }), "Editing skills/pdf/SKILL.md");
  assert.equal(labelForTool("Write", { file_path: "a/b.md" }), "Writing a/b.md");
  assert.equal(labelForTool("Glob", { pattern: "**/*.md" }), "Finding files: **/*.md");
  assert.equal(labelForTool("Grep", { pattern: "origin" }), "Searching for: origin");
  assert.equal(labelForTool("Task", { subagent_type: "repo-hunter", description: "find moved repo" }), "agent: repo-hunter — find moved repo");
  assert.equal(labelForTool("Task", {}), "agent: subagent");
  assert.equal(labelForTool("Agent", { subagent_type: "skill-vault-assistant:skill-scout", description: "find skills" }), "agent: skill-scout — find skills");
  assert.equal(labelForTool("Skill", { skill: "skill-vault-assistant:vault-operations" }), "Loading skill: vault-operations");
  assert.equal(labelForTool("Skill", {}), "Loading skill");
  assert.equal(labelForTool("ToolSearch", { query: "x" }), "Loading tools");
  assert.equal(labelForTool("TodoWrite", {}), "Updating plan");
  assert.equal(labelForTool("mcp__vault__set_origin", {}), "vault: set_origin");
  assert.equal(labelForTool("SomeFutureTool", {}), "SomeFutureTool");
});
