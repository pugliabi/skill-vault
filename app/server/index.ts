/**
 * Express app factory. Wires the JSON API under /api/* and serves the
 * React client either via Vite middleware in dev or as static files
 * from `dist/public` in production.
 *
 * Called by `launcher.ts` which adds the net.listen and browser-open
 * behavior. Keeping app creation separate from listen makes it trivial
 * to test routes with supertest later without booting a real port.
 */

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { configRouter } from "./routes/config.ts";
import { skillsRouter } from "./routes/skills.ts";
import { historyRouter } from "./routes/history.ts";
import { adoptRouter } from "./routes/adopt.ts";
import { pushRouter } from "./routes/push.ts";
import { pullRouter } from "./routes/pull.ts";
import { syncRouter } from "./routes/sync.ts";
import { diffRouter } from "./routes/diff.ts";
import { devicesRouter } from "./routes/devices.ts";
import { importRouter } from "./routes/import.ts";
import { fixRouter } from "./routes/fix.ts";
import { tagsRouter } from "./routes/tags.ts";
import { desktopRouter } from "./routes/desktop.ts";
import { openclawRouter } from "./routes/openclaw.ts";
import { notionRouter } from "./routes/notion.ts";
import {
  eventsRouter,
  broadcastSse,
  closeAllSse,
} from "./routes/events.ts";
import { activityRouter } from "./routes/activity.ts";
import { subscribeActivity } from "./services/activity.ts";
import {
  createVaultWatcher,
  setActiveWatcher,
  setActiveWatcherBridge,
  getActiveWatcher,
  type VaultWatcher,
} from "./services/watcher.ts";
import { readAppConfig } from "./services/appConfig.ts";
import { createHistoryRecorder, scanForUnrecordedChanges } from "./services/historyRecorder.ts";
import { findFreePort } from "./services/freePort.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");

export interface CreateAppOptions {
  /** "development" enables Vite middleware + HMR; "production" serves dist/public. */
  mode: "development" | "production";
}

export async function createApp(opts: CreateAppOptions): Promise<Express> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Compact request log so failures are visible during dev without spam.
  app.use((req, _res, next) => {
    if (req.path.startsWith("/api")) {
      console.log(`[api] ${req.method} ${req.path}`);
    }
    next();
  });

  // ── Live updates: watcher + SSE bridge ──────────────────────────
  //
  // Wires the filesystem watcher (Plan 02) and activity ring buffer
  // (Plan 01) into the SSE channel (this plan). Order matters:
  //   1. Define the listener bridge ONCE so both the initial watcher
  //      and any later rebuildWatcher() result attach the same SSE
  //      listeners — without this, a config-driven rebuild would
  //      orphan the original chokidar instance's broadcast wiring.
  //   2. Start the initial watcher (if vault_path is configured) and
  //      register it as the singleton's active watcher.
  //   3. Subscribe the activity ring buffer to broadcastSse, capturing
  //      the unsubscribe handle for the cleanup hook.
  //   4. Hang cleanup off app.locals so launcher.ts can call it on
  //      SIGINT/SIGTERM before server.close().
  const historyRecorder = createHistoryRecorder({
    getVaultPath: () => readAppConfig().vault_path,
  });

  const attachWatcherListeners = (w: VaultWatcher): void => {
    w.on("skill_changed", (p) =>
      broadcastSse({ type: "skill_changed", name: p.name }),
    );
    w.on("skill_changed", (p) => historyRecorder.onSkillChanged(p.name));
    w.on("provider_changed", (p) =>
      broadcastSse({
        type: "provider_changed",
        provider_id: p.provider_id,
        skill: p.skill,
      }),
    );
  };
  setActiveWatcherBridge(attachWatcherListeners);

  const initialCfg = readAppConfig();
  if (initialCfg.vault_path) {
    const initialWatcher = createVaultWatcher({
      vaultPath: initialCfg.vault_path,
      providers: initialCfg.providers,
    });
    attachWatcherListeners(initialWatcher);
    setActiveWatcher(initialWatcher);
  } else {
    setActiveWatcher(null);
  }

  // Startup scan: catch skill edits/deletes made while the app was
  // closed (e.g. an agent editing the vault directly, or git pull).
  // Deferred with setImmediate so it never blocks server boot.
  if (initialCfg.vault_path) {
    const vp = initialCfg.vault_path;
    setImmediate(() => {
      try {
        const r = scanForUnrecordedChanges(vp);
        console.log(
          `[history] startup scan: ${r.recorded} recorded, ${r.deleted} deletions, ${r.gc} objects collected`,
        );
      } catch (err) {
        console.error("[history] startup scan failed:", err);
      }
    });
  }

  const unsubActivity = subscribeActivity((entry) =>
    broadcastSse({ type: "activity", entry }),
  );

  // Cleanup hook — launcher.ts invokes this before server.close() so
  // chokidar tears down cleanly on Ctrl+C and the SSE clients receive
  // a final FIN. The "active" watcher may have been swapped by
  // rebuildWatcher(), so close whichever one is currently registered.
  app.locals.cleanupLiveUpdates = async (): Promise<void> => {
    unsubActivity();
    closeAllSse();
    historyRecorder.flush();
    const current = getActiveWatcher();
    if (current) {
      try {
        await current.close();
      } catch (err) {
        console.error("[cleanup] watcher close threw:", err);
      }
    }
    setActiveWatcher(null);
  };

  app.use("/api/config", configRouter());
  app.use("/api/skills", skillsRouter());
  app.use("/api/history", historyRouter());
  app.use("/api/adopt", adoptRouter());
  app.use("/api/push", pushRouter());
  app.use("/api/pull", pullRouter());
  app.use("/api/sync", syncRouter());
  app.use("/api/diff", diffRouter());
  app.use("/api/devices", devicesRouter());
  app.use("/api/import", importRouter());
  app.use("/api/fix", fixRouter());
  app.use("/api/tags", tagsRouter());
  app.use("/api/desktop", desktopRouter());
  app.use("/api/openclaw", openclawRouter());
  app.use("/api/notion", notionRouter());
  app.use("/api/activity", activityRouter());
  app.use("/api/events", eventsRouter());

  // JSON error handler for API routes — anything the route handlers
  // let bubble up gets a clean 500 response instead of an HTML stack.
  app.use(
    "/api",
    (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      console.error("[api] unhandled error:", err);
      const message = err instanceof Error ? err.message : String(err);
      // Honor an explicit status when the error carries one (e.g. body-parser
      // raises a SyntaxError with .status 400 / .type "entity.parse.failed" on
      // malformed JSON). Everything else is a genuine 500. Without this, a bad
      // request body reads as a server error and sends callers debugging the
      // wrong thing.
      const e = err as { status?: number; statusCode?: number; type?: string };
      const status =
        typeof e.status === "number"
          ? e.status
          : typeof e.statusCode === "number"
            ? e.statusCode
            : e.type === "entity.parse.failed"
              ? 400
              : 500;
      res.status(status).json({ error: message });
    },
  );

  if (opts.mode === "development") {
    // Vite middleware mode: the Express app serves `/` by letting Vite
    // handle HMR, template transforms, etc. The client root lives in
    // `app/client/` (see vite.config.ts).
    const { createServer: createViteServer } = await import("vite");
    // Vite's HMR websocket server defaults to a hardcoded port (24678).
    // Running a second instance of this app on the same machine would
    // otherwise collide on that port ("WebSocket server error: Port is
    // already in use"), sending the client into an HMR reload loop.
    // Probe for a free port up front and pin HMR to it instead.
    const hmrPort = await findFreePort();
    const vite = await createViteServer({
      root: path.join(APP_ROOT, "client"),
      // allowedHosts: true disables the host-header check so the dev
      // server is reachable via LAN IP / hostname when --host 0.0.0.0
      // is used. Without this, Vite rejects non-localhost requests with
      // "Blocked request. This host is not allowed."
      server: { middlewareMode: true, allowedHosts: true, hmr: { port: hmrPort } },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production: serve the Vite-built bundle from dist/public. The
    // SPA fallback sends index.html for any non-api GET so wouter's
    // client-side routing works on deep-link reload.
    const dist = path.join(APP_ROOT, "dist/public");
    if (!fs.existsSync(dist)) {
      throw new Error(
        `Production bundle not found at ${dist}. Run 'npm run build:client' first.`,
      );
    }
    app.use(express.static(dist));
    // Express 5 (path-to-regexp v8) rejects a bare "*" string route
    // ("Missing parameter name at index 1: *"), so match every non-API
    // GET with a RegExp instead. Excluding /api keeps 404s from API
    // routes from being swallowed by the index.html fallback.
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(dist, "index.html"));
    });
  }

  return app;
}
