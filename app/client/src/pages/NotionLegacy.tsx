import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { Layout } from "../components/Layout";
import { GuardBanner } from "../components/GuardBanner";
import { Button } from "../components/ui/primitives";
import { ChangeMark, DiffBody } from "../components/DiffDrawer";
import { useNotionRunJob } from "../lib/useNotionRunJob";
import type { NotionRunJob } from "../lib/types";

/**
 * /notion/legacy — skills linked to a legacy Notion page (a distilled
 * summary made by the old converter, frozen by sync). Left: the legacy
 * skills with checkboxes. Right: the full vault skill vs Notion's summary
 * (downloaded on open, read-only). "Upgrade" replaces the summary page with
 * the full skill — same page, title set to the skill name, summary kept in
 * history — via POST /api/notion/legacy/upgrade (a job, polled like the
 * push/pull runs). A 409 vault_behind shows the multi-device guard banner.
 */

type RowResult = NotionRunJob["results"][number];

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Notion is not connected — connect it in Settings.";
    return err.message || fallback;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

function vaultBehindCount(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.message !== "vault_behind") return null;
  const raw = err.raw as { behind?: number } | null;
  return typeof raw?.behind === "number" ? raw.behind : 0;
}

function confirmText(names: string[]): string {
  if (names.length === 1) {
    return (
      `Replaces the Notion summary page with the full skill (all files). ` +
      `Sets the Notion title to '${names[0]}'. The summary is kept in history.`
    );
  }
  const shown = names.slice(0, 10).map((n) => `'${n}'`).join(", ") + (names.length > 10 ? `, and ${names.length - 10} more` : "");
  return (
    `Upgrade ${names.length} skills?\n\n` +
    `Replaces each Notion summary page with the full skill (all files). ` +
    `Sets each Notion title to the skill name (${shown}). The summaries are kept in history.`
  );
}

const skillOf = (id: string) => id.replace(/^upgrade:/, "");

export default function NotionLegacy() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const requested = new URLSearchParams(search).get("skill");
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["notion-legacy"],
    queryFn: () => api.notionLegacy(),
    retry: false,
  });
  const skills = useMemo(() => data?.skills ?? [], [data]);
  const focused = requested && skills.some((s) => s.name === requested) ? requested : skills[0]?.name ?? null;
  const focus = (name: string) => navigate(`/notion/legacy?skill=${encodeURIComponent(name)}`, { replace: true });

  const [checked, setChecked] = useState<Set<string>>(new Set());
  // Arriving from a skill's legacy badge pre-selects that skill.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !requested || !skills.some((s) => s.name === requested)) return;
    seeded.current = true;
    setChecked(new Set([requested]));
  }, [requested, skills]);
  // Drop selections that left the list (upgraded elsewhere / after a run).
  useEffect(() => {
    setChecked((prev) => {
      const next = new Set([...prev].filter((n) => skills.some((s) => s.name === n)));
      return next.size === prev.size ? prev : next;
    });
  }, [skills]);

  const [results, setResults] = useState<RowResult[]>([]);
  const [guard, setGuard] = useState<{ skills: string[]; behind: number } | null>(null);

  const { start, job, running, lost } = useNotionRunJob((finished, wasLost) => {
    const ran = finished?.results ?? [];
    setResults(ran);
    const failed = ran.filter((r) => !r.ok).length;
    if (wasLost) toast.error("Lost track of the upgrade — reload to see where things stand");
    else if (finished?.error) toast.error(`Upgrade failed: ${finished.error}`);
    else if (failed > 0) toast.error(`Upgrade: ${ran.length - failed} done, ${failed} failed — see the results`);
    else toast.success(`Upgraded ${ran.length} legacy page${ran.length === 1 ? "" : "s"}`);
    for (const key of ["skills", "notion-legacy", "notion-status", "notion-plan", "notion-conflicts"]) {
      qc.invalidateQueries({ queryKey: [key] });
    }
    for (const r of ran) if (r.ok) qc.invalidateQueries({ queryKey: ["history", skillOf(r.id)] });
  });

  const upgrade = useMutation({
    mutationFn: (body: { skills: string[]; override_guard?: boolean }) => api.notionUpgradeLegacy(body),
    onSuccess: (r) => {
      setGuard(null);
      setResults([]);
      start(r.job_id);
    },
    onError: (err, vars) => {
      const behind = vaultBehindCount(err);
      if (behind !== null) {
        setGuard({ skills: vars.skills, behind });
        return;
      }
      toast.error(errorText(err, "Upgrade failed"));
    },
  });

  const busy = running || upgrade.isPending;
  const run = (names: string[]) => {
    if (names.length === 0 || busy) return;
    if (!window.confirm(confirmText(names))) return;
    upgrade.mutate({ skills: names });
  };

  const allChecked = skills.length > 0 && skills.every((s) => checked.has(s.name));
  const toggle = (name: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <Layout>
      <div className="sv-fade-in" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "20px 24px 14px", borderBottom: "0.5px solid var(--border)", flexWrap: "wrap" }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--ink)", letterSpacing: "-0.01em" }}>
            Legacy Notion pages
          </h1>
          <span style={{ fontSize: 12, color: "var(--ink-3)", flex: 1, minWidth: 240 }}>
            Summary pages made by the old converter. Upgrading replaces each one with the full skill; the summary stays in history.
          </span>
          <Button
            size="sm"
            kind="primary"
            disabled={busy || checked.size === 0}
            onClick={() => run(skills.filter((s) => checked.has(s.name)).map((s) => s.name))}
          >
            Upgrade selected ({checked.size})
          </Button>
        </div>

        {guard && (
          <GuardBanner
            guard={{ is_repo: true, behind: guard.behind, ahead: 0 }}
            onRunAnyway={() => upgrade.mutate({ skills: guard.skills, override_guard: true })}
            onDismiss={() => setGuard(null)}
          />
        )}

        {(running || lost || results.length > 0) && (
          <div role="status" style={{ padding: "8px 24px", borderBottom: "0.5px solid var(--border)", fontSize: 12, display: "flex", flexDirection: "column", gap: 3 }}>
            {running ? (
              <span style={{ color: "var(--ink-2)" }}>
                Upgrading… {job?.done ?? 0}/{job?.total || "?"}
                {job?.current ? ` — ${job.current}` : ""}
              </span>
            ) : lost ? (
              <span style={{ color: "var(--bad)" }}>Lost track of the upgrade — reload to see where things stand.</span>
            ) : (
              results.map((r) => (
                <span key={r.id} style={{ color: r.ok ? "var(--ok)" : "var(--bad)" }}>
                  <span style={{ fontFamily: "var(--mono)" }}>{skillOf(r.id)}</span>:{" "}
                  {r.ok ? `✓ ${r.message ?? "upgraded"}` : `✕ ${r.error ?? "failed"}`}
                  {!r.ok && r.error?.startsWith("Name mismatch") && (
                    <>
                      {" "}
                      <Link
                        href={`/skill-names?skill=${encodeURIComponent(skillOf(r.id))}`}
                        style={{ color: "var(--accent)", textDecoration: "none", fontWeight: 500 }}
                      >
                        Fix in Names →
                      </Link>
                    </>
                  )}
                </span>
              ))
            )}
          </div>
        )}

        {isLoading ? (
          <div style={{ padding: 24, color: "var(--ink-3)", fontSize: 13 }}>Loading…</div>
        ) : error ? (
          <div style={{ padding: 24, color: "var(--bad)", fontSize: 13 }}>{errorText(error, "Couldn't load legacy pages")}</div>
        ) : skills.length === 0 ? (
          <div style={{ padding: 24, color: "var(--ink-3)", fontSize: 13 }}>No legacy pages — every linked skill is a full Notion skill.</div>
        ) : (
          <div style={{ flex: 1, display: "grid", gridTemplateColumns: "280px 1fr", minHeight: 0 }}>
            <div className="sv-scroll" style={{ borderRight: "0.5px solid var(--border-2)", overflowY: "auto" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderBottom: "0.5px solid var(--border)", fontSize: 12, color: "var(--ink-2)", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={allChecked}
                  disabled={busy}
                  onChange={() => setChecked(allChecked ? new Set() : new Set(skills.map((s) => s.name)))}
                />
                Select all ({skills.length})
              </label>
              {skills.map((s) => (
                <div
                  key={s.name}
                  role="button"
                  tabIndex={0}
                  aria-current={s.name === focused ? "true" : undefined}
                  onClick={() => focus(s.name)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") focus(s.name);
                  }}
                  style={{
                    display: "flex",
                    gap: 8,
                    padding: "9px 14px",
                    borderBottom: "0.5px solid var(--border)",
                    borderLeft: `2px solid ${s.name === focused ? "var(--accent)" : "transparent"}`,
                    background: s.name === focused ? "var(--surface-2)" : "transparent",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select ${s.name}`}
                    checked={checked.has(s.name)}
                    disabled={busy}
                    onClick={(e: MouseEvent) => e.stopPropagation()}
                    onChange={() => toggle(s.name)}
                    style={{ marginTop: 2 }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--ink)" }}>{s.name}</div>
                    {s.notion_title && s.notion_title !== s.name && (
                      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>Notion: {s.notion_title}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {focused && <LegacyDetail key={focused} name={focused} busy={busy} onUpgrade={() => run([focused])} />}
          </div>
        )}
      </div>
    </Layout>
  );
}

function LegacyDetail({ name, busy, onUpgrade }: { name: string; busy: boolean; onUpgrade: () => void }) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const { data: detail, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["notion-legacy-detail", name],
    queryFn: () => api.notionLegacyDetail(name),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const changed = useMemo(() => (detail?.diff.files ?? []).filter((f) => f.change !== "same"), [detail]);
  useEffect(() => {
    if (!selectedFile || !changed.some((f) => f.path === selectedFile)) setSelectedFile(changed[0]?.path ?? null);
  }, [changed, selectedFile]);

  if (isLoading) {
    return <div style={{ padding: 24, color: "var(--ink-3)", fontSize: 13 }}>Downloading the Notion summary…</div>;
  }
  if (error || !detail) {
    return (
      <div style={{ padding: 24, fontSize: 13, display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
        <span style={{ color: "var(--bad)" }}>{errorText(error, "Couldn't load this page")}</span>
        <Button size="sm" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? "Retrying…" : "Retry"}
        </Button>
      </div>
    );
  }

  const file = changed.find((f) => f.path === selectedFile) ?? null;
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ padding: "12px 18px", borderBottom: "0.5px solid var(--border)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 220 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
            {detail.name}
            {detail.notion_title && detail.notion_title !== detail.name && (
              <span style={{ marginLeft: 8, fontFamily: "inherit", fontWeight: 400, fontSize: 12, color: "var(--ink-3)" }}>
                Notion: {detail.notion_title} → {detail.name}
              </span>
            )}
          </span>
          <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
            Vault: {detail.vault_files.length} file{detail.vault_files.length === 1 ? "" : "s"} · Notion summary:{" "}
            {detail.notion_files.length} file{detail.notion_files.length === 1 ? "" : "s"}
          </span>
        </div>
        <Button size="sm" kind="primary" disabled={busy} onClick={onUpgrade}>
          Upgrade
        </Button>
      </div>
      <div className="sv-scroll" style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: "8px 18px" }}>
          {changed.length === 0 ? (
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>No content differences.</span>
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
        {file && <DiffBody file={file} labels={detail.labels} />}
      </div>
    </div>
  );
}
