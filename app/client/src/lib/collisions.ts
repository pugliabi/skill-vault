import type { Skill } from "./types";

/**
 * Trigger-collision detection — unique to a whole-vault view.
 *
 * When two skills have near-identical descriptions, the agent can't tell
 * them apart and may fire the wrong one. No per-skill tool can catch this;
 * it needs the whole corpus. We compare description token sets pairwise
 * (Jaccard) and surface pairs above a similarity threshold.
 *
 * O(n²) over skills with a usable description — a few tens of thousands of
 * small set comparisons for a couple hundred skills; trivial in the browser.
 */

const STOP = new Set([
  "when", "with", "this", "that", "your", "from", "into", "using", "used",
  "the", "and", "for", "use", "user", "skill", "agent", "should",
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface Collision {
  a: string;
  b: string;
  similarity: number;
}

export function findCollisions(skills: Skill[], threshold = 0.55): Collision[] {
  const usable = skills.filter(
    (s) => s.description && s.description.trim().length > 20,
  );
  const toks = new Map(usable.map((s) => [s.name, tokens(s.description)]));
  const out: Collision[] = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const sim = jaccard(
        toks.get(usable[i].name)!,
        toks.get(usable[j].name)!,
      );
      if (sim >= threshold) {
        out.push({ a: usable[i].name, b: usable[j].name, similarity: sim });
      }
    }
  }
  return out.sort((x, y) => y.similarity - x.similarity);
}
