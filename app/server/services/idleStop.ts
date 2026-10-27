/**
 * Stop the server when nobody is using it. Only for servers started by
 * scripts/launch.ps1 (`--exit-when-idle`). Idle means no open app window
 * (no SSE client on /api/events) and nothing busy (Notion job, assistant
 * turn, skill update check, app update). Grace: bootGraceMs until the first
 * window connects, then graceMs after the last one disconnects.
 */
export interface IdleOptions {
  clients: () => number;
  isBusy: () => boolean;
  graceMs: number;
  bootGraceMs: number;
  now?: () => number;
}

export function createIdleTracker(opts: IdleOptions): { tick(): boolean } {
  const now = opts.now ?? Date.now;
  let lastActive = now();
  let everConnected = false;
  return {
    /** True once the server has been idle for the applicable grace period. */
    tick(): boolean {
      const clients = opts.clients();
      if (clients > 0) everConnected = true;
      if (clients > 0 || opts.isBusy()) {
        lastActive = now();
        return false;
      }
      return now() - lastActive >= (everConnected ? opts.graceMs : opts.bootGraceMs);
    },
  };
}

export function startIdleStop(opts: IdleOptions & { onIdle: () => void; tickMs?: number }): { stop(): void } {
  const tracker = createIdleTracker(opts);
  const timer = setInterval(() => {
    if (!tracker.tick()) return;
    clearInterval(timer);
    opts.onIdle();
  }, opts.tickMs ?? 5_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
