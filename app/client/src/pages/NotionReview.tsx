import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { Layout } from "../components/Layout";
import { GuardBanner } from "../components/GuardBanner";
import { Button } from "../components/ui/primitives";
import { ChangeMark, DiffBody } from "../components/DiffDrawer";
import { useNotionRunJob } from "../lib/useNotionRunJob";
import { AskAIButton } from "../components/assistant/AskAIButton";
import type {
  NotionDeletedAction,
  NotionDirection,
  NotionPlanKind,
  NotionPlanRow,
  NotionRunJob,
} from "../lib/types";

/**
 * /notion/push and /notion/pull — review what a push or pull would do, pick
 * rows, run them. Left: rows grouped Update · New · Rename · Deleted ·
 * Conflict with checkboxes (group select-all), J/K to move, Space to toggle;
 * Deleted rows choose an action. Right: vault-vs-Notion diff of the focused
 * row (Notion copy downloaded read-only) + warnings. Footer: run the
 * selection, then per-row results. Conflict rows are never run here — they
 * link to Conflicts.
 */

const GROUPS: Array<{ kind: NotionPlanKind; label: string }> = [
  { kind: "update", label: "Update" },
  { kind: "new", label: "New" },
  { kind: "rename", label: "Rename" },
  { kind: "deleted", label: "Deleted" },
  { kind: "conflict", label: "Conflict" },
];

const ACTION_LABEL: Record<NotionDeletedAction, string> = {
  unlink: "Unlink (keep both sides)",
  "delete-vault": "Delete from vault (kept in history)",
  trash: "Move Notion page to trash",
  recreate: "Re-create in Notion",
};

type RowResult = NotionRunJob["results"][number];

function actionLabel(a: NotionDeletedAction, direction: NotionDirection): string {
  return a === "recreate" && direction === "pull" ? "Re-create in Notion (writes to Notion)" : ACTION_LABEL[a];
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Notion is not connected — connect it in Settings.";
    const raw = err.raw as { message?: string } | null;
    if (err.message === "plan_stale") return raw?.message ?? "The Notion check expired — reload the plan.";
    return err.message || fallback;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

/** A per-row error / warning about a folder vs SKILL.md name mismatch (fixed on the Names page). */
export function isNameMismatch(text: string | undefined): boolean {
  return !!text && text.startsWith("Name mismatch");
}

function rowLabel(r: NotionPlanRow): string {
  return r.skill ?? r.title ?? r.id;
}

export default function NotionReview({ direction }: { direction: NotionDirection }) {
  const qc = useQueryClient();
  const verb = direction === "push" ? "Push" : "Pull";

  const { data: plan, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["notion-plan", direction],
    queryFn: () => api.notionPlan(direction),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const rows = useMemo(() => plan?.rows ?? [], [plan]);
  const ordered = useMemo(
    () => GROUPS.flatMap((g) => rows.filter((r) => r.kind === g.kind)),
    [rows],
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actions, setActions] = useState<Record<string, NotionDeletedAction>>({});
  const [focused, setFocused] = useState<string | null>(null);
  const [overrideGuard, setOverrideGuard] = useState(false);
  /** Results of earlier runs on this plan (kept across runs until the plan is reloaded). */
  const [pastResults, setPastResults] = useState<Map<string, RowResult>>(new Map());

  // A new plan resets the selection to the plan's defaults.
  useEffect(() => {
    setSelected(new Set(rows.filter((r) => r.default_selected && r.kind !== "conflict").map((r) => r.id)));
    setActions(Object.fromEntries(rows.filter((r) => r.default_action).map((r) => [r.id, r.default_action!])));
    setFocused((f) => (f && rows.some((r) => r.id === f) ? f : ordered[0]?.id ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);

  const {
    start: startPolling,
    reset: resetPolling,
    job,
    running,
    lost: jobLost,
  } = useNotionRunJob((finished, lost) => {
    const ran = finished?.results ?? [];
    setPastResults((prev) => {
      const m = new Map(prev);
      for (const r of ran) m.set(r.id, r);
      return m;
    });
    setSelected((s) => {
      const n = new Set(s);
      for (const r of ran) n.delete(r.id);
      return n;
    });
    const failed = ran.filter((r) => !r.ok).length;
    if (lost) toast.error(`Lost track of the ${direction} — reload the plan to see where things stand`);
    else if (finished?.error) toast.error(`${verb} failed: ${finished.error}`);
    else if (failed) toast.error(`${verb}: ${ran.length - failed} done, ${failed} failed — see the rows`);
    else toast.success(`${verb}: ${ran.length} done`);
    qc.invalidateQueries({ queryKey: ["skills"] });
    qc.invalidateQueries({ queryKey: ["notion-conflicts"] });
    qc.invalidateQueries({ queryKey: ["notion-status"] });
    qc.invalidateQueries({ queryKey: ["notion-plan-diff"] });
  });
  const results = useMemo(() => {
    const m = new Map(pastResults);
    for (const r of job?.results ?? []) m.set(r.id, r);
    return m;
  }, [pastResults, job]);
  /** Rows that already ran successfully can't be run again from this plan. */
  const doneOk = (id: string) => results.get(id)?.ok === true;

  const start = useMutation({
    mutationFn: (body: Parameters<typeof api.notionRun>[0]) => api.notionRun(body),
    onSuccess: (r) => startPolling(r.job_id),
    onError: (err) => {
      if (err instanceof ApiError && err.status === 401) qc.invalidateQueries({ queryKey: ["notion-status"] });
      if (err instanceof ApiError && err.message === "plan_stale") refetch();
      // The guard shown on the page was stale (another device pushed since
      // this plan loaded) — reload it so plan.guard reflects the real
      // behind count and the banner appears.
      if (err instanceof ApiError && err.message === "vault_behind") refetch();
      toast.error(errorText(err, `${verb} failed`));
    },
  });

  const selectable = (r: NotionPlanRow) => r.kind !== "conflict";
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const setGroup = (kind: NotionPlanKind, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      for (const r of rows) if (r.kind === kind) (on ? n.add(r.id) : n.delete(r.id));
      return n;
    });

  // J/K move the focused row, Space toggles it. Only text entry swallows
  // the keys; on a focused checkbox/button Space keeps its native action.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      const inputType = tag === "INPUT" ? (el as HTMLInputElement).type : "";
      const textEntry =
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (tag === "INPUT" && !["checkbox", "radio", "button", "submit", "reset"].includes(inputType)) ||
        !!el?.isContentEditable;
      if (textEntry) return;
      const nativeSpace = tag === "BUTTON" || tag === "A" || tag === "INPUT";
      if ((e.key === "j" || e.key === "k") && ordered.length > 0) {
        e.preventDefault();
        const i = ordered.findIndex((r) => r.id === focused);
        const next = e.key === "j" ? Math.min(i + 1, ordered.length - 1) : Math.max(i - 1, 0);
        setFocused(ordered[i === -1 ? 0 : next].id);
      } else if (e.key === " " && !nativeSpace && focused && !running) {
        const r = ordered.find((x) => x.id === focused);
        if (r && selectable(r) && !doneOk(r.id)) {
          e.preventDefault();
          toggle(r.id);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [ordered, focused, running, results]);

  useEffect(() => {
    if (focused) document.getElementById(`plan-row-${focused}`)?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  const chosen = rows.filter((r) => selected.has(r.id) && selectable(r) && !doneOk(r.id));
  const guardBlocked = !!plan?.guard && plan.guard.behind > 0 && !overrideGuard;

  const runSelected = () => {
    const deletes = chosen.filter((r) => r.kind === "deleted" && actions[r.id] === "delete-vault");
    if (
      deletes.length > 0 &&
      !confirm(
        `Delete ${deletes.map(rowLabel).join(", ")} from the vault? ${deletes.length === 1 ? "It stays" : "They stay"} restorable from history.`,
      )
    ) {
      return;
    }
    start.mutate({
      direction,
      rows: chosen.map((r) => (r.kind === "deleted" ? { id: r.id, action: actions[r.id] } : { id: r.id })),
      ...(overrideGuard ? { override_guard: true } : {}),
    });
  };

  const reload = () => {
    resetPolling();
    setPastResults(new Map());
    refetch();
  };

  const focusedRow = rows.find((r) => r.id === focused) ?? null;

  return (
    <Layout>
      <div className="sv-fade-in" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "20px 24px 14px", borderBottom: "0.5px solid var(--border)", flexWrap: "wrap" }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--ink)", letterSpacing: "-0.01em" }}>
            {direction === "push" ? "Push to Notion" : "Pull from Notion"}
          </h1>
          <span style={{ fontSize: 12, color: "var(--ink-3)", flex: 1 }}>
            {direction === "push"
              ? "Vault changes that would go to Notion. Nothing runs until you choose."
              : "Notion changes that would come into the vault. Nothing runs until you choose."}
            {plan?.checked_at && <> · checked {new Date(plan.checked_at).toLocaleTimeString()}</>}
          </span>
          <AskAIButton
            options={{
              chips: [{ kind: "notion", id: `notion-${direction}`, label: `notion: ${direction} review` }],
              prompt: `Walk me through this Notion ${direction} plan — what would each row do, and is anything risky?`,
            }}
          />
          <Button size="sm" onClick={reload} disabled={isFetching || running}>
            {isFetching ? "Checking…" : "Reload"}
          </Button>
        </div>

        <GuardBanner guard={plan?.guard} overrideGuard={overrideGuard} onOverrideChange={setOverrideGuard} />

        {isLoading ? (
          <div style={{ padding: 24, color: "var(--ink-3)", fontSize: 13 }}>Checking Notion…</div>
        ) : error ? (
          <div style={{ padding: 24, fontSize: 13, display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
            <span style={{ color: "var(--bad)" }}>{errorText(error, "Couldn't build the plan")}</span>
            <Button size="sm" onClick={() => refetch()} disabled={isFetching}>
              Retry
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 24, color: "var(--ink-3)", fontSize: 13 }}>
            Nothing to {direction} — the vault and Notion agree.
          </div>
        ) : (
          <>
            <div style={{ flex: 1, display: "grid", gridTemplateColumns: "minmax(280px, 360px) 1fr", minHeight: 0 }}>
              <div className="sv-scroll" role="listbox" aria-label="Plan rows" style={{ borderRight: "0.5px solid var(--border-2)", overflowY: "auto" }}>
                {GROUPS.map((g) => {
                  const groupRows = rows.filter((r) => r.kind === g.kind);
                  if (groupRows.length === 0) return null;
                  const pickable = groupRows.filter((r) => selectable(r) && !doneOk(r.id));
                  const on = pickable.filter((r) => selected.has(r.id)).length;
                  return (
                    <div key={g.kind}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px 6px", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-3)", background: "var(--surface-2)", borderBottom: "0.5px solid var(--border)" }}>
                        {g.kind !== "conflict" && (
                          <input
                            type="checkbox"
                            aria-label={`Select all ${g.label}`}
                            disabled={running || pickable.length === 0}
                            checked={pickable.length > 0 && on === pickable.length}
                            ref={(el) => {
                              if (el) el.indeterminate = on > 0 && on < pickable.length;
                            }}
                            onChange={(e) => setGroup(g.kind, e.target.checked)}
                          />
                        )}
                        {g.label} · {groupRows.length}
                      </div>
                      {groupRows.map((r) => (
                        <PlanRowItem
                          key={r.id}
                          row={r}
                          focused={r.id === focused}
                          checked={selected.has(r.id)}
                          disabled={running || doneOk(r.id)}
                          action={actions[r.id]}
                          result={results.get(r.id)}
                          onFocus={() => setFocused(r.id)}
                          onToggle={() => toggle(r.id)}
                          onAction={(a) => setActions((m) => ({ ...m, [r.id]: a }))}
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
              {focusedRow ? (
                <RowDetail key={focusedRow.id} direction={direction} row={focusedRow} action={actions[focusedRow.id]} />
              ) : (
                <div />
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 24px", borderTop: "0.5px solid var(--border)", background: "var(--surface)" }}>
              <span style={{ flex: 1, fontSize: 12, color: "var(--ink-3)" }} role="status">
                {jobLost
                  ? "Lost track of this run (the server may have restarted) — reload the plan to see where things stand."
                  : running && job
                  ? `${verb}ing ${Math.min(job.done + 1, job.total)} of ${job.total}${job.current ? ` — ${job.current}` : ""}…`
                  : job && !job.running
                    ? `Done: ${job.results.filter((r) => r.ok).length} ok, ${job.results.filter((r) => !r.ok).length} failed.`
                    : "J/K to move · Space to select"}
              </span>
              {((job && !job.running) || jobLost) && (
                <Button size="sm" onClick={reload}>
                  Reload plan
                </Button>
              )}
              <Button
                size="sm"
                kind="primary"
                disabled={chosen.length === 0 || running || start.isPending || guardBlocked}
                title={guardBlocked ? "The vault is behind its remote — pull first or tick Run anyway" : undefined}
                onClick={runSelected}
              >
                {running || start.isPending ? `${verb}ing…` : `${verb} selected (${chosen.length})`}
              </Button>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}

function PlanRowItem({
  row,
  focused,
  checked,
  disabled,
  action,
  result,
  onFocus,
  onToggle,
  onAction,
}: {
  row: NotionPlanRow;
  focused: boolean;
  checked: boolean;
  disabled: boolean;
  action?: NotionDeletedAction;
  result?: NotionRunJob["results"][number];
  onFocus: () => void;
  onToggle: () => void;
  onAction: (a: NotionDeletedAction) => void;
}) {
  const conflict = row.kind === "conflict";
  return (
    <div
      id={`plan-row-${row.id}`}
      role="option"
      aria-selected={focused}
      onClick={onFocus}
      style={{
        display: "flex",
        gap: 8,
        padding: "8px 14px",
        borderBottom: "0.5px solid var(--border)",
        borderLeft: `2px solid ${focused ? "var(--accent)" : "transparent"}`,
        background: focused ? "var(--surface-2)" : "transparent",
        cursor: "pointer",
      }}
    >
      {!conflict && (
        <input
          type="checkbox"
          aria-label={`Select ${rowLabel(row)}`}
          checked={checked}
          disabled={disabled}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggle}
          style={{ marginTop: 2 }}
        />
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {rowLabel(row)}
          {row.kind === "rename" && row.title && row.title !== row.skill && (
            <span style={{ color: "var(--ink-3)" }}> → {row.title}</span>
          )}
        </span>
        <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{row.detail}</span>
        {row.warnings.length > 0 && (
          <span style={{ fontSize: 11, color: "var(--warn)" }}>⚠ {row.warnings.length} warning{row.warnings.length === 1 ? "" : "s"}</span>
        )}
        {row.kind === "deleted" && row.actions && (
          <select
            aria-label={`Action for ${rowLabel(row)}`}
            value={action ?? row.default_action}
            disabled={disabled}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onAction(e.target.value as NotionDeletedAction)}
            style={{ fontSize: 11.5, padding: "2px 4px", maxWidth: "100%", background: "var(--surface)", color: "var(--ink)", border: "0.5px solid var(--border-2)", borderRadius: 4 }}
          >
            {row.actions.map((a) => (
              <option key={a} value={a}>
                {actionLabel(a, row.direction)}
              </option>
            ))}
          </select>
        )}
        {conflict && row.skill && (
          <Link
            href={`/notion/conflicts?skill=${encodeURIComponent(row.skill)}`}
            onClick={(e: MouseEvent) => e.stopPropagation()}
            style={{ fontSize: 11.5, color: "var(--accent)", textDecoration: "none", fontWeight: 500 }}
          >
            Resolve in Conflicts →
          </Link>
        )}
        {result && (
          <span style={{ fontSize: 11, color: result.ok ? "var(--ok)" : "var(--bad)" }}>
            {result.ok ? `✓ ${result.message ?? "done"}` : `✕ ${result.error ?? "failed"}`}
          </span>
        )}
        {row.skill && (isNameMismatch(result?.error) || row.warnings.some((w) => isNameMismatch(w))) && (
          <Link
            href={`/skill-names?skill=${encodeURIComponent(row.skill)}`}
            onClick={(e: MouseEvent) => e.stopPropagation()}
            style={{ fontSize: 11.5, color: "var(--accent)", textDecoration: "none", fontWeight: 500 }}
          >
            Fix in Names →
          </Link>
        )}
      </div>
    </div>
  );
}

function RowDetail({
  direction,
  row,
  action,
}: {
  direction: NotionDirection;
  row: NotionPlanRow;
  action?: NotionDeletedAction;
}) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const { data: diff, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["notion-plan-diff", direction, row.id],
    queryFn: () => api.notionPlanDiff(direction, row.id),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const changed = useMemo(() => (diff?.files ?? []).filter((f) => f.change !== "same"), [diff]);
  useEffect(() => {
    if (!selectedFile || !changed.some((f) => f.path === selectedFile)) setSelectedFile(changed[0]?.path ?? null);
  }, [changed, selectedFile]);
  const file = changed.find((f) => f.path === selectedFile) ?? null;
  const chosenAction = action ?? row.default_action;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ padding: "12px 18px", borderBottom: "0.5px solid var(--border)", display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
          {rowLabel(row)}
          {row.title && row.title !== row.skill && (
            <span style={{ marginLeft: 8, fontFamily: "inherit", fontWeight: 400, fontSize: 12, color: "var(--ink-3)" }}>
              Notion: {row.title}
            </span>
          )}
        </span>
        <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{row.detail}</span>
        {row.kind === "deleted" && chosenAction === "trash" && (
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            This app can't trash Notion pages — running this row will remind you to trash it in Notion, then Unlink.
          </span>
        )}
        {row.warnings.map((w) => (
          <span key={w} role="note" style={{ fontSize: 12, color: "var(--warn)" }}>
            ⚠ {w}
          </span>
        ))}
        {row.kind === "conflict" && row.skill && (
          <Link href={`/notion/conflicts?skill=${encodeURIComponent(row.skill)}`} style={{ fontSize: 12.5, color: "var(--accent)", textDecoration: "none", fontWeight: 500 }}>
            Resolve in Conflicts →
          </Link>
        )}
      </div>
      <div className="sv-scroll" style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {isLoading ? (
          <div style={{ padding: 24, color: "var(--ink-3)", fontSize: 13 }}>Downloading the Notion copy…</div>
        ) : error || !diff ? (
          <div style={{ padding: 24, fontSize: 13, display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
            <span style={{ color: "var(--bad)" }}>{errorText(error, "Couldn't load the diff")}</span>
            <Button size="sm" onClick={() => refetch()} disabled={isFetching}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: "8px 18px", alignItems: "center" }}>
              {!diff.notion_available && row.page_id && (
                <span style={{ fontSize: 12, color: "var(--ink-3)", marginRight: 8 }}>No Notion copy to compare.</span>
              )}
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
            {file && <DiffBody file={file} labels={diff.labels} />}
          </>
        )}
      </div>
    </div>
  );
}
