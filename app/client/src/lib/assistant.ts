/**
 * Assistant transport layer: wire event types shared with the server
 * (server/services/assistant/streamEvents.ts is the source of truth), the
 * NDJSON turn-stream reader, and the small session REST surface.
 *
 * A chat turn is a POST whose RESPONSE streams — EventSource can't POST,
 * so the reader is fetch + ReadableStream, splitting on newlines exactly
 * like the server's line-buffered writer produces them.
 */

import { ApiError } from "./api";

// ── Wire events (one JSON object per NDJSON line) ────────────────

export type AssistantStreamEvent =
  | { type: "session"; session_id: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; tool_use_id: string; name: string; label: string; input_preview?: string }
  | { type: "tool_result"; tool_use_id: string; ok: boolean; output_preview?: string }
  | { type: "turn_end"; cost_usd?: number; duration_ms?: number }
  | { type: "error"; message: string }
  | { type: "done" };

// ── Context chips (mirror server sanitizeChips) ──────────────────

export type ChipKind = "skill" | "skills" | "filter" | "failure" | "notion" | "page" | "suggestion";

export interface AssistantChip {
  kind: ChipKind;
  id: string;
  label: string;
  data?: Record<string, unknown>;
}

export type AgentKind = "vault" | "skill";

// ── Session REST shapes ──────────────────────────────────────────

export interface AssistantStatus {
  available: boolean;
  version?: string;
  reason?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  agent: AgentKind;
  skill?: string;
  turn_count: number;
  total_cost_usd: number;
  running: boolean;
  created_at: string;
  last_at: string;
}

export interface StoredTurn {
  at: string;
  user: string;
  events: AssistantStreamEvent[];
}

export interface SessionDetail {
  session: {
    id: string;
    title: string;
    agent: AgentKind;
    skill?: string;
    chips: AssistantChip[];
    running: boolean;
    total_cost_usd: number;
    created_at: string;
    last_at: string;
  };
  turns: StoredTurn[];
}

async function rest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!res.ok) {
    const d = data as { error?: string } | null;
    throw new ApiError(d?.error ?? `Request failed (${res.status})`, res.status, data);
  }
  return data as T;
}

export const assistantApi = {
  status: (refresh?: boolean) =>
    rest<AssistantStatus>("GET", `/api/assistant/status${refresh ? "?refresh=1" : ""}`),
  sessions: () => rest<{ sessions: SessionSummary[] }>("GET", "/api/assistant/sessions"),
  session: (id: string) => rest<SessionDetail>("GET", `/api/assistant/sessions/${encodeURIComponent(id)}`),
  deleteSession: (id: string) =>
    rest<{ ok: boolean }>("DELETE", `/api/assistant/sessions/${encodeURIComponent(id)}`),
  stop: (id: string) =>
    rest<{ stopped: boolean }>("POST", `/api/assistant/sessions/${encodeURIComponent(id)}/stop`),
  suggestions: () => rest<SuggestionsResponse>("GET", "/api/assistant/suggestions"),
  dismissSuggestion: (id: string, fingerprint: string) =>
    rest<{ ok: boolean }>("POST", "/api/assistant/suggestions/dismiss", { id, fingerprint }),
  restoreSuggestion: (id: string) => rest<{ ok: boolean }>("POST", "/api/assistant/suggestions/restore", { id }),
  runSweep: () => rest<{ started: boolean; running: boolean }>("POST", "/api/assistant/suggestions/sweep"),
  installable: () => rest<{ skills: string[] }>("GET", "/api/assistant/install-skills"),
  installSkills: (body: { skills?: string[]; agents?: boolean; overwrite?: boolean }) =>
    rest<{
      installed_skills: string[];
      skipped_skills: { name: string; reason: string }[];
      installed_agents: string[];
      skipped_agents: { name: string; reason: string }[];
    }>("POST", "/api/assistant/install-skills", body),
};

// ── Proactive suggestions ("For you") ────────────────────────────

export type SuggestionSeverity = "action" | "warn" | "info";

export type SuggestionAction =
  | { type: "ask-ai"; label: string; prompt: string; chips?: AssistantChip[] }
  | { type: "link"; label: string; href: string };

export interface SuggestionCard {
  id: string;
  kind: string;
  severity: SuggestionSeverity;
  title: string;
  detail?: string;
  count: number;
  skills?: string[];
  actions: SuggestionAction[];
  freshness?: string;
  fingerprint: string;
}

export interface SuggestionsResponse {
  cards: SuggestionCard[];
  generated_at: string;
  sweep: { checked_at: string | null; running: boolean };
  dismissed: Array<{ id: string; at: string }>;
}

// ── The turn stream ──────────────────────────────────────────────

export interface StreamTurnBody {
  session_id?: string;
  agent: AgentKind;
  skill?: string;
  message: string;
  context: AssistantChip[];
}

/**
 * POST one turn and feed each NDJSON event to `onEvent` as it arrives.
 * Resolves when the stream closes; throws ApiError for a non-2xx response
 * (which never streams). Unknown event types are ignored for forward
 * compatibility. Aborting the signal drops the connection — the server
 * kills the CLI turn when it notices.
 */
export async function streamTurn(
  body: StreamTurnBody,
  onEvent: (ev: AssistantStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/assistant/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* no body */
    }
    const d = data as { error?: string } | null;
    throw new ApiError(d?.error ?? `Assistant request failed (${res.status})`, res.status, data);
  }
  if (!res.body) throw new ApiError("Assistant stream had no body", res.status, null);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev: AssistantStreamEvent;
    try {
      ev = JSON.parse(trimmed) as AssistantStreamEvent;
    } catch {
      return; // malformed line — drop, don't kill the stream
    }
    if (ev && typeof ev.type === "string") onEvent(ev);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = pending.indexOf("\n")) !== -1) {
      handleLine(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
    }
  }
  handleLine(pending);
}
