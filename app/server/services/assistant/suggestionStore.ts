/**
 * Persistence for the proactive-suggestions feature, following the
 * notion/store.ts conventions (atomic tmp+rename writes, home resolved at
 * call time so tests can point HOME at a tmp dir, corrupt files read as
 * empty — chat suggestions must never crash the app).
 *
 *   ~/.skill-vault/update-sweep.json          last background update sweep (lite)
 *   ~/.skill-vault/assistant-suggestions.json dismissals (server-side so the
 *                                             sidebar badge, the panel, and the
 *                                             MCP get_suggestions tool agree)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UpdateStatus } from "../../types/vault.ts";

export interface SweepResultLite {
  name: string;
  status: UpdateStatus;
  message?: string;
}

export interface UpdateSweepCache {
  checked_at: string;
  /** Sweeps are per-vault; ignore the cache when the active vault differs. */
  vault_path: string;
  results: SweepResultLite[];
  guard?: { ahead: number; behind: number; error?: string };
}

export interface Dismissal {
  id: string;
  fingerprint: string;
  at: string;
}

function homeDir(): string {
  return path.join(os.homedir(), ".skill-vault");
}

const sweepPath = () => path.join(homeDir(), "update-sweep.json");
const dismissalsPath = () => path.join(homeDir(), "assistant-suggestions.json");

function readJson<T>(abs: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(abs, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(abs: string, data: unknown): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, abs);
}

/** Returns null when there is no sweep yet or it belongs to another vault. */
export function readSweepCache(vaultPath: string): UpdateSweepCache | null {
  const c = readJson<UpdateSweepCache | null>(sweepPath(), null);
  if (!c || !Array.isArray(c.results) || typeof c.checked_at !== "string") return null;
  if (c.vault_path !== vaultPath) return null;
  return c;
}

export function writeSweepCache(cache: UpdateSweepCache): void {
  writeJson(sweepPath(), cache);
}

export function readDismissals(): Dismissal[] {
  const d = readJson<{ dismissals?: Dismissal[] }>(dismissalsPath(), {});
  return Array.isArray(d.dismissals)
    ? d.dismissals.filter((x) => x && typeof x.id === "string" && typeof x.fingerprint === "string")
    : [];
}

export function addDismissal(id: string, fingerprint: string): void {
  const rest = readDismissals().filter((d) => d.id !== id);
  writeJson(dismissalsPath(), {
    dismissals: [...rest, { id, fingerprint, at: new Date().toISOString() }],
  });
}

export function removeDismissal(id: string): void {
  writeJson(dismissalsPath(), { dismissals: readDismissals().filter((d) => d.id !== id) });
}
