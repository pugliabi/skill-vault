import { useEffect, useRef, useState } from "react";
import { assistantApi, type SessionSummary } from "../../lib/assistant";
import { timeAgo } from "../../lib/status";
import { Icon } from "../ui/icons";

/**
 * Recent-chats popover under the history button. Fetched fresh on every
 * open (cheap, always current); the active session is highlighted; rows
 * delete on hover-revealed ×.
 */
export function SessionList({
  currentId,
  onPick,
  onNew,
  onDelete,
  onClose,
}: {
  currentId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    assistantApi
      .sessions()
      .then((r) => alive && setSessions(r.sessions))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      className="sv-fade-in"
      style={{
        position: "absolute",
        top: 40,
        right: 44,
        width: 280,
        maxHeight: 340,
        overflowY: "auto",
        background: "var(--surface)",
        border: "0.5px solid var(--border-2)",
        borderRadius: 8,
        boxShadow: "0 10px 32px oklch(0.1 0.01 60 / 0.22)",
        zIndex: 20,
        padding: 4,
      }}
    >
      <button
        onClick={onNew}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "7px 9px",
          border: 0,
          background: "transparent",
          borderRadius: 6,
          color: "var(--ink)",
          fontSize: 12.5,
          fontWeight: 500,
          cursor: "pointer",
          textAlign: "left",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        <span style={{ display: "inline-flex", color: "var(--accent)" }}>{Icon.plus}</span>
        New chat
      </button>

      <div style={{ height: 1, background: "var(--border)", margin: "3px 4px" }} />

      {sessions === null && !error && (
        <div style={{ padding: "10px 9px", fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-3)" }}>Loading…</div>
      )}
      {error && (
        <div style={{ padding: "10px 9px", fontFamily: "var(--mono)", fontSize: 11, color: "var(--bad)" }}>
          Couldn't load chats
        </div>
      )}
      {sessions?.length === 0 && (
        <div style={{ padding: "10px 9px", fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-3)" }}>
          No chats yet
        </div>
      )}
      {sessions?.map((s) => {
        const active = s.id === currentId;
        return (
          <div
            key={s.id}
            onClick={() => onPick(s.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "6px 9px",
              borderRadius: 6,
              background: active ? "var(--surface-2)" : "transparent",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--surface-2)";
              const del = e.currentTarget.querySelector<HTMLElement>("[data-del]");
              if (del) del.style.opacity = "1";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = active ? "var(--surface-2)" : "transparent";
              const del = e.currentTarget.querySelector<HTMLElement>("[data-del]");
              if (del) del.style.opacity = "0";
            }}
          >
            <span
              title={s.agent === "skill" ? `skill: ${s.skill}` : "vault agent"}
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                flexShrink: 0,
                background: s.agent === "skill" ? "var(--ok)" : "var(--accent)",
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {s.title}
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-4)" }}>
                {s.running ? "running…" : timeAgo(s.last_at)}
                {s.total_cost_usd > 0 ? ` · $${s.total_cost_usd.toFixed(2)}` : ""}
              </div>
            </div>
            <button
              data-del
              onClick={(e) => {
                e.stopPropagation();
                onDelete(s.id);
                setSessions((prev) => prev?.filter((x) => x.id !== s.id) ?? null);
              }}
              title="Delete chat"
              style={{
                display: "inline-flex",
                border: 0,
                background: "transparent",
                color: "var(--ink-4)",
                cursor: "pointer",
                padding: 2,
                opacity: 0,
                transition: "opacity 100ms",
              }}
            >
              {Icon.x}
            </button>
          </div>
        );
      })}
    </div>
  );
}
