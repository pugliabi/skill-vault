/**
 * Claude Code as an engine: a thin wrapper over the code that already ran
 * every assistant turn (turn.ts buildTurnArgs, the stream-json parser, the
 * claude auth env). Nothing about Claude's turns changes. Claude keeps its
 * own executable resolver (claude/cli.ts resolveClaudeExe); exe.ts serves
 * the other engines.
 */
import { buildTurnArgs } from "../turn.ts";
import { parseStreamJsonLine } from "../streamEvents.ts";
import { claudeChildEnv, withAuthHint } from "../../claude/auth.ts";
import {
  claudeAvailable,
  claudeLoginStatus,
  resetClaudeAvailableCache,
  resetResolvedExeCache,
  resolveClaudeExe,
} from "../../claude/cli.ts";
import type { AssistantEngine } from "./types.ts";

export function createClaudeEngine(): AssistantEngine {
  return {
    id: "claude",
    label: "Claude Code",
    cliName: "claude",
    verifiedVersion: "2.1.177",
    subagents: true,
    apiKeyEnv: ["ANTHROPIC_API_KEY"],
    install: [{ kind: "powershell", label: "Install Claude Code", script: "irm https://claude.ai/install.ps1 | iex", source: "claude.ai" }],
    loginArgs: ["auth", "login"],
    loginHint: "Finish signing in in the browser window that opens.",
    loginEnv: () => ({}),
    target: () => {
      const exe = resolveClaudeExe();
      return exe ? { command: exe, prefixArgs: [], label: "claude CLI" } : null;
    },
    async detect(opts) {
      if (opts?.refresh) {
        resetClaudeAvailableCache();
        resetResolvedExeCache();
      }
      const r = await claudeAvailable();
      return { installed: r.available, version: r.version, reason: r.reason };
    },
    async authStatus(cfg) {
      if (cfg.auth === "api_key") return { signed_in: Boolean(cfg.api_key || process.env.ANTHROPIC_API_KEY), method: "api_key" };
      const s = await claudeLoginStatus();
      return s ? { signed_in: s.logged_in, method: "login", account: s.email ?? undefined } : { signed_in: null, method: "login" };
    },
    childEnv: (cfg, base) => claudeChildEnv({ auth: cfg.auth, api_key: cfg.api_key, workspace_id: cfg.workspace_id }, base),
    buildTurn: (input) => ({
      label: "claude CLI",
      args: buildTurnArgs({
        sessionId: input.sessionId,
        isFirstTurn: input.isFirstTurn,
        leadAgent: input.leadAgent,
        contextBlock: input.contextBlock,
        mcpConfigJson: JSON.stringify({ mcpServers: { vault: input.mcp } }),
        pluginDir: input.pluginDir,
        reposDir: input.reposDir,
      }),
      stdin: input.message,
      cwd: input.vaultPath,
    }),
    createParser: () => ({ parse: (line) => parseStreamJsonLine(line) }),
    authHint: withAuthHint,
  };
}
