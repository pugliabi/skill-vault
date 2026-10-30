/**
 * The contract every assistant engine implements. One engine = one CLI the
 * assistant can run on (Claude Code, Codex, Copilot, Grok Build).
 * An engine knows how to find, install and sign in to its CLI, how to build
 * one headless chat turn, and how to read that CLI's JSONL back into the
 * panel's AssistantStreamEvents. "Engine" in code, "Provider" in the UI —
 * "providers" already means skill targets here.
 */
import type { AssistantStreamEvent } from "../streamEvents.ts";
import type { VaultMcpServer } from "../mcpConfig.ts";
import type { SpawnTarget } from "./exe.ts";

export type EngineId = "claude" | "codex" | "copilot" | "grok";
/** Settings lists engines in this order. */
export const ENGINE_IDS: EngineId[] = ["claude", "codex", "copilot", "grok"];

export interface EngineAuthConfig {
  auth?: "login" | "api_key";
  api_key?: string;
  /** Claude only: sent as anthropic-workspace-id. */
  workspace_id?: string;
}

export interface EngineDetect {
  installed: boolean;
  version?: string;
  reason?: string;
}

export interface EngineAuthStatus {
  /** null = couldn't tell (a turn is still allowed; the CLI will say if it's signed out). */
  signed_in: boolean | null;
  method: "login" | "api_key";
  account?: string;
}

export type InstallStep =
  | { kind: "npm"; label: string; args: string[]; source: string }
  | { kind: "powershell"; label: string; script: string; source: string };

/** The command as the user sees it in the confirm dialog. */
export function installDisplay(step: InstallStep): string {
  return step.kind === "npm" ? `npm ${step.args.join(" ")}` : step.script;
}

export interface TurnInput {
  /** The app's chat id (a UUID); Claude, Copilot and Grok use it as their session id. */
  sessionId: string;
  /** An id the engine assigned on an earlier turn (Codex thread ids). */
  engineSessionId?: string;
  isFirstTurn: boolean;
  /** Exactly what the user typed. */
  message: string;
  leadAgent: string;
  contextBlock: string;
  mcp: VaultMcpServer;
  vaultPath: string;
  reposDir: string;
  pluginDir: string;
  /** ~/.skill-vault/engines/<id>/ — exists when buildTurn runs. */
  workDir: string;
  auth: EngineAuthConfig;
  /** The env to start from (process.env in the app). */
  baseEnv: NodeJS.ProcessEnv;
}

export interface TurnSpec {
  /** Names the CLI in errors: "codex CLI". */
  label: string;
  /** Omitted for Claude: its runner resolves claude.exe and applies the saved auth mode itself. */
  target?: SpawnTarget;
  args: string[];
  stdin: string;
  env?: NodeJS.ProcessEnv;
  cwd: string;
  /** Deleted after the turn, whatever happened. */
  tempFiles?: string[];
}

export interface TurnParser {
  /** One stdout line → zero or more wire events. Never throws. */
  parse(line: string): AssistantStreamEvent[];
  /** An id the engine assigned this turn (Codex), to resume with next time. */
  engineSessionId?(): string | undefined;
}

export interface AssistantEngine {
  id: EngineId;
  label: string;
  /** The command as typed in a terminal ("codex"); names it in "run this yourself" messages. */
  cliName: string;
  /** CLI version this adapter and its fixtures were checked against. */
  verifiedVersion: string;
  /** Can the lead delegate to the plugin's subagents on this engine? */
  subagents: boolean;
  /** Env vars the CLI reads an API key from, the one the app sets first. Login mode removes them all. */
  apiKeyEnv: string[];
  install: InstallStep[];
  loginArgs: string[];
  loginHint: string;
  /** Extra env for the sign-in window (may write a settings file first). */
  loginEnv(): Record<string, string>;
  /** The CLI to spawn, or null when it isn't installed. */
  target(): SpawnTarget | null;
  /** refresh: forget the remembered executable and look again (after an install, "Check again"). */
  detect(opts?: { refresh?: boolean }): Promise<EngineDetect>;
  authStatus(cfg: EngineAuthConfig): Promise<EngineAuthStatus>;
  childEnv(cfg: EngineAuthConfig, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /** Throws when the CLI can't run (not installed). */
  buildTurn(input: TurnInput): TurnSpec;
  createParser(): TurnParser;
  /** Appends where-to-fix-it text to an error that means "signed out". */
  authHint(message: string): string;
}
