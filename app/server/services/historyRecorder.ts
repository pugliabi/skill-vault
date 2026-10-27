/**
 * Records skill edits made outside the app (Claude Code, editors, git)
 * into version history. The vault watcher already debounces bursts to
 * ~0.5 s; this layer waits for a longer quiet period (60 s by default)
 * so an agent rewriting a skill in 40 saves yields one version.
 */

import fs from "node:fs";
import path from "node:path";
import {
  gcObjects,
  listVersions,
  recordDeletionMarker,
  recordVersion,
  skillHistoryDir,
} from "./history.ts";

export function createHistoryRecorder(opts: {
  getVaultPath: () => string | null;
  quietMs?: number;
}) {
  const quietMs = opts.quietMs ?? 60_000;
  // Keyed by `${vaultPath}\0${name}` so a pending debounce always fires
  // against the vault it was scheduled for, even if the app's active
  // vault is switched before the timer elapses.
  const timers = new Map<string, { vaultPath: string; name: string; timer: NodeJS.Timeout }>();

  function key(vaultPath: string, name: string): string {
    return `${vaultPath}\0${name}`;
  }

  function fire(vaultPath: string, name: string): void {
    timers.delete(key(vaultPath, name));
    try {
      if (fs.existsSync(path.join(vaultPath, "skills", name))) {
        recordVersion(vaultPath, name, { source: "external-edit" });
      } else if (fs.existsSync(skillHistoryDir(vaultPath, name))) {
        recordDeletionMarker(vaultPath, name, "deleted outside the app");
      }
    } catch (err) {
      console.error(`[history] failed to record ${name}:`, err);
    }
  }

  return {
    onSkillChanged(name: string): void {
      const vaultPath = opts.getVaultPath();
      if (!vaultPath) return;
      const k = key(vaultPath, name);
      const existing = timers.get(k);
      if (existing) clearTimeout(existing.timer);
      const timer = setTimeout(() => fire(vaultPath, name), quietMs);
      timers.set(k, { vaultPath, name, timer });
    },
    /** Record everything pending now (used on shutdown). */
    flush(): void {
      for (const { vaultPath, name, timer } of timers.values()) {
        clearTimeout(timer);
        fire(vaultPath, name);
      }
    },
    close(): void {
      for (const { timer } of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

type ScanResult = { recorded: number; deleted: number; gc: number };

/** The startup scan as steps: one per skill, then deletions and gc. */
function* scanSteps(vaultPath: string, out: ScanResult): Generator<void, void, void> {
  const skillsRoot = path.join(vaultPath, "skills");
  const present = fs.existsSync(skillsRoot)
    ? fs.readdirSync(skillsRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".temp-")).map((e) => e.name)
    : [];
  for (const name of present) {
    let hasHistory: boolean;
    try {
      hasHistory = listVersions(vaultPath, name).length > 0;
    } catch (err) {
      // Unreadable versions.json: leave it alone (recordVersion would skip it too).
      console.error(`[history] ${(err as Error).message}`);
      continue;
    }
    const v = recordVersion(vaultPath, name, {
      source: "external-edit",
      note: hasHistory ? "changed while the app was closed" : "baseline",
    });
    if (v) out.recorded++;
    yield;
  }
  const histSkills = path.join(vaultPath, ".history", "skills");
  if (fs.existsSync(histSkills)) {
    for (const name of fs.readdirSync(histSkills)) {
      // A skill created after the snapshot above is live, not deleted.
      if (present.includes(name) || fs.existsSync(path.join(skillsRoot, name))) continue;
      if (recordDeletionMarker(vaultPath, name, "deleted while the app was closed")) out.deleted++;
    }
  }
  yield;
  out.gc = gcObjects(vaultPath);
}

export function scanForUnrecordedChanges(vaultPath: string): ScanResult {
  const out: ScanResult = { recorded: 0, deleted: 0, gc: 0 };
  const steps = scanSteps(vaultPath, out);
  while (!steps.next().done) {
    /* run every step now */
  }
  return out;
}

/** Same scan, yielding to the event loop between skills so boot-time requests aren't held up. */
export async function scanForUnrecordedChangesAsync(vaultPath: string): Promise<ScanResult> {
  const out: ScanResult = { recorded: 0, deleted: 0, gc: 0 };
  const steps = scanSteps(vaultPath, out);
  while (!steps.next().done) await new Promise<void>((resolve) => setImmediate(resolve));
  return out;
}
