import { useEffect, useRef } from "react";
import type { AgentKind, Phase } from "../../lib/assistantStore";
import { Icon } from "../ui/icons";
import { Button } from "../ui/primitives";

/**
 * Message composer: auto-growing textarea, Enter sends / Shift+Enter
 * newline, Stop replaces Send while a turn runs. The draft lives in the
 * store (pre-seeded by "Ask AI" entry points), not local state.
 */
export function Composer({
  draft,
  phase,
  agent,
  skill,
  disabled,
  onDraft,
  onSend,
  onStop,
}: {
  draft: string;
  phase: Phase;
  agent: AgentKind;
  skill?: string;
  disabled: boolean;
  onDraft: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const working = phase !== "idle";

  // Auto-grow between 1 and 6 rows.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [draft]);

  // When an entry point pre-seeds a prompt, put the caret at the end.
  useEffect(() => {
    if (draft && ref.current && document.activeElement !== ref.current) {
      ref.current.focus();
      ref.current.setSelectionRange(draft.length, draft.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ borderTop: "0.5px solid var(--border)", padding: "10px 14px 8px", flexShrink: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 8,
          background: "var(--surface)",
          border: "0.5px solid var(--border-2)",
          borderRadius: 8,
          padding: "8px 8px 8px 12px",
        }}
      >
        <textarea
          ref={ref}
          rows={1}
          value={draft}
          disabled={disabled}
          placeholder={
            disabled
              ? "Assistant unavailable"
              : agent === "skill"
                ? `Ask about ${skill}…`
                : "Ask the vault agent…"
          }
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!working && draft.trim()) onSend();
            }
          }}
          className="sv-scroll"
          style={{
            flex: 1,
            resize: "none",
            border: 0,
            outline: "none",
            background: "transparent",
            color: "var(--ink)",
            fontFamily: "var(--sans)",
            fontSize: 13,
            lineHeight: 1.5,
            maxHeight: 132,
            padding: 0,
          }}
        />
        {working ? (
          <Button kind="danger" size="sm" icon={Icon.stop} onClick={onStop} title="Stop this turn">
            Stop
          </Button>
        ) : (
          <Button
            kind="accent"
            size="sm"
            icon={Icon.send}
            onClick={onSend}
            disabled={disabled || !draft.trim()}
            title="Send (Enter)"
          />
        )}
      </div>
      <div
        style={{
          marginTop: 5,
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: "var(--ink-4)",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>⏎ send · ⇧⏎ newline</span>
        {working && (
          <span className="sv-dots" style={{ color: "var(--accent)" }}>
            <span /><span /><span />
          </span>
        )}
      </div>
    </div>
  );
}
