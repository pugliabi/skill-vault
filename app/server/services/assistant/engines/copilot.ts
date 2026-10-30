// app/server/services/assistant/engines/copilot.ts
/**
 * GitHub Copilot CLI (`copilot -p … --output-format json`). Checked against 1.0.105 (spike S8–S9).
 *
 * Copilot loads the assistant plugin as-is (--plugin-dir + --agent, the agent
 * name plugin-qualified), so it gets the lead agent, the subagents and the
 * skills like Claude does; only the engine note and the per-turn context ride
 * in the prompt. It has NO shell: Copilot auto-approves commands it judges
 * read-only even when only shell(git:*) is allowed, so a git-only rule can't
 * be enforced. --available-tools is an allowlist of everything else the
 * assistant needs ("vault" = every tool of the vault MCP server); it also
 * drops Copilot's built-in computer-use, sql, workflow and shell-session
 * tools. The system temp folder stays allowed: Copilot saves large tool output (e.g. a big
 * list_skills) there and reads it back.
 * COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN outrank the stored login, so
 * login mode strips all three.
 */
import path from "node:path";
import { canonicalTool, toolResultEvent, toolStartEvent, type ToolAliases } from "../streamEvents.ts";
import { apiKeyPresent, defaultEngineDeps, detectWithVersion, keyEnv, makeAuthHint, type EngineDeps } from "./common.ts";
import { composeInstructions, composePrompt } from "./instructions.ts";
import type { AssistantEngine, EngineAuthStatus, TurnParser } from "./types.ts";

const LABEL = "GitHub Copilot CLI";
const KEYS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
const authHint = makeAuthHint(LABEL, /not (logged|signed) in|unauthori[sz]ed|\b401\b|copilot login|no copilot (access|subscription)|authenticat/i);
/** S9: plugin agents are addressed as <plugin name>:<agent>; the bare name is rejected. */
const AGENT_NAME = (lead: string): string => `skill-vault-assistant:${lead}`;

/** Every tool a Copilot turn may use (S9). No shell tool on purpose. "vault" = the vault MCP server. */
export const COPILOT_TOOLS = ["view", "create", "edit", "grep", "glob", "web_fetch", "skill", "task", "update_todo", "vault"];

/** Copilot's tool names → Claude's (S9). MCP tools arrive as vault-<tool>, which canonicalTool handles. */
export const COPILOT_ALIASES: ToolAliases = {
  view: "Read",
  create: "Write",
  edit: "Edit",
  grep: "Grep",
  glob: "Glob",
  web_fetch: "WebFetch",
  skill: "Skill",
  task: "Task",
  update_todo: "TodoWrite",
  tool_search_tool: "ToolSearch",
};

export function createCopilotEngine(deps: EngineDeps = defaultEngineDeps()): AssistantEngine {
  const target = () => deps.resolve("copilot", "copilot CLI");
  const configFile = () => path.join(deps.env.COPILOT_HOME || path.join(deps.home, ".copilot"), "config.json");
  const engine: AssistantEngine = {
    id: "copilot",
    label: LABEL,
    cliName: "copilot",
    verifiedVersion: "GitHub Copilot CLI 1.0.105",
    subagents: true,
    apiKeyEnv: KEYS,
    install: [{ kind: "npm", label: "Install GitHub Copilot CLI", args: ["install", "-g", "@github/copilot"], source: "npmjs.com" }],
    loginArgs: ["login"],
    loginHint: "The window shows a one-time code — open github.com/login/device and enter it.",
    loginEnv: () => ({}),
    target,
    // detect() and authStatus() never throw: the state layer relies on it.
    async detect(opts) {
      try {
        if (opts?.refresh) deps.forget("copilot");
        return await detectWithVersion(deps, target(), engine.childEnv({ auth: "login" }, deps.env));
      } catch (e) {
        return { installed: false, reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
      }
    },
    async authStatus(cfg): Promise<EngineAuthStatus> {
      try {
        if (cfg.auth === "api_key") return { signed_in: apiKeyPresent(cfg, deps.env, KEYS), method: "api_key" };
        const file = configFile();
        if (!deps.exists(file)) return { signed_in: false, method: "login" };
        // S8: camelCase — lastLoggedInUser / loggedInUsers carry { host, login }.
        // Copilot writes "// …" comment lines above the JSON; JSON strings can't span lines,
        // so dropping whole comment lines is safe.
        const text = deps.readFile(file).replace(/^\s*\/\/.*$/gm, "");
        const j = JSON.parse(text) as { lastLoggedInUser?: { login?: string }; loggedInUsers?: Array<{ login?: string }> };
        const raw = j.lastLoggedInUser?.login ?? j.loggedInUsers?.[0]?.login;
        const login = typeof raw === "string" && raw ? raw : null;
        return login ? { signed_in: true, method: "login", account: login } : { signed_in: false, method: "login" };
      } catch {
        return { signed_in: null, method: cfg.auth === "api_key" ? "api_key" : "login" };
      }
    },
    childEnv: (cfg, base) => keyEnv(cfg, base, KEYS),
    buildTurn(input) {
      const t = target();
      if (!t) throw new Error("GitHub Copilot CLI isn't installed — install it in Settings → AI assistant.");
      const instructions = input.isFirstTurn
        ? composeInstructions({
            pluginDir: input.pluginDir,
            lead: input.leadAgent,
            note: { label: LABEL, vaultToolSpelling: "vault-<tool>", subagents: true, shell: "none" },
            includeLead: false,
          })
        : undefined;
      const mcp = JSON.stringify({
        mcpServers: { vault: { type: "local", command: input.mcp.command, args: input.mcp.args, env: input.mcp.env, tools: ["*"] } },
      });
      return {
        label: "copilot CLI",
        target: t,
        args: [
          "-p", composePrompt({ instructions, context: input.contextBlock, message: input.message }),
          "--output-format", "json",
          "--stream", "on",
          "--session-id", input.sessionId,
          "-C", input.vaultPath,
          "--add-dir", input.reposDir,
          "--add-dir", input.pluginDir,
          "--plugin-dir", input.pluginDir,
          "--agent", AGENT_NAME(input.leadAgent),
          "--additional-mcp-config", mcp,
          "--disable-builtin-mcps",
          "--available-tools", ...COPILOT_TOOLS,
          "--allow-tool", "write",
          "--allow-tool", "vault",
          "--no-ask-user",
          "--no-auto-update",
        ],
        stdin: "",
        env: engine.childEnv(input.auth, input.baseEnv),
        cwd: input.vaultPath,
      };
    },
    createParser: () => createCopilotParser(authHint),
    authHint,
  };
  return engine;
}

/**
 * Copilot JSONL → wire events (S9; fixtures/copilot-turn.jsonl). Each line is
 * { type, data, id, timestamp, parentId, ephemeral? }; the final `result` line
 * has no `data`. Text comes from assistant.message_delta (the full
 * assistant.message repeats it); session.*, tool_call_delta, shell_output and
 * turn_start/turn_end (one per model call, not per chat turn) are ignored.
 */
export function createCopilotParser(hint: (m: string) => string): TurnParser {
  const streamed = new Set<string>();
  let ended = false;
  return {
    parse(line) {
      let msg: { type?: string; data?: Record<string, unknown>; exitCode?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        return [];
      }
      const d = (msg?.data ?? {}) as Record<string, any>;
      switch (msg?.type) {
        case "assistant.message_delta":
          if (typeof d.deltaContent !== "string" || !d.deltaContent) return [];
          if (typeof d.messageId === "string") streamed.add(d.messageId);
          return [{ type: "text_delta", text: d.deltaContent }];
        case "assistant.message":
          return typeof d.content === "string" && d.content && !streamed.has(String(d.messageId)) ? [{ type: "text_delta", text: d.content }] : [];
        case "tool.execution_start": {
          if (typeof d.toolCallId !== "string" || typeof d.toolName !== "string") return [];
          const c = canonicalTool(COPILOT_ALIASES, d.toolName, d.arguments && typeof d.arguments === "object" ? d.arguments : {});
          return [toolStartEvent(d.toolCallId, c.name, c.input)];
        }
        case "tool.execution_complete":
          // A refusal is success: false with error { message, code: "denied" }.
          return typeof d.toolCallId === "string" ? [toolResultEvent(d.toolCallId, d.success !== false, d.result?.content ?? d.error?.message)] : [];
        case "session.error": // not seen in the spike; shape assumed { message }
          return [{ type: "error", message: hint(String(d.message ?? "Copilot reported an error")) }];
        case "result":
          if (ended) return [];
          ended = true;
          return typeof msg.exitCode === "number" && msg.exitCode !== 0
            ? [{ type: "error", message: hint(`Copilot ended the turn with exit code ${msg.exitCode}`) }]
            : [{ type: "turn_end" }];
        default:
          return [];
      }
    },
  };
}
