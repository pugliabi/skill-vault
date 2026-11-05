/**
 * The setup guide's Agents step: what it can offer for the vault and tools
 * chosen in the draft, not the saved settings
 * (docs/superpowers/specs/2026-11-05-setup-agents-step-design.md).
 */
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../../types/vault.ts";
import { BUNDLED_SKILL_NAME } from "../agentAccess/bundledSkill.ts";
import type { PathEnv } from "../agentAccess/desktopConfig.ts";
import { desktopStatus, type DesktopStatus } from "../agentAccess/desktopConnect.ts";
import { readManifest } from "../vault.ts";
import { effectiveTargets } from "./plan.ts";
import type { SetupDraft } from "./types.ts";

export interface AgentsStatus {
  bridge_built: boolean;
  skill: { state: "not_in_vault" | "in_vault" | "adopting"; adopting_from?: string };
  desktop: DesktopStatus;
  default_targets: string[];
  vault_path: string;
}

/** Whether the draft's vault already has a skill-vault (ours or not: the Settings card sorts that out). */
export function skillInDraftVault(draft: SetupDraft): AgentsStatus["skill"] {
  const adopting = draft.skills.adopt.find((a) => a.name === BUNDLED_SKILL_NAME);
  if (adopting) return { state: "adopting", adopting_from: adopting.from };
  const v = draft.vault;
  if (!v || v.mode === "new") return { state: "not_in_vault" };
  if (v.mode === "clone") return { state: v.clone?.skill_names.includes(BUNDLED_SKILL_NAME) ? "in_vault" : "not_in_vault" };
  if (fs.existsSync(path.join(v.path, "skills", BUNDLED_SKILL_NAME))) return { state: "in_vault" };
  try {
    if (Object.hasOwn(readManifest(v.path).skills, BUNDLED_SKILL_NAME)) return { state: "in_vault" };
  } catch {
    /* no readable manifest: the folder alone decides */
  }
  return { state: "not_in_vault" };
}

export function agentsStatus(
  draft: SetupDraft,
  deps: { config: Pick<AppConfig, "providers" | "default_targets">; env: PathEnv; bridgePath: string | null },
): AgentsStatus {
  return {
    bridge_built: !!deps.bridgePath && fs.existsSync(deps.bridgePath),
    skill: skillInDraftVault(draft),
    desktop: desktopStatus(deps.env),
    default_targets: effectiveTargets(draft, deps.config).filter((t) => t.is_default).map((t) => t.id),
    vault_path: draft.vault?.path ?? "",
  };
}
