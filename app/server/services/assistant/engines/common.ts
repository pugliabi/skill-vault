// app/server/services/assistant/engines/common.ts
/** Small pieces every non-Claude engine shares: finding its CLI, its version, its env, its sign-in hint. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { knownInstallDirs, resolveTarget, runCommand, type CommandRunner, type SpawnTarget } from "./exe.ts";
import type { EngineAuthConfig, EngineDetect } from "./types.ts";

export interface EngineDeps {
  /** The CLI, found without a shell. Remembered per name (a miss too) until forget(name). */
  resolve(name: string, label: string): SpawnTarget | null;
  /** Drop the remembered result for `name`: detect({ refresh: true }) calls it. */
  forget(name: string): void;
  run: CommandRunner;
  home: string;
  env: NodeJS.ProcessEnv;
  exists(p: string): boolean;
  readFile(p: string): string;
  writeFile(p: string, text: string): void;
}

const findOnThisPc = (name: string, label: string): SpawnTarget | null =>
  resolveTarget(name, label, { knownDirs: knownInstallDirs() });

/** `find` is the uncached search; tests pass a fake. */
export function defaultEngineDeps(find: (name: string, label: string) => SpawnTarget | null = findOnThisPc): EngineDeps {
  // resolveTarget can spawn `reg query` twice, and target() runs on every view and turn.
  const found = new Map<string, SpawnTarget | null>();
  return {
    resolve: (name, label) => {
      if (!found.has(name)) found.set(name, find(name, label));
      return found.get(name) ?? null;
    },
    forget: (name) => {
      found.delete(name);
    },
    run: runCommand,
    home: os.homedir(),
    env: process.env,
    exists: (p) => fs.existsSync(p),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    writeFile: (p, text) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text, "utf-8");
    },
  };
}

export async function detectWithVersion(deps: EngineDeps, target: SpawnTarget | null, env: NodeJS.ProcessEnv): Promise<EngineDetect> {
  if (!target) return { installed: false, reason: "not found on this PC" };
  const r = await deps.run(target, ["--version"], { env, timeoutMs: 20_000 });
  // "GitHub Copilot CLI 1.0.105." → no trailing punctuation.
  const line = r.stdout.trim().split(/\r?\n/)[0]?.trim().replace(/[.,;:!]+$/, "");
  if (r.code === 0 && line) return { installed: true, version: line };
  const why = r.stderr.trim().split(/\r?\n/).at(-1) || `${target.label} --version failed`;
  return { installed: false, reason: why.slice(0, 200) };
}

/** Delete env vars by name, ignoring case (Windows env names are case-insensitive). */
function deleteVar(env: NodeJS.ProcessEnv, name: string): void {
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) if (k.toUpperCase() === upper) delete env[k];
}

/**
 * Login mode: remove every key var the CLI would prefer over its own login.
 * API-key mode: set the saved key on the first var (a key already in the env is left for the CLI).
 */
export function keyEnv(cfg: EngineAuthConfig, base: NodeJS.ProcessEnv, keys: string[], extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (cfg.auth === "api_key") {
    if (cfg.api_key) {
      deleteVar(env, keys[0]);
      env[keys[0]] = cfg.api_key;
    }
  } else {
    for (const k of keys) deleteVar(env, k);
  }
  return { ...env, ...extra };
}

export function apiKeyPresent(cfg: EngineAuthConfig, env: NodeJS.ProcessEnv, keys: string[]): boolean {
  return Boolean(cfg.api_key) || keys.some((k) => Boolean(env[k]));
}

export function makeAuthHint(label: string, pattern: RegExp): (message: string) => string {
  return (m) => (pattern.test(m) && !m.includes("Settings → AI assistant") ? `${m} — sign in to ${label} again in Settings → AI assistant.` : m);
}
