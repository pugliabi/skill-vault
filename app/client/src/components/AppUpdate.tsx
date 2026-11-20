import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "./ui/primitives";
import { renderMarkdown } from "../lib/markdown";
import { timeAgo } from "../lib/status";
import {
  appUpdateApi,
  getHealth,
  waitForNewServer,
  type AppUpdateStatus,
  type ApplyEvent,
} from "../lib/appUpdate";

const PROMPTED_KEY = "sv-update-prompted";
/** The version this window already prompted for; sessionStorage keeps it across reloads of one window. */
let promptedVersion: string | null = (() => {
  try {
    return sessionStorage.getItem(PROMPTED_KEY);
  } catch {
    return null;
  }
})();

function markPrompted(version: string): void {
  promptedVersion = version;
  try {
    sessionStorage.setItem(PROMPTED_KEY, version);
  } catch {
    /* the in-memory mark still stops repeats until the window reloads */
  }
}

/**
 * Sidebar-footer pill, shown only when this checkout is behind GitHub's
 * main. Opens AppUpdateDialog, which streams pull → install → build →
 * restart and reloads once the new server answers. When main carries a
 * higher app version (not just new commits), the dialog also opens by
 * itself once per app window, with the release notes.
 */
export function UpdatePill() {
  const qc = useQueryClient();
  // Snapshot of the status at click time keeps the dialog mounted: a refetch
  // that reports behind: 0 mid-update must not unmount it and its progress.
  // While the live status is still behind, the dialog shows that instead, so
  // its reason and button follow eligibility (a job finishing, a cleaned
  // checkout) rather than freezing at click time.
  const [snapshot, setSnapshot] = useState<AppUpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const { data } = useQuery({
    queryKey: ["app-update"],
    queryFn: appUpdateApi.status,
    // The server's first check runs 5 s after start: poll quickly until it
    // has one, so the startup prompt and pill don't wait for the 10-minute cadence.
    refetchInterval: (query) => (query.state.data?.checked_at ? 10 * 60_000 : 5_000),
    staleTime: 60_000,
  });
  const showPill = !!data && data.behind > 0;

  // Opening re-checks the checkout (the background check runs only every
  // 6 h), so fixing what blocked the update is picked up right away.
  const open = (current: AppUpdateStatus) => {
    setSnapshot(current);
    setChecking(true);
    appUpdateApi
      .check()
      .then((fresh) => {
        qc.setQueryData(["app-update"], fresh);
        if (fresh.behind > 0) setSnapshot((s) => (s ? fresh : s));
      })
      .catch(() => {
        /* keep showing the cached status */
      })
      .finally(() => setChecking(false));
  };

  // A new version prompts on its own, once per window (see markPrompted).
  // The status was just fetched, so this skips the re-check a click does.
  useEffect(() => {
    if (!data?.new_version || !data.latest_version || snapshot) return;
    if (promptedVersion === data.latest_version) return;
    markPrompted(data.latest_version);
    setSnapshot(data);
  }, [data, snapshot]);

  if (!showPill && !snapshot) return null;
  const shown = data && data.behind > 0 ? data : snapshot;

  return (
    <>
      {showPill && (
      <button
        onClick={() => open(data)}
        title={
          data.new_version && data.latest_version
            ? `Skill Vault ${data.latest_version} is available`
            : "A newer version of Skill Vault is available"
        }
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 8px",
          border: "0.5px solid var(--accent)",
          background: "var(--bg)",
          borderRadius: 6,
          cursor: "pointer",
          color: "var(--ink)",
          fontSize: 12,
        }}
      >
        <span className="sv-pulse" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)" }} />
        <span style={{ flex: 1, textAlign: "left" }}>Update available</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-4)" }}>
          {data.new_version && data.latest_version ? `v${data.latest_version}` : data.behind}
        </span>
      </button>
      )}
      {snapshot && shown && (
        <AppUpdateDialog status={shown} checking={checking} onClose={() => setSnapshot(null)} />
      )}
    </>
  );
}

/** One line for Settings → App: how this copy stands against GitHub's main. */
function updateSummary(s: AppUpdateStatus): { text: string; tone: "ok" | "info" | "warn" } {
  if (s.behind > 0) {
    const what =
      s.new_version && s.latest_version
        ? `Skill Vault ${s.latest_version} is available`
        : `${s.behind} new ${s.behind === 1 ? "change is" : "changes are"} on GitHub`;
    return s.can_apply
      ? { text: `${what}.`, tone: "info" }
      : { text: `${what}. It can't be installed right now: ${s.reason ?? "unknown reason"}.`, tone: "warn" };
  }
  if (!s.checked_at) {
    return s.last_error
      ? { text: `Couldn't check for updates: ${s.last_error}`, tone: "warn" }
      : { text: "Not checked yet.", tone: "info" };
  }
  if (s.last_error) return { text: `The last check didn't finish: ${s.last_error}`, tone: "warn" };
  if (!s.supported) return { text: `In-app updates are off: ${s.reason ?? "unknown reason"}.`, tone: "warn" };
  return { text: "You're up to date.", tone: "ok" };
}

const TONE_COLOR = { ok: "var(--ok)", info: "var(--ink-2)", warn: "var(--warn)" } as const;

/**
 * Settings → App: the installed version, "Check for updates" (asks GitHub
 * now instead of waiting for the 6-hour background check) and, when main is
 * ahead, the same Update & restart dialog the sidebar pill opens.
 */
export function AppUpdateSettings() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["app-update"], queryFn: appUpdateApi.status, staleTime: 60_000 });
  const [snapshot, setSnapshot] = useState<AppUpdateStatus | null>(null);
  const check = useMutation({
    mutationFn: appUpdateApi.check,
    onSuccess: (fresh) => qc.setQueryData(["app-update"], fresh),
  });
  const summary = data ? updateSummary(data) : null;
  // As in UpdatePill: follow the live status while it's still behind, else keep the snapshot mounted.
  const shown = data && data.behind > 0 ? data : snapshot;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ color: "var(--ink)" }}>
          Skill Vault{" "}
          {data?.version && <code style={{ fontFamily: "var(--mono)", fontSize: 12 }}>v{data.version}</code>}
        </span>
        {data?.checked_at && (
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>checked {timeAgo(data.checked_at)}</span>
        )}
        <span style={{ flex: 1 }} />
        <Button size="sm" onClick={() => check.mutate()} disabled={check.isPending || !!data?.applying}>
          {check.isPending ? "Checking…" : "Check for updates"}
        </Button>
        {data && data.behind > 0 && (
          <Button kind="primary" size="sm" onClick={() => setSnapshot(data)} disabled={check.isPending}>
            Update &amp; restart…
          </Button>
        )}
      </div>
      {check.isError ? (
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--bad)" }}>
          Couldn&apos;t check for updates: {(check.error as Error).message}
        </p>
      ) : (
        summary && <p style={{ margin: 0, fontSize: 12.5, color: TONE_COLOR[summary.tone] }}>{summary.text}</p>
      )}
      {snapshot && shown && <AppUpdateDialog status={shown} checking={false} onClose={() => setSnapshot(null)} />}
    </div>
  );
}

type Phase = "idle" | "running" | "restarting" | "failed";

const STEP_LABEL: Record<ApplyEvent["step"], string> = {
  check: "Check",
  pull: "Download the update",
  install: "Install packages",
  build: "Build",
  restart: "Restart",
};

const MARK: Record<ApplyEvent["state"], string> = { start: "…", done: "✓", skip: "–", wait: "…", error: "✗" };

function CommitList({ commits }: { commits: AppUpdateStatus["commits"] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4 }}>
      {commits.map((c) => (
        <div key={c.sha} style={{ fontSize: 12.5, display: "flex", gap: 8, color: "var(--ink)" }}>
          <code style={{ fontFamily: "var(--mono)", color: "var(--ink-3)" }}>{c.sha}</code>
          <span>{c.subject}</span>
        </div>
      ))}
    </div>
  );
}

const FOCUSABLE ='button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

function AppUpdateDialog({
  status,
  checking,
  onClose,
}: {
  status: AppUpdateStatus;
  checking: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>("idle");
  const [events, setEvents] = useState<ApplyEvent[]>([]);
  const busy = phase === "running" || phase === "restarting";
  const panel = useRef<HTMLDivElement>(null);
  const release = status.new_version && !!status.latest_version;
  const notesHtml = useMemo(() => (status.notes ? renderMarkdown(status.notes) : ""), [status.notes]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  // Modal focus: move focus into the dialog on open, keep Tab inside it,
  // and give it back to whatever opened the dialog on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const trapTab = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab" || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      e.preventDefault();
      panel.current.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!panel.current.contains(active) || (e.shiftKey && (active === first || active === panel.current))) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const run = async () => {
    setPhase("running");
    setEvents([]);
    const before = await getHealth();
    let restarting = false;
    let failed = false;
    let sawError = false;
    let dropped: string | null = null;
    try {
      await appUpdateApi.apply((e) => {
        setEvents((xs) => [...xs, e]);
        if (e.state === "error") {
          failed = true;
          sawError = true;
        }
        if (e.step === "restart" && e.state === "start") restarting = true;
      });
    } catch (err) {
      // The old server closing the stream after "restart" is expected.
      if (!restarting) {
        failed = true;
        dropped = (err as Error).message;
      }
    }
    // The stream can drop before the restart event arrives even though the
    // restart happened; confirm through /api/health before calling it failed.
    if (!restarting && !sawError) {
      const now = await getHealth();
      if (before && now && now.pid !== before.pid) {
        restarting = true;
        failed = false;
      } else if (dropped !== null) {
        setEvents((xs) => [...xs, { step: "check", state: "error", message: dropped! }]);
      }
    }
    if (failed || !restarting) {
      setPhase("failed");
      void qc.invalidateQueries({ queryKey: ["app-update"] });
      return;
    }
    setPhase("restarting");
    if (await waitForNewServer(before?.pid ?? null)) window.location.reload();
    else setPhase("failed");
  };

  // Latest state per step, in step order.
  const latest = new Map<ApplyEvent["step"], ApplyEvent>();
  for (const e of events) latest.set(e.step, e);

  return (
    <div
      onClick={() => !busy && onClose()}
      onKeyDown={trapTab}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "grid", placeItems: "center", zIndex: 50 }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Update Skill Vault"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          outline: "none",
          width: "min(520px, 92vw)",
          maxHeight: "70vh",
          overflow: "auto",
          background: "var(--bg)",
          border: "0.5px solid var(--border-2)",
          borderRadius: 8,
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {release ? (
          <>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Skill Vault {status.latest_version} is available</div>
            <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>You have {status.version}.</div>
            {status.notes && (
              // Notes scroll on their own so the buttons stay in view.
              <div
                className="sv-markdown sv-markdown--chat"
                style={{ borderTop: "0.5px solid var(--border)", paddingTop: 8, maxHeight: "38vh", overflowY: "auto" }}
                dangerouslySetInnerHTML={{ __html: notesHtml }}
              />
            )}
            <details style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
              <summary style={{ cursor: "pointer" }}>
                {status.behind} {status.behind === 1 ? "change" : "changes"} on GitHub
              </summary>
              <CommitList commits={status.commits} />
            </details>
          </>
        ) : (
          <>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Update Skill Vault</div>
            <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
              {status.behind} new {status.behind === 1 ? "change" : "changes"} on GitHub:
            </div>
            <CommitList commits={status.commits} />
          </>
        )}
        {checking && phase === "idle" && <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>Checking GitHub…</div>}
        {!checking && !status.can_apply && status.reason && phase === "idle" && (
          <div style={{ fontSize: 12.5, color: "var(--warn)" }}>Can't update right now: {status.reason}.</div>
        )}
        {latest.size > 0 && (
          <div style={{ fontFamily: "var(--mono)", fontSize: 12, display: "flex", flexDirection: "column", gap: 2 }}>
            {[...latest.values()].map((e) => (
              <div key={e.step} style={{ color: e.state === "error" ? "var(--bad)" : "var(--ink-2)" }}>
                {MARK[e.state]} {STEP_LABEL[e.step]}
                {e.message ? `: ${e.message}` : ""}
              </div>
            ))}
          </div>
        )}
        {phase === "restarting" && (
          <div style={{ fontSize: 12.5 }}>Restarting. The window reloads when the new version is ready.</div>
        )}
        {phase === "failed" && (
          <div style={{ fontSize: 12.5, color: "var(--bad)" }}>
            The update didn't finish. Your current version is still running; details are in
            ~/.skill-vault/logs/server.log.
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
          <Button kind="ghost" size="sm" onClick={onClose} disabled={busy}>
            {release && phase === "idle" ? "Later" : "Close"}
          </Button>
          <Button kind="primary" size="sm" onClick={() => void run()} disabled={!status.can_apply || busy || checking}>
            {busy ? "Updating…" : "Update & restart"}
          </Button>
        </div>
      </div>
    </div>
  );
}
