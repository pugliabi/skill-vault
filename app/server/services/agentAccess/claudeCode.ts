/**
 * Claude Code's user-scope MCP entry for the vault bridge.
 *
 * Status is read from ~/.claude.json, where `claude mcp add --scope user`
 * writes; `claude mcp get` would start the server to health-check it.
 * Changes always go through the CLI, never by editing that file: Claude
 * Code rewrites it constantly.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRunner, type ClaudeRunner } from "../claude/cli.ts";
import { SERVER_NAME, isOurEntry } from "./desktopConfig.ts";

export function claudeCodeConfigPath(home = os.homedir()): string {
  return path.join(home, ".claude.json");
}

/** The user-scope "skill-vault" entry, or undefined (none, or the file can't be read). */
export function readClaudeCodeEntry(file = claudeCodeConfigPath()): unknown {
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf-8")) as { mcpServers?: Record<string, unknown> };
    return json?.mcpServers?.[SERVER_NAME];
  } catch {
    return undefined;
  }
}

export function addArgs(nodePath: string, bridgePath: string): string[] {
  return ["mcp", "add", "--scope", "user", SERVER_NAME, "--", nodePath, bridgePath, "--client", "claude-code"];
}

export const REMOVE_ARGS = ["mcp", "remove", "--scope", "user", SERVER_NAME];

export class ClaudeCodeError extends Error {}

async function run(runner: ClaudeRunner, args: string[]): Promise<void> {
  let r: { stdout: string; stderr: string; code: number | null };
  try {
    r = await runner(args, "", { cwd: os.tmpdir(), timeoutMs: 30_000 });
  } catch (err) {
    throw new ClaudeCodeError(`Couldn't run the claude CLI: ${(err as Error).message}`);
  }
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim() || `exit code ${r.code}`;
    throw new ClaudeCodeError(`claude ${args.slice(0, 2).join(" ")} failed: ${detail}`);
  }
}

/** Add the entry, replacing our own if it's there. A foreign entry with the same name is refused. */
export async function connectClaudeCode(
  nodePath: string,
  bridgePath: string,
  entry: unknown,
  runner: ClaudeRunner = defaultRunner,
): Promise<void> {
  if (entry !== undefined && !isOurEntry(entry)) {
    throw new ClaudeCodeError(`Claude Code already has an MCP server named "${SERVER_NAME}" that isn't from Skill Vault`);
  }
  if (entry !== undefined) await run(runner, REMOVE_ARGS);
  await run(runner, addArgs(nodePath, bridgePath));
}

export async function disconnectClaudeCode(entry: unknown, runner: ClaudeRunner = defaultRunner): Promise<void> {
  if (entry === undefined || !isOurEntry(entry)) return;
  await run(runner, REMOVE_ARGS);
}
