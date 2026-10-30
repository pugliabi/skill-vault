/**
 * The assistant block of ~/.skill-vault/config.json, grown for engines:
 *
 *   assistant.engine         — which engine runs new chats (missing = claude)
 *   assistant.engines.<id>   — login vs API key (+ saved key) per non-Claude engine
 *
 * Claude's auth/api_key/workspace_id stay at the top of the block, where AI
 * tagging and the Claude merge already read them. Saved keys never leave the
 * server (state.ts reports has_saved_key only).
 */
import { applyClaudeAuthPatch, type ClaudeAuthConfig, type ClaudeAuthPatch } from "../../claude/auth.ts";
import { ENGINE_IDS, type EngineAuthConfig, type EngineId } from "./types.ts";

export type OtherEngineId = Exclude<EngineId, "claude">;

export interface AssistantBlock extends ClaudeAuthConfig {
  engine?: EngineId;
  engines?: Partial<Record<OtherEngineId, EngineAuthConfig>>;
}

export function isEngineId(v: unknown): v is EngineId {
  return typeof v === "string" && (ENGINE_IDS as string[]).includes(v);
}

export function selectedEngine(block: AssistantBlock): EngineId {
  return isEngineId(block.engine) ? block.engine : "claude";
}

export function engineAuth(block: AssistantBlock, id: EngineId): EngineAuthConfig {
  if (id === "claude") {
    return {
      auth: block.auth === "api_key" ? "api_key" : "login",
      ...(block.api_key ? { api_key: block.api_key } : {}),
      ...(block.workspace_id ? { workspace_id: block.workspace_id } : {}),
    };
  }
  const e = block.engines?.[id];
  if (!e || typeof e !== "object") return { auth: "login" };
  return { auth: e.auth === "api_key" ? "api_key" : "login", ...(e.api_key ? { api_key: e.api_key } : {}) };
}

/** PUT body: an omitted field is kept, an empty string clears it. */
export interface EngineAuthPatch {
  auth?: "login" | "api_key";
  api_key?: string;
}

export function applyEngineAuthPatch(block: AssistantBlock, id: OtherEngineId, patch: EngineAuthPatch): AssistantBlock {
  const current: EngineAuthConfig = { ...(block.engines?.[id] ?? {}) };
  if (patch.auth !== undefined) {
    if (patch.auth !== "login" && patch.auth !== "api_key") throw new Error('auth must be "login" or "api_key"');
    current.auth = patch.auth;
  }
  if (patch.api_key !== undefined) {
    const key = patch.api_key.trim();
    if (key) current.api_key = key;
    else delete current.api_key;
  }
  return { ...block, engines: { ...(block.engines ?? {}), [id]: current } };
}

export function withSelectedEngine(block: AssistantBlock, id: EngineId): AssistantBlock {
  return { ...block, engine: id };
}

/** What the setup guide's Finish writes for the assistant (services/setup/apply.ts). */
export interface AssistantSetupPatch extends ClaudeAuthPatch {
  engine?: EngineId;
  engine_auth?: EngineAuthPatch;
}

export function applyAssistantSetupPatch(block: AssistantBlock, patch: AssistantSetupPatch): AssistantBlock {
  const { engine, engine_auth, ...claude } = patch;
  let next: AssistantBlock = Object.keys(claude).length > 0 ? (applyClaudeAuthPatch(block, claude) as AssistantBlock) : { ...block };
  if (engine) next = withSelectedEngine(next, engine);
  if (engine && engine !== "claude" && engine_auth) next = applyEngineAuthPatch(next, engine, engine_auth);
  return next;
}
