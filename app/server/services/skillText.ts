/**
 * Small, dependency-free helpers for pulling readable text out of a
 * SKILL.md: the frontmatter `description` (including YAML block scalars)
 * and a trimmed body excerpt. Used by the skill list (vault.ts) and by
 * AI auto-tagging (aiTagging.ts).
 */

const FRONTMATTER_RE = /^﻿?---\s*\r?\n([\s\S]*?)\r?\n---[^\n]*(\r?\n|$)/;

/**
 * Read `description:` from YAML frontmatter. Handles a plain one-line
 * value, a quoted value, and block scalars (`>`, `|`, `>-`, `|+`, …),
 * whose indented continuation lines are joined with spaces. Returns ""
 * when there is no frontmatter or no description key.
 */
export function frontmatterDescription(text: string): string {
  const fm = text.match(FRONTMATTER_RE);
  if (!fm) return "";
  const lines = fm[1].split(/\r?\n/);
  const idx = lines.findIndex((l) => /^description:/.test(l));
  if (idx === -1) return "";
  const inline = lines[idx].replace(/^description:\s*/, "").trim();

  const isBlock = /^[>|][+-]?\d*$/.test(inline);
  if (inline && !isBlock) {
    return inline.replace(/^["']|["']$/g, "").trim();
  }
  // Block scalar (or empty value with an indented continuation).
  const parts: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    if (!/^\s/.test(l)) break; // next top-level key
    parts.push(l.trim());
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** SKILL.md body with the frontmatter block removed. */
export function stripFrontmatter(text: string): string {
  return text.replace(FRONTMATTER_RE, "");
}

/**
 * A compact excerpt of a SKILL.md body for classification: frontmatter
 * and fenced code blocks dropped (code is mostly noise for "what is this
 * about"), whitespace collapsed, capped at `maxChars` on a word boundary.
 */
export function bodyExcerpt(text: string, maxChars = 1200): string {
  const flat = stripFrontmatter(text)
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= maxChars) return flat;
  const cut = flat.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > maxChars * 0.8 ? cut.slice(0, lastSpace) : cut}…`;
}
