/**
 * SKILL.md patching for Notion pulls. Pure string functions, no I/O.
 *
 * A pull merges "what changed in Notion since the last sync" (base → Notion
 * now) onto the vault's SKILL.md with a 3-way line merge of the body. The
 * frontmatter always starts from the vault's (so fields Notion does not know
 * about — license, allowed-tools, … — survive); only `name`/`description`
 * are taken from Notion, and only when Notion changed them. `notion_page_id`
 * (which Notion injects into its copy) is never written to the vault.
 */
import { diff3Merge } from "node-diff3";
import { contentFingerprint } from "./matching.ts";

export type MergeSkillMdResult = { ok: true; text: string } | { ok: false; reason: string };

interface Doc {
  bom: string;
  eol: "\n" | "\r\n";
  /** Frontmatter lines between the `---` fences (LF, no fences), or null. */
  fm: string[] | null;
  /** True when something (even an empty line) follows the closing fence. */
  afterFence: boolean;
  /** Everything after the closing fence's line break (LF). */
  body: string;
}

function parseDoc(text: string): Doc {
  let bom = "";
  if (text.startsWith("﻿")) {
    bom = "﻿";
    text = text.slice(1);
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lf = text.replace(/\r\n?/g, "\n");
  const lines = lf.split("\n");
  if (lines[0].trimEnd() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
    if (end > 0) {
      return {
        bom,
        eol,
        fm: lines.slice(1, end),
        afterFence: end + 1 < lines.length,
        body: lines.slice(end + 1).join("\n"),
      };
    }
  }
  return { bom, eol, fm: null, afterFence: false, body: lf };
}

function renderDoc(d: Doc): string {
  const lf = d.fm
    ? ["---", ...d.fm, "---"].join("\n") + (d.afterFence || d.body ? "\n" + d.body : "")
    : d.body;
  return d.bom + (d.eol === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf);
}

// ── Frontmatter entries ─────────────────────────────────────────

const KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(.*)$/;

/** [start, end) line range of a top-level key and its indented continuation. */
function findEntry(fm: string[], key: string): { start: number; end: number } | null {
  const start = fm.findIndex((l) => KEY_RE.exec(l)?.[1] === key);
  if (start < 0) return null;
  let end = start + 1;
  while (end < fm.length && (fm[end].trim() === "" || /^\s/.test(fm[end]))) end++;
  // Blank lines after the entry belong to the gap, not the entry.
  while (end > start + 1 && fm[end - 1].trim() === "") end--;
  return { start, end };
}

/** Best-effort scalar value of a top-level key (block, quoted or plain). */
export function readFrontmatterValue(fm: string[] | null, key: string): string | undefined {
  if (!fm) return undefined;
  const e = findEntry(fm, key);
  if (!e) return undefined;
  const raw = KEY_RE.exec(fm[e.start])![2].trim();
  const cont = fm.slice(e.start + 1, e.end);
  const block = /^([|>])([+-]?)\d*$/.exec(raw);
  if (block) {
    const indent = Math.min(...cont.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
    const lines = cont.map((l) => (l.trim() ? l.slice(Number.isFinite(indent) ? indent : 0) : ""));
    const joined = block[1] === "|" ? lines.join("\n") : lines.join(" ").replace(/ {2,}/g, " ");
    return joined.replace(/\s+$/, "");
  }
  const full = [raw, ...cont.map((l) => l.trim())].filter((s) => s !== "").join(" ");
  if (full.startsWith('"')) {
    try {
      return String(JSON.parse(full));
    } catch {
      return full.replace(/^"|"$/g, "");
    }
  }
  if (full.startsWith("'")) return full.replace(/^'|'$/g, "").replace(/''/g, "'");
  return full;
}

const YAML_RESERVED = /^(?:true|false|yes|no|on|off|null|~|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|\.inf|\.nan)$/i;

function serializeEntry(key: string, value: string): string[] {
  if (value.includes("\n")) {
    return [`${key}: |-`, ...value.split("\n").map((l) => (l ? `  ${l}` : ""))];
  }
  const plainSafe =
    value !== "" &&
    value.trim() === value &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
    !/:\s|\s#|:$/.test(value) &&
    !YAML_RESERVED.test(value);
  return [`${key}: ${plainSafe ? value : JSON.stringify(value)}`];
}

function setEntry(fm: string[], key: string, value: string): string[] {
  const out = [...fm];
  const lines = serializeEntry(key, value);
  const e = findEntry(out, key);
  if (e) {
    out.splice(e.start, e.end - e.start, ...lines);
  } else {
    const after = key === "description" ? findEntry(out, "name") : null;
    out.splice(after ? after.end : 0, 0, ...lines);
  }
  return out;
}

function removeEntry(fm: string[], key: string): string[] {
  const e = findEntry(fm, key);
  if (!e) return fm;
  const out = [...fm];
  out.splice(e.start, e.end - e.start);
  return out;
}

// ── Public API ──────────────────────────────────────────────────

/** Remove the `notion_page_id` frontmatter key; returns the text unchanged when absent. */
export function stripNotionPageId(skillMd: string): string {
  const d = parseDoc(skillMd);
  if (!d.fm || !findEntry(d.fm, "notion_page_id")) return skillMd;
  return renderDoc({ ...d, fm: removeEntry(d.fm, "notion_page_id") });
}

function splitBody(body: string): { lead: string; lines: string[]; trail: string } {
  const m = /^(\n*)([\s\S]*?)(\n*)$/.exec(body)!;
  return { lead: m[1], lines: m[2] === "" ? [] : m[2].split("\n"), trail: m[3] };
}

const FM_KEYS = ["name", "description"] as const;

/**
 * 3-way merge: apply the Notion-side change (base → notionNow) onto `vault`.
 * The body is merged line by line (leading/trailing blank lines are ignored
 * for the merge and kept as the vault had them); overlapping edits fail.
 * Frontmatter: the vault's, with `name`/`description` from Notion when
 * Notion changed them (both sides changing one differently fails), and
 * without `notion_page_id`. Output uses the vault's line endings.
 */
export function mergeSkillMd(base: string, notionNow: string, vault: string): MergeSkillMdResult {
  const b = parseDoc(base);
  const n = parseDoc(notionNow);
  const v = parseDoc(vault);

  let fm = v.fm ? [...v.fm] : [];
  for (const key of FM_KEYS) {
    const bv = readFrontmatterValue(b.fm, key) ?? "";
    const nv = readFrontmatterValue(n.fm, key);
    if (nv === undefined || nv === bv) continue;
    const vv = readFrontmatterValue(fm, key) ?? "";
    // Whether the VAULT changed the field is judged by content (Notion
    // reformats text on its side, so a byte comparison against a
    // Notion-made base is meaningless). Whether the vault already HAS
    // Notion's value must be exact: a Notion punctuation-only edit has the
    // same fingerprint but still has to be applied.
    const vaultChanged = contentFingerprint(vv) !== contentFingerprint(bv);
    const vaultHasIt = vv === nv;
    if (vaultHasIt) continue;
    if (vaultChanged) return { ok: false, reason: `both sides changed the SKILL.md ${key}` };
    fm = setEntry(fm, key, nv);
  }
  fm = removeEntry(fm, "notion_page_id");

  const vb = splitBody(v.body);
  const regions = diff3Merge(vb.lines, splitBody(b.body).lines, splitBody(n.body).lines, {
    excludeFalseConflicts: true,
  });
  const conflict = regions.find((r) => r.conflict);
  if (conflict?.conflict) {
    return {
      ok: false,
      reason: `overlapping edits in the SKILL.md body near line ${conflict.conflict.aIndex + 1}`,
    };
  }
  const merged = regions.flatMap((r) => r.ok ?? []);
  const outFm = v.fm ? fm : fm.length ? fm : null;
  const bodyText = vb.lead + merged.join("\n") + vb.trail;
  return {
    ok: true,
    text: renderDoc({ ...v, fm: outFm, body: bodyText }),
  };
}

/**
 * Force-pull flavour: Notion's body and Notion's `name`/`description`, on
 * top of the vault's frontmatter (other fields kept), never `notion_page_id`,
 * in the vault's line endings. With no vault SKILL.md, Notion's file minus
 * `notion_page_id`.
 */
export function overlayNotionSkillMd(notionNow: string, vault: string | null): string {
  if (vault === null) return stripNotionPageId(notionNow);
  const n = parseDoc(notionNow);
  const v = parseDoc(vault);
  let fm = v.fm ? [...v.fm] : [];
  for (const key of FM_KEYS) {
    const nv = readFrontmatterValue(n.fm, key);
    if (nv !== undefined && nv !== readFrontmatterValue(fm, key)) fm = setEntry(fm, key, nv);
  }
  fm = removeEntry(fm, "notion_page_id");
  const outFm = v.fm || fm.length ? fm : null;
  return renderDoc({ ...v, fm: outFm, afterFence: n.afterFence || !!n.body, body: n.body });
}
