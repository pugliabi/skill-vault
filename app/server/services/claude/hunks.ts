/**
 * Hunk planning and file rebuilding for the Claude merge (pure, no I/O).
 *
 * Instead of sending whole files to Claude and asking for whole merged
 * files back (slow and expensive on large skills — output tokens dominate),
 * each differing text file is cut into line hunks between the vault and
 * Notion copies. Only those hunks (plus a little context) go to Claude;
 * Claude answers with a choice per hunk, and the server rebuilds every file
 * from the vault copy by swapping in the chosen text.
 */
import { diffIndices } from "node-diff3";
import { HTML_WRAPPER_TAG_RE } from "../notion/matching.ts";

const FENCE_RE = /^\s*(```+|~~~+)/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const LIST_MARKER_RE = /^\s*(?:[+*•-]|\d+[.)])\s+/;
const ESCAPED_PUNCT_RE = /\\([!-/:-@[-`{-~])/g;

/** Normalize Markdown text outside code spans: HTML emphasis → Markdown, other wrapper tags dropped, escapes undone. */
function normalizeProse(s: string): string {
  return s
    .replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, "[$2]($1)")
    .replace(/<\/?(?:b|strong)\b[^>]*>/gi, "**")
    .replace(/<\/?(?:i|em)\b[^>]*>/gi, "*")
    .replace(/<\/?code\b[^>]*>/gi, "`")
    .replace(HTML_WRAPPER_TAG_RE, "")
    .replace(/__(?=\S)(.+?)__/g, "**$1**")
    .replace(ESCAPED_PUNCT_RE, "$1");
}

/**
 * What a hunk side says, ignoring only true formatting: whitespace, list
 * marker style and numbering, code-fence language labels, table separator
 * rows, HTML wrapper tags (emphasis/code tags count as their Markdown
 * form), `__x__` vs `**x**`, and backslash escapes before punctuation.
 * Everything else — link targets, URLs, punctuation, code-span and
 * fenced-code content — is kept, so a real edit is never auto-resolved.
 */
export function formattingFingerprint(lines: string[]): string {
  const out: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (FENCE_RE.test(line)) {
      out.push("```");
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (TABLE_SEPARATOR_RE.test(line)) continue;
    const body = line.replace(LIST_MARKER_RE, "");
    // Code spans are kept verbatim; only the prose between them is normalized.
    const parts = body.split(/(`[^`]*`)/);
    out.push(parts.map((p, i) => (i % 2 === 1 ? p : normalizeProse(p))).join(""));
  }
  return out.join("\n").replace(/\s+/g, "");
}

/** Hunks separated by at most this many unchanged lines are merged into one. */
export const HUNK_MERGE_GAP = 3;
/** Unchanged context lines shown to Claude on each side of a hunk. */
export const HUNK_CONTEXT_LINES = 3;
/** Max headings listed in a file's outline. */
const OUTLINE_MAX = 80;

export interface HunkFileInput {
  path: string;
  base: string | null;
  vault: string | null;
  notion: string | null;
}

/** A text split into lines (terminators removed), plus how to put it back together. */
export interface SplitText {
  lines: string[];
  eol: string;
  trailingNewline: boolean;
}

export interface Hunk {
  id: string;
  file: string;
  /** Vault line range [vStart, vEnd) this hunk replaces. */
  vStart: number;
  vEnd: number;
  /** Notion line range [nStart, nEnd). */
  nStart: number;
  nEnd: number;
  vault_lines: string[];
  notion_lines: string[];
  /** Base region matching this hunk, or null when there is no base. */
  base_lines: string[] | null;
  context_before: string[];
  context_after: string[];
  /** Which side moved away from the base here (only when a base exists). */
  changed_on: "vault" | "notion" | "both" | null;
  /** Identical after normalization — resolved to the vault side, never sent to Claude. */
  auto: boolean;
}

export interface FilePlan {
  path: string;
  vault: SplitText;
  notion: SplitText;
  hunks: Hunk[];
  /** Headings of the file (vault copy, else Notion) as "L<n> <heading>". */
  outline: string[];
}

export function splitText(text: string | null): SplitText {
  if (text === null || text === "") return { lines: [], eol: "\n", trailingNewline: true };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const trailingNewline = lines[lines.length - 1] === "";
  if (trailingNewline) lines.pop();
  return { lines, eol, trailingNewline };
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((l, i) => l === b[i]);
}

/**
 * Changed regions between `a` and `b` as [aStart, aLen, bStart, bLen],
 * ascending. The common prefix/suffix is trimmed first: LCS cost grows with
 * repeated identical lines, and most of a skill is usually unchanged.
 */
function diffRegions(a: string[], b: string[]): Array<[number, number, number, number]> {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  if (am.length === 0 && bm.length === 0) return [];
  if (am.length === 0 || bm.length === 0) return [[pre, am.length, pre, bm.length]];
  return diffIndices(am, bm)
    .map((d): [number, number, number, number] => [d.buffer1[0] + pre, d.buffer1[1], d.buffer2[0] + pre, d.buffer2[1]])
    .sort((x, y) => x[0] - y[0]);
}

/** For each line of `a`, the index of the matching line in `b`, or -1 when it changed. */
function lineMap(a: string[], b: string[]): Int32Array {
  const map = new Int32Array(a.length).fill(-1);
  let ai = 0;
  let bi = 0;
  for (const [as, al, bs, bl] of diffRegions(a, b)) {
    while (ai < as) map[ai++] = bi++;
    ai = as + al;
    bi = bs + bl;
  }
  while (ai < a.length) map[ai++] = bi++;
  return map;
}

function outlineOf(lines: string[]): string[] {
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length && out.length < OUTLINE_MAX; i++) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
    else if (!inFence && /^#{1,6}\s/.test(l)) out.push(`L${i + 1} ${l.trim()}`);
  }
  return out;
}

/**
 * Cut every file into vault↔Notion hunks. Hunk ids are global ("h1", "h2",
 * …) across files, in file order then line order.
 */
export function planHunks(files: HunkFileInput[]): FilePlan[] {
  let next = 1;
  return files.map((f) => {
    const vault = splitText(f.vault);
    const notion = splitText(f.notion);
    const v = vault.lines;
    const n = notion.lines;
    const base = f.base === null ? null : splitText(f.base).lines;
    const vToBase = base ? lineMap(v, base) : null;

    // Raw diff regions, then merge the ones ≤ HUNK_MERGE_GAP unchanged lines apart.
    const ranges: Array<{ vStart: number; vEnd: number; nStart: number; nEnd: number }> = [];
    for (const [vs, vl, ns, nl] of diffRegions(v, n)) {
      const r = { vStart: vs, vEnd: vs + vl, nStart: ns, nEnd: ns + nl };
      const prev = ranges[ranges.length - 1];
      if (prev && r.vStart - prev.vEnd <= HUNK_MERGE_GAP) {
        prev.vEnd = r.vEnd;
        prev.nEnd = r.nEnd;
      } else {
        ranges.push(r);
      }
    }

    const hunks: Hunk[] = ranges.map((r) => {
      const vault_lines = v.slice(r.vStart, r.vEnd);
      const notion_lines = n.slice(r.nStart, r.nEnd);
      let base_lines: string[] | null = null;
      let changed_on: Hunk["changed_on"] = null;
      if (base && vToBase) {
        let bStart = 0;
        for (let i = r.vStart - 1; i >= 0; i--) {
          if (vToBase[i] >= 0) {
            bStart = vToBase[i] + 1;
            break;
          }
        }
        let bEnd = base.length;
        for (let i = r.vEnd; i < v.length; i++) {
          if (vToBase[i] >= 0) {
            bEnd = vToBase[i];
            break;
          }
        }
        base_lines = base.slice(bStart, Math.max(bStart, bEnd));
        const vc = !sameLines(vault_lines, base_lines);
        const nc = !sameLines(notion_lines, base_lines);
        changed_on = vc && nc ? "both" : vc ? "vault" : nc ? "notion" : "both";
      }
      return {
        id: "",
        file: f.path,
        ...r,
        vault_lines,
        notion_lines,
        base_lines,
        context_before: v.slice(Math.max(0, r.vStart - HUNK_CONTEXT_LINES), r.vStart),
        context_after: v.slice(r.vEnd, r.vEnd + HUNK_CONTEXT_LINES),
        changed_on,
        auto: formattingFingerprint(vault_lines) === formattingFingerprint(notion_lines),
      };
    });
    for (const h of hunks) h.id = `h${next++}`;

    return { path: f.path, vault, notion, hunks, outline: outlineOf(v.length ? v : n) };
  });
}

/** UTF-8 bytes of the text Claude would see for these hunks (context + all sides). */
export function hunkPayloadBytes(hunks: Hunk[]): number {
  let total = 0;
  for (const h of hunks) {
    for (const part of [h.context_before, h.context_after, h.vault_lines, h.notion_lines, h.base_lines ?? []]) {
      for (const l of part) total += Buffer.byteLength(l, "utf8") + 1;
    }
  }
  return total;
}

/** "both": vault lines, then the Notion lines the vault copy doesn't already have. */
export function bothLines(h: Pick<Hunk, "vault_lines" | "notion_lines">): string[] {
  const have = new Set(h.vault_lines.map((l) => l.trim()).filter(Boolean));
  return [...h.vault_lines, ...h.notion_lines.filter((l) => !l.trim() || !have.has(l.trim()))];
}

export function customLines(text: string): string[] {
  return splitText(text).lines;
}

export interface RebuiltHunk {
  hunk: Hunk;
  chosen: string[];
  /** Output line range [oStart, oEnd) the chosen lines occupy in the rebuilt file. */
  oStart: number;
  oEnd: number;
}

export interface RebuiltFile {
  path: string;
  content: string;
  lines: string[];
  eol: string;
  trailingNewline: boolean;
  hunks: RebuiltHunk[];
}

/** Render lines with `eol` after each; drop the last one when the span reaches EOF and the file has none. */
export function renderSpan(lines: string[], eol: string, reachesEof: boolean, trailingNewline: boolean): string {
  const s = lines.map((l) => l + eol).join("");
  return reachesEof && !trailingNewline && s.endsWith(eol) ? s.slice(0, -eol.length) : s;
}

/**
 * Rebuild one file from its vault copy: unchanged lines stay, each hunk's
 * vault lines are replaced by `choose(hunk)`. Line endings and the trailing
 * newline follow the vault copy (the Notion copy when the vault has none).
 */
export function rebuildFile(plan: FilePlan, choose: (h: Hunk) => string[]): RebuiltFile {
  const src = plan.vault.lines.length || plan.notion.lines.length === 0 ? plan.vault : plan.notion;
  const eol = plan.vault.lines.length ? plan.vault.eol : plan.notion.eol;
  const trailingNewline = src.trailingNewline;
  const v = plan.vault.lines;
  const out: string[] = [];
  const hunks: RebuiltHunk[] = [];
  let vi = 0;
  for (const h of plan.hunks) {
    while (vi < h.vStart) out.push(v[vi++]);
    const chosen = choose(h);
    const oStart = out.length;
    out.push(...chosen);
    hunks.push({ hunk: h, chosen, oStart, oEnd: out.length });
    vi = h.vEnd;
  }
  while (vi < v.length) out.push(v[vi++]);
  return {
    path: plan.path,
    content: renderSpan(out, eol, true, trailingNewline),
    lines: out,
    eol,
    trailingNewline,
    hunks,
  };
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return Infinity;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}

export interface DecisionTexts {
  vault_text: string;
  notion_text: string;
  merged_text: string;
  toggleable: boolean;
}

/**
 * The vault / Notion / merged texts for one rebuilt hunk, widened with
 * unchanged neighbouring lines (at most HUNK_CONTEXT_LINES each side, never
 * into another hunk) until every variant is non-empty and occurs exactly
 * once in the file it would sit in — so `toggleDecision`'s first-occurrence
 * replace always hits this hunk. `toggleable:false` when no widening works.
 */
export function decisionTexts(file: RebuiltFile, idx: number): DecisionTexts {
  const rh = file.hunks[idx];
  const prevEnd = idx > 0 ? file.hunks[idx - 1].oEnd : 0;
  const nextStart = idx + 1 < file.hunks.length ? file.hunks[idx + 1].oStart : file.lines.length;
  const maxBefore = Math.min(HUNK_CONTEXT_LINES, rh.oStart - prevEnd);
  const maxAfter = Math.min(HUNK_CONTEXT_LINES, nextStart - rh.oEnd);

  const texts = (eb: number, ea: number) => {
    const before = file.lines.slice(rh.oStart - eb, rh.oStart);
    const after = file.lines.slice(rh.oEnd, rh.oEnd + ea);
    const eof = rh.oEnd + ea >= file.lines.length;
    const r = (mid: string[]) => renderSpan([...before, ...mid, ...after], file.eol, eof, file.trailingNewline);
    return { vault_text: r(rh.hunk.vault_lines), notion_text: r(rh.hunk.notion_lines), merged_text: r(rh.chosen) };
  };

  const ok = (t: ReturnType<typeof texts>): boolean => {
    const f = file.content;
    if (countOccurrences(f, t.merged_text) !== 1) return false;
    const pos = f.indexOf(t.merged_text);
    for (const alt of [t.vault_text, t.notion_text]) {
      const g = f.slice(0, pos) + alt + f.slice(pos + t.merged_text.length);
      if (countOccurrences(g, alt) !== 1) return false;
    }
    return true;
  };

  let eb = 0;
  let ea = 0;
  for (;;) {
    const t = texts(eb, ea);
    if (ok(t)) return { ...t, toggleable: true };
    if (eb < maxBefore && (eb <= ea || ea >= maxAfter)) eb++;
    else if (ea < maxAfter) ea++;
    else break;
  }
  return { ...texts(0, 0), toggleable: false };
}
