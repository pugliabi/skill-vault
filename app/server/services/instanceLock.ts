/**
 * ~/.skill-vault/app.lock — which server owns this user's app window.
 * scripts/launch.ps1 reads it to reuse a running server instead of starting
 * a second one. A server takes the lock only when no live process holds it
 * (a second server — e.g. `npm run dev` beside the built app — still runs,
 * it just doesn't own the lock) and clears it only while it still owns it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface InstanceLock {
  pid: number;
  port: number;
  started_at: string;
  version: string;
  mode: "development" | "production";
}

/** Resolved per call: tests point USERPROFILE/HOME at a sandbox. */
export function lockPath(): string {
  return path.join(os.homedir(), ".skill-vault", "app.lock");
}

export function readLock(): InstanceLock | null {
  try {
    const l = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as InstanceLock;
    return typeof l?.pid === "number" && typeof l?.port === "number" ? l : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Write the lock unless another live process holds it. True when we own it. */
export function acquireLock(lock: InstanceLock, alive: (pid: number) => boolean = isProcessAlive): boolean {
  const held = readLock();
  if (held && held.pid !== lock.pid && alive(held.pid)) return false;
  try {
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(lockPath(), JSON.stringify(lock, null, 2) + "\n");
  } catch (err) {
    // The lock is a launcher convenience; never take the server down over it.
    console.error(`[lock] could not write ${lockPath()}: ${(err as Error).message}`);
    return false;
  }
  return true;
}

/** Remove the lock only if `pid` still owns it. */
export function releaseLock(pid: number): void {
  try {
    if (readLock()?.pid === pid) fs.rmSync(lockPath(), { force: true });
  } catch {
    /* runs in shutdown / exit handlers: must never throw */
  }
}

/** The build's git SHA from dist/.build-stamp; "dev" when running from source. */
export function buildVersion(appRoot: string, mode: InstanceLock["mode"]): string {
  if (mode !== "production") return "dev";
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(appRoot, "dist", ".build-stamp"), "utf8"));
    return typeof stamp.git_sha === "string" ? stamp.git_sha : "unknown";
  } catch {
    return "unknown";
  }
}
