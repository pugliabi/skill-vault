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
import { withAuthHint } from "../claude/auth.ts";
import type { EngineId } from "./engines/types.ts";

export type AssistantStreamEvent =
  | { type: "session"; session_id: string; engine?: EngineId }
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
    // The delegation tool is "Task" on older CLIs and "Agent" on newer ones;
    // plugin agents arrive namespaced ("skill-vault-assistant:repo-hunter").
    case "Task":
    case "Agent": {
      const raw = typeof input.subagent_type === "string" && input.subagent_type ? input.subagent_type : "subagent";
      const agent = raw.includes(":") ? raw.slice(raw.lastIndexOf(":") + 1) : raw;
      const desc = typeof input.description === "string" && input.description ? ` — ${input.description}` : "";
      return truncate(`agent: ${agent}${desc}`, 90);
    }
    case "Skill": {
      const raw = typeof input.skill === "string" ? input.skill : "";
      const skill = raw.includes(":") ? raw.slice(raw.lastIndexOf(":") + 1) : raw;
      return skill ? `Loading skill: ${skill}` : "Loading skill";
    }
    case "ToolSearch":
      return "Loading tools";
    case "TodoWrite":
      return "Updating plan";
    default:
      return name;
  }
}

/** Native tool name → the Claude name labelForTool and the activity line understand. */
export type ToolAliases = Record<string, string>;

const PATH_KEYS = ["file_path", "path", "absolute_path", "target_file", "filePath"];
/** The vault tool across engines: mcp__vault__x (Claude, Codex), vault__x (Grok), vault-x (Copilot). */
const VAULT_TOOL = /^(?:mcp__vault__|vault__|vault-)(.+)$/;

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/** Map another CLI's tool call onto Claude's names and input fields, so every engine's timeline reads the same. */
export function canonicalTool(
  aliases: ToolAliases,
  name: string,
  input: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
  if (name === "use_tool" && typeof input.name === "string") {
    const inner = input.arguments ?? input.input;
    return canonicalTool(aliases, input.name, inner && typeof inner === "object" ? (inner as Record<string, unknown>) : {});
  }
  const vault = name.match(VAULT_TOOL);
  if (vault) return { name: `mcp__vault__${vault[1]}`, input };
  const to = aliases[name] ?? name;
  const out: Record<string, unknown> = { ...input };
  const fill = (field: string, keys: string[]): void => {
    if (!out[field]) {
      const v = firstString(input, keys);
      if (v) out[field] = v;
    }
  };
  switch (to) {
    case "Read":
    case "Edit":
    case "Write":
      fill("file_path", PATH_KEYS);
      break;
    case "Bash":
      fill("command", ["command", "cmd", "commandLine"]);
      break;
    case "Grep":
    case "Glob":
      fill("pattern", ["pattern", "query", "glob", "path", "dir_path"]);
      break;
    case "WebSearch":
      fill("query", ["query", "q"]);
      break;
    case "WebFetch":
      fill("url", ["url", "prompt"]);
      break;
  }
  return { name: to, input: out };
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

export function toolStartEvent(id: string, name: string, input: Record<string, unknown>): AssistantStreamEvent {
  const inputPreview = truncate(JSON.stringify(input), INPUT_PREVIEW_MAX);
  return {
    type: "tool_start",
    tool_use_id: id,
    name,
    label: labelForTool(name, input),
    input_preview: inputPreview === "{}" ? undefined : inputPreview,
  };
}

export function toolResultEvent(id: string, ok: boolean, content: unknown): AssistantStreamEvent {
  return { type: "tool_result", tool_use_id: id, ok, output_preview: toolResultPreview(content) };
}

/**
 * Parse one JSONL line into wire events. Unknown/irrelevant lines return []
 * — never throw: a malformed line is dropped, not fatal to the stream.
 */
export function parseStreamJsonLine(
  line: string,
  opts: { aliases?: ToolAliases; authHint?: (m: string) => string } = {},
): AssistantStreamEvent[] {
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
          const c = opts.aliases ? canonicalTool(opts.aliases, b.name, input) : { name: b.name, input };
          events.push(toolStartEvent(b.id, c.name, c.input));
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
          events.push(toolResultEvent(b.tool_use_id, b.is_error !== true, b.content));
        }
      }
      return events;
    }

    case "result": {
      if (msg.is_error) {
        const message = typeof msg.result === "string" && msg.result ? msg.result : "claude CLI reported an error";
        return [{ type: "error", message: (opts.authHint ?? withAuthHint)(message) }];
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
