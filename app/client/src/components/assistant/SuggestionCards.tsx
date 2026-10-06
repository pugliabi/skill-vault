import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { assistantApi, type SuggestionCard } from "../../lib/assistant";
import { applySuggestionAction, closeAssistant, startBriefing } from "../../lib/assistantStore";
import { timeAgo } from "../../lib/status";
import { Icon } from "../ui/icons";

/**
 * "For you" — the assistant's proactive suggestions. Zero AI cost: the
 * server composes ranked cards from signals the app already computes plus
 * the background update sweep. Rendered in the panel's empty state and in
 * the header popover once a conversation exists.
 *
 * action/warn tiers are always visible; info tier collapses behind
 * "N more". Dismissals are server-side (badge + agents agree) and expire
 * after 7 days or when the card's content changes.
 */

const SEV_TINT: Record<SuggestionCard["severity"], string> = {
  action: "var(--bad)",
  warn: "var(--warn)",
  info: "var(--ink-4)",
};

export function SuggestionCards({
  compact = false,
  onAfterAction,
}: {
  compact?: boolean;
  /** e.g. close the hosting popover once a card action fires. */
  onAfterAction?: () => void;
}) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [showInfo, setShowInfo] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["assistant-suggestions"],
    queryFn: () => assistantApi.suggestions(),
    staleTime: 60_000,
  });

  const dismiss = useMutation({
    mutationFn: ({ id, fingerprint }: { id: string; fingerprint: string }) => assistantApi.dismissSuggestion(id, fingerprint),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["assistant-suggestions"] }),
  });
  const sweep = useMutation({
    mutationFn: () => assistantApi.runSweep(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["assistant-suggestions"] }),
  });

  if (isLoading || !data) return null;
  const cards = data.cards;
  const urgent = cards.filter((c) => c.severity !== "info");
  const info = cards.filter((c) => c.severity === "info");
  const visible = showInfo ? [...urgent, ...info] : urgent;
  const sweepRunning = data.sweep.running || sweep.isPending;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontFamily: "var(--mono)",
          fontSize: 10,
          fontWeight: 600,
          color: "var(--ink-4)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        For you
        {cards.length > 0 && <span style={{ fontWeight: 400 }}>· {cards.length}</span>}
      </div>

      {cards.length === 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--ink-3)", padding: "4px 0" }}>
          <span style={{ color: "var(--ok)", display: "inline-flex" }}>{Icon.check}</span>
          Nothing needs attention right now.
        </div>
      ) : (
        visible.map((card) => (
          <CardRow
            key={card.id}
            card={card}
            onAskAi={(action) => {
              applySuggestionAction(card, action);
              onAfterAction?.();
            }}
            onLink={(href) => {
              navigate(href);
              onAfterAction?.();
              if (compact) closeAssistant();
            }}
            onDismiss={() => dismiss.mutate({ id: card.id, fingerprint: card.fingerprint })}
          />
        ))
      )}

      {!showInfo && info.length > 0 && (
        <button
          onClick={() => setShowInfo(true)}
          style={{
            alignSelf: "flex-start",
            border: 0,
            background: "transparent",
            color: "var(--ink-3)",
            fontFamily: "var(--mono)",
            fontSize: 10.5,
            cursor: "pointer",
            padding: "2px 0",
          }}
        >
          + {info.length} more suggestion{info.length === 1 ? "" : "s"}
        </button>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 2,
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: "var(--ink-4)",
        }}
      >
        <span>
          {sweepRunning
            ? "checking sources…"
            : data.sweep.checked_at
              ? `sources checked ${timeAgo(data.sweep.checked_at)}`
              : "sources not checked yet"}
        </span>
        <button
          onClick={() => sweep.mutate()}
          disabled={sweepRunning}
          title="Re-check every skill's source now"
          style={{
            border: 0,
            background: "transparent",
            color: sweepRunning ? "var(--ink-4)" : "var(--accent)",
            fontFamily: "var(--mono)",
            fontSize: 10,
            cursor: sweepRunning ? "default" : "pointer",
            padding: 0,
          }}
        >
          refresh
        </button>
        <span style={{ flex: 1 }} />
        {cards.length >= 2 && (
          <button
            onClick={() => startBriefing(cards)}
            title="One AI turn that prioritizes everything above"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              border: 0,
              background: "transparent",
              color: "var(--accent)",
              fontFamily: "var(--mono)",
              fontSize: 10,
              cursor: "pointer",
              padding: 0,
            }}
          >
            {Icon.sparkle} AI briefing
          </button>
        )}
      </div>
    </div>
  );
}

function CardRow({
  card,
  onAskAi,
  onLink,
  onDismiss,
}: {
  card: SuggestionCard;
  onAskAi: (action: Extract<SuggestionCard["actions"][number], { type: "ask-ai" }>) => void;
  onLink: (href: string) => void;
  onDismiss: () => void;
}) {
  const [hover, setHover] = useState(false);
  const tint = SEV_TINT[card.severity];
  const askAi = card.actions.find((a) => a.type === "ask-ai") as Extract<SuggestionCard["actions"][number], { type: "ask-ai" }> | undefined;
  const link = card.actions.find((a) => a.type === "link") as Extract<SuggestionCard["actions"][number], { type: "link" }> | undefined;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 5,
        padding: "8px 10px",
        background: "var(--surface)",
        border: `0.5px solid color-mix(in oklab, ${tint} ${card.severity === "info" ? 18 : 32}%, var(--border-2))`,
        borderRadius: 7,
      }}
      title={card.skills?.length ? card.skills.join(", ") : undefined}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: tint, flexShrink: 0, marginTop: 5 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink)", lineHeight: 1.35 }}>{card.title}</div>
          {card.detail && (
            <div style={{ fontSize: 11, color: "var(--ink-3)", lineHeight: 1.4, marginTop: 1 }}>{card.detail}</div>
          )}
        </div>
        <button
          onClick={onDismiss}
          title="Dismiss (comes back if it changes, or in a week)"
          style={{
            display: "inline-flex",
            border: 0,
            background: "transparent",
            color: "var(--ink-4)",
            cursor: "pointer",
            padding: 2,
            opacity: hover ? 1 : 0,
            transition: "opacity 100ms",
            flexShrink: 0,
          }}
        >
          {Icon.x}
        </button>
      </div>
      <div style={{ display: "flex", gap: 10, marginLeft: 13 }}>
        {askAi && (
          <ActionText color="var(--accent)" onClick={() => onAskAi(askAi)}>
            {Icon.sparkle} {askAi.label}
          </ActionText>
        )}
        {link && (
          <ActionText color="var(--ink-3)" onClick={() => onLink(link.href)}>
            {link.label} →
          </ActionText>
        )}
      </div>
    </div>
  );
}

function ActionText({ color, onClick, children }: { color: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        border: 0,
        background: "transparent",
        color,
        fontSize: 11.5,
        fontWeight: 500,
        fontFamily: "var(--sans)",
        cursor: "pointer",
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}
