/** Pure logic for linking vault skills to Notion Skills. No I/O. */
import { normalizedContentHash } from "../skillHash.ts";
import type { NotionLink, NotionStatus } from "../../types/vault.ts";
import type { NotionCacheRow } from "./store.ts";

const VALID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidSkillName(s: string): boolean {
  return VALID.test(s);
}

export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export interface MatchResult {
  pairs: Array<{ vault: string; row: NotionCacheRow; how: "id" | "exact" | "normalized" }>;
  notionOnly: NotionCacheRow[];
  vaultOnly: string[];
}

export function matchSkills(
  vault: Array<{ name: string; link?: NotionLink }>,
  rows: NotionCacheRow[],
): MatchResult {
  const pairs: MatchResult["pairs"] = [];
  const usedRows = new Set<string>();
  const usedVault = new Set<string>();
  const excluded = new Set(
    vault.filter((v) => v.link && (v.link.state === "unlinked" || v.link.state === "vault-only")).map((v) => v.name),
  );
  const candidates = vault.filter((v) => !excluded.has(v.name));

  const take = (v: string, r: NotionCacheRow, how: "id" | "exact" | "normalized") => {
    pairs.push({ vault: v, row: r, how });
    usedRows.add(r.page_id);
    usedVault.add(v);
  };

  for (const v of candidates) {
    if (!v.link?.page_id) continue;
    const r = rows.find((x) => !usedRows.has(x.page_id) && x.page_id === v.link!.page_id);
    if (r) take(v.name, r, "id");
  }
  for (const v of candidates) {
    if (usedVault.has(v.name)) continue;
    const r = rows.find((x) => !usedRows.has(x.page_id) && x.title === v.name);
    if (r) take(v.name, r, "exact");
  }
  for (const v of candidates) {
    if (usedVault.has(v.name)) continue;
    const r = rows.find((x) => !usedRows.has(x.page_id) && normalizeName(x.title) === v.name);
    if (r) take(v.name, r, "normalized");
  }

  return {
    pairs,
    notionOnly: rows.filter((r) => !usedRows.has(r.page_id)),
    vaultOnly: vault.map((v) => v.name).filter((n) => !usedVault.has(n)),
  };
}

function frontmatterValue(lines: string[], key: string): string {
  const i = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (i < 0) return "";
  const inline = lines[i].slice(key.length + 1).trim();
  if (inline && !/^[|>][+-]?$/.test(inline)) return inline.replace(/^["']|["']$/g, "");
  const out: string[] = [];
  for (let j = i + 1; j < lines.length && /^\s+/.test(lines[j]); j++) out.push(lines[j].trim());
  return out.join(" ");
}

/**
 * Content-level fingerprint of markdown text: strips everything Notion is
 * known to rewrite when it regenerates a SKILL.md from its own blocks
 * (fenced code lines including their language tag, leading list/ordinal
 * markers, HTML tags, markdown link targets, bare URLs, stray `+`/`•`
 * bullet glyphs, and backslash escapes), then keeps only letters and digits,
 * joined with no separator so re-splitting of words by autolinking or
 * link-splitting can't change the result.
 */
export function contentFingerprint(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const noFences = lines.filter((l) => !/^\s*```/.test(l));
  const processed = noFences.map((l) => {
    let s = l;
    s = s.replace(/^\s*(?:[+*•-]|\d+[.)])\s*/, "");
    s = s.replace(
      /<\/?(?:p|b|i|u|s|em|strong|code|a|br|span|div|sub|sup|mark|ul|ol|li|pre|blockquote|h[1-6]|hr|table|thead|tbody|tr|td|th|details|summary)\b[^>]*>/gi,
      "",
    );
    s = s.replace(/\]\([^)]*\)/g, "");
    s = s.replace(/https?:\/\/\S+/g, "");
    s = s.replace(/[+•]/g, "");
    s = s.replace(/\\/g, "");
    return s;
  });
  return (processed.join("").match(/[\p{L}\p{N}]/gu) ?? []).join("");
}

function alnumLower(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function normalizeSkillMd(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let body = lines;
  let name = "";
  let description = "";
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      const fm = lines.slice(1, end);
      name = frontmatterValue(fm, "name");
      description = frontmatterValue(fm, "description");
      body = lines.slice(end + 1);
    }
  }
  return [
    `name:${alnumLower(name)}`,
    `description:${contentFingerprint(description)}`,
    contentFingerprint(body.join("\n")),
  ].join("\n");
}

export function skillDirsEquivalent(
  vaultFiles: Map<string, Buffer>,
  notionFiles: Map<string, Buffer>,
): { equivalent: boolean; differing: string[] } {
  const keys = [...new Set([...vaultFiles.keys(), ...notionFiles.keys()])].sort();
  const differing: string[] = [];
  for (const k of keys) {
    const a = vaultFiles.get(k);
    const b = notionFiles.get(k);
    if (!a || !b) {
      differing.push(k);
      continue;
    }
    const same =
      k === "SKILL.md"
        ? normalizeSkillMd(a.toString("utf8")) === normalizeSkillMd(b.toString("utf8"))
        : normalizedContentHash(k, a) === normalizedContentHash(k, b);
    if (!same) differing.push(k);
  }
  return { equivalent: differing.length === 0, differing };
}

export function isLegacyConversion(a: {
  vaultName: string;
  notionTitle: string;
  notionHasFiles: boolean;
  vaultHasSupportingFiles: boolean;
  notionSkillMd: string;
}): boolean {
  const displayTitle = a.notionTitle !== a.vaultName && normalizeName(a.notionTitle) === a.vaultName;
  const summaryShape =
    (!a.notionHasFiles && a.vaultHasSupportingFiles) || a.notionSkillMd.includes("What Claude automates");
  return displayTitle && summaryShape;
}

export function isNotionNative(row: NotionCacheRow): boolean {
  return !isValidSkillName(row.title);
}

export function computeNotionStatus(a: {
  link?: NotionLink;
  connected: boolean;
  vaultHash: string | null;
  /** The Notion cache row for link.page_id, if the cache has one. */
  cacheRow?: NotionCacheRow;
  /**
   * True when the per-machine cache was produced by a check (checked_at set)
   * against the currently chosen data source. An invalid cache says nothing
   * about the Notion side, so linked skills report "unchecked".
   */
  cacheValid: boolean;
}): NotionStatus | undefined {
  if (!a.connected) return undefined;
  const link = a.link;
  if (!link) return "not-in-notion";
  if (link.state === "legacy") return "legacy";
  if (link.state === "vault-only") return "vault-only";
  if (link.state === "unlinked") return "unlinked";
  if (!link.synced_at) return "conflict";
  if (!a.cacheValid) return "unchecked";
  if (!a.cacheRow) return "missing-in-notion";
  const vaultChanged = !!link.vault_hash && a.vaultHash !== link.vault_hash;
  if (!a.cacheRow.version_id) return vaultChanged ? "changed-vault" : "unchecked";
  const notionChanged = !!link.notion_version_id && a.cacheRow.version_id !== link.notion_version_id;
  if (vaultChanged && notionChanged) return "conflict";
  if (vaultChanged) return "changed-vault";
  if (notionChanged) return "changed-notion";
  return "synced";
}
