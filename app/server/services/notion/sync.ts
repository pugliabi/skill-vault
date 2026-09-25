/**
 * Notion sync primitives: push (vault → Notion), pull (Notion → vault, with a
 * 3-way SKILL.md merge), adopt a Notion-only skill, and apply a conflict
 * resolution. Every vault overwrite happens inside `withHistory`, every
 * Notion copy seen is recorded as a notion-side history version, and every
 * successful action rewrites the link bookkeeping (synced_at, vault_hash,
 * notion_version_id, bases) while carrying over fields it doesn't know.
 * Legacy links are frozen: every primitive throws LegacyLinkError.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getVersion, listVersions, readObject, recordVersion, withHistory, type HistorySide } from "../history.ts";
import { hashSkillDirNormalized } from "../skillHash.ts";
import { readManifest, skillDir, skillsDir, upsertManifestSkill } from "../vault.ts";
import type { NotionLink } from "../../types/vault.ts";
import type { NotionApi } from "./api.ts";
import { readSkillFiles } from "./linker.ts";
import { isNotionNative, isValidSkillName, normalizeName } from "./matching.ts";
import { mergeSkillMd, overlayNotionSkillMd, readFrontmatterValue, stripNotionPageId } from "./patch.ts";
import { readNotionCache, readNotionSettings, setNotionLink, type NotionCacheRow } from "./store.ts";
import { uploadSkill } from "./transfer.ts";

export interface SyncDeps {
  api: NotionApi;
  extract: (url: string) => Promise<{ skillRoot: string; cleanup(): void }>;
  now?: () => string;
  /** Upload override for tests; defaults to transfer.uploadSkill. */
  upload?: (api: NotionApi, pageId: string, dir: string, name: string) => Promise<void>;
}

export class LegacyLinkError extends Error {
  constructor(skill: string) {
    super(`"${skill}" is linked to a legacy Notion page and cannot be synced`);
  }
}

export class NotionChangedError extends Error {
  constructor(skill: string) {
    super(`"${skill}" is not in sync with Notion (never synced, or Notion changed since the last sync) — pull or resolve it first`);
  }
}

export type HistoryResolutionSource = "claude-merge" | "vault-edit";

const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---/;

const SKIP = new Set(["node_modules", "__pycache__", ".git", ".DS_Store", "Thumbs.db"]);

const nowOf = (deps: SyncDeps) => (deps.now ? deps.now() : new Date().toISOString());

// ── Link helpers ────────────────────────────────────────────────

function currentLink(vaultPath: string, skill: string): NotionLink | undefined {
  const entry = readManifest(vaultPath).skills[skill];
  if (!entry) throw new Error(`skill "${skill}" is not in skills.json`);
  return entry.notion;
}

/** The skill's link, which must be a non-legacy "linked" link with a page. */
function requireLinked(vaultPath: string, skill: string): NotionLink {
  const link = currentLink(vaultPath, skill);
  if (link?.state === "legacy") throw new LegacyLinkError(skill);
  if (!link || link.state !== "linked" || !link.page_id) {
    throw new Error(`"${skill}" is not linked to a Notion page`);
  }
  return link;
}

function newestVersionId(vaultPath: string, skill: string, side: HistorySide): string | undefined {
  return listVersions(vaultPath, skill).find((v) => v.side === side)?.id;
}

/** Rewrite the link as synced now, keeping every field not being updated. */
function markSynced(
  deps: SyncDeps,
  vaultPath: string,
  skill: string,
  patch: { notion_version_id: string; notion_edited_at?: string } & Partial<NotionLink>,
): void {
  const prev = currentLink(vaultPath, skill);
  const vaultHash = hashSkillDirNormalized(skillDir(vaultPath, skill));
  const baseVault = newestVersionId(vaultPath, skill, "vault");
  const baseNotion = newestVersionId(vaultPath, skill, "notion");
  const next = {
    ...prev,
    ...patch,
    state: "linked",
    synced_at: nowOf(deps),
    vault_name: skill,
    ...(vaultHash ? { vault_hash: vaultHash } : {}),
    ...(baseVault ? { base_vault_version: baseVault } : {}),
    ...(baseNotion ? { base_notion_version: baseNotion } : {}),
  } as NotionLink;
  if (next.notion_edited_at === undefined) delete next.notion_edited_at;
  setNotionLink(vaultPath, skill, next);
}

function clearSynced(vaultPath: string, skill: string): void {
  const prev = currentLink(vaultPath, skill);
  if (!prev) return;
  const { synced_at: _drop, ...rest } = prev;
  setNotionLink(vaultPath, skill, rest as NotionLink);
}

/** The later of the cached row's edited_at and the link's (never moves backwards). */
function latestEditedAt(pageId: string, known?: string): string | undefined {
  const cached = readNotionCache().rows.find((r) => r.page_id === pageId)?.edited_at;
  if (!cached) return known;
  if (!known) return cached;
  return Date.parse(cached) > Date.parse(known) ? cached : known;
}

// ── Folder replacement ──────────────────────────────────────────

/** Reject relative paths that could escape the skill folder. */
function assertSafeRel(rel: string): void {
  if (
    typeof rel !== "string" ||
    rel.length === 0 ||
    rel.startsWith("/") ||
    rel.startsWith("\\") ||
    /^[a-zA-Z]:/.test(rel) ||
    path.isAbsolute(rel) ||
    rel.split(/[\\/]/).some((seg) => seg === ".." || seg === "." || seg === "")
  ) {
    throw new Error(`invalid file path: ${rel}`);
  }
}

function validateFiles(files: Map<string, Buffer>): void {
  for (const rel of files.keys()) assertSafeRel(rel);
  if (!files.has("SKILL.md")) throw new Error("resolved skill has no SKILL.md");
}

/** Move skip-set entries (node_modules, .git, …) from `from` into `to`, at any depth. */
function carryOverSkipped(from: string, to: string, rel = ""): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(from, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const childRel = rel ? path.join(rel, e.name) : e.name;
    if (SKIP.has(e.name)) {
      const dest = path.join(to, childRel);
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(path.join(from, childRel), dest);
    } else if (e.isDirectory()) {
      carryOverSkipped(from, to, childRel);
    }
  }
}

/**
 * Replace <vault>/skills/<skill> with exactly `files`. Built next to the live
 * folder under a ".temp-" name (ignored by the watcher), swapped in, and the
 * old folder's skip-set entries (node_modules, .git, …) are moved across —
 * they are never part of a skill's synced content. Callers wrap this in
 * withHistory so the previous state is recorded first.
 */
function replaceSkillDir(vaultPath: string, skill: string, files: Map<string, Buffer>): void {
  validateFiles(files);
  const dir = skillDir(vaultPath, skill);
  const suffix = `${skill}-${crypto.randomBytes(4).toString("hex")}`;
  const tmp = path.join(skillsDir(vaultPath), `.temp-sync-${suffix}`);
  const aside = path.join(skillsDir(vaultPath), `.temp-sync-old-${suffix}`);
  try {
    for (const [rel, bytes] of files) {
      const abs = path.join(tmp, ...rel.split("/"));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, bytes);
    }
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  const hadDir = fs.existsSync(dir);
  try {
    if (hadDir) fs.renameSync(dir, aside);
    fs.renameSync(tmp, dir);
  } catch (err) {
    if (hadDir && !fs.existsSync(dir) && fs.existsSync(aside)) fs.renameSync(aside, dir);
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  if (!hadDir) return;
  try {
    carryOverSkipped(aside, dir);
    fs.rmSync(aside, { recursive: true, force: true });
  } catch (err) {
    // Leave the old folder in place rather than lose anything in it.
    console.error(`[notion] could not clean up ${aside}: ${(err as Error).message}`);
  }
}

// ── Push ────────────────────────────────────────────────────────

function frontmatterName(skillMdPath: string): string | undefined {
  const md = fs.readFileSync(skillMdPath, "utf8");
  const fm = FRONTMATTER_RE.exec(md)?.[1].split(/\r?\n/) ?? null;
  const name = readFrontmatterValue(fm, "name")?.trim();
  return name ? name : undefined;
}

export interface PushOptions {
  /** Overwrite Notion even if it changed since the last sync (its copy is recorded first). */
  force?: boolean;
  /** Create the Notion page when the skill has no link yet. */
  create?: boolean;
}

/**
 * Upload the vault folder to the linked Notion page (or a newly created one
 * with `create`). Without `force`, refuses when the skill is not in sync or
 * Notion's version moved since the last sync. With `force`, Notion's current
 * copy is recorded in history before it is overwritten.
 */
export async function pushSkill(
  deps: SyncDeps,
  vaultPath: string,
  skill: string,
  opts: PushOptions = {},
): Promise<{ versionId: string }> {
  const existing = currentLink(vaultPath, skill);
  if (existing?.state === "legacy") throw new LegacyLinkError(skill);
  const dir = skillDir(vaultPath, skill);
  if (!fs.existsSync(path.join(dir, "SKILL.md"))) throw new Error(`"${skill}" has no SKILL.md in the vault`);

  let pageId: string;
  let createdPage = false;
  if (!existing && opts.create) {
    const dsId = readNotionSettings(vaultPath).data_source_id;
    if (!dsId) throw new Error("No Notion Skills data source selected — choose one in Settings");
    const md = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    const fm = FRONTMATTER_RE.exec(md)?.[1].split(/\r?\n/) ?? null;
    const description = readFrontmatterValue(fm, "description") ?? "";
    pageId = await deps.api.createSkillPage(dsId, skill, description);
    setNotionLink(vaultPath, skill, { page_id: pageId, state: "linked", linked_at: nowOf(deps), notion_title: skill });
    createdPage = true;
  } else {
    const link = requireLinked(vaultPath, skill);
    pageId = link.page_id;
    let current: { versionId: string; url: string } | null;
    try {
      current = await deps.api.downloadSkill(pageId);
    } catch (err) {
      // A page this app created whose first upload never landed has no
      // archive yet (and its link no synced_at / notion_version_id): there
      // is no Notion copy to protect, so upload again. Any other link must
      // not be overwritten blind.
      if (link.synced_at || link.notion_version_id) throw err;
      current = null;
    }
    if (!current) {
      /* never-uploaded page created by this app — nothing to record or check */
    } else if (opts.force) {
      const ex = await deps.extract(current.url);
      try {
        recordVersion(vaultPath, skill, {
          side: "notion",
          source: "notion-edit",
          note: "before force-push",
          dir: ex.skillRoot,
        });
      } finally {
        ex.cleanup();
      }
    } else if (!link.synced_at || (link.notion_version_id && current.versionId !== link.notion_version_id)) {
      throw new NotionChangedError(skill);
    }
  }

  recordVersion(vaultPath, skill, opts.force
    ? { source: "force-push", note: "kept vault copy" }
    : { source: "external-edit", note: "pushed" });

  // The upload sets the page title to the frontmatter `name` being uploaded
  // (not the folder name) — restore the linked title when they differ.
  const uploadedName = frontmatterName(path.join(dir, "SKILL.md")) ?? skill;
  try {
    await (deps.upload ?? ((api, id, d, n) => uploadSkill(api, id, d, n)))(deps.api, pageId, dir, skill);
  } catch (err) {
    if (!createdPage) throw err;
    // Undo the link to the empty page just created (there was none before),
    // so the skill is back to "not in Notion"; the page itself stays in
    // Notion (this app never trashes pages) — name it so the user can.
    setNotionLink(vaultPath, skill, existing);
    throw new Error(
      `created Notion page ${pageId} for "${skill}" but the upload failed (${(err as Error).message}) — ` +
        `delete that empty page in Notion, then push again`,
    );
  }
  const title = currentLink(vaultPath, skill)?.notion_title;
  if (title && title !== uploadedName) await deps.api.setTitle(pageId, title);

  const dl = await deps.api.downloadSkill(pageId);
  const ex = await deps.extract(dl.url);
  try {
    recordVersion(vaultPath, skill, { side: "notion", source: "push-notion-copy", dir: ex.skillRoot });
  } finally {
    ex.cleanup();
  }
  markSynced(deps, vaultPath, skill, { notion_version_id: dl.versionId });
  return { versionId: dl.versionId };
}

// ── Pull ────────────────────────────────────────────────────────

export type PullResult = { result: "pulled" | "conflict"; reason?: string };

/**
 * Bring Notion's copy into the vault. `force` replaces the folder with
 * Notion's (vault frontmatter extras kept, notion_page_id stripped).
 * Otherwise SKILL.md is 3-way merged against the Notion copy at the last
 * sync (link.base_notion_version) and the other files are replaced as
 * Notion delivers them; a missing base or overlapping edits leave the vault
 * untouched, clear synced_at and return "conflict".
 */
export async function pullSkill(
  deps: SyncDeps,
  vaultPath: string,
  skill: string,
  opts: { force?: boolean } = {},
): Promise<PullResult> {
  const link = requireLinked(vaultPath, skill);
  const dl = await deps.api.downloadSkill(link.page_id);
  const ex = await deps.extract(dl.url);
  try {
    const notionFiles = readSkillFiles(ex.skillRoot);
    const notionMd = notionFiles.get("SKILL.md");
    if (!notionMd) throw new Error(`Notion's copy of "${skill}" has no SKILL.md`);
    recordVersion(vaultPath, skill, { side: "notion", source: "notion-edit", note: "pulled", dir: ex.skillRoot });

    const vaultMdPath = path.join(skillDir(vaultPath, skill), "SKILL.md");
    const vaultMd = fs.existsSync(vaultMdPath) ? fs.readFileSync(vaultMdPath, "utf8") : null;
    const files = new Map(notionFiles);

    if (opts.force) {
      files.set("SKILL.md", Buffer.from(overlayNotionSkillMd(notionMd.toString("utf8"), vaultMd), "utf8"));
      withHistory(vaultPath, skill, "force-pull", () => replaceSkillDir(vaultPath, skill, files));
    } else {
      const merged = mergePulled(vaultPath, skill, link, notionMd.toString("utf8"), vaultMd);
      if (!merged.ok) {
        clearSynced(vaultPath, skill);
        return { result: "conflict", reason: merged.reason };
      }
      files.set("SKILL.md", Buffer.from(merged.text, "utf8"));
      withHistory(vaultPath, skill, "pull", () => replaceSkillDir(vaultPath, skill, files));
    }
  } finally {
    ex.cleanup();
  }
  markSynced(deps, vaultPath, skill, {
    notion_version_id: dl.versionId,
    notion_edited_at: latestEditedAt(link.page_id, link.notion_edited_at),
  });
  return { result: "pulled" };
}

function mergePulled(
  vaultPath: string,
  skill: string,
  link: NotionLink,
  notionMd: string,
  vaultMd: string | null,
): { ok: true; text: string } | { ok: false; reason: string } {
  if (vaultMd === null) return { ok: false, reason: "the vault copy has no SKILL.md" };
  const base = link.base_notion_version ? getVersion(vaultPath, skill, link.base_notion_version) : null;
  const baseSha = base?.side === "notion" ? base.files["SKILL.md"] : undefined;
  if (!baseSha) return { ok: false, reason: "no base version of the Notion copy to merge against" };
  let baseMd: string;
  try {
    baseMd = readObject(vaultPath, baseSha).toString("utf8");
  } catch {
    return { ok: false, reason: "the base version of the Notion copy is missing from history" };
  }
  return mergeSkillMd(baseMd, notionMd, vaultMd);
}

// ── Adopt ───────────────────────────────────────────────────────

/**
 * Bring a Notion-only (folder-compatible) skill into the vault as a new,
 * linked, in-sync skill. The folder name comes from the archive's frontmatter
 * `name` when it is a valid skill name, else the normalized page title.
 * Never overwrites an existing skill.
 */
export async function adoptFromNotion(deps: SyncDeps, vaultPath: string, row: NotionCacheRow): Promise<string> {
  const manifest = readManifest(vaultPath);
  for (const [name, entry] of Object.entries(manifest.skills)) {
    if (entry.notion?.page_id !== row.page_id) continue;
    if (entry.notion.state === "legacy") throw new LegacyLinkError(name);
    throw new Error(`Notion page is already linked to "${name}"`);
  }
  if (isNotionNative(row)) throw new Error(`"${row.title}" is a Notion-native skill and cannot be adopted as a folder`);

  const dl = await deps.api.downloadSkill(row.page_id);
  const ex = await deps.extract(dl.url);
  let name: string;
  try {
    const files = readSkillFiles(ex.skillRoot);
    const md = files.get("SKILL.md");
    if (!md) throw new Error(`Notion's copy of "${row.title}" has no SKILL.md`);
    const stripped = stripNotionPageId(md.toString("utf8"));
    const fm = FRONTMATTER_RE.exec(stripped)?.[1].split(/\r?\n/) ?? null;
    const fmName = readFrontmatterValue(fm, "name") ?? "";
    name = isValidSkillName(fmName) ? fmName : normalizeName(row.title);
    if (!isValidSkillName(name)) throw new Error(`cannot derive a skill name from "${row.title}"`);
    if (readManifest(vaultPath).skills[name] || fs.existsSync(skillDir(vaultPath, name))) {
      throw new Error(`a skill named "${name}" already exists in the vault`);
    }
    files.set("SKILL.md", Buffer.from(stripped, "utf8"));
    replaceSkillDir(vaultPath, name, files);
    const now = nowOf(deps);
    upsertManifestSkill(vaultPath, name, {
      targets: [],
      source: "pulled from Notion",
      notion: { page_id: row.page_id, state: "linked", linked_at: now, notion_title: row.title },
    });
    recordVersion(vaultPath, name, { side: "notion", source: "notion-edit", note: "adopted", dir: ex.skillRoot });
    recordVersion(vaultPath, name, { source: "adopt", note: "adopted from Notion" });
  } finally {
    ex.cleanup();
  }
  markSynced(deps, vaultPath, name, {
    notion_version_id: dl.versionId,
    ...(row.edited_at ? { notion_edited_at: row.edited_at } : {}),
  });
  return name;
}

// ── Resolution ──────────────────────────────────────────────────

/**
 * Write a resolved folder (e.g. Claude's merge) to the vault — recorded in
 * history under `source` — then force-push it: the resolution already
 * accounts for Notion's copy, which is also recorded before it's replaced.
 */
export async function applyResolution(
  deps: SyncDeps,
  vaultPath: string,
  skill: string,
  files: Map<string, Buffer>,
  source: HistoryResolutionSource,
): Promise<void> {
  requireLinked(vaultPath, skill);
  validateFiles(files);
  withHistory(vaultPath, skill, source, () => replaceSkillDir(vaultPath, skill, files));
  await pushSkill(deps, vaultPath, skill, { force: true });
}

export function keepVault(deps: SyncDeps, vaultPath: string, skill: string): Promise<{ versionId: string }> {
  return pushSkill(deps, vaultPath, skill, { force: true });
}

export function keepNotion(deps: SyncDeps, vaultPath: string, skill: string): Promise<PullResult> {
  return pullSkill(deps, vaultPath, skill, { force: true });
}
