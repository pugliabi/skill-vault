import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { Layout } from "../components/Layout";
import { Button } from "../components/ui/primitives";
import { ChangeMark, DiffBody } from "../components/DiffDrawer";
import { ClaudeMergePanel } from "../components/ClaudeMergePanel";
import type { ConflictResolveBody, MergeResult, NotionConflict, NotionConflictItem } from "../lib/types";

/**
 * /notion/conflicts — skills edited on both sides since the last sync.
 * Left: the conflicts (name + both edit dates). Right: a fresh snapshot of
 * the selected skill (downloaded from Notion on open), its vault-vs-Notion
 * diff, and the three ways out: Keep vault, Keep Notion, or Merge with
 * Claude (only when the local claude CLI is available) → ClaudeMergePanel.
 * When Claude is unavailable (or the change is too large for it), "Edit
 * manually" opens the same panel seeded with the vault copy instead.
 * Every resolve carries the Notion version seen when the conflict was
 * opened; if Notion moved since, the server refuses (409 notion_changed)
 * and the conflict is reloaded.
 */
type QC = ReturnType<typeof useQueryClient>;

function when(iso?: string): string {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "unknown";
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Notion is no longer connected — connect it again in Settings.";
    const raw = err.raw as { message?: string; code?: string } | null;
    // A 413 from the request-size limit; the Claude prompt cap has its own message.
    if (err.status === 413 && raw?.code !== "claude_too_large") return "This change is too large to send in one request — pick a side or edit fewer files.";
    if (err.message === "notion_changed") return raw?.message ?? "Notion's copy changed — reloading the conflict.";
    if (err.message === "vault_changed") return raw?.message ?? "The vault copy changed — reloading the conflict.";
    if (err.message === "claude_unavailable") return "Claude isn't available on this machine.";
    return err.message || fallback;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

function onUnauthorized(qc: QC, err: unknown): void {
  if (err instanceof ApiError && err.status === 401) {
    qc.invalidateQueries({ queryKey: ["notion-status"] });
    qc.invalidateQueries({ queryKey: ["skills"] });
  }
}

export default function NotionConflicts() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const requested = new URLSearchParams(search).get("skill");

  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["notion-conflicts"],
    queryFn: () => api.notionConflicts(),
    retry: false,
  });
  const conflicts = useMemo(() => data?.skills ?? [], [data]);
  const selected =
    requested && conflicts.some((c) => c.name === requested) ? requested : conflicts[0]?.name ?? null;

  const select = (name: string | null) =>
    navigate(name ? `/notion/conflicts?skill=${encodeURIComponent(name)}` : "/notion/conflicts", { replace: true });

  /**
   * After a resolve: drop the skill from the list right away (no refetch of
   * the list or of the resolved skill) and select the next conflict (else
   * the previous one; none left → empty state).
   */
  const selectNextAfter = (name: string) => {
    const i = conflicts.findIndex((c) => c.name === name);
    const rest = conflicts.filter((c) => c.name !== name);
    qc.setQueryData<{ skills: NotionConflictItem[] }>(["notion-conflicts"], (old) =>
      old ? { ...old, skills: old.skills.filter((c) => c.name !== name) } : old,
    );
    qc.invalidateQueries({ queryKey: ["notion-conflicts"], refetchType: "none" });
    select(rest.length === 0 ? null : rest[Math.min(Math.max(i, 0), rest.length - 1)].name);
  };

  return (
    <Layout>
      <div className="sv-fade-in" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "20px 24px 14px", borderBottom: "0.5px solid var(--border)" }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--ink)", letterSpacing: "-0.01em" }}>
            Notion conflicts
          </h1>
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            Skills edited in both the vault and Notion since the last sync.
          </span>
        </div>

        {isLoading ? (
          <div style={{ padding: 24, color: "var(--ink-3)", fontSize: 13 }}>Loading…</div>
        ) : error ? (
          <div style={{ padding: 24, color: "var(--bad)", fontSize: 13 }}>{errorText(error, "Couldn't load conflicts")}</div>
        ) : conflicts.length === 0 ? (
          <div style={{ padding: 24, color: "var(--ink-3)", fontSize: 13 }}>No conflicts — everything is resolved.</div>
        ) : (
          <div style={{ flex: 1, display: "grid", gridTemplateColumns: "260px 1fr", minHeight: 0 }}>
            <div className="sv-scroll" style={{ borderRight: "0.5px solid var(--border-2)", overflowY: "auto" }}>
              {conflicts.map((c) => (
                <button
                  key={c.name}
                  onClick={() => select(c.name)}
                  aria-current={c.name === selected ? "true" : undefined}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "9px 14px",
                    border: 0,
                    borderBottom: "0.5px solid var(--border)",
                    borderLeft: `2px solid ${c.name === selected ? "var(--accent)" : "transparent"}`,
                    cursor: "pointer",
                    background: c.name === selected ? "var(--surface-2)" : "transparent",
                  }}
                >
                  <div style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--ink)" }}>{c.name}</div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)" }}>vault {when(c.vault_edited_at)}</div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)" }}>Notion {when(c.notion_edited_at)}</div>
                </button>
              ))}
            </div>
            {selected && <ConflictDetail key={selected} name={selected} onResolved={() => selectNextAfter(selected)} />}
          </div>
        )}
      </div>
    </Layout>
  );
}

function ConflictDetail({ name, onResolved }: { name: string; onResolved: () => void }) {
  const qc = useQueryClient();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [merge, setMerge] = useState<MergeResult | null>(null);
  /** The panel holds a hand edit (no Claude result). */
  const [manual, setManual] = useState(false);
  /** Claude refused this conflict as too large — offer the manual editor. */
  const [tooLarge, setTooLarge] = useState(false);

  const { data: conflict, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["notion-conflict", name],
    queryFn: () => api.notionConflict(name),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const { data: claude } = useQuery({
    queryKey: ["claude-status"],
    queryFn: () => api.claudeStatus(),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (error) onUnauthorized(qc, error);
  }, [error, qc]);

  const changed = useMemo(
    () => (conflict?.diff_vault_vs_notion.files ?? []).filter((f) => f.change !== "same"),
    [conflict],
  );
  useEffect(() => {
    if (!selectedFile || !changed.some((f) => f.path === selectedFile)) setSelectedFile(changed[0]?.path ?? null);
  }, [changed, selectedFile]);

  /** Notion moved under us: drop any merge and reload the conflict. */
  const reload = () => {
    setMerge(null);
    setManual(false);
    qc.invalidateQueries({ queryKey: ["notion-conflict", name] });
  };
  const handleError = (err: unknown, fallback: string) => {
    onUnauthorized(qc, err);
    toast.error(errorText(err, fallback));
    if (err instanceof ApiError && (err.message === "notion_changed" || err.message === "vault_changed")) reload();
    if (err instanceof ApiError && err.message === "claude_unavailable") {
      qc.invalidateQueries({ queryKey: ["claude-status"] });
    }
  };

  const resolve = useMutation({
    mutationFn: (body: ConflictResolveBody) => api.notionResolve(name, body),
    onSuccess: (_r, body) => {
      toast.success(
        body.mode === "keep-vault"
          ? `${name}: kept the vault copy and updated Notion`
          : body.mode === "keep-notion"
            ? `${name}: kept the Notion copy`
            : body.mode === "files" && body.edited
              ? `${name}: edited copy saved and pushed to Notion`
              : `${name}: merged copy saved and pushed to Notion`,
      );
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.invalidateQueries({ queryKey: ["history", name] });
      // The resolved skill's snapshot is stale; mark it so without refetching
      // (it is only fetched again if the skill is ever selected again).
      qc.invalidateQueries({ queryKey: ["notion-conflict", name], refetchType: "none" });
      onResolved();
    },
    onError: (err) => handleError(err, "Resolve failed"),
  });

  const runMerge = useMutation({
    mutationFn: (c: NotionConflict) => api.notionMerge(name, c.notion_version_id),
    onSuccess: (r) => {
      setManual(false);
      setMerge(r);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 413 && (err.raw as { code?: string } | null)?.code === "claude_too_large") {
        setTooLarge(true);
      }
      handleError(err, "Claude merge failed");
    },
  });

  if (isLoading) {
    return <div style={{ padding: 24, color: "var(--ink-3)", fontSize: 13 }}>Downloading the Notion copy…</div>;
  }
  if (error || !conflict) {
    return (
      <div style={{ padding: 24, fontSize: 13, display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
        <span style={{ color: "var(--bad)" }}>{errorText(error, "Couldn't load this conflict")}</span>
        <Button size="sm" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? "Retrying…" : "Retry"}
        </Button>
      </div>
    );
  }

  const busy = resolve.isPending || runMerge.isPending || isFetching;
  const version = conflict.notion_version_id;
  const file = changed.find((f) => f.path === selectedFile) ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ padding: "12px 18px", borderBottom: "0.5px solid var(--border)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 220 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
            {conflict.name}
            {conflict.notion_title && conflict.notion_title !== conflict.name && (
              <span style={{ marginLeft: 8, fontFamily: "inherit", fontWeight: 400, fontSize: 12, color: "var(--ink-3)" }}>
                Notion: {conflict.notion_title}
              </span>
            )}
          </span>
          <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
            Vault edited {when(conflict.vault_edited_at)} · Notion edited {when(conflict.notion_edited_at)}
            {!conflict.base_available && " · no common base version (never synced)"}
          </span>
        </div>
        {!merge && (
          <span style={{ display: "flex", gap: 8 }}>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                if (!confirm(`Overwrite Notion with the vault copy of "${name}"? Notion's current copy is saved in history first.`)) return;
                resolve.mutate({ mode: "keep-vault", expected_notion_version: version });
              }}
            >
              {resolve.isPending && resolve.variables?.mode === "keep-vault" ? "Keeping vault…" : "Keep vault"}
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                if (!confirm(`Overwrite the vault copy of "${name}" with Notion's? The vault copy is saved in history first.`)) return;
                resolve.mutate({ mode: "keep-notion", expected_notion_version: version });
              }}
            >
              {resolve.isPending && resolve.variables?.mode === "keep-notion" ? "Keeping Notion…" : "Keep Notion"}
            </Button>
            {claude?.available && !tooLarge && (
              <Button size="sm" kind="primary" disabled={busy} onClick={() => runMerge.mutate(conflict)}>
                Merge with Claude
              </Button>
            )}
            {(claude && !claude.available) || tooLarge ? (
              <Button
                size="sm"
                kind={tooLarge || !claude?.available ? "primary" : "default"}
                disabled={busy}
                title="Edit the vault copy by hand, then save it to both sides"
                onClick={() => {
                  setManual(true);
                  setMerge(manualSeed(conflict));
                }}
              >
                Edit manually
              </Button>
            ) : null}
          </span>
        )}
      </div>

      <div className="sv-scroll" style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {runMerge.isPending ? (
          <div role="status" style={{ padding: 24, fontSize: 13, color: "var(--ink-2)", display: "flex", alignItems: "center", gap: 10 }}>
            <span aria-hidden style={{ display: "inline-block", width: 12, height: 12, borderRadius: "50%", border: "2px solid var(--border-2)", borderTopColor: "var(--accent)", animation: "sv-spin 0.9s linear infinite" }} />
            Claude is reading both versions…
            <style>{"@keyframes sv-spin { to { transform: rotate(360deg); } }"}</style>
          </div>
        ) : merge ? (
          <ClaudeMergePanel
            result={merge}
            conflict={conflict}
            applying={resolve.isPending}
            manual={manual}
            onDiscard={() => {
              setMerge(null);
              setManual(false);
            }}
            onApply={(files, binary_choices, edited) =>
              resolve.mutate({
                mode: "files",
                expected_notion_version: merge.notion_version_id ?? version,
                expected_vault_hash: conflict.vault_hash,
                files,
                binary_choices,
                edited,
              })
            }
          />
        ) : (
          <>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: "8px 18px" }}>
              {changed.length === 0 ? (
                <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                  No content differences — keeping either side will mark it in sync.
                </span>
              ) : (
                changed.map((f) => (
                  <button
                    key={f.path}
                    onClick={() => setSelectedFile(f.path)}
                    aria-current={f.path === selectedFile ? "true" : undefined}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      padding: "2px 6px",
                      borderRadius: 4,
                      cursor: "pointer",
                      color: "var(--ink)",
                      border: `0.5px solid ${f.path === selectedFile ? "var(--accent)" : "var(--border-2)"}`,
                      background: "var(--surface)",
                    }}
                  >
                    <ChangeMark change={f.change} />
                    {f.path}
                  </button>
                ))
              )}
            </div>
            {file && <DiffBody file={file} labels={{ left: "vault", right: "notion" }} />}
          </>
        )}
      </div>
    </div>
  );
}

/** A "merge result" for hand editing: each differing text file starts as the vault copy (Notion's if the vault has none). */
function manualSeed(conflict: NotionConflict): MergeResult {
  return {
    explanation: "",
    vault_changes: [],
    notion_changes: [],
    decisions: [],
    warnings: [],
    files: conflict.files
      .filter((f) => !f.same && !f.binary && !f.too_large)
      .map((f) => ({ path: f.path, content: f.vault ?? f.notion ?? "" })),
    notion_version_id: conflict.notion_version_id,
  };
}
