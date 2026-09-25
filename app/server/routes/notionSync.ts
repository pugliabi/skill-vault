/**
 * Push/pull review + run + force endpoints (mounted inside notionRouter, at /api/notion).
 *
 *   GET  /plan?direction=push|pull            review rows (cache refreshed if stale and no job runs) + guard + stats
 *   GET  /plan/diff?direction=…&row=<id>      vault vs Notion SkillDiff for one row (Notion copy downloaded, read-only)
 *   POST /run    {direction, rows:[{id, action?}], override_guard?}   → {job_id}
 *   POST /force  {direction, skills?, override_guard?}                  → {job_id}
 *   POST /push-selected {skills, override_guard?}                      → {job_id}  (non-force push; Notion edits are never overwritten)
 *   GET  /run/:id                             job progress + per-row results
 *   GET  /legacy                              legacy-linked skills [{name, notion_title, page_id}]
 *   GET  /legacy/:name                        full vault skill vs Notion's summary page (downloaded, read-only)
 *   POST /legacy/upgrade {skills, override_guard?}  → {job_id}  (replace each summary page with the full skill)
 */
import type { Request, Response, Router } from "express";
import crypto from "node:crypto";
import { recordActivity } from "../services/activity.ts";
import { computeFilesDiff } from "../services/diff.ts";
import { gitGuard as realGitGuard, type GuardStatus } from "../services/notion/checker.ts";
import { readSkillFiles, refreshNotionCache } from "../services/notion/linker.ts";
import { CacheStaleError } from "../services/notion/plan.ts";
import { stripNotionPageId } from "../services/notion/patch.ts";
import {
  cacheIsStale,
  cacheIsValid,
  currentPlan,
  executeForce,
  executePushSelected,
  executeRow,
  forceTargets,
  planStats,
  syncCacheRow,
  type Direction,
  type RowResult,
} from "../services/notion/run.ts";
import { readNotionAuth, readNotionCache } from "../services/notion/store.ts";
import type { NotionApi } from "../services/notion/api.ts";
import { upgradeLegacySkill, type SyncDeps } from "../services/notion/sync.ts";
import { readManifest, skillDir } from "../services/vault.ts";
import { isSafeNameSegment } from "./skills.ts";

type ApiConn = { api: NotionApi; close(): Promise<void> };

/** 409 {error:"busy"} text: another Notion job holds the single job slot. */
export const BUSY_MESSAGE = "Another Notion job is running — try again when it finishes.";

/** A plan older than this (or an invalid cache) is refreshed before review. */
export const PLAN_CACHE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Multi-device guard: before a run or force, refuse when the vault is a git
 * repo behind its remote, unless `override` is set. `gitGuardFn` defaults to
 * the real `gitGuard` and is overridable so routes/tests can inject a fake
 * without touching a real git repo.
 */
export async function checkGuard(
  vaultPath: string,
  override: boolean,
  gitGuardFn: (vaultPath: string) => Promise<GuardStatus> = realGitGuard,
): Promise<void> {
  if (override) return;
  const status = await gitGuardFn(vaultPath);
  if (status.is_repo && status.behind > 0) {
    throw new GuardBlockedError({ error: "vault_behind", behind: status.behind });
  }
}

/** Thrown by checkGuard to block a run (→ 409 with `body`). */
export class GuardBlockedError extends Error {
  constructor(readonly body: Record<string, unknown>) {
    super(String(body.error ?? "guard_blocked"));
  }
}

interface SyncJob {
  id: string;
  kind: "run" | "force" | "push-selected" | "upgrade";
  direction: Direction;
  done: number;
  total: number;
  current: string;
  running: boolean;
  results: RowResult[];
  error?: string;
}

/** In-memory registry of push/pull/force jobs: only the latest is kept; lost on restart. */
const syncJobs = new Map<string, SyncJob>();

export function syncJobRunning(): boolean {
  return [...syncJobs.values()].some((j) => j.running);
}

export interface SyncRouteCtx {
  openApi: (req: Request) => Promise<ApiConn>;
  withApi: <T>(req: Request, fn: (api: NotionApi) => Promise<T>) => Promise<T>;
  extract: SyncDeps["extract"];
  syncDeps: (api: NotionApi) => SyncDeps;
  vaultPathOr409: (res: Response) => string | null;
  sendError: (res: Response, err: unknown) => void;
  /** True while any Notion job (link or sync) is running. */
  anyJobRunning: () => boolean;
  /** Multi-device guard status lookup; defaults to the real gitGuard, overridable for tests. */
  gitGuard: (vaultPath: string) => Promise<GuardStatus>;
}

/** Cache bookkeeping after a successful row — a failure here must not fail the row. */
function safeSyncCacheRow(vp: string, skill: string): void {
  try {
    syncCacheRow(vp, skill);
  } catch (err) {
    console.error(`[notion] cache update for ${skill} failed: ${(err as Error).message}`);
  }
}

function parseDirection(v: unknown): Direction | null {
  return v === "push" || v === "pull" ? v : null;
}

/** Kind segment of a row id `${direction}:${kind}:${key}`. */
function idParts(id: string): { direction: string; kind: string } {
  const [direction = "", kind = ""] = id.split(":");
  return { direction, kind };
}

export function mountSyncRoutes(router: Router, ctx: SyncRouteCtx): void {
  const notConnected401 = (res: Response): boolean => {
    if (readNotionAuth().tokens) return false;
    res.status(401).json({ error: "notion_not_connected" });
    return true;
  };

  router.get("/plan", async (req, res) => {
    const vp = ctx.vaultPathOr409(res);
    if (!vp) return;
    const direction = parseDirection(req.query.direction);
    if (!direction) {
      res.status(400).json({ error: "direction must be push or pull" });
      return;
    }
    if (notConnected401(res)) return;
    try {
      if (cacheIsStale(vp, PLAN_CACHE_MAX_AGE_MS)) {
        if (!ctx.anyJobRunning()) {
          await ctx.withApi(req, (api) => refreshNotionCache(api, vp));
        } else if (!cacheIsValid(vp)) {
          // A running job owns the cache; an unusable one can't be reviewed yet.
          res.status(409).json({ error: "busy", message: BUSY_MESSAGE });
          return;
        }
        // else: review against the current (older) cache — the job refreshes it when it ends.
      }
      const rows = currentPlan(vp, direction);
      const guard = await ctx.gitGuard(vp).catch((err) => ({
        is_repo: false,
        behind: 0,
        ahead: 0,
        error: (err as Error).message,
      }));
      res.json({ rows, guard, stats: planStats(vp, rows), checked_at: readNotionCache().checked_at ?? null });
    } catch (err) {
      ctx.sendError(res, err);
    }
  });

  router.get("/plan/diff", async (req, res) => {
    const vp = ctx.vaultPathOr409(res);
    if (!vp) return;
    const direction = parseDirection(req.query.direction);
    const id = typeof req.query.row === "string" ? req.query.row : "";
    if (!direction || !id) {
      res.status(400).json({ error: "direction and row are required" });
      return;
    }
    if (notConnected401(res)) return;
    let row;
    try {
      row = currentPlan(vp, direction).find((r) => r.id === id);
    } catch (err) {
      if (err instanceof CacheStaleError) {
        res.status(409).json({ error: "plan_stale", message: "The Notion check expired — reload the plan." });
        return;
      }
      throw err;
    }
    if (!row) {
      res.status(404).json({ error: "row not found — reload the plan" });
      return;
    }
    const vaultFiles = row.skill ? readSkillFiles(skillDir(vp, row.skill)) : new Map<string, Buffer>();
    // Deleted-in-Notion rows (vault folder still there) have no Notion copy to fetch.
    const notionGone = row.kind === "deleted" && vaultFiles.size > 0;
    try {
      let notionFiles = new Map<string, Buffer>();
      let notionVersion: string | null = null;
      if (row.page_id && !notionGone) {
        await ctx.withApi(req, async (api) => {
          const dl = await api.downloadSkill(row.page_id!);
          const ex = await ctx.extract(dl.url);
          try {
            notionFiles = readSkillFiles(ex.skillRoot);
          } finally {
            ex.cleanup();
          }
          notionVersion = dl.versionId;
        });
        const md = notionFiles.get("SKILL.md");
        if (md) notionFiles.set("SKILL.md", Buffer.from(stripNotionPageId(md.toString("utf8")), "utf8"));
      }
      res.json({
        ...computeFilesDiff(vaultFiles, notionFiles),
        labels: { left: "vault", right: "notion" },
        notion_available: !!notionVersion,
        notion_version_id: notionVersion,
      });
    } catch (err) {
      ctx.sendError(res, err);
    }
  });

  /**
   * Reserve the single job slot synchronously (before any await), then run
   * the guard and open the Notion connection. On failure the slot is freed
   * and an error response sent; on success `{job_id}` is sent and `work`
   * runs in the background with the open connection.
   */
  async function startJob(
    req: Request,
    res: Response,
    vp: string,
    kind: SyncJob["kind"],
    direction: Direction,
    overrideGuard: boolean,
    work: (job: SyncJob, api: NotionApi) => Promise<void>,
  ): Promise<void> {
    if (ctx.anyJobRunning()) {
      res.status(409).json({ error: "a Notion job is already running" });
      return;
    }
    const job: SyncJob = { id: crypto.randomUUID(), kind, direction, done: 0, total: 0, current: "", running: true, results: [] };
    syncJobs.clear(); // only the latest job is kept
    syncJobs.set(job.id, job);

    let conn: ApiConn;
    try {
      await checkGuard(vp, overrideGuard, ctx.gitGuard);
      conn = await ctx.openApi(req);
    } catch (err) {
      syncJobs.delete(job.id);
      if (err instanceof GuardBlockedError) res.status(409).json(err.body);
      else ctx.sendError(res, err);
      return;
    }
    res.json({ job_id: job.id });

    void (async () => {
      try {
        await work(job, conn.api);
        if (job.results.some((r) => r.ok)) {
          try {
            await refreshNotionCache(conn.api, vp);
          } catch (err) {
            console.error(`[notion] post-run check failed: ${(err as Error).message}`);
          }
        }
        const failed = job.results.filter((r) => !r.ok).length;
        recordActivity({
          kind: "notion-sync",
          skill: "*",
          ok: failed === 0,
          message: `${kind} ${direction}: ${job.results.length - failed} ok, ${failed} failed`,
        });
      } catch (err) {
        job.error = (err as Error).message;
        recordActivity({ kind: "notion-sync", skill: "*", ok: false, message: job.error });
      } finally {
        job.current = "";
        job.running = false;
        await conn.close().catch(() => {});
      }
    })();
  }

  router.post("/run", async (req, res) => {
    const vp = ctx.vaultPathOr409(res);
    if (!vp) return;
    const body = (req.body ?? {}) as { direction?: unknown; rows?: unknown; override_guard?: unknown };
    const direction = parseDirection(body.direction);
    if (!direction) {
      res.status(400).json({ error: "direction must be push or pull" });
      return;
    }
    const valid =
      Array.isArray(body.rows) &&
      body.rows.length > 0 &&
      body.rows.every(
        (r) =>
          r && typeof r === "object" && typeof (r as any).id === "string" &&
          ((r as any).action === undefined || typeof (r as any).action === "string"),
      );
    if (!valid) {
      res.status(400).json({ error: "rows must be a non-empty array of {id, action?}" });
      return;
    }
    const requested = body.rows as Array<{ id: string; action?: string }>;
    for (const r of requested) {
      const p = idParts(r.id);
      if (p.kind === "conflict") {
        res.status(400).json({ error: "conflict rows can't be run — resolve them in Conflicts", row: r.id });
        return;
      }
      if (p.direction !== direction) {
        res.status(400).json({ error: `row ${r.id} is not a ${direction} row` });
        return;
      }
    }
    let plan;
    try {
      plan = currentPlan(vp, direction);
    } catch (err) {
      if (err instanceof CacheStaleError) {
        res.status(409).json({ error: "plan_stale", message: "The Notion check expired — reload the plan." });
        return;
      }
      throw err;
    }
    // A row that became a conflict since the review is also refused outright.
    const nowConflict = requested.find((r) => plan.find((p) => p.id === r.id)?.kind === "conflict");
    if (nowConflict) {
      res.status(400).json({ error: "conflict rows can't be run — resolve them in Conflicts", row: nowConflict.id });
      return;
    }
    if (notConnected401(res)) return;

    await startJob(req, res, vp, "run", direction, body.override_guard === true, async (job, api) => {
      const d = ctx.syncDeps(api);
      const cacheRows = readNotionCache().rows;
      const seen = new Set<string>();
      job.total = requested.length;
      for (const r of requested) {
        if (seen.has(r.id)) {
          job.done++;
          continue;
        }
        seen.add(r.id);
        const row = plan.find((p) => p.id === r.id);
        job.current = row?.skill ?? row?.title ?? r.id;
        if (!row) {
          job.results.push({ id: r.id, ok: false, error: "no longer in the plan — reload and review again" });
        } else {
          try {
            const out = await executeRow(d, vp, row, r.action, cacheRows);
            if (out.skill) safeSyncCacheRow(vp, out.skill);
            job.results.push({ id: r.id, ok: true, message: out.message });
          } catch (err) {
            job.results.push({ id: r.id, ok: false, error: (err as Error).message });
          }
        }
        job.done++;
      }
    });
  });

  router.post("/force", async (req, res) => {
    const vp = ctx.vaultPathOr409(res);
    if (!vp) return;
    const body = (req.body ?? {}) as { direction?: unknown; skills?: unknown; override_guard?: unknown };
    const direction = parseDirection(body.direction);
    if (!direction) {
      res.status(400).json({ error: "direction must be push or pull" });
      return;
    }
    let skills: string[] | undefined;
    if (body.skills !== undefined) {
      if (!Array.isArray(body.skills) || body.skills.length === 0 || !body.skills.every(isSafeNameSegment)) {
        res.status(400).json({ error: "skills must be a non-empty array of skill names" });
        return;
      }
      skills = body.skills as string[];
    }
    if (notConnected401(res)) return;
    const targets = forceTargets(vp, direction, skills);

    await startJob(req, res, vp, "force", direction, body.override_guard === true, async (job, api) => {
      const d = ctx.syncDeps(api);
      job.total = targets.length;
      for (const t of targets) {
        job.current = t.skill;
        try {
          const message = await executeForce(d, vp, direction, t);
          safeSyncCacheRow(vp, t.skill);
          job.results.push({ id: t.id, ok: true, message });
        } catch (err) {
          job.results.push({ id: t.id, ok: false, error: (err as Error).message });
        }
        job.done++;
      }
    });
  });

  router.post("/push-selected", async (req, res) => {
    const vp = ctx.vaultPathOr409(res);
    if (!vp) return;
    const body = (req.body ?? {}) as { skills?: unknown; override_guard?: unknown };
    if (!Array.isArray(body.skills) || body.skills.length === 0 || !body.skills.every(isSafeNameSegment)) {
      res.status(400).json({ error: "skills must be a non-empty array of skill names" });
      return;
    }
    const skills = body.skills as string[];
    if (notConnected401(res)) return;
    const targets = forceTargets(vp, "push", skills).map((t) => ({ ...t, id: `push-selected:${t.skill}` }));

    await startJob(req, res, vp, "push-selected", "push", body.override_guard === true, async (job, api) => {
      const d = ctx.syncDeps(api);
      job.total = targets.length;
      for (const t of targets) {
        job.current = t.skill;
        try {
          const message = await executePushSelected(d, vp, t);
          safeSyncCacheRow(vp, t.skill);
          job.results.push({ id: t.id, ok: true, message });
        } catch (err) {
          job.results.push({ id: t.id, ok: false, error: (err as Error).message });
        }
        job.done++;
      }
    });
  });

  // ── Legacy summary pages → full skills ─────────────────────────

  router.get("/legacy", (_req, res) => {
    const vp = ctx.vaultPathOr409(res);
    if (!vp) return;
    const skills = Object.entries(readManifest(vp).skills)
      .filter(([, e]) => e.notion?.state === "legacy")
      .map(([name, e]) => ({ name, notion_title: e.notion!.notion_title ?? null, page_id: e.notion!.page_id }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ skills });
  });

  router.get("/legacy/:name", async (req, res) => {
    const vp = ctx.vaultPathOr409(res);
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
    const link = entry.notion;
    if (link?.state !== "legacy" || !link.page_id) {
      res.status(409).json({ error: `"${name}" is not linked to a legacy Notion page` });
      return;
    }
    if (notConnected401(res)) return;
    try {
      const vaultFiles = readSkillFiles(skillDir(vp, name));
      let notionFiles = new Map<string, Buffer>();
      let notionVersion = "";
      await ctx.withApi(req, async (api) => {
        const dl = await api.downloadSkill(link.page_id);
        const ex = await ctx.extract(dl.url);
        try {
          notionFiles = readSkillFiles(ex.skillRoot);
        } finally {
          ex.cleanup();
        }
        notionVersion = dl.versionId;
      });
      const md = notionFiles.get("SKILL.md");
      if (md) notionFiles.set("SKILL.md", Buffer.from(stripNotionPageId(md.toString("utf8")), "utf8"));
      res.json({
        name,
        notion_title: link.notion_title ?? null,
        page_id: link.page_id,
        vault_files: [...vaultFiles.keys()].sort(),
        notion_files: [...notionFiles.keys()].sort(),
        diff: computeFilesDiff(vaultFiles, notionFiles),
        labels: { left: "vault (full skill)", right: "notion (summary)" },
        notion_version_id: notionVersion,
      });
    } catch (err) {
      ctx.sendError(res, err);
    }
  });

  router.post("/legacy/upgrade", async (req, res) => {
    const vp = ctx.vaultPathOr409(res);
    if (!vp) return;
    const body = (req.body ?? {}) as { skills?: unknown; override_guard?: unknown };
    if (!Array.isArray(body.skills) || body.skills.length === 0 || !body.skills.every(isSafeNameSegment)) {
      res.status(400).json({ error: "skills must be a non-empty array of skill names" });
      return;
    }
    const skills = [...new Set(body.skills as string[])];
    if (notConnected401(res)) return;

    await startJob(req, res, vp, "upgrade", "push", body.override_guard === true, async (job, api) => {
      const d = ctx.syncDeps(api);
      job.total = skills.length;
      for (const skill of skills) {
        job.current = skill;
        const id = `upgrade:${skill}`;
        try {
          await upgradeLegacySkill(d, vp, skill);
          safeSyncCacheRow(vp, skill);
          job.results.push({ id, ok: true, message: `upgraded — Notion title is now "${skill}"` });
        } catch (err) {
          job.results.push({ id, ok: false, error: (err as Error).message });
        }
        job.done++;
      }
    });
  });

  router.get("/run/:id", (req, res) => {
    const job = syncJobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: "job not found" });
      return;
    }
    res.json(job);
  });
}
