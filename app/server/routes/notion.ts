import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import { readAppConfig } from "../services/appConfig.ts";
import { recordActivity } from "../services/activity.ts";
import { listSkills, readManifest, skillDir } from "../services/vault.ts";
import { hashSkillDirNormalized } from "../services/skillHash.ts";
import { NotionApi } from "../services/notion/api.ts";
import { downloadAndExtract } from "../services/notion/archive.ts";
import { gitGuard as realGitGuard, type GuardStatus } from "../services/notion/checker.ts";
import {
  NotionNotConnectedError,
  callToolJson,
  disconnectNotion,
  finishNotionAuth,
  getNotionClient,
  missingTools,
  startNotionAuth,
} from "../services/notion/connection.ts";
import {
  NoDataSourceError,
  notionOnlySummary,
  refreshNotionCache,
  runFirstLink,
  type LinkSummary,
} from "../services/notion/linker.ts";
import {
  readNotionAuth,
  readNotionCache,
  readNotionSettings,
  setNotionLink,
  writeNotionSettings,
} from "../services/notion/store.ts";
import { isSafeNameSegment } from "./skills.ts";
import {
  ResolveInputError,
  buildResolvedFiles,
  buildSnapshot,
  listConflicts,
  parseFilesResolution,
} from "../services/notion/conflicts.ts";
import { LegacyLinkError, applyResolution, keepNotion, keepVault, type SyncDeps } from "../services/notion/sync.ts";
import { readSkillFiles } from "../services/notion/linker.ts";
import { syncCacheRow } from "../services/notion/run.ts";
import { BUSY_MESSAGE, mountSyncRoutes, syncJobRunning } from "./notionSync.ts";
import { ClaudeError, claudeAvailable, type ClaudeRunner } from "../services/claude/cli.ts";
import { TooLargeError, mergeWithClaude } from "../services/claude/merge.ts";
import type { NotionLink } from "../types/vault.ts";

type ApiConn = { api: NotionApi; close(): Promise<void> };
type ClaudeStatus = { available: boolean; version?: string; reason?: string };

/** Injection points for tests (fake Notion API / archive / Claude); defaults are the real ones. */
export interface NotionRouterDeps {
  openApi?: (req: Request) => Promise<ApiConn>;
  extract?: SyncDeps["extract"];
  upload?: SyncDeps["upload"];
  claudeStatus?: () => Promise<ClaudeStatus>;
  claudeRunner?: ClaudeRunner;
  /** Multi-device guard status lookup; defaults to the real gitGuard, overridable for tests. */
  gitGuard?: (vaultPath: string) => Promise<GuardStatus>;
}

/** The vault folder changed since the client opened the conflict (→ 409 vault_changed). */
class VaultMovedError extends Error {
  constructor() {
    super("vault_changed");
  }
}

/** Notion moved since the client opened the conflict (→ 409 notion_changed). */
class NotionMovedError extends Error {
  constructor() {
    super("notion_changed");
  }
}

export const LAST_EDITED_PROPERTY = "Last edited";
/** A Notion data source id: a UUID, with or without dashes. */
const DATA_SOURCE_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

interface LinkJob {
  id: string;
  done: number;
  total: number;
  current: string;
  running: boolean;
  summary?: LinkSummary;
  error?: string;
}

/** In-memory job registry: one running link job at a time; lost on restart. */
const jobs = new Map<string, LinkJob>();
/** True while a conflict resolution is writing to the vault and Notion (it holds the job slot). */
let resolveRunning = false;
/**
 * True while a link job, a push/pull/force job or a conflict resolution is
 * running (one Notion job at a time). Combines both job registries (link
 * jobs here + push/pull/force jobs in notionSync.ts) — also the background
 * checker's isBusy check (server/index.ts).
 */
export const anyJobRunning = () => resolveRunning || [...jobs.values()].some((j) => j.running) || syncJobRunning();
/** Result of the last post-connect tool probe (undefined = no probe ran this process). */
let lastMissingTools: string[] | undefined;

/**
 * OAuth redirect URL built from the server's own origin: the local port the
 * request arrived on, never the client-controlled Host header.
 */
export function redirectUrlFor(req: Request): string {
  return `http://localhost:${req.socket.localPort}/api/notion/callback`;
}

async function getApi(req: Request): Promise<ApiConn> {
  const client = await getNotionClient(redirectUrlFor(req));
  return {
    api: new NotionApi((name, args) => callToolJson(client, name, args)),
    close: () => client.close(),
  };
}

/** Run `fn` with a connected API client (from `open`), always closing it afterwards. */
async function withApiFrom<T>(
  open: (req: Request) => Promise<ApiConn>,
  req: Request,
  fn: (api: NotionApi) => Promise<T>,
): Promise<T> {
  const { api, close } = await open(req);
  try {
    return await fn(api);
  } finally {
    await close().catch(() => {});
  }
}

/** Probe the server's tool list after a successful sign-in; never throws. */
async function probeTools(req: Request): Promise<void> {
  try {
    const client = await getNotionClient(redirectUrlFor(req));
    try {
      lastMissingTools = await missingTools(client);
    } finally {
      await client.close().catch(() => {});
    }
  } catch (err) {
    console.error(`[notion] tool probe failed: ${(err as Error).message}`);
  }
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof NotionNotConnectedError) {
    res.status(401).json({ error: "notion_not_connected" });
  } else if (err instanceof NoDataSourceError) {
    res.status(400).json({ error: (err as Error).message });
  } else {
    console.error("[notion]", err);
    res.status(502).json({ error: (err as Error).message });
  }
}

function vaultPathOr409(res: Response): string | null {
  const vp = readAppConfig().vault_path;
  if (!vp) {
    res.status(409).json({ error: "vault not configured" });
    return null;
  }
  return vp;
}

/**
 * Notion connect + link endpoints (mounted at /api/notion).
 *
 *   GET  /status                     connection + settings summary
 *   POST /connect                    start OAuth → {status:"connected"} | {status:"redirect", url}
 *   GET  /callback                   OAuth redirect target → 302 to /settings?notion=…
 *   POST /disconnect                 forget tokens
 *   GET  /data-sources               candidate Skills data sources
 *   POST /data-source                choose one (+ optionally add "Last edited")
 *   POST /check                      refresh the per-machine cache
 *   POST /link, GET /link/:id        first-run link job
 *   GET  /summary                    Notion-only rows from cache vs manifest
 *   POST /skills/:name/unlink        link state → "unlinked"
 *   POST /skills/:name/vault-only    link state → "vault-only"
 *   POST /skills/:name/relink        forget an "unlinked" link so the next Link run can re-link it
 */
export function notionRouter(deps: NotionRouterDeps = {}): Router {
  const router = Router();
  const openApi = deps.openApi ?? getApi;
  const extract = deps.extract ?? ((url: string) => downloadAndExtract(url));
  const withApi = <T>(req: Request, fn: (api: NotionApi) => Promise<T>) => withApiFrom(openApi, req, fn);
  const syncDeps = (api: NotionApi): SyncDeps => ({ api, extract, ...(deps.upload ? { upload: deps.upload } : {}) });
  const gitGuard = deps.gitGuard ?? realGitGuard;

  router.get("/status", (_req, res) => {
    const connected = !!readNotionAuth().tokens;
    const vp = readAppConfig().vault_path;
    const settings = vp ? readNotionSettings(vp) : {};
    const cache = readNotionCache();
    res.json({
      connected,
      ...(settings.data_source_id
        ? { data_source: { id: settings.data_source_id, name: settings.data_source_name ?? "" } }
        : {}),
      ...("last_edited_property" in settings ? { last_edited_property: settings.last_edited_property ?? null } : {}),
      ...(settings.linked_at ? { linked_at: settings.linked_at } : {}),
      ...(cache.checked_at ? { checked_at: cache.checked_at } : {}),
      ...(lastMissingTools ? { missing_tools: lastMissingTools } : {}),
    });
  });

  router.post("/connect", async (req, res) => {
    try {
      const r = await startNotionAuth(redirectUrlFor(req));
      if (r.status === "connected") await probeTools(req);
      res.json(r);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get("/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    try {
      if (!code) {
        const denied = typeof req.query.error === "string" ? req.query.error : "no authorization code";
        throw new Error(`Notion sign-in failed: ${denied}`);
      }
      await finishNotionAuth(redirectUrlFor(req), code, state);
      await probeTools(req);
      res.redirect(302, "/settings?notion=connected");
    } catch (err) {
      res.redirect(302, `/settings?notion=error&message=${encodeURIComponent((err as Error).message)}`);
    }
  });

  router.post("/disconnect", async (_req, res) => {
    await disconnectNotion();
    lastMissingTools = undefined;
    res.json({ ok: true });
  });

  router.get("/data-sources", async (req, res) => {
    try {
      const data_sources = await withApi(req, (api) => api.detectSkillsDataSources());
      res.json({ data_sources });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post("/data-source", async (req, res) => {
    const vp = vaultPathOr409(res);
    if (!vp) return;
    const { id, name, add_last_edited } = (req.body ?? {}) as { id?: unknown; name?: unknown; add_last_edited?: unknown };
    if (typeof id !== "string" || !id.trim()) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    if (!DATA_SOURCE_ID.test(id)) {
      res.status(400).json({ error: "id must be a Notion data source id (UUID)" });
      return;
    }
    const dsName = typeof name === "string" ? name : "";
    try {
      const { last_edited_property, warning } = await withApi(req, async (api) => {
        let has = await api.hasProperty(id, LAST_EDITED_PROPERTY, "last_edited_time");
        let warning: string | undefined;
        if (!has && add_last_edited === true) {
          try {
            await api.addLastEditedProperty(id, LAST_EDITED_PROPERTY);
            has = await api.hasProperty(id, LAST_EDITED_PROPERTY, "last_edited_time");
            if (!has) warning = `Could not verify the "${LAST_EDITED_PROPERTY}" property after adding it`;
          } catch (err) {
            warning = `Could not add "${LAST_EDITED_PROPERTY}": ${(err as Error).message}`;
          }
        }
        return { last_edited_property: has ? LAST_EDITED_PROPERTY : null, warning };
      });
      writeNotionSettings(vp, { data_source_id: id, data_source_name: dsName, last_edited_property });
      res.json({ ok: true, last_edited_property, ...(warning ? { warning } : {}) });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post("/check", async (req, res) => {
    const vp = vaultPathOr409(res);
    if (!vp) return;
    // A running job owns the cache (and refreshes it when it finishes).
    if (anyJobRunning()) {
      res.status(409).json({ error: "busy", message: BUSY_MESSAGE });
      return;
    }
    try {
      const cache = await withApi(req, (api) => refreshNotionCache(api, vp));
      recordActivity({ kind: "notion-check", skill: "*", ok: true, message: `${cache.rows.length} Notion skills` });
      res.json({ checked_at: cache.checked_at, rows: cache.rows.length });
    } catch (err) {
      if (!(err instanceof NotionNotConnectedError)) {
        recordActivity({ kind: "notion-check", skill: "*", ok: false, message: (err as Error).message });
      }
      sendError(res, err);
    }
  });

  router.post("/link", async (req, res) => {
    const vp = vaultPathOr409(res);
    if (!vp) return;
    if (anyJobRunning()) {
      res.status(409).json({ error: "a Notion job is already running" });
      return;
    }
    // Reserve the slot before any await so two requests can't both start.
    const job: LinkJob = { id: crypto.randomUUID(), done: 0, total: 0, current: "", running: true };
    jobs.clear(); // only the latest job is kept
    jobs.set(job.id, job);
    let conn: ApiConn;
    try {
      conn = await openApi(req);
    } catch (err) {
      jobs.delete(job.id);
      sendError(res, err);
      return;
    }
    res.json({ job_id: job.id });

    void (async () => {
      try {
        job.summary = await runFirstLink({ api: conn.api, extract }, vp, (done, total, skill) => {
          job.done = done;
          job.total = total;
          job.current = skill;
        });
        const s = job.summary;
        recordActivity({
          kind: "notion-link",
          skill: "*",
          ok: s.errors.length === 0,
          message: `${s.linked_in_sync.length} in sync, ${s.conflicts.length} conflicts, ${s.legacy.length} legacy, ${s.errors.length} errors`,
        });
      } catch (err) {
        job.error = (err as Error).message;
        recordActivity({ kind: "notion-link", skill: "*", ok: false, message: job.error });
      } finally {
        job.running = false;
        await conn.close().catch(() => {});
      }
    })();
  });

  router.get("/link/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: "job not found" });
      return;
    }
    const { running: _running, ...state } = job;
    res.json(state);
  });

  router.get("/summary", (_req, res) => {
    const vp = vaultPathOr409(res);
    if (!vp) return;
    res.json(notionOnlySummary(vp, readNotionCache().rows));
  });

  const setState = (state: "unlinked" | "vault-only") => (req: Request, res: Response) => {
    const vp = vaultPathOr409(res);
    if (!vp) return;
    const name = req.params.name;
    if (!isSafeNameSegment(name)) {
      res.status(400).json({ error: "invalid skill name" });
      return;
    }
    const entry = readManifest(vp).skills[name];
    if (!entry) {
      res.status(404).json({ error: `skill "${name}" not found` });
      return;
    }
    const link = entry.notion
      ? { ...entry.notion, state }
      : { page_id: "", state, linked_at: new Date().toISOString() };
    setNotionLink(vp, name, link);
    res.json({ ok: true, notion: link });
  };
  router.post("/skills/:name/unlink", setState("unlinked"));
  router.post("/skills/:name/vault-only", setState("vault-only"));

  // Forget an "unlinked" link entirely so the next Link run can match the
  // skill to a Notion page again (by name, like any never-linked skill).
  router.post("/skills/:name/relink", (req, res) => {
    const vp = vaultPathOr409(res);
    if (!vp) return;
    const name = req.params.name;
    if (!isSafeNameSegment(name)) {
      res.status(400).json({ error: "invalid skill name" });
      return;
    }
    const entry = readManifest(vp).skills[name];
    if (!entry) {
      res.status(404).json({ error: `skill "${name}" not found` });
      return;
    }
    if (entry.notion?.state !== "unlinked") {
      res.status(409).json({ error: `"${name}" is not unlinked` });
      return;
    }
    if (anyJobRunning()) {
      res.status(409).json({ error: "busy", message: BUSY_MESSAGE });
      return;
    }
    setNotionLink(vp, name, undefined);
    res.json({ ok: true });
  });

  router.get("/guard", async (_req, res) => {
    const vp = vaultPathOr409(res);
    if (!vp) return;
    try {
      res.json(await gitGuard(vp));
    } catch (err) {
      sendError(res, err);
    }
  });

  mountConflictRoutes(router, deps, withApi, extract, syncDeps);
  mountSyncRoutes(router, { openApi, withApi, extract, syncDeps, vaultPathOr409, sendError, anyJobRunning, gitGuard });

  return router;
}

// ── Conflicts ───────────────────────────────────────────────────

const RESOLVE_MODES = ["keep-vault", "keep-notion", "files"] as const;
type ResolveMode = (typeof RESOLVE_MODES)[number];

/** The skill's link for a conflict route, or a response already sent (null). */
function conflictLinkOr4xx(res: Response, vp: string, name: string): NotionLink | null {
  if (!isSafeNameSegment(name)) {
    res.status(400).json({ error: "invalid skill name" });
    return null;
  }
  const entry = readManifest(vp).skills[name];
  if (!entry) {
    res.status(404).json({ error: `skill "${name}" not found` });
    return null;
  }
  const link = entry.notion;
  if (link?.state === "legacy") {
    res.status(409).json({ error: `"${name}" is linked to a legacy Notion page and cannot be synced` });
    return null;
  }
  if (!link || link.state !== "linked" || !link.page_id) {
    res.status(409).json({ error: `"${name}" is not linked to a Notion page` });
    return null;
  }
  return link;
}

function sendConflictError(res: Response, err: unknown): void {
  if (err instanceof VaultMovedError) {
    res.status(409).json({
      error: "vault_changed",
      message: "The vault copy changed since this conflict was opened — reopen it to see the new state.",
    });
  } else if (err instanceof NotionMovedError) {
    res.status(409).json({
      error: "notion_changed",
      message: "Notion's copy changed since this conflict was opened — reopen it to see the new state.",
    });
  } else if (err instanceof ResolveInputError) {
    res.status(400).json({ error: err.message });
  } else if (err instanceof LegacyLinkError) {
    res.status(409).json({ error: err.message });
  } else {
    sendError(res, err);
  }
}

/** Download + extract Notion's current copy and build the review snapshot. */
async function loadSnapshot(
  api: NotionApi,
  extract: SyncDeps["extract"],
  vp: string,
  name: string,
  link: NotionLink,
) {
  const dl = await api.downloadSkill(link.page_id);
  const ex = await extract(dl.url);
  try {
    return buildSnapshot(vp, name, link, dl.versionId, readSkillFiles(ex.skillRoot));
  } finally {
    ex.cleanup();
  }
}

/**
 *   GET  /conflicts                  linked skills needing review
 *   GET  /conflicts/:name            fresh side-by-side snapshot (+ notion_version_id)
 *   POST /conflicts/:name/merge      Claude merge of the differing text files
 *   POST /conflicts/:name/resolve    keep-vault | keep-notion | files (needs expected_notion_version;
 *                                    files: edited=true records the result as a vault edit, else a Claude merge)
 */
function mountConflictRoutes(
  router: Router,
  deps: NotionRouterDeps,
  withApi: <T>(req: Request, fn: (api: NotionApi) => Promise<T>) => Promise<T>,
  extract: SyncDeps["extract"],
  syncDeps: (api: NotionApi) => SyncDeps,
): void {
  const claudeStatus = deps.claudeStatus ?? (() => claudeAvailable());

  router.get("/conflicts", (_req, res) => {
    const vp = vaultPathOr409(res);
    if (!vp) return;
    if (!readNotionAuth().tokens) {
      res.status(401).json({ error: "notion_not_connected" });
      return;
    }
    res.json({ skills: listConflicts(vp) });
  });

  router.get("/conflicts/:name", async (req, res) => {
    const vp = vaultPathOr409(res);
    if (!vp) return;
    const link = conflictLinkOr4xx(res, vp, req.params.name);
    if (!link) return;
    try {
      res.json(await withApi(req, (api) => loadSnapshot(api, extract, vp, req.params.name, link)));
    } catch (err) {
      sendConflictError(res, err);
    }
  });

  router.post("/conflicts/:name/merge", async (req, res) => {
    const vp = vaultPathOr409(res);
    if (!vp) return;
    const name = req.params.name;
    const link = conflictLinkOr4xx(res, vp, name);
    if (!link) return;
    const expected = (req.body ?? {}).expected_notion_version;
    const status = await claudeStatus();
    if (!status.available) {
      res.status(409).json({ error: "claude_unavailable", ...(status.reason ? { reason: status.reason } : {}) });
      return;
    }
    try {
      const snap = await withApi(req, (api) => loadSnapshot(api, extract, vp, name, link));
      if (typeof expected === "string" && expected && snap.notion_version_id !== expected) throw new NotionMovedError();
      const files = snap.files
        .filter((f) => !f.same && !f.binary && !f.too_large)
        .map((f) => ({ path: f.path, base: f.base, vault: f.vault, notion: f.notion }));
      if (files.length === 0) {
        res.status(400).json({ error: "no differing text files to merge — pick a side" });
        return;
      }
      const result = await mergeWithClaude(
        {
          skill: name,
          files,
          ...(snap.vault_edited_at ? { vaultEditedAt: snap.vault_edited_at } : {}),
          ...(snap.notion_edited_at ? { notionEditedAt: snap.notion_edited_at } : {}),
        },
        deps.claudeRunner,
      );
      res.json({ ...result, notion_version_id: snap.notion_version_id });
    } catch (err) {
      if (err instanceof TooLargeError) {
        res.status(413).json({ error: err.message, code: "claude_too_large" });
      } else if (err instanceof ClaudeError) {
        console.error("[claude-merge]", err.constructor.name, err.message.slice(0, 200));
        res.status(502).json({ error: `Claude merge failed: ${err.message}` });
      } else {
        sendConflictError(res, err);
      }
    }
  });

  router.post("/conflicts/:name/resolve", async (req, res) => {
    const vp = vaultPathOr409(res);
    if (!vp) return;
    const name = req.params.name;
    const body = (req.body ?? {}) as {
      mode?: unknown;
      expected_notion_version?: unknown;
      expected_vault_hash?: unknown;
      files?: unknown;
      binary_choices?: unknown;
      /** files mode: true when the user flipped a decision or edited by hand (history source "vault-edit"). */
      edited?: unknown;
    };
    if (!RESOLVE_MODES.includes(body.mode as ResolveMode)) {
      res.status(400).json({ error: `mode must be one of ${RESOLVE_MODES.join(", ")}` });
      return;
    }
    const mode = body.mode as ResolveMode;
    if (typeof body.expected_notion_version !== "string" || !body.expected_notion_version) {
      res.status(400).json({ error: "expected_notion_version is required" });
      return;
    }
    const expected = body.expected_notion_version;
    const expectedVault = body.expected_vault_hash;
    if (mode === "files" && typeof expectedVault !== "string" && expectedVault !== null) {
      res.status(400).json({ error: "expected_vault_hash is required for a files resolution" });
      return;
    }
    if (body.edited !== undefined && typeof body.edited !== "boolean") {
      res.status(400).json({ error: "edited must be a boolean" });
      return;
    }
    const source = body.edited === true ? "vault-edit" : "claude-merge";
    const link = conflictLinkOr4xx(res, vp, name);
    if (!link) return;
    // Take the single Notion job slot (synchronously, before any await) so a
    // run/force/link or the background check can't interleave with it.
    if (anyJobRunning()) {
      res.status(409).json({ error: "busy", message: BUSY_MESSAGE });
      return;
    }
    resolveRunning = true;
    try {
      const resolution = mode === "files" ? parseFilesResolution(body) : null;
      await withApi(req, async (api) => {
        const current = await api.downloadSkill(link.page_id);
        if (current.versionId !== expected) throw new NotionMovedError();
        if (
          (typeof expectedVault === "string" || expectedVault === null) &&
          hashSkillDirNormalized(skillDir(vp, name)) !== expectedVault
        ) {
          throw new VaultMovedError();
        }
        const d = syncDeps(api);
        if (mode === "keep-vault") {
          await keepVault(d, vp, name);
        } else if (mode === "keep-notion") {
          await keepNotion(d, vp, name);
        } else {
          const ex = await extract(current.url);
          let files: Map<string, Buffer>;
          try {
            files = buildResolvedFiles(readSkillFiles(skillDir(vp, name)), readSkillFiles(ex.skillRoot), resolution!);
          } finally {
            ex.cleanup();
          }
          await applyResolution(d, vp, name, files, source);
        }
      });
      syncCacheRow(vp, name);
      recordActivity({ kind: "notion-resolve", skill: name, ok: true, message: mode });
      const status = listSkills(vp).find((s) => s.name === name)?.notion_status ?? null;
      res.json({ ok: true, status });
    } catch (err) {
      const expectedErr =
        err instanceof NotionNotConnectedError ||
        err instanceof NotionMovedError ||
        err instanceof VaultMovedError ||
        err instanceof ResolveInputError;
      if (!expectedErr) {
        recordActivity({ kind: "notion-resolve", skill: name, ok: false, message: (err as Error).message });
      }
      sendConflictError(res, err);
    } finally {
      resolveRunning = false;
    }
  });
}

/** GET /api/claude/status → { available, version?, reason? } (mounted at /api/claude). */
export function claudeRouter(deps: { claudeStatus?: () => Promise<ClaudeStatus> } = {}): Router {
  const router = Router();
  const status = deps.claudeStatus ?? (() => claudeAvailable());
  router.get("/status", async (_req, res) => {
    const s = await status();
    res.json({ available: s.available, version: s.version ?? null, ...(s.reason ? { reason: s.reason } : {}) });
  });
  return router;
}
