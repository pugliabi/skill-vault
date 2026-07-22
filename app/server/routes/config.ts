import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import {
  cliConfigPath,
  readAppConfig,
  removeProvider,
  setVaultPath,
  upsertProvider,
  writeAppConfig,
} from "../services/appConfig.ts";
import { initVault } from "../services/vault.ts";
import { rebuildWatcher } from "../services/watcher.ts";
import type { AppConfig, Provider } from "../types/vault.ts";

export type ProviderCheck =
  | "ok"
  | "missing"
  | "not_dir"
  | "readonly"
  | "denied"
  | "unreachable";

function checkProviderPath(p: string): { status: ProviderCheck; message?: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "missing" };
    if (code === "EACCES" || code === "EPERM") return { status: "denied" };
    return { status: "unreachable", message: code ?? "unknown" };
  }
  if (!stat.isDirectory()) return { status: "not_dir" };
  try {
    fs.accessSync(p, fs.constants.W_OK);
  } catch {
    return { status: "readonly" };
  }
  return { status: "ok" };
}

export function configRouter(): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(readAppConfig());
  });

  /**
   * Full-ish replace: sets vault_path and (optionally) providers.
   * The Setup page uses this after picking a vault directory. We
   * initialize the vault on disk here so Skills.tsx can render
   * immediately after the redirect.
   *
   * Note: this does NOT wipe keys in ~/.skill-vault/config.json that
   * the app doesn't own (repo_url, machine_id, etc.). Those are
   * preserved round-trip by appConfig.writeAppConfig.
   */
  router.put("/", (req, res) => {
    const body = req.body as Partial<AppConfig>;
    if (typeof body.vault_path !== "string" || !body.vault_path) {
      res.status(400).json({ error: "vault_path is required" });
      return;
    }
    const abs = path.resolve(body.vault_path);
    try {
      fs.mkdirSync(abs, { recursive: true });
    } catch (err) {
      res.status(400).json({
        error: `Cannot create vault directory: ${(err as Error).message}`,
      });
      return;
    }
    initVault(abs);

    const next = writeAppConfig({
      vault_path: abs,
      providers: Array.isArray(body.providers) ? body.providers : undefined,
    });
    // PUT / writes the entire config — a vault_path change moves the
    // watcher's <vault>/skills root; a providers change moves the
    // provider roots. Either way the watcher needs to restart.
    // rebuildWatcher() is debounced 500ms internally, so a flurry of
    // setup calls collapses into one rebuild. Synchronous fire-and-
    // forget — the response is NOT delayed.
    rebuildWatcher();
    res.json({ ...next, _config_file: cliConfigPath() });
  });

  /** Shortcut for just updating the vault path (the Settings page uses it). */
  router.put("/vault-path", (req, res) => {
    const body = req.body as { path?: string };
    if (typeof body.path !== "string" || !body.path) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    const abs = path.resolve(body.path);
    try {
      fs.mkdirSync(abs, { recursive: true });
      initVault(abs);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    const next = setVaultPath(abs);
    // A vault_path change moves the watcher's <vault>/skills root,
    // so the active watcher must be rebuilt — same reason as PUT /.
    // Debounced internally; do NOT delay the response.
    rebuildWatcher();
    res.json(next);
  });

  /**
   * Validate every configured provider path — does it exist, is it a
   * directory, is it writable? Distinguishes missing / permission-denied /
   * unreachable (e.g. a dropped WSL or network share throws UNKNOWN, not
   * ENOENT) so the UI can explain silent push failures instead of leaving
   * a bad path looking fine.
   */
  router.get("/providers/check", (_req, res) => {
    const cfg = readAppConfig();
    const checks: Record<string, { status: ProviderCheck; message?: string }> = {};
    for (const p of cfg.providers) checks[p.id] = checkProviderPath(p.path);
    res.json({ checks });
  });

  router.post("/providers", (req, res) => {
    const body = req.body as Partial<Provider>;
    if (!body.id || !body.path) {
      res.status(400).json({ error: "id and path are required" });
      return;
    }
    const next = upsertProvider({
      id: body.id,
      path: path.resolve(body.path),
    });
    // A provider was added or replaced — the watcher needs to pick up
    // the new directory. Debounced 500ms internally so multiple rapid
    // edits collapse to one rebuild.
    rebuildWatcher();
    res.json(next);
  });

  router.delete("/providers/:id", (req, res) => {
    const next = removeProvider(req.params.id);
    // A provider was removed — the watcher needs to stop watching the
    // old directory so subsequent file changes there produce NO event.
    // Debounced 500ms internally.
    rebuildWatcher();
    res.json(next);
  });

  return router;
}
