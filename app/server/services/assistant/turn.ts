/**
 * One assistant chat turn = one headless `claude -p` spawn.
 *
 * Deliberate deltas from runClaudeJson (merge/tagging): session persistence
 * stays ON (`--session-id` / `--resume` give the CLI the conversation
 * memory), cwd is the VAULT — stable across turns because the CLI keys
 * sessions by cwd — built-in tools are enabled behind a strict allowlist,
 * and the vault MCP bridge + assistant plugin ride along. The allowlist is
 * the whole safety story in `-p` mode (no prompt channel exists): anything
 * not listed is auto-denied, so shell access is git-only and app mutations
 * can only happen through the audited bridge. Never add bypassPermissions.
 */

import { ClaudeError, defaultStreamRunner, type ClaudeStreamRunner } from "../claude/cli.ts";
import { parseStreamJsonLine, type AssistantStreamEvent } from "./streamEvents.ts";
import type { AssistantSession } from "./session.ts";

export const IDLE_TIMEOUT_MS = 300_000; // agentic turns idle between tools, not forever
export const HARD_TIMEOUT_MS = 30 * 60_000;

export const ALLOWED_TOOLS =
  "Read,Glob,Grep,Edit,Write,Task,TodoWrite,Skill,WebSearch,WebFetch,Bash(git:*),mcp__vault__*";

export interface TurnArgsInput {
  sessionId: string;
  isFirstTurn: boolean;
  leadAgent: string;
  contextBlock: string;
  mcpConfigJson: string;
  pluginDir: string;
  reposDir: string;
}

export function buildTurnArgs(input: TurnArgsInput): string[] {
  return [
    "-p",
    "--verbose", // required for stream-json with -p
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    ...(input.isFirstTurn ? ["--session-id", input.sessionId] : ["--resume", input.sessionId]),
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    input.mcpConfigJson,
    "--plugin-dir",
    input.pluginDir,
    "--agent",
    input.leadAgent,
    "--allowedTools",
    ALLOWED_TOOLS,
    "--add-dir",
    input.reposDir,
    // Second add-dir: the plugin bundle itself, so skills' references/
    // files are Read-able at runtime (progressive disclosure).
    "--add-dir",
    input.pluginDir,
    "--append-system-prompt",
    input.contextBlock,
  ];
}

export interface RunTurnResult {
  /** Compacted events for session history (deltas folded into one text event per burst). */
  events: AssistantStreamEvent[];
  costUsd?: number;
  /** Set when the turn ended abnormally (error/abort) — already emitted to the client. */
  errorMessage?: string;
}

/**
 * Spawn the CLI for one turn, forward wire events to `emit` as they arrive,
 * and return the compacted record for session history. Never throws for
 * turn-level failures — they surface as an `error` event + `errorMessage`
 * (an abort reads as "stopped"). The caller owns the session lock.
 */
export async function runTurn(opts: {
  session: AssistantSession;
  message: string;
  args: string[];
  cwd: string;
  abort: AbortController;
  emit: (ev: AssistantStreamEvent) => void;
  streamRunner?: ClaudeStreamRunner;
}): Promise<RunTurnResult> {
  const runner = opts.streamRunner ?? defaultStreamRunner;
  const compact: AssistantStreamEvent[] = [];
  let textBuf = "";
  let costUsd: number | undefined;
  let sawTerminal = false;
  let errorMessage: string | undefined;

  const flushText = (): void => {
    if (textBuf) {
      compact.push({ type: "text_delta", text: textBuf });
      textBuf = "";
    }
  };

  const handle = (ev: AssistantStreamEvent): void => {
    // The session id is announced by the route before the spawn; the CLI's
    // own init echo would just duplicate it.
    if (ev.type === "session") return;
    opts.emit(ev);
    switch (ev.type) {
      case "text_delta":
        textBuf += ev.text;
        break;
      case "thinking_delta":
        break; // live-only; not worth persisting
      case "turn_end":
        sawTerminal = true;
        costUsd = ev.cost_usd;
        flushText();
        compact.push(ev);
        break;
      case "error":
        sawTerminal = true;
        errorMessage = ev.message;
        flushText();
        compact.push(ev);
        break;
      default:
        flushText();
        compact.push(ev);
    }
  };

  try {
    const { code, stderr } = await runner(opts.args, opts.message, {
      cwd: opts.cwd,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      hardTimeoutMs: HARD_TIMEOUT_MS,
      signal: opts.abort.signal,
      onLine: (line) => {
        for (const ev of parseStreamJsonLine(line)) handle(ev);
      },
    });
    if (!sawTerminal) {
      // CLI exited without a result record — surface whatever it said on stderr.
      const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
      const message = `claude CLI exited (code ${code}) without a result${detail ? `: ${detail}` : ""}`;
      errorMessage = message;
      flushText();
      const ev: AssistantStreamEvent = { type: "error", message };
      compact.push(ev);
      opts.emit(ev);
    }
  } catch (err) {
    const aborted = opts.abort.signal.aborted;
    const message = aborted
      ? "stopped"
      : err instanceof ClaudeError
        ? err.message
        : `assistant turn failed: ${(err as Error).message}`;
    errorMessage = message;
    flushText();
    const ev: AssistantStreamEvent = { type: "error", message };
    compact.push(ev);
    opts.emit(ev);
  }

  flushText();
  return { events: compact, costUsd, errorMessage };
}
