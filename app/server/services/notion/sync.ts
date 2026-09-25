/**
 * Notion sync primitives: push (vault → Notion), pull (Notion → vault, with a
 * 3-way SKILL.md merge), adopt a Notion-only skill, and apply a conflict
 * resolution. Every vault overwrite happens inside `withHistory`, every
 * Notion copy seen is recorded as a notion-side history version, and every
 * successful action rewrites the link bookkeeping (synced_at, vault_hash,
 * notion_version_id, bases) while carrying over fields it doesn't know.
 * Legacy links are frozen: every primitive throws LegacyLinkError — the
 * only way out is `upgradeLegacySkill`, which replaces the summary page with
 * the full skill.
 *
 * Name agreement: an upload is refused (NameMismatchError, before any
 * Notion write — no page created, nothing uploaded) unless SKILL.md's
 * frontmatter `name` equals the folder name; after an upload the Notion
 * title is set to that same name.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getVersion, listVersions, readObject, recordVersion, withHistory, type HistorySide } from "../history.ts";
import { hashSkillDirNormalized } from "../skillHash.ts";
import { setSkillMdName } from "../skillLifecycle.ts";
import { NameMismatchError, assertNameAgreement, frontmatterValueOf, skillMdName } from "../skillNames.ts";
import { readManifest, skillDir, skillsDir, upsertManifestSkill } from "../vault.ts";
import type { NotionLink } from "../../types/vault.ts";
import type { NotionApi } from "./api.ts";
import { readSkillFiles } from "./linker.ts";
import { isNotionNative, isValidSkillName, normalizeName } from "./matching.ts";
import { mergeSkillMd, overlayNotionSkillMd, stripNotionPageId } from "./patch.ts";
import { readNotionCache, readNotionSettings, setNotionLink, type NotionCacheRow } from "./store.ts";
import { uploadSkill } from "./transfer.ts";
import { isFile } from "../fsUtil.ts";

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

export class NotLegacyError extends Error {
  constructor(skill: string) {
    super(`"${skill}" is not linked to a legacy Notion page — nothing to upgrade`);
  }
}

export class NotionChangedError extends Error {
  constructor(skill: string) {
    super(`"${skill}" is not in sync with Notion (never synced, or Notion changed since the last sync) — pull or resolve it first`);
  }
}

export type HistoryResolutionSource = "claude-merge" | "vault-edit";


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

export interface PushOptions {
  /** Overwrite Notion even if it changed since the last sync (its copy is recorded first). */
  force?: boolean;
  /** Create the Notion page when the skill has no link yet. */
  create?: boolean;
  /**
   * A reviewed vault folder rename: when SKILL.md still carries this (old
   * folder) name, it is set to the folder name — only after the Notion
   * pre-checks pass, so a refused push leaves the vault untouched. Any other
   * name mismatch is refused (NameMismatchError).
   */
  carryNameFrom?: string;
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
  if (!isFile(path.join(dir, "SKILL.md"))) throw new Error(`"${skill}" has no SKILL.md in the vault`);
  const carryName = !!opts.carryNameFrom && skillMdName(vaultPath, skill) === opts.carryNameFrom;
  if (!carryName) assertNameAgreement(vaultPath, skill);

  let pageId: string;
  /** Set when this push linked the page (created, or an empty one reused): undone if the upload fails. */
  let newLink: "created" | "reused" | null = null;
  if (!existing && opts.create) {
    const dsId = readNotionSettings(vaultPath).data_source_id;
    if (!dsId) throw new Error("No Notion Skills data source selected — choose one in Settings");
    const reusable = await findEmptyPageNamed(deps, vaultPath, skill);
    if (reusable) {
      pageId = reusable;
      newLink = "reused";
    } else {
      const md = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
      const description = frontmatterValueOf(md, "description") ?? "";
      pageId = await deps.api.createSkillPage(dsId, skill, description);
      newLink = "created";
    }
    setNotionLink(vaultPath, skill, { page_id: pageId, state: "linked", linked_at: nowOf(deps), notion_title: skill });
  } else {
    const link = requireLinked(vaultPath, skill);
    pageId = link.page_id;
    // A link awaiting its first upload (no synced_at / notion_version_id:
    // an empty page linked by the linker, or created here) is filled blind
    // only while Notion still reports the page blank; otherwise it is
    // treated like any never-synced link (Conflicts). Download errors are
    // always errors.
    const awaitingFirstUpload = !link.synced_at && !link.notion_version_id;
    const current = await deps.api.downloadSkill(pageId);
    if (opts.force) {
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
    } else if (awaitingFirstUpload) {
      if (!(await isEmptyNotionPage(deps, pageId))) throw new NotionChangedError(skill);
    } else if (!link.synced_at || (link.notion_version_id && current.versionId !== link.notion_version_id)) {
      throw new NotionChangedError(skill);
    }
  }

  if (carryName) setSkillMdName(vaultPath, skill, skill);

  recordVersion(vaultPath, skill, opts.force
    ? { source: "force-push", note: "kept vault copy" }
    : { source: "external-edit", note: "pushed" });

  try {
    await uploadWith(deps, pageId, dir, skill);
  } catch (err) {
    if (!newLink) throw err;
    // Undo the link to the empty page (there was none before), so the skill
    // is back to "not in Notion"; the page itself stays in Notion (this app
    // never trashes pages) — a later push reuses it while it stays empty.
    setNotionLink(vaultPath, skill, existing);
    throw new Error(
      `${newLink === "created" ? "created" : "reused the empty"} Notion page ${pageId} for "${skill}" but the upload failed ` +
        `(${(err as Error).message}) — push again (the empty page is reused while it keeps the name "${skill}")`,
    );
  }
  await fixNotionTitle(deps, vaultPath, skill, pageId);
  return finishUpload(deps, vaultPath, skill, pageId);
}

// ── Empty pages ─────────────────────────────────────────────────

/**
 * An EMPTY page: Notion reports it blank (notion-fetch's `<blank-page>`
 * marker) and its cached row has no files. download-skill succeeds even on
 * such a page, so its result says nothing about emptiness.
 */
export async function isEmptyNotionPage(deps: SyncDeps, pageId: string): Promise<boolean> {
  const row = readNotionCache().rows.find((r) => r.page_id === pageId);
  if (!row || row.has_files !== false) return false;
  return deps.api.isBlankPage(pageId);
}

/**
 * An existing empty page titled exactly `skill` (no files, not linked to any
 * skill, reported blank by Notion) — e.g. left behind by a failed first
 * upload and named by the user — to reuse instead of creating a duplicate.
 */
async function findEmptyPageNamed(deps: SyncDeps, vaultPath: string, skill: string): Promise<string | null> {
  const linked = new Set(
    Object.values(readManifest(vaultPath).skills)
      .map((e) => e.notion?.page_id)
      .filter((id): id is string => !!id),
  );
  for (const row of readNotionCache().rows) {
    if (row.title !== skill || row.has_files !== false || linked.has(row.page_id)) continue;
    try {
      if (await deps.api.isBlankPage(row.page_id)) return row.page_id;
    } catch (err) {
      console.error(`[notion] could not check page ${row.page_id}: ${(err as Error).message}`);
    }
  }
  return null;
}

// ── Shared upload bookkeeping ───────────────────────────────────

function uploadWith(deps: SyncDeps, pageId: string, dir: string, skill: string): Promise<void> {
  return (deps.upload ?? ((api, id, d, n) => uploadSkill(api, id, d, n)))(deps.api, pageId, dir, skill);
}

/**
 * After an upload: the Notion title must be the skill name. The upload sets
 * the title from the uploaded frontmatter name (== the folder name, checked
 * before uploading), so this only writes when the last known title (cache,
 * else link) differs — e.g. a display title "My Skill" becomes "my-skill".
 */
async function fixNotionTitle(deps: SyncDeps, vaultPath: string, skill: string, pageId: string): Promise<void> {
  const cached = readNotionCache().rows.find((r) => r.page_id === pageId)?.title;
  const known = cached ?? currentLink(vaultPath, skill)?.notion_title;
  if (known !== skill) await deps.api.setTitle(pageId, skill);
}

/** Record the Notion copy just uploaded and mark the link linked + synced under the skill name. */
async function finishUpload(
  deps: SyncDeps,
  vaultPath: string,
  skill: string,
  pageId: string,
): Promise<{ versionId: string }> {
  const dl = await deps.api.downloadSkill(pageId);
  const ex = await deps.extract(dl.url);
  try {
    recordVersion(vaultPath, skill, { side: "notion", source: "push-notion-copy", dir: ex.skillRoot });
  } finally {
    ex.cleanup();
  }
  markSynced(deps, vaultPath, skill, { notion_version_id: dl.versionId, notion_title: skill });
  return { versionId: dl.versionId };
}

// ── Legacy upgrade ──────────────────────────────────────────────

/**
 * Replace a legacy summary page with the full vault skill, in the same
 * Notion page. Notion's current (summary) copy is recorded in history first
 * ("legacy-snapshot", always), every file is uploaded, the title becomes
 * the skill name, and the link becomes linked + synced exactly as after a
 * push. The vault copy is never changed; a folder / SKILL.md name mismatch
 * is refused up front (NameMismatchError) before anything is downloaded.
 */
export async function upgradeLegacySkill(
  deps: SyncDeps,
  vaultPath: string,
  skill: string,
): Promise<{ versionId: string }> {
  const link = currentLink(vaultPath, skill);
  if (link?.state !== "legacy") throw new NotLegacyError(skill);
  if (!link.page_id) throw new Error(`"${skill}" has no Notion page id`);
  const dir = skillDir(vaultPath, skill);
  if (!isFile(path.join(dir, "SKILL.md"))) throw new Error(`"${skill}" has no SKILL.md in the vault`);
  assertNameAgreement(vaultPath, skill);
  const pageId = link.page_id;

  const current = await deps.api.downloadSkill(pageId);
  const ex = await deps.extract(current.url);
  try {
    recordVersion(vaultPath, skill, {
      side: "notion",
      source: "legacy-snapshot",
      note: "before upgrade",
      dir: ex.skillRoot,
      always: true,
    });
  } finally {
    ex.cleanup();
  }

  recordVersion(vaultPath, skill, { source: "external-edit", note: "upgraded legacy Notion page" });
  await uploadWith(deps, pageId, dir, skill);
  await deps.api.setTitle(pageId, skill);
  return finishUpload(deps, vaultPath, skill, pageId);
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
    const vaultMd = isFile(vaultMdPath) ? fs.readFileSync(vaultMdPath, "utf8") : null;
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
    const fmName = frontmatterValueOf(stripped, "name") ?? "";
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
  // Refuse before writing anything when the result would not upload.
  const resolvedName = frontmatterValueOf(files.get("SKILL.md")!.toString("utf8"), "name");
  if (resolvedName !== skill) throw new NameMismatchError(skill, resolvedName);
  withHistory(vaultPath, skill, source, () => replaceSkillDir(vaultPath, skill, files));
  await pushSkill(deps, vaultPath, skill, { force: true });
}

export function keepVault(deps: SyncDeps, vaultPath: string, skill: string): Promise<{ versionId: string }> {
  return pushSkill(deps, vaultPath, skill, { force: true });
}

export function keepNotion(deps: SyncDeps, vaultPath: string, skill: string): Promise<PullResult> {
  return pullSkill(deps, vaultPath, skill, { force: true });
}
