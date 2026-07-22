import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { buildSuggestions } from "../lib/autoTag";
import { Button } from "./ui/primitives";
import type { Skill } from "../lib/types";

/**
 * Review-and-apply dialog for heuristic auto-tagging. Suggestions come
 * from lib/autoTag (name + description keyword match); the user unchecks
 * anything wrong, then Apply groups accepted (skill, tag) pairs by tag and
 * calls the existing bulkTag endpoint once per tag.
 */
export function AutoTagDialog({
  skills,
  onClose,
}: {
  skills: Skill[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [onlyUntagged, setOnlyUntagged] = useState(true);
  const [applying, setApplying] = useState(false);

  const rows = useMemo(
    () => buildSuggestions(skills, { onlyUntagged }),
    [skills, onlyUntagged],
  );

  // Accepted (skill, tag) pairs, keyed "skill\0tag". Default: accept all.
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const key = (skill: string, tag: string) => `${skill}\0${tag}`;

  const toggle = (skill: string, tag: string) => {
    const k = key(skill, tag);
    setRejected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const accepted = useMemo(() => {
    const byTag = new Map<string, string[]>();
    for (const r of rows) {
      for (const tag of r.suggested) {
        if (rejected.has(key(r.skill, tag))) continue;
        const arr = byTag.get(tag) ?? [];
        arr.push(r.skill);
        byTag.set(tag, arr);
      }
    }
    return byTag;
  }, [rows, rejected]);

  const acceptedPairCount = useMemo(
    () => [...accepted.values()].reduce((n, arr) => n + arr.length, 0),
    [accepted],
  );

  const apply = async () => {
    if (accepted.size === 0) return;
    setApplying(true);
    try {
      const results = await Promise.allSettled(
        [...accepted].map(([tag, skillNames]) =>
          api.bulkTag({ skills: skillNames, add: [tag] }),
        ),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const affected = new Set<string>();
      for (const arr of accepted.values()) for (const s of arr) affected.add(s);
      if (failed === 0) {
        toast.success(
          `Tagged ${affected.size} skill${affected.size === 1 ? "" : "s"} · ${accepted.size} tag${accepted.size === 1 ? "" : "s"}`,
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
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "var(--bg)",
          border: "0.5px solid var(--border-2)",
          borderRadius: 10,
          width: 560,
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 12px 40px oklch(0.1 0.01 60 / 0.3)",
        }}
      >
        {/* Header */}
        <div style={{ padding: "18px 22px 12px", borderBottom: "0.5px solid var(--border)" }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--ink)" }}>
            Auto-tag skills
          </h3>
          <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--ink-2)" }}>
            Suggested from each skill's name and description. Uncheck anything
            wrong, then apply.
          </p>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              marginTop: 10,
              fontSize: 12,
              color: "var(--ink-2)",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={onlyUntagged}
              onChange={(e) => setOnlyUntagged(e.target.checked)}
              style={{ accentColor: "var(--accent)" }}
            />
            Only untagged skills
          </label>
        </div>

        {/* Body */}
        <div className="sv-scroll" style={{ flex: 1, overflowY: "auto", padding: "6px 0" }}>
          {rows.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", fontSize: 13, color: "var(--ink-3)" }}>
              No confident suggestions{onlyUntagged ? " for untagged skills" : ""}.
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
                <span
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 12.5,
                    color: "var(--ink)",
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.skill}
                </span>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  {r.suggested.map((tag) => {
                    const off = rejected.has(key(r.skill, tag));
                    return (
                      <button
                        key={tag}
                        onClick={() => toggle(r.skill, tag)}
                        style={{
                          fontFamily: "var(--mono)",
                          fontSize: 11,
                          fontWeight: 500,
                          padding: "2px 8px",
                          borderRadius: 4,
                          cursor: "pointer",
                          border: `0.5px solid ${off ? "var(--border-2)" : "var(--accent)"}`,
                          background: off ? "transparent" : "color-mix(in oklab, var(--accent) 12%, transparent)",
                          color: off ? "var(--ink-4)" : "var(--accent)",
                          textDecoration: off ? "line-through" : "none",
                        }}
                        title={off ? "Click to include" : "Click to exclude"}
                      >
                        {tag}
                      </button>
                    );
                  })}
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
            {acceptedPairCount} tag assignment{acceptedPairCount === 1 ? "" : "s"} across{" "}
            {rows.length} skill{rows.length === 1 ? "" : "s"}
          </span>
          <span style={{ flex: 1 }} />
          <Button kind="ghost" size="sm" onClick={onClose} disabled={applying}>
            Cancel
          </Button>
          <Button
            kind="primary"
            size="sm"
            onClick={apply}
            disabled={applying || acceptedPairCount === 0}
          >
            {applying ? "Applying…" : "Apply tags"}
          </Button>
        </div>
      </div>
    </div>
  );
}
