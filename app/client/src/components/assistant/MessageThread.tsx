import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { AgentKind, Phase } from "../../lib/assistantStore";
import type { AssistantBlock, ChatItem, ToolBlock } from "../../lib/assistantStore";
import { renderMarkdown } from "../../lib/markdown";
import { Icon } from "../ui/icons";
import { Button } from "../ui/primitives";
import { ToolActivityLine } from "./ToolActivityLine";

/**
 * The conversation: user messages as quiet cards, assistant messages as
 * streaming markdown with consecutive tool calls grouped into a bordered
 * timeline. Sticks to the bottom unless the user scrolled up (then a
 * "↓ latest" pill appears).
 */

const SUGGESTIONS: Record<AgentKind, string[]> = {
  vault: [
    "Check all skills for updates and apply the safe ones",
    "Find the errors from my recent operations and fix them",
    "Find top-starred GitHub skills worth adopting for my stack",
    "What's the Notion sync state of my vault?",
  ],
  skill: [
    "Update this skill from its source",
    "Why is this skill failing its update check? Fix it.",
    "Explain what this skill does and how it's organized",
    "Push this skill to all its targets",
  ],
};

/** Group an assistant item's blocks: text runs render as markdown, tool runs as a timeline. */
function groupBlocks(blocks: AssistantBlock[]): Array<{ kind: "text"; text: string } | { kind: "tools"; tools: ToolBlock[] }> {
  const groups: Array<{ kind: "text"; text: string } | { kind: "tools"; tools: ToolBlock[] }> = [];
  for (const b of blocks) {
    const last = groups[groups.length - 1];
    if (b.kind === "text") {
      if (b.text.trim() === "") continue;
      if (last?.kind === "text") last.text += b.text;
      else groups.push({ kind: "text", text: b.text });
    } else {
      if (last?.kind === "tools") last.tools.push(b);
      else groups.push({ kind: "tools", tools: [b] });
    }
  }
  return groups;
}

function Markdown({ source, streaming }: { source: string; streaming: boolean }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return (
    <div style={{ position: "relative" }}>
      <div className="sv-markdown sv-markdown--chat" dangerouslySetInnerHTML={{ __html: html }} />
      {streaming && (
        <span className="sv-pulse" style={{ color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 13 }}>
          ▍
        </span>
      )}
    </div>
  );
}

function AssistantMessage({ item, onRetry }: { item: Extract<ChatItem, { kind: "assistant" }>; onRetry: () => void }) {
  const groups = useMemo(() => groupBlocks(item.blocks), [item.blocks]);
  const lastGroup = groups[groups.length - 1];
  const stopped = item.error === "stopped";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      {groups.map((g, i) =>
        g.kind === "text" ? (
          <Markdown key={i} source={g.text} streaming={item.streaming && g === lastGroup} />
        ) : (
          <div
            key={i}
            style={{ borderLeft: "2px solid var(--border-2)", marginLeft: 2, paddingLeft: 10, minWidth: 0 }}
          >
            {g.tools.map((t) => (
              <ToolActivityLine key={t.id} block={t} />
            ))}
          </div>
        ),
      )}

      {item.streaming && groups.length === 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontFamily: "var(--mono)",
            fontSize: 11.5,
            color: "var(--ink-3)",
          }}
        >
          <span className="sv-dots" style={{ color: "var(--accent)" }}>
            <span /><span /><span />
          </span>
          Working…
        </div>
      )}

      {item.error && !stopped && (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 10px",
            border: "0.5px solid var(--bad)",
            background: "color-mix(in oklab, var(--bad) 8%, transparent)",
            borderRadius: 6,
            fontSize: 12,
            color: "var(--ink)",
          }}
        >
          <span style={{ color: "var(--bad)", display: "inline-flex", flexShrink: 0 }}>{Icon.warn}</span>
          <span style={{ flex: 1, minWidth: 0, wordBreak: "break-word" }}>{item.error}</span>
          <Button kind="ghost" size="sm" onClick={onRetry} title="Send the last message again">
            Retry
          </Button>
        </div>
      )}
      {stopped && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-4)" }}>— stopped —</div>
      )}

      {!item.streaming && (item.costUsd !== undefined || item.durationMs !== undefined) && (
        <div style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-4)" }}>
          {item.costUsd !== undefined ? `$${item.costUsd.toFixed(3)}` : ""}
          {item.costUsd !== undefined && item.durationMs !== undefined ? " · " : ""}
          {item.durationMs !== undefined ? `${Math.round(item.durationMs / 1000)}s` : ""}
        </div>
      )}
    </div>
  );
}

export function MessageThread({
  items,
  phase,
  agent,
  skill,
  loading,
  onSuggestion,
  onRetry,
  suggestionsSlot,
}: {
  items: ChatItem[];
  phase: Phase;
  agent: AgentKind;
  skill?: string;
  loading: boolean;
  onSuggestion: (text: string) => void;
  onRetry: () => void;
  /** Proactive "For you" cards, rendered above the canned prompts in the empty state. */
  suggestionsSlot?: React.ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true); // stick to bottom until the user scrolls up
  const pinnedRef = useRef(true);
  pinnedRef.current = pinned;

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  });

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom !== pinnedRef.current) setPinned(nearBottom);
  };

  if (loading) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-3)", fontFamily: "var(--mono)", fontSize: 11.5 }}>
        Loading chat…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div
        className="sv-scroll"
        style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: suggestionsSlot ? "flex-start" : "center", padding: suggestionsSlot ? "16px 22px" : "0 22px", gap: 14, overflowY: "auto", minHeight: 0 }}
      >
        {suggestionsSlot}
        <div style={{ textAlign: "center", color: "var(--ink-4)", display: "flex", justifyContent: "center" }}>
          <span style={{ transform: "scale(1.6)", display: "inline-flex" }}>{Icon.sparkle}</span>
        </div>
        <div style={{ textAlign: "center", fontSize: 12.5, color: "var(--ink-3)", lineHeight: 1.5 }}>
          {agent === "skill" ? (
            <>Assistant — scoped to <span style={{ fontFamily: "var(--mono)", color: "var(--ink-2)" }}>{skill}</span>: its source, updates, files, targets, and Notion link.</>
          ) : (
            <>Assistant — checks updates, pushes, syncs, fixes errors, and discovers new skills across your whole vault. It can research the web and git repos, repair broken sources, and even write skills.</>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {SUGGESTIONS[agent].map((s) => (
            <button
              key={s}
              onClick={() => onSuggestion(s)}
              style={{
                textAlign: "left",
                padding: "8px 12px",
                background: "var(--surface)",
                border: "0.5px solid var(--border-2)",
                borderRadius: 7,
                color: "var(--ink-2)",
                fontSize: 12.5,
                cursor: "pointer",
                fontFamily: "var(--sans)",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "var(--surface)")}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="sv-scroll"
        style={{ height: "100%", overflowY: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 14 }}
      >
        {items.map((item) => (
          <Fragment key={item.id}>
            {item.kind === "user" ? (
              <div style={{ alignSelf: "flex-end", maxWidth: "88%" }}>
                <div
                  style={{
                    background: "var(--surface-2)",
                    border: "0.5px solid var(--border)",
                    borderRadius: 8,
                    padding: "7px 11px",
                    fontSize: 13,
                    lineHeight: 1.5,
                    color: "var(--ink)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {item.text}
                </div>
              </div>
            ) : (
              <AssistantMessage item={item} onRetry={onRetry} />
            )}
          </Fragment>
        ))}
        {phase === "waiting" && items[items.length - 1]?.kind === "user" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--ink-3)" }}>
            <span className="sv-dots" style={{ color: "var(--accent)" }}>
              <span /><span /><span />
            </span>
            Working…
          </div>
        )}
      </div>

      {!pinned && (
        <button
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            setPinned(true);
          }}
          style={{
            position: "absolute",
            bottom: 10,
            left: "50%",
            transform: "translateX(-50%)",
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "4px 10px",
            background: "var(--surface)",
            border: "0.5px solid var(--border-2)",
            borderRadius: 999,
            boxShadow: "0 4px 14px oklch(0.1 0.01 60 / 0.15)",
            color: "var(--ink-2)",
            fontFamily: "var(--mono)",
            fontSize: 10.5,
            cursor: "pointer",
          }}
        >
          {Icon.arrowDown} latest
        </button>
      )}
    </div>
  );
}
