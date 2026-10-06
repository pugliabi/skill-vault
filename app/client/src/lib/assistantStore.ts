/**
 * Assistant panel state — a module-singleton store (the lib/sse.ts
 * precedent: plain module + useSyncExternalStore subscribers), NOT React
 * state, because a running turn must survive the panel being collapsed,
 * the route changing, and Layout remounting. Components are thin views;
 * everything that matters lives here.
 *
 * Rules encoded here, not in components:
 *  - the lead agent derives from context at session start (skill chip →
 *    skill agent) and FREEZES after the first send — "New chat" switches;
 *  - pre-seeded prompts from "Ask AI" buttons fill the composer draft but
 *    are never auto-sent;
 *  - text deltas are batched (~40ms) so markdown re-parses per frame, not
 *    per token.
 */

import { useSyncExternalStore } from "react";
import {
  assistantApi,
  streamTurn,
  type AgentKind,
  type AssistantChip,
  type AssistantStreamEvent,
  type StoredTurn,
} from "./assistant";
import { ApiError } from "./api";

export type { AgentKind, AssistantChip } from "./assistant";

// ── Chat item model ──────────────────────────────────────────────

export interface ToolBlock {
  kind: "tool";
  id: string;
  name: string;
  label: string;
  inputPreview?: string;
  state: "running" | "ok" | "error";
  outputPreview?: string;
  startedAt?: number;
  durationMs?: number;
}

export type AssistantBlock = { kind: "text"; text: string } | ToolBlock;

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "assistant";
      id: string;
      blocks: AssistantBlock[];
      streaming: boolean;
      costUsd?: number;
      durationMs?: number;
      error?: string;
    };

export type PanelMode = "closed" | "rail" | "open";
export type Phase = "idle" | "waiting" | "streaming";

export interface AssistantState {
  mode: PanelMode;
  width: number;
  agent: AgentKind;
  skill?: string;
  chips: AssistantChip[];
  draft: string;
  sessionId: string | null;
  sessionTitle: string;
  items: ChatItem[];
  phase: Phase;
  /** Transport/load failure shown as a banner (turn errors live on items). */
  error: string | null;
  loadingSession: boolean;
}

const LS_SESSION = "sv.assistant.session";
const LS_WIDTH = "sv.assistant.width";
const MIN_WIDTH = 380;
const MAX_WIDTH = 760;

function clampWidth(w: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));
}

let state: AssistantState = {
  mode: "closed",
  width: clampWidth(Number(localStorage.getItem(LS_WIDTH)) || 480),
  agent: "vault",
  skill: undefined,
  chips: [],
  draft: "",
  sessionId: localStorage.getItem(LS_SESSION),
  sessionTitle: "",
  items: [],
  phase: "idle",
  error: null,
  loadingSession: false,
};

const listeners = new Set<() => void>();
let abortController: AbortController | null = null;
let sessionLoaded = false; // lazily hydrate the persisted session on first open
let lastUserMessage = ""; // for Retry

function emit(): void {
  state = { ...state };
  for (const l of listeners) {
    try {
      l();
    } catch (err) {
      console.error("[assistant] listener threw:", err);
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAssistantState(): AssistantState {
  return state;
}

export function useAssistantState(): AssistantState {
  return useSyncExternalStore(subscribe, getAssistantState, getAssistantState);
}

export function useAssistantWorking(): boolean {
  return useSyncExternalStore(subscribe, () => state.phase !== "idle", () => false);
}

// ── Event → items reducer (shared by live stream and history replay) ──

let nextId = 1;
const genId = (): string => `i${nextId++}`;

function lastAssistant(items: ChatItem[]): Extract<ChatItem, { kind: "assistant" }> | null {
  const last = items[items.length - 1];
  return last && last.kind === "assistant" ? last : null;
}

/**
 * Apply one wire event to the item list. Returns false for ignored events.
 * IMMUTABILITY MATTERS: components memoize on the `blocks` array reference
 * (AssistantMessage's groupBlocks memo), so every change must produce a NEW
 * blocks array — in-place mutation renders as a blank message.
 */
function applyEvent(items: ChatItem[], ev: AssistantStreamEvent, live: boolean): boolean {
  const a = lastAssistant(items);
  if (!a) return false;
  switch (ev.type) {
    case "text_delta": {
      const lastBlock = a.blocks[a.blocks.length - 1];
      a.blocks =
        lastBlock && lastBlock.kind === "text"
          ? [...a.blocks.slice(0, -1), { kind: "text", text: lastBlock.text + ev.text }]
          : [...a.blocks, { kind: "text", text: ev.text }];
      return true;
    }
    case "tool_start":
      a.blocks = [
        ...a.blocks,
        {
          kind: "tool",
          id: ev.tool_use_id,
          name: ev.name,
          label: ev.label,
          inputPreview: ev.input_preview,
          state: live ? "running" : "ok",
          startedAt: live ? Date.now() : undefined,
        },
      ];
      return true;
    case "tool_result":
      a.blocks = a.blocks.map((b) =>
        b.kind === "tool" && b.id === ev.tool_use_id
          ? {
              ...b,
              state: ev.ok ? ("ok" as const) : ("error" as const),
              outputPreview: ev.output_preview,
              durationMs: b.startedAt ? Date.now() - b.startedAt : b.durationMs,
            }
          : b,
      );
      return true;
    case "turn_end":
      a.costUsd = ev.cost_usd;
      a.durationMs = ev.duration_ms;
      a.streaming = false;
      return true;
    case "error":
      a.error = ev.message;
      a.streaming = false;
      // A stop mid-tool leaves spinners otherwise.
      a.blocks = a.blocks.map((b) => (b.kind === "tool" && b.state === "running" ? { ...b, state: "error" as const } : b));
      return true;
    default:
      return false;
  }
}

function itemsFromTurns(turns: StoredTurn[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const turn of turns) {
    items.push({ kind: "user", id: genId(), text: turn.user });
    items.push({ kind: "assistant", id: genId(), blocks: [], streaming: false });
    for (const ev of turn.events) applyEvent(items, ev, false);
  }
  return items;
}

// ── Panel chrome ─────────────────────────────────────────────────

export interface OpenAssistantOptions {
  skill?: string;
  chips?: AssistantChip[];
  /** Pre-fills the composer. NEVER auto-sent — the user reviews first. */
  prompt?: string;
  newSession?: boolean;
}

export function openAssistant(opts: OpenAssistantOptions = {}): void {
  state.mode = "open";

  const wantsContext = opts.skill !== undefined || opts.chips !== undefined || opts.newSession;
  if (wantsContext && (state.items.length > 0 || state.sessionId)) {
    // A fresh context means a fresh conversation — never silently splice
    // a new skill into an existing thread's frozen context.
    resetToNewSession();
  }
  if (opts.skill !== undefined) {
    state.agent = "skill";
    state.skill = opts.skill;
    const chip: AssistantChip = { kind: "skill", id: opts.skill, label: `skill: ${opts.skill}` };
    const extra = (opts.chips ?? []).filter((c) => !(c.kind === "skill" && c.id === opts.skill));
    state.chips = [chip, ...extra];
  } else if (opts.chips !== undefined) {
    state.agent = "vault";
    state.skill = undefined;
    state.chips = opts.chips;
  }
  if (opts.prompt !== undefined) state.draft = opts.prompt;

  void hydratePersistedSession();
  emit();
}

export function closeAssistant(): void {
  state.mode = "closed";
  emit();
}

export function collapseAssistant(): void {
  state.mode = "rail";
  emit();
}

export function toggleAssistant(): void {
  if (state.mode === "open") closeAssistant();
  else openAssistant();
}

export function setAssistantWidth(width: number): void {
  state.width = clampWidth(width);
  localStorage.setItem(LS_WIDTH, String(state.width));
  emit();
}

export function setDraft(draft: string): void {
  state.draft = draft;
  emit();
}

export function removeChip(id: string): void {
  if (state.items.length > 0) return; // frozen after the first send
  state.chips = state.chips.filter((c) => c.id !== id);
  const stillHasSkill = state.chips.some((c) => c.kind === "skill");
  if (!stillHasSkill && state.agent === "skill") {
    state.agent = "vault";
    state.skill = undefined;
  }
  emit();
}

// ── Sessions ─────────────────────────────────────────────────────

function resetToNewSession(): void {
  abortController?.abort();
  abortController = null;
  state.sessionId = null;
  state.sessionTitle = "";
  state.items = [];
  state.phase = "idle";
  state.error = null;
  state.agent = "vault";
  state.skill = undefined;
  state.chips = [];
  localStorage.removeItem(LS_SESSION);
  sessionLoaded = true; // a deliberate blank slate beats re-hydrating the old one
}

export function newChat(): void {
  resetToNewSession();
  state.mode = "open";
  emit();
}

/** First open after boot: restore the last session's history (if any). */
async function hydratePersistedSession(): Promise<void> {
  if (sessionLoaded) return;
  sessionLoaded = true;
  const id = state.sessionId;
  if (!id) return;
  await loadSession(id, { silent: true });
}

export async function loadSession(id: string, opts: { silent?: boolean } = {}): Promise<void> {
  abortController?.abort();
  abortController = null;
  state.loadingSession = true;
  state.error = null;
  emit();
  try {
    const detail = await assistantApi.session(id);
    state.sessionId = detail.session.id;
    state.sessionTitle = detail.session.title;
    state.agent = detail.session.agent;
    state.skill = detail.session.skill;
    state.chips = detail.session.chips ?? [];
    state.items = itemsFromTurns(detail.turns);
    state.phase = "idle";
    localStorage.setItem(LS_SESSION, detail.session.id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      // The session evaporated (store trimmed, different machine) — quiet reset.
      resetToNewSession();
    } else if (!opts.silent) {
      state.error = err instanceof ApiError ? err.message : "Failed to load the chat";
    } else {
      resetToNewSession();
    }
  } finally {
    state.loadingSession = false;
    emit();
  }
}

export async function deleteChat(id: string): Promise<void> {
  try {
    await assistantApi.deleteSession(id);
  } catch {
    /* already gone is fine */
  }
  if (state.sessionId === id) {
    resetToNewSession();
    state.mode = "open";
  }
  emit();
}

// ── Sending / stopping turns ─────────────────────────────────────

/** Batch text deltas so markdown re-renders per animation tick, not per token. */
let deltaBuf = "";
let deltaTimer: ReturnType<typeof setTimeout> | null = null;

function flushDeltas(): void {
  deltaTimer = null;
  if (!deltaBuf) return;
  const text = deltaBuf;
  deltaBuf = "";
  if (applyEvent(state.items, { type: "text_delta", text }, true)) {
    if (state.phase === "waiting") state.phase = "streaming";
    emit();
  }
}

export function sendMessage(text?: string): void {
  const message = (text ?? state.draft).trim();
  if (!message || state.phase !== "idle") return;

  lastUserMessage = message;
  state.draft = "";
  state.error = null;
  state.phase = "waiting";
  state.items = [
    ...state.items,
    { kind: "user", id: genId(), text: message },
    { kind: "assistant", id: genId(), blocks: [], streaming: true },
  ];
  emit();

  const ac = new AbortController();
  abortController = ac;

  const body = {
    session_id: state.sessionId ?? undefined,
    agent: state.agent,
    skill: state.skill,
    message,
    context: state.chips,
  };

  void streamTurn(
    body,
    (ev) => {
      if (ev.type === "session") {
        state.sessionId = ev.session_id;
        localStorage.setItem(LS_SESSION, ev.session_id);
        return;
      }
      if (ev.type === "done") return;
      if (ev.type === "text_delta") {
        deltaBuf += ev.text;
        if (!deltaTimer) deltaTimer = setTimeout(flushDeltas, 40);
        return;
      }
      if (ev.type === "thinking_delta") {
        if (state.phase === "waiting") {
          state.phase = "streaming";
          emit();
        }
        return;
      }
      flushDeltas(); // keep ordering: text before this event lands first
      if (applyEvent(state.items, ev, true)) {
        if (state.phase === "waiting") state.phase = "streaming";
        emit();
      }
    },
    ac.signal,
  )
    .catch((err) => {
      flushDeltas();
      const a = lastAssistant(state.items);
      const message =
        ac.signal.aborted
          ? "stopped"
          : err instanceof ApiError
            ? err.message
            : "Connection to the assistant was lost";
      if (a && !a.error) {
        a.error = message;
        a.streaming = false;
        a.blocks = a.blocks.map((b) => (b.kind === "tool" && b.state === "running" ? { ...b, state: "error" as const } : b));
      }
    })
    .finally(() => {
      flushDeltas();
      const a = lastAssistant(state.items);
      if (a) a.streaming = false;
      if (abortController === ac) abortController = null;
      state.phase = "idle";
      if (!state.sessionTitle && lastUserMessage) {
        state.sessionTitle = lastUserMessage.length > 60 ? `${lastUserMessage.slice(0, 59)}…` : lastUserMessage;
      }
      emit();
    });
}

export function stopTurn(): void {
  const id = state.sessionId;
  abortController?.abort(); // drops the stream; the server kills the CLI tree
  if (id) void assistantApi.stop(id).catch(() => {}); // belt and braces
}

export function retryLastMessage(): void {
  if (state.phase !== "idle" || !lastUserMessage) return;
  // Drop the failed assistant item (and its user item) so the thread
  // doesn't show the same question twice.
  const items = state.items;
  const a = lastAssistant(items);
  if (a?.error && items.length >= 2) {
    state.items = items.slice(0, -2);
  }
  sendMessage(lastUserMessage);
}

/** TEST-ONLY (vitest/node) — reset module state between tests. */
export function __resetAssistantStoreForTests(): void {
  abortController?.abort();
  abortController = null;
  deltaBuf = "";
  if (deltaTimer) clearTimeout(deltaTimer);
  deltaTimer = null;
  sessionLoaded = false;
  lastUserMessage = "";
  state = { ...state, mode: "closed", agent: "vault", skill: undefined, chips: [], draft: "", sessionId: null, sessionTitle: "", items: [], phase: "idle", error: null, loadingSession: false };
}
