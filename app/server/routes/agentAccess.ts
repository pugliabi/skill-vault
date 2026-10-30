/**
 * Settings → Agent access: give Claude Desktop, Claude Code and any agent
 * with a shell the vault tools, and put the bundled skill-vault skill in the
 * vault (docs/superpowers/specs/2026-10-29-agent-access-design.md).
 *
 *   GET  /api/agent-access                         status of every row
 *   POST /api/agent-access/skill/add               adopt (or refresh) the bundled skill; new → push to default targets
 *   GET  /api/agent-access/skill/prompt            the copy-paste install prompt
 *   POST /api/agent-access/skill/zip               upload-ready zip, then open the staging folder
 *   POST /api/agent-access/desktop/connect         add the MCP entry to claude_desktop_config.json
 *   POST /api/agent-access/desktop/disconnect
 *   POST /api/agent-access/claude-code/connect     claude mcp add --scope user
 *   POST /api/agent-access/claude-code/disconnect
 *
 * Connect/disconnect are settings changes: they log to the server log, not
 * the activity feed (ActivityKind has no kind for them).
 */
import fs from "node:fs";
import path from "node:path";
import { Router, type Response } from "express";
import open from "open";
import { readAppConfig, readClaudeDesktopStage } from "../services/appConfig.ts";
import { recordActivity } from "../services/activity.ts";
import { importSkills } from "../services/adoption.ts";
import { isLink, resolveLink } from "../services/linking.ts";
import { claudeAvailable as realClaudeAvailable, type ClaudeRunner } from "../services/claude/cli.ts";
import { defaultStageDir, packageFolderForClaudeDesktop, recordDesktopPackage } from "../services/desktopPackaging.ts";
import { pushSkillToProvider } from "../services/pushSkill.ts";
import { hashSkillDirNormalized } from "../services/skillHash.ts";
import { readManifest, skillDir } from "../services/vault.ts";
import {
  BUNDLED_SKILL_NAME, bundledSkillDir, bundledSkillsRoot, installPrompt, readBundledSkillMd,
} from "../services/agentAccess/bundledSkill.ts";
import {
  bridgeEntry, desktopConfigPath, entryState, getEntry, readDesktopConfig,
  realPathEnv, withEntry, withoutEntry, writeDesktopConfig, type PathEnv,
} from "../services/agentAccess/desktopConfig.ts";
import { ClaudeCodeError, connectClaudeCode, disconnectClaudeCode, readClaudeCodeEntry } from "../services/agentAccess/claudeCode.ts";
import { shimDir } from "../services/agentAccess/commandShim.ts";
import type { AgentAccessStatus } from "../types/vault.ts";
import { refuseCrossSiteWrites } from "./sameOrigin.ts";

export interface AgentAccessOptions {
  appRoot: string;
  /** The node that runs the bridge; defaults to the one running this server. */
  nodePath?: string;
  pathEnv?: () => PathEnv;
  claudeRunner?: ClaudeRunner;
  claudeAvailable?: () => Promise<{ available: boolean; reason?: string }>;
  claudeCodeEntry?: () => unknown;
  openFolder?: (dir: string) => Promise<unknown>;
}

const samePath = (a: string | undefined, b: string): boolean =>
  !!a && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

const realOr = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

/** True when `p` is a symlink or junction to `vaultCopy` (an earlier push of ours). */
function linksTo(p: string, vaultCopy: string): boolean {
  const target = isLink(p) ? resolveLink(p) : null;
  return !!target && (samePath(target, vaultCopy) || samePath(realOr(target), realOr(vaultCopy)));
}

/** Display text for sh users; the shim lives under ~/.skill-vault/bin. */
const POSIX_COMMAND = "~/.skill-vault/bin/skill-vault";

export function agentAccessRouter(opts: AgentAccessOptions): Router {
  const router = Router();
  router.use(refuseCrossSiteWrites);

  const nodePath = opts.nodePath ?? process.execPath;
  const bridgePath = path.join(opts.appRoot, "dist", "assistant-mcp.js");
  const pathEnv = opts.pathEnv ?? realPathEnv;
  const isAvailable = opts.claudeAvailable ?? (() => realClaudeAvailable());
  const ccEntry = opts.claudeCodeEntry ?? (() => readClaudeCodeEntry());
  const openFolder = opts.openFolder ?? ((dir: string) => open(dir));

  function skillRow(): AgentAccessStatus["skill"] {
    const cfg = readAppConfig();
    if (!cfg.vault_path) return { state: "no_vault", targets: [] };
    const entry = readManifest(cfg.vault_path).skills[BUNDLED_SKILL_NAME];
    const vaultCopy = skillDir(cfg.vault_path, BUNDLED_SKILL_NAME);
    if (!entry && !fs.existsSync(vaultCopy)) return { state: "not_in_vault", targets: [] };
    const origin = entry?.origin;
    // Any app checkout's bundled-skills folder, not only this one: a moved or
    // re-cloned app must still know its own copy. win32 basename splits on
    // both separators, so a vault shared with another OS reads the same.
    const ours =
      origin?.type === "dir" &&
      origin.subpath === BUNDLED_SKILL_NAME &&
      !!origin.path &&
      path.win32.basename(origin.path).toLowerCase() === path.basename(bundledSkillsRoot(opts.appRoot)).toLowerCase();
    if (!entry || !origin || !ours) return { state: "name_taken", targets: entry?.targets ?? [] };
    const vaultHash = hashSkillDirNormalized(vaultCopy);
    // One-click refresh only while the vault copy is untouched since import;
    // a locally edited copy goes through the normal Updates flow instead.
    const untouched = vaultHash === origin.content_hash;
    const differs = vaultHash !== hashSkillDirNormalized(bundledSkillDir(opts.appRoot));
    return { state: untouched && differs ? "update_available" : "in_vault", targets: entry.targets };
  }

  function desktopRow(): AgentAccessStatus["claude_desktop"] {
    const file = desktopConfigPath(pathEnv());
    if (!file) return { state: "not_installed", config_path: null };
    try {
      return { state: entryState(getEntry(readDesktopConfig(file)), (p) => fs.existsSync(p)), config_path: file };
    } catch (err) {
      return { state: "unreadable", config_path: file, error: (err as Error).message };
    }
  }

  async function claudeCodeRow(): Promise<AgentAccessStatus["claude_code"]> {
    const avail = await isAvailable();
    if (!avail.available) return { state: "cli_missing", ...(avail.reason ? { reason: avail.reason } : {}) };
    return { state: entryState(ccEntry(), (p) => fs.existsSync(p)) };
  }

  const bridgeMissing = (res: Response): boolean => {
    if (fs.existsSync(bridgePath)) return false;
    res.status(409).json({ error: "Build the app first: the bridge (dist/assistant-mcp.js) isn't built yet." });
    return true;
  };

  /** Run a settings change; any failure becomes a 409 naming `what`, never a 500. */
  async function attempt(res: Response, what: string, fn: () => void | Promise<void>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      const message = (err as Error).message;
      res.status(409).json({ error: err instanceof ClaudeCodeError ? message : `Couldn't update ${what}: ${message}` });
      return false;
    }
  }

  /** The Desktop config path, or a 404 when Claude Desktop isn't installed. */
  function desktopFile(res: Response): string | null {
    const file = desktopConfigPath(pathEnv());
    if (!file) res.status(404).json({ error: "Claude Desktop isn't installed for this user." });
    return file;
  }

  router.get("/", async (_req, res) => {
    const out: AgentAccessStatus = {
      bridge_built: fs.existsSync(bridgePath),
      skill: skillRow(),
      claude_desktop: desktopRow(),
      claude_code: await claudeCodeRow(),
      command: { windows: path.join(shimDir(), "skill-vault.cmd"), posix: POSIX_COMMAND },
    };
    res.json(out);
  });

  router.post("/skill/add", (_req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const vaultPath = cfg.vault_path;
    const row = skillRow();
    if (row.state === "name_taken") {
      res.status(409).json({ error: `Your vault already has a skill named "${BUNDLED_SKILL_NAME}" from somewhere else. Rename it to add this one.` });
      return;
    }
    const sourceRoot = bundledSkillsRoot(opts.appRoot);
    const result = importSkills(
      vaultPath,
      sourceRoot,
      [],
      undefined,
      undefined,
      [{ name: BUNDLED_SKILL_NAME, path: bundledSkillDir(opts.appRoot) }],
      { overwrite: row.state === "update_available", originContext: { type: "dir", root: sourceRoot } },
    );
    // importSkills skips (rather than fails) a missing source, an existing
    // copy without overwrite and an identical copy; only report what happened.
    if (!result.imported.includes(BUNDLED_SKILL_NAME) && !result.updated.includes(BUNDLED_SKILL_NAME)) {
      if (!fs.existsSync(bundledSkillDir(opts.appRoot))) {
        res.status(409).json({ error: `The app's bundled ${BUNDLED_SKILL_NAME} skill folder is missing. Reinstall or rebuild the app.` });
      } else if (row.state === "in_vault" && hashSkillDirNormalized(skillDir(vaultPath, BUNDLED_SKILL_NAME)) === hashSkillDirNormalized(bundledSkillDir(opts.appRoot))) {
        res.json({ ...result, pushed: [], failed: [], skill: skillRow() });
      } else if (row.state === "in_vault") {
        res.status(409).json({ error: `Your vault copy of ${BUNDLED_SKILL_NAME} has local changes — update it from Updates.` });
      } else {
        res.status(409).json({ error: `Couldn't add ${BUNDLED_SKILL_NAME} to the vault.` });
      }
      return;
    }
    recordActivity({
      kind: "adopt",
      skill: BUNDLED_SKILL_NAME,
      ok: true,
      message: row.state === "update_available" ? "updated from the app's copy" : "added from the app",
    });
    // New to the vault: push to the default targets. A refresh keeps its
    // targets, and linked targets already point at the vault copy.
    const pushed: string[] = [];
    const failed: Array<{ provider_id: string; error: string }> = [];
    if (row.state === "not_in_vault") {
      const vaultCopy = skillDir(vaultPath, BUNDLED_SKILL_NAME);
      for (const id of cfg.default_targets ?? []) {
        const provider = cfg.providers.find((p) => p.id === id);
        if (!provider) {
          failed.push({ provider_id: id, error: "not configured" });
          continue;
        }
        // A push replaces whatever is at the target. Only a link to the vault
        // copy is known to be ours; anything else may be the user's own skill.
        const dest = path.join(provider.path, BUNDLED_SKILL_NAME);
        if ((fs.existsSync(dest) || isLink(dest)) && !linksTo(dest, vaultCopy)) {
          const error = `a ${BUNDLED_SKILL_NAME} folder that isn't from your vault is already there (${dest}) — rename or remove it first`;
          failed.push({ provider_id: id, error });
          recordActivity({ kind: "push", skill: BUNDLED_SKILL_NAME, provider_id: id, ok: false, message: error });
          continue;
        }
        try {
          pushSkillToProvider(vaultPath, BUNDLED_SKILL_NAME, provider);
          pushed.push(id);
          recordActivity({ kind: "push", skill: BUNDLED_SKILL_NAME, provider_id: id, ok: true, message: "pushed" });
        } catch (err) {
          failed.push({ provider_id: id, error: (err as Error).message });
          recordActivity({ kind: "push", skill: BUNDLED_SKILL_NAME, provider_id: id, ok: false, message: (err as Error).message });
        }
      }
    }
    res.json({ ...result, pushed, failed, skill: skillRow() });
  });

  router.get("/skill/prompt", (_req, res) => {
    res.json({ prompt: installPrompt(readBundledSkillMd(opts.appRoot)) });
  });

  router.post("/skill/zip", async (_req, res) => {
    const cfg = readAppConfig();
    const stageDir = readClaudeDesktopStage() ?? (cfg.vault_path ? defaultStageDir(cfg.vault_path) : null);
    if (!stageDir) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const state = skillRow().state;
    const fromVault = !!cfg.vault_path && (state === "in_vault" || state === "update_available");
    const folder = fromVault ? skillDir(cfg.vault_path!, BUNDLED_SKILL_NAME) : bundledSkillDir(opts.appRoot);
    const zipPath = await packageFolderForClaudeDesktop(folder, stageDir, BUNDLED_SKILL_NAME);
    if (fromVault) {
      recordDesktopPackage(cfg.vault_path!, BUNDLED_SKILL_NAME, hashSkillDirNormalized(folder) ?? "empty", new Date().toISOString());
    }
    await openFolder(stageDir);
    res.json({ zip_path: zipPath, stage_dir: stageDir, from_vault: fromVault });
  });

  router.post("/desktop/connect", async (_req, res) => {
    if (bridgeMissing(res)) return;
    const file = desktopFile(res);
    if (!file) return;
    const ok = await attempt(res, file, () =>
      writeDesktopConfig(file, withEntry(readDesktopConfig(file), bridgeEntry(nodePath, bridgePath, "claude-desktop"))),
    );
    if (!ok) return;
    console.log(`[agent-access] connected Claude Desktop (${file})`);
    res.json(desktopRow());
  });

  router.post("/desktop/disconnect", async (_req, res) => {
    const file = desktopFile(res);
    if (!file) return;
    const ok = await attempt(res, file, () => {
      const config = readDesktopConfig(file);
      const next = withoutEntry(config);
      if (next !== config) writeDesktopConfig(file, next);
    });
    if (!ok) return;
    console.log(`[agent-access] disconnected Claude Desktop (${file})`);
    res.json(desktopRow());
  });

  router.post("/claude-code/connect", async (_req, res) => {
    if (bridgeMissing(res)) return;
    const ok = await attempt(res, "Claude Code", () => connectClaudeCode(nodePath, bridgePath, ccEntry(), opts.claudeRunner));
    if (!ok) return;
    console.log("[agent-access] connected Claude Code");
    res.json(await claudeCodeRow());
  });

  router.post("/claude-code/disconnect", async (_req, res) => {
    const ok = await attempt(res, "Claude Code", () => disconnectClaudeCode(ccEntry(), opts.claudeRunner));
    if (!ok) return;
    console.log("[agent-access] disconnected Claude Code");
    res.json(await claudeCodeRow());
  });

  return router;
}
