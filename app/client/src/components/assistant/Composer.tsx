import { useEffect, useRef, useState } from "react";
import type { AgentKind, Phase } from "../../lib/assistantStore";
import { speechSupported, startDictation, type Dictation } from "../../lib/speech";
import { Icon } from "../ui/icons";
import { Button } from "../ui/primitives";

/**
 * Message composer: auto-growing textarea, Enter sends / Shift+Enter
 * newline, Stop replaces Send while a turn runs. The draft lives in the
 * store (pre-seeded by "Ask AI" entry points), not local state.
 *
 * Voice input: a mic button (Web Speech API — Chrome/Edge; hidden where
 * unsupported) dictates into the draft. Final utterances append to the
 * draft; the in-flight guess renders as a live hint under the box.
 * Dictation stops on send, on toggle, and on unmount.
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

  // ── Voice input ─────────────────────────────────────────────
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const dictationRef = useRef<Dictation | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const canDictate = speechSupported();

  const stopDictation = (): void => {
    dictationRef.current?.stop();
    dictationRef.current = null;
  };

  const toggleDictation = (): void => {
    if (listening) {
      stopDictation();
      return;
    }
    const d = startDictation({
      onFinal: (text) => {
        const t = text.trim();
        if (!t) return;
        const cur = draftRef.current;
        onDraft(cur ? `${cur.replace(/\s+$/, "")} ${t}` : t);
      },
      onInterim: setInterim,
      onEnd: () => {
        dictationRef.current = null;
        setListening(false);
        setInterim("");
      },
    });
    if (d) {
      dictationRef.current = d;
      setListening(true);
    }
  };

  // Never leave the mic hot after unmount (panel closed mid-dictation).
  useEffect(() => stopDictation, []);

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
              if (!working && draft.trim()) {
                stopDictation();
                onSend();
              }
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
        {canDictate && !disabled && (
          <button
            onClick={toggleDictation}
            title={listening ? "Stop dictating" : "Dictate (voice to text)"}
            style={{
              width: 26,
              height: 26,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              border: listening ? "0.5px solid color-mix(in oklab, var(--bad) 45%, transparent)" : "0.5px solid transparent",
              background: listening ? "color-mix(in oklab, var(--bad) 10%, transparent)" : "transparent",
              borderRadius: 6,
              color: listening ? "var(--bad)" : "var(--ink-3)",
              cursor: "pointer",
            }}
            className={listening ? "sv-pulse" : undefined}
          >
            {Icon.mic}
          </button>
        )}
        {working ? (
          <Button kind="danger" size="sm" icon={Icon.stop} onClick={onStop} title="Stop this turn">
            Stop
          </Button>
        ) : (
          <Button
            kind="accent"
            size="sm"
            icon={Icon.send}
            onClick={() => {
              stopDictation();
              onSend();
            }}
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
          gap: 10,
        }}
      >
        <span style={{ flexShrink: 0 }}>⏎ send · ⇧⏎ newline</span>
        {listening && (
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--ink-3)",
              textAlign: "right",
            }}
          >
            {interim || "listening…"}
          </span>
        )}
        {working && (
          <span className="sv-dots" style={{ color: "var(--accent)" }}>
            <span /><span /><span />
          </span>
        )}
      </div>
    </div>
  );
}
