import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { assistantApi } from "../../lib/assistant";
import {
  closeAssistant,
  collapseAssistant,
  deleteChat,
  loadSession,
  newChat,
  openAssistant,
  removeChip,
  retryLastMessage,
  sendMessage,
  setAssistantWidth,
  setDraft,
  stopTurn,
  toggleAssistant,
  useAssistantState,
} from "../../lib/assistantStore";
import { Icon } from "../ui/icons";
import { Button } from "../ui/primitives";
import { AgentChip, ContextChips } from "./ContextChips";
import { Composer } from "./Composer";
import { MessageThread } from "./MessageThread";
import { SessionList } from "./SessionList";

/**
 * The assistant pane — DOCKED, not modal: it sits as a flex sibling of the
 * main content (Layout renders it last), so the app stays fully usable
 * beside an open chat. Three states: open (resizable 380–760px), rail
 * (44px strip with a working indicator), closed (nothing).
 *
 * Ctrl/Cmd+J toggles open/closed from anywhere; Escape collapses to the
 * rail only when focus is inside the panel (so it never fights dialogs).
 */
export function AssistantPanel() {
  const state = useAssistantState();
  const [historyOpen, setHistoryOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const status = useQuery({
    queryKey: ["assistant-status"],
    queryFn: () => assistantApi.status(),
    staleTime: 60_000,
  });
  const available = status.data?.available ?? false;

  // Global shortcut: Ctrl/Cmd+J toggles the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        toggleAssistant();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Escape collapses — only when the event originated inside the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (panelRef.current && panelRef.current.contains(e.target as Node)) {
        e.preventDefault();
        collapseAssistant();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Width drag — pointer events on the left edge handle.
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const d = dragRef.current;
      if (!d) return;
      setAssistantWidth(d.startWidth + (d.startX - e.clientX));
    };
    const onUp = (): void => {
      if (dragRef.current) {
        dragRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  if (state.mode === "closed") return null;

  if (state.mode === "rail") {
    return (
      <div
        style={{
          width: 44,
          flexShrink: 0,
          borderLeft: "0.5px solid var(--border)",
          background: "var(--surface)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          paddingTop: 12,
          gap: 10,
        }}
      >
        <button
          onClick={() => openAssistant()}
          title="Expand assistant (⌘J)"
          style={{
            width: 30,
            height: 30,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "0.5px solid var(--border-2)",
            background: "var(--bg)",
            borderRadius: 7,
            color: "var(--accent)",
            cursor: "pointer",
            position: "relative",
          }}
        >
          {Icon.sparkle}
          {state.phase !== "idle" && (
            <span
              className="sv-pulse"
              style={{
                position: "absolute",
                top: -2,
                right: -2,
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "var(--accent)",
              }}
            />
          )}
        </button>
        <button
          onClick={closeAssistant}
          title="Close assistant"
          style={{
            width: 24,
            height: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: 0,
            background: "transparent",
            color: "var(--ink-4)",
            cursor: "pointer",
          }}
        >
          {Icon.x}
        </button>
      </div>
    );
  }

  const frozen = state.items.length > 0;

  return (
    <div
      ref={panelRef}
      className="sv-slide-in-right"
      style={{
        width: state.width,
        flexShrink: 0,
        borderLeft: "0.5px solid var(--border)",
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        minWidth: 0,
      }}
    >
      {/* Resize handle */}
      <div
        onMouseDown={(e) => {
          dragRef.current = { startX: e.clientX, startWidth: state.width };
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        title="Drag to resize"
        style={{
          position: "absolute",
          left: -3,
          top: 0,
          bottom: 0,
          width: 6,
          cursor: "col-resize",
          zIndex: 5,
        }}
      />

      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 12px 10px 16px",
          borderBottom: "0.5px solid var(--border)",
          flexShrink: 0,
          position: "relative",
        }}
      >
        <span style={{ display: "inline-flex", color: "var(--accent)", flexShrink: 0 }}>{Icon.sparkle}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", flexShrink: 0 }}>Assistant</span>
        <AgentChip agent={state.agent} skill={state.skill} />
        <span style={{ flex: 1 }} />
        <HeaderIconButton title="Chat history" onClick={() => setHistoryOpen((v) => !v)}>
          {Icon.history}
        </HeaderIconButton>
        <HeaderIconButton title="New chat" onClick={() => { setHistoryOpen(false); newChat(); }}>
          {Icon.plus}
        </HeaderIconButton>
        <HeaderIconButton title="Collapse (Esc inside panel)" onClick={collapseAssistant}>
          {Icon.chevron}
        </HeaderIconButton>
        <HeaderIconButton title="Close (⌘J)" onClick={closeAssistant}>
          {Icon.x}
        </HeaderIconButton>

        {historyOpen && (
          <SessionList
            currentId={state.sessionId}
            onPick={(id) => {
              setHistoryOpen(false);
              if (id !== state.sessionId) void loadSession(id);
            }}
            onNew={() => {
              setHistoryOpen(false);
              newChat();
            }}
            onDelete={(id) => void deleteChat(id)}
            onClose={() => setHistoryOpen(false)}
          />
        )}
      </div>

      <ContextChips chips={state.chips} frozen={frozen} onRemove={removeChip} />

      {state.error && (
        <div
          role="alert"
          style={{
            margin: "10px 16px 0",
            padding: "7px 10px",
            border: "0.5px solid var(--bad)",
            background: "color-mix(in oklab, var(--bad) 8%, transparent)",
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          {state.error}
        </div>
      )}

      {/* Availability gate */}
      {status.data && !available ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            padding: "0 24px",
            textAlign: "center",
          }}
        >
          <span style={{ color: "var(--warn)", display: "inline-flex", transform: "scale(1.4)" }}>{Icon.warn}</span>
          <div style={{ fontSize: 13, fontWeight: 500 }}>Assistant unavailable</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--ink-3)", lineHeight: 1.5 }}>
            {status.data.reason ?? "Claude CLI not found"}
          </div>
          <Button
            kind="default"
            size="sm"
            icon={Icon.refresh}
            onClick={() => {
              void assistantApi.status(true).then(() => status.refetch());
            }}
          >
            Retry
          </Button>
        </div>
      ) : (
        <MessageThread
          items={state.items}
          phase={state.phase}
          agent={state.agent}
          skill={state.skill}
          loading={state.loadingSession}
          onSuggestion={(text) => sendMessage(text)}
          onRetry={retryLastMessage}
        />
      )}

      <Composer
        draft={state.draft}
        phase={state.phase}
        agent={state.agent}
        skill={state.skill}
        disabled={Boolean(status.data && !available)}
        onDraft={setDraft}
        onSend={() => sendMessage()}
        onStop={stopTurn}
      />
    </div>
  );
}

function HeaderIconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 26,
        height: 26,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: 0,
        background: "transparent",
        borderRadius: 5,
        color: "var(--ink-3)",
        cursor: "pointer",
        flexShrink: 0,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      {children}
    </button>
  );
}
