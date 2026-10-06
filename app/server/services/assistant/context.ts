/**
 * Per-turn context for the assistant: which lead agent runs, and the
 * compact `--append-system-prompt` block describing the vault, the chat's
 * focus (skill / selection / filters), recent failures, and Notion state.
 *
 * `buildTurnContext` is pure (data in, string out) and size-capped;
 * `gatherTurnContext` does the IO. Fresh context every turn is deliberate —
 * statuses move under a long chat, and the block is tiny.
 */

import type { ActivityEntry } from "../../types/vault.ts";
import { listActivity } from "../activity.ts";
import { readAppConfig } from "../appConfig.ts";
import { DEFAULT_ADOPT_PATH } from "../adoption.ts";
import { getSkillDetail } from "../vault.ts";
import { readNotionAuth, readNotionSettings } from "../notion/store.ts";
import type { AgentKind, ChatContextChip } from "./session.ts";

export const LEAD_AGENTS: Record<AgentKind, string> = {
  vault: "vault-manager",
  skill: "skill-agent",
};

export function pickLeadAgent(agent: AgentKind): string {
  return LEAD_AGENTS[agent];
}

export interface TurnContextData {
  vaultPath: string;
  reposDir: string;
  agent: AgentKind;
  skill?: string;
  /** Compact facts about the focused skill (origin, statuses). */
  skillDetail?: {
    origin?: unknown;
    status?: string;
    stage?: string;
    targets?: string[];
    notion_state?: string;
  };
  chips: ChatContextChip[];
  recentErrors: ActivityEntry[];
  notion: { connected: boolean; data_source_name?: string };
}

const CONTEXT_CAP = 2_500;

export function resolveReposDir(cfg: Record<string, unknown>): string {
  const fromCfg = cfg.repos_dir;
  if (typeof fromCfg === "string" && fromCfg) return fromCfg;
  return DEFAULT_ADOPT_PATH;
}

/** IO half: snapshot everything the pure builder needs. Never throws. */
export function gatherTurnContext(opts: {
  agent: AgentKind;
  skill?: string;
  chips?: ChatContextChip[];
}): TurnContextData {
  const cfg = readAppConfig();
  const vaultPath = cfg.vault_path ?? "";
  let skillDetail: TurnContextData["skillDetail"];
  if (opts.skill && vaultPath) {
    try {
      const d = getSkillDetail(vaultPath, opts.skill, cfg.providers) as unknown as Record<string, unknown> | null;
      if (d) {
        skillDetail = {
          origin: d.origin,
          status: typeof d.status === "string" ? d.status : undefined,
          stage: typeof d.stage === "string" ? d.stage : undefined,
          targets: Array.isArray(d.targets) ? (d.targets as string[]) : undefined,
          notion_state: (d.notion_status as { state?: string } | undefined)?.state,
        };
      }
    } catch {
      /* detail is best-effort context, never fatal */
    }
  }
  let notion: TurnContextData["notion"] = { connected: false };
  try {
    const auth = readNotionAuth() as { tokens?: unknown } | null;
    const settings = vaultPath ? (readNotionSettings(vaultPath) as { data_source_name?: string }) : {};
    notion = { connected: Boolean(auth && auth.tokens), data_source_name: settings.data_source_name };
  } catch {
    /* same */
  }
  return {
    vaultPath,
    reposDir: resolveReposDir(cfg as unknown as Record<string, unknown>),
    agent: opts.agent,
    skill: opts.skill,
    skillDetail,
    chips: opts.chips ?? [],
    recentErrors: listActivity().filter((e) => !e.ok).slice(-5),
    notion,
  };
}

/** Pure half: the system-prompt block, hard-capped at {@link CONTEXT_CAP} chars. */
export function buildTurnContext(data: TurnContextData): string {
  const lines: string[] = [
    "# Skill Vault session context",
    `Vault: ${data.vaultPath || "(not configured)"}`,
    `Repos dir (git clones live here): ${data.reposDir}`,
    "App operations run ONLY through the mcp__vault__* tools — never guess HTTP endpoints or hand-edit skills.json.",
  ];

  if (data.agent === "skill" && data.skill) {
    lines.push(`Focus skill: ${data.skill}`);
    if (data.skillDetail) {
      const d = data.skillDetail;
      if (d.origin) lines.push(`  origin: ${JSON.stringify(d.origin)}`);
      if (d.status) lines.push(`  provider status: ${d.status}${d.stage && d.stage !== "production" ? ` (${d.stage})` : ""}`);
      if (d.targets?.length) lines.push(`  targets: ${d.targets.join(", ")}`);
      if (d.notion_state) lines.push(`  notion: ${d.notion_state}`);
    }
  } else {
    lines.push("Scope: whole vault (no single skill in focus).");
  }

  for (const chip of data.chips) {
    if (chip.kind === "skills" && Array.isArray(chip.data?.skills)) {
      const names = chip.data.skills as string[];
      lines.push(`User-selected skills (${names.length}): ${names.slice(0, 40).join(", ")}${names.length > 40 ? ", …" : ""}`);
    } else if (chip.kind === "filter" && chip.data) {
      lines.push(`Active Skills-page filters: ${JSON.stringify(chip.data)}`);
    } else if (chip.kind === "failure" && chip.data) {
      lines.push(`Failure in focus (${chip.label}): ${JSON.stringify(chip.data)}`);
    } else if (chip.kind === "page") {
      lines.push(`User is on the ${chip.label} page.`);
    }
  }

  lines.push(
    data.notion.connected
      ? `Notion: connected${data.notion.data_source_name ? ` (data source "${data.notion.data_source_name}")` : ""}`
      : "Notion: not connected (OAuth happens in the app UI, not via tools)",
  );

  if (data.recentErrors.length > 0) {
    lines.push("Recent failed operations (newest last):");
    for (const e of data.recentErrors) {
      const msg = (e.message ?? "").slice(0, 160);
      lines.push(`  [${e.kind}] ${e.skill}${e.provider_id ? ` → ${e.provider_id}` : ""}: ${msg}`);
    }
  }

  let out = lines.join("\n");
  if (out.length > CONTEXT_CAP) out = `${out.slice(0, CONTEXT_CAP - 1)}…`;
  return out;
}
