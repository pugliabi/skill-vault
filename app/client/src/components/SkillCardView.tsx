import { useState } from "react";
import type { Skill } from "../lib/types";
import { DesktopBadge, ProviderChip, StatusBadge } from "./ui/primitives";
import { TagChips } from "./TagChips";

export function SkillCardView({
  skills,
  selectedName,
  selected,
  onSelect,
  onToggleSelect,
  onPreview,
}: {
  skills: Skill[];
  selectedName?: string;
  selected: Set<string>;
  onSelect: (name: string, e: React.MouseEvent) => void;
  onToggleSelect: (name: string, e: React.MouseEvent) => void;
  onPreview: (name: string) => void;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: 12,
        padding: 16,
      }}
    >
      {skills.map((s) => (
        <SkillCard
          key={s.name}
          skill={s}
          isActive={selectedName === s.name}
          isChecked={selected.has(s.name)}
          anySelected={selected.size > 0}
          onSelect={(e) => onSelect(s.name, e)}
          onToggleSelect={(e) => onToggleSelect(s.name, e)}
          onPreview={() => onPreview(s.name)}
        />
      ))}
    </div>
  );
}

function SkillCard({
  skill: s,
  isActive,
  isChecked,
  anySelected,
  onSelect,
  onToggleSelect,
  onPreview,
}: {
  skill: Skill;
  isActive: boolean;
  isChecked: boolean;
  anySelected: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onToggleSelect: (e: React.MouseEvent) => void;
  onPreview: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: isActive
          ? "var(--surface-2)"
          : hovered
            ? "var(--surface)"
            : "var(--bg)",
        border: isChecked
          ? "1px solid var(--accent)"
          : isActive
            ? "1px solid var(--border-2)"
            : "0.5px solid var(--border)",
        borderRadius: 8,
        padding: 14,
        cursor: "pointer",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        transition: "border-color 120ms, background 120ms",
      }}
    >
      {/* Checkbox */}
      {(hovered || anySelected) && (
        <input
          type="checkbox"
          checked={isChecked}
          onChange={() => {}}
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect(e);
          }}
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            width: 14,
            height: 14,
            cursor: "pointer",
            accentColor: "var(--accent)",
          }}
        />
      )}

      {/* Name */}
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 13,
          fontWeight: 600,
          color: "var(--ink)",
          paddingRight: 24,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {s.name}
      </div>

      {/* Description */}
      <div
        style={{
          fontSize: 12,
          color: "var(--ink-3)",
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          lineHeight: "1.4",
          minHeight: "2.8em",
        }}
      >
        {s.description || (
          <span style={{ color: "var(--ink-4)", fontStyle: "italic" }}>
            no description
          </span>
        )}
      </div>

      {/* Tags */}
      {s.tags.length > 0 && <TagChips tags={s.tags} />}

      {/* Footer: status + targets */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginTop: "auto",
        }}
      >
        <StatusBadge status={s.status} />
        <DesktopBadge status={s.desktop_status} />
        <span style={{ flex: 1 }} />
        {s.targets.length > 0 ? (
          s.targets.map((t) => <ProviderChip key={t} slug={t} />)
        ) : (
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--ink-4)",
            }}
          >
            —
          </span>
        )}
      </div>
    </div>
  );
}
