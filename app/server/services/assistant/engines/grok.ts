// app/server/services/assistant/engines/grok.ts
/**
 * Grok Build (`grok --prompt-file … --output-format streaming-messages-json`).
 * Built from xAI's docs only: Grok wasn't run in the spike (S1–S4 unverified),
 * so the install folder, the auth.json check, the tool names and the
 * refusals are confirmed live in plan Task 20.
 *
 * Grok reads MCP servers only from files: its own config.toml plus
 * ~/.claude.json, Cursor's config and .mcp.json. So the app gives Grok its own
 * home (GROK_HOME) holding just the vault server, with the Claude/Cursor
 * imports off — the app's Grok therefore has its own sign-in. API-key mode
 * uses a second home that never holds a login (a stored login would outrank
 * XAI_API_KEY). Grok's streaming-messages-json is Claude's stream-json wire
 * format, so the Claude parser reads it, with Grok's tool names mapped.
 * Until the live check, Grok runs without a shell or direct file edits (see GROK_TOOLS).
 */
import path from "node:path";
import { parseStreamJsonLine, type ToolAliases } from "../streamEvents.ts";
import type { VaultMcpServer } from "../mcpConfig.ts";
import { apiKeyPresent, defaultEngineDeps, detectWithVersion, keyEnv, makeAuthHint, type EngineDeps } from "./common.ts";
import { composeInstructions, composePrompt } from "./instructions.ts";
import type { AssistantEngine, EngineAuthStatus } from "./types.ts";

const LABEL = "Grok Build";
const KEYS = ["XAI_API_KEY"];
const authHint = makeAuthHint(LABEL, /not (logged|signed) in|unauthori[sz]ed|\b401\b|grok login|XAI_API_KEY/i);

/**
 * Headless tool allowlist, per xAI's docs (S3, unverified). MCP calls go through use_tool.
 * Fail-closed until plan Task 20 checks Grok live: no shell and no file writes, because nobody has seen
 * headless Grok refuse a non-git command or a write outside --cwd. Once the live check proves both are
 * refused, restore `search_replace,write_file,run_terminal_cmd` here, the `--allow "Bash(git *)"` pair in
 * buildTurn, and the engine note's `shell: "git"` (dropping `writes: false`); then move Grok back to the
 * git-only group in safety.test.ts.
 */
export const GROK_TOOLS = "read_file,grep,list_dir,web_search,web_fetch";

export const GROK_ALIASES: ToolAliases = {
  run_terminal_cmd: "Bash",
  read_file: "Read",
  search_replace: "Edit",
  write_file: "Write",
  grep: "Grep",
  list_dir: "Glob",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
  search_tool: "ToolSearch",
};

export function grokHome(home: string, mode: "login" | "api_key"): string {
  return path.join(home, ".skill-vault", "engines", mode === "api_key" ? "grok-apikey" : "grok");
}

const toml = (s: string): string => JSON.stringify(s);

/** Rewritten before every turn: the bridge's port can change between app runs. */
export function grokConfigToml(mcp: VaultMcpServer): string {
  return [
    "# Written by Skill Vault before each assistant turn. Edits are overwritten.",
    "[mcp_servers.vault]",
    `command = ${toml(mcp.command)}`,
    `args = [${mcp.args.map(toml).join(", ")}]`,
    `env = { SKILL_VAULT_URL = ${toml(mcp.env.SKILL_VAULT_URL)} }`,
    "",
    "[compat.claude]",
    "mcps = false",
    "",
    "[compat.cursor]",
    "mcps = false",
    "",
  ].join("\n");
}

export function createGrokEngine(deps: EngineDeps = defaultEngineDeps()): AssistantEngine {
  const target = () => deps.resolve("grok", "grok CLI");
  const engine: AssistantEngine = {
    id: "grok",
    label: LABEL,
    cliName: "grok",
    verifiedVersion: "xAI docs only (not run yet)",
    subagents: false,
    apiKeyEnv: KEYS,
    install: [{ kind: "powershell", label: "Install Grok Build", script: "irm https://x.ai/cli/install.ps1 | iex", source: "x.ai" }],
    loginArgs: ["login"],
    loginHint: "A browser window opens — sign in with your grok.com account. This sign-in is only for Skill Vault.",
    loginEnv: () => ({ GROK_HOME: grokHome(deps.home, "login") }),
    target,
    // detect() and authStatus() never throw: the state layer relies on it.
    async detect(opts) {
      try {
        if (opts?.refresh) deps.forget("grok");
        return await detectWithVersion(deps, target(), engine.childEnv({ auth: "login" }, deps.env));
      } catch (e) {
        return { installed: false, reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
      }
    },
    async authStatus(cfg): Promise<EngineAuthStatus> {
      try {
        if (cfg.auth === "api_key") return { signed_in: apiKeyPresent(cfg, deps.env, KEYS), method: "api_key" };
        // S2 (unverified): `grok login` writes auth.json into GROK_HOME.
        return { signed_in: deps.exists(path.join(grokHome(deps.home, "login"), "auth.json")), method: "login" };
      } catch {
        return { signed_in: null, method: cfg.auth === "api_key" ? "api_key" : "login" };
      }
    },
    childEnv: (cfg, base) =>
      keyEnv(cfg, base, KEYS, {
        GROK_HOME: grokHome(deps.home, cfg.auth === "api_key" ? "api_key" : "login"),
        GROK_DISABLE_AUTOUPDATER: "1",
      }),
    buildTurn(input) {
      const t = target();
      if (!t) throw new Error("Grok Build isn't installed — install it in Settings → AI assistant.");
      const home = grokHome(deps.home, input.auth.auth === "api_key" ? "api_key" : "login");
      deps.writeFile(path.join(home, "config.toml"), grokConfigToml(input.mcp));
      const promptFile = path.join(input.workDir, `prompt-${input.sessionId}-${Date.now()}.txt`);
      const instructions = input.isFirstTurn
        ? composeInstructions({
            pluginDir: input.pluginDir,
            lead: input.leadAgent,
            // Fail-closed until verified (see GROK_TOOLS): no shell, no direct file edits.
            note: { label: LABEL, vaultToolSpelling: "vault__<tool>, called through use_tool", subagents: false, shell: "none", writes: false },
            includeLead: true,
          })
        : undefined;
      deps.writeFile(promptFile, composePrompt({ instructions, context: input.contextBlock, message: input.message }));
      return {
        label: "grok CLI",
        target: t,
        args: [
          "--prompt-file", promptFile,
          "--output-format", "streaming-messages-json",
          "--include-partial-messages",
          ...(input.isFirstTurn ? ["-s", input.sessionId] : ["-r", input.sessionId]),
          "--cwd", input.vaultPath,
          "--tools", GROK_TOOLS,
          "--no-auto-update",
        ],
        stdin: "",
        env: engine.childEnv(input.auth, input.baseEnv),
        cwd: input.vaultPath,
        tempFiles: [promptFile],
      };
    },
    createParser: () => ({ parse: (line) => parseStreamJsonLine(line, { aliases: GROK_ALIASES, authHint }) }),
    authHint,
  };
  return engine;
}
