import type { AgentKind, AssistantChip } from "../../lib/assistant";
import { Icon } from "../ui/icons";

/**
 * The agent identity pill + removable context chips. Chips (and therefore
 * the agent) are editable only before the first send — the store enforces
 * it; this component just hides the remove affordance once frozen.
 */

export function AgentChip({ agent, skill }: { agent: AgentKind; skill?: string }) {
  const isSkill = agent === "skill";
  const color = isSkill ? "var(--ok)" : "var(--accent)";
  return (
    <span
      title={isSkill ? `Scoped to the skill "${skill}"` : "Operates across the whole vault"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 8px",
        border: `0.5px solid color-mix(in oklab, ${color} 45%, transparent)`,
        background: `color-mix(in oklab, ${color} 9%, transparent)`,
        color,
        borderRadius: 999,
        fontFamily: "var(--mono)",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.06em",
        whiteSpace: "nowrap",
        maxWidth: 220,
      }}
    >
      {isSkill ? (
        <>
          SKILL
          <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis" }}>
            · {skill}
          </span>
        </>
      ) : (
        "VAULT AGENT"
      )}
    </span>
  );
}

const CHIP_TINT: Record<AssistantChip["kind"], string> = {
  skill: "var(--ok)",
  skills: "var(--accent)",
  filter: "var(--info)",
  failure: "var(--warn)",
  notion: "var(--info)",
  page: "var(--ink-3)",
};

export function ContextChips({
  chips,
  frozen,
  onRemove,
}: {
  chips: AssistantChip[];
  frozen: boolean;
  onRemove: (id: string) => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        padding: "8px 16px",
        borderBottom: "0.5px solid var(--border)",
      }}
    >
      {chips.map((c) => {
        const tint = CHIP_TINT[c.kind] ?? "var(--ink-3)";
        return (
          <span
            key={c.id}
            title={c.data ? JSON.stringify(c.data, null, 1).slice(0, 400) : c.label}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "2px 7px",
              background: "var(--surface-2)",
              border: `0.5px solid color-mix(in oklab, ${tint} 30%, var(--border-2))`,
              borderRadius: 5,
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--ink-2)",
              maxWidth: 260,
            }}
          >
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: tint, flexShrink: 0 }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.label}</span>
            {!frozen && (
              <button
                onClick={() => onRemove(c.id)}
                title="Remove from context"
                style={{
                  display: "inline-flex",
                  border: 0,
                  background: "transparent",
                  color: "var(--ink-4)",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                {Icon.x}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
