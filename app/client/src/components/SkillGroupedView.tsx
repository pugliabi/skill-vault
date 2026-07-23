import { useState } from "react";
import type { Skill } from "../lib/types";
import { DesktopBadge, StatusBadge } from "./ui/primitives";
import { TagChips } from "./TagChips";

type GroupByKey = "tag" | "provider" | "stage" | "status";

export function SkillGroupedView({
  skills,
  groupBy,
  selectedName,
  selected,
  onSelect,
  onToggleSelect,
  onPreview,
}: {
  skills: Skill[];
  groupBy: GroupByKey;
  selectedName?: string;
  selected: Set<string>;
  onSelect: (name: string, e: React.MouseEvent) => void;
  onToggleSelect: (name: string, e: React.MouseEvent) => void;
  onPreview: (name: string) => void;
}) {
  const groups = buildGroups(skills, groupBy);

  // Sum of bucket sizes vs unique skill count. For tag/provider
  // groupings a skill can land in multiple buckets (e.g. tags = ["ai",
  // "browser"] → both groups list it). The footer shows the unique
  // count so users understand the inflated bucket totals.
  const bucketTotal = groups.reduce((n, [, items]) => n + items.length, 0);
  const uniqueCount = skills.length;
  const isMultiBucket = (groupBy === "tag" || groupBy === "provider") && bucketTotal !== uniqueCount;

  return (
    <div style={{ padding: "8px 0" }}>
      {groups.map(([label, items]) => (
        <GroupSection
          key={label}
          label={label}
          skills={items}
          selectedName={selectedName}
          selected={selected}
          onSelect={onSelect}
          onToggleSelect={onToggleSelect}
          onPreview={onPreview}
        />
      ))}
      {isMultiBucket && (
        <div
          style={{
            padding: "10px 22px 14px",
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--ink-4)",
            borderTop: "0.5px solid var(--border)",
            background: "var(--surface)",
          }}
        >
          {bucketTotal} listing{bucketTotal === 1 ? "" : "s"} across {groups.length} group
          {groups.length === 1 ? "" : "s"} · {uniqueCount} unique skill
          {uniqueCount === 1 ? "" : "s"}
          {groupBy === "tag" && " (skills with multiple tags appear in each group)"}
          {groupBy === "provider" && " (skills pushed to multiple providers appear in each group)"}
        </div>
      )}
    </div>
  );
}

/**
 * Map skills to their group buckets. For `tag` and `provider` groupings
 * each skill emits one bucket per tag/target, so a skill with tags
 * `["ai", "browser"]` shows in BOTH the `ai` and `browser` groups.
 * This is intentional — there is no concept of a "primary tag" in the
 * data model, and silently dropping skills from secondary groups would
 * be more confusing than honest duplication. The dedup hint footer in
 * SkillGroupedView reports the unique-count so totals make sense.
 */
function buildGroups(
  skills: Skill[],
  groupBy: GroupByKey,
): Array<[string, Skill[]]> {
  const map = new Map<string, Skill[]>();

  for (const s of skills) {
    const keys = getGroupKeys(s, groupBy);
    for (const k of keys) {
      const arr = map.get(k);
      if (arr) arr.push(s);
      else map.set(k, [s]);
    }
  }

  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function getGroupKeys(s: Skill, groupBy: GroupByKey): string[] {
  switch (groupBy) {
    case "tag":
      return s.tags.length > 0 ? s.tags : ["Untagged"];
    case "provider":
      return s.targets.length > 0 ? s.targets : ["No targets"];
    case "stage":
      return [s.stage];
    case "status":
      return [s.status];
  }
}

function GroupSection({
  label,
  skills,
  selectedName,
  selected,
  onSelect,
  onToggleSelect,
}: {
  label: string;
  skills: Skill[];
  selectedName?: string;
  selected: Set<string>;
  onSelect: (name: string, e: React.MouseEvent) => void;
  onToggleSelect: (name: string, e: React.MouseEvent) => void;
  onPreview: (name: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const anySelected = selected.size > 0;

  return (
    <div style={{ marginBottom: 4 }}>
      {/* Group header */}
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 22px",
          cursor: "pointer",
          userSelect: "none",
          background: "var(--surface)",
          borderBottom: "0.5px solid var(--border)",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
            transition: "transform 120ms",
            color: "var(--ink-3)",
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path
              d="M3 2l3 3-3 3"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            fontWeight: 600,
            color: "var(--ink-2)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "var(--ink-4)",
          }}
        >
          {skills.length}
        </span>
      </div>

      {/* Group body */}
      {!collapsed &&
        skills.map((s) => (
          <div
            key={s.name}
            onClick={(e) => onSelect(s.name, e)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "7px 22px 7px 40px",
              borderBottom: "0.5px solid var(--border)",
              cursor: "pointer",
              background:
                selectedName === s.name
                  ? "var(--surface-2)"
                  : "transparent",
            }}
          >
            {anySelected && (
              <input
                type="checkbox"
                checked={selected.has(s.name)}
                onChange={() => {}}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSelect(s.name, e);
                }}
                style={{
                  width: 13,
                  height: 13,
                  cursor: "pointer",
                  accentColor: "var(--accent)",
                }}
              />
            )}
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: 12.5,
                fontWeight: 500,
                color: "var(--ink)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {s.name}
            </span>
            {s.tags.length > 0 && <TagChips tags={s.tags} />}
            <span style={{ flex: 1 }} />
            <DesktopBadge status={s.desktop_status} />
            <StatusBadge status={s.status} />
          </div>
        ))}
    </div>
  );
}
