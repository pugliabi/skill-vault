/**
 * App configuration — shared with the Python CLI.
 *
 * The app reads and writes the SAME config file the `sv` CLI uses:
 *
 *   ~/.skill-vault/config.json
 *
 * This is a deliberate choice. A user who ran `sv init` earlier should
 * see their vault and providers immediately when they open the app for
 * the first time, with zero re-entry. Conversely, a user who configured
 * things here should be able to run `sv push` in a terminal and have
 * it Just Work.
 *
 * Contract with the CLI (defined in `src/skill_vault/config.py`):
 *   - `vault_path: string`               — absolute path to the vault root
 *   - `agent_locations: {id: path}`      — provider directories (this is
 *                                          what `providers[]` projects to)
 *   - `default_targets: string[]`        — user's default push targets
 *   - `app: {port, host, auto_open_browser}` — runtime settings (read
 *                                          by launcher.ts for fallback
 *                                          port/host values)
 *
 * All other top-level keys the CLI writes (`repo_url`, `machine_id`,
 * `perplexity_stage`, `ai_scanner`, etc.) are PRESERVED round-trip.
 * The app never strips or rewrites fields it doesn't recognize.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AppConfig, Provider } from "../types/vault.ts";

const CLI_CONFIG_DIR = path.join(os.homedir(), ".skill-vault");
const CLI_CONFIG_FILE = path.join(CLI_CONFIG_DIR, "config.json");

/** Raw shape — only the keys we touch are narrowed. Other keys pass through. */
interface RawCliConfig {
  vault_path?: string;
  agent_locations?: Record<string, string>;
  default_targets?: string[];
  /** Claude Desktop packaging stage dir — mirrors the CLI's perplexity_stage pattern. */
  claude_desktop_stage?: string;
  app?: {
    port?: number;
    host?: string;
    auto_open_browser?: boolean;
  };
  [key: string]: unknown;
}

export function cliConfigPath(): string {
  return CLI_CONFIG_FILE;
}

/**
 * Read the CLI config file verbatim. Missing file → empty object so
 * first-run callers don't need to special-case ENOENT.
 */
function readRaw(): RawCliConfig {
  if (!fs.existsSync(CLI_CONFIG_FILE)) return {};
  try {
    const raw = fs.readFileSync(CLI_CONFIG_FILE, "utf-8");
    return JSON.parse(raw) as RawCliConfig;
  } catch (err) {
    throw new Error(
      `Failed to parse ${CLI_CONFIG_FILE}: ${(err as Error).message}`,
    );
  }
}

/**
 * Write the CLI config atomically. The whole object is round-tripped —
 * any keys the app didn't touch are preserved exactly as written.
 */
function writeRaw(cfg: RawCliConfig): void {
  fs.mkdirSync(CLI_CONFIG_DIR, { recursive: true });
  const tmp = `${CLI_CONFIG_FILE}.tmp`;
  // Trailing newline matches what `src/skill_vault/config.py` writes, so
  // diffs stay minimal when both tools rewrite the file.
  fs.writeFileSync(
    tmp,
    JSON.stringify(cfg, null, 2) + "\n",
    "utf-8",
  );
  fs.renameSync(tmp, CLI_CONFIG_FILE);
}

/**
 * Project the raw CLI config into the app-facing shape. This is what
 * the HTTP routes return and what the React client consumes.
 */
export function readAppConfig(): AppConfig {
  const raw = readRaw();
  const locations = raw.agent_locations ?? {};
  const providers: Provider[] = Object.entries(locations).map(([id, p]) => ({
    id,
    path: p,
  }));
  return {
    vault_path: raw.vault_path ?? null,
    providers,
    default_targets: raw.default_targets,
    claude_desktop_stage: raw.claude_desktop_stage ?? null,
  };
}

/**
 * Raw `app` block from the CLI config, used by `launcher.ts` for
 * port/host fallback. Returns an empty object if the file is missing
 * or the block isn't present — never throws.
 */
export function readCliAppBlock(): {
  port?: number;
  host?: string;
  auto_open_browser?: boolean;
} {
  try {
    const raw = readRaw();
    return raw.app ?? {};
  } catch {
    return {};
  }
}

/** Set (or create) the vault path, preserving all other config keys. */
export function setVaultPath(vaultPath: string): AppConfig {
  const raw = readRaw();
  raw.vault_path = vaultPath;
  writeRaw(raw);
  return readAppConfig();
}

/**
 * Write vault_path and/or providers. Partial update — any field not
 * present in `partial` stays as-is in the CLI config file.
 */
export function writeAppConfig(partial: Partial<AppConfig>): AppConfig {
  const raw = readRaw();
  if (typeof partial.vault_path === "string") {
    raw.vault_path = partial.vault_path;
  }
  if (partial.providers) {
    raw.agent_locations = Object.fromEntries(
      partial.providers.map((p) => [p.id, p.path]),
    );
  }
  writeRaw(raw);
  return readAppConfig();
}

/** Add or replace a single provider, preserving the rest. */
export function upsertProvider(provider: Provider): AppConfig {
  const raw = readRaw();
  const locations = { ...(raw.agent_locations ?? {}) };
  locations[provider.id] = provider.path;
  raw.agent_locations = locations;
  writeRaw(raw);
  return readAppConfig();
}

/** Remove a provider by id. No-op if it doesn't exist. */
export function removeProvider(id: string): AppConfig {
  const raw = readRaw();
  if (!raw.agent_locations || !(id in raw.agent_locations)) {
    return readAppConfig();
  }
  const { [id]: _removed, ...rest } = raw.agent_locations;
  raw.agent_locations = rest;
  writeRaw(raw);
  return readAppConfig();
}

/**
 * Raw `claude_desktop_stage` value from the CLI config, or null when
 * unset. Callers resolve the default (a sibling of the vault — see
 * services/desktopPackaging.ts:defaultStageDir) because the default
 * depends on vault_path, which may itself be unset.
 */
export function readClaudeDesktopStage(): string | null {
  const raw = readRaw();
  return raw.claude_desktop_stage ?? null;
}

/** Set the Claude Desktop stage dir, preserving all other config keys. */
export function setClaudeDesktopStage(stagePath: string): AppConfig {
  const raw = readRaw();
  raw.claude_desktop_stage = stagePath;
  writeRaw(raw);
  return readAppConfig();
}
