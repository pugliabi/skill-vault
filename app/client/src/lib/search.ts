import type { Skill } from "./types";

export type SearchScope = "all" | "name" | "description" | "content" | "tags";

export const SEARCH_SCOPES: Array<{ id: SearchScope; label: string }> = [
  { id: "all", label: "All" },
  { id: "name", label: "Name" },
  { id: "description", label: "Description" },
  { id: "content", label: "Content" },
  { id: "tags", label: "Tags" },
];

const PREFIXES: Record<string, SearchScope> = {
  name: "name",
  desc: "description",
  description: "description",
  content: "content",
  body: "content",
  tag: "tags",
  tags: "tags",
  all: "all",
};

/**
 * Split an inline `scope:` prefix off the query ("name:pdf" → name / "pdf").
 * Without a recognised prefix the selected scope applies unchanged.
 */
export function parseSearch(
  raw: string,
  selected: SearchScope,
): { scope: SearchScope; term: string } {
  const m = /^(\w+):\s*(.*)$/.exec(raw.trim());
  if (m && PREFIXES[m[1].toLowerCase()]) {
    return { scope: PREFIXES[m[1].toLowerCase()], term: m[2].toLowerCase() };
  }
  return { scope: selected, term: raw.trim().toLowerCase() };
}

/** Does the skill match `term` within `scope`? Content hits come from the server's full-text search. */
export function matchesSearch(
  s: Skill,
  scope: SearchScope,
  term: string,
  fullTextNames: Set<string>,
): boolean {
  if (!term) return true;
  const inName = s.name.toLowerCase().includes(term);
  const inDesc = s.description.toLowerCase().includes(term);
  const inTags = s.tags.some((t) => t.toLowerCase().includes(term));
  switch (scope) {
    case "name":
      return inName;
    case "description":
      return inDesc;
    case "tags":
      return inTags;
    case "content":
      return fullTextNames.has(s.name);
    case "all":
      return inName || inDesc || inTags || fullTextNames.has(s.name);
  }
}

/** Lower is better: exact name, name prefix, name substring, anything else. */
export function searchRank(s: Skill, term: string): number {
  if (!term) return 0;
  const n = s.name.toLowerCase();
  if (n === term) return 0;
  if (n.startsWith(term)) return 1;
  if (n.includes(term)) return 2;
  return 3;
}
