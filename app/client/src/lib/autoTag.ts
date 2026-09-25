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
 * This is the fallback: when the Claude Code CLI is available the review
 * dialog asks the server (POST /api/tags/suggest) to classify skills with
 * AI from name + description + SKILL.md, and uses these rules only when
 * the CLI is missing or a batch fails.
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
  { tag: "fabric", pattern: /\b(microsoft fabric|in (microsoft )?fabric|sql databases? in (microsoft )?fabric|fabric (workspace|capacit(y|ies)|items?|notebooks?|pipelines?|cli|api|rest)|lakehouses?|warehouses?|onelake|dataflows?|eventhouses?|eventstreams?|kql database|spark (notebooks?|jobs?|sessions?)|medallion|databricks|synapse|hdinsight|mirrored (database|catalog)s?)\b/i },
  { tag: "powerbi", pattern: /\b(power ?bi|\bdax\b|tmdl|semantic models?|pbir|pbip|tabular editor|power query|bpa rules?|best practice analyzer)\b/i },
  { tag: "data", pattern: /\b(\bsql\b|database|postgres|mongo|analytics|dataset|pandas|spark|data ?viz|visuali[sz])\b/i },
  { tag: "ai", pattern: /\b(\bllm\b|\bgpt\b|claude|gemini|prompt|inference|embedding|multimodal|\bagent\b)\b/i },
  { tag: "testing", pattern: /\b(pytest|end[- ]to[- ]end|\be2e\b|unit test|\btdd\b|test runner)\b/i },
  { tag: "devops", pattern: /\b(docker|kubernetes|ci\/cd|deploy|terraform|pipeline)\b/i },
  { tag: "api", pattern: /\b(\brest\b|graphql|\bgrpc\b|\bapi\b|endpoint|webhook)\b/i },
  { tag: "docs", pattern: /\b(documentation|readme|changelog|docs? site|markdown)\b/i },
  { tag: "automation", pattern: /\b(automat(e|ion)|workflow|\bn8n\b|zapier|\bcron\b|schedul)\b/i },
  { tag: "search", pattern: /\b(search|research|perplexity|\bbrave\b|firecrawl|\bexa\b)\b/i },
  { tag: "design", pattern: /\b(design|\bui\b|\bux\b|\bcss\b|tailwind|figma|color|palette)\b/i },
  { tag: "notion", pattern: /\bnotion\b/i },
  { tag: "slack", pattern: /\bslack\b/i },
  { tag: "git", pattern: /\b(\bgit\b|github|worktree|commit|pull request)\b/i },
];

/**
 * `cli` only when the skill is ABOUT a command-line tool (strong phrasing,
 * or a cli-/-cli name) and no platform tag matched: a Fabric or Power BI
 * skill that happens to drive a CLI is tagged by its platform instead.
 */
const CLI_PATTERN =
  /\b(command[- ]line (tools?|interfaces?|utilit(y|ies)|apps?)|cli (tools?|wrappers?|harness(es)?)|terminal (workflows?|sessions?|apps?)|tmux|clink|shell (completions?|scripts?)|autocomplet(e|ion)s?|tab completion)\b/i;
const CLI_NAME = /(^cli-|-cli$|^cli$)/i;
const PLATFORM_TAGS = new Set(["fabric", "powerbi", "notion", "slack", "git", "grok"]);

/** The fallback never suggests more tags than the AI path may (MAX_TAGS_PER_SKILL). */
export const MAX_SUGGESTIONS = 5;

// Common name prefixes worth clustering into a tag (skill families).
const PREFIX_TAGS: Record<string, string> = {
  "powerbi-": "powerbi",
  "pbi": "powerbi",
  "pbir": "powerbi",
  "pbip": "powerbi",
  "fabric-": "fabric",
  "fabriciq-": "fabric",
  "dataflows-": "fabric",
  "eventhouse-": "fabric",
  "eventstream-": "fabric",
  "sqldw-": "fabric",
  "sqldb-": "fabric",
  "spark-": "fabric",
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
  const isPlatform = [...out].some((t) => PLATFORM_TAGS.has(t));
  if (!isPlatform && (CLI_PATTERN.test(hay) || CLI_NAME.test(skill.name))) {
    out.add("cli");
  }

  const existing = new Set(skill.tags);
  return [...out].filter((t) => !existing.has(t)).sort().slice(0, MAX_SUGGESTIONS);
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

/**
 * Split an AI recommendation (the full tag set a skill should have) into
 * what to add and what to remove relative to its current tags.
 */
export function diffTags(
  current: string[],
  recommended: string[],
): { add: string[]; remove: string[] } {
  const cur = new Set(current);
  const rec = new Set(recommended);
  return {
    add: recommended.filter((t) => !cur.has(t)),
    remove: current.filter((t) => !rec.has(t)),
  };
}
