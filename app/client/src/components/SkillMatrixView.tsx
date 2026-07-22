import { useMemo } from "react";
import type { Skill, TargetStatus } from "../lib/types";

/**
 * Coverage matrix — skills as rows, providers as columns, each cell a
 * status dot derived from `skill.target_status[provider]`.
 *
 * The point of this view is the 19/227 sync gap: at a glance you see which
 * skills are missing/stale where, and you can act on a whole column
 * ("push everything missing to Cursor") or a single cell without leaving
 * the page. All data comes from `target_status`, already on every skill.
 */

type Cell = TargetStatus | "untargeted";

const CELL_META: Record<Cell, { dot: string; fill: boolean; title: string; actionable: boolean }> = {
  synced:     { dot: "var(--ok)",      fill: true,  title: "synced",              actionable: false },
  stale:      { dot: "var(--warn)",    fill: true,  title: "stale — click to re-push", actionable: true },
  missing:    { dot: "var(--bad)",     fill: true,  title: "missing — click to push",  actionable: true },
  error:      { dot: "var(--bad)",     fill: false, title: "error",               actionable: false },
  untargeted: { dot: "var(--border-2)", fill: false, title: "not a target",        actionable: false },
};

function cellFor(s: Skill, provider: string): Cell {
  const st = s.target_status[provider];
  if (!st) return s.targets.includes(provider) ? "missing" : "untargeted";
  return st;
}

export function SkillMatrixView({
  skills,
  providers,
  activeName,
  onOpen,
  onCellPush,
  onColumnPush,
}: {
  skills: Skill[];
  providers: string[];
  activeName?: string;
  onOpen: (name: string) => void;
  /** Push one skill to one provider (fired on an actionable cell click). */
  onCellPush: (skill: string, provider: string) => void;
  /** Push every missing/stale skill in a column to that provider. */
  onColumnPush: (provider: string) => void;
}) {
  // Count missing/stale per provider for the column header badge.
  const colCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of providers) {
      let n = 0;
      for (const s of skills) {
        const c = cellFor(s, p);
        if (c === "missing" || c === "stale") n++;
      }
      m[p] = n;
    }
    return m;
  }, [skills, providers]);

  const nameColW = 240;
  const colW = 92;

  return (
    <div className="sv-scroll" style={{ overflow: "auto", height: "100%" }}>
      <div style={{ minWidth: nameColW + providers.length * colW, paddingBottom: 40 }}>
        {/* Header row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `${nameColW}px repeat(${providers.length}, ${colW}px)`,
            position: "sticky",
            top: 0,
            zIndex: 2,
            background: "var(--bg)",
            borderBottom: "0.5px solid var(--border)",
          }}
        >
          <div
            style={{
              padding: "10px 22px",
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              fontWeight: 600,
              color: "var(--ink-3)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              position: "sticky",
              left: 0,
              background: "var(--bg)",
            }}
          >
            Skill
          </div>
          {providers.map((p) => {
            const n = colCounts[p] ?? 0;
            return (
              <button
                key={p}
                onClick={() => onColumnPush(p)}
                disabled={n === 0}
                title={n > 0 ? `Push ${n} missing/stale to ${p}` : `${p} — all in sync`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 3,
                  padding: "8px 4px",
                  border: 0,
                  borderLeft: "0.5px solid var(--border)",
                  background: "transparent",
                  cursor: n > 0 ? "pointer" : "default",
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--ink)",
                  }}
                >
                  {p}
                </span>
                <span
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 10,
                    color: n > 0 ? "var(--bad)" : "var(--ink-4)",
                  }}
                >
                  {n > 0 ? `↑ ${n}` : "✓"}
                </span>
              </button>
            );
          })}
        </div>

        {/* Body rows */}
        {skills.map((s) => (
          <div
            key={s.name}
            style={{
              display: "grid",
              gridTemplateColumns: `${nameColW}px repeat(${providers.length}, ${colW}px)`,
              borderBottom: "0.5px solid var(--border)",
              background: activeName === s.name ? "var(--surface-2)" : "transparent",
            }}
          >
            <div
              onClick={() => onOpen(s.name)}
              title={s.description || s.name}
              style={{
                padding: "9px 22px",
                minWidth: 0,
                position: "sticky",
                left: 0,
                background: activeName === s.name ? "var(--surface-2)" : "var(--bg)",
                cursor: "pointer",
                fontFamily: "var(--mono)",
                fontSize: 12.5,
                color: "var(--ink)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                borderRight: "0.5px solid var(--border)",
              }}
            >
              {s.name}
            </div>
            {providers.map((p) => {
              const cell = cellFor(s, p);
              const meta = CELL_META[cell];
              return (
                <button
                  key={p}
                  onClick={() => meta.actionable && onCellPush(s.name, p)}
                  disabled={!meta.actionable}
                  title={`${s.name} · ${p}: ${meta.title}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: 0,
                    borderLeft: "0.5px solid var(--border)",
                    background: "transparent",
                    cursor: meta.actionable ? "pointer" : "default",
                    padding: 0,
                    height: "100%",
                  }}
                >
                  <span
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: "50%",
                      background: meta.fill ? meta.dot : "transparent",
                      border: meta.fill ? "none" : `1px solid ${meta.dot}`,
                    }}
                  />
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
