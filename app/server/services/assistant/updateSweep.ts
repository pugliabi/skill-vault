/**
 * Background update sweep — keeps the proactive-suggestions cards about
 * upstream sources fresh without the user clicking "Check for updates".
 *
 * Copies the startNotionChecker shape (services/notion/checker.ts): delayed
 * first run, fixed interval, single-flight, isBusy yield, never throws.
 * Each tick runs the SAME checkUpdates a manual check uses (including the
 * ff-only pull of local clones — the user opted into that), then:
 *   - immediately removes any temp clones the check created (the cache
 *     stores statuses only; a later apply re-resolves sources itself),
 *   - runs the git ahead/behind guard on the vault repo,
 *   - persists a lite cache (suggestionStore), and
 *   - broadcasts `suggestions_changed` so every open tab refreshes.
 *
 * Strictly read-only on the vault: the sweep never applies anything
 * (suggest-only by user decision). No recordActivity either — a 6-hourly
 * background read would just be noise in the feed.
 *
 * Foreground coordination: routes/adopt.ts marks user-initiated check/apply
 * operations via begin/endForegroundCheck(); a tick that lands while one is
 * active skips (two ff-pulls of the same clone can race on git's
 * index.lock; the reverse race — user clicks mid-sweep — degrades to the
 * existing "compared without pull" message and is accepted).
 */

import fs from "node:fs";
import type { UpdateCheckResult } from "../../types/vault.ts";
import { checkUpdates } from "../updates.ts";
import { gitGuard } from "../notion/checker.ts";
import { writeSweepCache, type UpdateSweepCache } from "./suggestionStore.ts";

const FIRST_RUN_DELAY_MS = 45_000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

// ── Foreground-check flags (set by routes/adopt.ts) ─────────────────────

let foregroundChecks = 0;

export function beginForegroundCheck(): void {
  foregroundChecks++;
}

export function endForegroundCheck(): void {
  foregroundChecks = Math.max(0, foregroundChecks - 1);
}

export function foregroundCheckActive(): boolean {
  return foregroundChecks > 0;
}

// ── The sweeper ──────────────────────────────────────────────────────────

export interface UpdateSweeper {
  stop(): void;
  /** Start a sweep immediately. False when one is already running. */
  runNow(): boolean;
  isRunning(): boolean;
}

export interface SweepDeps {
  getVaultPath: () => string | null;
  /** Yield while foreground work runs (Notion jobs, user update checks). */
  isBusy?: () => boolean;
  firstRunDelayMs?: number;
  intervalMs?: number;
  // Injectable for tests:
  check?: (vaultPath: string) => Promise<UpdateCheckResult[]>;
  guard?: (vaultPath: string) => Promise<{ ahead: number; behind: number; error?: string; is_repo?: boolean }>;
  persist?: (cache: UpdateSweepCache) => void;
  removeClone?: (tmpPath: string) => void;
  onDone?: () => void;
  now?: () => string;
}

export function startUpdateSweep(deps: SweepDeps): UpdateSweeper {
  const isBusy = deps.isBusy ?? (() => false);
  const check = deps.check ?? ((vp: string) => checkUpdates(vp, undefined, { pull: true }));
  const guard = deps.guard ?? ((vp: string) => gitGuard(vp));
  const persist = deps.persist ?? writeSweepCache;
  const removeClone =
    deps.removeClone ??
    ((tmpPath: string) => {
      try {
        fs.rmSync(tmpPath, { recursive: true, force: true, maxRetries: 5 });
      } catch (err) {
        console.error(`[update-sweep] failed to remove temp clone ${tmpPath}:`, err);
      }
    });
  const onDone = deps.onDone ?? (() => {});
  const now = deps.now ?? (() => new Date().toISOString());

  let currentTick: Promise<void> | null = null;
  let stopped = false;

  async function tick(): Promise<void> {
    const vaultPath = deps.getVaultPath();
    if (!vaultPath || isBusy() || foregroundCheckActive()) return;

    let results: UpdateCheckResult[];
    try {
      results = await check(vaultPath);
    } catch (err) {
      console.error("[update-sweep] check failed:", err);
      return;
    }

    // The cache stores statuses only — drop the clones this sweep made.
    const clones = new Set<string>();
    for (const r of results) if (r.tmp_path) clones.add(r.tmp_path);
    for (const tmp of clones) removeClone(tmp);

    let guardResult: UpdateSweepCache["guard"];
    try {
      const g = await guard(vaultPath);
      if (g && g.is_repo !== false) {
        guardResult = { ahead: g.ahead, behind: g.behind, ...(g.error ? { error: g.error } : {}) };
      }
    } catch {
      /* guard is best-effort context */
    }

    try {
      persist({
        checked_at: now(),
        vault_path: vaultPath,
        results: results.map((r) => ({
          name: r.name,
          status: r.status,
          ...(r.message ? { message: r.message } : {}),
        })),
        ...(guardResult ? { guard: guardResult } : {}),
      });
    } catch (err) {
      console.error("[update-sweep] persist failed:", err);
      return;
    }

    console.log(`[update-sweep] checked ${results.length} skills`);
    try {
      onDone();
    } catch {
      /* broadcast is best-effort */
    }
  }

  function launch(): boolean {
    if (stopped || currentTick) return false;
    currentTick = tick()
      .catch((err) => console.error("[update-sweep] tick threw:", err))
      .finally(() => {
        currentTick = null;
      });
    return true;
  }

  const initial = setTimeout(launch, deps.firstRunDelayMs ?? FIRST_RUN_DELAY_MS);
  const interval = setInterval(launch, deps.intervalMs ?? INTERVAL_MS);
  // Never keep the process alive just for the sweep.
  initial.unref?.();
  interval.unref?.();

  return {
    stop() {
      stopped = true;
      clearTimeout(initial);
      clearInterval(interval);
    },
    runNow: launch,
    isRunning: () => currentTick !== null,
  };
}
