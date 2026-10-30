// app/server/services/assistant/engines/codex.ts
/**
 * OpenAI Codex (`codex exec --json`). Checked against codex-cli 0.144.4 (spike S5–S7).
 *
 * Codex has no per-tool allowlist, so the shell can't be limited to git the
 * way Claude's and Grok's are. Instead every turn runs in the workspace-write
 * sandbox: commands can run, but writes land only in the vault and repos
 * folders (network on so `git clone` works). --ignore-user-config keeps the
 * user's own Codex MCP servers and settings out; auth still comes from
 * CODEX_HOME. Without the user's config Codex has no Windows sandbox and
 * falls back to read-only (every command "blocked by policy", MCP calls
 * "user cancelled"), so two settings put it back: windows.sandbox =
 * "unelevated" and auto-approval for the vault server's tools. Codex assigns
 * its own thread id (thread.started), saved as the chat's engine_session_id
 * and resumed with `codex exec resume <id>`.
 */
import { canonicalTool, toolResultEvent, toolStartEvent, type AssistantStreamEvent } from "../streamEvents.ts";
import { apiKeyPresent, defaultEngineDeps, detectWithVersion, keyEnv, makeAuthHint, type EngineDeps } from "./common.ts";
import { composeInstructions, composePrompt } from "./instructions.ts";
import type { AssistantEngine, EngineAuthStatus, TurnParser } from "./types.ts";

const LABEL = "OpenAI Codex";
/** S6 unverified (no key was offered in the spike): CODEX_API_KEY is the documented variable. */
const KEYS = ["CODEX_API_KEY", "OPENAI_API_KEY"];
const authHint = makeAuthHint(LABEL, /not logged in|unauthori[sz]ed|\b401\b|log ?in required|sign in|expired|invalid api key/i);

/** TOML basic string: JSON's escaping of \ and " is valid TOML. */
const toml = (s: string): string => JSON.stringify(s);

export function createCodexEngine(deps: EngineDeps = defaultEngineDeps()): AssistantEngine {
  const target = () => deps.resolve("codex", "codex CLI");
  const engine: AssistantEngine = {
    id: "codex",
    label: LABEL,
    cliName: "codex",
    verifiedVersion: "codex-cli 0.144.4",
    subagents: false,
    apiKeyEnv: KEYS,
    install: [{ kind: "npm", label: "Install OpenAI Codex", args: ["install", "-g", "@openai/codex"], source: "npmjs.com" }],
    loginArgs: ["login"],
    loginHint: "A browser window opens — sign in with your ChatGPT account.",
    loginEnv: () => ({}),
    target,
    // detect() and authStatus() never throw: the state layer relies on it.
    async detect(opts) {
      try {
        if (opts?.refresh) deps.forget("codex");
        return await detectWithVersion(deps, target(), engine.childEnv({ auth: "login" }, deps.env));
      } catch (e) {
        return { installed: false, reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
      }
    },
    async authStatus(cfg): Promise<EngineAuthStatus> {
      try {
        if (cfg.auth === "api_key") return { signed_in: apiKeyPresent(cfg, deps.env, KEYS), method: "api_key" };
        const t = target();
        if (!t) return { signed_in: false, method: "login" };
        // S5: exit 0 and "Logged in using ChatGPT" on stdout when signed in.
        const r = await deps.run(t, ["login", "status"], { env: engine.childEnv({ auth: "login" }, deps.env), timeoutMs: 20_000 });
        if (r.code === null) return { signed_in: null, method: "login" };
        if (r.code !== 0) return { signed_in: false, method: "login" };
        // Never the raw line: an API-key login prints part of the key ("Logged in using an API key - sk-…").
        return /\bChatGPT\b/i.test(`${r.stdout}\n${r.stderr}`) ? { signed_in: true, method: "login", account: "ChatGPT" } : { signed_in: true, method: "login" };
      } catch {
        return { signed_in: null, method: cfg.auth === "api_key" ? "api_key" : "login" };
      }
    },
    childEnv: (cfg, base) => keyEnv(cfg, base, KEYS),
    buildTurn(input) {
      const t = target();
      if (!t) throw new Error("OpenAI Codex isn't installed — install it in Settings → AI assistant.");
      const fresh = input.isFirstTurn || !input.engineSessionId;
      const settings = [
        "--json",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "-c", 'sandbox_mode="workspace-write"',
        "-c", 'windows.sandbox="unelevated"', // S7: without it Codex falls back to read-only
        "-c", `sandbox_workspace_write.writable_roots=[${[input.vaultPath, input.reposDir].map(toml).join(",")}]`,
        "-c", "sandbox_workspace_write.network_access=true",
        "-c", 'approval_policy="never"',
        "-c", `mcp_servers.vault.command=${toml(input.mcp.command)}`,
        "-c", `mcp_servers.vault.args=[${input.mcp.args.map(toml).join(",")}]`,
        "-c", `mcp_servers.vault.env={ SKILL_VAULT_URL = ${toml(input.mcp.env.SKILL_VAULT_URL)} }`,
        "-c", 'mcp_servers.vault.default_tools_approval_mode="approve"', // S7: else every vault call is "user cancelled"
      ];
      const instructions = fresh
        ? composeInstructions({
            pluginDir: input.pluginDir,
            lead: input.leadAgent,
            note: { label: LABEL, vaultToolSpelling: "the `vault` MCP server's tools", subagents: false, shell: "sandboxed" },
            includeLead: true,
          })
        : undefined;
      return {
        label: "codex CLI",
        target: t,
        args: fresh ? ["exec", ...settings, "-"] : ["exec", "resume", ...settings, input.engineSessionId as string, "-"],
        stdin: composePrompt({ instructions, context: input.contextBlock, message: input.message }),
        env: engine.childEnv(input.auth, input.baseEnv),
        cwd: input.vaultPath,
      };
    },
    createParser: () => createCodexParser(authHint),
    authHint,
  };
  return engine;
}

/** The item fields the parser reads (S7; fixtures/codex-turn.jsonl). */
interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  /** in_progress | completed | failed (mcp_tool_call) | declined (command_execution) */
  status?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content?: unknown } | null;
  error?: { message?: string } | null;
  changes?: Array<{ path?: string }>;
  query?: string;
}

function toolOf(item: CodexItem): { name: string; input: Record<string, unknown> } | null {
  switch (item.type) {
    case "command_execution":
      return { name: "Bash", input: { command: String(item.command ?? "") } };
    case "file_change":
      return { name: "Edit", input: { file_path: String(item.changes?.[0]?.path ?? "") } };
    case "mcp_tool_call":
      return canonicalTool({}, `mcp__${item.server}__${item.tool}`, item.arguments && typeof item.arguments === "object" ? (item.arguments as Record<string, unknown>) : {});
    case "web_search":
      return { name: "WebSearch", input: { query: String(item.query ?? "") } };
    default:
      return null;
  }
}

/** Codex JSONL → wire events. Resume emits thread.started again with the same thread_id. */
export function createCodexParser(hint: (m: string) => string): TurnParser {
  let threadId: string | undefined;
  const started = new Set<string>();
  let wroteText = false;
  return {
    engineSessionId: () => threadId,
    parse(line) {
      let msg: { type?: string; thread_id?: string; item?: CodexItem; error?: { message?: string }; message?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        return [];
      }
      if (!msg || typeof msg !== "object") return [];
      const item = msg.item ?? {};
      const id = typeof item.id === "string" ? item.id : "";
      switch (msg.type) {
        case "thread.started":
          if (typeof msg.thread_id === "string") threadId = msg.thread_id;
          return [];
        case "item.started": {
          const tool = toolOf(item);
          if (!tool || !id) return [];
          started.add(id);
          return [toolStartEvent(id, tool.name, tool.input)];
        }
        case "item.completed": {
          if (item.type === "agent_message" && typeof item.text === "string" && item.text) {
            const text = wroteText ? `\n\n${item.text}` : item.text;
            wroteText = true;
            return [{ type: "text_delta", text }];
          }
          if (item.type === "reasoning" && typeof item.text === "string" && item.text) return [{ type: "thinking_delta", text: item.text }];
          const tool = toolOf(item);
          if (!tool || !id) return [];
          // A refusal is status failed (MCP) or declined (a command the sandbox policy blocked).
          const refused = item.status === "failed" || item.status === "declined" || Boolean(item.error);
          const ok = !refused && (item.exit_code == null || item.exit_code === 0);
          const output =
            item.type === "command_execution"
              ? item.aggregated_output || (refused ? `command ${item.status ?? "refused"}` : "")
              : item.error?.message ?? item.result?.content;
          const events: AssistantStreamEvent[] = started.has(id) ? [] : [toolStartEvent(id, tool.name, tool.input)];
          events.push(toolResultEvent(id, ok, output));
          return events;
        }
        case "turn.completed":
          return [{ type: "turn_end" }];
        case "turn.failed":
          return [{ type: "error", message: hint(String(msg.error?.message ?? "Codex turn failed")) }];
        case "error":
          return [{ type: "error", message: hint(String(msg.message ?? "Codex reported an error")) }];
        default:
          return [];
      }
    },
  };
}
