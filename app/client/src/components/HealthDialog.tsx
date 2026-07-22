import { useMemo, useState } from "react";
import { findCollisions } from "../lib/collisions";
import { scoreSkill, gradeColor } from "../lib/skillQuality";
import type { Skill } from "../lib/types";

/**
 * Vault health board: trigger collisions (near-duplicate descriptions that
 * make the agent fire the wrong skill) + low-quality skills (weak/missing
 * descriptions that won't trigger at all). Both are computed client-side
 * from lib/collisions + lib/skillQuality. Clicking any skill opens it.
 */
export function HealthDialog({
  skills,
  onOpen,
  onClose,
}: {
  skills: Skill[];
  onOpen: (name: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"collisions" | "quality">("collisions");

  const collisions = useMemo(() => findCollisions(skills), [skills]);
  const lowQuality = useMemo(
    () =>
      skills
        .map((s) => ({ s, q: scoreSkill(s) }))
        .filter((x) => x.q.score < 75)
        .sort((a, b) => a.q.score - b.q.score),
    [skills],
  );

  const open = (name: string) => {
    onOpen(name);
    onClose();
  };

  const tabBtn = (id: typeof tab, label: string, count: number): React.CSSProperties => ({
    padding: "6px 12px",
    fontSize: 12.5,
    fontWeight: tab === id ? 600 : 400,
    color: tab === id ? "var(--ink)" : "var(--ink-3)",
    background: tab === id ? "var(--surface-2)" : "transparent",
    border: "0.5px solid var(--border-2)",
    borderRadius: 6,
    cursor: "pointer",
    display: "inline-flex",
    gap: 6,
    alignItems: "center",
  });

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
          width: 620,
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 12px 40px oklch(0.1 0.01 60 / 0.3)",
        }}
      >
        <div style={{ padding: "16px 20px 12px", borderBottom: "0.5px solid var(--border)" }}>
          <h3 style={{ margin: "0 0 10px", fontSize: 15, fontWeight: 600, color: "var(--ink)" }}>
            Vault health
          </h3>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={tabBtn("collisions", "Collisions", collisions.length)} onClick={() => setTab("collisions")}>
              Trigger collisions
              <Badge n={collisions.length} bad={collisions.length > 0} />
            </button>
            <button style={tabBtn("quality", "Quality", lowQuality.length)} onClick={() => setTab("quality")}>
              Needs work
              <Badge n={lowQuality.length} bad={lowQuality.length > 0} />
            </button>
          </div>
        </div>

        <div className="sv-scroll" style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
          {tab === "collisions" ? (
            collisions.length === 0 ? (
              <Empty text="No near-duplicate descriptions found." />
            ) : (
              collisions.map((c) => (
                <div
                  key={`${c.a}\0${c.b}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "9px 20px",
                    borderBottom: "0.5px solid var(--border)",
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 10.5,
                      fontWeight: 600,
                      color: c.similarity > 0.75 ? "var(--bad)" : "var(--warn)",
                      width: 40,
                    }}
                  >
                    {Math.round(c.similarity * 100)}%
                  </span>
                  <button onClick={() => open(c.a)} style={linkStyle}>{c.a}</button>
                  <span style={{ color: "var(--ink-4)", fontSize: 12 }}>↔</span>
                  <button onClick={() => open(c.b)} style={linkStyle}>{c.b}</button>
                </div>
              ))
            )
          ) : lowQuality.length === 0 ? (
            <Empty text="Every skill scores well. Nice." />
          ) : (
            lowQuality.map(({ s, q }) => (
              <button
                key={s.name}
                onClick={() => open(s.name)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  width: "100%",
                  padding: "9px 20px",
                  borderBottom: "0.5px solid var(--border)",
                  background: "transparent",
                  border: 0,
                  borderBottomColor: "var(--border)",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                    fontWeight: 700,
                    color: gradeColor(q.grade),
                    width: 18,
                  }}
                >
                  {q.grade}
                </span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--ink)", width: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.name}
                </span>
                <span style={{ flex: 1, fontSize: 11.5, color: "var(--ink-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {q.issues[0] ?? ""}
                  {q.issues.length > 1 ? ` · +${q.issues.length - 1} more` : ""}
                </span>
              </button>
            ))
          )}
        </div>

        <div style={{ padding: "10px 20px", borderTop: "0.5px solid var(--border)", display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{ fontSize: 12.5, padding: "5px 12px", border: "0.5px solid var(--border-2)", background: "var(--surface)", borderRadius: 6, cursor: "pointer", color: "var(--ink-2)" }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

const linkStyle: React.CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 12.5,
  color: "var(--accent)",
  background: "transparent",
  border: 0,
  cursor: "pointer",
  padding: 0,
};

function Badge({ n, bad }: { n: number; bad: boolean }) {
  return (
    <span
      style={{
        fontFamily: "var(--mono)",
        fontSize: 10,
        fontWeight: 600,
        color: bad ? "var(--bad)" : "var(--ink-3)",
        background: bad ? "color-mix(in oklab, var(--bad) 14%, transparent)" : "var(--surface)",
        borderRadius: 4,
        padding: "1px 5px",
      }}
    >
      {n}
    </span>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ padding: 28, textAlign: "center", fontSize: 13, color: "var(--ink-3)" }}>
      {text}
    </div>
  );
}
