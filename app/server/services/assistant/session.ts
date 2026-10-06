/**
 * Assistant chat session registry.
 *
 * The `claude` CLI owns the real conversation transcript (sessions are
 * resumable by id as long as the cwd — the vault path — stays the same).
 * This registry keeps the app-side view: which sessions exist, their lead
 * agent + context, the rendered turn history for the UI, and the per-session
 * running lock. It is persisted as one small JSON file under
 * ~/.skill-vault/ so chats survive an app restart (turns included, so the
 * panel can re-render history; the CLI resume keeps the model's memory).
 *
 * Concurrency: one in-flight turn per session, and a small global cap so a
 * runaway tab can't fan out expensive CLI calls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { AssistantStreamEvent } from "./streamEvents.ts";

export type AgentKind = "vault" | "skill";

export interface ChatContextChip {
  kind: "skill" | "skills" | "filter" | "failure" | "notion" | "page" | "suggestion";
  id: string;
  label: string;
  data?: Record<string, unknown>;
}

export interface StoredTurn {
  at: string;
  user: string;
  /** Compacted wire events: one text event per message, tool lines, result. */
  events: AssistantStreamEvent[];
}

export interface AssistantSession {
  id: string;
  title: string;
  agent: AgentKind;
  skill?: string;
  chips: ChatContextChip[];
  turns: StoredTurn[];
  running: boolean;
  abort?: AbortController;
  totalCostUsd: number;
  created_at: string;
  last_at: string;
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

const MAX_SESSIONS = 30;
const MAX_TURNS_PER_SESSION = 50;
export const GLOBAL_RUNNING_CAP = 2;

const sessions = new Map<string, AssistantSession>();
let loaded = false;

function storePath(): string {
  return path.join(os.homedir(), ".skill-vault", "assistant-sessions.json");
}

interface PersistedSession extends Omit<AssistantSession, "running" | "abort"> {}

function loadOnce(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(storePath(), "utf-8");
    const parsed = JSON.parse(raw) as { sessions?: PersistedSession[] };
    for (const p of parsed.sessions ?? []) {
      if (!p?.id) continue;
      sessions.set(p.id, { ...p, chips: p.chips ?? [], turns: p.turns ?? [], running: false, totalCostUsd: p.totalCostUsd ?? 0 });
    }
  } catch {
    /* missing/corrupt store = start empty; never crash the app for chat history */
  }
}

function persist(): void {
  const list = [...sessions.values()]
    .sort((a, b) => (a.last_at < b.last_at ? 1 : -1))
    .slice(0, MAX_SESSIONS)
    .map(({ running: _r, abort: _a, ...rest }) => rest);
  const file = storePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ sessions: list }, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error("[assistant] failed to persist sessions:", err);
  }
}

export function createSession(opts: { agent: AgentKind; skill?: string; chips?: ChatContextChip[] }): AssistantSession {
  loadOnce();
  const now = new Date().toISOString();
  const session: AssistantSession = {
    id: crypto.randomUUID(),
    title: "", // set from the first user message
    agent: opts.agent,
    skill: opts.skill,
    chips: opts.chips ?? [],
    turns: [],
    running: false,
    totalCostUsd: 0,
    created_at: now,
    last_at: now,
  };
  sessions.set(session.id, session);
  persist();
  return session;
}

export function getSession(id: string): AssistantSession | undefined {
  loadOnce();
  return sessions.get(id);
}

export function listSessions(): SessionSummary[] {
  loadOnce();
  return [...sessions.values()]
    .sort((a, b) => (a.last_at < b.last_at ? 1 : -1))
    .map((s) => ({
      id: s.id,
      title: s.title || "(new chat)",
      agent: s.agent,
      skill: s.skill,
      turn_count: s.turns.length,
      total_cost_usd: s.totalCostUsd,
      running: s.running,
      created_at: s.created_at,
      last_at: s.last_at,
    }));
}

export function deleteSession(id: string): boolean {
  loadOnce();
  const s = sessions.get(id);
  if (!s) return false;
  s.abort?.abort();
  sessions.delete(id);
  persist();
  return true;
}

export function anyTurnCapacity(): boolean {
  loadOnce();
  let running = 0;
  for (const s of sessions.values()) if (s.running) running++;
  return running < GLOBAL_RUNNING_CAP;
}

/** Claim the per-session turn lock. Returns false when a turn is already running. */
export function beginTurn(session: AssistantSession, abort: AbortController): boolean {
  if (session.running) return false;
  session.running = true;
  session.abort = abort;
  return true;
}

export function endTurn(
  session: AssistantSession,
  turn: { user: string; events: AssistantStreamEvent[]; costUsd?: number },
): void {
  session.running = false;
  session.abort = undefined;
  session.last_at = new Date().toISOString();
  if (!session.title) {
    const t = turn.user.replace(/\s+/g, " ").trim();
    session.title = t.length > 60 ? `${t.slice(0, 59)}…` : t;
  }
  if (typeof turn.costUsd === "number") session.totalCostUsd += turn.costUsd;
  session.turns.push({ at: session.last_at, user: turn.user, events: turn.events });
  if (session.turns.length > MAX_TURNS_PER_SESSION) {
    session.turns.splice(0, session.turns.length - MAX_TURNS_PER_SESSION);
  }
  persist();
}

export function stopSession(id: string): boolean {
  loadOnce();
  const s = sessions.get(id);
  if (!s?.running) return false;
  s.abort?.abort();
  return true;
}

/** Abort every running turn — the app shutdown hook. */
export function abortAllTurns(): void {
  for (const s of sessions.values()) {
    if (s.running) s.abort?.abort();
  }
}

/** TEST-ONLY: reset in-memory state (the store file is left to the test's tmp HOME). */
export function __resetSessionsForTests(): void {
  sessions.clear();
  loaded = false;
}
