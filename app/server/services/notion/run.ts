/**
 * Executes reviewed push/pull plan rows and force runs. The route layer owns
 * jobs, connections and HTTP; this module owns what each row does. Every
 * row runs on its own — a failure is reported for that row only.
 *
 * Safety rules (constraints.md): nothing is hard-deleted (vault deletes go
 * through deleteVaultSkill, which records history), Notion pages are never
 * trashed by this app (the tool has no trash option), legacy links are
 * never touched, conflict rows are never executed here.
 */
import fs from "node:fs";
import path from "node:path";
import { getVersion, listVersions } from "../history.ts";
import { hashSkillDirNormalized } from "../skillHash.ts";
import { deleteVaultSkill, renameVaultSkill, setSkillMdName } from "../skillLifecycle.ts";
import { assertNameAgreement, skillMdName } from "../skillNames.ts";
import { readManifest, skillDir } from "../vault.ts";
import type { NotionLink } from "../../types/vault.ts";
import { readSkillFiles } from "./linker.ts";
import { computeNotionStatus } from "./matching.ts";
import { buildPlan, type PlanRow, type PlanSkillInput } from "./plan.ts";
import {
  readNotionCache,
  readNotionSettings,
  setNotionLink,
  writeNotionCache,
  type NotionCache,
  type NotionCacheRow,
} from "./store.ts";
import { NotionChangedError, adoptFromNotion, pullSkill, pushSkill, type SyncDeps } from "./sync.ts";

export type Direction = "push" | "pull";
export type DeletedAction = "unlink" | "delete-vault" | "trash" | "recreate";

export const TRASH_UNSUPPORTED =
  "This app can't move Notion pages to the trash (the Notion tool has no trash option). Move it to trash in Notion, then Unlink.";

/** A plan row as the review page sees it: plus the choices for a Deleted row. */
export interface ReviewRow extends PlanRow {
  actions?: DeletedAction[];
  default_action?: DeletedAction;
}

export interface RowResult {
  id: string;
  ok: boolean;
  error?: string;
  message?: string;
}

// ── Plan inputs ─────────────────────────────────────────────────

/** True when the per-machine cache was produced by a check against the chosen data source. */
export function cacheIsValid(vaultPath: string, cache: NotionCache = readNotionCache()): boolean {
  const dsId = readNotionSettings(vaultPath).data_source_id;
  return !!cache.checked_at && !!dsId && cache.data_source_id === dsId;
}

/** True when the cache is invalid or older than `maxAgeMs`. */
export function cacheIsStale(vaultPath: string, maxAgeMs: number, now = Date.now()): boolean {
  const cache = readNotionCache();
  if (!cacheIsValid(vaultPath, cache)) return true;
  const at = Date.parse(cache.checked_at!);
  return Number.isNaN(at) || now - at > maxAgeMs;
}

function planSkills(vaultPath: string): PlanSkillInput[] {
  const manifest = readManifest(vaultPath);
  return Object.entries(manifest.skills).map(([name, entry]) => {
    const dir = skillDir(vaultPath, name);
    const exists = fs.existsSync(dir);
    let has_history = false;
    try {
      has_history = listVersions(vaultPath, name).length > 0;
    } catch {
      /* unreadable history → treat as none */
    }
    return {
      name,
      ...(entry.notion ? { link: entry.notion } : {}),
      vaultHash: exists ? hashSkillDirNormalized(dir) : null,
      exists,
      has_history,
    };
  });
}

/** Supporting files the Notion copy had at the last sync that the vault no longer has. */
function removedSupportingFiles(vaultPath: string, skill: string, link?: NotionLink): string[] {
  if (!link?.base_notion_version) return [];
  let base;
  try {
    base = getVersion(vaultPath, skill, link.base_notion_version);
  } catch {
    return [];
  }
  if (!base || base.side !== "notion") return [];
  const now = readSkillFiles(skillDir(vaultPath, skill));
  return Object.keys(base.files)
    .filter((rel) => rel !== "SKILL.md" && !now.has(rel))
    .sort();
}

/** Build the review rows from the current cache (throws CacheStaleError if it is invalid). */
export function currentPlan(vaultPath: string, direction: Direction): ReviewRow[] {
  const cache = readNotionCache();
  const skills = planSkills(vaultPath);
  const rows = buildPlan({ direction, skills, rows: cache.rows, cacheValid: cacheIsValid(vaultPath, cache) });
  const manifest = readManifest(vaultPath);
  return rows.map((row): ReviewRow => {
    const out: ReviewRow = { ...row, warnings: [...row.warnings] };
    const exists = !!row.skill && fs.existsSync(skillDir(vaultPath, row.skill));
    if (row.kind === "deleted") {
      out.actions = !exists
        ? ["unlink", "trash"] // deleted in the vault
        : direction === "push"
          ? ["unlink", "recreate"] // deleted in Notion
          : ["unlink", "delete-vault", "recreate"];
      out.default_action = "unlink";
    }
    if (direction === "push" && row.skill && exists && row.kind !== "deleted" && row.kind !== "conflict") {
      const mdName = skillMdName(vaultPath, row.skill);
      const link = manifest.skills[row.skill]?.notion;
      // A reviewed folder-rename row carries the new name into SKILL.md itself (see pushRename).
      const renameFixes = row.kind === "rename" && !!link?.vault_name && link.vault_name !== row.skill && mdName === link.vault_name;
      if (mdName !== row.skill && !renameFixes) {
        out.warnings.push(
          `Name mismatch: folder '${row.skill}' vs SKILL.md name '${mdName ?? "(none)"}' — fix it in Names first (this row will fail)`,
        );
      }
    }
    if (direction === "push" && row.skill && exists && (row.kind === "update" || row.kind === "rename")) {
      const gone = removedSupportingFiles(vaultPath, row.skill, manifest.skills[row.skill]?.notion);
      if (gone.length > 0) {
        out.warnings.push(
          `Removed from the vault but will stay in Notion (uploads never delete Notion files): ${gone.join(", ")}`,
        );
      }
    }
    return out;
  });
}

export function planStats(vaultPath: string, rows: PlanRow[]) {
  const by_kind = { update: 0, new: 0, rename: 0, deleted: 0, conflict: 0 };
  for (const r of rows) by_kind[r.kind]++;
  let linked = 0;
  let legacy = 0;
  for (const [name, entry] of Object.entries(readManifest(vaultPath).skills)) {
    if (entry.notion?.state === "legacy") legacy++;
    else if (entry.notion?.state === "linked" && entry.notion.page_id && fs.existsSync(skillDir(vaultPath, name))) linked++;
  }
  return { by_kind, force_eligible: linked, legacy };
}

// ── Cache bookkeeping ───────────────────────────────────────────

/** Point the cached Notion row at the version the link now records. */
export function syncCacheRow(vaultPath: string, skill: string): void {
  const link = readManifest(vaultPath).skills[skill]?.notion;
  if (!link?.notion_version_id) return;
  const cache = readNotionCache();
  const row = cache.rows.find((r) => r.page_id === link.page_id);
  if (!row) return;
  let changed = false;
  if (row.version_id !== link.notion_version_id) {
    row.version_id = link.notion_version_id;
    changed = true;
  }
  if (link.notion_title && row.title !== link.notion_title) {
    row.title = link.notion_title;
    changed = true;
  }
  if (changed) writeNotionCache(cache);
}

// ── Row execution ───────────────────────────────────────────────

function linkOf(vaultPath: string, skill: string): NotionLink {
  const link = readManifest(vaultPath).skills[skill]?.notion;
  if (!link) throw new Error(`"${skill}" has no Notion link`);
  return link;
}

function unlink(vaultPath: string, skill: string): string {
  setNotionLink(vaultPath, skill, { ...linkOf(vaultPath, skill), state: "unlinked" });
  return "unlinked";
}

/** Create a fresh Notion page for a skill whose page is gone; the old link is restored on failure. */
async function recreate(d: SyncDeps, vaultPath: string, skill: string): Promise<string> {
  const prev = linkOf(vaultPath, skill);
  if (!fs.existsSync(path.join(skillDir(vaultPath, skill), "SKILL.md"))) {
    throw new Error(`"${skill}" has no SKILL.md in the vault — restore it first`);
  }
  setNotionLink(vaultPath, skill, undefined);
  try {
    await pushSkill(d, vaultPath, skill, { create: true });
  } catch (err) {
    // Only roll back when no new page got linked (create failed before linking).
    if (!readManifest(vaultPath).skills[skill]?.notion) setNotionLink(vaultPath, skill, prev);
    throw err;
  }
  return "re-created in Notion";
}

async function runDeleted(d: SyncDeps, vaultPath: string, row: PlanRow, action: DeletedAction): Promise<string> {
  const skill = row.skill!;
  switch (action) {
    case "unlink":
      return unlink(vaultPath, skill);
    case "trash":
      throw new Error(TRASH_UNSUPPORTED);
    case "delete-vault":
      deleteVaultSkill(vaultPath, skill);
      return "deleted from the vault (kept in history)";
    case "recreate":
      return recreate(d, vaultPath, skill);
  }
}

/**
 * Push rename row.
 * - Vault folder rename (link.vault_name differs): a normal push; SKILL.md's
 *   name is carried over from the old folder name only after Notion's
 *   pre-checks pass (pushSkill carryNameFrom). pushSkill then sets the title.
 * - "Fix name in Notion" (title differs from the skill name): when the skill
 *   is otherwise synced, only the Notion title is set (no upload); else a
 *   normal (non-force) push, which also sets the title.
 */
async function pushRename(d: SyncDeps, vaultPath: string, skill: string): Promise<string> {
  const link = linkOf(vaultPath, skill);
  const before = link.notion_title;
  const renamed = (from?: string) =>
    from && from !== skill ? `renamed in Notion from "${from}" to "${skill}"` : `renamed in Notion to "${skill}"`;
  if (link.vault_name && link.vault_name !== skill) {
    await pushSkill(d, vaultPath, skill, { carryNameFrom: link.vault_name });
    return renamed(before);
  }
  assertNameAgreement(vaultPath, skill);
  if (linkStatus(vaultPath, skill, link) === "synced") {
    await d.api.setTitle(link.page_id, skill);
    setNotionLink(vaultPath, skill, { ...linkOf(vaultPath, skill), notion_title: skill, vault_name: skill });
    return `Notion title set to "${skill}"`;
  }
  await pushSkill(d, vaultPath, skill);
  return renamed(before);
}

/** The skill's Notion status from the current cache (same computation as the badges). */
function linkStatus(vaultPath: string, skill: string, link: NotionLink) {
  const cache = readNotionCache();
  return computeNotionStatus({
    link,
    connected: true,
    vaultHash: hashSkillDirNormalized(skillDir(vaultPath, skill)),
    cacheRow: cache.rows.find((r) => r.page_id === link.page_id),
    cacheValid: cacheIsValid(vaultPath, cache),
  });
}

/**
 * Notion-side rename pulled into the vault: rename the folder (shared helper),
 * then the link's names. The rename rewrites SKILL.md's `name`, which changes
 * the vault hash; when the vault was in sync before the rename, the new hash
 * and newest vault-side version become the baseline, so the skill stays
 * "synced" (a vault edit made before the rename still shows as a change).
 */
async function pullRename(vaultPath: string, skill: string, title: string): Promise<string> {
  const before = linkOf(vaultPath, skill);
  const inSync = !!before.vault_hash && hashSkillDirNormalized(skillDir(vaultPath, skill)) === before.vault_hash;
  await renameVaultSkill(vaultPath, skill, title);
  setSkillMdName(vaultPath, title, title);
  const next: NotionLink = { ...linkOf(vaultPath, title), notion_title: title, vault_name: title };
  if (inSync) {
    const hash = hashSkillDirNormalized(skillDir(vaultPath, title));
    const baseVault = listVersions(vaultPath, title).find((v) => v.side === "vault")?.id;
    if (hash) next.vault_hash = hash;
    if (baseVault) next.base_vault_version = baseVault;
  }
  setNotionLink(vaultPath, title, next);
  return `renamed in vault to "${title}"`;
}

/**
 * Execute one reviewed row. Returns a short message (and the skill's name
 * afterwards, if it still exists) on success; throws on
 * failure (the caller records it for this row only). Conflict rows must be
 * rejected by the caller before any row runs.
 */
export async function executeRow(
  d: SyncDeps,
  vaultPath: string,
  row: ReviewRow,
  action: string | undefined,
  cacheRows: NotionCacheRow[],
): Promise<{ message: string; skill?: string }> {
  if (row.kind === "conflict") throw new Error("conflict rows are resolved in Conflicts");
  if (row.kind === "deleted") {
    const chosen = (action ?? row.default_action) as DeletedAction | undefined;
    if (!chosen || !row.actions?.includes(chosen)) {
      throw new Error(`action must be one of: ${(row.actions ?? []).join(", ")}`);
    }
    const message = await runDeleted(d, vaultPath, row, chosen);
    return { message, ...(chosen === "delete-vault" ? {} : { skill: row.skill }) };
  }

  if (row.direction === "push") {
    const skill = row.skill!;
    if (row.kind === "update") {
      await pushSkill(d, vaultPath, skill);
      return { message: "pushed", skill };
    }
    if (row.kind === "new") {
      await pushSkill(d, vaultPath, skill, { create: true });
      return { message: "created in Notion", skill };
    }
    return { message: await pushRename(d, vaultPath, skill), skill };
  }

  // pull
  if (row.kind === "new") {
    const cacheRow = cacheRows.find((r) => r.page_id === row.page_id);
    if (!cacheRow) throw new Error("this Notion page is no longer in the cache — reload the plan");
    const name = await adoptFromNotion(d, vaultPath, cacheRow);
    return { message: `adopted as "${name}"`, skill: name };
  }
  const skill = row.skill!;
  if (row.kind === "rename") return { message: await pullRename(vaultPath, skill, row.title!), skill: row.title! };
  const r = await pullSkill(d, vaultPath, skill);
  if (r.result === "conflict") {
    throw new Error(`both sides changed the same lines (${r.reason ?? "no base"}) — resolve it in Conflicts`);
  }
  return { message: "pulled", skill };
}

// ── Force ───────────────────────────────────────────────────────

/** Skip reason for legacy links in force / bulk push runs. */
export const LEGACY_SKIP = "legacy Notion summary page — skipped; use Notion ▾ → Upgrade legacy pages";

export interface ForceTarget {
  id: string;
  skill: string;
  /** Set when the target must be skipped (reported as an error for that skill). */
  skip?: string;
  /** Push only: the skill has no link and was explicitly listed → create its Notion page. */
  create?: boolean;
}

/**
 * Which skills a force run touches. "All" = every linked, non-legacy skill
 * whose folder exists. An explicit list may also name never-linked skills
 * (push only: their Notion page is created). Legacy, unlinked and folder-less
 * skills are skipped; nothing is ever deleted.
 */
export function forceTargets(vaultPath: string, direction: Direction, skills?: string[]): ForceTarget[] {
  const manifest = readManifest(vaultPath);
  const id = (skill: string) => `force:${direction}:${skill}`;
  if (!skills) {
    return Object.entries(manifest.skills)
      .filter(
        ([name, e]) =>
          e.notion?.state === "linked" && !!e.notion.page_id && fs.existsSync(skillDir(vaultPath, name)),
      )
      .map(([name]) => ({ id: id(name), skill: name }));
  }
  return [...new Set(skills)].map((skill): ForceTarget => {
    const entry = manifest.skills[skill];
    const t = { id: id(skill), skill };
    if (!entry) return { ...t, skip: `skill "${skill}" not found` };
    if (!fs.existsSync(skillDir(vaultPath, skill))) return { ...t, skip: "no vault folder — nothing to sync" };
    const link = entry.notion;
    if (link?.state === "legacy") return { ...t, skip: LEGACY_SKIP };
    if (!link) {
      return direction === "push" ? { ...t, create: true } : { ...t, skip: "not linked to Notion" };
    }
    if (link.state !== "linked" || !link.page_id) return { ...t, skip: `link is ${link.state} — skipped` };
    return t;
  });
}

export async function executeForce(d: SyncDeps, vaultPath: string, direction: Direction, t: ForceTarget): Promise<string> {
  if (t.skip) throw new Error(t.skip);
  if (direction === "push") {
    await pushSkill(d, vaultPath, t.skill, t.create ? { create: true } : { force: true });
    return t.create ? "created in Notion" : "force-pushed";
  }
  if (await alreadySynced(d, vaultPath, t.skill)) return "already in sync — nothing to pull";
  await pullSkill(d, vaultPath, t.skill, { force: true });
  return "force-pulled";
}

/**
 * True when neither side moved since the last sync: the vault hash matches
 * the link and Notion's live version (downloaded now, not the possibly
 * stale cache) is the one the link recorded. A force pull skips those.
 */
async function alreadySynced(d: SyncDeps, vaultPath: string, skill: string): Promise<boolean> {
  const link = readManifest(vaultPath).skills[skill]?.notion;
  if (!link?.synced_at || !link.vault_hash || !link.notion_version_id || link.state !== "linked") return false;
  if (hashSkillDirNormalized(skillDir(vaultPath, skill)) !== link.vault_hash) return false;
  return (await d.api.downloadSkill(link.page_id)).versionId === link.notion_version_id;
}

// ── Push selected (non-force) ───────────────────────────────────

export const CHANGED_IN_NOTION = "Changed in Notion — resolve in Conflicts";

/**
 * Bulk "Push to Notion" for skills the user selected: a normal (non-force)
 * push per skill. Never overwrites a Notion edit — a skill that is not in
 * sync with Notion (never synced, or Notion changed) fails with
 * CHANGED_IN_NOTION. A never-linked skill gets a new Notion page (it was
 * explicitly selected). Targets come from `forceTargets(…, "push", skills)`,
 * so legacy / unlinked / folder-less skills are skipped with a reason.
 */
export async function executePushSelected(d: SyncDeps, vaultPath: string, t: ForceTarget): Promise<string> {
  if (t.skip) throw new Error(t.skip);
  if (t.create) {
    await pushSkill(d, vaultPath, t.skill, { create: true });
    return "created in Notion";
  }
  const link = readManifest(vaultPath).skills[t.skill]?.notion;
  if (link?.synced_at && link.vault_hash && hashSkillDirNormalized(skillDir(vaultPath, t.skill)) === link.vault_hash) {
    return "no vault changes — nothing to push";
  }
  try {
    await pushSkill(d, vaultPath, t.skill);
  } catch (err) {
    if (err instanceof NotionChangedError) throw new Error(CHANGED_IN_NOTION);
    throw err;
  }
  return "pushed";
}
