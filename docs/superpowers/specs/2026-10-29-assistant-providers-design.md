# AI Assistant Providers — Design

**Date:** 2026-10-29 · **Status:** approved design, amended after the verification spike (see "Spike
findings" at the end) · **Not in the original 5-project roadmap** — a new request, built on top of the
merged first-run setup guide (d778d08).

## Problem

- The assistant only runs on Claude Code. Someone who pays for ChatGPT, Copilot or Grok instead can't use
  it at all.
- Everything is wired to `claude -p`: the flags in `turn.ts`, the stream-json parser in
  `streamEvents.ts`, the `.cmd`-shim resolver in `claude/cli.ts`, the sign-in panel in Settings, and the
  setup guide's Assistant step.
- If the CLI isn't installed, the app shows a command to copy and run somewhere else. Sign-in is the same:
  the app checks it, but you have to do it on your own.

## Goals

1. One app-wide **provider** setting picks the CLI that runs new assistant chats: **Claude Code**
   (default), **OpenAI Codex**, **GitHub Copilot CLI** or **Grok Build**.
2. When the chosen CLI isn't installed, the app **installs it**: it shows the exact command first, then
   streams the output.
3. The app **starts sign-in for you**. It opens the tool's own login in a window, waits until you're
   signed in, then says so. An **API key** is the alternative for each provider.
4. The chat works the same on every provider: vault tools through the MCP bridge, the lead agent's
   instructions, the ten skills, the per-turn context, the activity timeline, Stop, and resume.
5. Safety stays deny-by-default on every provider. The shell is git-only on Claude, Copilot has no shell
   at all, Grok has no shell and no file-write tools until its limits are checked live (fail-closed), and
   Codex runs sandboxed with no network (see Safety). Other changes to the app go only through the
   audited bridge.
6. The setup guide's Assistant step becomes **pick provider → install → sign in**.

## Non-goals

- AI auto-tagging and the Claude merge on update. They stay on Claude, and Settings says so.
- Picking the provider per chat (the setting is app-wide).
- A model picker for any provider.
- ACP (Agent Client Protocol). We considered it and chose per-CLI headless adapters instead.
- Subagents on Codex and Grok. Their lead agent does the specialist work itself, using the skills.
- Install commands outside Windows. Other platforms show the command to run yourself.
- A shell on Copilot (see the spike findings: a git-only rule can't be enforced there).
- **Later: a Google provider (Antigravity CLI `agy`).** Gemini CLI was in the first design but was dropped
  after the spike: Google refuses its Google-account sign-in for individuals
  (`IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals … migrate
  to the Antigravity suite`).

## Decisions made while brainstorming (and after the spike)

| Question | Decision |
|---|---|
| How is the provider chosen? | One app-wide setting. It applies to new chats; an existing chat keeps the provider it started on. |
| Do tagging and merge follow it? | No, chat only. |
| Which providers? | Codex, Copilot, Grok Build (plus Claude). Gemini CLI was dropped after the spike (sign-in refused for individuals); a Google provider via Antigravity is for later. |
| How do you sign in? | The tool's own account login by default, an API key/token optionally. |
| How does the app talk to each CLI? | Per-CLI headless adapters (one turn = one CLI process), the same model as Claude today. |
| How safe is Codex? | Codex has no per-tool allowlist. It runs in the `workspace-write` sandbox (with `windows.sandbox="unelevated"`): writes are limited to the vault and repos folders, and the network is **off** (user decision 2026-10-30: with network on a sandboxed command could reach the app's own API). Updates, adopting and cloning go through the vault tools, server-side. |
| Does Copilot get a git-only shell? | No shell at all. Copilot's default permission mode auto-approves commands it judges read-only even when only `shell(git:*)` is allowed (`hostname` ran in the spike), so git-only can't be enforced. The user chose no shell over an unenforceable one. |
| Grok's details? | Built from xAI's docs. Grok wasn't run in the spike (user: "Skip Grok for now"); its items are checked live at the end of the plan. |

**Naming.** In this codebase "providers" already means skill targets (`agent_locations`). So in code,
an assistant backend is an **engine** (`assistant.engine`, `engines/`). The UI calls it **Provider**.

## Architecture

### Engine modules

`app/server/services/assistant/engines/` contains one module per CLI and a registry. The contract is the
plan's Task 4 `engines/types.ts`, which is authoritative:

```ts
export type EngineId = "claude" | "codex" | "copilot" | "grok";
export const ENGINE_IDS: EngineId[] = ["claude", "codex", "copilot", "grok"]; // Settings order

export interface EngineAuthConfig { auth?: "login" | "api_key"; api_key?: string; workspace_id?: string } // workspace_id: Claude only
export interface EngineDetect { installed: boolean; version?: string; reason?: string }
export interface EngineAuthStatus {
  signed_in: boolean | null;   // null = couldn't tell (a turn is still allowed; the CLI will say)
  method: "login" | "api_key";
  account?: string;
}

export type InstallStep =
  | { kind: "npm"; label: string; args: string[]; source: string }
  | { kind: "powershell"; label: string; script: string; source: string };

export interface TurnInput {
  sessionId: string;            // the app's chat UUID
  engineSessionId?: string;     // an id the engine assigned (Codex threads)
  isFirstTurn: boolean;
  message: string;              // what the user typed
  leadAgent: string;            // the plugin's lead agent ("vault-assistant")
  contextBlock: string;         // buildTurnContext() output, as today
  mcp: VaultMcpServer;          // McpBridgeConfig["mcpServers"]["vault"], from mcpConfig.ts
  vaultPath: string; reposDir: string; pluginDir: string;
  workDir: string;              // ~/.skill-vault/engines/<id>/
  auth: EngineAuthConfig;       // this engine's saved auth
  baseEnv: NodeJS.ProcessEnv;   // process.env in the app
}
export interface TurnSpec {
  label: string;                // "codex CLI", for errors
  target?: SpawnTarget;         // omitted for Claude: its runner resolves claude.exe itself
  args: string[]; stdin: string; env?: NodeJS.ProcessEnv; cwd: string;
  tempFiles?: string[];         // deleted after the turn, whatever happened
}
export interface TurnParser { parse(line: string): AssistantStreamEvent[]; engineSessionId?(): string | undefined }

export interface AssistantEngine {
  id: EngineId;
  label: string;                // "OpenAI Codex"
  cliName: string;              // "codex": the command as typed in a terminal
  verifiedVersion: string;      // CLI version the adapter + fixtures were checked against
  subagents: boolean;
  apiKeyEnv: string[];          // env vars the CLI reads a key from; login mode strips them all
  install: InstallStep[];       // shown to the user before running
  loginArgs: string[]; loginHint: string; loginEnv(): Record<string, string>;
  target(): SpawnTarget | null; // the CLI to spawn, or null when it isn't installed
  detect(opts?: { refresh?: boolean }): Promise<EngineDetect>;
  authStatus(cfg: EngineAuthConfig): Promise<EngineAuthStatus>;
  childEnv(cfg: EngineAuthConfig, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  buildTurn(input: TurnInput): TurnSpec;   // throws when the CLI can't run (not installed)
  createParser(): TurnParser;
  authHint(message: string): string;       // "— sign in again in Settings → AI assistant"
}
```

- `claude.ts` wraps today's code with no behavior change: `buildTurnArgs`, `parseStreamJsonLine`,
  `claudeChildEnv`, `claudeAvailable`, `claudeLoginStatus`.
- `turn.ts`'s `runTurn` keeps its job (stream, compact, error handling). It now takes a `TurnSpec` and a
  `TurnParser` instead of claude args. Its result also returns `engineSessionId`.
- The stream runner (`createStreamRunner`) takes the spawn target and env from the `TurnSpec`. The
  process-tree kill, the idle and hard timeouts, and the abort signal are unchanged.

### Finding the real executable

Claude keeps its own `resolveClaudeExe` in `claude/cli.ts` (extended to also search the registry PATH
and `~/.local/bin`, and exported for the Claude engine's `target()`). The other engines use
`engines/exe.ts`: `resolveTarget(name, label, deps)`. It checks, in order:

1. The process PATH: `name.exe`, else a `name.cmd` shim parsed with `parseCmdShim` (a real `.exe`, or a
   node script run with the app's own node — never the shim itself).
2. Known install folders: the folder of the app's node, the npm global prefix, `%USERPROFILE%\.local\bin`,
   and Grok's install folder `~/.grok/bin` (from xAI's docs, unverified).
3. Only when both miss (Windows): the PATH **as stored in the registry right now** (`HKCU\Environment`,
   then `HKLM\…\Session Manager\Environment`). Installers update the registry, not the running server.
   Reading it costs two `reg query` spawns, so it comes last.

Results are cached per name (`defaultEngineDeps().resolve`, misses too). An engine's
`detect({ refresh: true })` clears its entry; a finished install and "Check again" both re-detect with
refresh. The rule against newline arguments through `cmd.exe` stays: nothing here spawns a `.cmd`.

### Config

The `assistant` block of `~/.skill-vault/config.json` grows:

```jsonc
"assistant": {
  "auth": "login", "api_key": "…", "workspace_id": "…",   // Claude — unchanged, still read by tagging + merge
  "engine": "codex",                                       // new; missing = "claude"
  "engines": {                                             // new; per non-Claude engine
    "codex":   { "auth": "login" },
    "copilot": { "auth": "api_key", "api_key": "github_pat_…" }
  }
}
```

- Keys are stored the way Claude's is today: in the config file, never sent to the client (the API
  reports `has_saved_key`).
- `readAssistantBlock` and `writeAssistantBlock` keep every other key round-trip, as they do now.

### Sessions

- `AssistantSession` gains `engine: EngineId` and `engine_session_id?: string`. A stored chat without
  `engine` reads as `"claude"`.
- New chats take `engine` from config. Continuing a chat uses the chat's own `engine`.
- If that engine isn't installed or signed in, the chat's history still renders. The composer is locked
  with the note: "This chat used Codex — sign in to continue it, or start a new chat."
- Claude, Copilot and Grok accept the app's UUID as their session id. Codex assigns a thread id: the
  parser reads it from `thread.started`, `runTurn` returns it, and `endTurn` saves it as
  `engine_session_id`.
- `SessionSummary` and the session detail include `engine`.

### Routes (`/api/assistant`)

| Route | Purpose |
|---|---|
| `GET /status` | As today, now for the selected engine: `{available, engine, label, version, reason}`. `available` = vault set + plugin present + engine installed + (signed in, or an API key saved). |
| `GET /engines` | `[{id, label, selected, installed, version, verified_version, reason, subagents, auth: {mode, signed_in, account, has_saved_key, env_key_present}, install, login_hint}]`. `?refresh=1` re-detects. |
| `GET /engines/:id` | One view. `?refresh=1` re-detects; `?mode=login` reports the login status whatever mode is saved (the setup guide signs in before Finish saves the mode). Closes a pending sign-in window once the view shows a login that's signed in. |
| `PUT /engine` | `{engine}` — the provider for new chats. |
| `POST /engines/:id/install` | Runs the install steps as an NDJSON job (the same format as `POST /api/app/update`). Only one install at a time (409 otherwise). |
| `POST /engines/:id/login` | Opens the sign-in window and returns `{started: true, hint}`. Loopback requests only (403 otherwise); 500 with the reason if the window can't be opened. |
| `POST /engines/:id/login/cancel` | Closes the sign-in window. |
| `PUT /engines/:id/auth` | `{auth?, api_key?, workspace_id?}`, using the same omitted = keep, `""` = clear rules as Claude's `PUT /auth`. For `claude` it runs exactly the `PUT /auth` code path. |
| `GET/PUT /auth` | Unchanged. This is still Claude's (Settings and the setup guide use it for Claude). |

Every POST and PUT above goes through the existing cross-site guard, like the other `/api/app` and
`/api/setup` mutations.

`POST /stream` picks the engine (the session's, or config's for a new chat). If that engine isn't ready
it answers **409 with a JSON error before streaming starts**. Otherwise it builds the `TurnInput`, calls
`engine.buildTurn`, and runs the turn as today. Claude only needs to be installed to be ready (final-review
ruling): its `claude auth status` can't see Bedrock, Vertex or token sign-ins, so a `signed_in: false`
never blocks a turn and the CLI reports its own sign-in error, as before providers. The other engines
also need a sign-in (or a key in API-key mode). An "isn't installed" reason carries the engine's own
detail, e.g. "(claude.exe not found next to the claude.cmd shim)".

## Engines

Items that were marked **†** in the first design have been settled by plan task 1 (the spike) and are
recorded in "Spike findings" at the end. Grok's items are the exception: unverified, built from xAI's
docs, checked live in the plan's last task.

### Claude Code (existing)

- **Install:** PowerShell `irm https://claude.ai/install.ps1 | iex` (claude.ai).
- **Sign in:** `claude auth login`. Status comes from `claude auth status` (the existing
  `claudeLoginStatus`).
- **Turn:** today's `buildTurnArgs`, unchanged.

### OpenAI Codex — checked against codex-cli 0.144.4

- **Install:** `npm install -g @openai/codex` (npmjs.com).
- **Sign in:** `codex login` opens a browser for the ChatGPT account. Status: `codex login status` exits 0
  and prints "Logged in using ChatGPT" when signed in (S5). The account shown is the fixed word "ChatGPT"
  (or nothing), never the raw line: an API-key login prints part of the key.
- **API key:** the saved key goes in as `CODEX_API_KEY` in the turn's environment, so the user's own
  terminal login isn't overwritten (S6: unverified, documented default). Login mode strips
  `OPENAI_API_KEY` and `CODEX_API_KEY`.
- **Turn:** the prompt goes on stdin (`-`). The first turn is `codex exec --json …`; later turns are
  `codex exec resume <engine_session_id> --json …`. `resume` takes fewer flags, so both forms put
  everything else in `-c`:
  - `--ignore-user-config --skip-git-repo-check` (the user's own MCP servers and config stay out; auth
    still comes from `CODEX_HOME`)
  - `-c sandbox_mode="workspace-write"`
  - `-c windows.sandbox="unelevated"` (S7: without the user's config Codex has no Windows sandbox and
    falls back to read-only)
  - `-c sandbox_workspace_write.writable_roots=[<vault>, <repos>]`
  - `-c sandbox_workspace_write.network_access=false` (user decision 2026-10-30, after the final review:
    the app's API on 127.0.0.1 has no token and its cross-site guard lets a request with neither `Origin`
    nor `Sec-Fetch-Site` through, so with network on a sandboxed `curl -X PATCH …/api/config` followed by
    `POST /api/push` could write outside the sandbox. `git clone`/`pull` and `curl` don't work in the
    sandbox; the vault tools — updates, adopting, cloning — run in the app server and still do.)
  - `-c approval_policy="never"`
  - `-c mcp_servers.vault.command=… / .args=[…] / .env={SKILL_VAULT_URL="…"}`
  - `-c mcp_servers.vault.default_tools_approval_mode="approve"` (S7: otherwise every vault call comes
    back "user cancelled MCP tool call")

  The spawn's cwd is the vault.
- **Events (S7, `fixtures/codex-turn.jsonl`):**
  - `thread.started{thread_id}` gives the engine session id. Resume emits it again with the same id.
  - `item.started` / `item.completed{item}`: `agent_message{id,text}` → `text_delta` (whole message, no
    token streaming); `command_execution{command, aggregated_output, exit_code, status}` → `Bash`;
    `file_change` → `Edit`; `mcp_tool_call{server, tool, arguments, result:{content}|null,
    error:{message}|null, status}` → `mcp__<server>__<tool>`; `web_search` → `WebSearch`.
  - A refusal is `status: "declined"` (command) or `"failed"` with `error.message` (MCP call) → a
    `tool_result` with `ok: false`. A write the sandbox rejects emits **no** item at all.
  - `turn.completed{usage}` → `turn_end` (no cost; the usage tokens aren't shown).
  - `turn.failed` and `error` → `error`.
- **Windows sandbox (S7):** with the two `-c` settings above, the sandbox is enforced on Windows:
  `hostname` runs (allowed by design) and a write outside the roots is refused ("writing outside of the
  project").

### GitHub Copilot CLI — checked against 1.0.105

- **Install:** `npm install -g @github/copilot` (npmjs.com).
- **Sign in:** `copilot login`, a device code shown in the window. Status: read
  `<COPILOT_HOME or ~/.copilot>/config.json`; it is camelCase: `lastLoggedInUser: {host, login}` and
  `loggedInUsers: [{host, login}]` (S8).
- **API key:** a fine-grained PAT with "Copilot Requests", passed as `COPILOT_GITHUB_TOKEN`. Login mode
  strips `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN`. Copilot ranks those above the stored login,
  and a stray `GH_TOKEN` from the `gh` CLI would take over.
- **Turn:** `copilot -p <context + message> --output-format json --stream on --session-id <uuid>`. The
  same flag creates the session on the first turn and resumes it on later turns (verified). Also passed:
  - `-C <vault> --add-dir <repos> --add-dir <plugin>`
  - `--plugin-dir <plugin> --agent skill-vault-assistant:<lead>`. Plugin agents must be plugin-qualified;
    the bare name is rejected (S9). Copilot loads the bundle as-is.
  - `--additional-mcp-config <json> --disable-builtin-mcps`
  - `--available-tools view create edit grep glob web_fetch skill task update_todo vault` — an
    allowlist, one argv element per tool. `vault` means every tool of the vault MCP server (`vault-*`
    doesn't work). There is deliberately **no shell tool**. The list also removes Copilot's built-in
    computer-use plugin (desktop control), sql, workflow and shell-session tools.
  - `--allow-tool write --allow-tool vault`. No `--disallow-temp-dir`: Copilot saves tool output over
    ~20 KB (a big `list_skills`) to the system temp folder and must be able to read it back.
  - `--no-ask-user --no-auto-update` (there is no `--no-remote` flag)

  The prompt is an argument, so the real `copilot.exe` (or its node script) behind the npm shim must be
  resolved.
- **Events (S9, `fixtures/copilot-turn.jsonl`):** one JSON object per line, `{type, data, id, timestamp,
  parentId, ephemeral?}`.
  - `assistant.message_delta{messageId, deltaContent}` → `text_delta`. Concatenated, the deltas equal the
    final `assistant.message{messageId, content, toolRequests}`, which is therefore not repeated.
  - `tool.execution_start{toolCallId, toolName, arguments, mcpServerName?, mcpToolName?}` → `tool_start`;
    `tool.execution_complete{toolCallId, success, result:{content, detailedContent?}, error:{message, code}}`
    → `tool_result` (`success: false`, e.g. `code: "denied"`, is a refusal).
  - The final `result{sessionId, exitCode, usage}` (no `data` wrapper) → `turn_end`, or `error` when
    `exitCode` isn't 0. `tool.shell_output`, `assistant.tool_call_delta`, `assistant.turn_start/turn_end`
    (one per model call), `assistant.idle` and the many `session.*` events are ignored.
  - Tool names: `view`→Read, `create`→Write, `edit`→Edit, `grep`→Grep, `glob`→Glob, `web_fetch`→WebFetch,
    `skill`→Skill, `task`→Task, `update_todo`→TodoWrite, `tool_search_tool`→ToolSearch, MCP tools as
    `vault-<tool>`→`mcp__vault__<tool>`.

### Grok Build — built from xAI's docs, not yet run

- **Install:** PowerShell `irm https://x.ai/cli/install.ps1 | iex` (x.ai). Expected folder `~/.grok/bin`.
- **App-owned home.** Grok reads MCP servers only from files: its own config, `~/.claude.json`, Cursor's
  config, and `.mcp.json`. So the app runs Grok with `GROK_HOME=~/.skill-vault/engines/grok`. That folder
  holds a `config.toml` with only the vault server, plus `[compat.claude] mcps = false` and
  `[compat.cursor] mcps = false`. The file is rewritten before every turn because the bridge port can
  change.
- **Sign in:** `grok login`, run with the same `GROK_HOME`. The app's Grok therefore has **its own
  sign-in**, separate from a terminal `grok`. Status: `<GROK_HOME>/auth.json` exists (unverified).
- **API key:** `XAI_API_KEY`. Grok uses it only when no session token is stored. So API-key mode runs
  with a second app home, `~/.skill-vault/engines/grok-apikey/`, where no login is ever written.
  Switching modes never deletes the login.
- **Turn:** `grok --prompt-file <tmp> --output-format streaming-messages-json --include-partial-messages
  (-s <uuid> | -r <uuid>) --cwd <vault> --tools read_file,grep,list_dir,web_search,web_fetch
  --no-auto-update`. Headless Grok doesn't read stdin, so the prompt goes through a temp file. That file
  is deleted after the turn.
- **Fail-closed until verified (final-review ruling).** The allowlist has no shell tool
  (`run_terminal_cmd`) and no file-write tools (`write_file`, `search_replace`), and the turn passes no
  `--allow 'Bash(git *)'` rule. The engine note says there is no shell and no direct file edits, so the
  model works through the vault tools. Once the live check shows headless Grok refuses a non-git command
  and a write outside `--cwd`, those three tools, the `--allow` pair and the git-only note come back
  (`grok.ts` says exactly what to restore).
- **Events:** the output is Claude's stream-json wire format, so the parser is `parseStreamJsonLine` plus
  a Grok tool-name map: `run_terminal_cmd` → `Bash`, `read_file` → `Read`, `search_replace` → `Edit`,
  `write_file` → `Write`, `grep` → `Grep`, `list_dir` → `Glob`, `web_search` / `web_fetch`, and
  `use_tool {name: "vault__x"}` → `mcp__vault__x`. Cost comes from the `result` record, as with Claude.
  `fixtures/grok-turn.jsonl` is **hand-written** from these docs, not recorded.
- **Safety (unverified):** the plan's last task checks two things live. First, that headless Grok with
  the git-only rule restored refuses a non-git command and a write outside the vault (until then it ships
  without a shell or file writes, above; if the check fails, it stays that way). Second, whether it also
  honors `~/.claude/settings.json` permission rules; if it does, the app home's config turns that compat
  off.

### Shared by the non-Claude engines

**Instructions and skills.** `engines/instructions.ts` composes one block from the shipped plugin:

1. The body of the lead agent (`assistant-plugin/agents/<LEAD_AGENT>.md`, frontmatter stripped).
2. An **engine note**: "You are running on <label> inside Skill Vault." It explains how tool names map
   (the vault tools as this engine names them). Its shell line depends on the engine: your shell tool
   runs in a sandbox (Codex), or — on Copilot and, for now, Grok — there is no shell tool, so you can't
   run git; use a vault tool, or give the user the exact command. With `writes: false` (Grok for now) it
   also says there are no file edit/write tools, so every change goes through the vault tools. It also
   says subagents aren't available on
   this engine, so when the instructions say to delegate, do that work yourself using the matching
   skill. Copilot is the exception: it loads the plugin's agents (verified).
3. A **skills index**: one line per plugin skill with its name, its `description`, and the absolute
   path of its `SKILL.md`, plus the line "Read a skill's SKILL.md (and its references/) before doing
   that kind of work." The plugin folder is a readable directory on every engine.

How each engine gets the block:

- **Codex, Grok:** the prompt is `<skill-vault-instructions>…</skill-vault-instructions>` (first turn
  only; the session keeps it after that), then `<skill-vault-context>…</skill-vault-context>` (every
  turn), then the message. This goes through stdin or the prompt file, so Windows' 32 K command-line
  limit never applies.
- **Copilot:** gets the lead agent's body and the skills from the plugin through `--agent`. Its
  prepended block is the engine note (first turn only) plus the context block (every turn).

The stored turn's `user` stays the raw message, so the chat shows what you typed.

**Tool labels.** Each parser maps native tool names to the canonical Claude names, then calls the
existing `labelForTool`. The activity timeline reads the same on every engine.

**Cost.** `turn_end.cost_usd` is set only where the CLI reports USD (Claude, Grok). The chat shows no
cost otherwise.

## Safety

| Engine | Shell | File writes | App changes | User's own config kept out by |
|---|---|---|---|---|
| Claude | `Bash(git:*)` | Edit/Write (cwd + add-dirs) | `mcp__vault__*` | `--strict-mcp-config`, `--setting-sources ""` (today) |
| Codex | any command, **sandboxed** (`workspace-write`, `windows.sandbox="unelevated"`), **no network** | vault + repos only (sandbox) | vault MCP (tools auto-approved) | `--ignore-user-config` |
| Copilot | **none** (`--available-tools` lists no shell tool) | `create`/`edit` + `--allow-tool write` (cwd + add-dirs + system temp, where Copilot saves large tool output) | `vault` | `--disable-builtin-mcps`; `--available-tools` drops every tool not listed, including the computer-use plugin |
| Grok | **none** for now (no `run_terminal_cmd`, no `--allow`); `Bash(git *)` after the live check | **none** for now (no `write_file` / `search_replace` in `--tools`); restored after the live check | vault MCP | app-owned `GROK_HOME`, compat off |

- Every engine registers **one** MCP server, `vault`, built by the existing `buildMcpConfig` and
  allowed as a whole server. Tools added to `assistant-mcp/bridge.ts` later reach all four engines with
  no per-engine change. That includes `read_skill_files`, `save_skill` and `package_for_desktop`, which
  the Claude Desktop work is adding in parallel. The engine note's tool-name mapping is generic
  (`mcp__vault__<tool>` → this engine's spelling), not a list of tools.
- Nothing here ever passes `--yolo`, `--allow-all*`, `bypassPermissions`,
  `--dangerously-skip-permissions` or `--dangerously-bypass-approvals-and-sandbox`. One unit test
  (`engines/safety.test.ts`) asserts that for every registered engine's `buildTurn` (new and resumed
  chat, login and API key), matching `--flag=value` forms too, plus: no Copilot argument contains
  `shell(`, Grok gets no shell tool, no `--allow` rule and no file-write tool, Claude's shell rule is
  git-only, and Codex always passes `sandbox_mode="workspace-write"` and
  `sandbox_workspace_write.network_access=false` (never `=true`).
- **Codex's sandbox network is off (user decision 2026-10-30).** The final review found that with network
  on, a sandboxed command could call the app's own unauthenticated API on 127.0.0.1 (the cross-site guard
  allows requests with neither `Origin` nor `Sec-Fetch-Site`) and, for example, repoint a provider and
  push files outside the writable roots, which bypasses the audited bridge. Of the three options (network
  off; a per-run secret header; accept and document), the user chose network off. Codex loses `git
  clone`/`pull` and `curl` in its shell; the vault tools (updates, adopt, clone) run server-side and keep
  working.
- The live check in the plan runs a refused action on each engine (a non-git command, and a write
  outside the vault) and confirms it was refused. For Codex, the refused actions are the write outside
  the vault and a loopback call to the app's API (no network). For Copilot, the command can't even be
  attempted (no shell tool). For Grok, the check runs with its shell and write tools restored, before
  they ship.

## Install flow

1. **Install <Provider>** opens a confirm dialog. It shows each step's exact command, where it downloads
   from (npmjs.com, x.ai, claude.ai), and "This installs a program on this PC."
2. **Install** starts `POST /engines/:id/install`. Output lines stream into the dialog.
   - npm steps run the `npm.cmd` next to the app's own Node (`path.dirname(process.execPath)`), falling
     back to `npm` on PATH. If neither exists, the dialog says Node.js/npm is needed and doesn't run.
   - PowerShell steps run `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "<installer>"`.
     These are the vendors' documented one-liners, and the bypass is for that one process.
   - The commands come from the engine module and never from the request.
   - Steps run with stdin closed, so a vendor script that prompts fails instead of waiting. A step still
     running after 10 minutes is killed and the install fails with that message.
   - While it runs, Escape and the backdrop don't close the dialog, but **Cancel install** calls
     `POST /engines/:id/install/cancel`, which kills the step; the stream then ends with `done` ok:false
     "The install was stopped."
3. On success the server re-detects with refresh (which clears the remembered exe). The dialog shows
   "Installed v…" and, when the provider signs in with an account and isn't signed in yet, moves
   straight on to **Sign in**.
4. On failure the dialog shows the last 20 output lines, **Copy command** and **Check again**. A failed
   refresh or Check again shows its error in the dialog.
5. While an install runs, `app.locals.isBusy` reports busy: the idle auto-stop waits, and an app update
   waits.

## Sign-in flow

1. **Sign in** starts `POST /engines/:id/login`. The server spawns `powershell.exe -NoProfile -Command
   "& '<exe>' <login args>; …; exit $code"` in a **new visible console window** (`detached: true`,
   `windowsHide: false`). The window exits with the login command's exit code; on a failure it first
   waits for Enter so the error stays readable.
   - The window's title is "Sign in to <Provider>".
   - It uses the engine's login-mode env (stray tokens stripped; `GROK_HOME` for Grok).
   - The command is built only from the resolved exe path and the engine's fixed args.
   - Only loopback requests may start it, the same as the folder dialog.
   - If PowerShell can't be started, the route answers 500 with the reason and nothing stays pending.
   - The tool handles its own browser or device-code step in that window.
   - Outside Windows the app says to run `<cliName> <login args>` in a terminal.
2. The dialog shows the engine's hint ("Finish signing in in the window that opened"). It polls
   `GET /engines/:id?refresh=1&mode=login` every 2 s for up to 10 minutes.
3. Once that view shows a login (`auth.mode` login) with `signed_in` true, the dialog shows "Signed in as
   <account>" and the server closes the window. A status for the other mode never closes it.
   - **Already signed in at start ("Sign in again").** Stored state (Copilot's config, Grok's
     `auth.json`, `codex login status`) can read as signed in with an expired token, so `signed_in` proves
     nothing. The start response says `already_signed_in: true`; the server never closes that window
     early, and the dialog finishes only when `GET /engines/:id`'s `sign_in` reports the window exited
     with code 0.
   - A window that exits with any other code is reported as failed ("The sign-in didn't finish (exit
     code N)") with **Try again**.
4. **Cancel** calls `/login/cancel`, which kills the window's process tree — only when the open window
   belongs to that provider. A timeout does the same and says "Didn't see a sign-in — try again".
5. While a sign-in is pending, `isBusy` reports busy (like `notionSignInPending`).

**API key mode.** A radio button switches **Account login / API key** for the selected provider. The key
field is write-only; the UI shows "Key saved", and **Remove** clears it. In API-key mode, "signed in"
means a key is saved, or the engine's env var is already set (`env_key_present`). The app doesn't make a
paid call to test the key.

**Auth errors in a turn.** `withAuthHint` becomes per engine: each engine lists the error texts that
mean it is signed out. A matching turn error gets "— sign in again in Settings → AI assistant."

## UI

**Settings → AI assistant** (`client/src/components/assistant/ProviderSettings.tsx`, new; `Settings.tsx`
keeps only the section shell):

- A **Provider** list with four rows. Each row shows its state (*Not installed* / *Installed v0.144* /
  *Signed in as …* / *API key saved*) and a radio button. An installed row shows its version and
  "checked with <verifiedVersion>" as visible text.
- The selected row expands to show **Install** or **Sign in**, the **Account login / API key** choice,
  and the key field. Claude's existing panel (login vs API key + workspace ID) moves into its row,
  unchanged.
- When the selected provider isn't Claude: "AI tagging and merge-on-update still use Claude Code."
- The existing "Install assistant skills" block stays below the list.
- Dialogs: `EngineInstallDialog.tsx` and `EngineSignInDialog.tsx`, shared with the setup guide and the
  chat panel.

**Chat panel:**

- The header shows the chat's provider label.
- For a **new** chat whose (selected) provider isn't ready, the empty state says why, with one button:
  **Install** or **Sign in**.
- An open chat is judged by its own engine: if that engine isn't ready, its history still renders
  read-only and the composer is locked with the note from Sessions. History always renders.
- The session list shows a small badge on chats whose engine differs from the current setting.

**Setup guide** (`client/src/pages/setup/steps/AssistantStep.tsx`):

- The step becomes **pick provider → install (if missing) → sign in → login or API key**. It reads
  `/api/assistant/engines` and reuses the two dialogs.
- Install and sign-in happen **immediately** in the step. They change the tool, not the app's config, so
  the guide's "nothing is saved until Finish" rule still holds for config.
- Like today's step, it preloads what's saved: with nothing in the draft yet, the auth choice starts from
  the selected provider's saved mode, and Claude's workspace ID from `GET /api/assistant/auth`. Next
  without a click changes nothing.
- "Signed in" shows only for a login status (the saved mode is login, or a sign-in finished in the step).
- The draft's `assistant` gains `engine`: `{ engine, auth, workspace_id? }`. As today, an API key stays
  in page memory only and is sent with Finish.
- Finish writes `assistant.engine` and that engine's auth (Claude's fields for Claude,
  `engines.<id>` otherwise).
- `/api/setup/assistant` is removed once the step moves to `/api/assistant/engines` (nothing else calls
  it).

## Errors

- **Engine not ready at stream time:** 409 JSON before any NDJSON ("Codex isn't installed —
  Settings → AI assistant", "Copilot isn't signed in — …").
- **CLI exits without a final event:** an `error` event built from the last 3 stderr lines plus the
  engine's sign-in hint, as today. Copilot's final `result` with a non-zero `exitCode` is an error too.
- **Lines a parser can't read** are skipped, and unknown event types are ignored. A CLI update can drop a
  timeline line; it can't crash a turn. `verifiedVersion` is shown in Settings next to the installed
  version, so drift is visible.
- **Temp files** (the Grok prompt file and its `config.toml`) are written under the app's
  `~/.skill-vault/engines/` folders. Prompt files are deleted in a `finally`.
- **Unchanged and engine-agnostic:** the per-chat turn lock, the 2-turn global cap, Stop (process-tree
  kill) and the idle and hard timeouts.
- **Install and sign-in:** one of each at a time (409 otherwise). A sign-in window that can't be opened
  is a 500 with the reason. A server shutdown kills a running install and closes a sign-in window.

## Testing

node:test, in the same layout as now. No test spawns a real CLI.

- **Each engine:**
  - snapshot tests of first-turn and resumed-turn `buildTurn` output
  - `childEnv` tests (login strips the stray vars, API key sets them, Claude unchanged)
  - parser tests against the spike's **recorded fixtures** (`engines/fixtures/codex-turn.jsonl`,
    `copilot-turn.jsonl`): text, the vault tool call, a shell call (Codex), the refusal the fixture
    holds (Copilot's denied `create` → `ok: false`; Codex's refusals don't appear in its fixture, so a
    synthetic test covers `declined` and `failed`), the end of the turn. Grok's fixture is hand-written
    from xAI's docs and replaced by a recorded one in the live check.
  - `authStatus` tests with fake files and a fake runner
- **Safety (`engines/safety.test.ts`):** for every registered engine, `buildTurn` (new/resumed chat ×
  login/API key) never contains a Global Constraints flag; no Copilot argument contains `shell(`; Claude's
  and Grok's shell allowance is git-only; Codex's sandbox mode is asserted. The forbidden list lives in
  `engines/testFakes.ts` (`FORBIDDEN_FLAGS`).
- **`exe.ts`:** PATH, shim, known folders, registry PATH (read only when the others miss), each with
  fakes; the per-name memo and `forget` in `common.ts`.
- **`instructions.ts`:** lead body, engine note (subagents; git-only shell vs none) and skills index from
  a fixture plugin dir. The block goes only on the first turn; the context block goes on every turn.
- **Routes:** `GET /engines`; `PUT /engine`; `PUT /engines/:id/auth` never echoes the key, and `""`
  clears the saved Claude key through `/engines/claude/auth`; the install job with a fake runner
  (streams, 409 on a second install, commands never taken from the body); login with a fake window
  (opens, closes once signed in, cancel closes it, a non-loopback Host gets 403, a window that fails to
  open gives 500); `/stream` gives 409 for an engine that isn't ready.
- **Sessions:** old chats read as Claude; Codex's thread id is saved and used on resume.
- **Setup:** the draft accepts and normalizes `engine` (missing = claude); Finish writes the right config
  fields.
- **Client:** Settings provider states; the chat empty state; the read-only chat note.

**Live checks (manual, each with the user's OK first, because they spend real requests):**

- Per engine: one short turn that calls `list_skills`; one refused non-git command (Copilot: no shell
  tool at all; Codex: allowed by design); one refused write outside the vault; a resumed second turn that
  remembers the first.
- Grok: install and sign-in end to end, since it isn't installed on this machine and wasn't run in the
  spike; record a real fixture; confirm or correct S1–S4.

## Plan task 1 — verification spike (done)

Before any adapter code, the spike ran one short real turn per CLI with the flags above and a prompt
that calls one vault tool, runs `hostname` and writes outside the vault, saved the raw JSONL as parser
fixtures, and settled the open items. Codex and Copilot were recorded. Grok was skipped (user decision).
Gemini CLI was tried and dropped (its sign-in is refused for individuals). The results are below; the
adapter details above already reflect them.

## Docs & rollout

- **Default stays Claude:** existing users see no change until they pick another provider.
- **Docs:**
  - `docs/assistant.md`: providers, install, sign-in, safety per provider, and what differs (no
    subagents on Codex and Grok; no shell on Copilot; no cost on some)
  - `docs/configuration.md`: `assistant.engine`, `assistant.engines`
  - `docs/faq.md`: "Why does Grok need its own sign-in?", "Why is Codex's shell not git-only?", "Why
    can't the assistant run git on Copilot?"
  - `docs/tech_reference.md`: the API rows for the new routes
  - `docs/changelog.md`, and `app/CHANGELOG.md` entries under the top `## [Unreleased] - 2026-10-28`
    heading (this ships in the combined 0.2.0 release with the setup guide and the Notion fixes)
- **Where to build:** in this worktree (`.claude/worktrees/assistant-providers`, branched from local
  main `a25a664`), never in the shared `C:\Github\skill-vault` checkout. Rebase onto main before the PR,
  since the Claude Desktop work touches `bridge.ts` in parallel.

## Files

**New** (`app/server/services/assistant/engines/`): `types.ts`, `registry.ts`, `exe.ts`, `config.ts`,
`instructions.ts`, `common.ts`, `claude.ts`, `codex.ts`, `copilot.ts`, `grok.ts`, `state.ts`, `install.ts`
(the install job), `signIn.ts` (window launcher + pending state), `jobs.ts`, `testFakes.ts`, `fixtures/`,
plus tests for each and `safety.test.ts`. Also `server/routes/assistant.test.ts`.
Client: `components/ui/Modal.tsx`, `components/assistant/ProviderSettings.tsx`, `ClaudeSignIn.tsx`,
`EngineInstallDialog.tsx`, `EngineSignInDialog.tsx`.

**Changed:**

- `server/services/assistant/turn.ts`: engine-agnostic runner
- `server/services/assistant/session.ts`: `engine`, `engine_session_id`
- `server/services/assistant/streamEvents.ts`: canonical tool names, event builders, parser options
- `server/services/assistant/mcpConfig.ts`: `VaultMcpServer`
- `server/routes/assistant.ts`: engine routes; `/stream` picks the engine
- `server/services/claude/cli.ts`: stream runner spawn targets; Claude's exe search dirs
- `server/services/appConfig.ts`: the assistant block's `engine` / `engines`
- `server/index.ts`: `isBusy` includes a running install and a pending sign-in
- `server/services/setup/draft.ts` and `server/services/setup/apply.ts` (the Finish job):
  `assistant.engine`
- `server/routes/setup.ts`
- `client/src/lib/api.ts` (one NDJSON reader), `lib/setup.ts`, `lib/appUpdate.ts`
- `client/src/pages/setup/steps/AssistantStep.tsx`, `ReviewStep.tsx`
- `client/src/pages/Settings.tsx`
- `client/src/lib/assistant.ts`, `lib/assistantStore.ts`
- `components/assistant/AssistantPanel.tsx`, `SessionList.tsx`
- the docs listed above

## Spike findings (2026-10-29)

| # | Item | Finding |
|---|---|---|
| S1 | Grok install folder | Unverified: Grok skipped (user decision). Default from xAI's docs kept: `~/.grok/bin`. |
| S2 | Grok sign-in file under GROK_HOME | Unverified: Grok skipped. Default kept: `auth.json` in `GROK_HOME`. |
| S3 | Grok tool names + MCP call shape | Unverified: Grok skipped. Defaults kept: `read_file, grep, list_dir, search_replace, write_file, run_terminal_cmd, web_search, web_fetch`; MCP via `use_tool {name: "vault__<tool>"}`. `fixtures/grok-turn.jsonl` is hand-written from these. |
| S4 | Grok refusals; ~/.claude/settings.json compat | Unverified: Grok skipped. Checked live in the plan's last task. |
| S5 | `codex login status` signed-in exit/text | Exit 0, stdout "Logged in using ChatGPT". |
| S6 | CODEX_API_KEY for `codex exec` | Unverified (no API key offered). `CODEX_API_KEY` default kept. |
| S7 | Codex sandbox on Windows; item shapes; resume | codex-cli 0.144.4. With `--ignore-user-config` Codex has no Windows sandbox and falls back to read-only: every command "blocked by policy", MCP calls `error.message = "user cancelled MCP tool call"`. `-c windows.sandbox="unelevated"` and `-c mcp_servers.vault.default_tools_approval_mode="approve"` fix it. With them: `list_skills` succeeded, `hostname` ran (allowed by design in the sandbox), the write outside the vault was refused ("writing outside of the project"; no `file_change` item is emitted for a rejected patch). Events: `thread.started{thread_id}`, `turn.started`, `item.started`/`item.completed{item}`, `turn.completed{usage}`. Items: `agent_message{id,text}`; `mcp_tool_call{id,server,tool,arguments,result:{content:[{type,text}]}\|null,error:{message}\|null,status: in_progress\|completed\|failed}`; `command_execution{id,command,aggregated_output,exit_code,status: in_progress\|completed\|declined}`. Resume (`codex exec resume <thread_id> … -`) remembered the first turn and emits `thread.started` again with the same `thread_id`. |
| S8 | Copilot signed-in field in config.json | Copilot CLI 1.0.105. camelCase: `lastLoggedInUser: {host, login}` and `loggedInUsers: [{host, login}]` (not snake_case). |
| S9 | Copilot --agent name; event shapes; MCP tool spelling; refusals; resume | `--agent` must be plugin-qualified: `skill-vault-assistant:vault-assistant` (the bare name is rejected: "No such agent … available: skill-vault-assistant:…"). There is no `--no-remote` flag. Copilot's default "manual" permission mode auto-approves commands it classes as read-only: `hostname` ran with only `shell(git:*)` allowed, so a git-only allowlist isn't enforceable → **no shell** (user decision): `--available-tools view create edit grep glob web_fetch skill task update_todo vault` (each its own argv element; `vault` = every vault MCP tool, verified; `vault-*` doesn't work), plus `--allow-tool write --allow-tool vault --disallow-temp-dir` (later dropped: Copilot saves tool output over ~20 KB to temp and must read it back). The allowlist also removes the built-in computer-use plugin MCP, sql, workflow and shell-session tools. Events: JSONL `{type, data, id, timestamp, parentId, ephemeral?}`; `assistant.message_delta{messageId, deltaContent}` (concatenated = the final message `content`); `assistant.message{messageId, content, toolRequests:[{toolCallId,name,arguments,mcpServerName?,mcpToolName?}]}`; `tool.execution_start{toolCallId, toolName, arguments, mcpServerName?, mcpToolName?}`; `tool.execution_complete{toolCallId, success, result:{content, detailedContent?}\|undefined, error:{message, code}\|undefined}`; `tool.shell_output`, `assistant.tool_call_delta`, `assistant.turn_start/turn_end{turnId}`, `assistant.idle{}`, many `session.*` (ignored); final `result{sessionId, exitCode, usage:{premiumRequests,…}}` (no `data`). Tool names: `view`, `create`, `edit`, `grep`, `glob`, `web_fetch`, `skill`, `task`, `update_todo`, `tool_search_tool`, `powershell` (absent under the allowlist), MCP as `vault-<tool>`. The recorded fixture predates the allowlist (a `powershell` call that ran, a `create` denied with `error.code = "denied"`, a `tool_search_tool` call): parser tests use it for shapes only. Resume with the same `--session-id` remembered the first turn. |
| S10 | Gemini login files; `-p ""` + stdin | Gemini CLI 0.55.1: Google-account sign-in refused server-side (`IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals … migrate to the Antigravity suite`). **Gemini dropped** from this branch. |
| S11 | Gemini resume by UUID | Not reached (Gemini dropped). |
| S12 | Gemini policy; refusals; event shapes; MCP spelling | Not reached, except: Gemini's policy TOML rejects `toolName` as an array. |
