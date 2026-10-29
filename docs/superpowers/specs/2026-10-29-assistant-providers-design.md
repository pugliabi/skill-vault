# AI Assistant Providers — Design

**Date:** 2026-10-29 · **Status:** approved design, awaiting spec review · **Not in the original
5-project roadmap** — a new request, built on top of the merged first-run setup guide (d778d08).

## Problem

- The assistant only runs on Claude Code. Someone who pays for ChatGPT, Copilot, Grok or Gemini instead
  can't use it at all.
- Everything is wired to `claude -p`: the flags in `turn.ts`, the stream-json parser in
  `streamEvents.ts`, the `.cmd`-shim resolver in `claude/cli.ts`, the sign-in panel in Settings, and the
  setup guide's Assistant step.
- If the CLI isn't installed, the app shows a command to copy and run somewhere else. Sign-in is the same:
  the app checks it, but you have to do it on your own.

## Goals

1. One app-wide **provider** setting picks the CLI that runs new assistant chats: **Claude Code**
   (default), **OpenAI Codex**, **GitHub Copilot CLI**, **Grok Build** or **Gemini CLI**.
2. When the chosen CLI isn't installed, the app **installs it**: it shows the exact command first, then
   streams the output.
3. The app **starts sign-in for you**. It opens the tool's own login in a window, waits until you're
   signed in, then says so. An **API key** is the alternative for each provider.
4. The chat works the same on every provider: vault tools through the MCP bridge, the lead agent's
   instructions, the ten skills, the per-turn context, the activity timeline, Stop, and resume.
5. Safety stays deny-by-default on every provider. The shell is git-only everywhere except Codex, which
   runs sandboxed (see Safety). Other changes to the app go only through the audited bridge.
6. The setup guide's Assistant step becomes **pick provider → install → sign in**.

## Non-goals

- AI auto-tagging and the Claude merge on update. They stay on Claude, and Settings says so.
- Picking the provider per chat (the setting is app-wide).
- A model picker for any provider.
- ACP (Agent Client Protocol). We considered it and chose per-CLI headless adapters instead.
- Subagents on Codex, Grok and Gemini. Their lead agent does the specialist work itself, using the
  skills.
- Install commands outside Windows. Other platforms show the command to run yourself.

## Decisions made while brainstorming

| Question | Decision |
|---|---|
| How is the provider chosen? | One app-wide setting. It applies to new chats; an existing chat keeps the provider it started on. |
| Do tagging and merge follow it? | No, chat only. |
| Which providers? | Codex, Copilot, Grok Build, Gemini (plus Claude). |
| How do you sign in? | The tool's own account login by default, an API key/token optionally. |
| How does the app talk to each CLI? | Per-CLI headless adapters (one turn = one CLI process), the same model as Claude today. |
| How safe is Codex? | Codex has no per-tool allowlist. It runs in the `workspace-write` sandbox: writes are limited to the vault and repos folders, and network is on so `git clone` works. |

**Naming.** In this codebase "providers" already means skill targets (`agent_locations`). So in code,
an assistant backend is an **engine** (`assistant.engine`, `engines/`). The UI calls it **Provider**.

## Architecture

### Engine modules

`app/server/services/assistant/engines/` contains one module per CLI and a registry:

```ts
export type EngineId = "claude" | "codex" | "copilot" | "grok" | "gemini";

export interface AssistantEngine {
  id: EngineId;
  label: string;                         // "OpenAI Codex"
  verifiedVersion: string;               // CLI version the adapter + fixtures were checked against
  install: InstallStep[];                // shown to the user before running
  detect(): Promise<EngineDetect>;       // { installed, version?, exe?, reason? }
  authStatus(cfg: EngineAuthConfig, exe: string): Promise<EngineAuthStatus>;
  loginCommand(exe: string): { args: string[]; env: Record<string, string>; hint?: string };
  childEnv(cfg: EngineAuthConfig, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  buildTurn(input: TurnInput, exe: string): TurnSpec;
  createParser(): TurnParser;
}

export interface InstallStep { label: string; command: string; args: string[]; source: string; shell: "npm" | "powershell" }
export interface EngineAuthConfig { auth?: "login" | "api_key"; api_key?: string }   // Claude also has workspace_id
export interface EngineAuthStatus { signed_in: boolean; method: "login" | "api_key"; account?: string; detail?: string }

export interface TurnInput {
  sessionId: string;            // the app's chat UUID
  engineSessionId?: string;     // an id the engine assigned (Codex threads)
  isFirstTurn: boolean;
  message: string;              // what the user typed
  instructions: string;         // see "Instructions and skills"
  contextBlock: string;         // buildTurnContext() output, as today
  mcp: McpBridgeConfig["mcpServers"]["vault"];   // from mcpConfig.ts, unchanged
  vaultPath: string; reposDir: string; pluginDir: string;
  workDir: string;              // ~/.skill-vault/engines/<id>/
}
export interface TurnSpec { exe: string; args: string[]; stdin: string; env: NodeJS.ProcessEnv; cwd: string; tempFiles?: string[] }
export interface TurnParser { (line: string): AssistantStreamEvent[]; engineSessionId?(): string | undefined }
```

- `claude.ts` wraps today's code with no behavior change: `buildTurnArgs`, `parseStreamJsonLine`,
  `claudeChildEnv`, `claudeAvailable`, `claudeLoginStatus`.
- `turn.ts`'s `runTurn` keeps its job (stream, compact, error handling). It now takes a `TurnSpec` and a
  `TurnParser` instead of claude args. Its result also returns `engineSessionId`.
- The stream runner (`defaultStreamRunner`) takes the exe and env from the `TurnSpec`. The process-tree
  kill, the idle and hard timeouts, and the abort signal are unchanged.

### Finding the real executable

`claude/cli.ts`'s `resolveClaudeExe` becomes a general helper in `engines/exe.ts`:
`resolveExe(name, knownDirs)`. It checks, in order:

1. `name.exe` on the process PATH.
2. A `name.cmd` shim on PATH, parsed with `parseClaudeCmdShim` (renamed `parseCmdShim`).
3. The PATH **as stored in the registry right now** (`HKCU\Environment`, then `HKLM\…\Session
   Manager\Environment`). Installers update the registry, not the running server.
4. Known install folders: the npm global prefix, `%USERPROFILE%\.local\bin`, and Grok's install folder
   (†, see the spike).

Results are cached per name. `refresh` clears the cache, and so does a finished install. The rule against
newline arguments through `cmd.exe` stays: an engine whose real `.exe` can't be found refuses a turn
whose args contain a newline.

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
- If that engine isn't installed or signed in, the chat's history still renders. The composer is replaced
  by: "This chat used Codex — sign in to continue it, or start a new chat."
- Claude, Copilot, Grok and Gemini accept the app's UUID as their session id. Codex assigns a thread id:
  the parser reads it from the first event, `runTurn` returns it, and `endTurn` saves it as
  `engine_session_id`.
- `SessionSummary` and the session detail include `engine`.

### Routes (`/api/assistant`)

| Route | Purpose |
|---|---|
| `GET /status` | As today, now for the selected engine: `{available, engine, label, version, reason}`. `available` = vault set + plugin present + engine installed + (signed in, or an API key saved). |
| `GET /engines` | `[{id, label, selected, installed, version, reason, auth: {mode, signed_in, account, has_saved_key, env_key_present}}]`. `?refresh=1` re-detects. |
| `PUT /engine` | `{engine}` — the provider for new chats. |
| `POST /engines/:id/install` | Runs the install steps as an NDJSON job (the same format as `POST /api/app/update`). Only one install at a time (409 otherwise). |
| `POST /engines/:id/login` | Opens the sign-in window and returns `{started: true}`. Loopback requests only. |
| `POST /engines/:id/login/cancel` | Closes the sign-in window. |
| `PUT /engines/:id/auth` | `{auth?, api_key?}`, using the same omitted = keep, `""` = clear rules as Claude's `PUT /auth`. |
| `GET/PUT /auth` | Unchanged. This is still Claude's (Settings and the setup guide use it for Claude). |

Every POST and PUT above goes through the existing cross-site guard, like the other `/api/app` and
`/api/setup` mutations.

`POST /stream` picks the engine (the session's, or config's for a new chat). If that engine isn't ready
it answers **409 with a JSON error before streaming starts**. Otherwise it builds the `TurnInput`, calls
`engine.buildTurn`, and runs the turn as today.

## Engines

Items marked **†** are confirmed against the real CLI in plan task 1 (the spike) before the adapter is
built. If a † item turns out different, the spike's notes update this spec before the adapter task starts.

### Claude Code (existing)

- **Install:** PowerShell `irm https://claude.ai/install.ps1 | iex` (claude.ai).
- **Sign in:** `claude auth login`. Status comes from `claude auth status` (the existing
  `claudeLoginStatus`).
- **Turn:** today's `buildTurnArgs`, unchanged.

### OpenAI Codex — checked against codex-cli 0.144.4

- **Install:** `npm install -g @openai/codex` (npmjs.com).
- **Sign in:** `codex login` opens a browser for the ChatGPT account. Status: `codex login status`
  (exit code and text †).
- **API key:** the saved key goes in as `CODEX_API_KEY` (†) in the turn's environment, so the user's own
  terminal login isn't overwritten. Login mode strips `OPENAI_API_KEY` and `CODEX_API_KEY`.
- **Turn:** the prompt goes on stdin (`-`). The first turn is `codex exec --json …`; later turns are
  `codex exec resume <engine_session_id> --json …`. `resume` takes fewer flags, so both forms put
  everything else in `-c`:
  - `--ignore-user-config --skip-git-repo-check` (the user's own MCP servers and config stay out; auth
    still comes from `CODEX_HOME`)
  - `-c sandbox_mode="workspace-write"`
  - `-c sandbox_workspace_write.writable_roots=[<vault>, <repos>]`
  - `-c sandbox_workspace_write.network_access=true`
  - `-c approval_policy="never"`
  - `-c mcp_servers.vault.command=… / .args=[…] / .env={SKILL_VAULT_URL="…"}`

  The spawn's cwd is the vault.
- **Events (†, shapes from fixtures):**
  - `thread.started` gives `thread_id` (the engine session id).
  - `item.completed` and `item.started`: `agent_message` → `text_delta` (whole message, no token
    streaming); `command_execution` → `Bash`; `file_change` → `Edit`; `mcp_tool_call` →
    `mcp__<server>__<tool>`; `web_search` → `WebSearch`.
  - `turn.completed` → `turn_end` (no cost; the usage tokens aren't shown).
  - `turn.failed` and `error` → `error`.
- **Windows sandbox (†):** the spike checks that a write outside the roots is refused on Windows. If
  Codex reports the sandbox as unavailable on this machine, **Codex turns refuse to start** with a clear
  message. They never run unsandboxed.

### GitHub Copilot CLI — checked against 1.0.69

- **Install:** `npm install -g @github/copilot` (npmjs.com).
- **Sign in:** `copilot login`, a device code shown in the window. Status (†): read
  `<COPILOT_HOME or ~/.copilot>/config.json`, looking for the logged-in user. If that isn't reliable, the
  fallback is a cheap no-model check found in the spike.
- **API key:** a fine-grained PAT with "Copilot Requests", passed as `COPILOT_GITHUB_TOKEN`. Login mode
  strips `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN`. Copilot ranks those above the stored login,
  and a stray `GH_TOKEN` from the `gh` CLI would take over.
- **Turn:** `copilot -p <context + message> --output-format json --session-id <uuid>`. The same flag
  creates the session on the first turn and resumes it on later turns. Also passed:
  - `-C <vault> --add-dir <repos> --add-dir <plugin>`
  - `--plugin-dir <plugin> --agent <lead>` (†: the agent's name may be namespaced). Verified already:
    Copilot loads the bundle as-is; `copilot --plugin-dir assistant-plugin plugin list` shows
    `skill-vault-assistant (v2.0.0)`.
  - `--additional-mcp-config <json> --disable-builtin-mcps`
  - `--allow-tool 'shell(git:*)' --allow-tool write --allow-tool vault`
  - `--no-ask-user --no-auto-update --no-remote`

  The prompt is an argument, so the real `copilot.exe` behind the npm shim must be resolved (the ACP probe
  showed it lives under `@github/copilot-win32-x64`).
- **Events (†, from fixtures):** mapped to the same canonical tool names as the others.

### Grok Build — install verified in docs, not on this machine

- **Install:** PowerShell `irm https://x.ai/cli/install.ps1 | iex` (x.ai).
- **App-owned home.** Grok reads MCP servers only from files: its own config, `~/.claude.json`, Cursor's
  config, and `.mcp.json`. So the app runs Grok with `GROK_HOME=~/.skill-vault/engines/grok`. That folder
  holds a `config.toml` with only the vault server, plus `[compat.claude] mcps = false` and
  `[compat.cursor] mcps = false`. The file is rewritten before every turn because the bridge port can
  change.
- **Sign in:** `grok login`, run with the same `GROK_HOME`. The app's Grok therefore has **its own
  sign-in**, separate from a terminal `grok`. Status: `<GROK_HOME>/auth.json` exists (†).
- **API key:** `XAI_API_KEY`. Grok uses it only when no session token is stored. So API-key mode runs
  with a second app home, `~/.skill-vault/engines/grok-apikey/`, where no login is ever written.
  Switching modes never deletes the login.
- **Turn:** `grok --prompt-file <tmp> --output-format streaming-messages-json --include-partial-messages
  (-s <uuid> | -r <uuid>) --cwd <vault> --tools <allowlist> --allow 'Bash(git *)' --no-auto-update`.
  Headless Grok doesn't read stdin, so the prompt goes through a temp file. That file is deleted after
  the turn.
- **Events:** the output is Claude's stream-json wire format, so the parser is `parseStreamJsonLine` plus
  a Grok tool-name map: `run_terminal_cmd` → `Bash`, `read_file` → `Read`, `search_replace` → `Edit`,
  `grep` → `Grep`, `list_dir` → `Glob`, `web_search` / `web_fetch`, and `use_tool {name: "vault__x"}` →
  `mcp__vault__x`. Cost comes from the `result` record, as with Claude.
- **Safety (†):** the spike checks two things. First, that headless Grok with these flags refuses a
  non-git command and a write outside the vault. Second, whether it also honors `~/.claude/settings.json`
  permission rules. If it does, the app home's config turns that compat off, or the flags add explicit
  `--deny` rules.

### Gemini CLI — checked against 0.55.1

- **Install:** `npm install -g @google/gemini-cli` (npmjs.com).
- **Sign in:** Gemini has no login subcommand. The window runs `gemini` with the hint "Choose **Login
  with Google**, finish in the browser, then type `/quit`." Status (†): `~/.gemini/oauth_creds.json`
  exists; the account comes from `~/.gemini/google_accounts.json`.
- **API key:** `GEMINI_API_KEY`. Login mode strips `GEMINI_API_KEY` and `GOOGLE_API_KEY`.
- **App settings file.** The app writes a system settings file
  (`~/.skill-vault/engines/gemini/settings.json`) and passes it as `GEMINI_CLI_SYSTEM_SETTINGS_PATH`
  (system settings win over the user's). It holds only the vault MCP server and the auth type that
  matches the mode (`oauth-personal` / `gemini-api-key`), and turns off auto-update.
- **Turn:** `gemini -p "" -o stream-json (--session-id <uuid> | --resume <uuid>†)
  --include-directories <repos>,<plugin> --approval-mode default --policy <app policy>
  --allowed-mcp-server-names vault --skip-trust`, with the prompt on stdin. †: resume by UUID. The help
  only shows "latest" or an index; if UUIDs don't work, the adapter maps the UUID to an index with
  `--list-sessions`.
- **Policy file (`engines/gemini/policy.toml`, format †):** allow `run_shell_command` only with the
  prefix `git `; allow `replace` and `write_file`; allow the `vault` MCP server. Anything else needs
  approval, which non-interactive mode refuses (†).
- **Events (†, from fixtures):** `run_shell_command` → `Bash`, `read_file` → `Read`, `replace` → `Edit`,
  `write_file` → `Write`, `glob` → `Glob`, `search_file_content` → `Grep`, `google_web_search` →
  `WebSearch`, `web_fetch` → `WebFetch`, vault tools → `mcp__vault__x`.

### Shared by the non-Claude engines

**Instructions and skills.** `engines/instructions.ts` composes one block from the shipped plugin:

1. The body of the lead agent (`assistant-plugin/agents/<LEAD_AGENT>.md`, frontmatter stripped).
2. An **engine note**: "You are running on <label> inside Skill Vault." It explains how tool names map
   (the vault tools as this engine names them; "Bash" means your shell tool, git only). It also says
   subagents aren't available on this engine, so when the instructions say to delegate, do that work
   yourself using the matching skill. Copilot is the exception (it loads the plugin's agents) †.
3. A **skills index**: one line per plugin skill with its name, its `description`, and the absolute
   path of its `SKILL.md`, plus the line "Read a skill's SKILL.md (and its references/) before doing
   that kind of work." The plugin folder is a readable directory on every engine.

How each engine gets the block:

- **Codex, Grok, Gemini:** the prompt is `<skill-vault-instructions>…</skill-vault-instructions>` (first
  turn only; the session keeps it after that), then `<skill-vault-context>…</skill-vault-context>`
  (every turn), then the message. This goes through stdin or the prompt file, so Windows' 32 K
  command-line limit never applies.
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
| Codex | any command, **sandboxed** | vault + repos only (sandbox), network on | vault MCP | `--ignore-user-config` |
| Copilot | `shell(git:*)` | `write` (cwd + add-dirs) | `vault` | `--disable-builtin-mcps`; other MCP servers aren't on the allow list, so `-p` denies them |
| Grok | `Bash(git *)` † | `--tools` allowlist † | vault MCP | app-owned `GROK_HOME`, compat off |
| Gemini | `git ` prefix (policy) | `replace`/`write_file` (workspace dirs) | `vault` | system settings file, `--allowed-mcp-server-names vault` |

- Nothing here ever passes `--yolo`, `--allow-all*`, `bypassPermissions` or
  `--dangerously-bypass-approvals-and-sandbox`. A unit test asserts that for every engine's
  `buildTurn`.
- The live check in the plan runs a refused action on each engine (a non-git command, and a write
  outside the vault) and confirms it was refused. For Codex, the refused action is only the write
  outside the vault.

## Install flow

1. **Install <Provider>** opens a confirm dialog. It shows each step's exact command, where it downloads
   from (npmjs.com, x.ai, claude.ai), and "This installs a program on this PC."
2. **Install** starts `POST /engines/:id/install`. Output lines stream into the dialog.
   - npm steps run the `npm.cmd` next to the app's own Node (`path.dirname(process.execPath)`), falling
     back to `npm` on PATH. If neither exists, the dialog says Node.js/npm is needed and doesn't run.
   - PowerShell steps run `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "<installer>"`.
     These are the vendors' documented one-liners, and the bypass is for that one process.
   - The commands come from the engine module and never from the request.
3. On success the server clears the exe cache and re-detects. The dialog shows "Installed v…" and moves
   straight on to **Sign in**.
4. On failure the dialog shows the last 20 output lines, **Copy command** and **Check again**.
5. While an install runs, `app.locals.isBusy` reports busy: the idle auto-stop waits, and an app update
   waits.

## Sign-in flow

1. **Sign in** starts `POST /engines/:id/login`. The server spawns `powershell.exe -NoProfile -NoExit
   -Command "& '<exe>' <login args>"` in a **new visible console window** (`detached: true`,
   `windowsHide: false`).
   - The window's title is "Sign in to <Provider>".
   - It uses the engine's login-mode env (stray tokens stripped; `GROK_HOME` for Grok).
   - The command is built only from the resolved exe path and the engine's fixed args.
   - Only loopback requests may start it, the same as the folder dialog.
   - The tool handles its own browser or device-code step in that window.
2. The dialog shows the engine's hint ("Finish signing in in the window that opened", or Gemini's menu
   hint). It polls `GET /engines` every 2 s for up to 10 minutes.
3. Once `signed_in` turns true, the dialog shows "Signed in as <account>" and the server closes the
   window.
4. **Cancel** calls `/login/cancel`, which kills the window's process tree. A timeout does the same and
   says "Didn't see a sign-in — try again".
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

- A **Provider** list with five rows. Each row shows its state (*Not installed* / *Installed v0.144* /
  *Signed in as …* / *API key saved*) and a radio button.
- The selected row expands to show **Install** or **Sign in**, the **Account login / API key** choice,
  and the key field. Claude's existing panel (login vs API key + workspace ID) moves into its row,
  unchanged.
- When the selected provider isn't Claude: "AI tagging and merge-on-update still use Claude Code."
- The existing "Install assistant skills" block stays below the list.
- Dialogs: `EngineInstallDialog.tsx` and `EngineSignInDialog.tsx`, shared with the setup guide.

**Chat panel:**

- The header shows the chat's provider label.
- If the selected provider isn't ready, the empty state says why, with one button: **Install** or
  **Sign in**.
- The session list shows a small badge on chats whose engine differs from the current setting.
- A chat whose engine isn't ready shows its history read-only, with the note from Sessions.

**Setup guide** (`client/src/pages/setup/steps/AssistantStep.tsx`):

- The step becomes **pick provider → install (if missing) → sign in → login or API key**. It reads
  `/api/assistant/engines` and reuses the two dialogs.
- Install and sign-in happen **immediately** in the step. They change the tool, not the app's config, so
  the guide's "nothing is saved until Finish" rule still holds for config.
- The draft's `assistant` gains `engine`: `{ engine, auth, workspace_id? }`. As today, an API key stays
  in page memory only and is sent with Finish.
- Finish writes `assistant.engine` and that engine's auth (Claude's fields for Claude,
  `engines.<id>` otherwise).
- `/api/setup/assistant` is removed if nothing else calls it once the step moves to
  `/api/assistant/engines` (the plan checks).

## Errors

- **Engine not ready at stream time:** 409 JSON before any NDJSON ("Codex isn't installed —
  Settings → AI assistant", "Copilot isn't signed in — …").
- **CLI exits without a final event:** an `error` event built from the last 3 stderr lines plus the
  engine's sign-in hint, as today.
- **Lines a parser can't read** are skipped, and unknown event types are ignored. A CLI update can drop a
  timeline line; it can't crash a turn. `verifiedVersion` is shown in Settings next to the installed
  version, so drift is visible.
- **Temp files** (Grok prompt file, Gemini settings and policy, Grok `config.toml`) are written under
  `~/.skill-vault/engines/<id>/`. Prompt files are deleted in a `finally`.
- **Unchanged and engine-agnostic:** the per-chat turn lock, the 2-turn global cap, Stop (process-tree
  kill) and the idle and hard timeouts.
- **Install and sign-in:** one of each at a time (409 otherwise). A server shutdown kills a running
  install and closes a sign-in window.

## Testing

node:test, in the same layout as now. No test spawns a real CLI.

- **Each engine:**
  - snapshot tests of first-turn and resumed-turn `buildTurn` output
  - `childEnv` tests (login strips the stray vars, API key sets them, Claude unchanged)
  - parser tests against **real JSONL fixtures** captured in the spike
    (`engines/fixtures/<id>-*.jsonl`): text, a vault tool call, a shell call, a refused call, an error,
    the end of the turn
  - `authStatus` tests with fake files and a fake runner
- **Safety:** for every engine, `buildTurn` never contains a bypass/yolo/allow-all flag, and the shell
  allowance is git-only (except Codex, whose sandbox mode is asserted).
- **`exe.ts`:** PATH, shim, registry PATH and known folders, each with fakes.
- **`instructions.ts`:** lead body, engine note and skills index from a fixture plugin dir. The block
  goes only on the first turn; the context block goes on every turn.
- **Routes:** `GET /engines`; `PUT /engine`; the install job with a fake runner (streams, 409 on a
  second install, commands never taken from the body); login with a fake launcher (loopback-only,
  cancel); `PUT /engines/:id/auth` never echoes the key; `/stream` gives 409 for an engine that isn't
  ready.
- **Sessions:** old chats read as Claude; Codex's thread id is saved and used on resume.
- **Setup:** the draft accepts and normalizes `engine`; Finish writes the right config fields.
- **Client:** Settings provider states; the chat empty state; the read-only chat note.

**Live checks (manual, each with the user's OK first, because they spend real requests):**

- Per engine: one short turn that calls `list_skills`; one refused non-git command; one refused write
  outside the vault (Codex: the write only); a resumed second turn that remembers the first.
- Grok: install and sign-in end to end, since it isn't installed on this machine.

## Plan task 1 — verification spike

Before any adapter code, for each of Codex, Copilot, Grok and Gemini:

1. Capture fixtures: run one short real turn per CLI with the flags above and a prompt that calls one
   vault tool and one refused shell command. Save the raw JSONL as the parser fixtures. **Ask the user
   first.**
2. Settle every † item:
   - each sign-in status check
   - Codex: `CODEX_API_KEY`, and whether the Windows sandbox is enforced
   - Copilot: the agent name with the plugin
   - Grok: install folder, `auth.json`, the safety flags, `~/.claude/settings.json` compat
   - Gemini: resume by UUID, the policy format, non-interactive refusals
3. Write the findings into this spec (a "Spike findings" section) and adjust the affected adapter
   details before their tasks start.

## Docs & rollout

- **Default stays Claude:** existing users see no change until they pick another provider.
- **Docs:**
  - `docs/assistant.md`: providers, install, sign-in, safety per provider, and what differs (no
    subagents on Codex, Grok and Gemini; no cost on some)
  - `docs/configuration.md`: `assistant.engine`, `assistant.engines`
  - `docs/faq.md`: "Why does Grok need its own sign-in?", "Why is Codex's shell not git-only?"
  - `docs/tech_reference.md`: the API rows for the new routes
  - `docs/changelog.md`, `app/CHANGELOG.md`
  - What's New

## Files

**New** (`app/server/services/assistant/engines/`): `types.ts`, `registry.ts`, `exe.ts`,
`instructions.ts`, `claude.ts`, `codex.ts`, `copilot.ts`, `grok.ts`, `gemini.ts`, `install.ts`
(the install job), `signIn.ts` (window launcher + pending state), `fixtures/`, plus tests for each.
Client: `components/assistant/ProviderSettings.tsx`, `EngineInstallDialog.tsx`,
`EngineSignInDialog.tsx`.

**Changed:**

- `server/services/assistant/turn.ts`: engine-agnostic runner
- `session.ts`: `engine`, `engine_session_id`
- `server/routes/assistant.ts`: engine routes; `/stream` picks the engine
- `server/services/claude/cli.ts`: the shim/exe resolver moves to `engines/exe.ts` and is re-exported
- `server/services/claude/auth.ts`: `withAuthHint` moves behind the Claude engine
- `server/services/appConfig.ts`: the assistant block's `engine` / `engines`
- `server/index.ts`: `isBusy` includes a running install and a pending sign-in
- `server/services/setup/draft.ts` and the setup applier: `assistant.engine`
- `server/routes/setup.ts`
- `client/src/pages/setup/steps/AssistantStep.tsx`
- `client/src/pages/Settings.tsx`
- `client/src/lib/assistant.ts`
- `components/assistant/AssistantPanel.tsx`, `SessionList.tsx`
- the docs listed above
