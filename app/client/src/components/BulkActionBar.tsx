import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./ui/icons";
import { Button } from "./ui/primitives";
import type { Skill } from "../lib/types";

/**
 * Bottom-pinned action bar for the multi-select flow on /skills.
 *
 * Mounts only when at least one skill is selected (the parent gates
 * us on `anySelected`). Push/Pull/Remove are simple callbacks the
 * parent wires to API mutations + Promise.allSettled.
 *
 * Tag is different: it owns its own popover with checkbox state per
 * tag (3-state: all selected have it / some have it / none have it),
 * computes `add` / `remove` deltas and hands them to `onApplyTags`.
 * Living inside this component keeps the popover anchoring trivial
 * and avoids leaking tag-state plumbing into Skills.tsx.
 */
export function BulkActionBar({
  count,
  selectedSkills,
  allTags,
  providers,
  onPush,
  onPull,
  onRemove,
  onPromote,
  onDemote,
  onAddProvider,
  onAddAllProviders,
  onCheckUpdates,
  onApplyTags,
  onZip,
  onExportOpenClaw,
  openclawAvailable,
  onPushNotion,
  onDeselect,
}: {
  count: number;
  selectedSkills: Skill[];
  allTags: string[];
  providers: { id: string; path: string }[];
  onPush: () => void;
  onPull: () => void;
  onRemove: () => void;
  onPromote: () => void | Promise<void>;
  onDemote: () => void | Promise<void>;
  onAddProvider: (providerId: string) => void | Promise<void>;
  /** Add every configured provider to the selected skills in one pass. */
  onAddAllProviders?: () => void | Promise<void>;
  /**
   * Check the selected skills against their adopted sources. Present only
   * when at least one selected skill has a recorded origin.
   */
  onCheckUpdates?: () => void;
  onApplyTags: (add: string[], remove: string[]) => void | Promise<void>;
  onZip: () => void | Promise<void>;
  /** Present only when the OpenClaw WSL gateway is detected (win32). */
  onExportOpenClaw?: () => void | Promise<void>;
  openclawAvailable?: boolean;
  /** Present only when Notion is connected and a data source is configured. */
  onPushNotion?: () => void;
  onDeselect: () => void;
}) {
  const guarded = (cb: () => void | Promise<void>) => () => {
    if (count === 0) return;
    cb();
  };

  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 70,
        background: "var(--surface)",
        borderTop: "0.5px solid var(--border-2)",
        padding: "12px 24px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        boxShadow: "0 -4px 16px rgba(0,0,0,0.08)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--ink)",
          marginRight: 8,
        }}
      >
        {count} selected
      </span>
      <Button
        kind="default"
        size="sm"
        icon={Icon.push}
        onClick={guarded(onPush)}
        disabled={count === 0}
      >
        Push
      </Button>
      <Button
        kind="default"
        size="sm"
        icon={Icon.pull}
        onClick={guarded(onPull)}
        disabled={count === 0}
      >
        Pull
      </Button>
      <Button
        kind="default"
        size="sm"
        icon={Icon.upload}
        onClick={guarded(onPromote)}
        disabled={count === 0}
      >
        Promote
      </Button>
      <Button
        kind="default"
        size="sm"
        icon={Icon.download}
        onClick={guarded(onDemote)}
        disabled={count === 0}
      >
        Demote
      </Button>
      <BulkProviderButton
        providers={providers}
        onAdd={onAddProvider}
        onAddAll={onAddAllProviders}
        disabled={count === 0}
      />
      {onCheckUpdates && (
        <Button
          kind="default"
          size="sm"
          icon={Icon.pull}
          onClick={guarded(onCheckUpdates)}
          disabled={count === 0}
          title="Check the selected skills against their adopted sources for upstream changes"
        >
          Check updates
        </Button>
      )}
      <BulkTagButton
        selectedSkills={selectedSkills}
        allTags={allTags}
        onApply={onApplyTags}
        disabled={count === 0}
      />
      <Button
        kind="default"
        size="sm"
        icon={Icon.archive}
        onClick={guarded(onZip)}
        disabled={count === 0}
      >
        Zip
      </Button>
      {openclawAvailable && onExportOpenClaw && (
        <Button
          kind="default"
          size="sm"
          icon={Icon.upload}
          onClick={guarded(onExportOpenClaw)}
          disabled={count === 0}
          title="Install selected skills into the OpenClaw agent (WSL)"
        >
          OpenClaw
        </Button>
      )}
      {onPushNotion && (
        <Button
          kind="default"
          size="sm"
          icon={Icon.sync}
          onClick={guarded(onPushNotion)}
          disabled={count === 0}
          title="Push the selected skills' vault changes to Notion (creates missing pages; skips skills changed in Notion)"
        >
          Push to Notion
        </Button>
      )}
      <Button
        kind="danger"
        size="sm"
        icon={Icon.trash}
        onClick={guarded(onRemove)}
        disabled={count === 0}
      >
        Remove
      </Button>
      <span style={{ flex: 1 }} />
      <Button kind="ghost" size="sm" icon={Icon.x} onClick={onDeselect}>
        Deselect
      </Button>
    </div>
  );
}

function BulkProviderButton({
  providers,
  onAdd,
  onAddAll,
  disabled,
}: {
  providers: { id: string; path: string }[];
  onAdd: (providerId: string) => void | Promise<void>;
  onAddAll?: () => void | Promise<void>;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handlePick = async (id: string) => {
    if (busy) return;
    setBusy(id);
    try {
      await onAdd(id);
      setOpen(false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <Button
        kind="default"
        size="sm"
        icon={Icon.folder}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
      >
        Add to provider
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="Add provider"
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            left: 0,
            zIndex: 90,
            width: 220,
            background: "var(--bg)",
            border: "0.5px solid var(--border-2)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.16)",
            display: "flex",
            flexDirection: "column",
            maxHeight: 320,
          }}
        >
          <div
            style={{
              padding: "10px 12px 8px",
              borderBottom: "0.5px solid var(--border)",
            }}
          >
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: 10.5,
                fontWeight: 600,
                color: "var(--ink-3)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              Providers
            </span>
          </div>
          <div
            className="sv-scroll"
            style={{ flex: 1, overflowY: "auto", padding: "6px 8px" }}
          >
            {onAddAll && providers.length > 1 && (
              <button
                onClick={async () => {
                  if (busy) return;
                  setBusy("__all__");
                  try {
                    await onAddAll();
                    setOpen(false);
                  } finally {
                    setBusy(null);
                  }
                }}
                disabled={busy !== null}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "6px 6px",
                  marginBottom: 4,
                  border: 0,
                  borderBottom: "0.5px solid var(--border)",
                  background: "transparent",
                  cursor: busy !== null ? "not-allowed" : "pointer",
                  borderRadius: 4,
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--accent)",
                  textAlign: "left",
                }}
              >
                <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                  ★ All providers ({providers.length})
                </span>
                {busy === "__all__" && (
                  <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--ink-3)" }}>
                    adding…
                  </span>
                )}
              </button>
            )}
            {providers.length === 0 ? (
              <div
                style={{ padding: "8px 6px", fontSize: 12, color: "var(--ink-3)" }}
              >
                No providers configured.
              </div>
            ) : (
              providers.map((p) => (
                <button
                  key={p.id}
                  onClick={() => handlePick(p.id)}
                  disabled={busy !== null}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    padding: "6px 6px",
                    border: 0,
                    background: "transparent",
                    cursor: busy !== null ? "not-allowed" : "pointer",
                    borderRadius: 4,
                    fontSize: 12,
                    color: "var(--ink)",
                    textAlign: "left",
                    opacity: busy !== null && busy !== p.id ? 0.5 : 1,
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = "var(--surface)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "transparent")
                  }
                >
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                    {p.id}
                  </span>
                  {busy === p.id && (
                    <span
                      style={{
                        marginLeft: "auto",
                        fontSize: 10.5,
                        color: "var(--ink-3)",
                      }}
                    >
                      adding…
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tag popover ───────────────────────────────────────────────────

type TagState = "all" | "some" | "none";

function originalState(tag: string, skills: Skill[]): TagState {
  if (skills.length === 0) return "none";
  let count = 0;
  for (const s of skills) if (s.tags.includes(tag)) count++;
  if (count === 0) return "none";
  if (count === skills.length) return "all";
  return "some";
}

function BulkTagButton({
  selectedSkills,
  allTags,
  onApply,
  disabled,
}: {
  selectedSkills: Skill[];
  allTags: string[];
  onApply: (add: string[], remove: string[]) => void | Promise<void>;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <Button
        kind="default"
        size="sm"
        icon={Icon.tag}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
      >
        Tag
      </Button>
      {open && (
        <BulkTagPopover
          selectedSkills={selectedSkills}
          allTags={allTags}
          onClose={() => setOpen(false)}
          onApply={async (add, remove) => {
            await onApply(add, remove);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function BulkTagPopover({
  selectedSkills,
  allTags,
  onClose,
  onApply,
}: {
  selectedSkills: Skill[];
  allTags: string[];
  onClose: () => void;
  onApply: (add: string[], remove: string[]) => void | Promise<void>;
}) {
  // Override map: tag → user-chosen final state. Absent → leave at original.
  const [overrides, setOverrides] = useState<Record<string, TagState>>({});
  const [newTagInput, setNewTagInput] = useState("");
  // Tags the user typed in but hasn't applied yet — original = "none".
  const [createdTags, setCreatedTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // Tags rendered in the list = union of all tags in vault + tags
  // the user just created in this popover.
  const tags = useMemo(() => {
    const set = new Set<string>(allTags);
    for (const t of createdTags) set.add(t);
    return [...set].sort();
  }, [allTags, createdTags]);

  const stateFor = (tag: string): TagState => {
    if (overrides[tag]) return overrides[tag];
    if (createdTags.includes(tag)) return "none";
    return originalState(tag, selectedSkills);
  };

  const cycle = (tag: string) => {
    const orig = createdTags.includes(tag)
      ? "none"
      : originalState(tag, selectedSkills);
    const cur = stateFor(tag);
    // Click "all" → "none". Click anything else → "all".
    const next: TagState = cur === "all" ? "none" : "all";
    setOverrides((prev) => {
      const copy = { ...prev };
      if (next === orig) delete copy[tag];
      else copy[tag] = next;
      return copy;
    });
  };

  const tryAddNew = () => {
    const raw = newTagInput.trim().toLowerCase();
    if (!raw) return;
    if (/\s/.test(raw)) return;
    setNewTagInput("");
    if (allTags.includes(raw) || createdTags.includes(raw)) {
      // Already exists — just flip its override to "all".
      setOverrides((prev) => ({ ...prev, [raw]: "all" }));
      return;
    }
    setCreatedTags((prev) => [...prev, raw]);
    setOverrides((prev) => ({ ...prev, [raw]: "all" }));
  };

  const { addList, removeList } = useMemo(() => {
    const add: string[] = [];
    const remove: string[] = [];
    for (const tag of tags) {
      const orig = createdTags.includes(tag)
        ? "none"
        : originalState(tag, selectedSkills);
      const final = stateFor(tag);
      if (final === orig) continue;
      if (final === "all") add.push(tag);
      else if (final === "none") remove.push(tag);
    }
    return { addList: add, removeList: remove };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tags, overrides, createdTags, selectedSkills]);

  const dirty = addList.length > 0 || removeList.length > 0;

  const handleApply = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    try {
      await onApply(addList, removeList);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Edit tags"
      style={{
        position: "absolute",
        bottom: "calc(100% + 8px)",
        left: 0,
        zIndex: 90,
        width: 260,
        background: "var(--bg)",
        border: "0.5px solid var(--border-2)",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.16)",
        display: "flex",
        flexDirection: "column",
        maxHeight: 360,
      }}
    >
      <div
        style={{
          padding: "10px 12px 8px",
          borderBottom: "0.5px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10.5,
            fontWeight: 600,
            color: "var(--ink-3)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          Tags · {selectedSkills.length} skill{selectedSkills.length === 1 ? "" : "s"}
        </span>
      </div>

      <div
        className="sv-scroll"
        style={{ flex: 1, overflowY: "auto", padding: "6px 8px" }}
      >
        {tags.length === 0 ? (
          <div style={{ padding: "8px 6px", fontSize: 12, color: "var(--ink-3)" }}>
            No tags yet. Add one below.
          </div>
        ) : (
          tags.map((tag) => {
            const s = stateFor(tag);
            return (
              <label
                key={tag}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "5px 6px",
                  cursor: "pointer",
                  borderRadius: 4,
                  fontSize: 12,
                  color: "var(--ink)",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "var(--surface)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "transparent")
                }
              >
                <input
                  type="checkbox"
                  checked={s === "all"}
                  ref={(el) => {
                    if (el) el.indeterminate = s === "some";
                  }}
                  onChange={() => cycle(tag)}
                  style={{ accentColor: "var(--accent)" }}
                />
                <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{tag}</span>
              </label>
            );
          })
        )}
      </div>

      <div
        style={{
          borderTop: "0.5px solid var(--border)",
          padding: "8px 10px",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <input
          value={newTagInput}
          onChange={(e) => setNewTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              tryAddNew();
            } else if (e.key === "Escape") {
              setNewTagInput("");
            }
          }}
          placeholder="new tag…"
          style={{
            flex: 1,
            height: 24,
            fontSize: 12,
            fontFamily: "var(--mono)",
            padding: "0 6px",
            border: "0.5px solid var(--border-2)",
            borderRadius: 4,
            background: "var(--surface)",
            color: "var(--ink)",
            outline: 0,
          }}
        />
        <button
          onClick={tryAddNew}
          disabled={!newTagInput.trim()}
          style={{
            height: 24,
            padding: "0 8px",
            border: "0.5px solid var(--border-2)",
            background: "var(--surface)",
            borderRadius: 4,
            fontSize: 11,
            fontFamily: "var(--mono)",
            color: "var(--ink-2)",
            cursor: newTagInput.trim() ? "pointer" : "not-allowed",
            opacity: newTagInput.trim() ? 1 : 0.5,
          }}
        >
          Add
        </button>
      </div>

      <div
        style={{
          borderTop: "0.5px solid var(--border)",
          padding: "8px 10px",
          display: "flex",
          alignItems: "center",
          gap: 6,
          justifyContent: "flex-end",
        }}
      >
        <Button kind="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          kind="primary"
          size="sm"
          onClick={handleApply}
          disabled={!dirty || busy}
        >
          {busy
            ? "Applying…"
            : dirty
              ? `Apply (${addList.length}+ ${removeList.length}-)`
              : "Apply"}
        </Button>
      </div>
    </div>
  );
}
