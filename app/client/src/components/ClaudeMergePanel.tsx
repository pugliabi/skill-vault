import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { toggleDecision } from "../lib/mergeToggle";
import { Button } from "./ui/primitives";
import { DiffBody } from "./DiffDrawer";
import type { MergeDecision, MergeResult, NotionConflict } from "../lib/types";

type View = "merged" | "vs-vault" | "vs-notion";

/**
 * Claude's merge of a Notion conflict, for review before anything is
 * written: what changed on each side, Claude's decisions (overlapping ones
 * can be flipped to either side), the merged files (read-only, or edited
 * by hand), per-file diffs against either side, and a side pick for any
 * binary / oversized file Claude couldn't merge. Apply sends the result as
 * a "files" resolution (flagged `edited` when the user flipped a decision
 * or edited by hand); Discard drops it.
 *
 * `manual`: no Claude result — `result` holds the vault copy of each
 * differing text file, every file opens in the editor, and Apply is always
 * a hand edit.
 */
export function ClaudeMergePanel({
  result: initial,
  conflict,
  applying,
  manual = false,
  onApply,
  onDiscard,
}: {
  result: MergeResult;
  conflict: NotionConflict;
  applying: boolean;
  manual?: boolean;
  onApply: (
    files: Array<{ path: string; content: string | null }>,
    binaryChoices: Record<string, "vault" | "notion">,
    edited: boolean,
  ) => void;
  onDiscard: () => void;
}) {
  const [result, setResult] = useState<MergeResult>(initial);
  /** Hand edits per file; a file with an entry is shown in a textarea. */
  const [edits, setEdits] = useState<Record<string, string>>(() =>
    manual ? Object.fromEntries(initial.files.map((f) => [f.path, f.content])) : {},
  );
  const [activeFile, setActiveFile] = useState<string>(initial.files[0]?.path ?? "");
  const [view, setView] = useState<View>("merged");

  const pickSideFiles = useMemo(
    () => conflict.files.filter((f) => !f.same && (f.binary || f.too_large)),
    [conflict],
  );
  const [binaryChoices, setBinaryChoices] = useState<Record<string, "vault" | "notion">>(() =>
    Object.fromEntries(pickSideFiles.map((f) => [f.path, "vault" as const])),
  );

  /** Files that exist on only one side: the user may drop them (sent as content null). */
  const oneSided = useMemo(
    () =>
      new Set(
        conflict.files
          .filter((f) => !f.same && !f.binary && !f.too_large && (f.vault === null) !== (f.notion === null))
          .map((f) => f.path),
      ),
    [conflict],
  );
  const [removed, setRemoved] = useState<Record<string, boolean>>({});

  const contentOf = (p: string) => edits[p] ?? result.files.find((f) => f.path === p)?.content ?? "";
  const side = conflict.files.find((f) => f.path === activeFile);
  const active = activeFile ? contentOf(activeFile) : "";
  const editing = activeFile in edits;

  const compareTo = view === "vs-vault" ? side?.vault ?? "" : view === "vs-notion" ? side?.notion ?? "" : null;
  const diff = useQuery({
    queryKey: ["merge-diff", activeFile, view, compareTo, active],
    queryFn: () => api.diffText(compareTo ?? "", active),
    enabled: compareTo !== null && !!activeFile,
    staleTime: Infinity,
  });

  const toggle = (d: MergeDecision, to: "vault" | "notion") => {
    setResult((r) => toggleDecision(r, d.id, to));
  };

  // A one-sided file Claude returned empty is never written as an empty
  // file by default: the user must tick "Remove this file" or edit it.
  const emptyUndecided = result.files
    .map((f) => f.path)
    .filter((p) => oneSided.has(p) && !removed[p] && contentOf(p) === "");

  // `edited` reflects whether the final result actually differs from
  // Claude's proposal — not merely whether "Edit manually" was opened or a
  // toggle was flipped and flipped back — by comparing final per-file
  // content (accounting for removals) and each decision's chosen side
  // against the original merge result.
  const filesChanged = result.files.some((f) => {
    const finalContent = removed[f.path] ? null : contentOf(f.path);
    const originalContent = initial.files.find((i) => i.path === f.path)?.content ?? null;
    return finalContent !== originalContent;
  });
  const decisionsChanged = result.decisions.some((d) => {
    const orig = initial.decisions.find((od) => od.id === d.id);
    return !!orig && d.chosen !== orig.chosen;
  });
  const edited = manual || filesChanged || decisionsChanged;
  const apply = () =>
    onApply(
      result.files.map((f) => ({ path: f.path, content: removed[f.path] ? null : contentOf(f.path) })),
      binaryChoices,
      edited,
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "14px 18px" }}>
      {manual && (
        <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)" }}>
          Edit the vault copy of each differing file by hand (compare it with Notion&apos;s using &quot;vs Notion&quot;),
          then Apply — the result is saved in the vault and pushed to Notion.
        </p>
      )}

      {/* What changed */}
      {!manual && (
      <section>
        <SectionTitle>What changed</SectionTitle>
        <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--ink)" }}>{result.explanation}</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <ChangeList label="In the vault" items={result.vault_changes} />
          <ChangeList label="In Notion" items={result.notion_changes} />
        </div>
      </section>
      )}

      {result.warnings.length > 0 && (
        <div
          role="alert"
          style={{
            fontSize: 12,
            color: "var(--ink)",
            border: "0.5px solid var(--warn)",
            background: "color-mix(in oklab, var(--warn) 10%, transparent)",
            borderRadius: 6,
            padding: "8px 10px",
          }}
        >
          {result.warnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      )}

      {/* Decisions */}
      {!manual && (
      <section>
        <SectionTitle>Claude&apos;s decisions</SectionTitle>
        {result.decisions.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>No individual decisions reported.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {result.decisions.map((d) => {
              const lockedByEdit = d.file in edits;
              return (
                <div
                  key={d.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "7px 10px",
                    borderRadius: 6,
                    border: `0.5px solid ${d.overlapping ? "var(--warn)" : "var(--border)"}`,
                    background: d.overlapping ? "color-mix(in oklab, var(--warn) 8%, transparent)" : "var(--surface)",
                    fontSize: 12.5,
                  }}
                >
                  <SideBadge side={d.chosen} />
                  <span style={{ flex: 1, color: "var(--ink)" }}>
                    {d.summary}
                    <span style={{ marginLeft: 6, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-3)" }}>
                      {d.file}
                    </span>
                  </span>
                  {d.overlapping && d.toggleable !== false && (
                    <span style={{ display: "inline-flex", gap: 4 }} title={lockedByEdit ? "This file is being edited by hand" : undefined}>
                      <Button
                        size="sm"
                        kind={d.chosen === "vault" ? "primary" : "default"}
                        disabled={lockedByEdit || d.chosen === "vault"}
                        onClick={() => toggle(d, "vault")}
                      >
                        Use vault version
                      </Button>
                      <Button
                        size="sm"
                        kind={d.chosen === "notion" ? "primary" : "default"}
                        disabled={lockedByEdit || d.chosen === "notion"}
                        onClick={() => toggle(d, "notion")}
                      >
                        Use Notion version
                      </Button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
      )}

      {/* Merged files */}
      <section style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <SectionTitle>{manual ? "Files" : "Merged files"}</SectionTitle>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
          {result.files.map((f) => (
            <button
              key={f.path}
              onClick={() => setActiveFile(f.path)}
              aria-current={f.path === activeFile ? "true" : undefined}
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                padding: "3px 8px",
                borderRadius: 4,
                cursor: "pointer",
                color: "var(--ink)",
                border: `0.5px solid ${f.path === activeFile ? "var(--accent)" : "var(--border-2)"}`,
                background: f.path === activeFile ? "var(--surface-2)" : "var(--surface)",
              }}
            >
              {f.path}
              {f.path in edits ? " ✎" : ""}
              {removed[f.path] ? " (removed)" : ""}
            </button>
          ))}
        </div>
        {activeFile && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              {(["merged", "vs-vault", "vs-notion"] as const).map((v) => (
                <Button key={v} size="sm" kind={view === v ? "primary" : "default"} onClick={() => setView(v)}>
                  {v === "merged" ? (manual ? "Edit" : "Merged") : v === "vs-vault" ? "vs vault" : "vs Notion"}
                </Button>
              ))}
              <span style={{ flex: 1 }} />
              {oneSided.has(activeFile) && (
                <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--ink-2)", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={!!removed[activeFile]}
                    onChange={(e) => setRemoved((r) => ({ ...r, [activeFile]: e.target.checked }))}
                    style={{ accentColor: "var(--accent)" }}
                  />
                  Remove this file
                  <span style={{ color: "var(--ink-4)" }}>
                    (only in {side?.vault === null ? "Notion" : "the vault"})
                  </span>
                </label>
              )}
              {editing ? (
                <Button
                  size="sm"
                  kind="ghost"
                  onClick={() =>
                    setEdits((e) => {
                      const { [activeFile]: _drop, ...rest } = e;
                      return rest;
                    })
                  }
                >
                  Discard hand edits
                </Button>
              ) : (
                <Button size="sm" onClick={() => setEdits((e) => ({ ...e, [activeFile]: active }))}>
                  Edit manually
                </Button>
              )}
            </div>
            {view === "merged" ? (
              editing ? (
                <textarea
                  value={active}
                  aria-label={`Merged content of ${activeFile}`}
                  onChange={(e) => setEdits((prev) => ({ ...prev, [activeFile]: e.target.value }))}
                  spellCheck={false}
                  style={{
                    width: "100%",
                    minHeight: 320,
                    resize: "vertical",
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: "var(--ink)",
                    background: "var(--bg)",
                    border: "0.5px solid var(--accent)",
                    borderRadius: 6,
                    padding: 10,
                    boxSizing: "border-box",
                  }}
                />
              ) : (
                <pre
                  className="sv-scroll"
                  style={{
                    margin: 0,
                    maxHeight: 420,
                    overflow: "auto",
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: "var(--ink-2)",
                    background: "var(--surface)",
                    border: "0.5px solid var(--border)",
                    borderRadius: 6,
                    padding: 10,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {active}
                </pre>
              )
            ) : (
              <div style={{ border: "0.5px solid var(--border)", borderRadius: 6, maxHeight: 420, overflow: "auto" }} className="sv-scroll">
                {diff.isLoading ? (
                  <div style={{ padding: 12, fontSize: 12, color: "var(--ink-3)" }}>Comparing…</div>
                ) : diff.isError ? (
                  <div style={{ padding: 12, fontSize: 12, color: "var(--bad)" }}>
                    {diff.error instanceof ApiError ? diff.error.message : "Couldn't compute the diff"}
                  </div>
                ) : diff.data && !diff.data.hunks ? (
                  <div style={{ padding: 12, fontSize: 12, color: "var(--ink-3)" }}>Too large to diff.</div>
                ) : diff.data?.hunks && diff.data.hunks.every((h) => h.type === "ctx") ? (
                  <div style={{ padding: 12, fontSize: 12, color: "var(--ink-3)" }}>
                    Identical to the {view === "vs-vault" ? "vault" : "Notion"} copy.
                  </div>
                ) : diff.data?.hunks ? (
                  <DiffBody
                    file={{
                      path: activeFile,
                      change: "modified",
                      hunks: diff.data.hunks,
                      vault_size: new Blob([compareTo ?? ""]).size,
                      target_size: new Blob([active]).size,
                    }}
                    labels={{ left: view === "vs-vault" ? "vault" : "notion", right: "merged" }}
                  />
                ) : null}
              </div>
            )}
          </>
        )}
      </section>

      {pickSideFiles.length > 0 && (
        <section>
          <SectionTitle>{manual ? "Binary / large files — pick a side" : "Files Claude can’t merge — pick a side"}</SectionTitle>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {pickSideFiles.map((f) => (
              <label key={f.path} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
                <code style={{ fontFamily: "var(--mono)", flex: 1 }}>
                  {f.path}{" "}
                  <span style={{ color: "var(--ink-3)" }}>({f.binary ? "binary" : "too large"})</span>
                </code>
                <select
                  value={binaryChoices[f.path] ?? "vault"}
                  onChange={(e) =>
                    setBinaryChoices((c) => ({ ...c, [f.path]: e.target.value as "vault" | "notion" }))
                  }
                  style={{
                    fontSize: 12,
                    color: "var(--ink)",
                    background: "var(--bg)",
                    border: "0.5px solid var(--border-2)",
                    borderRadius: 5,
                    height: 26,
                  }}
                >
                  <option value="vault">Keep vault copy</option>
                  <option value="notion">Keep Notion copy</option>
                </select>
              </label>
            ))}
          </div>
        </section>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
        {typeof result.cost_usd === "number" && (
          <span style={{ fontSize: 11, color: "var(--ink-4)", marginRight: "auto", fontFamily: "var(--mono)" }}>
            Claude cost ${result.cost_usd.toFixed(3)}
          </span>
        )}
        <Button kind="ghost" size="md" onClick={onDiscard} disabled={applying}>
          Discard
        </Button>
        {emptyUndecided.length > 0 && (
          <span role="alert" style={{ fontSize: 12, color: "var(--warn)" }}>
            {emptyUndecided.join(", ")} came back empty — tick &quot;Remove this file&quot; or edit it.
          </span>
        )}
        <Button kind="primary" size="md" onClick={apply} disabled={applying || emptyUndecided.length > 0}>
          {applying ? "Applying…" : "Apply"}
        </Button>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--ink-3)",
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

function ChangeList({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)", marginBottom: 4 }}>{label}</div>
      {items.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--ink-4)" }}>Nothing reported.</div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--ink-2)", display: "flex", flexDirection: "column", gap: 2 }}>
          {items.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SideBadge({ side }: { side: "vault" | "notion" | "both" }) {
  const color = side === "vault" ? "var(--accent)" : side === "notion" ? "var(--ok)" : "var(--ink-3)";
  return (
    <span
      style={{
        fontFamily: "var(--mono)",
        fontSize: 10,
        fontWeight: 600,
        color,
        border: `0.5px solid ${color}`,
        borderRadius: 4,
        padding: "1px 6px",
        whiteSpace: "nowrap",
      }}
    >
      {side === "both" ? "both" : side === "vault" ? "vault" : "Notion"}
    </span>
  );
}
