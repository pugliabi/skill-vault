import type { Skill } from "./types";

/**
 * Heuristic auto-tagging (v1).
 *
 * Only 6/227 skills are tagged, which leaves group-by-tag and the tag
 * filter effectively dead. This derives tag suggestions from a skill's
 * name + description using a curated keyword map, plus a light
 * name-prefix cluster rule. It is intentionally deterministic and
 * dependency-free — no network, no Python — so it runs entirely in the
 * browser against the skill list the app already has.
 *
 * Upgrade path: swap `suggestTags` for a call to an AI endpoint backed by
 * the `ai_scanner` / `perplexity_stage` config keys when higher-recall
 * categorization is wanted. The review-dialog UI stays the same.
 */

interface Rule {
  tag: string;
  pattern: RegExp;
}

// High-precision domain rules. Order doesn't matter — all matches apply.
const RULES: Rule[] = [
  { tag: "web", pattern: /\b(browser|scrap(e|ing)|puppeteer|playwright|crawl|website|selenium|\bdom\b|bookmark)\b/i },
  { tag: "image", pattern: /\b(image|photo|png|jpe?g|\bsvg\b|imagemagick|screenshot|background[- ]remov|upscal|nano banana)\b/i },
  { tag: "video", pattern: /\b(video|veo|seedance|\bwan\b|lipsync|foley|animate|animation)\b/i },
  { tag: "audio", pattern: /\b(audio|speech|transcri|voice|\btts\b|music|\bsound\b)\b/i },
  { tag: "pdf", pattern: /\bpdf\b/i },
  { tag: "docx", pattern: /\b(docx|word document)\b/i },
  { tag: "spreadsheet", pattern: /\b(xlsx|spreadsheet|excel|\bcsv\b)\b/i },
  { tag: "pptx", pattern: /\b(pptx|powerpoint|slides?)\b/i },
  { tag: "powerbi", pattern: /\b(power ?bi|\bdax\b|tmdl|\bfabric\b|semantic model|pbir|pbip|lakehouse|medallion|notebook)\b/i },
  { tag: "data", pattern: /\b(\bsql\b|database|postgres|mongo|analytics|dataset|pandas|spark|data ?viz|visuali[sz])\b/i },
  { tag: "ai", pattern: /\b(\bllm\b|\bgpt\b|claude|gemini|prompt|inference|embedding|multimodal|\bagent\b)\b/i },
  { tag: "testing", pattern: /\b(pytest|end[- ]to[- ]end|\be2e\b|unit test|\btdd\b|test runner)\b/i },
  { tag: "devops", pattern: /\b(docker|kubernetes|ci\/cd|deploy|terraform|pipeline)\b/i },
  { tag: "api", pattern: /\b(\brest\b|graphql|\bgrpc\b|\bapi\b|endpoint|webhook)\b/i },
  { tag: "docs", pattern: /\b(documentation|readme|changelog|docs? site|markdown)\b/i },
  { tag: "cli", pattern: /\b(\bcli\b|command[- ]line|terminal|\bshell\b|bash|powershell)\b/i },
  { tag: "automation", pattern: /\b(automat(e|ion)|workflow|\bn8n\b|zapier|\bcron\b|schedul)\b/i },
  { tag: "search", pattern: /\b(search|research|perplexity|\bbrave\b|firecrawl|\bexa\b)\b/i },
  { tag: "design", pattern: /\b(design|\bui\b|\bux\b|\bcss\b|tailwind|figma|color|palette)\b/i },
  { tag: "notion", pattern: /\bnotion\b/i },
  { tag: "slack", pattern: /\bslack\b/i },
  { tag: "git", pattern: /\b(\bgit\b|github|worktree|commit|pull request)\b/i },
];

// Common name prefixes worth clustering into a tag (skill families).
const PREFIX_TAGS: Record<string, string> = {
  "powerbi-": "powerbi",
  "pbi": "powerbi",
  "pbir": "powerbi",
  "pbip": "powerbi",
  "fabric-": "powerbi",
  "spark-": "data",
  "dax": "powerbi",
  "prompting-": "ai",
  "prompt-": "ai",
  "ai-": "ai",
};

/**
 * Suggest tags for a skill, excluding any it already has.
 * Returns [] when nothing confident matches.
 */
export function suggestTags(skill: Skill): string[] {
  const hay = `${skill.name} ${skill.description}`.toLowerCase();
  const out = new Set<string>();

  for (const r of RULES) {
    if (r.pattern.test(hay)) out.add(r.tag);
  }
  for (const [prefix, tag] of Object.entries(PREFIX_TAGS)) {
    if (skill.name.toLowerCase().startsWith(prefix)) out.add(tag);
  }

  const existing = new Set(skill.tags);
  return [...out].filter((t) => !existing.has(t)).sort();
}

export interface AutoTagRow {
  skill: string;
  suggested: string[];
}

/**
 * Build suggestions across a list of skills. By default only considers
 * skills that are currently untagged (the 221/227 gap); pass
 * `onlyUntagged: false` to suggest additions for already-tagged skills too.
 * Rows with no suggestions are omitted.
 */
export function buildSuggestions(
  skills: Skill[],
  opts: { onlyUntagged?: boolean } = {},
): AutoTagRow[] {
  const onlyUntagged = opts.onlyUntagged ?? true;
  const rows: AutoTagRow[] = [];
  for (const s of skills) {
    if (onlyUntagged && s.tags.length > 0) continue;
    const suggested = suggestTags(s);
    if (suggested.length > 0) rows.push({ skill: s.name, suggested });
  }
  return rows;
}
