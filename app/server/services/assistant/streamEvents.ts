/**
 * Pure mapping from claude CLI `--output-format stream-json` JSONL lines to
 * the compact NDJSON wire events the assistant panel renders. One CLI line
 * can produce zero events (system/status/rate-limit noise, subagent-internal
 * streams) or several (an assistant message carrying two tool_use blocks).
 *
 * Shapes were verified against CLI v2.1.177: `system:init` carries the
 * session id; incremental text arrives as `stream_event` wrappers around
 * Anthropic SSE events; complete `assistant` messages repeat the text (so
 * text blocks are mined ONLY from deltas, tool_use blocks ONLY from the
 * complete messages — never both, or the UI would double-render); tool
 * results come back as `user` messages; `result` closes the turn with cost.
 * Events with a non-null `parent_tool_use_id` belong to a subagent's inner
 * conversation and are skipped — the Task tool_use line ("agent: repo-hunter")
 * and its eventual tool_result already represent that work in the timeline.
 */

export type AssistantStreamEvent =
  | { type: "session"; session_id: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; tool_use_id: string; name: string; label: string; input_preview?: string }
  | { type: "tool_result"; tool_use_id: string; ok: boolean; output_preview?: string }
  | { type: "turn_end"; cost_usd?: number; duration_ms?: number }
  | { type: "error"; message: string }
  | { type: "done" };

const INPUT_PREVIEW_MAX = 400;
const OUTPUT_PREVIEW_MAX = 400;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Last path segments, forward slashes — enough to recognize a file at a glance. */
function shortPath(p: unknown): string {
  if (typeof p !== "string" || !p) return "";
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-3).join("/");
}

/**
 * One human-scannable line per tool call. The UI renders these verbatim in
 * the activity timeline, so they read as actions, not tool names.
 */
export function labelForTool(name: string, input: Record<string, unknown>): string {
  const mcp = name.match(/^mcp__vault__(.+)$/);
  if (mcp) return `vault: ${mcp[1]}`;
  switch (name) {
    case "Bash": {
      const cmd = typeof input.command === "string" ? input.command.split("\n")[0] : "";
      return `Running: ${truncate(cmd, 80)}`;
    }
    case "WebSearch":
      return `Searching web: ${truncate(String(input.query ?? ""), 80)}`;
    case "WebFetch":
      return `Fetching: ${truncate(String(input.url ?? ""), 80)}`;
    case "Read":
      return `Reading ${shortPath(input.file_path)}`;
    case "Edit":
      return `Editing ${shortPath(input.file_path)}`;
    case "Write":
      return `Writing ${shortPath(input.file_path)}`;
    case "Glob":
      return `Finding files: ${truncate(String(input.pattern ?? ""), 60)}`;
    case "Grep":
      return `Searching for: ${truncate(String(input.pattern ?? ""), 60)}`;
    case "Task": {
      const agent = typeof input.subagent_type === "string" && input.subagent_type ? input.subagent_type : "subagent";
      const desc = typeof input.description === "string" && input.description ? ` — ${input.description}` : "";
      return truncate(`agent: ${agent}${desc}`, 90);
    }
    case "TodoWrite":
      return "Updating plan";
    default:
      return name;
  }
}

interface CliContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface CliLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
  message?: { role?: string; content?: CliContentBlock[] };
  result?: unknown;
  is_error?: boolean;
  total_cost_usd?: number;
  duration_ms?: number;
}

function toolResultPreview(content: unknown): string | undefined {
  if (typeof content === "string") return truncate(content, OUTPUT_PREVIEW_MAX) || undefined;
  if (Array.isArray(content)) {
    const text = content
      .map((b) => (b && typeof b === "object" && (b as CliContentBlock).type === "text" ? String((b as CliContentBlock).text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
    return text ? truncate(text, OUTPUT_PREVIEW_MAX) : undefined;
  }
  return undefined;
}

/**
 * Parse one JSONL line into wire events. Unknown/irrelevant lines return []
 * — never throw: a malformed line is dropped, not fatal to the stream.
 */
export function parseStreamJsonLine(line: string): AssistantStreamEvent[] {
  let msg: CliLine;
  try {
    msg = JSON.parse(line);
  } catch {
    return [];
  }
  if (!msg || typeof msg !== "object") return [];

  // Subagent-internal traffic: represented by its Task line, skip the rest.
  if (msg.parent_tool_use_id) return [];

  switch (msg.type) {
    case "system":
      return msg.subtype === "init" && typeof msg.session_id === "string"
        ? [{ type: "session", session_id: msg.session_id }]
        : [];

    case "stream_event": {
      const ev = msg.event;
      if (ev?.type !== "content_block_delta") return [];
      if (ev.delta?.type === "text_delta" && ev.delta.text) {
        return [{ type: "text_delta", text: ev.delta.text }];
      }
      if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
        return [{ type: "thinking_delta", text: ev.delta.thinking }];
      }
      return [];
    }

    case "assistant": {
      const blocks = msg.message?.content;
      if (!Array.isArray(blocks)) return [];
      const events: AssistantStreamEvent[] = [];
      for (const b of blocks) {
        if (b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
          const input = b.input && typeof b.input === "object" ? b.input : {};
          const inputPreview = truncate(JSON.stringify(input), INPUT_PREVIEW_MAX);
          events.push({
            type: "tool_start",
            tool_use_id: b.id,
            name: b.name,
            label: labelForTool(b.name, input),
            input_preview: inputPreview === "{}" ? undefined : inputPreview,
          });
        }
      }
      return events;
    }

    case "user": {
      const blocks = msg.message?.content;
      if (!Array.isArray(blocks)) return [];
      const events: AssistantStreamEvent[] = [];
      for (const b of blocks) {
        if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
          events.push({
            type: "tool_result",
            tool_use_id: b.tool_use_id,
            ok: b.is_error !== true,
            output_preview: toolResultPreview(b.content),
          });
        }
      }
      return events;
    }

    case "result": {
      if (msg.is_error) {
        const message = typeof msg.result === "string" && msg.result ? msg.result : "claude CLI reported an error";
        return [{ type: "error", message }];
      }
      return [
        {
          type: "turn_end",
          cost_usd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined,
          duration_ms: typeof msg.duration_ms === "number" ? msg.duration_ms : undefined,
        },
      ];
    }

    default:
      return []; // rate_limit_event, system:status, future types
  }
}
