import { useEffect, useRef, useState } from "react";
import { Icon } from "./ui/icons";
import type { ActiveFilters } from "../lib/preferences";

export type { ActiveFilters } from "../lib/preferences";

export function FilterBar({
  providers,
  allTags,
  filters,
  onChange,
}: {
  providers: string[];
  allTags: string[];
  filters: ActiveFilters;
  onChange: (filters: ActiveFilters) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const chips: Array<{ key: string; label: string; remove: () => void }> = [];
  if (filters.providers) {
    for (const p of filters.providers) {
      chips.push({
        key: `p:${p}`,
        label: `provider: ${p}`,
        remove: () => {
          const next = filters.providers!.filter((x) => x !== p);
          onChange({ ...filters, providers: next.length > 0 ? next : undefined });
        },
      });
    }
  }
  if (filters.tags) {
    for (const t of filters.tags) {
      chips.push({
        key: `t:${t}`,
        label: `tag: ${t}`,
        remove: () => {
          const next = filters.tags!.filter((x) => x !== t);
          onChange({ ...filters, tags: next.length > 0 ? next : undefined });
        },
      });
    }
  }
  if (filters.hasSkillMd) {
    chips.push({
      key: "skill-md",
      label: "has SKILL.md",
      remove: () => onChange({ ...filters, hasSkillMd: undefined }),
    });
  }
  if (filters.minFiles != null) {
    chips.push({
      key: "minFiles",
      label: `> ${filters.minFiles} files`,
      remove: () => onChange({ ...filters, minFiles: undefined }),
    });
  }

  const hasAny = chips.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {/* + Filter button */}
        <div ref={ref} style={{ position: "relative" }}>
          <button
            onClick={() => setOpen(!open)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              height: 26,
              padding: "0 10px",
              fontSize: 12,
              fontWeight: 500,
              fontFamily: "var(--sans)",
              color: hasAny ? "var(--accent)" : "var(--ink-3)",
              background: hasAny ? "var(--accent-bg, var(--surface))" : "var(--surface)",
              border: `0.5px solid ${hasAny ? "var(--accent)" : "var(--border-2)"}`,
              borderRadius: 5,
              cursor: "pointer",
            }}
          >
            {Icon.plus}
            Filter
          </button>

          {open && (
            <FilterDropdown
              providers={providers}
              allTags={allTags}
              filters={filters}
              onChange={onChange}
            />
          )}
        </div>

        {/* Active filter chips */}
        {hasAny && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {chips.map((c) => (
              <span
                key={c.key}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontFamily: "var(--mono)",
                  fontSize: 10.5,
                  fontWeight: 500,
                  color: "var(--ink-2)",
                  background: "var(--surface)",
                  padding: "2px 6px 2px 8px",
                  borderRadius: 4,
                  border: "0.5px solid var(--border-2)",
                }}
              >
                {c.label}
                <button
                  onClick={() => c.remove()}
                  style={{
                    border: 0,
                    background: "transparent",
                    color: "var(--ink-3)",
                    padding: 0,
                    cursor: "pointer",
                    lineHeight: 1,
                    fontSize: 12,
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterDropdown({
  providers,
  allTags,
  filters,
  onChange,
}: {
  providers: string[];
  allTags: string[];
  filters: ActiveFilters;
  onChange: (filters: ActiveFilters) => void;
}) {
  const sectionStyle: React.CSSProperties = {
    padding: "8px 12px 6px",
    borderBottom: "0.5px solid var(--border)",
  };
  const labelStyle: React.CSSProperties = {
    fontFamily: "var(--mono)",
    fontSize: 10,
    fontWeight: 600,
    color: "var(--ink-3)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: 6,
    display: "block",
  };

  const toggleProvider = (p: string) => {
    const cur = filters.providers ?? [];
    const next = cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p];
    onChange({ ...filters, providers: next.length > 0 ? next : undefined });
  };

  const toggleTag = (t: string) => {
    const cur = filters.tags ?? [];
    const next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t];
    onChange({ ...filters, tags: next.length > 0 ? next : undefined });
  };

  return (
    <div
      style={{
        position: "absolute",
        top: "calc(100% + 4px)",
        left: 0,
        zIndex: 80,
        width: 240,
        background: "var(--bg)",
        border: "0.5px solid var(--border-2)",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
        maxHeight: 340,
        overflowY: "auto",
      }}
    >
      {/* Provider section */}
      {providers.length > 0 && (
        <div style={sectionStyle}>
          <span style={labelStyle}>Provider</span>
          {providers.map((p) => (
            <label
              key={p}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                color: "var(--ink)",
                padding: "3px 0",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={filters.providers?.includes(p) ?? false}
                onChange={() => toggleProvider(p)}
                style={{ accentColor: "var(--accent)" }}
              />
              <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{p}</span>
            </label>
          ))}
        </div>
      )}

      {/* Tag section */}
      {allTags.length > 0 && (
        <div style={sectionStyle}>
          <span style={labelStyle}>Tag</span>
          {allTags.map((t) => (
            <label
              key={t}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                color: "var(--ink)",
                padding: "3px 0",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={filters.tags?.includes(t) ?? false}
                onChange={() => toggleTag(t)}
                style={{ accentColor: "var(--accent)" }}
              />
              <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{t}</span>
            </label>
          ))}
        </div>
      )}

      {/* Has SKILL.md */}
      <div style={sectionStyle}>
        <span style={labelStyle}>Has SKILL.md</span>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: "var(--ink)",
            padding: "3px 0",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={filters.hasSkillMd === true}
            onChange={() =>
              onChange({
                ...filters,
                hasSkillMd: filters.hasSkillMd ? undefined : true,
              })
            }
            style={{ accentColor: "var(--accent)" }}
          />
          <span style={{ fontSize: 11 }}>Yes, has SKILL.md</span>
        </label>
      </div>

      {/* File count */}
      <div style={{ ...sectionStyle, borderBottom: "none" }}>
        <span style={labelStyle}>Min file count</span>
        {[5, 10, 20].map((n) => (
          <label
            key={n}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              color: "var(--ink)",
              padding: "3px 0",
              cursor: "pointer",
            }}
          >
            <input
              type="radio"
              name="minFiles"
              checked={filters.minFiles === n}
              onChange={() =>
                onChange({
                  ...filters,
                  minFiles: filters.minFiles === n ? undefined : n,
                })
              }
              style={{ accentColor: "var(--accent)" }}
            />
            <span style={{ fontSize: 11 }}>&gt; {n} files</span>
          </label>
        ))}
      </div>
    </div>
  );
}

