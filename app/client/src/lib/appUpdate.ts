/**
 * In-app updates (server: services/appUpdate.ts, routes/app.ts). The apply
 * call streams NDJSON progress; after {step:"restart"} the server hands
 * over to a new process, so the client waits for /api/health to answer
 * with a new pid and then reloads.
 */
import { ApiError } from "./api";

export interface AppUpdateStatus {
  supported: boolean;
  branch: string | null;
  current: string | null;
  latest: string | null;
  behind: number;
  ahead: number;
  dirty: boolean;
  commits: Array<{ sha: string; subject: string }>;
  checked_at: string | null;
  can_apply: boolean;
  reason?: string;
  last_error?: string;
  applying: boolean;
}

export interface ApplyEvent {
  step: "check" | "pull" | "install" | "build" | "restart";
  /** "wait": the new build is ready; the restart is held until running jobs finish. */
  state: "start" | "done" | "skip" | "wait" | "error";
  message?: string;
}

export interface HealthInfo {
  ok: true;
  pid: number;
  port: number | null;
  version: string;
  mode: "development" | "production";
}

async function json<T>(method: "GET" | "POST", url: string): Promise<T> {
  const res = await fetch(url, { method });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(msg, res.status, data);
  }
  return data as T;
}

export const appUpdateApi = {
  status: () => json<AppUpdateStatus>("GET", "/api/app/update"),
  check: () => json<AppUpdateStatus>("POST", "/api/app/update/check"),
  /** Runs the update, calling onEvent per progress line, until the server ends the stream. */
  async apply(onEvent: (e: ApplyEvent) => void): Promise<void> {
    const res = await fetch("/api/app/update", { method: "POST" });
    if (!res.ok || !res.body) throw new Error(`Update failed to start (${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onEvent(JSON.parse(line) as ApplyEvent);
      }
    }
  },
};

export async function getHealth(): Promise<HealthInfo | null> {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    return res.ok ? ((await res.json()) as HealthInfo) : null;
  } catch {
    return null;
  }
}

/** After "Update & restart": true once /api/health answers from a different process. */
export async function waitForNewServer(oldPid: number | null, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const h = await getHealth();
    if (h && h.pid !== oldPid) return true;
  }
  return false;
}
