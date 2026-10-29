/**
 * Agent calls through the vault bridge (Claude Desktop, Claude Code, the
 * shared `skill-vault` command) count as app activity, so a server the
 * bridge started in the background stays up while an agent is working and
 * idles out afterwards (server/index.ts folds `within` into isBusy).
 *
 * The bridge names its client in the X-Skill-Vault-Client header. The
 * in-app assistant sends "assistant" and doesn't count: its turns are
 * already busy work.
 */
import type { NextFunction, Request, Response } from "express";

export const AGENT_CLIENT_HEADER = "x-skill-vault-client";

/** 10 minutes; SKILL_VAULT_AGENT_IDLE_MS overrides it (tests shorten it). */
export function agentIdleMs(): number {
  const raw = process.env.SKILL_VAULT_AGENT_IDLE_MS;
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0 ? n : 10 * 60_000;
}

const LABELS: Record<string, string> = {
  "claude-desktop": "Claude Desktop",
  "claude-code": "Claude Code",
  command: "a shell agent",
  assistant: "the assistant",
};

/** Human label for a client id, used in `source` and activity messages. */
export function clientLabel(id: string | undefined): string {
  return (id !== undefined && LABELS[id]) || "an agent";
}

export function createAgentActivity(now: () => number = Date.now): {
  track(req: Request, res: Response, next: NextFunction): void;
  within(ms: number): boolean;
} {
  let last: number | null = null;
  return {
    track(req, _res, next) {
      const client = req.get(AGENT_CLIENT_HEADER);
      if (client && client !== "assistant") last = now();
      next();
    },
    within(ms) {
      return last !== null && now() - last < ms;
    },
  };
}
