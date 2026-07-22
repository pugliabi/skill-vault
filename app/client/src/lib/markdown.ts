/**
 * Single-source markdown renderer for the file preview pane.
 *
 * Uses `marked` synchronously with GFM features (tables, strikethrough,
 * task lists) but soft line breaks OFF, matching standard CommonMark
 * paragraph behavior.
 *
 * No DOMPurify in v1 — the vault is single-user-local, content is the
 * user's own files (CONTEXT.md). Revisit if vault sharing ever ships.
 *
 * Renders are O(content size); the preview pane upstream filters files
 * to ≤256KB so pathological cases don't reach this layer.
 */

import { marked } from "marked";

marked.use({
  gfm: true,
  breaks: false,
});

/** Render markdown source to an HTML string. */
export function renderMarkdown(source: string): string {
  return marked.parse(source, { async: false }) as string;
}
