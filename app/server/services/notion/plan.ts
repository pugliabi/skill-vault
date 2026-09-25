/**
 * Sync plan (pure). Given the current vault/Notion state, decides which
 * review rows a push or pull would show. No I/O — everything needed is
 * passed in by the caller (route handler), which reads the manifest and
 * the per-machine Notion cache.
 *
 * Row selection reuses `computeNotionStatus` for the vault/Notion "changed"
 * determination rather than re-deriving it, so the plan always agrees with
 * the status badges shown elsewhere in the UI.
 */
import type { NotionLink } from "../../types/vault.ts";
import { computeNotionStatus, isNotionNative, isValidSkillName } from "./matching.ts";
import type { NotionCacheRow } from "./store.ts";

export type RowKind = "update" | "new" | "rename" | "deleted" | "conflict";

export interface PlanRow {
  id: string;
  kind: RowKind;
  skill?: string;
  page_id?: string;
  title?: string;
  direction: "push" | "pull";
  default_selected: boolean;
  detail: string;
  warnings: string[];
}

export interface PlanSkillInput {
  name: string;
  link?: NotionLink;
  /** Normalized hash of the vault copy right now; null if unreadable. */
  vaultHash: string | null;
  /** Whether the skill's folder still exists on disk. */
  exists: boolean;
  /** Whether there is at least one history version recorded for this skill. */
  has_history: boolean;
}

export interface BuildPlanInput {
  direction: "push" | "pull";
  skills: PlanSkillInput[];
  rows: NotionCacheRow[];
  /** From the per-machine cache: true when it was freshly checked against the chosen data source. */
  cacheValid: boolean;
}

/** Thrown when the per-machine Notion cache is stale/invalid — caller should refresh and retry. */
export class CacheStaleError extends Error {
  constructor() {
    super("Notion cache is stale — refresh before building a sync plan");
  }
}

function rowId(direction: "push" | "pull", kind: RowKind, key: string): string {
  return `${direction}:${kind}:${key}`;
}

/** True when some OTHER row already claims this title — a rename target collision. */
function titleTaken(rows: NotionCacheRow[], title: string, exceptPageId: string): boolean {
  return rows.some((r) => r.title === title && r.page_id !== exceptPageId);
}

function buildPushRow(skill: PlanSkillInput, rows: NotionCacheRow[]): PlanRow | undefined {
  const { name, link } = skill;
  if (!link) {
    // Never linked — a candidate to create fresh in Notion.
    if (!skill.exists) return undefined;
    return {
      id: rowId("push", "new", name),
      kind: "new",
      skill: name,
      title: name,
      direction: "push",
      default_selected: false,
      detail: "Create in Notion",
      warnings: [],
    };
  }
  if (link.state !== "linked") return undefined; // legacy / unlinked / vault-only never produce rows

  // Vault folder gone: nothing to push regardless of the Notion side. With
  // history to restore from it is worth a review row; without it, there is
  // nothing actionable to show.
  if (!skill.exists) {
    if (!skill.has_history) return undefined;
    return {
      id: rowId("push", "deleted", name),
      kind: "deleted",
      skill: name,
      page_id: link.page_id,
      title: link.notion_title ?? name,
      direction: "push",
      default_selected: false,
      detail: "Deleted in vault — Unlink (trash it in Notion yourself)",
      warnings: [],
    };
  }

  const cacheRow = rows.find((r) => r.page_id === link.page_id);
  const status = computeNotionStatus({ link, connected: true, vaultHash: skill.vaultHash, cacheRow, cacheValid: true });

  // Conflict is evaluated before rename: a real conflict must never be
  // hidden behind a rename row.
  if (status === "conflict") {
    return {
      id: rowId("push", "conflict", name),
      kind: "conflict",
      skill: name,
      page_id: link.page_id,
      title: link.notion_title ?? name,
      direction: "push",
      default_selected: false,
      detail: "Both sides changed (or never synced) — review in Conflicts",
      warnings: [],
    };
  }

  if (status === "missing-in-notion") {
    return {
      id: rowId("push", "deleted", name),
      kind: "deleted",
      skill: name,
      page_id: link.page_id,
      title: link.notion_title ?? name,
      direction: "push",
      default_selected: false,
      detail: "Deleted in Notion — Re-create in Notion, or Unlink",
      warnings: [],
    };
  }

  // Vault-side rename: the folder name recorded at the last link/sync
  // differs from the current one, and the Notion side hasn't itself
  // changed (an old link with no recorded vault_name never renames).
  if (
    link.vault_name &&
    link.vault_name !== name &&
    status !== "changed-notion" &&
    !titleTaken(rows, name, link.page_id)
  ) {
    return {
      id: rowId("push", "rename", name),
      kind: "rename",
      skill: name,
      page_id: link.page_id,
      title: name,
      direction: "push",
      default_selected: false,
      detail: `Renamed in vault from "${link.vault_name}" to "${name}" — update the Notion skill name`,
      warnings: [],
    };
  }

  if (status === "changed-vault") {
    return {
      id: rowId("push", "update", name),
      kind: "update",
      skill: name,
      page_id: link.page_id,
      title: link.notion_title ?? name,
      direction: "push",
      default_selected: true,
      detail: "Push vault changes to Notion",
      warnings: [],
    };
  }
  return undefined;
}

function buildPullUpdateRow(skill: PlanSkillInput, cacheRow: NotionCacheRow): PlanRow {
  const { name, link } = skill;
  return {
    id: rowId("pull", "update", name),
    kind: "update",
    skill: name,
    page_id: link!.page_id,
    title: cacheRow.title,
    direction: "pull",
    default_selected: true,
    detail: "Pull Notion changes into the vault",
    warnings: [],
  };
}

function buildPullLinkedRow(skill: PlanSkillInput, rows: NotionCacheRow[]): PlanRow | undefined {
  const { name, link } = skill;
  if (!link || link.state !== "linked") return undefined; // legacy / unlinked / vault-only never produce rows

  const cacheRow = rows.find((r) => r.page_id === link.page_id);
  const status = computeNotionStatus({ link, connected: true, vaultHash: skill.vaultHash, cacheRow, cacheValid: true });

  if (status === "conflict") {
    return {
      id: rowId("pull", "conflict", name),
      kind: "conflict",
      skill: name,
      page_id: link.page_id,
      title: link.notion_title ?? name,
      direction: "pull",
      default_selected: false,
      detail: "Both sides changed (or never synced) — review in Conflicts",
      warnings: [],
    };
  }
  if (status === "missing-in-notion") {
    return {
      id: rowId("pull", "deleted", name),
      kind: "deleted",
      skill: name,
      page_id: link.page_id,
      title: link.notion_title ?? name,
      direction: "pull",
      default_selected: false,
      detail: "Deleted in Notion — Unlink, Delete from vault, or Re-create in Notion",
      warnings: [],
    };
  }
  if (
    cacheRow &&
    cacheRow.title !== name &&
    isValidSkillName(cacheRow.title) &&
    link.notion_title &&
    cacheRow.title !== link.notion_title
  ) {
    return {
      id: rowId("pull", "rename", name),
      kind: "rename",
      skill: name,
      page_id: link.page_id,
      title: cacheRow.title,
      direction: "pull",
      default_selected: false,
      detail: `Renamed to "${cacheRow.title}" in Notion — rename in vault`,
      warnings: [],
    };
  }
  if (status === "changed-notion" && cacheRow) {
    return buildPullUpdateRow(skill, cacheRow);
  }
  return undefined;
}

/**
 * Build the review rows for a push or a pull. Pure — throws `CacheStaleError`
 * when the per-machine cache is not valid (the caller should refresh and
 * call again) instead of producing a warning row.
 */
export function buildPlan(input: BuildPlanInput): PlanRow[] {
  if (!input.cacheValid) throw new CacheStaleError();

  const rows: PlanRow[] = [];

  if (input.direction === "push") {
    for (const skill of input.skills) {
      const row = buildPushRow(skill, input.rows);
      if (row) rows.push(row);
    }
    return rows;
  }

  // pull
  const linkedPageIds = new Set(
    input.skills.filter((s) => s.link?.page_id).map((s) => s.link!.page_id),
  );
  for (const skill of input.skills) {
    const row = buildPullLinkedRow(skill, input.rows);
    if (row) rows.push(row);
  }
  for (const notionRow of input.rows) {
    if (linkedPageIds.has(notionRow.page_id)) continue;
    if (isNotionNative(notionRow)) continue;
    rows.push({
      id: rowId("pull", "new", notionRow.page_id),
      kind: "new",
      page_id: notionRow.page_id,
      title: notionRow.title,
      direction: "pull",
      default_selected: true,
      detail: "Adopt into vault",
      warnings: [],
    });
  }
  return rows;
}
