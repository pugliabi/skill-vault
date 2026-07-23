import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { Button } from "./ui/primitives";
import type { UpdateCheckResult } from "../lib/types";

/**
 * Check-for-updates dialog for the /skills page.
 *
 * Opens immediately and runs POST /api/adopt/check-updates for the given
 * skill names (or every adopted skill when `skills` is undefined). Results
 * are grouped into:
 *   - Updates available — pre-checked, safe to pull (vault copy untouched
 *     since adoption).
 *   - Conflicts — the vault copy was edited locally AND upstream changed;
 *     unchecked by default, pulling overwrites the local edits.
 *   - Informational — up to date, local-only changes, missing sources,
 *     errors. Not selectable.
 *
 * "Update N" calls POST /api/adopt/update for the checked rows. Any temp
 * clones the check created are cleaned up when the dialog closes (either
 * path), via the same /api/adopt/cleanup endpoint the Git adopt flow uses.
 */
export function UpdateDialog({
  skills,
  onClose,
}: {
  /** Names to check; undefined = all skills with a recorded origin. */
  skills?: string[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [results, setResults] = useState<UpdateCheckResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  // tmp clone dirs from the check — cleaned up exactly once on close.
  const tmpPaths = useRef<Set<string>>(new Set());
  const cleanedUp = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.checkUpdates(skills);
        if (cancelled) return;
        for (const r of res.results) if (r.tmp_path) tmpPaths.current.add(r.tmp_path);
        setResults(res.results);
        setPicked(new Set(
          res.results.filter((r) => r.status === "update_available").map((r) => r.name),
        ));
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Check failed");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cleanupAndClose = () => {
    if (!cleanedUp.current) {
      cleanedUp.current = true;
      for (const tmp of tmpPaths.current) {
        api.adoptCleanup({ tmp_path: tmp }).catch(() => {});
      }
    }
    onClose();
  };

  const updatable = (results ?? []).filter((r) => r.status === "update_available");
  const conflicts = (results ?? []).filter((r) => r.status === "conflict");
  const info = (results ?? []).filter(
    (r) => r.status !== "update_available" && r.status !== "conflict",
  );

  const toggle = (name: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const doApply = async () => {
    if (picked.size === 0 || applying || !results) return;
    setApplying(true);
    try {
      const items = results
        .filter((r) => picked.has(r.name))
        .map((r) => ({
          name: r.name,
          upstream_path: r.upstream_path,
          tmp_path: r.tmp_path,
        }));
      const res = await api.applyUpdates(items);
      const parts = [`Updated ${res.updated.length} skill(s)`];
      if (res.skipped.length > 0) parts.push(`${res.skipped.length} skipped`);
      toast.success(parts.join(" · "));
      qc.invalidateQueries({ queryKey: ["skills"] });
      cleanupAndClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Update failed");
      setApplying(false);
    }
  };

  const shortHash = (h?: string) => (h ? h.slice(0, 8) : "—");

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "oklch(0.15 0.005 60 / 0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) cleanupAndClose(); }}
    >
      <div
        style={{
          background: "var(--bg)",
          border: "0.5px solid var(--border-2)",
          borderRadius: 10,
          width: 660,
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 12px 40px oklch(0.1 0.01 60 / 0.3)",
        }}
      >
        <div style={{ padding: "16px 20px 12px", borderBottom: "0.5px solid var(--border)" }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--ink)" }}>
            Check for updates
          </h3>
          <div style={{ marginTop: 4, fontSize: 12, color: "var(--ink-3)" }}>
            {skills
              ? `${skills.length} selected skill${skills.length === 1 ? "" : "s"}`
              : "All skills with a recorded source"}
          </div>
        </div>

        <div className="sv-scroll" style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
          {error ? (
            <div style={{ padding: 28, textAlign: "center", fontSize: 13, color: "var(--bad)" }}>
              {error}
            </div>
          ) : results === null ? (
            <div style={{ padding: 28, textAlign: "center", fontSize: 13, color: "var(--ink-3)" }}>
              Checking sources… (git repos are pulled/cloned, this can take a moment)
            </div>
          ) : results.length === 0 ? (
            <div style={{ padding: 28, textAlign: "center", fontSize: 13, color: "var(--ink-3)" }}>
              No skills with a recorded source to check. Adopt (or re-adopt) a skill
              first — newly adopted skills track where they came from.
            </div>
          ) : (
            <>
              {updatable.length > 0 && (
                <Section title={`Updates available (${updatable.length})`} tone="var(--ok)">
                  {updatable.map((r) => (
                    <Row key={r.name} r={r} checked={picked.has(r.name)} onToggle={toggle} shortHash={shortHash} />
                  ))}
                </Section>
              )}
              {conflicts.length > 0 && (
                <Section
                  title={`Conflicts — local changes will be overwritten (${conflicts.length})`}
                  tone="var(--warn)"
                >
                  {conflicts.map((r) => (
                    <Row key={r.name} r={r} checked={picked.has(r.name)} onToggle={toggle} shortHash={shortHash} warn />
                  ))}
                </Section>
              )}
              {info.length > 0 && (
                <Section title={`No action (${info.length})`} tone="var(--ink-4)">
                  {info.map((r) => (
                    <div
                      key={r.name}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "7px 20px",
                        borderBottom: "0.5px solid var(--border)",
                        opacity: 0.75,
                      }}
                    >
                      <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--ink)", width: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.name}
                      </span>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: statusColor(r.status), flexShrink: 0 }}>
                        {statusLabel(r.status)}
                      </span>
                      <span title={r.message} style={{ flex: 1, fontSize: 11, color: "var(--ink-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.message ?? ""}
                      </span>
                    </div>
                  ))}
                </Section>
              )}
            </>
          )}
        </div>

        <div
          style={{
            padding: "10px 20px",
            borderTop: "0.5px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            justifyContent: "flex-end",
          }}
        >
          <Button kind="ghost" size="sm" onClick={cleanupAndClose} disabled={applying}>
            Cancel
          </Button>
          <Button
            kind="primary"
            size="sm"
            onClick={doApply}
            disabled={picked.size === 0 || applying || results === null}
          >
            {applying ? "Updating…" : `Update ${picked.size}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  tone,
  children,
}: {
  title: string;
  tone: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div
        style={{
          padding: "8px 20px 4px",
          fontFamily: "var(--mono)",
          fontSize: 10.5,
          fontWeight: 600,
          color: tone,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({
  r,
  checked,
  onToggle,
  shortHash,
  warn = false,
}: {
  r: UpdateCheckResult;
  checked: boolean;
  onToggle: (name: string) => void;
  shortHash: (h?: string) => string;
  warn?: boolean;
}) {
  const sourceLabel =
    r.origin?.type === "git"
      ? r.origin.url ?? "git"
      : r.origin?.path ?? "";
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 20px",
        borderBottom: "0.5px solid var(--border)",
        cursor: "pointer",
        background: warn && checked ? "color-mix(in oklab, var(--warn) 8%, transparent)" : "transparent",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={() => onToggle(r.name)}
        style={{ accentColor: warn ? "var(--warn)" : "var(--accent)", flexShrink: 0 }}
      />
      <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--ink)", width: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0 }}>
        {r.name}
      </span>
      <span
        title={`recorded ${shortHash(r.recorded_hash)} · vault ${shortHash(r.vault_hash)} · upstream ${shortHash(r.upstream_hash)}`}
        style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-4)", flexShrink: 0 }}
      >
        {shortHash(r.vault_hash)} → {shortHash(r.upstream_hash)}
      </span>
      {r.git_pulled && (
        <span title="Source repo was git-pulled before comparing" style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ok)", flexShrink: 0 }}>
          pulled
        </span>
      )}
      <span
        title={[sourceLabel, r.message].filter(Boolean).join(" · ")}
        style={{ flex: 1, fontSize: 11, color: "var(--ink-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "right" }}
      >
        {r.message ?? sourceLabel}
      </span>
    </label>
  );
}

function statusLabel(s: UpdateCheckResult["status"]): string {
  switch (s) {
    case "up_to_date": return "up to date";
    case "local_changed": return "local changes only";
    case "no_origin": return "no source recorded";
    case "source_missing": return "source missing";
    case "upstream_missing": return "gone upstream";
    case "error": return "error";
    default: return s;
  }
}

function statusColor(s: UpdateCheckResult["status"]): string {
  switch (s) {
    case "up_to_date": return "var(--ok)";
    case "local_changed": return "var(--info)";
    case "error": return "var(--bad)";
    default: return "var(--ink-4)";
  }
}
