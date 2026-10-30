/**
 * What Settings, the chat panel and /stream need to know about each engine —
 * installed? which version? signed in? — cached for 30 s so polling the UI
 * doesn't spawn a CLI on every render. A changed auth mode or key skips the
 * cache; install, sign-in and auth changes invalidate it explicitly.
 */
import { engineAuth, selectedEngine, type AssistantBlock } from "./config.ts";
import type { EngineRegistry } from "./registry.ts";
import {
  installDisplay,
  type AssistantEngine,
  type EngineAuthConfig,
  type EngineAuthStatus,
  type EngineDetect,
  type EngineId,
} from "./types.ts";

export interface EngineView {
  id: EngineId;
  label: string;
  selected: boolean;
  installed: boolean;
  version: string | null;
  verified_version: string;
  reason: string | null;
  subagents: boolean;
  auth: {
    mode: "login" | "api_key";
    signed_in: boolean | null;
    account: string | null;
    has_saved_key: boolean;
    env_key_present: boolean;
  };
  install: { label: string; display: string; source: string }[];
  login_hint: string;
}

export interface ViewOpts {
  refresh?: boolean;
  /**
   * Report sign-in for this mode instead of the saved one. The setup guide's
   * sign-in runs before Finish saves the mode, so it asks for "login".
   */
  mode?: "login" | "api_key";
}

export interface EngineStates {
  view(id: EngineId, opts?: ViewOpts): Promise<EngineView | null>;
  views(opts?: { refresh?: boolean }): Promise<EngineView[]>;
  invalidate(id?: EngineId): void;
  ready(id: EngineId): Promise<{ ok: true } | { ok: false; reason: string }>;
}

const TTL_MS = 30_000;

export function createEngineStates(deps: {
  registry: EngineRegistry;
  readBlock: () => AssistantBlock;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): EngineStates {
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const cache = new Map<EngineId, { at: number; key: string; detect: EngineDetect; auth: EngineAuthStatus }>();

  async function probe(engine: AssistantEngine, refresh: boolean, cfg: EngineAuthConfig) {
    const key = `${cfg.auth ?? "login"}|${cfg.api_key ? "key" : ""}`;
    const hit = cache.get(engine.id);
    if (!refresh && hit && hit.key === key && now() - hit.at < TTL_MS) return hit;
    const detect = await engine.detect({ refresh });
    const auth: EngineAuthStatus = detect.installed
      ? await engine.authStatus(cfg)
      : { signed_in: false, method: cfg.auth === "api_key" ? "api_key" : "login" };
    const entry = { at: now(), key, detect, auth };
    cache.set(engine.id, entry);
    return entry;
  }

  async function view(id: EngineId, opts: ViewOpts = {}): Promise<EngineView | null> {
    const engine = deps.registry.get(id);
    if (!engine) return null;
    const block = deps.readBlock();
    const saved = engineAuth(block, id);
    const cfg: EngineAuthConfig = opts.mode ? { ...saved, auth: opts.mode } : saved;
    const { detect, auth } = await probe(engine, opts.refresh === true, cfg);
    return {
      id,
      label: engine.label,
      selected: selectedEngine(block) === id,
      installed: detect.installed,
      version: detect.version ?? null,
      verified_version: engine.verifiedVersion,
      reason: detect.reason ?? null,
      subagents: engine.subagents,
      auth: {
        mode: cfg.auth === "api_key" ? "api_key" : "login",
        signed_in: auth.signed_in,
        account: auth.account ?? null,
        has_saved_key: Boolean(cfg.api_key),
        env_key_present: engine.apiKeyEnv.some((k) => Boolean(env[k])),
      },
      install: engine.install.map((s) => ({ label: s.label, display: installDisplay(s), source: s.source })),
      login_hint: engine.loginHint,
    };
  }

  return {
    view,
    async views(opts = {}) {
      const all = await Promise.all(deps.registry.list().map((e) => view(e.id, opts)));
      return all.filter((v): v is EngineView => v !== null);
    },
    invalidate(id) {
      if (id) cache.delete(id);
      else cache.clear();
    },
    async ready(id) {
      const v = await view(id);
      if (!v) return { ok: false, reason: "That assistant provider isn't available in this version of Skill Vault." };
      if (!v.installed) return { ok: false, reason: `${v.label} isn't installed — install it in Settings → AI assistant.` };
      if (v.auth.mode === "api_key" && !v.auth.has_saved_key && !v.auth.env_key_present) {
        return { ok: false, reason: `${v.label} has no API key — add one in Settings → AI assistant.` };
      }
      if (v.auth.mode === "login" && v.auth.signed_in === false) {
        return { ok: false, reason: `${v.label} isn't signed in — sign in in Settings → AI assistant.` };
      }
      return { ok: true };
    },
  };
}
