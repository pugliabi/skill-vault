import { Router } from "express";
import { readAppConfig } from "../services/appConfig.ts";
import { recordActivity } from "../services/activity.ts";
import {
  diffVersion,
  listDeletedSkills,
  listVersions,
  readHistoryConfig,
  restoreVersion,
  writeHistoryConfig,
  type HistoryVersion,
} from "../services/history.ts";

/**
 * `:name` route params are not validated by services/skillName.ts's
 * validateSkillName (that function checks NEW/uniqueness rules for
 * creating or renaming a skill, not "is this safe to use as a path
 * segment"). Since routes/skills.ts itself does not re-validate
 * `req.params.name` for its existing-skill routes (GET/PATCH/DELETE
 * /:name), we mirror that same shape here but add the minimal guard
 * needed because `name` flows into filesystem paths under
 * `.history/skills/<name>/`: reject anything that isn't a plain path
 * segment (no "/", "\", "..", and non-empty).
 */
function isSafeNameSegment(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("..")
  );
}

/** Version id format, per history.ts's newId(): `${base36 timestamp}-${6 hex chars}`. */
const VERSION_ID_RE = /^[a-z0-9]+-[a-f0-9]{6}$/;

/** "not found" errors from the service → 404; anything else (e.g. an unreadable versions.json) → 500. */
function errorStatus(err: unknown): number {
  return /not found/.test((err as Error).message) ? 404 : 500;
}

function summary(v: HistoryVersion) {
  const { files, ...rest } = v;
  return { ...rest, file_count: Object.keys(files).length };
}

export function historyRouter(): Router {
  const router = Router();

  const vault = (res: import("express").Response): string | null => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return null;
    }
    return cfg.vault_path;
  };

  // Meta routes use "_"-prefixed segments, which are never valid skill
  // names, so they can't shadow a skill called "config" or "deleted".
  router.get("/_config", (_req, res) => {
    const vp = vault(res);
    if (vp) res.json(readHistoryConfig(vp));
  });

  router.put("/_config", (req, res) => {
    const vp = vault(res);
    if (!vp) return;
    try {
      writeHistoryConfig(vp, { max_versions: Number(req.body?.max_versions) });
      res.json(readHistoryConfig(vp));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get("/_deleted", (_req, res) => {
    const vp = vault(res);
    if (vp) res.json({ skills: listDeletedSkills(vp) });
  });

  router.get("/:name", (req, res) => {
    if (!isSafeNameSegment(req.params.name)) {
      res.status(400).json({ error: "invalid skill name" });
      return;
    }
    const vp = vault(res);
    if (!vp) return;
    try {
      res.json({ versions: listVersions(vp, req.params.name).map(summary) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/:name/:id/diff", (req, res) => {
    if (!isSafeNameSegment(req.params.name)) {
      res.status(400).json({ error: "invalid skill name" });
      return;
    }
    if (!VERSION_ID_RE.test(req.params.id)) {
      res.status(400).json({ error: "invalid version id" });
      return;
    }
    const vp = vault(res);
    if (!vp) return;
    try {
      const against = (req.query.against as string | undefined) ?? "current";
      if (against !== "current" && !VERSION_ID_RE.test(against)) {
        res.status(400).json({ error: "invalid version id" });
        return;
      }
      res.json(diffVersion(vp, req.params.name, req.params.id, against));
    } catch (err) {
      res.status(errorStatus(err)).json({ error: (err as Error).message });
    }
  });

  router.post("/:name/:id/restore", (req, res) => {
    if (!isSafeNameSegment(req.params.name)) {
      res.status(400).json({ error: "invalid skill name" });
      return;
    }
    if (!VERSION_ID_RE.test(req.params.id)) {
      res.status(400).json({ error: "invalid version id" });
      return;
    }
    const vp = vault(res);
    if (!vp) return;
    const name = req.params.name;
    try {
      const v = restoreVersion(vp, name, req.params.id);
      recordActivity({ kind: "restore", skill: name, ok: true, message: v.note ?? `restored version from ${v.at}` });
      res.json({ version: summary(v) });
    } catch (err) {
      recordActivity({ kind: "restore", skill: name, ok: false, message: (err as Error).message });
      res.status(errorStatus(err)).json({ error: (err as Error).message });
    }
  });

  return router;
}
