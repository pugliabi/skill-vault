/**
 * One assistant chat turn = one headless CLI spawn (an engine's TurnSpec).
 * The notes below describe the Claude spawn.
 *
 * Deliberate deltas from runClaudeJson (merge/tagging): session persistence
 * stays ON (`--session-id` / `--resume` give the CLI the conversation
 * memory), cwd is the VAULT — stable across turns because the CLI keys
 * sessions by cwd — built-in tools are enabled behind a strict allowlist,
 * and the vault MCP bridge + assistant plugin ride along. `-p` has no prompt
 * channel, so these flags are the whole safety story: `--permission-mode
 * dontAsk` denies anything unlisted (left unset, `-p` can start in auto mode),
 * Edit(path) rules keep file writes in the vault and repos folder, and the git
 * gate hook refuses every shell command but plain git, which no allow rule can
 * do (Claude Code approves its read-only commands itself). App mutations can
 * only happen through the audited bridge. Never add bypassPermissions.
 */

import fs from "node:fs";
import path from "node:path";
import { ClaudeError, defaultStreamRunner, type ClaudeStreamRunner } from "../claude/cli.ts";
import type { AssistantStreamEvent } from "./streamEvents.ts";
import type { TurnParser, TurnSpec } from "./engines/types.ts";

export const IDLE_TIMEOUT_MS = 300_000; // agentic turns idle between tools, not forever
export const HARD_TIMEOUT_MS = 30 * 60_000;

/** File edits are allowed per folder, by editRule: an Edit(path) rule also covers Write, and Write(path) never matches. */
export const ALLOWED_TOOLS =
  "Read,Glob,Grep,Task,TodoWrite,Skill,WebSearch,WebFetch,Bash(git:*),mcp__vault__*";

/** They run commands with no allow rule: Claude Code approves read-only ones itself. */
export const DISALLOWED_TOOLS = "PowerShell,Monitor";

export interface TurnArgsInput {
  sessionId: string;
  isFirstTurn: boolean;
  leadAgent: string;
  contextBlock: string;
  mcpConfigJson: string;
  vaultPath: string;
  pluginDir: string;
  reposDir: string;
}

/** A folder and everything in it. Claude Code matches gitignore patterns on POSIX paths, and `//` is the filesystem root. */
export function editRule(dir: string): string {
  const resolved = /^[A-Za-z]:[\\/]/.test(dir) ? path.win32.resolve(dir) : path.posix.resolve(dir);
  const posix = resolved
    .replace(/\\/g, "/")
    .replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
    .replace(/\/$/, "");
  return `Edit(/${posix.replace(/[[\]*?]/g, "\\$&")}/**)`;
}

/** Each folder as given and as it really is: behind a junction or symlink, an allow rule must match both. */
function writableRoots(dirs: string[]): string[] {
  const roots = new Set<string>();
  for (const dir of dirs) {
    roots.add(dir);
    try {
      roots.add(fs.realpathSync(dir));
    } catch {
      // Not created yet: there's nothing for it to resolve to.
    }
  }
  return [...roots];
}

/** Inline, because `--setting-sources ""` loads no settings file. The hook is assistant-plugin/hooks/git-gate.mjs. */
function gitGateSettings(pluginDir: string, roots: string[]): string {
  return JSON.stringify({
    // Git's own defence: a bare repository found in a folder, whether planted or
    // shipped inside a clone, could otherwise run commands from its config.
    env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.bareRepository", GIT_CONFIG_VALUE_0: "explicit" },
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: process.execPath, // the running node — never "node" from PATH
              args: [path.join(pluginDir, "hooks", "git-gate.mjs"), "--hook", ...roots],
              onFailure: "block",
            },
          ],
        },
      ],
    },
  });
}

export function buildTurnArgs(input: TurnArgsInput): string[] {
  const roots = writableRoots([input.vaultPath, input.reposDir]);
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
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    [ALLOWED_TOOLS, ...roots.map(editRule)].join(","),
    "--disallowedTools",
    DISALLOWED_TOOLS,
    "--settings",
    gitGateSettings(input.pluginDir, roots),
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
  /** An id the engine assigned this turn (Codex thread), to resume with next time. */
  engineSessionId?: string;
}

/**
 * Spawn the CLI for one turn, forward wire events to `emit` as they arrive,
 * and return the compacted record for session history. Never throws for
 * turn-level failures — they surface as an `error` event + `errorMessage`
 * (an abort reads as "stopped"). The caller owns the session lock.
 */
export async function runTurn(opts: {
  spec: TurnSpec;
  parser: TurnParser;
  /** The engine's sign-in hint for errors that mean "signed out". */
  authHint: (message: string) => string;
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
    try {
      const { code, stderr } = await runner(opts.spec.args, opts.spec.stdin, {
        cwd: opts.spec.cwd,
        target: opts.spec.target,
        env: opts.spec.env,
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        hardTimeoutMs: HARD_TIMEOUT_MS,
        signal: opts.abort.signal,
        onLine: (line) => {
          // This runs inside the child's stdout handler: a throw here would take the whole server down.
          let events: AssistantStreamEvent[];
          try {
            events = opts.parser.parse(line);
          } catch {
            events = [];
          }
          for (const ev of events) handle(ev);
        },
      });
      if (!sawTerminal) {
        // CLI exited without a result record — surface whatever it said on stderr.
        const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
        const message = opts.authHint(`${opts.spec.label} exited (code ${code}) without a result${detail ? `: ${detail}` : ""}`);
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
  } finally {
    for (const f of opts.spec.tempFiles ?? []) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* a file still locked after an abort must not discard the turn's result */
      }
    }
  }

  flushText();
  return { events: compact, costUsd, errorMessage, engineSessionId: opts.parser.engineSessionId?.() };
}
