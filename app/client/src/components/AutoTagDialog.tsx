import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { buildSuggestions, diffTags, suggestTags } from "../lib/autoTag";
import { Button } from "./ui/primitives";
import type { Skill } from "../lib/types";

/**
 * Review-and-apply dialog for auto-tagging.
 *
 * Two sources of suggestions:
 * - **AI** (default when the Claude Code CLI is on PATH): the client sends
 *   skill names to POST /api/tags/suggest one batch at a time (so progress
 *   is real and Cancel is immediate); the server has Claude classify them
 *   from name + description + a SKILL.md excerpt and returns the full
 *   recommended tag set per skill with a one-line reason, plus a
 *   conservative list of current tags to remove. Additions are
 *   pre-accepted; removals start rejected and are only pre-accepted with
 *   "Include removals". Batches that fail fall back to the keyword rules.
 * - **Keywords**: lib/autoTag's deterministic rules, additions only.
 *
 * The user toggles individual chips, then Apply groups accepted changes by
 * tag and calls the existing bulkTag endpoint once per (tag, add|remove).
 * Nothing is written before Apply.
 */

const BATCH_SIZE = 20;
const NO_SELECTION: Skill[] = [];
const CONCURRENCY = 2;

type Mode = "ai" | "keywords";
type Op = "add" | "remove";

interface Row {
  skill: string;
  add: string[];
  remove: string[];
  newTags: string[];
  reason?: string;
  /** Per removed tag, the model's reason (when it gave one). */
  removeReasons?: Record<string, string>;
  fallback?: boolean;
}

interface AiRun {
  state: "running" | "done" | "cancelled";
  total: number;
  done: number;
  rows: Row[];
  unchanged: number;
  failures: string[];
  /** Skills that got keyword-fallback suggestions instead of AI ones. */
  fallbackSkills: number;
}

export function AutoTagDialog({
  skills,
  selected = NO_SELECTION,
  onClose,
}: {
  skills: Skill[];
  /** When non-empty, auto-tag only these skills. */
  selected?: Skill[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["ai-tag-status"],
    queryFn: () => api.aiTagStatus(),
    staleTime: 60_000,
  });
  const aiAvailable = !!status.data?.available;
  const [rechecking, setRechecking] = useState(false);
  const recheck = async () => {
    setRechecking(true);
    try {
      qc.setQueryData(["ai-tag-status"], await api.aiTagStatus(true));
    } catch {
      toast.error("Could not check for the Claude Code CLI");
    } finally {
      setRechecking(false);
    }
  };

  const [modeChoice, setModeChoice] = useState<Mode | null>(null);
  const mode: Mode = modeChoice ?? (aiAvailable ? "ai" : "keywords");
  // AI mode is for re-tagging too, so it defaults to every skill in scope.
  const [untaggedChoice, setUntaggedChoice] = useState<boolean | null>(null);
  const onlyUntagged = untaggedChoice ?? mode === "keywords";
  const [applying, setApplying] = useState(false);
  const [run, setRun] = useState<AiRun | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const scope = useMemo(() => {
    if (selected.length) return selected;
    return onlyUntagged ? skills.filter((s) => s.tags.length === 0) : skills;
  }, [skills, selected, onlyUntagged]);

  // Changing mode or the set of skills in scope invalidates an AI run. Keyed
  // by names, not array identity: the skills query refetches on vault events.
  const scopeKey = useMemo(() => scope.map((s) => s.name).join("\n"), [scope]);
  const cancelRun = () => {
    abortRef.current?.abort();
    abortRef.current = null;
  };
  useEffect(() => {
    cancelRun();
    setRun(null);
  }, [mode, scopeKey]);
  useEffect(() => cancelRun, []);

  const keywordRows = useMemo<Row[]>(
    () =>
      mode === "keywords"
        ? buildSuggestions(scope, { onlyUntagged: false }).map((r) => ({
            skill: r.skill,
            add: r.suggested,
            remove: [],
            newTags: [],
          }))
        : [],
    [mode, scope],
  );
  const rows = mode === "ai" ? (run?.rows ?? []) : keywordRows;

  const startAi = async () => {
    cancelRun();
    const ac = new AbortController();
    abortRef.current = ac;
    const bySkill = new Map(scope.map((s) => [s.name, s]));
    const batches: string[][] = [];
    for (let i = 0; i < scope.length; i += BATCH_SIZE) {
      batches.push(scope.slice(i, i + BATCH_SIZE).map((s) => s.name));
    }
    setRun({
      state: "running",
      total: scope.length,
      done: 0,
      rows: [],
      unchanged: 0,
      failures: [],
      fallbackSkills: 0,
    });

    const fallbackRows = (names: string[], error: string): Row[] =>
      names.flatMap((name) => {
        const s = bySkill.get(name);
        const add = s ? suggestTags(s) : [];
        return add.length
          ? [{ skill: name, add, remove: [], newTags: [], fallback: true, reason: `Keyword fallback (AI: ${error})` }]
          : [];
      });

    const handleBatch = async (names: string[]) => {
      let newRows: Row[] = [];
      let unchanged = 0;
      let fallbackSkills = 0;
      const failures: string[] = [];
      try {
        const res = await api.suggestTagsAI(names, ac.signal);
        for (const [name, sug] of Object.entries(res.results)) {
          const current = bySkill.get(name)?.tags ?? [];
          const { add } = diffTags(current, sug.tags);
          // The server decides which removals are allowed at all.
          const remove = (sug.remove ?? []).filter((t) => current.includes(t));
          if (!add.length && !remove.length) {
            unchanged++;
            continue;
          }
          newRows.push({
            skill: name,
            add,
            remove,
            newTags: sug.new_tags,
            reason: sug.reason,
            removeReasons: sug.remove_reasons,
          });
        }
        for (const f of res.failed) {
          failures.push(f.error);
          fallbackSkills += f.names.length;
          newRows = newRows.concat(fallbackRows(f.names, f.error));
        }
      } catch (err) {
        if (ac.signal.aborted) return;
        const msg = err instanceof ApiError ? err.message : "request failed";
        failures.push(msg);
        fallbackSkills += names.length;
        newRows = fallbackRows(names, msg);
      }
      if (ac.signal.aborted) return;
      setRun((r) =>
        r && {
          ...r,
          done: r.done + names.length,
          unchanged: r.unchanged + unchanged,
          failures: [...r.failures, ...failures],
          fallbackSkills: r.fallbackSkills + fallbackSkills,
          rows: [...r.rows, ...newRows].sort((a, b) => a.skill.localeCompare(b.skill)),
        },
      );
    };

    let next = 0;
    const worker = async () => {
      while (next < batches.length && !ac.signal.aborted) {
        await handleBatch(batches[next++]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
    if (abortRef.current === ac) abortRef.current = null;
    setRun((r) => r && { ...r, state: ac.signal.aborted ? "cancelled" : "done" });
  };

  const stopAi = () => {
    cancelRun();
    setRun((r) => r && { ...r, state: "cancelled" });
  };

  // Chips the user flipped away from their default, keyed "skill\0op\0tag".
  // Additions default to accepted; removals default to rejected unless
  // "Include removals" is on.
  const [includeRemovals, setIncludeRemovals] = useState(false);
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  const key = (skill: string, op: Op, tag: string) => `${skill}\0${op}\0${tag}`;
  const isOff = (skill: string, op: Op, tag: string) => {
    const defaultOn = op === "add" || includeRemovals;
    return flipped.has(key(skill, op, tag)) === defaultOn;
  };
  const toggle = (skill: string, op: Op, tag: string) => {
    const k = key(skill, op, tag);
    setFlipped((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };
  const setRemovals = (on: boolean) => {
    setIncludeRemovals(on);
    // Toggling pre-accepts (or pre-rejects) every removal again.
    setFlipped((prev) => new Set([...prev].filter((k) => k.split("\0")[1] !== "remove")));
  };
  const removalCount = rows.reduce((n, r) => n + r.remove.length, 0);

  // Accepted changes grouped by "op\0tag" → skills.
  const accepted = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const r of rows) {
      for (const [op, tags] of [["add", r.add], ["remove", r.remove]] as [Op, string[]][]) {
        for (const tag of tags) {
          if (isOff(r.skill, op, tag)) continue;
          const g = `${op}\0${tag}`;
          groups.set(g, [...(groups.get(g) ?? []), r.skill]);
        }
      }
    }
    return groups;
    // isOff reads only flipped + includeRemovals.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, flipped, includeRemovals]);

  const acceptedCount = useMemo(
    () => [...accepted.values()].reduce((n, arr) => n + arr.length, 0),
    [accepted],
  );

  const apply = async () => {
    if (accepted.size === 0) return;
    setApplying(true);
    try {
      const results = await Promise.allSettled(
        [...accepted].map(([g, skillNames]) => {
          const [op, tag] = g.split("\0") as [Op, string];
          return op === "add"
            ? api.bulkTag({ skills: skillNames, add: [tag] })
            : api.bulkTag({ skills: skillNames, remove: [tag], prune_known: false });
        }),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const affected = new Set([...accepted.values()].flat());
      if (failed === 0) {
        toast.success(
          `Updated tags on ${affected.size} skill${affected.size === 1 ? "" : "s"} · ${acceptedCount} change${acceptedCount === 1 ? "" : "s"}`,
        );
      } else {
        toast.warning(`Applied with ${failed} tag group${failed === 1 ? "" : "s"} failing`);
      }
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.invalidateQueries({ queryKey: ["tags"] });
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Auto-tag failed");
    } finally {
      setApplying(false);
    }
  };

  const running = run?.state === "running";
  const batchCount = Math.ceil(scope.length / BATCH_SIZE);
  const pct = run && run.total ? Math.round((run.done / run.total) * 100) : 0;

  const chip = (r: Row, op: Op, tag: string) => {
    const off = isOff(r.skill, op, tag);
    const why = op === "remove" ? r.removeReasons?.[tag] : undefined;
    const color = op === "add" ? "var(--ok)" : "var(--bad)";
    const isNew = op === "add" && r.newTags.includes(tag);
    return (
      <button
        key={`${op}-${tag}`}
        onClick={() => toggle(r.skill, op, tag)}
        style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          fontWeight: 500,
          padding: "2px 8px",
          borderRadius: 4,
          cursor: "pointer",
          border: `0.5px ${isNew ? "dashed" : "solid"} ${off ? "var(--border-2)" : color}`,
          background: off ? "transparent" : `color-mix(in oklab, ${color} 12%, transparent)`,
          color: off ? "var(--ink-4)" : color,
          textDecoration: off ? "line-through" : "none",
        }}
        title={
          op === "add"
            ? `${off ? "Click to add" : "Will add — click to skip"}${isNew ? " (new tag)" : ""}`
            : `${off ? "Will keep — click to remove" : "Will remove — click to keep"}${why ? ` (${why})` : ""}`
        }
      >
        {op === "add" ? "+" : "−"}{tag}{isNew ? " ·new" : ""}
      </button>
    );
  };

  const segBtn = (m: Mode, label: string, disabled = false) => (
    <button
      onClick={() => setModeChoice(m)}
      disabled={disabled || running}
      style={{
        fontSize: 12,
        padding: "3px 10px",
        border: "none",
        borderRadius: 5,
        cursor: disabled || running ? "default" : "pointer",
        background: mode === m ? "var(--bg)" : "transparent",
        color: disabled ? "var(--ink-4)" : mode === m ? "var(--ink)" : "var(--ink-3)",
        boxShadow: mode === m ? "0 0 0 0.5px var(--border-2)" : "none",
      }}
    >
      {label}
    </button>
  );

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
      onClick={(e) => { if (e.target === e.currentTarget && !applying) onClose(); }}
    >
      <div
        style={{
          background: "var(--bg)",
          border: "0.5px solid var(--border-2)",
          borderRadius: 10,
          width: 640,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 12px 40px oklch(0.1 0.01 60 / 0.3)",
        }}
      >
        {/* Header */}
        <div style={{ padding: "18px 22px 12px", borderBottom: "0.5px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--ink)", flex: 1 }}>
              Auto-tag skills
            </h3>
            <div style={{ display: "inline-flex", gap: 2, padding: 2, borderRadius: 7, background: "var(--surface-2)" }}>
              {segBtn("ai", "AI (Claude)", !aiAvailable)}
              {segBtn("keywords", "Keywords")}
            </div>
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--ink-2)" }}>
            {mode === "ai"
              ? "Claude reads each skill's name, description and SKILL.md and proposes tags. Suggested removals stay unchecked unless you include them. Nothing changes until you apply."
              : "Suggested from each skill's name and description with keyword rules. Uncheck anything wrong, then apply."}
          </p>
          {!status.isLoading && !aiAvailable && (
            <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ink-3)" }}>
              AI tagging needs the Claude Code CLI (<code>claude</code>) on PATH
              {status.data?.reason ? ` — ${status.data.reason}` : ""}. Using keyword rules.{" "}
              <button
                onClick={recheck}
                disabled={rechecking}
                style={{
                  border: "none",
                  background: "none",
                  padding: 0,
                  font: "inherit",
                  color: "var(--accent)",
                  textDecoration: "underline",
                  cursor: rechecking ? "default" : "pointer",
                }}
              >
                {rechecking ? "Checking…" : "Re-check"}
              </button>
            </p>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10, fontSize: 12, color: "var(--ink-2)" }}>
            {selected.length ? (
              <span>
                Scope: {selected.length} selected skill{selected.length === 1 ? "" : "s"}
              </span>
            ) : (
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: running ? "default" : "pointer" }}>
                <input
                  type="checkbox"
                  checked={onlyUntagged}
                  disabled={running}
                  onChange={(e) => setUntaggedChoice(e.target.checked)}
                  style={{ accentColor: "var(--accent)" }}
                />
                Only untagged skills
              </label>
            )}
            <span style={{ color: "var(--ink-3)" }}>
              {scope.length} skill{scope.length === 1 ? "" : "s"} in scope
            </span>
            {mode === "ai" && (
              <label
                style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", marginLeft: "auto" }}
                title="Suggested removals start unchecked; turn this on to pre-select them"
              >
                <input
                  type="checkbox"
                  checked={includeRemovals}
                  onChange={(e) => setRemovals(e.target.checked)}
                  style={{ accentColor: "var(--accent)" }}
                />
                Include removals{removalCount ? ` (${removalCount})` : ""}
              </label>
            )}
          </div>

          {mode === "ai" && run && (
            <div style={{ marginTop: 10 }}>
              <div style={{ height: 4, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    width: `${pct}%`,
                    background: "var(--accent)",
                    transition: "width 300ms ease",
                  }}
                />
              </div>
              <div style={{ marginTop: 5, fontSize: 11.5, color: "var(--ink-3)", display: "flex", gap: 8 }}>
                <span>
                  {running ? "Classifying" : run.state === "cancelled" ? "Stopped at" : "Classified"} {run.done} / {run.total}
                </span>
                {run.unchanged > 0 && <span>· {run.unchanged} already fine</span>}
                {run.fallbackSkills > 0 && (
                  <span style={{ color: "var(--warn)" }} title={[...new Set(run.failures)].join("\n")}>
                    · {run.fallbackSkills} skill{run.fallbackSkills === 1 ? "" : "s"} used the keyword fallback
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Body */}
        <div className="sv-scroll" style={{ flex: 1, overflowY: "auto", padding: "6px 0", minHeight: 120 }}>
          {mode === "ai" && !run ? (
            <div style={{ padding: "28px 24px", textAlign: "center", fontSize: 13, color: "var(--ink-2)" }}>
              {scope.length === 0 ? (
                <span style={{ color: "var(--ink-3)" }}>No skills in scope.</span>
              ) : (
                <>
                  <div style={{ marginBottom: 12, color: "var(--ink-3)", fontSize: 12.5 }}>
                    Sends {scope.length} skill{scope.length === 1 ? "" : "s"} to Claude via your local Claude Code CLI
                    ({status.data?.model ?? "sonnet"}) in {batchCount} batch{batchCount === 1 ? "" : "es"}.
                    This uses your Claude subscription.
                  </div>
                  <Button kind="primary" size="sm" onClick={startAi}>
                    Suggest tags with Claude
                  </Button>
                </>
              )}
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", fontSize: 13, color: "var(--ink-3)" }}>
              {running
                ? "Waiting for the first batch…"
                : mode === "ai"
                  ? "No changes suggested."
                  : `No confident suggestions${onlyUntagged && !selected.length ? " for untagged skills" : ""}.`}
            </div>
          ) : (
            rows.map((r) => (
              <div
                key={r.skill}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 22px",
                  borderBottom: "0.5px solid var(--border)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 12.5,
                      color: "var(--ink)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {r.skill}
                  </div>
                  {r.reason && (
                    <div
                      style={{
                        fontSize: 11.5,
                        color: r.fallback ? "var(--warn)" : "var(--ink-3)",
                        marginTop: 2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={r.reason}
                    >
                      {r.reason}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap", justifyContent: "flex-end", maxWidth: "55%" }}>
                  {r.add.map((t) => chip(r, "add", t))}
                  {r.remove.map((t) => chip(r, "remove", t))}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 22px",
            borderTop: "0.5px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            {acceptedCount} change{acceptedCount === 1 ? "" : "s"} across {rows.length} skill
            {rows.length === 1 ? "" : "s"}
          </span>
          <span style={{ flex: 1 }} />
          {running ? (
            <Button kind="ghost" size="sm" onClick={stopAi}>
              Stop
            </Button>
          ) : mode === "ai" && run ? (
            <Button kind="ghost" size="sm" onClick={startAi} disabled={applying}>
              Re-run
            </Button>
          ) : null}
          <Button kind="ghost" size="sm" onClick={() => { cancelRun(); onClose(); }} disabled={applying}>
            Cancel
          </Button>
          <Button
            kind="primary"
            size="sm"
            onClick={apply}
            disabled={applying || running || acceptedCount === 0}
          >
            {applying ? "Applying…" : "Apply tags"}
          </Button>
        </div>
      </div>
    </div>
  );
}
