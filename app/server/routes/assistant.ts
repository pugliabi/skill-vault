/**
 * Assistant chat endpoints.
 *
 *   GET    /api/assistant/status         — selected engine readiness + plugin dir + vault check
 *   GET    /api/assistant/engines[/:id]  — engine views; PUT /engine selects, PUT /engines/:id/auth saves auth
 *   GET    /api/assistant/auth           — sign-in mode (Claude login / API key); never the key itself
 *   PUT    /api/assistant/auth           — {auth?, api_key?, workspace_id?}; "" clears a field
 *   GET    /api/assistant/sessions       — recent chats (newest first)
 *   GET    /api/assistant/sessions/:id   — one chat with its rendered turn history
 *   DELETE /api/assistant/sessions/:id   — forget a chat (aborts it if running)
 *   POST   /api/assistant/sessions/:id/stop — abort the in-flight turn
 *   POST   /api/assistant/stream         — run one turn, streaming NDJSON events
 *
 * /stream responds as `application/x-ndjson`: one JSON event per line, in
 * the AssistantStreamEvent wire shape (see services/assistant/streamEvents).
 * The first line is always `{type:"session", session_id}` so the client can
 * persist the id before anything else happens. Closing the request aborts
 * the CLI turn (whole process tree).
 */

import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { readAppConfig, readAssistantBlock, writeAssistantBlock } from "../services/appConfig.ts";
import { applyClaudeAuthPatch, claudeAuthStatus, type ClaudeAuthConfig, type ClaudeAuthPatch } from "../services/claude/auth.ts";
import type { ClaudeStreamRunner } from "../services/claude/cli.ts";
import { getServerPort } from "../services/runtime.ts";
import { buildMcpConfig } from "../services/assistant/mcpConfig.ts";
import { buildTurnContext, gatherTurnContext, pickLeadAgent, resolveReposDir } from "../services/assistant/context.ts";
import { runTurn } from "../services/assistant/turn.ts";
import { defaultRegistry, engineWorkDir, type EngineRegistry } from "../services/assistant/engines/registry.ts";
import { applyEngineAuthPatch, engineAuth, isEngineId, selectedEngine, withSelectedEngine } from "../services/assistant/engines/config.ts";
import { createEngineStates, type EngineStates } from "../services/assistant/engines/state.ts";
import { createEngineJobs, type EngineJobs } from "../services/assistant/engines/jobs.ts";
import type { InstallEvent } from "../services/assistant/engines/install.ts";
import type { TurnInput, TurnSpec } from "../services/assistant/engines/types.ts";
import {
  anyTurnCapacity,
  beginTurn,
  createSession,
  deleteSession,
  endTurn,
  getSession,
  listSessions,
  stopSession,
  type AgentKind,
  type ChatContextChip,
} from "../services/assistant/session.ts";
import { installAssistantSkills, listPluginSkills } from "../services/assistant/installer.ts";
import { composeSuggestions, gatherSuggestionInputs } from "../services/assistant/suggestions.ts";
import { addDismissal, readDismissals, readSweepCache, removeDismissal } from "../services/assistant/suggestionStore.ts";
import type { UpdateSweeper } from "../services/assistant/updateSweep.ts";
import { broadcastSse } from "./events.ts";
import { isLoopbackRequest, refuseCrossSiteWrites } from "./sameOrigin.ts";
import type { AssistantStreamEvent } from "../services/assistant/streamEvents.ts";

export interface AssistantRouterOpts {
  mode: "development" | "production";
  /** The app package root (holds package.json, assistant-plugin/, dist/). */
  appRoot: string;
  /** The background update sweeper — lets /suggestions report + trigger it. */
  sweeper?: Pick<UpdateSweeper, "runNow" | "isRunning">;
  registry?: EngineRegistry;
  states?: EngineStates;
  jobs?: EngineJobs;
  /** Tests replace the CLI spawn. */
  streamRunner?: ClaudeStreamRunner;
}

const VALID_CHIP_KINDS = new Set(["skill", "skills", "filter", "failure", "notion", "page", "suggestion"]);

function sanitizeChips(raw: unknown): ChatContextChip[] {
  if (!Array.isArray(raw)) return [];
  const chips: ChatContextChip[] = [];
  for (const c of raw.slice(0, 12)) {
    if (
      c &&
      typeof c === "object" &&
      VALID_CHIP_KINDS.has((c as { kind?: string }).kind ?? "") &&
      typeof (c as { id?: unknown }).id === "string" &&
      typeof (c as { label?: unknown }).label === "string"
    ) {
      const chip = c as ChatContextChip;
      chips.push({
        kind: chip.kind,
        id: chip.id.slice(0, 200),
        label: chip.label.slice(0, 200),
        ...(chip.data && typeof chip.data === "object" ? { data: chip.data } : {}),
      });
    }
  }
  return chips;
}

/**
 * The body of PUT /auth and PUT /engines/:id/auth: every field that's present must be a string
 * (an omitted field is kept, "" clears it). Returns the patch, or the error to answer 400 with.
 */
function parseAuthPatch(body: unknown): ClaudeAuthPatch | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: ClaudeAuthPatch = {};
  for (const k of ["auth", "api_key", "workspace_id"] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "string") return `${k} must be a string`;
    (patch as Record<string, string>)[k] = b[k] as string;
  }
  return patch;
}

export function assistantRouter(opts: AssistantRouterOpts): Router {
  const router = Router();
  router.use(refuseCrossSiteWrites);
  const registry = opts.registry ?? defaultRegistry();
  const states = opts.states ?? createEngineStates({ registry, readBlock: readAssistantBlock });
  const jobs = opts.jobs ?? createEngineJobs();

  /** Claude's fields, for PUT /auth and PUT /engines/claude/auth alike. Throws on a bad auth value. */
  const saveClaudeAuth = (patch: ClaudeAuthPatch): ClaudeAuthConfig => {
    const next = applyClaudeAuthPatch(readAssistantBlock(), patch);
    writeAssistantBlock(next);
    states.invalidate("claude");
    return next;
  };
  const pluginDir = path.join(opts.appRoot, "assistant-plugin");

  router.get("/status", async (req, res) => {
    const cfg = readAppConfig();
    const id = selectedEngine(readAssistantBlock());
    const view = await states.view(id, { refresh: req.query.refresh === "1" || req.query.refresh === "true" });
    const plugin = fs.existsSync(path.join(pluginDir, ".claude-plugin", "plugin.json"));
    const ready = await states.ready(id);
    const reason = !cfg.vault_path
      ? "vault not configured"
      : !plugin
        ? "assistant plugin bundle missing"
        : ready.ok
          ? undefined
          : ready.reason;
    res.json({ available: !reason, engine: id, label: view?.label ?? id, version: view?.version ?? undefined, reason });
  });

  router.get("/engines", async (req, res) => {
    res.json({ engines: await states.views({ refresh: req.query.refresh === "1" }) });
  });

  router.get("/engines/:id", async (req, res) => {
    const id = req.params.id;
    const mode = req.query.mode === "login" || req.query.mode === "api_key" ? req.query.mode : undefined;
    const view = isEngineId(id) ? await states.view(id, { refresh: req.query.refresh === "1", mode }) : null;
    if (!view) {
      res.status(404).json({ error: "unknown provider" });
      return;
    }
    if (view.auth.mode === "login" && view.auth.signed_in === true && jobs.signIn.current() === view.id) jobs.signIn.finish(view.id);
    res.json(view);
  });

  router.put("/engine", (req, res) => {
    const id = (req.body ?? {}).engine;
    if (!isEngineId(id) || !registry.get(id)) {
      res.status(400).json({ error: "unknown provider" });
      return;
    }
    writeAssistantBlock(withSelectedEngine(readAssistantBlock(), id));
    res.json({ engine: id });
  });

  router.put("/engines/:id/auth", async (req, res) => {
    const id = req.params.id;
    if (!isEngineId(id) || !registry.get(id)) {
      res.status(404).json({ error: "unknown provider" });
      return;
    }
    const patch = parseAuthPatch(req.body);
    if (typeof patch === "string") {
      res.status(400).json({ error: patch });
      return;
    }
    try {
      if (id === "claude") {
        saveClaudeAuth(patch); // the same path as PUT /auth
      } else {
        writeAssistantBlock(applyEngineAuthPatch(readAssistantBlock(), id, { auth: patch.auth, api_key: patch.api_key }));
        states.invalidate(id);
      }
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    res.json(await states.view(id));
  });

  router.post("/engines/:id/install", async (req, res) => {
    const id = req.params.id;
    const engine = isEngineId(id) ? registry.get(id) : undefined;
    if (!engine) {
      res.status(404).json({ error: "unknown provider" });
      return;
    }
    if (jobs.installer.isRunning()) {
      res.status(409).json({ error: "an install is already running" });
      return;
    }
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.flushHeaders?.();
    const write = (e: InstallEvent): void => {
      if (!res.writableEnded) res.write(`${JSON.stringify(e)}\n`);
    };
    let doneWritten = false;
    try {
      const r = await jobs.installer.run(engine, write);
      states.invalidate(engine.id);
      const view = await states.view(engine.id, { refresh: true });
      const found = Boolean(view?.installed);
      doneWritten = true;
      write({
        type: "done",
        ok: r.ok && found,
        ...(view?.version ? { version: view.version } : {}),
        ...(!r.ok
          ? { message: r.message }
          : found
            ? {}
            : { message: "Installed, but Skill Vault can't find it yet. Close and reopen Skill Vault, then check again." }),
      });
    } catch (err) {
      if (!doneWritten) write({ type: "done", ok: false, message: (err as Error).message || "The install failed unexpectedly." });
    }
    res.end();
  });

  router.post("/engines/:id/login", (req, res) => {
    const id = req.params.id;
    const engine = isEngineId(id) ? registry.get(id) : undefined;
    if (!engine) {
      res.status(404).json({ error: "unknown provider" });
      return;
    }
    if (!isLoopbackRequest(req)) {
      res.status(403).json({ error: "sign-in can only be started from this PC" });
      return;
    }
    const env = { ...engine.childEnv({ auth: "login" }, process.env), ...engine.loginEnv() };
    const r = jobs.signIn.start(engine, env);
    if ("error" in r) {
      res.status(r.reason === "spawn_failed" ? 500 : 409).json({ error: r.error });
      return;
    }
    states.invalidate(engine.id);
    res.json({ started: true, hint: engine.loginHint });
  });

  router.post("/engines/:id/login/cancel", (_req, res) => {
    jobs.signIn.cancel();
    res.json({ ok: true });
  });

  router.get("/auth", (_req, res) => {
    res.json(claudeAuthStatus(readAssistantBlock()));
  });

  router.put("/auth", (req, res) => {
    const patch = parseAuthPatch(req.body);
    if (typeof patch === "string") {
      res.status(400).json({ error: patch });
      return;
    }
    let next: ClaudeAuthConfig;
    try {
      next = saveClaudeAuth(patch);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    res.json(claudeAuthStatus(next));
  });

  router.get("/sessions", (_req, res) => {
    res.json({ sessions: listSessions() });
  });

  router.get("/sessions/:id", (req, res) => {
    const s = getSession(req.params.id);
    if (!s) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    res.json({
      session: {
        id: s.id,
        title: s.title || "(new chat)",
        agent: s.agent,
        skill: s.skill,
        engine: s.engine,
        chips: s.chips,
        running: s.running,
        total_cost_usd: s.totalCostUsd,
        created_at: s.created_at,
        last_at: s.last_at,
      },
      turns: s.turns,
    });
  });

  router.delete("/sessions/:id", (req, res) => {
    if (!deleteSession(req.params.id)) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    res.json({ ok: true });
  });

  router.post("/sessions/:id/stop", (req, res) => {
    res.json({ stopped: stopSession(req.params.id) });
  });

  // ── Proactive suggestions ("For you") ────────────────────────────────

  router.get("/suggestions", (_req, res) => {
    const cfg = readAppConfig();
    const running = opts.sweeper?.isRunning() ?? false;
    if (!cfg.vault_path) {
      // 200-empty keeps badge/panel code trivial on fresh installs.
      res.json({ cards: [], generated_at: new Date().toISOString(), sweep: { checked_at: null, running }, dismissed: [] });
      return;
    }
    const inputs = gatherSuggestionInputs({ vault_path: cfg.vault_path, providers: cfg.providers });
    res.json({
      cards: composeSuggestions(inputs),
      generated_at: inputs.now.toISOString(),
      sweep: { checked_at: readSweepCache(cfg.vault_path)?.checked_at ?? null, running },
      dismissed: readDismissals().map((d) => ({ id: d.id, at: d.at })),
    });
  });

  router.post("/suggestions/dismiss", (req, res) => {
    const body = (req.body ?? {}) as { id?: string; fingerprint?: string };
    if (typeof body.id !== "string" || typeof body.fingerprint !== "string") {
      res.status(400).json({ error: "id and fingerprint are required" });
      return;
    }
    addDismissal(body.id, body.fingerprint);
    broadcastSse({ type: "suggestions_changed" }); // other tabs drop the card too
    res.json({ ok: true });
  });

  router.post("/suggestions/restore", (req, res) => {
    const body = (req.body ?? {}) as { id?: string };
    if (typeof body.id !== "string") {
      res.status(400).json({ error: "id is required" });
      return;
    }
    removeDismissal(body.id);
    broadcastSse({ type: "suggestions_changed" });
    res.json({ ok: true });
  });

  router.post("/suggestions/sweep", (_req, res) => {
    if (!opts.sweeper) {
      res.status(503).json({ error: "sweeper not available in this environment" });
      return;
    }
    if (opts.sweeper.isRunning()) {
      res.json({ started: false, running: true });
      return;
    }
    const started = opts.sweeper.runNow();
    res.status(started ? 202 : 200).json({ started, running: !started });
  });

  // Install the assistant's skills (and optionally agents) into the vault
  // so they're usable from Claude Code directly, not just inside this app.
  router.post("/install-skills", (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const body = (req.body ?? {}) as { skills?: string[]; agents?: boolean; overwrite?: boolean };
    const claudeProvider = cfg.providers.find((p) => p.id === "claude");
    const agentsDir =
      body.agents === true && claudeProvider ? path.join(path.dirname(claudeProvider.path), "agents") : undefined;
    const result = installAssistantSkills({
      vaultPath: cfg.vault_path,
      pluginDir,
      skills: Array.isArray(body.skills) ? body.skills.filter((s) => typeof s === "string") : undefined,
      agentsDir,
      overwrite: body.overwrite === true,
    });
    res.json(result);
  });

  router.get("/install-skills", (_req, res) => {
    res.json({ skills: listPluginSkills(pluginDir) });
  });

  router.post("/stream", async (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const port = getServerPort();
    if (!port) {
      res.status(503).json({ error: "server port unknown — assistant unavailable in this environment" });
      return;
    }

    const body = (req.body ?? {}) as {
      session_id?: string;
      agent?: AgentKind;
      skill?: string;
      message?: string;
      context?: unknown;
    };
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    const existing = body.session_id ? getSession(body.session_id) : undefined;
    const engineId = existing?.engine ?? selectedEngine(readAssistantBlock());
    const engine = registry.get(engineId);
    if (!engine) {
      res.status(409).json({ error: "That assistant provider isn't available in this version of Skill Vault." });
      return;
    }
    const ready = await states.ready(engineId);
    if (!ready.ok) {
      res.status(409).json({ error: ready.reason });
      return;
    }

    let session = existing;
    if (body.session_id && !session) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    if (!session) {
      const agent: AgentKind = body.agent === "skill" && body.skill ? "skill" : "vault";
      session = createSession({
        agent,
        skill: agent === "skill" ? body.skill : undefined,
        chips: sanitizeChips(body.context),
        engine: engineId,
      });
    }

    if (session.running) {
      res.status(409).json({ error: "a turn is already running in this chat" });
      return;
    }
    if (!anyTurnCapacity()) {
      res.status(409).json({ error: "too many assistant turns running — wait for one to finish" });
      return;
    }

    const abort = new AbortController();
    if (!beginTurn(session, abort)) {
      res.status(409).json({ error: "a turn is already running in this chat" });
      return;
    }

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const emit = (ev: AssistantStreamEvent): void => {
      if (!res.writableEnded) res.write(`${JSON.stringify(ev)}\n`);
    };
    emit({ type: "session", session_id: session.id, engine: session.engine });

    // A dropped connection (tab closed, Stop without the POST) kills the
    // turn. NOTE: this must hang off `res`, not `req` — IncomingMessage
    // emits "close" as soon as its body is consumed (long before the
    // client goes away), which would abort every turn instantly.
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });

    const contextBlock = buildTurnContext(
      gatherTurnContext({ agent: session.agent, skill: session.skill, chips: session.chips }),
    );
    const input: TurnInput = {
      sessionId: session.id,
      engineSessionId: session.engine_session_id,
      isFirstTurn: session.turns.length === 0,
      message,
      leadAgent: pickLeadAgent(session.agent),
      contextBlock,
      mcp: buildMcpConfig({ mode: opts.mode, appRoot: opts.appRoot, port }).mcpServers.vault,
      vaultPath: cfg.vault_path,
      reposDir: resolveReposDir(cfg as unknown as Record<string, unknown>),
      pluginDir,
      workDir: engineWorkDir(engine.id),
      auth: engineAuth(readAssistantBlock(), engine.id),
      baseEnv: process.env,
    };

    try {
      fs.mkdirSync(input.workDir, { recursive: true });
      const spec: TurnSpec = engine.buildTurn(input);
      const result = await runTurn({
        spec,
        parser: engine.createParser(),
        authHint: (m) => engine.authHint(m),
        abort,
        emit,
        streamRunner: opts.streamRunner,
      });
      endTurn(session, { user: message, events: result.events, costUsd: result.costUsd, engineSessionId: result.engineSessionId });
    } catch (err) {
      // buildTurn refusals (not installed) land here too.
      endTurn(session, {
        user: message,
        events: [{ type: "error", message: (err as Error).message }],
      });
      emit({ type: "error", message: (err as Error).message });
    }

    emit({ type: "done" });
    res.end();
  });

  return router;
}
