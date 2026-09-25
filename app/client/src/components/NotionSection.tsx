import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link } from "wouter";
import { api, ApiError } from "../lib/api";
import { Button, Rule } from "./ui/primitives";
import type { NotionLinkSummary } from "../lib/types";

/**
 * Settings → Notion. Mirrors the HistorySection visual pattern (Rule +
 * surface box). Walks through three states:
 *
 *   1. Not connected — "Connect Notion" kicks off OAuth (POST /connect).
 *   2. Connected, no data source chosen — pick one of the candidate
 *      Skills databases detected via search.
 *   3. Configured — check/link/disconnect, with a first-run link job
 *      polled to completion and its summary rendered inline.
 *
 * On mount, reads `?notion=connected|error&message=` left by the OAuth
 * callback redirect, toasts it, and strips it from the URL so a refresh
 * doesn't re-toast.
 */
type QC = ReturnType<typeof useQueryClient>;

const NOT_CONNECTED_TEXT = "Notion is no longer connected — connect it again.";

/** Friendly text for a Notion API error (never the raw "notion_not_connected" code). */
function notionErrorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.message === "notion_not_connected") return NOT_CONNECTED_TEXT;
    return err.message || fallback;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

/** On a 401 the server has dropped the tokens: refresh status so the UI falls back to "Connect". */
function refreshIfUnauthorized(qc: QC, err: unknown): void {
  if (err instanceof ApiError && err.status === 401) {
    qc.invalidateQueries({ queryKey: ["notion-status"] });
    qc.invalidateQueries({ queryKey: ["skills"] });
  }
}

/** Toast a Notion error and resync status on 401. */
function reportNotionError(qc: QC, err: unknown, fallback: string): void {
  refreshIfUnauthorized(qc, err);
  toast.error(notionErrorText(err, fallback));
}

function useNotionDisconnect(qc: QC) {
  const disconnect = useMutation({
    mutationFn: () => api.notionDisconnect(),
    onSuccess: () => {
      toast.success("Notion disconnected");
      qc.invalidateQueries({ queryKey: ["notion-status"] });
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Disconnect failed"),
  });
  const confirmAndDisconnect = () => {
    if (!window.confirm("Disconnect Notion? Existing links stay in the vault, but sync stops until you reconnect.")) return;
    disconnect.mutate();
  };
  return { disconnect, confirmAndDisconnect };
}

export function NotionSection({ qc }: { qc: QC }) {
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const notion = params.get("notion");
    if (!notion) return;
    const message = params.get("message");
    if (notion === "connected") {
      toast.success("Notion connected");
    } else if (notion === "error") {
      toast.error(message ? `Notion sign-in failed: ${message}` : "Notion sign-in failed");
    }
    params.delete("notion");
    params.delete("message");
    const qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data: status, isLoading } = useQuery({
    queryKey: ["notion-status"],
    queryFn: () => api.notionStatus(),
  });

  return (
    <>
      <Rule label="Notion" />
      <div
        style={{
          background: "var(--surface)",
          border: "0.5px solid var(--border)",
          borderRadius: 8,
          padding: "14px 18px",
          marginBottom: 22,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          fontSize: 13,
          color: "var(--ink-2)",
        }}
      >
        {status?.connected && status.missing_tools && status.missing_tools.length > 0 && (
          <div
            role="alert"
            style={{
              fontSize: 12,
              color: "var(--ink)",
              border: "0.5px solid var(--border-2)",
              borderRadius: 6,
              padding: "6px 10px",
              background: "var(--surface-2)",
            }}
          >
            Your Notion connection is missing tools this app needs: {status.missing_tools.join(", ")}. Some
            actions may fail until they are available.
          </div>
        )}
        {isLoading ? (
          <span style={{ color: "var(--ink-3)" }}>Loading…</span>
        ) : !status?.connected ? (
          <NotConnected qc={qc} />
        ) : !status.data_source ? (
          <PickDataSource qc={qc} />
        ) : (
          <Configured qc={qc} status={status} />
        )}
      </div>
    </>
  );
}

/* ── State 1: not connected ─────────────────────────────────────── */

function NotConnected({ qc }: { qc: QC }) {
  const connect = useMutation({
    mutationFn: () => api.notionConnect(),
    onSuccess: (r) => {
      if (r.status === "redirect") {
        window.location.href = r.url;
        return;
      }
      toast.success("Notion connected");
      qc.invalidateQueries({ queryKey: ["notion-status"] });
    },
    onError: (err) => reportNotionError(qc, err, "Connect failed"),
  });

  return (
    <>
      <p style={{ margin: 0 }}>Sync skills with your Notion Skills library.</p>
      <div>
        <Button kind="primary" size="sm" onClick={() => connect.mutate()} disabled={connect.isPending}>
          {connect.isPending ? "Connecting…" : "Connect Notion"}
        </Button>
      </div>
    </>
  );
}

/* ── State 2: connected, no data source ─────────────────────────── */

function PickDataSource({ qc }: { qc: QC }) {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["notion-data-sources"],
    queryFn: () => api.notionDataSources(),
    retry: false,
  });
  const { disconnect, confirmAndDisconnect } = useNotionDisconnect(qc);
  useEffect(() => {
    if (error) refreshIfUnauthorized(qc, error);
  }, [error, qc]);
  const sources = data?.data_sources ?? [];
  const [selectedId, setSelectedId] = useState<string>("");
  const [addLastEdited, setAddLastEdited] = useState(true);

  useEffect(() => {
    if (sources.length > 0 && !selectedId) setSelectedId(sources[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  const use = useMutation({
    mutationFn: () => {
      const src = sources.find((s) => s.id === selectedId);
      return api.notionSetDataSource({
        id: selectedId,
        name: src?.name ?? "",
        add_last_edited: addLastEdited,
      });
    },
    onSuccess: (r) => {
      toast.success("Notion database configured");
      if (r.warning) toast.warning(r.warning);
      qc.invalidateQueries({ queryKey: ["notion-status"] });
    },
    onError: (err) => reportNotionError(qc, err, "Failed to set database"),
  });

  if (isLoading) {
    return <span style={{ color: "var(--ink-3)" }}>Looking for a Skills database…</span>;
  }

  if (error) {
    return (
      <>
        <p style={{ margin: 0 }}>
          Couldn&apos;t look up your Notion Skills databases: {notionErrorText(error, "request failed")}
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <Button kind="default" size="sm" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? "Retrying…" : "Retry"}
          </Button>
          <Button kind="danger" size="sm" onClick={confirmAndDisconnect} disabled={disconnect.isPending}>
            Disconnect
          </Button>
        </div>
      </>
    );
  }

  if (sources.length === 0) {
    return (
      <p style={{ margin: 0 }}>
        No Notion Skills database found. Create one in Notion, then reload this page.
      </p>
    );
  }

  return (
    <>
      {sources.length === 1 ? (
        <p style={{ margin: 0 }}>
          Found: <strong style={{ color: "var(--ink)" }}>{sources[0].name}</strong>
        </p>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Database:</span>
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            style={{
              fontFamily: "var(--mono)",
              fontSize: 12,
              color: "var(--ink)",
              background: "var(--bg)",
              border: "0.5px solid var(--border-2)",
              borderRadius: 5,
              padding: "0 8px",
              height: 28,
            }}
          >
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12.5, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={addLastEdited}
          onChange={(e) => setAddLastEdited(e.target.checked)}
          style={{ marginTop: 2, accentColor: "var(--accent)" }}
        />
        <span>
          Add a &quot;Last edited&quot; property to this database (recommended — lets the app
          detect Notion changes quickly)
        </span>
      </label>
      <div>
        <Button
          kind="primary"
          size="sm"
          onClick={() => use.mutate()}
          disabled={!selectedId || use.isPending}
        >
          {use.isPending ? "Saving…" : "Use this database"}
        </Button>
      </div>
    </>
  );
}

/* ── State 3: configured ─────────────────────────────────────────── */

const SUMMARY_ROWS: Array<{ key: keyof NotionLinkSummary; label: string }> = [
  { key: "linked_in_sync", label: "In sync" },
  { key: "conflicts", label: "Conflicts" },
  { key: "legacy", label: "Legacy" },
  { key: "notion_only_compatible", label: "Notion-only compatible" },
  { key: "notion_only_native", label: "Notion-native (not compatible)" },
  { key: "vault_only", label: "Vault-only" },
  { key: "errors", label: "Errors" },
];

function summaryCount(summary: NotionLinkSummary, key: keyof NotionLinkSummary): number {
  return (summary[key] as unknown[]).length;
}

function summaryNames(summary: NotionLinkSummary, key: keyof NotionLinkSummary): string[] {
  const value = summary[key];
  return (value as Array<string | { title?: string; skill?: string; page_id?: string }>).map((v) =>
    typeof v === "string" ? v : v.title ?? v.skill ?? v.page_id ?? "?",
  );
}

function Configured({
  qc,
  status,
}: {
  qc: QC;
  status: { data_source?: { id: string; name: string }; last_edited_property?: string | null; linked_at?: string; checked_at?: string };
}) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: job, error: jobError } = useQuery({
    queryKey: ["notion-job", jobId],
    queryFn: () => api.notionLinkJob(jobId!),
    enabled: !!jobId,
    retry: false,
    refetchInterval: (query) =>
      !query.state.error && query.state.data && !query.state.data.error && query.state.data.summary === undefined
        ? 1000
        : false,
  });

  useEffect(() => {
    if (job?.summary) {
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.invalidateQueries({ queryKey: ["notion-conflicts"] });
      qc.invalidateQueries({ queryKey: ["notion-status"] });
      qc.invalidateQueries({ queryKey: ["notion-summary"] });
    }
    if (job?.error) {
      toast.error(job.error);
      setJobId(null);
    }
  }, [job, qc]);

  // The job vanished (server restarted -> 404) or polling failed: stop and clear it.
  useEffect(() => {
    if (!jobError) return;
    toast.error(
      jobError instanceof ApiError && jobError.status === 404
        ? "The link job is no longer available (the app may have restarted) — run Link skills again."
        : notionErrorText(jobError, "Lost track of the link job"),
    );
    setJobId(null);
  }, [jobError]);

  const check = useMutation({
    mutationFn: () => api.notionCheck(),
    onSuccess: (r) => {
      toast.success(`Checked Notion — ${r.rows} skill${r.rows === 1 ? "" : "s"}`);
      qc.invalidateQueries({ queryKey: ["notion-status"] });
      qc.invalidateQueries({ queryKey: ["notion-conflicts"] });
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) => reportNotionError(qc, err, "Check failed"),
  });

  const link = useMutation({
    mutationFn: () => api.notionStartLink(),
    onSuccess: (r) => {
      setJobId(r.job_id);
    },
    onError: (err) => reportNotionError(qc, err, "Link failed"),
  });

  const { disconnect, confirmAndDisconnect: handleDisconnect } = useNotionDisconnect(qc);

  const { data: conflicts } = useQuery({
    queryKey: ["notion-conflicts"],
    queryFn: () => api.notionConflicts(),
    retry: false,
  });
  const conflictCount = conflicts?.skills.length ?? 0;

  const busy = check.isPending || link.isPending || (jobId != null && job && !job.summary && !job.error);

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div>
          Database: <strong style={{ color: "var(--ink)" }}>{status.data_source?.name}</strong>
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
          Last edited: {status.last_edited_property ? "on" : "off"}
          {status.checked_at && <> · last check {new Date(status.checked_at).toLocaleString()}</>}
          {status.linked_at && <> · last link {new Date(status.linked_at).toLocaleString()}</>}
        </div>
      </div>

      {conflictCount > 0 && (
        <Link
          href="/notion/conflicts"
          style={{ fontSize: 12.5, color: "var(--accent)", textDecoration: "none", fontWeight: 500 }}
        >
          Review {conflictCount} conflict{conflictCount === 1 ? "" : "s"} →
        </Link>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <Button kind="default" size="sm" onClick={() => check.mutate()} disabled={!!busy}>
          {check.isPending ? "Checking…" : "Check Notion now"}
        </Button>
        <Button kind="default" size="sm" onClick={() => link.mutate()} disabled={!!busy}>
          {link.isPending || (jobId && job && !job.summary && !job.error) ? "Linking…" : "Link skills"}
        </Button>
        <Button kind="danger" size="sm" onClick={handleDisconnect} disabled={disconnect.isPending}>
          Disconnect
        </Button>
      </div>

      <UnlinkedSkills qc={qc} />

      {jobId && job && !job.summary && !job.error && (
        <div style={{ fontSize: 12, color: "var(--ink-3)", fontFamily: "var(--mono)" }}>
          {job.done} / {job.total} — {job.current || "…"}
        </div>
      )}

      {jobId && job?.summary && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "10px 12px",
            background: "var(--bg)",
            border: "0.5px solid var(--border)",
            borderRadius: 6,
          }}
        >
          {SUMMARY_ROWS.map(({ key, label }) => {
            const count = summaryCount(job.summary!, key);
            const names = summaryNames(job.summary!, key);
            const isOpen = expanded === key;
            return (
              <div key={key}>
                <button
                  onClick={() => setExpanded(isOpen ? null : (key as string))}
                  disabled={count === 0}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    width: "100%",
                    border: 0,
                    background: "transparent",
                    padding: 0,
                    cursor: count === 0 ? "default" : "pointer",
                    fontSize: 12.5,
                    color: count === 0 ? "var(--ink-4)" : "var(--ink-2)",
                    textAlign: "left",
                  }}
                >
                  <span style={{ flex: 1 }}>{label}</span>
                  <span style={{ fontFamily: "var(--mono)", fontWeight: 600, color: "var(--ink)" }}>
                    {count}
                  </span>
                  {count > 0 && <span style={{ fontSize: 9, color: "var(--ink-4)" }}>{isOpen ? "▾" : "▸"}</span>}
                </button>
                {isOpen && count > 0 && (
                  <div
                    style={{
                      marginTop: 4,
                      marginLeft: 4,
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      color: "var(--ink-3)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                    }}
                  >
                    {names.map((n, i) => (
                      <span key={i}>{n}</span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/**
 * Skills whose Notion link was cut ("unlinked"). Relink forgets the link so
 * the next "Link skills" run matches the skill to a Notion page again.
 */
function UnlinkedSkills({ qc }: { qc: QC }) {
  const { data } = useQuery({ queryKey: ["skills"], queryFn: () => api.listSkills() });
  const unlinked = (data?.skills ?? []).filter((s) => s.notion_status === "unlinked").map((s) => s.name);
  const relink = useMutation({
    mutationFn: (name: string) => api.notionRelink(name),
    onSuccess: (_r, name) => {
      toast.success(`${name}: will be matched again on the next Link skills run`);
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) => reportNotionError(qc, err, "Relink failed"),
  });
  if (unlinked.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
        Unlinked from Notion ({unlinked.length}) — Relink, then run Link skills to match them again:
      </div>
      {unlinked.map((name) => (
        <div key={name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-2)" }}>{name}</span>
          <Button
            kind="default"
            size="sm"
            disabled={relink.isPending}
            onClick={() => relink.mutate(name)}
          >
            Relink
          </Button>
        </div>
      ))}
    </div>
  );
}
