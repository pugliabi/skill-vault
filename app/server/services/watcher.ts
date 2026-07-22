/**
 * Filesystem watcher for the vault and every configured provider.
 *
 * Wraps chokidar, debounces per-skill, and emits typed events that
 * the SSE channel (Plan 03) forwards to the browser. Reuses
 * IGNORE_NAMES from skillHash.ts so the change-detection ignore
 * list cannot drift from the hash-detection ignore list.
 *
 * .tmp paths are filtered to avoid phantom events from the
 * atomic-rename pattern in appConfig.writeRaw and vault.writeManifest.
 *
 * Also exposes a singleton (`setActiveWatcher`/`getActiveWatcher`)
 * and a debounced `rebuildWatcher()` so the config endpoints
 * (PUT /api/config, POST/DELETE /api/config/providers) can swap
 * the active watcher when the user edits agent_locations.
 *
 * Not yet mounted in createApp — Plan 03 wires this up.
 */

import path from "node:path";
import fs from "node:fs";
import chokidar, { type FSWatcher } from "chokidar";
import { IGNORE_NAMES } from "./skillHash.ts";
import { skillsDir } from "./vault.ts";
import { readAppConfig } from "./appConfig.ts";
import type { Provider } from "../types/vault.ts";

// ── Public types ────────────────────────────────────────────────

export interface VaultWatcherEvents {
  skill_changed: { name: string };
  provider_changed: { provider_id: string; skill?: string };
}

export interface VaultWatcher {
  /** Subscribe to a typed event. Returns unsubscribe. */
  on<K extends keyof VaultWatcherEvents>(
    event: K,
    listener: (payload: VaultWatcherEvents[K]) => void,
  ): () => void;
  /** Stop the underlying chokidar watch and clear timers/listeners. Idempotent. */
  close(): Promise<void>;
}

// ── Tunables ────────────────────────────────────────────────────

const DEBOUNCE_MS = 500;
const MAX_HOLD_MS = 1500;
const REBUILD_DEBOUNCE_MS = 500;

// ── Helpers ─────────────────────────────────────────────────────

/**
 * chokidar `ignored` matcher. Filters:
 *   a. IGNORE_NAMES segments (single source from skillHash.ts).
 *   b. *.tmp suffixes — defeats the appConfig.writeRaw / writeManifest
 *      atomic-rename phantom-event problem on Windows.
 *   c. .temp-* segments — defensive replication of linking.ts's
 *      copy-time filter convention; covers any in-flight extracted
 *      package staging dirs that may live under a skill folder.
 */
function makeIgnored(): (p: string) => boolean {
  return (p: string) => {
    if (p.endsWith(".tmp")) return true;
    const segs = p.split(/[\\/]/);
    for (const s of segs) {
      if (!s) continue;
      if (s.startsWith(".temp-")) return true;
      if (IGNORE_NAMES.has(s)) return true;
    }
    return false;
  };
}

/**
 * Normalize a path for relative-segment extraction. chokidar emits
 * absolute paths on Windows that may use either separator depending
 * on how the watcher was started; path.relative handles both.
 */
function firstSegmentRelativeTo(rootDir: string, p: string): string | null {
  const rel = path.relative(rootDir, p);
  if (!rel || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  const segs = rel.split(/[\\/]/).filter(Boolean);
  return segs.length ? segs[0] : null;
}

// ── createVaultWatcher ──────────────────────────────────────────

interface PendingTimer {
  /** Wall time when the first event in this debounce window arrived. */
  firstAt: number;
  /** Trailing-edge timer (resets on each event up to MAX_HOLD_MS). */
  timer: NodeJS.Timeout;
  /** Latest payload to emit when the timer fires. */
  payload: VaultWatcherEvents[keyof VaultWatcherEvents];
  /** Which event channel this timer fires on. */
  event: keyof VaultWatcherEvents;
}

type ListenerMap = {
  [K in keyof VaultWatcherEvents]: Set<(payload: VaultWatcherEvents[K]) => void>;
};

export function createVaultWatcher(opts: {
  vaultPath: string;
  providers: Provider[];
}): VaultWatcher {
  const { vaultPath, providers } = opts;

  // Watch roots: <vault>/skills + every provider.path that exists.
  const vaultRoot = skillsDir(vaultPath);
  const providerRoots = providers.map((p) => ({
    id: p.id,
    root: path.resolve(p.path),
  }));

  const watchPaths: string[] = [];
  // Vault skills dir — even if it doesn't exist yet (initVault may run later);
  // chokidar's `ignoreInitial: true` plus add() of a real path is required, so
  // we filter to existing paths here. If skillsDir doesn't exist yet the
  // watcher simply has nothing on the vault side until rebuildWatcher() fires.
  if (fs.existsSync(vaultRoot)) {
    watchPaths.push(vaultRoot);
  }
  for (const pr of providerRoots) {
    if (fs.existsSync(pr.root)) {
      watchPaths.push(pr.root);
    }
  }

  const ignored = makeIgnored();

  const fsw: FSWatcher = chokidar.watch(watchPaths, {
    ignored,
    ignoreInitial: true,
    followSymlinks: false,
    persistent: true,
    // awaitWriteFinish is intentionally OFF.
    //
    // Chokidar's awaitWriteFinish holds events at the watcher layer
    // until file size has been stable for `stabilityThreshold` ms.
    // During sustained churn (e.g., editor saving every 150ms), it
    // suppresses events INDEFINITELY, which violates this watcher's
    // MAX_HOLD_MS = 1500ms contract.
    //
    // Our application-level per-skill debounce (500ms / 1500ms cap)
    // is the correct layer for burst coalescing. The .tmp ignore
    // filter handles the half-written-file race for atomic-rename
    // writers (appConfig.writeRaw, vault.writeManifest).
  });

  // ── Listener bookkeeping ───────────────────────────────────────

  const listeners: ListenerMap = {
    skill_changed: new Set(),
    provider_changed: new Set(),
  };

  function emit<K extends keyof VaultWatcherEvents>(
    event: K,
    payload: VaultWatcherEvents[K],
  ): void {
    for (const listener of listeners[event]) {
      try {
        (listener as (p: VaultWatcherEvents[K]) => void)(payload);
      } catch (err) {
        // Isolate listener bugs — same pattern as activity.ts.
        console.error(
          `[watcher] listener for "${event}" threw:`,
          err,
        );
      }
    }
  }

  // ── Per-key debounce ────────────────────────────────────────────
  //
  // Key shape:
  //   skill_changed              → "v:<skillName>"
  //   provider_changed (skill)   → "p:<providerId>:<skillName>"
  //   provider_changed (root)    → "p:<providerId>:"
  //
  // Trailing-edge timer that resets on each new event for the same
  // key, BUT cannot exceed MAX_HOLD_MS from the first event in the
  // window. Coalesces bursts; guarantees an event fires within 1.5s
  // even under sustained churn.

  const pending = new Map<string, PendingTimer>();
  let closed = false;

  function schedule<K extends keyof VaultWatcherEvents>(
    key: string,
    event: K,
    payload: VaultWatcherEvents[K],
  ): void {
    if (closed) return;
    const now = Date.now();
    const existing = pending.get(key);

    if (!existing) {
      const timer = setTimeout(() => fire(key), DEBOUNCE_MS);
      pending.set(key, {
        firstAt: now,
        timer,
        payload,
        event,
      });
      return;
    }

    // Update payload with latest (provider events may upgrade root → skill,
    // but key uniqueness already separates those buckets).
    existing.payload = payload;
    existing.event = event;

    const heldMs = now - existing.firstAt;
    const remainingHold = MAX_HOLD_MS - heldMs;

    // Always restart the trailing-edge timer, but cap it to whatever's
    // left of the max-hold budget.
    clearTimeout(existing.timer);
    const nextDelay = Math.max(0, Math.min(DEBOUNCE_MS, remainingHold));
    existing.timer = setTimeout(() => fire(key), nextDelay);
  }

  function fire(key: string): void {
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    emit(entry.event, entry.payload as VaultWatcherEvents[typeof entry.event]);
  }

  // ── Path classification ─────────────────────────────────────────

  function classify(p: string): void {
    const abs = path.resolve(p);

    // Vault skills tree?
    if (fs.existsSync(vaultRoot) || abs.startsWith(vaultRoot)) {
      // Use a string-based check instead of fs.existsSync alone — vaultRoot
      // may have been deleted by the event we're processing.
      const relV = path.relative(vaultRoot, abs);
      if (relV && !relV.startsWith("..") && !path.isAbsolute(relV)) {
        const seg = firstSegmentRelativeTo(vaultRoot, abs);
        if (seg) {
          schedule(`v:${seg}`, "skill_changed", { name: seg });
          return;
        }
        // Top-level addDir/unlinkDir on vaultRoot itself shouldn't happen —
        // chokidar emits the child path. If we ever get here, fall through.
      }
    }

    // Provider roots?
    for (const pr of providerRoots) {
      const rel = path.relative(pr.root, abs);
      if (!rel || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) {
        continue;
      }
      const seg = firstSegmentRelativeTo(pr.root, abs);
      if (seg) {
        const key = `p:${pr.id}:${seg}`;
        schedule(key, "provider_changed", {
          provider_id: pr.id,
          skill: seg,
        });
      } else {
        // Change at the provider root itself (skill folder added/removed).
        const key = `p:${pr.id}:`;
        schedule(key, "provider_changed", { provider_id: pr.id });
      }
      return;
    }
  }

  // chokidar fires `all` for add/addDir/change/unlink/unlinkDir.
  fsw.on("all", (_eventName, p) => {
    if (closed) return;
    classify(p);
  });

  fsw.on("error", (err) => {
    console.error("[watcher] chokidar error:", err);
  });

  // ── Public API ─────────────────────────────────────────────────

  function on<K extends keyof VaultWatcherEvents>(
    event: K,
    listener: (payload: VaultWatcherEvents[K]) => void,
  ): () => void {
    listeners[event].add(listener as never);
    return () => {
      listeners[event].delete(listener as never);
    };
  }

  let closing: Promise<void> | null = null;
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      // Drop pending timers WITHOUT firing.
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
      }
      pending.clear();
      try {
        await fsw.close();
      } catch (err) {
        console.error("[watcher] chokidar close threw:", err);
      }
      // Clear listener sets so a stale watcher reference cannot keep
      // closures alive after rebuild.
      listeners.skill_changed.clear();
      listeners.provider_changed.clear();
    })();
    return closing;
  }

  return { on, close };
}

// ── Singleton + debounced rebuild ───────────────────────────────

let activeWatcher: VaultWatcher | null = null;
let activeBridge: ((w: VaultWatcher) => void) | null = null;
let rebuildTimer: NodeJS.Timeout | null = null;
let rebuildInFlight: Promise<void> = Promise.resolve();

/** Register the currently-active watcher so listeners can be migrated on rebuild. */
export function setActiveWatcher(w: VaultWatcher | null): void {
  activeWatcher = w;
}

/** Returns the currently-active watcher (null until createApp wires one up). */
export function getActiveWatcher(): VaultWatcher | null {
  return activeWatcher;
}

/**
 * Bridge attached by createApp so rebuildWatcher knows how to re-wire
 * SSE listeners to the freshly-created chokidar instance.
 */
export function setActiveWatcherBridge(
  bridge: (w: VaultWatcher) => void,
): void {
  activeBridge = bridge;
}

async function performRebuild(): Promise<void> {
  const cfg = readAppConfig();
  const previous = activeWatcher;
  if (previous) {
    try {
      await previous.close();
    } catch (err) {
      console.error("[watcher] previous close threw during rebuild:", err);
    }
  }
  if (!cfg.vault_path) {
    activeWatcher = null;
    return;
  }
  const next = createVaultWatcher({
    vaultPath: cfg.vault_path,
    providers: cfg.providers,
  });
  activeWatcher = next;
  if (activeBridge) {
    try {
      activeBridge(next);
    } catch (err) {
      console.error("[watcher] bridge threw on rebuild:", err);
    }
  }
}

/**
 * Debounced rebuild. Calls within REBUILD_DEBOUNCE_MS of each other
 * coalesce into one rebuild on the trailing edge. Safe no-op if no
 * bridge has been registered yet (i.e. createApp hasn't run).
 *
 * Rebuilds are serialized — a second rebuild always waits for the
 * first to finish before kicking off, so we don't race close() against
 * a fresh chokidar.watch().
 */
export function rebuildWatcher(): void {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    rebuildInFlight = rebuildInFlight.then(async () => {
      try {
        await performRebuild();
      } catch (err) {
        console.error("[watcher] rebuild failed:", err);
      }
    });
  }, REBUILD_DEBOUNCE_MS);
}

/** Test-only escape hatch: reset module-private singleton state. */
export function __resetWatcherForTests(): void {
  activeWatcher = null;
  activeBridge = null;
  if (rebuildTimer) {
    clearTimeout(rebuildTimer);
    rebuildTimer = null;
  }
  rebuildInFlight = Promise.resolve();
}
