import type { Skill } from "./types";

/**
 * Heuristic quality score for a skill (0-100), computed client-side from
 * the fields the list already carries. The dominant factor is whether the
 * description is strong enough to *trigger* reliably — a vague or missing
 * description is why an agent fails to invoke a skill it has.
 */
export interface QualityResult {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  issues: string[];
}

export function scoreSkill(s: Skill): QualityResult {
  const issues: string[] = [];
  let score = 100;

  if (!s.has_skill_md) {
    score -= 60;
    issues.push("No SKILL.md");
  }
  const desc = (s.description || "").trim();
  if (!desc) {
    score -= 30;
    issues.push("No description — the agent has nothing to trigger on");
  } else if (desc.length < 40) {
    score -= 15;
    issues.push("Description too short to trigger reliably");
  }
  if (desc && !/\b(use when|use this|when the user|trigger|for )/i.test(desc)) {
    score -= 10;
    issues.push("No trigger phrasing (e.g. “Use when…”)");
  }
  if (s.file_count <= 1) {
    score -= 5;
    issues.push("Only one file");
  }
  if (s.tags.length === 0) {
    score -= 5;
    issues.push("Untagged");
  }

  score = Math.max(0, Math.min(100, score));
  const grade =
    score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";
  return { score, grade, issues };
}

/** Color for a grade, using the app's semantic tokens. */
export function gradeColor(grade: QualityResult["grade"]): string {
  switch (grade) {
    case "A":
    case "B":
      return "var(--ok)";
    case "C":
      return "var(--warn)";
    default:
      return "var(--bad)";
  }
}
