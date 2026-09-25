import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { readAppConfig } from "../services/appConfig.ts";
import {
  readManifest,
  patchManifestSkill,
  writeManifest,
  skillDir,
} from "../services/vault.ts";
import {
  aiTaggingAvailability,
  buildVocabulary,
  claudeModel,
  readSkillInput,
  suggestAll,
  type ClaudeAvailability,
  type ClaudeRunner,
} from "../services/aiTagging.ts";
import type { SkillsManifest } from "../types/vault.ts";

/** Max skills per /suggest request; the client sends one batch at a time. */
const SUGGEST_MAX_SKILLS = 50;

/** Every tag used in the vault plus `known_tags`. */
function vaultTags(manifest: SkillsManifest): Set<string> {
  const tags = new Set<string>(
    Array.isArray(manifest.known_tags) ? manifest.known_tags : [],
  );
  for (const entry of Object.values(manifest.skills)) {
    if (Array.isArray(entry.tags)) for (const t of entry.tags) tags.add(t);
  }
  return tags;
}

/**
 * Tag is a "real" tag if non-empty, lowercased (no uppercase chars), and
 * contains no whitespace. Mirrors the validation we do when accepting
 * tags from the UI; keeping it here so /api/tags/rename can reject bad
 * inputs at the boundary instead of silently corrupting the manifest.
 */
function isValidTag(s: unknown): s is string {
  return (
    typeof s === "string" &&
    s.length > 0 &&
    s === s.toLowerCase() &&
    !/\s/.test(s)
  );
}

export interface TagsRouterDeps {
  /** Low-level CLI runner (services/claude/cli.ts); omitted → the real CLI. */
  runner?: ClaudeRunner;
  /** Defaults to the shared launcher's real `claude`; tests inject a fake. */
  detect?: (force?: boolean) => Promise<ClaudeAvailability>;
}

export function tagsRouter(deps: TagsRouterDeps = {}): Router {
  const router = Router();
  const runner = deps.runner;
  const detect = deps.detect ?? aiTaggingAvailability;

  /** Is AI auto-tagging available (Claude Code CLI on PATH)? */
  router.get("/ai-status", async (req, res) => {
    res.json({ ...(await detect(req.query.refresh === "1")), model: claudeModel() });
  });

  /**
   * AI tag suggestions for the named skills. Returns the full recommended
   * tag set per skill (not a diff) plus a one-line reason; skills that
   * could not be classified are listed in `failed` so the client can fall
   * back to the keyword heuristic. Read-only — nothing is written.
   */
  router.post("/suggest", async (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const body = req.body as { skills?: unknown };
    const names = Array.isArray(body.skills)
      ? [...new Set(body.skills.filter((s): s is string => typeof s === "string" && s.length > 0))]
      : [];
    if (!names.length) {
      res.status(400).json({ error: "skills array is required" });
      return;
    }
    if (names.length > SUGGEST_MAX_SKILLS) {
      res.status(400).json({ error: `at most ${SUGGEST_MAX_SKILLS} skills per request` });
      return;
    }
    const status = await detect();
    if (!status.available) {
      res.status(503).json({ error: status.reason ?? "AI tagging unavailable" });
      return;
    }

    const vaultPath = cfg.vault_path;
    const manifest = readManifest(vaultPath);
    // Only real skills: a manifest entry or a folder directly under skills/.
    const unknown = names.filter(
      (n) =>
        path.basename(n) !== n ||
        n === "." ||
        n === ".." ||
        !(manifest.skills[n] || fs.existsSync(skillDir(vaultPath, n))),
    );
    if (unknown.length) {
      res.status(404).json({ error: `unknown skill(s): ${unknown.slice(0, 5).join(", ")}` });
      return;
    }
    const tagsInVault = vaultTags(manifest);
    const vocab = buildVocabulary(tagsInVault);
    const inputs = names.map((n) => ({
      ...readSkillInput(skillDir(vaultPath, n), n),
      current: Array.isArray(manifest.skills[n]?.tags) ? manifest.skills[n].tags : [],
    }));

    // Kill the CLI if the client goes away (dialog closed / cancelled).
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });

    const { results, failed } = await suggestAll(inputs, vocab, runner, {
      signal: ac.signal,
      vaultTags: tagsInVault,
    });
    if (ac.signal.aborted) return;
    res.json({ results, failed });
  });

  router.get("/", (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const manifest = readManifest(cfg.vault_path);
    const known = Array.isArray(manifest.known_tags) ? manifest.known_tags : [];
    const withCounts =
      req.query.withCounts === "1" || req.query.withCounts === "true";

    if (withCounts) {
      const counts = new Map<string, number>();
      for (const entry of Object.values(manifest.skills)) {
        if (!Array.isArray(entry.tags)) continue;
        for (const t of entry.tags) {
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
      }
      for (const t of known) {
        if (!counts.has(t)) counts.set(t, 0);
      }
      const tags = [...counts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => a.tag.localeCompare(b.tag));
      res.json({ tags });
      return;
    }

    const tagSet = new Set<string>();
    for (const entry of Object.values(manifest.skills)) {
      if (Array.isArray(entry.tags)) {
        for (const t of entry.tags) tagSet.add(t);
      }
    }
    for (const t of known) tagSet.add(t);
    const tags = [...tagSet].sort((a, b) => a.localeCompare(b));
    res.json({ tags });
  });

  router.post("/", (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const body = req.body as { tag?: unknown };
    const tag = body.tag;
    if (!isValidTag(tag)) {
      res.status(409).json({
        error: "tag must be a non-empty lowercase string without whitespace",
      });
      return;
    }
    const manifest = readManifest(cfg.vault_path);
    const known = new Set<string>(
      Array.isArray(manifest.known_tags) ? manifest.known_tags : [],
    );
    known.add(tag);
    manifest.known_tags = [...known].sort((a, b) => a.localeCompare(b));
    writeManifest(cfg.vault_path, manifest);
    res.json({ ok: true, tag });
  });

  router.post("/bulk", (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const body = req.body as {
      skills?: string[];
      add?: string[];
      remove?: string[];
      /** Also drop removed tags from known_tags (default true). */
      prune_known?: boolean;
    };
    const skills = Array.isArray(body.skills) ? body.skills : [];
    const add = Array.isArray(body.add) ? body.add : [];
    const remove = Array.isArray(body.remove) ? body.remove : [];

    if (!skills.length) {
      res.status(400).json({ error: "skills array is required" });
      return;
    }

    let updated = 0;
    const manifest = readManifest(cfg.vault_path);
    for (const name of skills) {
      const entry = manifest.skills[name];
      if (!entry) continue;
      const current = new Set(entry.tags ?? []);
      for (const t of add) current.add(t);
      for (const t of remove) current.delete(t);
      patchManifestSkill(cfg.vault_path, name, { tags: [...current] });
      updated++;
    }

    if (remove.length && body.prune_known !== false) {
      const fresh = readManifest(cfg.vault_path);
      const known = Array.isArray(fresh.known_tags) ? fresh.known_tags : [];
      const removeSet = new Set(remove);
      const next = known.filter((t) => !removeSet.has(t));
      if (next.length !== known.length) {
        fresh.known_tags = next;
        writeManifest(cfg.vault_path, fresh);
      }
    }

    res.json({ ok: true, updated });
  });

  /**
   * Bulk-rename a tag across every skill that has it. Atomic in the
   * sense that we read + mutate + write the manifest once, instead of
   * looping patchManifestSkill (which would rewrite skills.json N
   * times). If a skill already has both `from` and `to`, we just drop
   * the duplicate.
   */
  router.post("/rename", (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const body = req.body as { from?: unknown; to?: unknown };
    const from = body.from;
    const to = body.to;

    if (!isValidTag(from) || !isValidTag(to)) {
      res.status(400).json({
        error:
          "from and to must be non-empty lowercase strings without whitespace",
      });
      return;
    }
    if (from === to) {
      res.json({ ok: true, updated: 0 });
      return;
    }

    const manifest = readManifest(cfg.vault_path);
    let updated = 0;
    let manifestDirty = false;
    for (const entry of Object.values(manifest.skills)) {
      if (!Array.isArray(entry.tags)) continue;
      if (!entry.tags.includes(from)) continue;
      const next = new Set<string>();
      for (const t of entry.tags) {
        next.add(t === from ? to : t);
      }
      entry.tags = [...next];
      updated++;
      manifestDirty = true;
    }

    const knownArr = Array.isArray(manifest.known_tags)
      ? manifest.known_tags
      : [];
    const knownSet = new Set(knownArr);
    if (knownSet.has(from)) {
      knownSet.delete(from);
      knownSet.add(to);
      manifest.known_tags = [...knownSet].sort((a, b) => a.localeCompare(b));
      manifestDirty = true;
    } else if (knownSet.size !== knownArr.length) {
      manifest.known_tags = [...knownSet].sort((a, b) => a.localeCompare(b));
      manifestDirty = true;
    }

    if (manifestDirty) {
      writeManifest(cfg.vault_path, manifest);
    }
    res.json({ ok: true, updated });
  });

  return router;
}
