/**
 * The tools the setup guide offers as targets. Same list and rule as the
 * CLI's `sv init` (src/skill_vault/config.py DEFAULT_AGENT_LOCATIONS and
 * discovery.detect_agent_dirs): a tool counts as installed when the parent
 * of its skills folder exists (e.g. ~/.cursor). Keep the two lists in step.
 */
import fs from "node:fs";
import path from "node:path";
import type { Provider } from "../../types/vault.ts";

export const KNOWN_TARGETS: ReadonlyArray<{ id: string; label: string; dir: string }> = [
  { id: "claude", label: "Claude Code", dir: ".claude" },
  { id: "openclaw", label: "OpenClaw", dir: ".openclaw" },
  { id: "cursor", label: "Cursor", dir: ".cursor" },
  { id: "codex", label: "Codex", dir: ".codex" },
  { id: "copilot", label: "Copilot", dir: ".copilot" },
  { id: "windsurf", label: "Windsurf", dir: ".windsurf" },
];

export type TargetStatus = "found" | "installed" | "not_found";

export interface DetectedTarget {
  id: string;
  label: string;
  path: string;
  status: TargetStatus;
  configured: boolean;
  is_default: boolean;
  known: boolean;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function targetStatus(p: string): TargetStatus {
  if (isDir(p)) return "found";
  if (isDir(path.dirname(p))) return "installed";
  return "not_found";
}

export function detectTargets(home: string, cfg: { providers: Provider[]; default_targets?: string[] }): DetectedTarget[] {
  const configured = new Map(cfg.providers.map((p) => [p.id, p.path]));
  const defaults = new Set(cfg.default_targets ?? []);
  const known = KNOWN_TARGETS.map((k) => {
    const p = configured.get(k.id) ?? path.join(home, k.dir, "skills");
    return {
      id: k.id,
      label: k.label,
      path: p,
      status: targetStatus(p),
      configured: configured.has(k.id),
      is_default: defaults.has(k.id),
      known: true,
    };
  });
  const custom = [...configured]
    .filter(([id]) => !KNOWN_TARGETS.some((k) => k.id === id))
    .map(([id, p]) => ({ id, label: id, path: p, status: targetStatus(p), configured: true, is_default: defaults.has(id), known: false }));
  return [...known, ...custom];
}
