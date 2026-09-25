/**
 * First-run linking between vault skills and native Notion Skills, plus the
 * cache refresh behind "Check now". Writes only skills.json link records,
 * notion.json (linked_at), the per-machine cache and history versions —
 * never skill content on either side.
 */
import fs from "node:fs";
import path from "node:path";
import { listVersions, recordVersion, type HistorySide } from "../history.ts";
import { hashSkillDirNormalized } from "../skillHash.ts";
import { readManifest, skillDir } from "../vault.ts";
import type { NotionLink } from "../../types/vault.ts";
import type { NotionApi } from "./api.ts";
import { isLegacyConversion, isNotionNative, matchSkills, skillDirsEquivalent } from "./matching.ts";
import {
  readNotionCache,
  readNotionSettings,
  setNotionLink,
  writeNotionCache,
  writeNotionSettings,
  type NotionCache,
  type NotionCacheRow,
} from "./store.ts";

export interface LinkSummary {
  linked_in_sync: string[];
  conflicts: string[];
  legacy: string[];
  notion_only_compatible: Array<{ page_id: string; title: string }>;
  notion_only_native: Array<{ page_id: string; title: string }>;
  vault_only: string[];
  errors: Array<{ skill: string; error: string }>;
}

export interface LinkDeps {
  api: NotionApi;
  extract: (url: string) => Promise<{ skillRoot: string; cleanup(): void }>;
}

export class NoDataSourceError extends Error {
  constructor() {
    super("No Notion Skills data source selected — choose one in Settings");
  }
}

const SKIP = new Set(["node_modules", "__pycache__", ".git", ".DS_Store", "Thumbs.db"]);

/** Read a skill folder into rel ("/"-separated) → bytes, skipping the history skip set. */
export function readSkillFiles(root: string, rel = "", out = new Map<string, Buffer>()): Map<string, Buffer> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) readSkillFiles(root, childRel, out);
    else if (e.isFile()) out.set(childRel, fs.readFileSync(path.join(root, childRel)));
  }
  return out;
}

/** Manifest skills that have a folder on disk, with their current link. */
function vaultSkills(vaultPath: string): Array<{ name: string; link?: NotionLink }> {
  const manifest = readManifest(vaultPath);
  return Object.entries(manifest.skills)
    .filter(([name]) => fs.existsSync(skillDir(vaultPath, name)))
    .map(([name, entry]) => ({ name, link: entry.notion }));
}

/** Notion-only rows (no vault match) split into folder-compatible and Notion-native. */
export function notionOnlySummary(
  vaultPath: string,
  rows: NotionCacheRow[],
): Pick<LinkSummary, "notion_only_compatible" | "notion_only_native"> {
  return splitNotionOnly(matchSkills(vaultSkills(vaultPath), rows).notionOnly);
}

function splitNotionOnly(
  notionOnly: NotionCacheRow[],
): Pick<LinkSummary, "notion_only_compatible" | "notion_only_native"> {
  const pick = (r: NotionCacheRow) => ({ page_id: r.page_id, title: r.title });
  return {
    notion_only_compatible: notionOnly.filter((r) => !isNotionNative(r)).map(pick),
    notion_only_native: notionOnly.filter((r) => isNotionNative(r)).map(pick),
  };
}

function isNewer(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a !== b;
  return ta > tb;
}

/**
 * List the chosen data source's rows and fill `version_id` for linked rows.
 * A row linked in the manifest is re-downloaded (metadata only — the archive
 * is never fetched here) when it has no edited_at, or was edited after the
 * link's notion_edited_at and the previous cache doesn't already hold a
 * version for that exact edited_at. Otherwise the link's version is reused.
 */
export async function refreshNotionCache(api: NotionApi, vaultPath: string): Promise<NotionCache> {
  const settings = readNotionSettings(vaultPath);
  const dsId = settings.data_source_id;
  if (!dsId) throw new NoDataSourceError();
  const rows = await api.listRows(dsId, settings.last_edited_property ?? null);

  const links = new Map<string, NotionLink>();
  for (const entry of Object.values(readManifest(vaultPath).skills)) {
    const l = entry.notion;
    if (l?.page_id && (l.state === "linked" || l.state === "legacy")) links.set(l.page_id, l);
  }
  const prevCache = readNotionCache();
  const prev = new Map(
    prevCache.data_source_id === dsId ? prevCache.rows.map((r) => [r.page_id, r] as const) : [],
  );

  const out: NotionCacheRow[] = [];
  for (const row of rows) {
    const link = links.get(row.page_id);
    const next: NotionCacheRow = { ...row };
    if (link) {
      const p = prev.get(row.page_id);
      if (row.edited_at && link.notion_edited_at && !isNewer(row.edited_at, link.notion_edited_at) && link.notion_version_id) {
        next.version_id = link.notion_version_id;
      } else if (row.edited_at && p?.edited_at === row.edited_at && p.version_id) {
        next.version_id = p.version_id;
      } else {
        try {
          next.version_id = (await api.downloadSkill(row.page_id)).versionId;
        } catch (err) {
          console.error(`[notion] version check failed for ${row.page_id}: ${(err as Error).message}`);
          if (p?.version_id) next.version_id = p.version_id;
        }
      }
    }
    out.push(next);
  }

  const cache: NotionCache = { checked_at: new Date().toISOString(), data_source_id: dsId, rows: out };
  writeNotionCache(cache);
  return cache;
}

const KNOWN_LINK_KEYS = new Set([
  "page_id", "state", "linked_at", "synced_at", "vault_hash", "notion_version_id",
  "notion_edited_at", "base_vault_version", "base_notion_version", "notion_title",
]);

/** Unknown fields of an existing link, carried over on rewrite. */
function extraFields(link?: NotionLink): Record<string, unknown> {
  if (!link) return {};
  return Object.fromEntries(Object.entries(link).filter(([k]) => !KNOWN_LINK_KEYS.has(k)));
}

function newestVersionId(vaultPath: string, skill: string, side: HistorySide): string | undefined {
  return listVersions(vaultPath, skill).find((v) => v.side === side)?.id;
}

export async function runFirstLink(
  deps: LinkDeps,
  vaultPath: string,
  onProgress?: (done: number, total: number, skill: string) => void,
): Promise<LinkSummary> {
  const cache = await refreshNotionCache(deps.api, vaultPath);
  const vault = vaultSkills(vaultPath);
  const { pairs, notionOnly, vaultOnly } = matchSkills(vault, cache.rows);
  const linkOf = new Map(vault.map((v) => [v.name, v.link] as const));

  const summary: LinkSummary = {
    linked_in_sync: [],
    conflicts: [],
    legacy: [],
    ...splitNotionOnly(notionOnly),
    vault_only: [...vaultOnly].sort(),
    errors: [],
  };

  const total = pairs.length;
  for (let i = 0; i < total; i++) {
    const { vault: name, row } = pairs[i];
    onProgress?.(i, total, name);
    const existing = linkOf.get(name);
    const samePage = existing?.page_id === row.page_id;

    // Idempotent re-run: nothing new on the Notion side since the last link.
    // An in-sync link is only skipped when the vault copy is also unchanged;
    // otherwise it is re-evaluated against a fresh download below.
    if (samePage && row.version_id && row.version_id === existing!.notion_version_id) {
      if (
        existing!.state === "linked" &&
        existing!.synced_at &&
        !!existing!.vault_hash &&
        hashSkillDirNormalized(skillDir(vaultPath, name)) === existing!.vault_hash
      ) {
        summary.linked_in_sync.push(name);
        continue;
      }
      if (existing!.state === "legacy") {
        summary.legacy.push(name);
        continue;
      }
    }

    try {
      const dl = await deps.api.downloadSkill(row.page_id);
      const ex = await deps.extract(dl.url);
      try {
        const now = new Date().toISOString();
        const vaultDir = skillDir(vaultPath, name);
        const vaultFiles = readSkillFiles(vaultDir);
        const notionFiles = readSkillFiles(ex.skillRoot);
        const base = {
          ...extraFields(existing),
          page_id: row.page_id,
          linked_at: samePage && existing?.linked_at ? existing.linked_at : now,
          notion_version_id: dl.versionId,
          ...(row.edited_at ? { notion_edited_at: row.edited_at } : {}),
          notion_title: row.title,
        };

        const legacy = isLegacyConversion({
          vaultName: name,
          notionTitle: row.title,
          notionHasFiles: row.has_files,
          vaultHasSupportingFiles: [...vaultFiles.keys()].some((k) => k !== "SKILL.md"),
          notionSkillMd: notionFiles.get("SKILL.md")?.toString("utf8") ?? "",
        });
        if (legacy) {
          recordVersion(vaultPath, name, { side: "notion", source: "legacy-snapshot", dir: ex.skillRoot, always: true });
          setNotionLink(vaultPath, name, { ...base, state: "legacy" });
          summary.legacy.push(name);
          continue;
        }

        const { equivalent } = skillDirsEquivalent(vaultFiles, notionFiles);
        recordVersion(vaultPath, name, { side: "notion", source: "notion-edit", note: "linked", dir: ex.skillRoot });
        recordVersion(vaultPath, name, { side: "vault", source: "external-edit", note: "linked" });
        if (equivalent) {
          const vaultHash = hashSkillDirNormalized(vaultDir);
          const baseNotion = newestVersionId(vaultPath, name, "notion");
          const baseVault = newestVersionId(vaultPath, name, "vault");
          setNotionLink(vaultPath, name, {
            ...base,
            state: "linked",
            synced_at: now,
            ...(vaultHash ? { vault_hash: vaultHash } : {}),
            ...(baseNotion ? { base_notion_version: baseNotion } : {}),
            ...(baseVault ? { base_vault_version: baseVault } : {}),
          });
          summary.linked_in_sync.push(name);
        } else {
          setNotionLink(vaultPath, name, { ...base, state: "linked" });
          summary.conflicts.push(name);
        }
      } finally {
        ex.cleanup();
      }
    } catch (err) {
      summary.errors.push({ skill: name, error: (err as Error).message });
    }
  }
  onProgress?.(total, total, "");

  summary.linked_in_sync.sort();
  summary.conflicts.sort();
  summary.legacy.sort();
  writeNotionSettings(vaultPath, { linked_at: new Date().toISOString() });
  return summary;
}
