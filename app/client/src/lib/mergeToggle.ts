import type { MergeResult } from "./types";

/**
 * Client port of server/services/claude/merge.ts `toggleDecision` — keep the
 * two in step. Flip one decision to the other side: replaces the first
 * occurrence of its current `merged_text` in the owning file with
 * `vault_text`/`notion_text`, and updates the decision's `chosen`/
 * `merged_text` to match. No-op (returns `result` unchanged) if the
 * decision is marked `toggleable:false`, or the decision or its file/text
 * can't be found.
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
