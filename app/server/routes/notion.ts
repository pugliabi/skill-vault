import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import { readAppConfig } from "../services/appConfig.ts";
import { recordActivity } from "../services/activity.ts";
import { readManifest } from "../services/vault.ts";
import { NotionApi } from "../services/notion/api.ts";
import { downloadAndExtract } from "../services/notion/archive.ts";
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
/** Result of the last post-connect tool probe (undefined = no probe ran this process). */
let lastMissingTools: string[] | undefined;

/**
 * OAuth redirect URL built from the server's own origin: the local port the
 * request arrived on, never the client-controlled Host header.
 */
export function redirectUrlFor(req: Request): string {
  return `http://localhost:${req.socket.localPort}/api/notion/callback`;
}

async function getApi(req: Request): Promise<{ api: NotionApi; close(): Promise<void> }> {
  const client = await getNotionClient(redirectUrlFor(req));
  return {
    api: new NotionApi((name, args) => callToolJson(client, name, args)),
    close: () => client.close(),
  };
}

/** Run `fn` with a connected API client, always closing it afterwards. */
async function withApi<T>(req: Request, fn: (api: NotionApi) => Promise<T>): Promise<T> {
  const { api, close } = await getApi(req);
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
 */
export function notionRouter(): Router {
  const router = Router();

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
    if ([...jobs.values()].some((j) => j.running)) {
      res.status(409).json({ error: "a link job is already running" });
      return;
    }
    let conn: Awaited<ReturnType<typeof getApi>>;
    try {
      conn = await getApi(req);
    } catch (err) {
      sendError(res, err);
      return;
    }
    const job: LinkJob = { id: crypto.randomUUID(), done: 0, total: 0, current: "", running: true };
    jobs.clear(); // only the latest job is kept
    jobs.set(job.id, job);
    res.json({ job_id: job.id });

    void (async () => {
      try {
        job.summary = await runFirstLink({ api: conn.api, extract: (url) => downloadAndExtract(url) }, vp, (done, total, skill) => {
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

  return router;
}
