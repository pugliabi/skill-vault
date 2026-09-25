/**
 * Claude-assisted merge for a skill edited on both sides (vault + Notion)
 * since the last sync. Unlike the deterministic 3-way `mergeSkillMd` used
 * for ordinary pulls, this is for the case that merge can't resolve: both
 * sides changed overlapping regions, or more than SKILL.md's body changed.
 *
 * Hunk-based: only the regions where the vault and Notion copies differ
 * (plus a few context lines, the base region when there is one, and a
 * heading outline for orientation) go to Claude, and Claude answers with a
 * choice per hunk — never whole files. The server rebuilds every file from
 * the vault copy (hunks.ts). Hunks that only differ in formatting are
 * resolved to the vault side without asking. The prompt and schema are
 * built here (pure, no I/O); `runClaudeJson` (cli.ts) does the CLI call.
 */
import { type ClaudeRunner, runClaudeJson } from "./cli.ts";
import {
  bothLines,
  customLines,
  decisionTexts,
  type FilePlan,
  type Hunk,
  hunkPayloadBytes,
  planHunks,
  rebuildFile,
} from "./hunks.ts";

export interface MergeInput {
  skill: string;
  files: Array<{ path: string; base: string | null; vault: string | null; notion: string | null }>;
  vaultEditedAt?: string;
  notionEditedAt?: string;
}

export interface MergeDecision {
  id: string;
  file: string;
  summary: string;
  /** Claude's "custom" choice is reported as "both". */
  chosen: "vault" | "notion" | "both";
  vault_text: string;
  notion_text: string;
  merged_text: string;
  overlapping: boolean;
  /** false when the decision's text isn't unique in its file, so it can't be flipped safely. */
  toggleable?: boolean;
}

export interface MergeResult {
  explanation: string;
  vault_changes: string[];
  notion_changes: string[];
  files: Array<{ path: string; content: string }>;
  decisions: MergeDecision[];
  /** Things the user should check by hand (missing Claude answers, non-toggleable decisions), in plain words. */
  warnings: string[];
  /** CLI-reported cost of the call, when it reports one. */
  cost_usd?: number;
}

/** Thrown instead of calling Claude when the differing regions are too big for one prompt. */
export class TooLargeError extends Error {
  constructor(skill: string) {
    super(`"${skill}" has too many edits for Claude to merge — pick a side or edit manually`);
  }
}

/** ~150 KB of UTF-8 hunk text (context + base + vault + notion lines) per merge. */
export const HUNK_PAYLOAD_CAP_BYTES = 150_000;

/**
 * Merges get a longer CLI timeout than other Claude calls (180 s default in
 * cli.ts): even hunk-only prompts on a skill with many changed regions can
 * take several minutes, and several merges may run in parallel.
 */
export const MERGE_TIMEOUT_MS = 600_000;

type HunkChoice = "vault" | "notion" | "both" | "custom";
const VALID_CHOICES = new Set<unknown>(["vault", "notion", "both", "custom"]);

/** Only the string entries of what should be a string array. */
function stringsOnly(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

interface ClaudeHunkAnswer {
  id: string;
  choice: HunkChoice;
  custom_text?: string;
  summary: string;
  overlapping: boolean;
}

interface ClaudeMergeOutput {
  explanation: string;
  vault_changes: string[];
  notion_changes: string[];
  hunks: ClaudeHunkAnswer[];
}

const SYSTEM_PROMPT = `You are merging two independently edited copies of an agent skill's files: one copy was edited locally in a "vault", the other in Notion. You are NOT shown whole files — only the regions ("hunks") where the two copies differ, each with a few unchanged context lines, the matching region of the shared base version when one exists, and a heading outline of each file for orientation. Everything outside the hunks is identical on both sides and stays as it is.

For every hunk, decide what the merged file should contain in place of that region:
- "vault": keep the vault lines.
- "notion": use the Notion lines.
- "both": keep the vault lines followed by the Notion lines (lines already in the vault lines are dropped from the Notion part automatically) — for independent additions on both sides.
- "custom": provide the exact replacement text in "custom_text" — only when the two sides must be interleaved or combined line by line. Use only text that appears in the hunk's vault, Notion, or base lines; never invent, summarize, or paraphrase. Do not repeat the context lines in custom_text.

Rules:
- When a base is given, a side whose lines equal the base did not change there: take the other side's change ("changed on" tells you which side moved).
- Keep every non-overlapping change from BOTH sides — never drop a change just because the other side also touched the file.
- When both sides changed the same region (an overlapping edit), prefer whichever side has the newer edit timestamp (vaultEditedAt vs notionEditedAt) and set "overlapping" to true; otherwise "overlapping" is false. Without a base, set "overlapping" true when both sides hold different real content for the region.
- Keep any YAML frontmatter (the block between --- fences at the top of a file) valid YAML.
- Answer every hunk id exactly once in "hunks", each with a short "summary" of what the region is and why you chose that side.
- Summarize what changed on each side overall as short bullet strings in "vault_changes" and "notion_changes", and give a one- or two-sentence overall "explanation" of the merge.`;

const MERGE_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["explanation", "vault_changes", "notion_changes", "hunks"],
  properties: {
    explanation: { type: "string" },
    vault_changes: { type: "array", items: { type: "string" } },
    notion_changes: { type: "array", items: { type: "string" } },
    hunks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "choice", "summary", "overlapping"],
        properties: {
          id: { type: "string" },
          choice: { type: "string", enum: ["vault", "notion", "both", "custom"] },
          custom_text: { type: "string" },
          summary: { type: "string" },
          overlapping: { type: "boolean" },
        },
      },
    },
  },
};

function block(label: string, lines: string[] | null): string {
  if (lines === null) return `${label}: (no base version)`;
  if (lines.length === 0) return `${label}: (no lines)`;
  return `${label}:\n"""\n${lines.join("\n")}\n"""`;
}

function renderHunk(h: Hunk): string {
  const vRange = h.vEnd > h.vStart ? `vault lines ${h.vStart + 1}-${h.vEnd}` : `insertion after vault line ${h.vStart}`;
  const nRange = h.nEnd > h.nStart ? `notion lines ${h.nStart + 1}-${h.nEnd}` : `nothing in notion`;
  const parts = [`--- Hunk ${h.id} · ${h.file} · ${vRange} · ${nRange}${h.changed_on ? ` · changed on: ${h.changed_on}` : ""} ---`];
  if (h.context_before.length) parts.push(block("Context before", h.context_before));
  parts.push(block("Base", h.base_lines));
  parts.push(block("Vault", h.vault_lines));
  parts.push(block("Notion", h.notion_lines));
  if (h.context_after.length) parts.push(block("Context after", h.context_after));
  return parts.join("\n");
}

function sentHunks(plans: FilePlan[]): Hunk[] {
  return plans.flatMap((p) => p.hunks.filter((h) => !h.auto));
}

function renderPrompt(input: MergeInput, plans: FilePlan[]): string {
  const lines: string[] = [];
  lines.push(`Skill: ${input.skill}`);
  if (input.vaultEditedAt) lines.push(`vaultEditedAt: ${input.vaultEditedAt}`);
  if (input.notionEditedAt) lines.push(`notionEditedAt: ${input.notionEditedAt}`);
  lines.push("");
  for (const p of plans) {
    const hunks = p.hunks.filter((h) => !h.auto);
    if (hunks.length === 0) continue;
    const fi = input.files.find((f) => f.path === p.path);
    const size = (t: string | null | undefined, n: number) => (t === null ? "missing" : `${n} lines`);
    lines.push(`=== File: ${p.path} (vault: ${size(fi?.vault, p.vault.lines.length)}, notion: ${size(fi?.notion, p.notion.lines.length)}) ===`);
    lines.push(p.outline.length ? `Outline:\n${p.outline.map((o) => `  ${o}`).join("\n")}` : "Outline: (no headings)");
    lines.push("");
    for (const h of hunks) {
      lines.push(renderHunk(h));
      lines.push("");
    }
  }
  return lines.join("\n");
}

/** Pure prompt/schema construction — no I/O, easy to unit test independently of the CLI. */
export function buildMergePrompt(input: MergeInput): { system: string; user: string; schema: object } {
  return { system: SYSTEM_PROMPT, user: renderPrompt(input, planHunks(input.files)), schema: MERGE_RESULT_SCHEMA };
}

function fallbackChoice(h: Hunk): "vault" | "notion" {
  return h.changed_on === "notion" ? "notion" : "vault";
}

/**
 * Rebuild every file from Claude's per-hunk answers and derive one
 * decision per sent hunk. Auto-resolved (formatting-only) hunks keep the
 * vault lines and get no decision.
 */
export function assembleMergeResult(input: MergeInput, plans: FilePlan[], output: ClaudeMergeOutput): MergeResult {
  const warnings: string[] = [];
  const answers = new Map<string, ClaudeHunkAnswer>();
  const known = new Set(sentHunks(plans).map((h) => h.id));
  for (const a of Array.isArray(output.hunks) ? output.hunks : []) {
    if (!a || typeof a !== "object" || typeof a.id !== "string") continue;
    if (!known.has(a.id)) {
      console.warn(`[claude-merge] ignoring answer for unknown hunk "${a.id}"`);
      continue;
    }
    if (!answers.has(a.id)) answers.set(a.id, a);
  }

  const effective = new Map<string, { choice: HunkChoice; custom?: string; summary: string; overlapping: boolean }>();
  for (const h of sentHunks(plans)) {
    const a = answers.get(h.id);
    if (!a || !VALID_CHOICES.has(a.choice)) {
      const side = fallbackChoice(h);
      warnings.push(
        `Claude didn't decide on a region of ${h.file} near line ${h.vStart + 1} — kept the ${side === "vault" ? "vault" : "Notion"} version; review it.`,
      );
      effective.set(h.id, { choice: side, summary: "Not decided by Claude — kept one side", overlapping: true });
    } else if (a.choice === "custom" && typeof a.custom_text !== "string") {
      warnings.push(`Claude chose a custom merge in ${h.file} near line ${h.vStart + 1} without text — kept both sides; review it.`);
      effective.set(h.id, { choice: "both", summary: String(a.summary ?? ""), overlapping: a.overlapping === true });
    } else {
      effective.set(h.id, { choice: a.choice, custom: a.custom_text, summary: String(a.summary ?? ""), overlapping: a.overlapping === true });
    }
  }

  const choose = (h: Hunk): string[] => {
    const e = effective.get(h.id);
    if (!e) return h.vault_lines; // auto-resolved
    if (e.choice === "vault") return h.vault_lines;
    if (e.choice === "notion") return h.notion_lines;
    if (e.choice === "both") return bothLines(h);
    return customLines(e.custom ?? "");
  };

  const files: MergeResult["files"] = [];
  const decisions: MergeDecision[] = [];
  let autoCount = 0;
  for (const plan of plans) {
    const rebuilt = rebuildFile(plan, choose);
    files.push({ path: plan.path, content: rebuilt.content });
    rebuilt.hunks.forEach((rh, idx) => {
      const e = effective.get(rh.hunk.id);
      if (!e) {
        autoCount++;
        return;
      }
      const t = decisionTexts(rebuilt, idx);
      const d: MergeDecision = {
        id: rh.hunk.id,
        file: plan.path,
        summary: e.summary,
        chosen: e.choice === "custom" ? "both" : e.choice,
        vault_text: t.vault_text,
        notion_text: t.notion_text,
        merged_text: t.merged_text,
        overlapping: e.overlapping,
      };
      if (!t.toggleable) {
        d.toggleable = false;
        if (e.overlapping) {
          warnings.push(`A decision in ${plan.path} ("${e.summary}") can't be flipped automatically — edit that file manually if needed.`);
        }
      }
      decisions.push(d);
    });
  }

  let explanation = typeof output.explanation === "string" ? output.explanation : "";
  if (autoCount > 0) {
    explanation = `${explanation}${explanation ? " " : ""}(${autoCount} formatting-only difference${autoCount === 1 ? " was" : "s were"} kept as in the vault.)`;
  }
  return {
    explanation,
    vault_changes: stringsOnly(output.vault_changes),
    notion_changes: stringsOnly(output.notion_changes),
    files,
    decisions,
    warnings,
  };
}

/**
 * Ask Claude to merge `input`'s files hunk by hunk, rebuild them, and
 * return the result. Throws `TooLargeError` before ever calling Claude when
 * the hunk payload is over the ~150 KB cap. When every difference is
 * formatting-only, Claude isn't called at all.
 */
export async function mergeWithClaude(input: MergeInput, runner?: ClaudeRunner): Promise<MergeResult> {
  const plans = planHunks(input.files);
  const hunks = sentHunks(plans);
  if (hunkPayloadBytes(hunks) > HUNK_PAYLOAD_CAP_BYTES) {
    throw new TooLargeError(input.skill);
  }
  if (hunks.length === 0) {
    return assembleMergeResult(input, plans, {
      explanation: "The two copies only differ in formatting; the vault version was kept.",
      vault_changes: [],
      notion_changes: [],
      hunks: [],
    });
  }

  const user = renderPrompt(input, plans);
  const { output, costUsd } = await runClaudeJson<ClaudeMergeOutput>(user, SYSTEM_PROMPT, MERGE_RESULT_SCHEMA, runner, {
    timeoutMs: MERGE_TIMEOUT_MS,
  });
  const result = assembleMergeResult(input, plans, output);
  return costUsd === undefined ? result : { ...result, cost_usd: costUsd };
}

/**
 * Flip one decision to the other side: replaces the first occurrence of its
 * current `merged_text` in the owning file with `vault_text`/`notion_text`,
 * and updates the decision's `chosen`/`merged_text` to match. No-op (returns
 * `result` unchanged) if the decision is marked `toggleable:false`, or the
 * decision or its file/text can't be found.
 */
export function toggleDecision(result: MergeResult, id: string, side: "vault" | "notion"): MergeResult {
  const decisionIdx = result.decisions.findIndex((d) => d.id === id);
  if (decisionIdx < 0) return result;
  const decision = result.decisions[decisionIdx];
  if (decision.toggleable === false) return result;

  const fileIdx = result.files.findIndex((f) => f.path === decision.file);
  if (fileIdx < 0) return result;
  const file = result.files[fileIdx];

  const newText = side === "vault" ? decision.vault_text : decision.notion_text;
  const pos = file.content.indexOf(decision.merged_text);
  if (pos < 0) return result;

  const newContent = file.content.slice(0, pos) + newText + file.content.slice(pos + decision.merged_text.length);

  const files = [...result.files];
  files[fileIdx] = { ...file, content: newContent };

  const decisions = [...result.decisions];
  decisions[decisionIdx] = { ...decision, chosen: side, merged_text: newText };

  return { ...result, files, decisions };
}
