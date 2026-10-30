# AI Assistant Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Skill Vault assistant can run on OpenAI Codex, GitHub Copilot CLI or Grok Build as well as
Claude Code. The app installs the chosen CLI and walks the user through sign-in.

**Architecture:** One adapter module per CLI ("engine") under `app/server/services/assistant/engines/`.
Each adapter builds that CLI's headless command line and parses its JSONL output into the existing
`AssistantStreamEvent`s. The turn runner, sessions, routes, Settings, chat panel and setup guide become
engine-aware. Claude's path is wrapped, not changed.

**Tech Stack:** Node 24 + TypeScript (tsx), Express 5, node:test, React 18 + TanStack Query, Windows.

**Spec:** `docs/superpowers/specs/2026-10-29-assistant-providers-design.md`. Read it before starting any
task. It holds the reasons behind each choice. Items marked † there were settled by Task 1 and recorded in
its "Spike findings" section. Later tasks refer to those findings as S1–S9. Grok's S1–S4 are unverified
(Grok wasn't run): its adapter is built from xAI's docs and checked live in Task 20. S10–S12 belonged to
a provider that was dropped after the spike (see Task 1).

## Global Constraints

- Work only in `C:\Github\skill-vault\.claude\worktrees\assistant-providers`, never in the shared
  `C:\Github\skill-vault` checkout. All commands below run from `app/` in that worktree unless a step
  says otherwise.
- Tests: `npm test` (node:test over `server/**/*.test.ts`). Types: `npm run typecheck`. Build:
  `npm run build`. The client has no test runner, so client tasks are checked with
  typecheck + build + a look in the running app.
- Claude Code stays the default engine. Its turn args, auth env and parser behave exactly as today.
  The existing `buildTurnArgs` test must pass unchanged.
- No engine's turn ever includes `--yolo`, `--allow-all`, `--allow-all-tools`, `--allow-all-paths`,
  `--allow-all-urls`, `bypassPermissions`, `--dangerously-skip-permissions` or
  `--dangerously-bypass-approvals-and-sandbox`.
- The shell is git-only on Claude, and on Grok once Task 20 verifies it (until then Grok has no shell
  and no file-write tools: final-review ruling). Copilot has no shell tool (allowlist via
  `--available-tools`). Codex runs in `sandbox_mode="workspace-write"` (with
  `windows.sandbox="unelevated"`) with writable roots = vault + repos and network off (user decision
  2026-10-30: with network on a sandboxed command could reach the app's own API), and never
  unsandboxed.
- Saved API keys are never returned to the browser. Views report `has_saved_key` only.
- UI copy says **Provider**; code says **engine**. "Providers" in this codebase already means skill
  targets (`agent_locations`).
- Changelog entries go under `## [Unreleased]` in `app/CHANGELOG.md`. They ship in the combined
  0.2.0 release.
- Commit messages follow the repo style (`area: what changed`, lowercase area: `engines:`,
  `assistant:`, `setup:`, `client:`, `docs:`) and end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Deliberate narrowing of the spec: Claude keeps its own `resolveClaudeExe` (only extended to also
  search the registry PATH and `~/.local/bin`), and Claude's `target()` uses it. The new
  `engines/exe.ts` resolver serves the other three: it searches the process PATH, then the known install
  folders, and reads the registry PATH only when both miss. `defaultEngineDeps().resolve` (Task 9)
  remembers each name's result; an engine's `detect({ refresh: true })` forgets it.
- Deliberate narrowing: the engine contract in Task 4 (`engines/types.ts`) is the authoritative one.
  The spec's interface block now mirrors it: `TurnInput` carries `leadAgent`, `auth` and `baseEnv`;
  engines expose `target()`, `cliName`, `loginArgs` / `loginHint` / `loginEnv()`; `TurnParser` is
  `{ parse, engineSessionId? }`; `InstallStep` is a `kind` union; `signed_in` is `boolean | null`.
- Engine order everywhere (registry, Settings, setup guide, docs): claude, codex, copilot, grok.

## File map

**New:** `app/server/services/assistant/engines/` holds:
- `types.ts`: the engine contract
- `exe.ts`: find and run CLIs without a shell
- `config.ts`: the assistant block's `engine` / `engines`
- `instructions.ts`: lead agent + engine note + skills index → prompt
- `common.ts`: shared engine helpers
- `claude.ts`, `codex.ts`, `copilot.ts`, `grok.ts`: one per CLI
- `registry.ts`: which engines exist, and their work folders
- `state.ts`: cached installed / signed-in views and readiness
- `install.ts`: the install job
- `signIn.ts`: the sign-in window
- `jobs.ts`: install + sign-in handles, for busy and shutdown
- `fixtures/`: `codex-turn.jsonl` and `copilot-turn.jsonl` recorded in Task 1; `grok-turn.jsonl`
  hand-written from xAI's docs (Grok wasn't run)
- `testFakes.ts`: a test-only fake engine and the forbidden-flag list
- a `*.test.ts` file next to each module, plus `safety.test.ts` (every engine against the Global
  Constraints)

Also new: `app/server/routes/assistant.test.ts`.

Client: `app/client/src/components/ui/Modal.tsx`, plus these in `app/client/src/components/assistant/`:
`EngineInstallDialog.tsx`, `EngineSignInDialog.tsx`, `ClaudeSignIn.tsx` (moved out of Settings),
`ProviderSettings.tsx`.

**Changed:**
- `server/services/claude/cli.ts`: spawn target on the stream runner; Claude exe search dirs
- `server/services/assistant/streamEvents.ts`: canonical tool names, exported event builders, parser
  options
- `server/services/assistant/turn.ts`: runs a `TurnSpec` with a `TurnParser`
- `server/services/assistant/session.ts`: `engine`, `engine_session_id`
- `server/services/assistant/mcpConfig.ts`: `VaultMcpServer` type
- `server/routes/assistant.ts`
- `server/index.ts`
- `server/services/appConfig.ts`
- `server/services/setup/{types,draft,apply}.ts` and their `draft.test.ts` / `apply.test.ts`
- `server/routes/setup.ts` and `setup.test.ts`
- client: `lib/api.ts`, `lib/appUpdate.ts`, `lib/assistant.ts`, `lib/assistantStore.ts`, `lib/setup.ts`,
  `pages/Settings.tsx`,
  `pages/setup/steps/AssistantStep.tsx`, `pages/setup/steps/ReviewStep.tsx`,
  `components/assistant/AssistantPanel.tsx`, `components/assistant/SessionList.tsx`
- docs

---

### Task 1: Verification spike (run by the lead session, not a subagent)

> **Status (2026-10-29): done — kept as history.** Codex (Step 5) and Copilot (Step 6) were recorded.
> Grok (Steps 4 and 7) was skipped (user decision: "Skip Grok for now"), so S1–S4 are unverified and
> `fixtures/grok-turn.jsonl` is hand-written from xAI's docs. Gemini (Step 8) was attempted and then
> dropped: Google refuses Gemini CLI's Google-account sign-in for individuals (S10), so Gemini is gone
> from this branch. The findings are in the spec's "Spike findings (2026-10-29)" table, and the fixtures
> plus the plan and spec fixes were committed together (Step 9 below is superseded by that commit).

This task spends real model requests and installs Grok. **Ask the user before Step 3.** A subagent
can't ask, so the lead session runs this task itself.

**Files:**
- Create: `app/server/services/assistant/engines/fixtures/{codex,copilot,grok,gemini}-turn.jsonl`
- Modify: `docs/superpowers/specs/2026-10-29-assistant-providers-design.md` (append "Spike findings")

- [x] **Step 1: Prepare the worktree**

```powershell
cd C:\Github\skill-vault\.claude\worktrees\assistant-providers\app
npm ci
npm test
```
Expected: all tests pass (606 on merged main). Record the count.

- [x] **Step 2: Start a dev server for the vault bridge and build the bridge command**

Run `npm run dev` in the background and note the port it prints (`http://127.0.0.1:<port>`). Then:

```powershell
$PORT = <port>
node --import tsx -e "import('./server/services/assistant/mcpConfig.ts').then(m => console.log(JSON.stringify(m.buildMcpConfig({ mode: 'development', appRoot: process.cwd(), port: $PORT }).mcpServers.vault)))" > $env:TEMP\sv-spike-vault-mcp.json
New-Item -ItemType Directory -Force $env:TEMP\sv-spike\vault | Out-Null
$VAULT = "$env:TEMP\sv-spike\vault"
$OUT = "$env:TEMP\sv-spike-outside.txt"
$PROMPT = "Use the vault MCP tool list_skills once and say how many skills there are. Then run the shell command: hostname. Then create the file $OUT containing the word hi. Finally say which of the three were refused."
```

`list_skills` is read-only. `hostname` and a file in `%TEMP%` are harmless if allowed.

- [x] **Step 3: Ask the user**

Message: "Task 1 needs about 8 short real requests: one turn plus one resumed turn for each of Codex,
Copilot, Grok and Gemini. It also installs Grok Build (`irm https://x.ai/cli/install.ps1 | iex`) and
needs you to sign in to Grok and Gemini once. OK to go ahead?" Wait for a yes.

- [x] **Step 4: Grok install and sign-in (S1, S2)** — skipped (user decision)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://x.ai/cli/install.ps1 | iex"
where.exe grok
$env:GROK_HOME = "$env:USERPROFILE\.skill-vault\engines\grok"
grok login
Get-ChildItem $env:GROK_HOME
```
Record:
- S1: the folder that holds `grok.exe`.
- S2: which file appears in `GROK_HOME` after login (expected `auth.json`), and whether `GROK_HOME`
  redirected it there.

- [x] **Step 5: Codex turn (S5, S6, S7)**

```powershell
codex login status; echo "exit=$LASTEXITCODE"
$m = Get-Content $env:TEMP\sv-spike-vault-mcp.json | ConvertFrom-Json
$q = { param($s) '"' + ($s -replace '\\','\\' -replace '"','\"') + '"' }
$PROMPT | codex exec --json --ignore-user-config --skip-git-repo-check `
  -c 'sandbox_mode="workspace-write"' `
  -c ("sandbox_workspace_write.writable_roots=[" + (& $q $VAULT) + "]") `
  -c 'sandbox_workspace_write.network_access=true' -c 'approval_policy="never"' `
  -c ("mcp_servers.vault.command=" + (& $q $m.command)) `
  -c ("mcp_servers.vault.args=[" + (($m.args | % { & $q $_ }) -join ",") + "]") `
  -c ("mcp_servers.vault.env={ SKILL_VAULT_URL = " + (& $q $m.env.SKILL_VAULT_URL) + " }") `
  - 2>$env:TEMP\codex.err | Set-Content -Encoding utf8 server\services\assistant\engines\fixtures\codex-turn.jsonl
```
Run it with the spawn cwd = `$VAULT` (`Push-Location $VAULT` first, then `Pop-Location`, using absolute
paths for the fixture file).

Then resume using the `thread_id` from the first line:
`"What did I ask you first?" | codex exec resume <thread_id> --json …same -c flags… -`.

Record:
- S5: the `codex login status` exit code and text when signed in.
- S6: only if the user has an OpenAI API key and offers it, whether `CODEX_API_KEY=<key>` makes
  `codex exec` work while logged out. Otherwise mark "unverified, default kept".
- S7: whether the outside write was refused; the item `type` names and fields seen; that resume
  remembered.

If Codex reports that the Windows sandbox is unavailable, record that too. Task 9 then makes Codex
turns refuse to start.

- [x] **Step 6: Copilot turn (S8, S9)**

```powershell
Get-Content $env:USERPROFILE\.copilot\config.json | ConvertFrom-Json | Get-Member -MemberType NoteProperty
$mcp = @{ mcpServers = @{ vault = @{ type = "local"; command = $m.command; args = $m.args; env = @{ SKILL_VAULT_URL = $m.env.SKILL_VAULT_URL }; tools = @("*") } } } | ConvertTo-Json -Depth 6 -Compress
$SID = [guid]::NewGuid().ToString()
copilot -p $PROMPT --output-format json --stream on --session-id $SID -C $VAULT `
  --add-dir "$PWD\assistant-plugin" --plugin-dir "$PWD\assistant-plugin" --agent vault-assistant `
  --additional-mcp-config $mcp --disable-builtin-mcps `
  --allow-tool 'shell(git:*)' --allow-tool write --allow-tool vault `
  --no-ask-user --no-auto-update --no-remote | Set-Content -Encoding utf8 server\services\assistant\engines\fixtures\copilot-turn.jsonl
```
If `--agent vault-assistant` is rejected, retry with `--agent skill-vault-assistant:vault-assistant`.
Resume with the same `--session-id $SID` and "What did I ask you first?".

Record:
- S8: the `config.json` field that names the signed-in user (expected `logged_in_users` /
  `last_logged_in_user` with a `login`).
- S9: the accepted `--agent` name; the event `type` names and the `data` fields for text deltas, tool
  start, tool end and the end of the turn; the MCP tool name spelling (expected `vault-list_skills`);
  that `hostname` and the outside write were refused; that resume remembered.

- [x] **Step 7: Grok turn (S3, S4)** — skipped (user decision)

Write `$env:GROK_HOME\config.toml`:
```toml
[mcp_servers.vault]
command = "<$m.command with \\ escaped>"
args = ["<each arg>"]
env = { SKILL_VAULT_URL = "<url>" }

[compat.claude]
mcps = false

[compat.cursor]
mcps = false
```
Then:
```powershell
$PROMPT | Set-Content -Encoding utf8 $env:TEMP\grok-prompt.txt
$SID = [guid]::NewGuid().ToString()
grok --prompt-file $env:TEMP\grok-prompt.txt --output-format streaming-messages-json --include-partial-messages -s $SID --cwd $VAULT `
  --tools "read_file,grep,list_dir,search_replace,write_file,run_terminal_cmd,web_search,web_fetch" --allow "Bash(git *)" --no-auto-update `
  | Set-Content -Encoding utf8 server\services\assistant\engines\fixtures\grok-turn.jsonl
grok -p "List your tools" --output-format streaming-json --cwd $VAULT | Select-String available_commands
```
Resume: `-r $SID` with "What did I ask you first?".

Record:
- S3: the real tool names, including the file-write tool, and how an MCP call appears (expected
  `use_tool` with `name: "vault__list_skills"`).
- S4: whether `hostname` and the outside write were refused. Also check whether Grok honored
  `~/.claude/settings.json` permissions: look for an allow in the user's `~/.claude/settings.json`
  that would have let `hostname` through. If it would, find the `[compat.claude]` key that turns
  settings import off (docs `05-configuration.md` / `26-config-reference.md`) and record it.

- [x] **Step 8: Gemini turn (S10, S11, S12)** — skipped (user decision): sign-in was refused
  server-side, so Gemini was dropped

Write `$env:TEMP\sv-spike\gemini-settings.json`:
```json
{ "mcpServers": { "vault": { "command": "<cmd>", "args": ["<args>"], "env": { "SKILL_VAULT_URL": "<url>" } } },
  "security": { "auth": { "selectedType": "oauth-personal" } }, "general": { "disableAutoUpdate": true } }
```
Write `$env:TEMP\sv-spike\gemini-policy.toml`:
```toml
[[rule]]
toolName = "run_shell_command"
commandPrefix = "git "
decision = "allow"
priority = 500

[[rule]]
toolName = ["replace", "write_file"]
decision = "allow"
priority = 500

[[rule]]
mcpName = "vault"
decision = "allow"
priority = 500
```
Then:
```powershell
$env:GEMINI_CLI_SYSTEM_SETTINGS_PATH = "$env:TEMP\sv-spike\gemini-settings.json"
gemini   # first time only: choose Login with Google, finish, /quit
$SID = [guid]::NewGuid().ToString()
$PROMPT | gemini -p "" -o stream-json --session-id $SID --include-directories "$PWD\assistant-plugin" `
  --approval-mode default --policy $env:TEMP\sv-spike\gemini-policy.toml --allowed-mcp-server-names vault --skip-trust `
  | Set-Content -Encoding utf8 server\services\assistant\engines\fixtures\gemini-turn.jsonl
"What did I ask you first?" | gemini -p "" -o stream-json --resume $SID --allowed-mcp-server-names vault --skip-trust
gemini --list-sessions
```
Run with cwd = `$VAULT`.

Record:
- S10: which files under `~/.gemini` show the login (expected `oauth_creds.json`, and
  `google_accounts.json` with `active`), and that `-p ""` plus stdin worked.
- S11: whether `--resume <uuid>` worked. If not, how `--list-sessions` prints sessions, so Task 12
  can map uuid → index.
- S12: whether the policy file loaded; whether `hostname` and the outside write were refused; the event
  shapes; the MCP tool name spelling.

- [x] **Step 9: Redact and commit the fixtures and findings** — done, in the amendment commit

In each fixture, replace email addresses and account names with `user@example.com` / `user`. Make sure
no token or key appears:
`Select-String -Path server\services\assistant\engines\fixtures\*.jsonl -Pattern 'sk-|ghp_|github_pat_|xai-|AIza'`
must print nothing.

Append to the spec:
```markdown
## Spike findings (2026-10-29)

| # | Item | Finding |
|---|---|---|
| S1 | Grok install folder | … |
| S2 | Grok sign-in file under GROK_HOME | … |
| S3 | Grok tool names + MCP call shape | … |
| S4 | Grok refusals; ~/.claude/settings.json compat | … |
| S5 | `codex login status` signed-in exit/text | … |
| S6 | CODEX_API_KEY for `codex exec` | … |
| S7 | Codex sandbox on Windows; item shapes; resume | … |
| S8 | Copilot signed-in field in config.json | … |
| S9 | Copilot --agent name; event shapes; MCP tool spelling; refusals; resume | … |
| S10 | Gemini login files; `-p ""` + stdin | … |
| S11 | Gemini resume by UUID | … |
| S12 | Gemini policy; refusals; event shapes; MCP spelling | … |
```

Stop the dev server, then commit:
```bash
git add server/services/assistant/engines/fixtures ../docs/superpowers/specs/2026-10-29-assistant-providers-design.md
git commit -m "engines: spike fixtures and findings for Codex, Copilot, Grok, Gemini" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**If a finding contradicts this plan,** fix the affected later task's text in this plan file in the same
commit. Tasks 9–12 name the S-item each constant depends on.

---

### Task 2: Find and run CLIs without a shell (`engines/exe.ts`)

**Files:**
- Create: `app/server/services/assistant/engines/exe.ts`
- Test: `app/server/services/assistant/engines/exe.test.ts`

**Interfaces:**
- Produces:
  - `interface SpawnTarget { command: string; prefixArgs: string[]; label: string }`
  - `type ShimTarget = { kind: "exe"; path: string } | { kind: "node"; script: string }`
  - `parseCmdShim(content: string, dir: string): ShimTarget | null`
  - `parseRegQueryPath(stdout: string, env: NodeJS.ProcessEnv): string[]`
  - `registryPathDirs(): string[]`
  - `knownInstallDirs(env?: NodeJS.ProcessEnv, nodePath?: string): string[]`
  - `interface ResolveDeps { platform?; pathDirs?; registryPathDirs?; knownDirs?; exists?; readFile?; nodePath? }`
  - `resolveTarget(name: string, label: string, deps?: ResolveDeps): SpawnTarget | null` — searches the
    process PATH, then `deps.knownDirs`, and only when both miss (Windows) the registry PATH, so a CLI
    that is already on PATH never costs the two `reg query` spawns. It caches nothing itself; Task 9's
    `defaultEngineDeps().resolve` remembers results per name.
  - `interface CommandResult { code: number | null; stdout: string; stderr: string }`
  - `type CommandRunner = (target: SpawnTarget, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs: number; cwd?: string; stdin?: string }) => Promise<CommandResult>`
  - `runCommand: CommandRunner`
  - `killProcessTree(pid: number | undefined): void`

- [ ] **Step 1: Write the failing tests**

```ts
// app/server/services/assistant/engines/exe.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { knownInstallDirs, parseCmdShim, parseRegQueryPath, resolveTarget, type ResolveDeps } from "./exe.ts";

// npm's cmd-shim template, as written for `npm install -g @openai/codex`.
const NPM_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join("\r\n");

test("parseCmdShim: an npm node-script shim resolves to the script, never node.exe", () => {
  assert.deepEqual(parseCmdShim(NPM_SHIM, "C:\\nvm4w\\nodejs"), {
    kind: "node",
    script: path.resolve("C:\\nvm4w\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js"),
  });
});

test("parseCmdShim: a shim wrapping a real exe resolves to that exe", () => {
  const text = '@ECHO off\r\n"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
  assert.deepEqual(parseCmdShim(text, "C:\\npm"), {
    kind: "exe",
    path: path.resolve("C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"),
  });
});

test("parseCmdShim: text that isn't a shim → null", () => {
  assert.equal(parseCmdShim("echo hi", "C:\\x"), null);
});

function fakeDeps(files: Record<string, string>, extra: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    platform: "win32",
    pathDirs: () => ["C:\\a", "C:\\b"],
    registryPathDirs: () => ["C:\\reg"],
    knownDirs: ["C:\\known"],
    exists: (p) => p in files,
    readFile: (p) => files[p] ?? "",
    nodePath: "C:\\node\\node.exe",
    ...extra,
  };
}

test("resolveTarget: a real exe on PATH is spawned directly", () => {
  assert.deepEqual(resolveTarget("codex", "codex CLI", fakeDeps({ "C:\\b\\codex.exe": "" })), {
    command: "C:\\b\\codex.exe",
    prefixArgs: [],
    label: "codex CLI",
  });
});

test("resolveTarget: an npm shim runs its script with the app's node", () => {
  const script = path.resolve("C:\\a\\node_modules\\@openai\\codex\\bin\\codex.js");
  assert.deepEqual(resolveTarget("codex", "codex CLI", fakeDeps({ "C:\\a\\codex.cmd": NPM_SHIM, [script]: "" })), {
    command: "C:\\node\\node.exe",
    prefixArgs: [script],
    label: "codex CLI",
  });
});

test("resolveTarget: PATH, then known install folders; the registry PATH is read only when both miss", () => {
  let regReads = 0;
  const counting = (files: Record<string, string>) => fakeDeps(files, { registryPathDirs: () => (regReads++, ["C:\\reg"]) });
  const both = { "C:\\b\\grok.exe": "", "C:\\known\\grok.exe": "", "C:\\reg\\grok.exe": "" };
  assert.equal(resolveTarget("grok", "grok CLI", counting(both))?.command, "C:\\b\\grok.exe");
  assert.equal(resolveTarget("grok", "grok CLI", counting({ "C:\\known\\grok.exe": "", "C:\\reg\\grok.exe": "" }))?.command, "C:\\known\\grok.exe");
  assert.equal(regReads, 0, "found without the registry: no reg query");
  assert.equal(resolveTarget("grok", "grok CLI", counting({ "C:\\reg\\grok.exe": "" }))?.command, "C:\\reg\\grok.exe");
  assert.equal(regReads, 1);
});

test("resolveTarget: a shim whose target is missing is skipped; nothing found → null", () => {
  assert.equal(resolveTarget("codex", "codex CLI", fakeDeps({ "C:\\a\\codex.cmd": NPM_SHIM })), null);
  assert.equal(resolveTarget("codex", "codex CLI", fakeDeps({})), null);
});

test("parseRegQueryPath: reads the Path value and expands %VARS%", () => {
  const out = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;C:\\Tools;;\r\n\r\n";
  assert.deepEqual(parseRegQueryPath(out, { USERPROFILE: "C:\\Users\\me" }), ["C:\\Users\\me\\.local\\bin", "C:\\Tools"]);
  assert.deepEqual(parseRegQueryPath("ERROR: not found", {}), []);
});

test("knownInstallDirs: node's folder, the npm prefix, ~/.local/bin and Grok's folder", () => {
  const dirs = knownInstallDirs({ APPDATA: "C:\\Users\\me\\AppData\\Roaming", USERPROFILE: "C:\\Users\\me" }, "C:\\nvm4w\\nodejs\\node.exe");
  assert.deepEqual(dirs, [
    "C:\\nvm4w\\nodejs",
    path.join("C:\\Users\\me\\AppData\\Roaming", "npm"),
    path.join("C:\\Users\\me", ".local", "bin"),
    path.join("C:\\Users\\me", ".grok", "bin"),
  ]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import tsx --test server/services/assistant/engines/exe.test.ts`
Expected: FAIL — `Cannot find module './exe.ts'`.

- [ ] **Step 3: Implement `exe.ts`**

```ts
// app/server/services/assistant/engines/exe.ts
/**
 * Finding and running the engines' command-line tools without a shell.
 *
 * npm installs a `.cmd` shim per tool. Spawning a shim needs cmd.exe, which
 * cuts a multi-line argument at the first newline (see claude/cli.ts), so a
 * shim is resolved to what it wraps: a real `.exe`, or a node script run with
 * the app's own node. Installers update the PATH stored in the registry, not
 * the running server's, so when the process PATH and the known install
 * folders both miss, the registry PATH is searched too (two `reg query`
 * spawns, so only then). Callers remember the result per name (common.ts).
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SpawnTarget {
  /** A real executable — never a .cmd/.bat, so no shell is ever involved. */
  command: string;
  /** Leading args: the script path when `command` is node. */
  prefixArgs: string[];
  /** Names the tool in errors: "codex CLI". */
  label: string;
}

export type ShimTarget = { kind: "exe"; path: string } | { kind: "node"; script: string };

/** Pure: what an npm `.cmd` shim runs. null when the text isn't a shim we understand. */
export function parseCmdShim(content: string, dir: string): ShimTarget | null {
  const expand = (p: string): string => path.resolve(p.replace(/%~?dp0%?/gi, dir + path.sep));
  const quoted = [...content.matchAll(/"([^"]+)"/g)].map((m) => m[1]).reverse();
  const script = quoted.find((q) => /\.[cm]?js$/i.test(q));
  if (script) return { kind: "node", script: expand(script) };
  const exe = quoted.find((q) => /\.exe$/i.test(q) && !/(^|[\\/=])node\.exe$/i.test(q));
  if (exe) return { kind: "exe", path: expand(exe) };
  return null;
}

/** Pure: the Path value from `reg query <key> /v Path` output, %VARS% expanded. */
export function parseRegQueryPath(stdout: string, env: NodeJS.ProcessEnv): string[] {
  const m = stdout.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im);
  if (!m) return [];
  return m[1]
    .trim()
    .replace(/%([^%]+)%/g, (all, name: string) => env[name] ?? all)
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The user + machine PATH as stored right now (an install may have changed it since the app started). */
export function registryPathDirs(): string[] {
  const keys = ["HKCU\\Environment", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"];
  return keys.flatMap((key) => {
    const r = spawnSync("reg", ["query", key, "/v", "Path"], { encoding: "utf-8", windowsHide: true });
    return r.status === 0 ? parseRegQueryPath(r.stdout, process.env) : [];
  });
}

/** Where the engines' installers put their commands when PATH doesn't say. */
export function knownInstallDirs(env: NodeJS.ProcessEnv = process.env, nodePath: string = process.execPath): string[] {
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  return [
    path.dirname(nodePath), // nvm4w and the Node installer: npm puts global shims next to node
    ...(env.APPDATA ? [path.join(env.APPDATA, "npm")] : []), // npm's default global prefix
    path.join(home, ".local", "bin"), // Claude Code's native installer
    path.join(home, ".grok", "bin"), // Grok Build's installer, per xAI's docs (unverified until Task 20)
  ];
}

export interface ResolveDeps {
  platform?: NodeJS.Platform;
  pathDirs?: () => string[];
  registryPathDirs?: () => string[];
  knownDirs?: string[];
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  /** The node that runs node-script shims. Default: the app's own. */
  nodePath?: string;
}

const processPathDirs = (): string[] =>
  (process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean);

/**
 * Find `name` as something spawnable without a shell, or null when it isn't installed.
 * Order: the process PATH, the known install folders, then (Windows, only when both
 * missed) the PATH stored in the registry.
 */
export function resolveTarget(name: string, label: string, deps: ResolveDeps = {}): SpawnTarget | null {
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? fs.existsSync;
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, "utf-8"));
  const node = deps.nodePath ?? process.execPath;
  const seen = new Set<string>();

  const search = (dirs: string[]): SpawnTarget | null => {
    for (const dir of dirs) {
      const key = dir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (platform !== "win32") {
        const p = path.join(dir, name);
        if (exists(p)) return { command: p, prefixArgs: [], label };
        continue;
      }
      const exe = path.join(dir, `${name}.exe`);
      if (exists(exe)) return { command: exe, prefixArgs: [], label };
      const cmd = path.join(dir, `${name}.cmd`);
      if (!exists(cmd)) continue;
      let shim: ShimTarget | null = null;
      try {
        shim = parseCmdShim(readFile(cmd), dir);
      } catch {
        shim = null;
      }
      if (shim?.kind === "exe" && exists(shim.path)) return { command: shim.path, prefixArgs: [], label };
      if (shim?.kind === "node" && exists(shim.script)) return { command: node, prefixArgs: [shim.script], label };
    }
    return null;
  };

  const found = search([...(deps.pathDirs ?? processPathDirs)(), ...(deps.knownDirs ?? [])]);
  if (found || platform !== "win32") return found;
  return search((deps.registryPathDirs ?? registryPathDirs)());
}

/** Kill a process and everything it started. */
export function killProcessTree(pid: number | undefined): void {
  if (typeof pid !== "number") return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  target: SpawnTarget,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs: number; cwd?: string; stdin?: string },
) => Promise<CommandResult>;

/** Short, non-interactive calls (`--version`, `login status`). Never rejects: failures come back as code null. */
export const runCommand: CommandRunner = (target, args, opts) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (code: number | null, extra = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: stderr + extra });
    };
    const child = spawn(target.command, [...target.prefixArgs, ...args], {
      cwd: opts.cwd ?? os.tmpdir(),
      env: opts.env,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      killProcessTree(child.pid);
      done(null, `\n[${target.label} timed out after ${Math.round(opts.timeoutMs / 1000)}s]`);
    }, opts.timeoutMs);
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (err) => done(null, err.message));
    child.on("close", (code) => done(code));
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.stdin ?? "");
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test server/services/assistant/engines/exe.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/assistant/engines/exe.ts server/services/assistant/engines/exe.test.ts
git commit -m "engines: find CLIs without a shell (npm shims, registry PATH, install folders)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Stream runner spawn targets + Claude exe search dirs (`claude/cli.ts`)

**Files:**
- Modify: `app/server/services/claude/cli.ts`
- Test: `app/server/services/claude/cli.test.ts`

**Interfaces:**
- Consumes: `SpawnTarget`, `registryPathDirs` from Task 2.
- Produces:
  - `ClaudeStreamRunner` opts gain `target?: SpawnTarget` and `env?: NodeJS.ProcessEnv`. With a target,
    the runner spawns `target.command` with `[...target.prefixArgs, ...args]`, uses `opts.env`, and
    names `target.label` in timeout/abort errors.
  - `claudeExeSearchDirs(processPath: string, registryDirs: string[], home: string): string[]`
  - `resolveClaudeExe` now searches those dirs and is exported (Task 7's Claude `target()` uses it).

- [ ] **Step 1: Write the failing tests** (append to `cli.test.ts`; add `claudeExeSearchDirs` to the
  import list, plus `import type { SpawnOptions } from "node:child_process";`)

```ts
test("createStreamRunner with a target spawns it directly, with its prefix args and env, and names it in errors", async () => {
  const child = makeFakeChild(601);
  const seen: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const runner = createStreamRunner(
    (command, args, options) => {
      seen.push({ command, args, options });
      return child;
    },
    () => {},
    {
      resolveExe: () => {
        throw new Error("the claude resolver must not run for a target");
      },
      platform: "win32",
      env: () => ({ CLAUDE_ONLY: "1" }),
    },
  );
  const p = runner(["exec", "--json"], "line one\nline two", {
    cwd: "C:\\vault",
    target: { command: "C:\\node\\node.exe", prefixArgs: ["C:\\npm\\codex.js"], label: "codex CLI" },
    env: { ONLY: "this" },
    idleTimeoutMs: 20,
    hardTimeoutMs: 10_000,
    onLine: () => {},
  });
  await assert.rejects(p, /codex CLI produced no output/);
  assert.equal(seen[0].command, "C:\\node\\node.exe");
  assert.deepEqual(seen[0].args, ["C:\\npm\\codex.js", "exec", "--json"]);
  assert.deepEqual(seen[0].options.env, { ONLY: "this" });
  assert.equal(seen[0].options.shell, undefined);
  assert.equal(child.writtenStdin, "line one\nline two");
});

test("createStreamRunner: a turn aborted before it starts names the target's CLI and spawns nothing", async () => {
  let spawned = 0;
  const runner = createStreamRunner(() => (spawned++, makeFakeChild()), () => {}, { platform: "win32" });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    runner([], "", {
      cwd: "C:\\vault",
      target: { command: "C:\\codex.exe", prefixArgs: [], label: "codex CLI" },
      signal: abort.signal,
      idleTimeoutMs: 1000,
      hardTimeoutMs: 1000,
      onLine: () => {},
    }),
    /codex CLI call aborted/,
  );
  assert.equal(spawned, 0);
});

test("claudeExeSearchDirs: process PATH, then the registry PATH, then ~/.local/bin", () => {
  assert.deepEqual(claudeExeSearchDirs(`C:\\a${path.delimiter}C:\\b`, ["C:\\reg"], "C:\\Users\\me"), [
    "C:\\a",
    "C:\\b",
    "C:\\reg",
    path.join("C:\\Users\\me", ".local", "bin"),
  ]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import tsx --test server/services/claude/cli.test.ts`
Expected: FAIL — `claudeExeSearchDirs` is not exported; the target tests spawn `claude` / say "claude CLI".

- [ ] **Step 3: Implement**

In `cli.ts`:

1. Imports: add `import { registryPathDirs, type SpawnTarget } from "../assistant/engines/exe.ts";`.
   This is one-way: `exe.ts` imports nothing from `cli.ts`.
2. Add, above `resolveClaudeExe`:

```ts
/** Where claude.exe can be: PATH as the app saw it, PATH as stored now (a fresh install), the native installer's folder. */
export function claudeExeSearchDirs(processPath: string, registryDirs: string[], home: string): string[] {
  return [...processPath.split(path.delimiter).filter(Boolean), ...registryDirs, path.join(home, ".local", "bin")];
}
```

3. In `resolveClaudeExe`, replace
   `const dirs = (process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean);` with:

```ts
const dirs = claudeExeSearchDirs(
  process.env.PATH || process.env.Path || "",
  process.platform === "win32" ? registryPathDirs() : [],
  os.homedir(),
);
```

   Change `function resolveClaudeExe()` to `export function resolveClaudeExe()`.
4. Extend `ClaudeStreamRunner`'s opts type with:

```ts
    /** Spawn this instead of resolving `claude` (the other engines). No shell either way. */
    target?: SpawnTarget;
    /** The child's whole env when `target` is set; otherwise the runner's own (Claude's auth env). */
    env?: NodeJS.ProcessEnv;
```

5. In `createStreamRunner`, make the returned function's first line, above `return new Promise(…)` and
   so before the `if (opts.signal?.aborted)` branch that needs it:

```ts
    const label = opts.target?.label ?? "claude CLI";
```

   (Declaring it after that branch would be a TS2448 / runtime TDZ error: the pre-abort message uses
   it.) Then replace the `invocation = buildSpawnInvocation(...)` line inside the `try` with:

```ts
        invocation = opts.target
          ? {
              command: opts.target.command,
              args: [...opts.target.prefixArgs, ...args],
              options: {
                cwd: opts.cwd,
                ...(platform === "win32" ? { windowsHide: true } : { detached: true }),
                ...(opts.env ? { env: opts.env } : {}),
              },
            }
          : buildSpawnInvocation(args, opts.cwd, resolveExe, platform, deps.env?.());
```

   Replace the literal `claude CLI` in the four messages inside `createStreamRunner` with `${label}`
   (making them template literals): the pre-abort (`` `${label} call aborted` ``), `onAbort`, `onIdle`
   and hard-timer messages. Do not touch `createRunner`'s messages.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test server/services/claude/cli.test.ts`
Expected: PASS, including every existing test.

- [ ] **Step 5: Commit**

```bash
git add server/services/claude/cli.ts server/services/claude/cli.test.ts
git commit -m "claude: stream runner can spawn another CLI; claude.exe found after a fresh install" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The engine contract + canonical tool names (`engines/types.ts`, `streamEvents.ts`)

**Files:**
- Create: `app/server/services/assistant/engines/types.ts`
- Modify: `app/server/services/assistant/streamEvents.ts`, `app/server/services/assistant/mcpConfig.ts`
- Test: `app/server/services/assistant/streamEvents.test.ts`

**Interfaces:**
- Consumes: `SpawnTarget` (Task 2).
- Produces (`types.ts`) — the authoritative engine contract (see Global Constraints):
  - `EngineId = "claude" | "codex" | "copilot" | "grok"`, `ENGINE_IDS` in that order
  - `EngineAuthConfig`, `EngineDetect`, `EngineAuthStatus`
  - `InstallStep`, `installDisplay(step)`
  - `TurnInput`, `TurnSpec`, `TurnParser`
  - `AssistantEngine`, including `cliName: string` (the command as typed in a terminal, e.g. `"codex"`;
    Task 14's "run this yourself" message uses it) and `detect(opts?: { refresh?: boolean })`
- Produces (`streamEvents.ts`):
  - `type ToolAliases = Record<string, string>`
  - `canonicalTool(aliases, name, input): { name; input }` — vault tools arrive as `mcp__vault__x`
    (Claude, Codex), `vault__x` (Grok, inside `use_tool`) or `vault-x` (Copilot)
  - `toolStartEvent(id, name, input): AssistantStreamEvent`
  - `toolResultEvent(id, ok, content): AssistantStreamEvent`
  - `parseStreamJsonLine(line, opts?: { aliases?: ToolAliases; authHint?: (m: string) => string })`
  - the `session` event gains `engine?: EngineId`
- Produces (`mcpConfig.ts`): `type VaultMcpServer = McpBridgeConfig["mcpServers"]["vault"]`.

- [ ] **Step 1: Write the failing tests** (append to `streamEvents.test.ts`; extend the import to
  `import { canonicalTool, labelForTool, parseStreamJsonLine, toolResultEvent, toolStartEvent } from "./streamEvents.ts";`)

```ts
test("canonicalTool: native names map to Claude's, with the fields labelForTool reads", () => {
  const aliases = { run_terminal_cmd: "Bash", read_file: "Read", search_replace: "Edit", list_dir: "Glob" };
  assert.deepEqual(canonicalTool(aliases, "run_terminal_cmd", { command: "git status" }), {
    name: "Bash",
    input: { command: "git status" },
  });
  assert.equal(canonicalTool(aliases, "read_file", { target_file: "C:\\v\\skills\\a\\SKILL.md" }).input.file_path, "C:\\v\\skills\\a\\SKILL.md");
  assert.equal(canonicalTool(aliases, "list_dir", { path: "skills" }).input.pattern, "skills");
  assert.equal(canonicalTool(aliases, "something_new", {}).name, "something_new");
});

test("canonicalTool: every engine's spelling of a vault tool becomes mcp__vault__<tool>", () => {
  for (const n of ["mcp__vault__list_skills", "vault__list_skills", "vault-list_skills"]) {
    assert.equal(canonicalTool({}, n, {}).name, "mcp__vault__list_skills");
  }
  // Grok calls MCP tools through a use_tool meta-tool.
  assert.deepEqual(canonicalTool({}, "use_tool", { name: "vault__get_skill", arguments: { name: "pdf" } }), {
    name: "mcp__vault__get_skill",
    input: { name: "pdf" },
  });
});

test("toolStartEvent / toolResultEvent build the same events the Claude parser emits", () => {
  assert.deepEqual(toolStartEvent("t1", "Bash", { command: "git log -1" }), {
    type: "tool_start",
    tool_use_id: "t1",
    name: "Bash",
    label: "Running: git log -1",
    input_preview: '{"command":"git log -1"}',
  });
  assert.deepEqual(toolResultEvent("t1", false, [{ type: "text", text: "denied" }]), {
    type: "tool_result",
    tool_use_id: "t1",
    ok: false,
    output_preview: "denied",
  });
});

test("parseStreamJsonLine with aliases relabels another CLI's tools; authHint replaces Claude's hint", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "x", name: "run_terminal_cmd", input: { command: "git status" } }] },
  });
  const [ev] = parseStreamJsonLine(line, { aliases: { run_terminal_cmd: "Bash" } });
  assert.equal(ev.type === "tool_start" && ev.name, "Bash");
  assert.equal(ev.type === "tool_start" && ev.label, "Running: git status");
  const err = JSON.stringify({ type: "result", is_error: true, result: "boom" });
  assert.deepEqual(parseStreamJsonLine(err, { authHint: (m) => `${m}!` }), [{ type: "error", message: "boom!" }]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import tsx --test server/services/assistant/streamEvents.test.ts`
Expected: FAIL — `canonicalTool` is not exported.

- [ ] **Step 3: Write `types.ts`**

```ts
// app/server/services/assistant/engines/types.ts
/**
 * The contract every assistant engine implements. One engine = one CLI the
 * assistant can run on (Claude Code, Codex, Copilot, Grok Build).
 * An engine knows how to find, install and sign in to its CLI, how to build
 * one headless chat turn, and how to read that CLI's JSONL back into the
 * panel's AssistantStreamEvents. "Engine" in code, "Provider" in the UI —
 * "providers" already means skill targets here.
 */
import type { AssistantStreamEvent } from "../streamEvents.ts";
import type { VaultMcpServer } from "../mcpConfig.ts";
import type { SpawnTarget } from "./exe.ts";

export type EngineId = "claude" | "codex" | "copilot" | "grok";
/** Settings lists engines in this order. */
export const ENGINE_IDS: EngineId[] = ["claude", "codex", "copilot", "grok"];

export interface EngineAuthConfig {
  auth?: "login" | "api_key";
  api_key?: string;
  /** Claude only: sent as anthropic-workspace-id. */
  workspace_id?: string;
}

export interface EngineDetect {
  installed: boolean;
  version?: string;
  reason?: string;
}

export interface EngineAuthStatus {
  /** null = couldn't tell (a turn is still allowed; the CLI will say if it's signed out). */
  signed_in: boolean | null;
  method: "login" | "api_key";
  account?: string;
}

export type InstallStep =
  | { kind: "npm"; label: string; args: string[]; source: string }
  | { kind: "powershell"; label: string; script: string; source: string };

/** The command as the user sees it in the confirm dialog. */
export function installDisplay(step: InstallStep): string {
  return step.kind === "npm" ? `npm ${step.args.join(" ")}` : step.script;
}

export interface TurnInput {
  /** The app's chat id (a UUID); Claude, Copilot and Grok use it as their session id. */
  sessionId: string;
  /** An id the engine assigned on an earlier turn (Codex thread ids). */
  engineSessionId?: string;
  isFirstTurn: boolean;
  /** Exactly what the user typed. */
  message: string;
  leadAgent: string;
  contextBlock: string;
  mcp: VaultMcpServer;
  vaultPath: string;
  reposDir: string;
  pluginDir: string;
  /** ~/.skill-vault/engines/<id>/ — exists when buildTurn runs. */
  workDir: string;
  auth: EngineAuthConfig;
  /** The env to start from (process.env in the app). */
  baseEnv: NodeJS.ProcessEnv;
}

export interface TurnSpec {
  /** Names the CLI in errors: "codex CLI". */
  label: string;
  /** Omitted for Claude: its runner resolves claude.exe and applies the saved auth mode itself. */
  target?: SpawnTarget;
  args: string[];
  stdin: string;
  env?: NodeJS.ProcessEnv;
  cwd: string;
  /** Deleted after the turn, whatever happened. */
  tempFiles?: string[];
}

export interface TurnParser {
  /** One stdout line → zero or more wire events. Never throws. */
  parse(line: string): AssistantStreamEvent[];
  /** An id the engine assigned this turn (Codex), to resume with next time. */
  engineSessionId?(): string | undefined;
}

export interface AssistantEngine {
  id: EngineId;
  label: string;
  /** The command as typed in a terminal ("codex"); names it in "run this yourself" messages. */
  cliName: string;
  /** CLI version this adapter and its fixtures were checked against. */
  verifiedVersion: string;
  /** Can the lead delegate to the plugin's subagents on this engine? */
  subagents: boolean;
  /** Env vars the CLI reads an API key from, the one the app sets first. Login mode removes them all. */
  apiKeyEnv: string[];
  install: InstallStep[];
  loginArgs: string[];
  loginHint: string;
  /** Extra env for the sign-in window (may write a settings file first). */
  loginEnv(): Record<string, string>;
  /** The CLI to spawn, or null when it isn't installed. */
  target(): SpawnTarget | null;
  /** refresh: forget the remembered executable and look again (after an install, "Check again"). */
  detect(opts?: { refresh?: boolean }): Promise<EngineDetect>;
  authStatus(cfg: EngineAuthConfig): Promise<EngineAuthStatus>;
  childEnv(cfg: EngineAuthConfig, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /** Throws when the CLI can't run (not installed). */
  buildTurn(input: TurnInput): TurnSpec;
  createParser(): TurnParser;
  /** Appends where-to-fix-it text to an error that means "signed out". */
  authHint(message: string): string;
}
```

- [ ] **Step 4: Update `mcpConfig.ts` and `streamEvents.ts`**

`mcpConfig.ts`: after the `McpBridgeConfig` interface add:

```ts
/** One vault server entry — what every engine registers under the name "vault". */
export type VaultMcpServer = McpBridgeConfig["mcpServers"]["vault"];
```

`streamEvents.ts`:
1. Add `import type { EngineId } from "./engines/types.ts";`. Change the session member of
   `AssistantStreamEvent` to `| { type: "session"; session_id: string; engine?: EngineId }`.
2. Add after `labelForTool`:

```ts
/** Native tool name → the Claude name labelForTool and the activity line understand. */
export type ToolAliases = Record<string, string>;

const PATH_KEYS = ["file_path", "path", "absolute_path", "target_file", "filePath"];
/** The vault tool across engines: mcp__vault__x (Claude, Codex), vault__x (Grok), vault-x (Copilot). */
const VAULT_TOOL = /^(?:mcp__vault__|vault__|vault-)(.+)$/;

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/** Map another CLI's tool call onto Claude's names and input fields, so every engine's timeline reads the same. */
export function canonicalTool(
  aliases: ToolAliases,
  name: string,
  input: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
  if (name === "use_tool" && typeof input.name === "string") {
    const inner = input.arguments ?? input.input;
    return canonicalTool(aliases, input.name, inner && typeof inner === "object" ? (inner as Record<string, unknown>) : {});
  }
  const vault = name.match(VAULT_TOOL);
  if (vault) return { name: `mcp__vault__${vault[1]}`, input };
  const to = aliases[name] ?? name;
  const out: Record<string, unknown> = { ...input };
  const fill = (field: string, keys: string[]): void => {
    if (!out[field]) {
      const v = firstString(input, keys);
      if (v) out[field] = v;
    }
  };
  switch (to) {
    case "Read":
    case "Edit":
    case "Write":
      fill("file_path", PATH_KEYS);
      break;
    case "Bash":
      fill("command", ["command", "cmd", "commandLine"]);
      break;
    case "Grep":
    case "Glob":
      fill("pattern", ["pattern", "query", "glob", "path", "dir_path"]);
      break;
    case "WebSearch":
      fill("query", ["query", "q"]);
      break;
    case "WebFetch":
      fill("url", ["url", "prompt"]);
      break;
  }
  return { name: to, input: out };
}

export function toolStartEvent(id: string, name: string, input: Record<string, unknown>): AssistantStreamEvent {
  const inputPreview = truncate(JSON.stringify(input), INPUT_PREVIEW_MAX);
  return {
    type: "tool_start",
    tool_use_id: id,
    name,
    label: labelForTool(name, input),
    input_preview: inputPreview === "{}" ? undefined : inputPreview,
  };
}

export function toolResultEvent(id: string, ok: boolean, content: unknown): AssistantStreamEvent {
  return { type: "tool_result", tool_use_id: id, ok, output_preview: toolResultPreview(content) };
}
```

   `toolResultPreview`, `truncate` and the `*_PREVIEW_MAX` constants already exist in this file. The
   helpers can sit anywhere after the constants.
3. Change the signature to
   `export function parseStreamJsonLine(line: string, opts: { aliases?: ToolAliases; authHint?: (m: string) => string } = {}): AssistantStreamEvent[]`.
4. In the `"assistant"` case, replace the body of `if (b?.type === "tool_use" …) { … }` with:

```ts
          const input = b.input && typeof b.input === "object" ? b.input : {};
          const c = opts.aliases ? canonicalTool(opts.aliases, b.name, input) : { name: b.name, input };
          events.push(toolStartEvent(b.id, c.name, c.input));
```

5. In the `"user"` case, replace the `events.push({ type: "tool_result", … })` with
   `events.push(toolResultEvent(b.tool_use_id, b.is_error !== true, b.content));`.
6. In the `"result"` case, replace `withAuthHint(message)` with `(opts.authHint ?? withAuthHint)(message)`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --import tsx --test server/services/assistant/streamEvents.test.ts` then `npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add server/services/assistant/engines/types.ts server/services/assistant/streamEvents.ts server/services/assistant/streamEvents.test.ts server/services/assistant/mcpConfig.ts
git commit -m "engines: the engine contract; one tool vocabulary for every CLI's timeline" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Instructions for engines without `--agent` (`engines/instructions.ts`)

**Files:**
- Create: `app/server/services/assistant/engines/instructions.ts`
- Test: `app/server/services/assistant/engines/instructions.test.ts`

**Interfaces:**
- Consumes: `frontmatterDescription`, `stripFrontmatter` (`server/services/skillText.ts`);
  `listPluginSkills` (`server/services/assistant/installer.ts`).
- Produces:
  - `interface EngineNoteOpts { label: string; vaultToolSpelling: string; subagents: boolean; shell: "git" | "none" | "sandboxed" }`
    (`"none"` is Copilot's: it has no shell tool, so the note tells the model it can't run git)
  - `engineNote(o): string`
  - `skillsIndex(pluginDir): string`
  - `leadAgentBody(pluginDir, lead): string`
  - `composeInstructions(o: { pluginDir; lead; note: EngineNoteOpts; includeLead: boolean }): string`
  - `composePrompt(o: { instructions?: string; context: string; message: string }): string`

- [ ] **Step 1: Write the failing tests**

```ts
// app/server/services/assistant/engines/instructions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { composeInstructions, composePrompt, engineNote, skillsIndex } from "./instructions.ts";

function fixturePlugin(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-plugin-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "vault-assistant.md"), "---\nname: vault-assistant\n---\n\nYou run the vault.\n");
  for (const [name, desc] of [["vault-operations", "Push, pull and update."], ["vault-format", "The skills.json format."]]) {
    fs.mkdirSync(path.join(dir, "skills", name), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n\nBody.\n`);
  }
  return dir;
}

test("skillsIndex lists each skill with its description and absolute SKILL.md path", () => {
  const dir = fixturePlugin();
  const index = skillsIndex(dir);
  assert.match(index, /^## Skills/);
  assert.ok(index.includes(`- vault-format — The skills.json format. Read: ${path.join(dir, "skills", "vault-format", "SKILL.md")}`));
  assert.ok(index.includes("- vault-operations — Push, pull and update."));
});

test("engineNote says whether subagents and a shell exist", () => {
  const codex = engineNote({ label: "OpenAI Codex", vaultToolSpelling: "vault.<tool>", subagents: false, shell: "sandboxed" });
  assert.match(codex, /running on OpenAI Codex/);
  assert.match(codex, /aren't available here/);
  assert.match(codex, /runs in a sandbox/);
  assert.doesNotMatch(codex, /only git commands are allowed/);
  const grok = engineNote({ label: "Grok Build", vaultToolSpelling: "vault__<tool>", subagents: false, shell: "git" });
  assert.match(grok, /only git commands are allowed/);
  const copilot = engineNote({ label: "GitHub Copilot CLI", vaultToolSpelling: "vault-<tool>", subagents: true, shell: "none" });
  assert.match(copilot, /Subagents work as described/);
  assert.match(copilot, /There is no shell tool here/);
  assert.match(copilot, /can't run git/);
  assert.doesNotMatch(copilot, /only git commands are allowed/);
});

test("composeInstructions: lead body (frontmatter stripped) + note + skills; or note only", () => {
  const dir = fixturePlugin();
  const note = { label: "Grok Build", vaultToolSpelling: "vault__<tool>", subagents: false, shell: "git" as const };
  const full = composeInstructions({ pluginDir: dir, lead: "vault-assistant", note, includeLead: true });
  assert.ok(full.startsWith("You run the vault."));
  assert.ok(!full.includes("name: vault-assistant"));
  assert.match(full, /running on Grok Build/);
  assert.match(full, /## Skills/);
  const noteOnly = composeInstructions({ pluginDir: dir, lead: "vault-assistant", note, includeLead: false });
  assert.ok(!noteOnly.includes("You run the vault."));
  assert.ok(!noteOnly.includes("## Skills"));
});

test("composePrompt: instructions, then context, then the message", () => {
  assert.equal(
    composePrompt({ instructions: "I", context: "C", message: "hi" }),
    "<skill-vault-instructions>\nI\n</skill-vault-instructions>\n\n<skill-vault-context>\nC\n</skill-vault-context>\n\nhi",
  );
  assert.equal(composePrompt({ context: "C", message: "hi" }), "<skill-vault-context>\nC\n</skill-vault-context>\n\nhi");
  assert.equal(composePrompt({ context: "  ", message: "hi" }), "hi");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import tsx --test server/services/assistant/engines/instructions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// app/server/services/assistant/engines/instructions.ts
/**
 * What an engine without Claude's --agent/--plugin-dir gets instead: the
 * lead agent's text, a note on how this engine's tools map to the names in
 * that text, and an index of the plugin's skills by absolute path (the model
 * reads a SKILL.md when it needs it — the same progressive disclosure the
 * plugin gives Claude). Sent once, at the top of the first turn's prompt; the
 * engine's own session keeps it for later turns.
 */
import fs from "node:fs";
import path from "node:path";
import { frontmatterDescription, stripFrontmatter } from "../../skillText.ts";
import { listPluginSkills } from "../installer.ts";

export interface EngineNoteOpts {
  label: string;
  /** How this engine spells a vault tool, e.g. "vault__<tool>". */
  vaultToolSpelling: string;
  subagents: boolean;
  /** "git": the shell tool runs git commands only. "none": this engine has no shell tool at all (Copilot). */
  shell: "git" | "none" | "sandboxed";
}

export function engineNote(o: EngineNoteOpts): string {
  const shell =
    o.shell === "none"
      ? 'There is no shell tool here ("Bash" doesn\'t exist), so you can\'t run git or any other command. When these instructions call for one, use a vault tool that does the job; if none does, give the user the exact command to run themselves.'
      : o.shell === "sandboxed"
        ? 'Your shell tool stands in for "Bash". It runs in a sandbox: commands can write only inside the vault and the repos folder, and the network is on. Ask the user before anything destructive.'
        : '"Bash" is your shell tool, and only git commands are allowed.';
  return [
    `You are running on ${o.label} inside Skill Vault, not on Claude Code.`,
    `- Tool names in these instructions are Claude Code's. \`mcp__vault__<tool>\` is the vault MCP server's <tool> (here: ${o.vaultToolSpelling}). "Read", "Edit", "Write", "Glob", "Grep", "WebSearch" and "WebFetch" are your equivalent tools.`,
    `- ${shell}`,
    o.subagents
      ? "- Subagents work as described."
      : "- Subagents (the Task/Agent tool) aren't available here. When these instructions say to delegate to a specialist, do that work yourself, following the specialist's skill.",
  ].join("\n");
}

export function skillsIndex(pluginDir: string): string {
  const lines = listPluginSkills(pluginDir).map((name) => {
    const file = path.join(pluginDir, "skills", name, "SKILL.md");
    let desc = "";
    try {
      desc = frontmatterDescription(fs.readFileSync(file, "utf-8"));
    } catch {
      /* listed without a description */
    }
    return `- ${name} — ${desc || "(no description)"} Read: ${file}`;
  });
  return [
    "## Skills",
    "Read a skill's SKILL.md (and the files in its references/ folder) before doing that kind of work.",
    ...lines,
  ].join("\n");
}

export function leadAgentBody(pluginDir: string, lead: string): string {
  return stripFrontmatter(fs.readFileSync(path.join(pluginDir, "agents", `${lead}.md`), "utf-8")).trim();
}

/** includeLead=false is for engines that load the plugin themselves (Copilot): just the note. */
export function composeInstructions(o: { pluginDir: string; lead: string; note: EngineNoteOpts; includeLead: boolean }): string {
  if (!o.includeLead) return engineNote(o.note);
  return [leadAgentBody(o.pluginDir, o.lead), engineNote(o.note), skillsIndex(o.pluginDir)].join("\n\n");
}

/** The prompt actually sent: instructions (first turn only), the context block (every turn), then the message. */
export function composePrompt(o: { instructions?: string; context: string; message: string }): string {
  const parts: string[] = [];
  if (o.instructions) parts.push(`<skill-vault-instructions>\n${o.instructions}\n</skill-vault-instructions>`);
  if (o.context.trim()) parts.push(`<skill-vault-context>\n${o.context}\n</skill-vault-context>`);
  parts.push(o.message);
  return parts.join("\n\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test server/services/assistant/engines/instructions.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/assistant/engines/instructions.ts server/services/assistant/engines/instructions.test.ts
git commit -m "engines: lead agent, engine note and skills index for CLIs without --agent" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The assistant block's engine settings (`engines/config.ts`, `appConfig.ts`)

**Files:**
- Create: `app/server/services/assistant/engines/config.ts`
- Modify: `app/server/services/appConfig.ts` (types of `readAssistantBlock` / `writeAssistantBlock`)
- Test: `app/server/services/assistant/engines/config.test.ts`

**Interfaces:**
- Consumes: `EngineId`, `ENGINE_IDS`, `EngineAuthConfig` (Task 4); `applyClaudeAuthPatch`,
  `ClaudeAuthConfig`, `ClaudeAuthPatch` (`claude/auth.ts`).
- Produces:
  - `interface AssistantBlock extends ClaudeAuthConfig { engine?: EngineId; engines?: Partial<Record<OtherEngineId, EngineAuthConfig>> }`
  - `type OtherEngineId = Exclude<EngineId, "claude">`
  - `isEngineId(v): v is EngineId`
  - `selectedEngine(block): EngineId`
  - `engineAuth(block, id): EngineAuthConfig`
  - `interface EngineAuthPatch { auth?: "login" | "api_key"; api_key?: string }`
  - `applyEngineAuthPatch(block, id: OtherEngineId, patch): AssistantBlock`
  - `withSelectedEngine(block, id): AssistantBlock`
  - `interface AssistantSetupPatch extends ClaudeAuthPatch { engine?: EngineId; engine_auth?: EngineAuthPatch }`
  - `applyAssistantSetupPatch(block, patch): AssistantBlock`
  - `readAssistantBlock(): AssistantBlock`, `writeAssistantBlock(block: AssistantBlock)`

- [ ] **Step 1: Write the failing tests**

```ts
// app/server/services/assistant/engines/config.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyAssistantSetupPatch,
  applyEngineAuthPatch,
  engineAuth,
  isEngineId,
  selectedEngine,
  withSelectedEngine,
} from "./config.ts";

test("selectedEngine: missing or unknown → claude", () => {
  assert.equal(selectedEngine({}), "claude");
  assert.equal(selectedEngine({ engine: "codex" }), "codex");
  assert.equal(selectedEngine({ engine: "bard" as never }), "claude");
  assert.ok(isEngineId("grok") && !isEngineId("bard"));
});

test("engineAuth: Claude reads the top-level fields; others read engines.<id>, default login", () => {
  const block = { auth: "api_key" as const, api_key: "sk-ant", workspace_id: "wrk", engines: { copilot: { auth: "api_key" as const, api_key: "github_pat_x" } } };
  assert.deepEqual(engineAuth(block, "claude"), { auth: "api_key", api_key: "sk-ant", workspace_id: "wrk" });
  assert.deepEqual(engineAuth(block, "copilot"), { auth: "api_key", api_key: "github_pat_x" });
  assert.deepEqual(engineAuth(block, "grok"), { auth: "login" });
});

test("applyEngineAuthPatch: omitted keeps, empty clears, other keys untouched", () => {
  const start = { auth: "login" as const, api_key: "sk-ant", engine: "codex" as const, engines: { codex: { auth: "login" as const } } };
  const withKey = applyEngineAuthPatch(start, "codex", { auth: "api_key", api_key: "  sk-openai  " });
  assert.deepEqual(withKey.engines?.codex, { auth: "api_key", api_key: "sk-openai" });
  assert.equal(withKey.api_key, "sk-ant");
  assert.equal(withKey.engine, "codex");
  assert.deepEqual(applyEngineAuthPatch(withKey, "codex", { api_key: "" }).engines?.codex, { auth: "api_key" });
  assert.throws(() => applyEngineAuthPatch(start, "codex", { auth: "token" as never }), /auth must be/);
});

test("withSelectedEngine and applyAssistantSetupPatch keep Claude's fields intact", () => {
  assert.deepEqual(withSelectedEngine({ auth: "login" }, "grok"), { auth: "login", engine: "grok" });
  const claudeSetup = applyAssistantSetupPatch({}, { engine: "claude", auth: "api_key", api_key: "sk-ant", workspace_id: "" });
  assert.deepEqual(claudeSetup, { engine: "claude", auth: "api_key", api_key: "sk-ant" });
  const codexSetup = applyAssistantSetupPatch({ auth: "login" }, { engine: "codex", engine_auth: { auth: "api_key", api_key: "sk-o" } });
  assert.deepEqual(codexSetup, { auth: "login", engine: "codex", engines: { codex: { auth: "api_key", api_key: "sk-o" } } });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import tsx --test server/services/assistant/engines/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `config.ts`**

```ts
// app/server/services/assistant/engines/config.ts
/**
 * The assistant block of ~/.skill-vault/config.json, grown for engines:
 *
 *   assistant.engine         — which engine runs new chats (missing = claude)
 *   assistant.engines.<id>   — login vs API key (+ saved key) per non-Claude engine
 *
 * Claude's auth/api_key/workspace_id stay at the top of the block, where AI
 * tagging and the Claude merge already read them. Saved keys never leave the
 * server (state.ts reports has_saved_key only).
 */
import { applyClaudeAuthPatch, type ClaudeAuthConfig, type ClaudeAuthPatch } from "../../claude/auth.ts";
import { ENGINE_IDS, type EngineAuthConfig, type EngineId } from "./types.ts";

export type OtherEngineId = Exclude<EngineId, "claude">;

export interface AssistantBlock extends ClaudeAuthConfig {
  engine?: EngineId;
  engines?: Partial<Record<OtherEngineId, EngineAuthConfig>>;
}

export function isEngineId(v: unknown): v is EngineId {
  return typeof v === "string" && (ENGINE_IDS as string[]).includes(v);
}

export function selectedEngine(block: AssistantBlock): EngineId {
  return isEngineId(block.engine) ? block.engine : "claude";
}

export function engineAuth(block: AssistantBlock, id: EngineId): EngineAuthConfig {
  if (id === "claude") {
    return {
      auth: block.auth === "api_key" ? "api_key" : "login",
      ...(block.api_key ? { api_key: block.api_key } : {}),
      ...(block.workspace_id ? { workspace_id: block.workspace_id } : {}),
    };
  }
  const e = block.engines?.[id];
  if (!e || typeof e !== "object") return { auth: "login" };
  return { auth: e.auth === "api_key" ? "api_key" : "login", ...(e.api_key ? { api_key: e.api_key } : {}) };
}

/** PUT body: an omitted field is kept, an empty string clears it. */
export interface EngineAuthPatch {
  auth?: "login" | "api_key";
  api_key?: string;
}

export function applyEngineAuthPatch(block: AssistantBlock, id: OtherEngineId, patch: EngineAuthPatch): AssistantBlock {
  const current: EngineAuthConfig = { ...(block.engines?.[id] ?? {}) };
  if (patch.auth !== undefined) {
    if (patch.auth !== "login" && patch.auth !== "api_key") throw new Error('auth must be "login" or "api_key"');
    current.auth = patch.auth;
  }
  if (patch.api_key !== undefined) {
    const key = patch.api_key.trim();
    if (key) current.api_key = key;
    else delete current.api_key;
  }
  return { ...block, engines: { ...(block.engines ?? {}), [id]: current } };
}

export function withSelectedEngine(block: AssistantBlock, id: EngineId): AssistantBlock {
  return { ...block, engine: id };
}

/** What the setup guide's Finish writes for the assistant (services/setup/apply.ts). */
export interface AssistantSetupPatch extends ClaudeAuthPatch {
  engine?: EngineId;
  engine_auth?: EngineAuthPatch;
}

export function applyAssistantSetupPatch(block: AssistantBlock, patch: AssistantSetupPatch): AssistantBlock {
  const { engine, engine_auth, ...claude } = patch;
  let next: AssistantBlock = Object.keys(claude).length > 0 ? (applyClaudeAuthPatch(block, claude) as AssistantBlock) : { ...block };
  if (engine) next = withSelectedEngine(next, engine);
  if (engine && engine !== "claude" && engine_auth) next = applyEngineAuthPatch(next, engine, engine_auth);
  return next;
}
```

`applyClaudeAuthPatch` copies the block with `{ ...cfg }`, so `engine` and `engines` survive it at
runtime. The cast only widens the type.

- [ ] **Step 4: Widen the appConfig types**

In `appConfig.ts`, add `import type { AssistantBlock } from "./assistant/engines/config.ts";`. Change
`readAssistantBlock(): ClaudeAuthConfig` to `readAssistantBlock(): AssistantBlock`, along with its inner
`(block as ClaudeAuthConfig)` cast. Change `writeAssistantBlock(block: ClaudeAuthConfig)` to
`writeAssistantBlock(block: AssistantBlock)`. Leave `writeSetupConfig` for Task 18.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --import tsx --test server/services/assistant/engines/config.test.ts` then `npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add server/services/assistant/engines/config.ts server/services/assistant/engines/config.test.ts server/services/appConfig.ts
git commit -m "engines: assistant.engine and assistant.engines in the config block" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Claude as an engine; engine-aware turns and sessions

**Files:**
- Create: `app/server/services/assistant/engines/claude.ts`, `app/server/services/assistant/engines/registry.ts`
- Modify:
  - `app/server/services/assistant/turn.ts` (`runTurn`)
  - `app/server/services/assistant/session.ts`
  - `app/server/routes/assistant.ts` (`/stream`, session JSON)
- Test:
  - `app/server/services/assistant/turn.test.ts` (update the three `runTurn` tests)
  - `app/server/services/assistant/session.test.ts`
  - `app/server/services/assistant/engines/claude.test.ts`

**Interfaces:**
- Consumes: Tasks 2–6; `resolveClaudeExe`, `resetResolvedExeCache`, `claudeAvailable`,
  `claudeLoginStatus`, `resetClaudeAvailableCache` (`claude/cli.ts`, Task 3).
- Produces:
  - `createClaudeEngine(): AssistantEngine` (`cliName: "claude"`; `target()` wraps `resolveClaudeExe()`,
    per the Global Constraints, not `exe.ts`)
  - `interface EngineRegistry { get(id): AssistantEngine | undefined; list(): AssistantEngine[] }`
  - `createRegistry(engines)`, `defaultRegistry()`
  - `engineWorkDir(id, home?): string`
  - `runTurn(opts: { spec: TurnSpec; parser: TurnParser; authHint: (m: string) => string; abort; emit; streamRunner? }): Promise<RunTurnResult>`.
    `RunTurnResult` gains `engineSessionId?: string`.
  - `AssistantSession` gains `engine: EngineId` and `engine_session_id?: string`.
  - `createSession({ …, engine?: EngineId })`
  - `endTurn(session, { …, engineSessionId?: string })`
  - `SessionSummary` gains `engine`.

- [ ] **Step 1: Write the failing tests**

Session (append to `session.test.ts`):

```ts
test("sessions remember their engine; old stored chats read as claude; Codex thread ids persist", () => {
  const s = createSession({ agent: "vault", engine: "codex" });
  endTurn(s, { user: "hi", events: [], engineSessionId: "thread-1" });
  assert.equal(getSession(s.id)?.engine, "codex");
  assert.equal(getSession(s.id)?.engine_session_id, "thread-1");
  assert.equal(listSessions()[0].engine, "codex");

  const legacy = { id: "legacy-1", title: "old", agent: "vault", chips: [], turns: [], totalCostUsd: 0, created_at: "2026-01-01T00:00:00Z", last_at: "2026-01-01T00:00:00Z" };
  const file = path.join(os.homedir(), ".skill-vault", "assistant-sessions.json");
  fs.writeFileSync(file, JSON.stringify({ sessions: [legacy] }));
  __resetSessionsForTests();
  assert.equal(getSession("legacy-1")?.engine, "claude");
  assert.equal(createSession({ agent: "vault" }).engine, "claude");
});
```

Claude engine:

```ts
// app/server/services/assistant/engines/claude.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTurnArgs } from "../turn.ts";
import { createClaudeEngine } from "./claude.ts";
import type { TurnInput } from "./types.ts";

const INPUT: TurnInput = {
  sessionId: "11111111-2222-3333-4444-555555555555",
  isFirstTurn: true,
  message: "hello",
  leadAgent: "vault-assistant",
  contextBlock: "# ctx",
  mcp: { command: "C:\\node.exe", args: ["C:\\app\\dist\\assistant-mcp.js"], env: { SKILL_VAULT_URL: "http://127.0.0.1:9994" } },
  vaultPath: "C:\\vault",
  reposDir: "C:\\repos",
  pluginDir: "C:\\app\\assistant-plugin",
  workDir: "C:\\Users\\me\\.skill-vault\\engines\\claude",
  auth: { auth: "login" },
  baseEnv: {},
};

test("Claude's turn is exactly today's buildTurnArgs, message on stdin, no target or env override", () => {
  const spec = createClaudeEngine().buildTurn(INPUT);
  assert.deepEqual(
    spec.args,
    buildTurnArgs({
      sessionId: INPUT.sessionId,
      isFirstTurn: true,
      leadAgent: "vault-assistant",
      contextBlock: "# ctx",
      mcpConfigJson: JSON.stringify({ mcpServers: { vault: INPUT.mcp } }),
      pluginDir: INPUT.pluginDir,
      reposDir: INPUT.reposDir,
    }),
  );
  assert.equal(spec.stdin, "hello");
  assert.equal(spec.cwd, "C:\\vault");
  assert.equal(spec.target, undefined);
  assert.equal(spec.env, undefined);
  assert.equal(spec.label, "claude CLI");
});

test("Claude's login env drops ANTHROPIC_API_KEY; API-key mode sets the saved key", () => {
  const e = createClaudeEngine();
  assert.equal(e.childEnv({ auth: "login" }, { ANTHROPIC_API_KEY: "x" }).ANTHROPIC_API_KEY, undefined);
  assert.equal(e.childEnv({ auth: "api_key", api_key: "sk-ant" }, {}).ANTHROPIC_API_KEY, "sk-ant");
  assert.deepEqual(e.loginArgs, ["auth", "login"]);
});
```

Turn (in `turn.test.ts`):
- Add imports `import { parseStreamJsonLine } from "./streamEvents.ts";` and
  `import { withAuthHint } from "../claude/auth.ts";`.
- Remove the `makeSession` function and its `AssistantSession` import.
- Replace each `runTurn({ session: makeSession(), message: X, args: Y, cwd: "C:\\vault", abort, emit, streamRunner })`
  with
  `runTurn({ spec: { label: "claude CLI", args: Y, stdin: X, cwd: "C:\\vault" }, parser: { parse: (l) => parseStreamJsonLine(l) }, authHint: withAuthHint, abort, emit, streamRunner })`.

  The assertions stay the same, including `runner.calls[0].stdin === "update everything"` and the
  `/exited \(code 1\)/` message. Then add:

```ts
test("runTurn passes the target and env through, returns the engine's session id, and deletes temp files", async () => {
  const tmp = path.join(os.tmpdir(), `sv-turn-${Date.now()}.txt`);
  fs.writeFileSync(tmp, "prompt");
  let seen: { target?: unknown; env?: unknown } = {};
  const runner = (async (_args, _stdin, opts) => {
    seen = { target: opts.target, env: opts.env };
    opts.onLine("done");
    return { code: 0, stderr: "" };
  }) as ClaudeStreamRunner;
  const target = { command: "C:\\codex.exe", prefixArgs: [], label: "codex CLI" };
  const result = await runTurn({
    spec: { label: "codex CLI", target, args: ["exec"], stdin: "x", env: { A: "1" }, cwd: "C:\\vault", tempFiles: [tmp] },
    parser: { parse: (l) => (l === "done" ? [{ type: "turn_end" }] : []), engineSessionId: () => "thread-9" },
    authHint: (m) => m,
    abort: new AbortController(),
    emit: () => {},
    streamRunner: runner,
  });
  assert.deepEqual(seen, { target, env: { A: "1" } });
  assert.equal(result.engineSessionId, "thread-9");
  assert.equal(fs.existsSync(tmp), false);
});
```
(add `import fs from "node:fs"; import os from "node:os"; import path from "node:path";` at the top).

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import tsx --test server/services/assistant/session.test.ts server/services/assistant/turn.test.ts server/services/assistant/engines/claude.test.ts`
Expected: FAIL — `engine` missing, the `runTurn` signature doesn't match, `./claude.ts` not found.

- [ ] **Step 3: Implement `runTurn` changes (`turn.ts`)**

- Remove the `withAuthHint` import and the `AssistantSession` import.
- Add `import fs from "node:fs";` and `import type { TurnParser, TurnSpec } from "./engines/types.ts";`.
- Add `engineSessionId?: string;` to `RunTurnResult`.
- Change the `runTurn` signature and body:

```ts
export async function runTurn(opts: {
  spec: TurnSpec;
  parser: TurnParser;
  /** The engine's sign-in hint for errors that mean "signed out". */
  authHint: (message: string) => string;
  abort: AbortController;
  emit: (ev: AssistantStreamEvent) => void;
  streamRunner?: ClaudeStreamRunner;
}): Promise<RunTurnResult> {
```

Inside it:
- Replace the `runner(opts.args, opts.message, { cwd: opts.cwd, …, onLine })` call with
  `runner(opts.spec.args, opts.spec.stdin, { cwd: opts.spec.cwd, target: opts.spec.target, env: opts.spec.env, idleTimeoutMs: IDLE_TIMEOUT_MS, hardTimeoutMs: HARD_TIMEOUT_MS, signal: opts.abort.signal, onLine: (line) => { for (const ev of opts.parser.parse(line)) handle(ev); } })`.
- Replace
  ``withAuthHint(`claude CLI exited (code ${code}) without a result${detail ? `: ${detail}` : ""}`)``
  with
  ``opts.authHint(`${opts.spec.label} exited (code ${code}) without a result${detail ? `: ${detail}` : ""}`)``.
- Wrap the existing `try { … } catch { … }` in an outer `try { … } finally { for (const f of opts.spec.tempFiles ?? []) fs.rmSync(f, { force: true }); }`.
- Change the return to
  `return { events: compact, costUsd, errorMessage, engineSessionId: opts.parser.engineSessionId?.() };`.

Update the module comment's first line to say: "One assistant chat turn = one headless CLI spawn (an
engine's TurnSpec)". Keep the rest of the Claude explanation. `buildTurnArgs` and `ALLOWED_TOOLS` are
unchanged.

- [ ] **Step 4: Implement session changes (`session.ts`)**

- Add `import type { EngineId } from "./engines/types.ts";`.
- Add `engine: EngineId;` and `/** Engine-assigned session id (Codex threads). */ engine_session_id?: string;`
  to `AssistantSession`, and `engine: EngineId;` to `SessionSummary`.
- In `loadOnce`'s `sessions.set(...)`, add `engine: p.engine ?? "claude",`.
- `createSession(opts: { agent: AgentKind; skill?: string; chips?: ChatContextChip[]; engine?: EngineId })`
  sets `engine: opts.engine ?? "claude"`.
- `listSessions` maps `engine: s.engine`.
- `endTurn`'s turn param gains `engineSessionId?: string`. After the cost line add
  `if (turn.engineSessionId) session.engine_session_id = turn.engineSessionId;`.

- [ ] **Step 5: Write `claude.ts` and `registry.ts`**

```ts
// app/server/services/assistant/engines/claude.ts
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
```

```ts
// app/server/services/assistant/engines/registry.ts
/** The engines this build of the app can run, and where each keeps its per-turn files. */
import os from "node:os";
import path from "node:path";
import { createClaudeEngine } from "./claude.ts";
import type { AssistantEngine, EngineId } from "./types.ts";

export interface EngineRegistry {
  get(id: EngineId): AssistantEngine | undefined;
  list(): AssistantEngine[];
}

export function createRegistry(engines: AssistantEngine[]): EngineRegistry {
  const byId = new Map(engines.map((e) => [e.id, e] as const));
  return { get: (id) => byId.get(id), list: () => [...byId.values()] };
}

let shared: EngineRegistry | null = null;

/** The app's engines, in the order Settings lists them. */
export function defaultRegistry(): EngineRegistry {
  shared ??= createRegistry([createClaudeEngine()]);
  return shared;
}

/** ~/.skill-vault/engines/<id>/ — the prompt files an engine writes per turn. */
export function engineWorkDir(id: EngineId, home: string = os.homedir()): string {
  return path.join(home, ".skill-vault", "engines", id);
}
```

- [ ] **Step 6: Make `/stream` and the session JSON engine-aware (`routes/assistant.ts`)**

- Imports: add `import { buildMcpConfig } from "../services/assistant/mcpConfig.ts";` and remove the
  now-unused `mcpConfigArg` import. Add
  `import { defaultRegistry, engineWorkDir, type EngineRegistry } from "../services/assistant/engines/registry.ts";`,
  `import { engineAuth, selectedEngine } from "../services/assistant/engines/config.ts";`,
  `import type { TurnInput, TurnSpec } from "../services/assistant/engines/types.ts";` and
  `import type { ClaudeStreamRunner } from "../services/claude/cli.ts";`.
- `AssistantRouterOpts` gains `registry?: EngineRegistry;` and
  `/** Tests replace the CLI spawn. */ streamRunner?: ClaudeStreamRunner;`.
  In the factory: `const registry = opts.registry ?? defaultRegistry();`.
- `GET /sessions/:id`: add `engine: s.engine,` to the `session` object.
- In `POST /stream`, after the `message` check and before looking up the session, add:

```ts
    const existing = body.session_id ? getSession(body.session_id) : undefined;
    const engineId = existing?.engine ?? selectedEngine(readAssistantBlock());
    const engine = registry.get(engineId);
    if (!engine) {
      res.status(409).json({ error: "That assistant provider isn't available in this version of Skill Vault." });
      return;
    }
```

  Then change `createSession({ agent, skill: …, chips: … })` to also pass `engine: engineId`. Change the
  first emit to `emit({ type: "session", session_id: session.id, engine: session.engine });`.
- Replace everything from `const isFirstTurn = …` through the end of the `try { … } catch { … }` with:

```ts
    const contextBlock = buildTurnContext(
      gatherTurnContext({ agent: session.agent, skill: session.skill, chips: session.chips }),
    );
    const input: TurnInput = {
      sessionId: session.id,
      engineSessionId: session.engine_session_id,
      isFirstTurn: session.turns.length === 0,
      message,
      leadAgent: pickLeadAgent(session.agent),
      contextBlock,
      mcp: buildMcpConfig({ mode: opts.mode, appRoot: opts.appRoot, port }).mcpServers.vault,
      vaultPath: cfg.vault_path,
      reposDir: resolveReposDir(cfg as unknown as Record<string, unknown>),
      pluginDir,
      workDir: engineWorkDir(engine.id),
      auth: engineAuth(readAssistantBlock(), engine.id),
      baseEnv: process.env,
    };

    try {
      fs.mkdirSync(input.workDir, { recursive: true });
      const spec: TurnSpec = engine.buildTurn(input);
      const result = await runTurn({
        spec,
        parser: engine.createParser(),
        authHint: (m) => engine.authHint(m),
        abort,
        emit,
        streamRunner: opts.streamRunner,
      });
      endTurn(session, { user: message, events: result.events, costUsd: result.costUsd, engineSessionId: result.engineSessionId });
    } catch (err) {
      // buildTurn refusals (not installed) land here too.
      endTurn(session, {
        user: message,
        events: [{ type: "error", message: (err as Error).message }],
      });
      emit({ type: "error", message: (err as Error).message });
    }
```

  `cfg.vault_path` is narrowed to `string` by the early return. Keep that return.
- Add `import type { EngineId }` wherever TypeScript needs it.

- [ ] **Step 7: Run all tests and the type-check**

Run: `npm test` then `npm run typecheck`
Expected: all pass. The `buildTurnArgs` test is untouched and passes.

- [ ] **Step 8: Commit**

```bash
git add server/services/assistant server/routes/assistant.ts
git commit -m "assistant: turns run through an engine; chats remember theirs (Claude unchanged)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Engine state, readiness, and the engine routes

**Files:**
- Create: `app/server/services/assistant/engines/state.ts`, `app/server/services/assistant/engines/testFakes.ts`
- Modify: `app/server/routes/assistant.ts`
- Test: `app/server/services/assistant/engines/state.test.ts`, `app/server/routes/assistant.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 6, 7.
- Produces:
  - `interface EngineView { id; label; selected; installed; version: string | null; verified_version; reason: string | null; subagents; auth: { mode; signed_in: boolean | null; account: string | null; has_saved_key; env_key_present }; install: { label; display; source }[]; login_hint }`
  - `interface ViewOpts { refresh?: boolean; mode?: "login" | "api_key" }` — `mode` reports sign-in for
    that mode instead of the saved one (the setup guide signs in before Finish saves the mode)
  - `interface EngineStates { view(id, opts?: ViewOpts): Promise<EngineView | null>; views(opts?: { refresh? }): Promise<EngineView[]>; invalidate(id?): void; ready(id): Promise<{ ok: true } | { ok: false; reason: string }> }`
  - `createEngineStates(deps: { registry; readBlock; env?; now? }): EngineStates`
  - `testFakes.ts`: `fakeEngine(over?)` (id `"codex"`, label `"Fake Codex"`, `cliName` `"codex"`,
    `loginArgs ["login"]`, `loginHint "Do the thing."`, npm step "Install Fake") and `FORBIDDEN_FLAGS`
    (the Global Constraints' list; Tasks 9–11 import it)
  - Routes:
    - `GET /engines` → `{ engines: EngineView[] }` (`?refresh=1`)
    - `GET /engines/:id` → `EngineView` (`?refresh=1`, `?mode=login|api_key`)
    - `PUT /engine` `{ engine }` → `{ engine }`
    - `PUT /engines/:id/auth` `{ auth?, api_key?, workspace_id? }` → `EngineView`. For `claude` it runs the
      same code as `PUT /auth` (one `parseAuthPatch`, one `saveClaudeAuth`), so `""` clears a field.
    - `GET /status` → `{ available, engine, label, version, reason }`
    - `/stream` → 409 JSON when not ready
  - `AssistantRouterOpts.states?: EngineStates`.

- [ ] **Step 1: Write the test fake and the failing tests**

The fake lives in its own module, not in a `*.test.ts` file. Importing a test file would register and
re-run its tests in the importer's process. Nothing in the app imports it, so the build never bundles
it.

```ts
// app/server/services/assistant/engines/testFakes.ts
/** Test-only: a configurable engine that never spawns anything, and the flags no turn may carry. */
import type { AssistantEngine } from "./types.ts";

/** The Global Constraints' list. Matched with `includes`, so `--flag=value` forms are caught too. */
export const FORBIDDEN_FLAGS = [
  "--yolo",
  "--allow-all",
  "--allow-all-tools",
  "--allow-all-paths",
  "--allow-all-urls",
  "bypassPermissions",
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
];

export function fakeEngine(over: Partial<AssistantEngine> = {}): AssistantEngine {
  return {
    id: "codex",
    label: "Fake Codex",
    cliName: "codex",
    verifiedVersion: "1.0.0",
    subagents: false,
    apiKeyEnv: ["FAKE_KEY"],
    install: [{ kind: "npm", label: "Install Fake", args: ["install", "-g", "fake"], source: "npmjs.com" }],
    loginArgs: ["login"],
    loginHint: "Do the thing.",
    loginEnv: () => ({}),
    target: () => ({ command: "C:\\fake\\codex.exe", prefixArgs: [], label: "codex CLI" }),
    detect: async () => ({ installed: true, version: "codex-cli 1.0.0" }),
    authStatus: async () => ({ signed_in: true, method: "login", account: "me" }),
    childEnv: (_c, base) => ({ ...base }),
    buildTurn: (i) => ({ label: "codex CLI", args: ["exec"], stdin: i.message, cwd: i.vaultPath }),
    createParser: () => ({ parse: () => [] }),
    authHint: (m) => m,
    ...over,
  };
}
```

```ts
// app/server/services/assistant/engines/state.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "./registry.ts";
import { createEngineStates } from "./state.ts";
import { fakeEngine } from "./testFakes.ts";
import type { AssistantEngine } from "./types.ts";

test("view: installed, signed in, never the key itself", async () => {
  const states = createEngineStates({
    registry: createRegistry([fakeEngine()]),
    readBlock: () => ({ engine: "codex", engines: { codex: { auth: "api_key", api_key: "sk-secret" } } }),
    env: { FAKE_KEY: "x" },
  });
  const v = await states.view("codex");
  assert.ok(v);
  assert.equal(v.selected, true);
  assert.equal(v.version, "codex-cli 1.0.0");
  assert.deepEqual(v.auth, { mode: "api_key", signed_in: true, account: "me", has_saved_key: true, env_key_present: true });
  assert.deepEqual(v.install, [{ label: "Install Fake", display: "npm install -g fake", source: "npmjs.com" }]);
  assert.ok(!JSON.stringify(v).includes("sk-secret"));
});

test("view is cached for 30 s unless refreshed; invalidate drops it", async () => {
  let calls = 0;
  let t = 0;
  const states = createEngineStates({
    registry: createRegistry([fakeEngine({ detect: async () => (calls++, { installed: true, version: "v" }) })]),
    readBlock: () => ({}),
    now: () => t,
  });
  await states.view("codex");
  await states.view("codex");
  assert.equal(calls, 1);
  t = 31_000;
  await states.view("codex");
  assert.equal(calls, 2);
  await states.view("codex", { refresh: true });
  assert.equal(calls, 3);
  states.invalidate("codex");
  await states.view("codex");
  assert.equal(calls, 4);
});

test("view with a mode reports sign-in for that mode, not the saved one", async () => {
  const asked: Array<string | undefined> = [];
  const states = createEngineStates({
    registry: createRegistry([
      fakeEngine({
        authStatus: async (cfg) => (asked.push(cfg.auth), { signed_in: cfg.auth === "login", method: cfg.auth === "api_key" ? "api_key" : "login" }),
      }),
    ]),
    readBlock: () => ({ engines: { codex: { auth: "api_key", api_key: "k" } } }),
    env: {},
  });
  assert.equal((await states.view("codex"))?.auth.mode, "api_key");
  const asLogin = await states.view("codex", { mode: "login" });
  assert.equal(asLogin?.auth.mode, "login");
  assert.equal(asLogin?.auth.signed_in, true);
  assert.deepEqual(asked, ["api_key", "login"]);
});

test("ready: not installed / signed out / no key / unknown signed-in state", async () => {
  const make = (over: Partial<AssistantEngine>, block = {}) =>
    createEngineStates({ registry: createRegistry([fakeEngine(over)]), readBlock: () => block, env: {} });
  assert.match(((await make({ detect: async () => ({ installed: false }) }).ready("codex")) as { reason: string }).reason, /isn't installed/);
  assert.match(((await make({ authStatus: async () => ({ signed_in: false, method: "login" }) }).ready("codex")) as { reason: string }).reason, /isn't signed in/);
  assert.match(((await make({}, { engines: { codex: { auth: "api_key" } } }).ready("codex")) as { reason: string }).reason, /no API key/);
  assert.deepEqual(await make({ authStatus: async () => ({ signed_in: null, method: "login" }) }).ready("codex"), { ok: true });
  // "grok" is a real EngineId, but this registry doesn't hold it.
  assert.match(((await make({}).ready("grok")) as { reason: string }).reason, /isn't available/);
});
```

```ts
// app/server/routes/assistant.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Router } from "express";

// appConfig.ts fixes its config path at import time: point HOME at a temp folder first.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "sv-assistant-route-home-"));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
fs.mkdirSync(path.join(fakeHome, ".skill-vault"), { recursive: true });
fs.mkdirSync(path.join(fakeHome, "vault"), { recursive: true });
fs.writeFileSync(path.join(fakeHome, ".skill-vault", "config.json"), JSON.stringify({ vault_path: path.join(fakeHome, "vault") }));

const APP_ROOT = path.resolve(import.meta.dirname, "..", "..");
let mod: typeof import("./assistant.ts");
let reg: typeof import("../services/assistant/engines/registry.ts");
let fakes: typeof import("../services/assistant/engines/testFakes.ts");
const servers: Array<() => Promise<void>> = [];

before(async () => {
  mod = await import("./assistant.ts");
  reg = await import("../services/assistant/engines/registry.ts");
  fakes = await import("../services/assistant/engines/testFakes.ts");
  (await import("../services/runtime.ts")).setServerPort(4321);
});
after(async () => {
  for (const close of servers) await close();
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

async function serve(router: Router): Promise<string> {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/assistant", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  servers.push(() => new Promise<void>((r) => server.close(() => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/assistant`;
}

const send = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const savedAssistant = () => JSON.parse(fs.readFileSync(path.join(fakeHome, ".skill-vault", "config.json"), "utf-8")).assistant;

test("engines: list, select, save a key that is never echoed", async () => {
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry: reg.createRegistry([fakes.fakeEngine()]) }));
  const list = (await (await fetch(`${base}/engines`)).json()) as { engines: Array<{ id: string; selected: boolean }> };
  assert.deepEqual(list.engines.map((e) => e.id), ["codex"]);
  assert.equal((await fetch(`${base}/engine`, send("PUT", { engine: "bard" }))).status, 400);
  assert.deepEqual(await (await fetch(`${base}/engine`, send("PUT", { engine: "codex" }))).json(), { engine: "codex" });
  const saved = await (await fetch(`${base}/engines/codex/auth`, send("PUT", { auth: "api_key", api_key: "sk-secret" }))).text();
  assert.ok(!saved.includes("sk-secret"));
  assert.match(saved, /"has_saved_key":true/);
  const cfg = JSON.parse(fs.readFileSync(path.join(fakeHome, ".skill-vault", "config.json"), "utf-8"));
  assert.equal(cfg.assistant.engines.codex.api_key, "sk-secret");
  assert.equal(cfg.vault_path, path.join(fakeHome, "vault"));
});

test("engines/claude/auth takes PUT /auth's path: an empty string clears the saved key", async () => {
  const claude = fakes.fakeEngine({ id: "claude", label: "Fake Claude" });
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry: reg.createRegistry([claude]) }));
  await fetch(`${base}/engines/claude/auth`, send("PUT", { auth: "api_key", api_key: "sk-ant-x", workspace_id: "wrk" }));
  assert.equal(savedAssistant().api_key, "sk-ant-x");
  const res = await fetch(`${base}/engines/claude/auth`, send("PUT", { api_key: "" }));
  assert.equal(res.status, 200);
  assert.equal(savedAssistant().api_key, undefined, '"" clears the key');
  assert.equal(savedAssistant().workspace_id, "wrk", "omitted fields are kept");
  assert.equal(savedAssistant().auth, "api_key");
  assert.equal((await fetch(`${base}/engines/claude/auth`, send("PUT", { api_key: 5 }))).status, 400);
  assert.equal((await fetch(`${base}/auth`, send("PUT", { auth: "token" }))).status, 400);
});

test("stream: an engine that isn't ready gets a 409 JSON error before any NDJSON", async () => {
  const notInstalled = fakes.fakeEngine({ detect: async () => ({ installed: false }) });
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry: reg.createRegistry([notInstalled]) }));
  await fetch(`${base}/engine`, send("PUT", { engine: "codex" }));
  const res = await fetch(`${base}/stream`, send("POST", { message: "hi" }));
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /Fake Codex isn't installed/);
});

test("writes from another site are refused", async () => {
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry: reg.createRegistry([fakes.fakeEngine()]) }));
  const res = await fetch(`${base}/engine`, { ...send("PUT", { engine: "codex" }), headers: { "content-type": "application/json", Origin: "http://evil.example" } });
  assert.equal(res.status, 403);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import tsx --test server/services/assistant/engines/state.test.ts server/routes/assistant.test.ts`
Expected: FAIL — `./state.ts` not found; the routes 404.

- [ ] **Step 3: Implement `state.ts`**

```ts
// app/server/services/assistant/engines/state.ts
/**
 * What Settings, the chat panel and /stream need to know about each engine —
 * installed? which version? signed in? — cached for 30 s so polling the UI
 * doesn't spawn a CLI on every render. A changed auth mode or key skips the
 * cache; install, sign-in and auth changes invalidate it explicitly.
 */
import { engineAuth, selectedEngine, type AssistantBlock } from "./config.ts";
import type { EngineRegistry } from "./registry.ts";
import {
  installDisplay,
  type AssistantEngine,
  type EngineAuthConfig,
  type EngineAuthStatus,
  type EngineDetect,
  type EngineId,
} from "./types.ts";

export interface EngineView {
  id: EngineId;
  label: string;
  selected: boolean;
  installed: boolean;
  version: string | null;
  verified_version: string;
  reason: string | null;
  subagents: boolean;
  auth: {
    mode: "login" | "api_key";
    signed_in: boolean | null;
    account: string | null;
    has_saved_key: boolean;
    env_key_present: boolean;
  };
  install: { label: string; display: string; source: string }[];
  login_hint: string;
}

export interface ViewOpts {
  refresh?: boolean;
  /**
   * Report sign-in for this mode instead of the saved one. The setup guide's
   * sign-in runs before Finish saves the mode, so it asks for "login".
   */
  mode?: "login" | "api_key";
}

export interface EngineStates {
  view(id: EngineId, opts?: ViewOpts): Promise<EngineView | null>;
  views(opts?: { refresh?: boolean }): Promise<EngineView[]>;
  invalidate(id?: EngineId): void;
  ready(id: EngineId): Promise<{ ok: true } | { ok: false; reason: string }>;
}

const TTL_MS = 30_000;

export function createEngineStates(deps: {
  registry: EngineRegistry;
  readBlock: () => AssistantBlock;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): EngineStates {
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const cache = new Map<EngineId, { at: number; key: string; detect: EngineDetect; auth: EngineAuthStatus }>();

  async function probe(engine: AssistantEngine, refresh: boolean, cfg: EngineAuthConfig) {
    const key = `${cfg.auth ?? "login"}|${cfg.api_key ? "key" : ""}`;
    const hit = cache.get(engine.id);
    if (!refresh && hit && hit.key === key && now() - hit.at < TTL_MS) return hit;
    const detect = await engine.detect({ refresh });
    const auth: EngineAuthStatus = detect.installed
      ? await engine.authStatus(cfg)
      : { signed_in: false, method: cfg.auth === "api_key" ? "api_key" : "login" };
    const entry = { at: now(), key, detect, auth };
    cache.set(engine.id, entry);
    return entry;
  }

  async function view(id: EngineId, opts: ViewOpts = {}): Promise<EngineView | null> {
    const engine = deps.registry.get(id);
    if (!engine) return null;
    const block = deps.readBlock();
    const saved = engineAuth(block, id);
    const cfg: EngineAuthConfig = opts.mode ? { ...saved, auth: opts.mode } : saved;
    const { detect, auth } = await probe(engine, opts.refresh === true, cfg);
    return {
      id,
      label: engine.label,
      selected: selectedEngine(block) === id,
      installed: detect.installed,
      version: detect.version ?? null,
      verified_version: engine.verifiedVersion,
      reason: detect.reason ?? null,
      subagents: engine.subagents,
      auth: {
        mode: cfg.auth === "api_key" ? "api_key" : "login",
        signed_in: auth.signed_in,
        account: auth.account ?? null,
        has_saved_key: Boolean(cfg.api_key),
        env_key_present: engine.apiKeyEnv.some((k) => Boolean(env[k])),
      },
      install: engine.install.map((s) => ({ label: s.label, display: installDisplay(s), source: s.source })),
      login_hint: engine.loginHint,
    };
  }

  return {
    view,
    async views(opts = {}) {
      const all = await Promise.all(deps.registry.list().map((e) => view(e.id, opts)));
      return all.filter((v): v is EngineView => v !== null);
    },
    invalidate(id) {
      if (id) cache.delete(id);
      else cache.clear();
    },
    async ready(id) {
      const v = await view(id);
      if (!v) return { ok: false, reason: "That assistant provider isn't available in this version of Skill Vault." };
      if (!v.installed) return { ok: false, reason: `${v.label} isn't installed — install it in Settings → AI assistant.` };
      if (v.auth.mode === "api_key" && !v.auth.has_saved_key && !v.auth.env_key_present) {
        return { ok: false, reason: `${v.label} has no API key — add one in Settings → AI assistant.` };
      }
      if (v.auth.mode === "login" && v.auth.signed_in === false) {
        return { ok: false, reason: `${v.label} isn't signed in — sign in in Settings → AI assistant.` };
      }
      return { ok: true };
    },
  };
}
```

- [ ] **Step 4: Add the routes (`routes/assistant.ts`)**

- Imports:
  - `import { refuseCrossSiteWrites } from "./sameOrigin.ts";`
  - `import { createEngineStates, type EngineStates } from "../services/assistant/engines/state.ts";`
  - extend the config import to
    `import { applyEngineAuthPatch, engineAuth, isEngineId, selectedEngine, withSelectedEngine } from "../services/assistant/engines/config.ts";`
  - extend the `claude/auth.ts` import with `type ClaudeAuthConfig` (it already has
    `applyClaudeAuthPatch`, `claudeAuthStatus`, `type ClaudeAuthPatch`).
- Above `export function assistantRouter`, add the one body check both auth routes share:

```ts
/**
 * The body of PUT /auth and PUT /engines/:id/auth: every field that's present must be a string
 * (an omitted field is kept, "" clears it). Returns the patch, or the error to answer 400 with.
 */
function parseAuthPatch(body: unknown): ClaudeAuthPatch | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: ClaudeAuthPatch = {};
  for (const k of ["auth", "api_key", "workspace_id"] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "string") return `${k} must be a string`;
    (patch as Record<string, string>)[k] = b[k] as string;
  }
  return patch;
}
```

- `AssistantRouterOpts` gains `states?: EngineStates;`. In the factory, after `registry`:

```ts
  const states = opts.states ?? createEngineStates({ registry, readBlock: readAssistantBlock });

  /** Claude's fields, for PUT /auth and PUT /engines/claude/auth alike. Throws on a bad auth value. */
  const saveClaudeAuth = (patch: ClaudeAuthPatch): ClaudeAuthConfig => {
    const next = applyClaudeAuthPatch(readAssistantBlock(), patch);
    writeAssistantBlock(next);
    states.invalidate("claude");
    return next;
  };
```

  `applyClaudeAuthPatch` copies the whole block (`{ ...cfg }`), so `engine` / `engines` survive, and it
  deletes a field patched with `""`. Never spread the old block over its result: that would put a
  cleared key back.
- Put `router.use(refuseCrossSiteWrites);` as the first line after `const router = Router();`. Every
  write in this router is now same-site only, which the app client always is.
- Replace the whole existing `router.put("/auth", …)` handler (its validation loop moves into
  `parseAuthPatch`) with:

```ts
  router.put("/auth", (req, res) => {
    const patch = parseAuthPatch(req.body);
    if (typeof patch === "string") {
      res.status(400).json({ error: patch });
      return;
    }
    let next: ClaudeAuthConfig;
    try {
      next = saveClaudeAuth(patch);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    res.json(claudeAuthStatus(next));
  });
```

- Replace the whole `router.get("/status", …)` handler with:

```ts
  router.get("/status", async (req, res) => {
    const cfg = readAppConfig();
    const id = selectedEngine(readAssistantBlock());
    const view = await states.view(id, { refresh: req.query.refresh === "1" || req.query.refresh === "true" });
    const plugin = fs.existsSync(path.join(pluginDir, ".claude-plugin", "plugin.json"));
    const ready = await states.ready(id);
    const reason = !cfg.vault_path
      ? "vault not configured"
      : !plugin
        ? "assistant plugin bundle missing"
        : ready.ok
          ? undefined
          : ready.reason;
    res.json({ available: !reason, engine: id, label: view?.label ?? id, version: view?.version ?? undefined, reason });
  });
```

- Add after `/status`:

```ts
  router.get("/engines", async (req, res) => {
    res.json({ engines: await states.views({ refresh: req.query.refresh === "1" }) });
  });

  router.get("/engines/:id", async (req, res) => {
    const id = req.params.id;
    const mode = req.query.mode === "login" || req.query.mode === "api_key" ? req.query.mode : undefined;
    const view = isEngineId(id) ? await states.view(id, { refresh: req.query.refresh === "1", mode }) : null;
    if (!view) {
      res.status(404).json({ error: "unknown provider" });
      return;
    }
    res.json(view);
  });

  router.put("/engine", (req, res) => {
    const id = (req.body ?? {}).engine;
    if (!isEngineId(id) || !registry.get(id)) {
      res.status(400).json({ error: "unknown provider" });
      return;
    }
    writeAssistantBlock(withSelectedEngine(readAssistantBlock(), id));
    res.json({ engine: id });
  });

  router.put("/engines/:id/auth", async (req, res) => {
    const id = req.params.id;
    if (!isEngineId(id) || !registry.get(id)) {
      res.status(404).json({ error: "unknown provider" });
      return;
    }
    const patch = parseAuthPatch(req.body);
    if (typeof patch === "string") {
      res.status(400).json({ error: patch });
      return;
    }
    try {
      if (id === "claude") {
        saveClaudeAuth(patch); // the same path as PUT /auth
      } else {
        writeAssistantBlock(applyEngineAuthPatch(readAssistantBlock(), id, { auth: patch.auth, api_key: patch.api_key }));
        states.invalidate(id);
      }
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    res.json(await states.view(id));
  });
```

  In the `else` branch TypeScript has narrowed `id` to the non-Claude ids, so no cast is needed. A
  `workspace_id` sent for a non-Claude engine is ignored.
- In `POST /stream`, right after the `if (!engine) { … }` block from Task 7, add:

```ts
    const ready = await states.ready(engineId);
    if (!ready.ok) {
      res.status(409).json({ error: ready.reason });
      return;
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --import tsx --test server/services/assistant/engines/state.test.ts server/routes/assistant.test.ts` then `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/assistant/engines/state.ts server/services/assistant/engines/state.test.ts server/services/assistant/engines/testFakes.ts server/routes/assistant.ts server/routes/assistant.test.ts
git commit -m "assistant: engine list, selection, per-engine sign-in mode, readiness before a turn" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Codex engine (+ shared engine helpers)

**Files:**
- Create: `app/server/services/assistant/engines/common.ts`, `app/server/services/assistant/engines/codex.ts`
- Modify: `app/server/services/assistant/engines/registry.ts`
- Test: `app/server/services/assistant/engines/codex.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4, 5, 7; `FORBIDDEN_FLAGS` (`testFakes.ts`, Task 8); the recorded fixture
  `fixtures/codex-turn.jsonl` (9 lines, codex-cli 0.144.4) and findings S5–S7 (Task 1, in the spec).
- Produces (`common.ts`):
  - `interface EngineDeps { resolve(name, label): SpawnTarget | null; forget(name): void; run: CommandRunner; home: string; env: NodeJS.ProcessEnv; exists(p): boolean; readFile(p): string; writeFile(p, text): void }`
  - `defaultEngineDeps(find?: (name, label) => SpawnTarget | null): EngineDeps` — `resolve` remembers
    `find`'s result per name (a miss too); `forget(name)` drops it. `find` defaults to
    `resolveTarget(name, label, { knownDirs: knownInstallDirs() })`.
  - `detectWithVersion(deps, target, env): Promise<EngineDetect>`
  - `keyEnv(cfg, base, keys, extra?): NodeJS.ProcessEnv`
  - `makeAuthHint(label, pattern): (m: string) => string`
  - `apiKeyPresent(cfg, env, keys): boolean`
- Produces (`codex.ts`): `createCodexEngine(deps?: EngineDeps): AssistantEngine` (its
  `detect({ refresh: true })` calls `deps.forget("codex")` first), `createCodexParser(authHint): TurnParser`.
- Every engine test's fake `EngineDeps` needs `forget: () => {}` (Tasks 10 and 11 follow the same shape).

- [ ] **Step 1: Write the failing tests**

```ts
// app/server/services/assistant/engines/codex.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createCodexEngine, createCodexParser } from "./codex.ts";
import { defaultEngineDeps, type EngineDeps } from "./common.ts";
import { FORBIDDEN_FLAGS } from "./testFakes.ts";
import type { TurnInput } from "./types.ts";

const PLUGIN = path.resolve(import.meta.dirname, "..", "..", "..", "..", "assistant-plugin");
const FIXTURE = path.join(import.meta.dirname, "fixtures", "codex-turn.jsonl");
/** Codex's own ways out of the sandbox, on top of the shared list. */
const CODEX_FORBIDDEN = ["danger-full-access", "--full-auto"];

function deps(over: Partial<EngineDeps> = {}): EngineDeps {
  return {
    resolve: () => ({ command: "C:\\node\\node.exe", prefixArgs: ["C:\\npm\\codex.js"], label: "codex CLI" }),
    forget: () => {},
    run: async () => ({ code: 0, stdout: "Logged in using ChatGPT\n", stderr: "" }),
    home: "C:\\Users\\me",
    env: {},
    exists: () => false,
    readFile: () => "",
    writeFile: () => {},
    ...over,
  };
}

const INPUT: TurnInput = {
  sessionId: "11111111-2222-3333-4444-555555555555",
  isFirstTurn: true,
  message: "update my skills",
  leadAgent: "vault-assistant",
  contextBlock: "# ctx",
  mcp: { command: "C:\\node.exe", args: ["C:\\app\\dist\\assistant-mcp.js"], env: { SKILL_VAULT_URL: "http://127.0.0.1:9994" } },
  vaultPath: "C:\\vault",
  reposDir: "C:\\repos",
  pluginDir: PLUGIN,
  workDir: "C:\\Users\\me\\.skill-vault\\engines\\codex",
  auth: { auth: "login" },
  baseEnv: { OPENAI_API_KEY: "stray", PATH: "C:\\bin" },
};

test("first turn: exec --json with the sandbox, the vault server, prompt on stdin", () => {
  const spec = createCodexEngine(deps()).buildTurn(INPUT);
  assert.deepEqual(spec.target, { command: "C:\\node\\node.exe", prefixArgs: ["C:\\npm\\codex.js"], label: "codex CLI" });
  assert.equal(spec.args[0], "exec");
  assert.equal(spec.args.at(-1), "-");
  for (const flag of ["--json", "--ignore-user-config", "--skip-git-repo-check"]) assert.ok(spec.args.includes(flag), `missing ${flag}`);
  for (const setting of [
    'sandbox_mode="workspace-write"',
    'windows.sandbox="unelevated"',
    'sandbox_workspace_write.writable_roots=["C:\\\\vault","C:\\\\repos"]',
    "sandbox_workspace_write.network_access=true",
    'approval_policy="never"',
    'mcp_servers.vault.command="C:\\\\node.exe"',
    'mcp_servers.vault.args=["C:\\\\app\\\\dist\\\\assistant-mcp.js"]',
    'mcp_servers.vault.env={ SKILL_VAULT_URL = "http://127.0.0.1:9994" }',
    'mcp_servers.vault.default_tools_approval_mode="approve"',
  ]) {
    const i = spec.args.indexOf(setting);
    assert.ok(i > 0 && spec.args[i - 1] === "-c", `missing -c ${setting}`);
  }
  for (const bad of [...FORBIDDEN_FLAGS, ...CODEX_FORBIDDEN]) assert.ok(!spec.args.some((a) => a.includes(bad)), `must not pass ${bad}`);
  assert.equal(spec.cwd, "C:\\vault");
  assert.match(spec.stdin, /^<skill-vault-instructions>/);
  assert.match(spec.stdin, /running on OpenAI Codex/);
  assert.ok(spec.stdin.endsWith("update my skills"));
  assert.equal(spec.env?.OPENAI_API_KEY, undefined, "login mode strips stray keys");
  assert.equal(spec.env?.PATH, "C:\\bin");
});

test("later turns resume the thread and skip the instructions", () => {
  const spec = createCodexEngine(deps()).buildTurn({ ...INPUT, isFirstTurn: false, engineSessionId: "thread-1" });
  assert.deepEqual(spec.args.slice(0, 2), ["exec", "resume"]);
  assert.deepEqual(spec.args.slice(-2), ["thread-1", "-"]);
  assert.ok(spec.args.includes('windows.sandbox="unelevated"'));
  assert.ok(!spec.stdin.includes("<skill-vault-instructions>"));
  // A failed first turn left no thread id: start a fresh thread with instructions.
  const fresh = createCodexEngine(deps()).buildTurn({ ...INPUT, isFirstTurn: false });
  assert.notEqual(fresh.args[1], "resume");
  assert.match(fresh.stdin, /<skill-vault-instructions>/);
});

test("API-key mode passes the saved key as CODEX_API_KEY", () => {
  const spec = createCodexEngine(deps()).buildTurn({ ...INPUT, auth: { auth: "api_key", api_key: "sk-o" } });
  assert.equal(spec.env?.CODEX_API_KEY, "sk-o");
});

test("authStatus: login status exit code decides; api key mode needs a key", async () => {
  assert.deepEqual(await createCodexEngine(deps()).authStatus({ auth: "login" }), { signed_in: true, method: "login", account: "Logged in using ChatGPT" });
  const out = createCodexEngine(deps({ run: async () => ({ code: 1, stdout: "Not logged in\n", stderr: "" }) }));
  assert.equal((await out.authStatus({ auth: "login" })).signed_in, false);
  assert.equal((await out.authStatus({ auth: "api_key" })).signed_in, false);
  assert.equal((await out.authStatus({ auth: "api_key", api_key: "k" })).signed_in, true);
});

test("the executable is looked up once per name; detect({ refresh: true }) forgets it first", async () => {
  const looked: string[] = [];
  const d = defaultEngineDeps((name, label) => (looked.push(name), { command: `C:\\${name}.exe`, prefixArgs: [], label }));
  d.resolve("codex", "codex CLI");
  d.resolve("codex", "codex CLI");
  d.resolve("grok", "grok CLI");
  d.forget("codex");
  d.resolve("codex", "codex CLI");
  d.resolve("grok", "grok CLI");
  assert.deepEqual(looked, ["codex", "grok", "codex"]);

  const forgot: string[] = [];
  const engine = createCodexEngine(deps({ forget: (n) => forgot.push(n) }));
  await engine.detect();
  assert.deepEqual(forgot, []);
  await engine.detect({ refresh: true });
  assert.deepEqual(forgot, ["codex"]);
});

test("parser: thread id, whole messages, tool calls with results, refusals, end of turn", () => {
  const p = createCodexParser((m) => m);
  const lines = [
    { type: "thread.started", thread_id: "thread-7" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "i1", type: "mcp_tool_call", server: "vault", tool: "list_skills", arguments: {}, result: null, error: null, status: "in_progress" } },
    { type: "item.completed", item: { id: "i1", type: "mcp_tool_call", server: "vault", tool: "list_skills", arguments: {}, result: { content: [{ type: "text", text: "12 skills" }] }, error: null, status: "completed" } },
    { type: "item.completed", item: { id: "i2", type: "command_execution", command: "hostname", aggregated_output: "PC1", exit_code: 0, status: "completed" } },
    { type: "item.completed", item: { id: "i3", type: "command_execution", command: "del x", aggregated_output: "", exit_code: null, status: "declined" } },
    { type: "item.completed", item: { id: "i4", type: "mcp_tool_call", server: "vault", tool: "push_skill", arguments: {}, result: null, error: { message: "user cancelled MCP tool call" }, status: "failed" } },
    { type: "item.completed", item: { id: "i5", type: "agent_message", text: "You have 12 skills." } },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } },
  ];
  const events = lines.flatMap((l) => p.parse(JSON.stringify(l)));
  assert.equal(p.engineSessionId?.(), "thread-7");
  assert.deepEqual(events.map((e) => e.type), [
    "tool_start", "tool_result", "tool_start", "tool_result", "tool_start", "tool_result", "tool_start", "tool_result", "text_delta", "turn_end",
  ]);
  assert.equal(events[0].type === "tool_start" && events[0].label, "vault: list_skills");
  assert.equal(events[2].type === "tool_start" && events[2].label, "Running: hostname");
  assert.equal(events[1].type === "tool_result" && events[1].output_preview, "12 skills");
  assert.equal(events[3].type === "tool_result" && events[3].ok, true);
  assert.equal(events[5].type === "tool_result" && events[5].ok, false, "a declined command is a refusal");
  assert.equal(events[7].type === "tool_result" && events[7].ok, false, "a failed MCP call is a refusal");
  assert.equal(events[7].type === "tool_result" && events[7].output_preview, "user cancelled MCP tool call");
  assert.deepEqual(p.parse("not json"), []);
  assert.deepEqual(p.parse(JSON.stringify({ type: "turn.failed", error: { message: "boom" } })), [{ type: "error", message: "boom" }]);
});

test("parser: the recorded Codex turn (S7) — thread id, the vault call, a shell call, text, end of turn", () => {
  const p = createCodexParser((m) => m);
  const events = fs.readFileSync(FIXTURE, "utf-8").split(/\r?\n/).filter(Boolean).flatMap((l) => p.parse(l));
  assert.equal(p.engineSessionId?.(), "01a189ea-394d-7400-b24a-ed9345e12f08");
  assert.deepEqual(events.map((e) => e.type), ["text_delta", "tool_start", "tool_result", "tool_start", "tool_result", "text_delta", "turn_end"]);
  const vault = events[1];
  assert.ok(vault.type === "tool_start" && vault.name === "mcp__vault__list_skills");
  assert.ok(events[2].type === "tool_result" && events[2].ok && events[2].output_preview?.includes('"total":3'));
  // The sandbox allows commands by design (hostname ran); the outside write left no item at all.
  assert.ok(events[3].type === "tool_start" && events[3].name === "Bash");
  assert.ok(events[4].type === "tool_result" && events[4].ok);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import tsx --test server/services/assistant/engines/codex.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `common.ts`**

```ts
// app/server/services/assistant/engines/common.ts
/** Small pieces every non-Claude engine shares: finding its CLI, its version, its env, its sign-in hint. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { knownInstallDirs, resolveTarget, runCommand, type CommandRunner, type SpawnTarget } from "./exe.ts";
import type { EngineAuthConfig, EngineDetect } from "./types.ts";

export interface EngineDeps {
  /** The CLI, found without a shell. Remembered per name (a miss too) until forget(name). */
  resolve(name: string, label: string): SpawnTarget | null;
  /** Drop the remembered result for `name`: detect({ refresh: true }) calls it. */
  forget(name: string): void;
  run: CommandRunner;
  home: string;
  env: NodeJS.ProcessEnv;
  exists(p: string): boolean;
  readFile(p: string): string;
  writeFile(p: string, text: string): void;
}

const findOnThisPc = (name: string, label: string): SpawnTarget | null =>
  resolveTarget(name, label, { knownDirs: knownInstallDirs() });

/** `find` is the uncached search; tests pass a fake. */
export function defaultEngineDeps(find: (name: string, label: string) => SpawnTarget | null = findOnThisPc): EngineDeps {
  // resolveTarget can spawn `reg query` twice, and target() runs on every view and turn.
  const found = new Map<string, SpawnTarget | null>();
  return {
    resolve: (name, label) => {
      if (!found.has(name)) found.set(name, find(name, label));
      return found.get(name) ?? null;
    },
    forget: (name) => {
      found.delete(name);
    },
    run: runCommand,
    home: os.homedir(),
    env: process.env,
    exists: (p) => fs.existsSync(p),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    writeFile: (p, text) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text, "utf-8");
    },
  };
}

export async function detectWithVersion(deps: EngineDeps, target: SpawnTarget | null, env: NodeJS.ProcessEnv): Promise<EngineDetect> {
  if (!target) return { installed: false, reason: "not found on this PC" };
  const r = await deps.run(target, ["--version"], { env, timeoutMs: 20_000 });
  const line = r.stdout.trim().split(/\r?\n/)[0]?.trim();
  if (r.code === 0 && line) return { installed: true, version: line };
  const why = r.stderr.trim().split(/\r?\n/).at(-1) || `${target.label} --version failed`;
  return { installed: false, reason: why.slice(0, 200) };
}

/** Delete env vars by name, ignoring case (Windows env names are case-insensitive). */
function deleteVar(env: NodeJS.ProcessEnv, name: string): void {
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) if (k.toUpperCase() === upper) delete env[k];
}

/**
 * Login mode: remove every key var the CLI would prefer over its own login.
 * API-key mode: set the saved key on the first var (a key already in the env is left for the CLI).
 */
export function keyEnv(cfg: EngineAuthConfig, base: NodeJS.ProcessEnv, keys: string[], extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (cfg.auth === "api_key") {
    if (cfg.api_key) {
      deleteVar(env, keys[0]);
      env[keys[0]] = cfg.api_key;
    }
  } else {
    for (const k of keys) deleteVar(env, k);
  }
  return { ...env, ...extra };
}

export function apiKeyPresent(cfg: EngineAuthConfig, env: NodeJS.ProcessEnv, keys: string[]): boolean {
  return Boolean(cfg.api_key) || keys.some((k) => Boolean(env[k]));
}

export function makeAuthHint(label: string, pattern: RegExp): (message: string) => string {
  return (m) => (pattern.test(m) && !m.includes("Settings → AI assistant") ? `${m} — sign in to ${label} again in Settings → AI assistant.` : m);
}
```

- [ ] **Step 4: Write `codex.ts`**

```ts
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
import type { AssistantEngine, TurnParser } from "./types.ts";

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
    detect: (opts) => {
      if (opts?.refresh) deps.forget("codex");
      return detectWithVersion(deps, target(), engine.childEnv({ auth: "login" }, deps.env));
    },
    async authStatus(cfg) {
      if (cfg.auth === "api_key") return { signed_in: apiKeyPresent(cfg, deps.env, KEYS), method: "api_key" };
      const t = target();
      if (!t) return { signed_in: false, method: "login" };
      // S5: exit 0 and "Logged in using ChatGPT" on stdout when signed in.
      const r = await deps.run(t, ["login", "status"], { env: engine.childEnv({ auth: "login" }, deps.env), timeoutMs: 20_000 });
      if (r.code === null) return { signed_in: null, method: "login" };
      const line = `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/)[0]?.trim();
      return r.code === 0 ? { signed_in: true, method: "login", account: line || undefined } : { signed_in: false, method: "login" };
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
```

What the spike settled (S5–S7), already reflected above:
- `codex login status` prints "Logged in using ChatGPT" and exits 0 when signed in (S5).
- `CODEX_API_KEY` is unverified (no key was offered); the documented default is kept (S6).
- With `--ignore-user-config` Codex has no Windows sandbox and falls back to read-only: every command
  is "blocked by policy" (status `declined`) and every MCP call fails with
  `error.message = "user cancelled MCP tool call"`. `-c windows.sandbox="unelevated"` and
  `-c mcp_servers.vault.default_tools_approval_mode="approve"` fix that; both forms of the turn pass
  both, and the first test asserts them. With them the sandbox works: `hostname` runs (allowed by
  design) and a write outside the roots is refused ("writing outside of the project"). A refused patch
  emits **no** `file_change` item, so the recorded fixture has no refused item; the synthetic test
  covers `declined` and `failed`.
- Resume (`codex exec resume <thread_id> … -`) remembers the first turn and emits `thread.started`
  again with the same `thread_id`.

- [ ] **Step 5: Register Codex**

In `registry.ts`: `import { createCodexEngine } from "./codex.ts";` and
`shared ??= createRegistry([createClaudeEngine(), createCodexEngine()]);`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --import tsx --test server/services/assistant/engines/codex.test.ts` then `npm test` and `npm run typecheck`
Expected: PASS (7 codex tests).

- [ ] **Step 7: Commit**

```bash
git add server/services/assistant/engines
git commit -m "engines: OpenAI Codex (sandboxed exec --json, thread resume, ChatGPT login or API key)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Copilot engine

**Files:**
- Create: `app/server/services/assistant/engines/copilot.ts`
- Modify: `app/server/services/assistant/engines/registry.ts`
- Test: `app/server/services/assistant/engines/copilot.test.ts`

**Interfaces:**
- Consumes: `common.ts` (Task 9, `EngineDeps` with `forget`), Tasks 4–5 (`engineNote` with
  `shell: "none"`), `FORBIDDEN_FLAGS` (Task 8); the recorded fixture `fixtures/copilot-turn.jsonl`
  (117 lines, Copilot CLI 1.0.105) and findings S8–S9 (Task 1, in the spec).
- Produces: `createCopilotEngine(deps?)`, `createCopilotParser(authHint)`, `COPILOT_TOOLS` (the
  `--available-tools` allowlist), `COPILOT_ALIASES`.
- Copilot has **no shell** (user decision after S9): its "manual" permission mode auto-approves
  commands it classes as read-only even under a `shell(git:*)`-only rule (`hostname` ran), so a
  git-only allowlist can't be enforced. The engine note tells the model it has no shell and can't run
  git.

- [ ] **Step 1: Write the failing tests**

```ts
// app/server/services/assistant/engines/copilot.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createCopilotEngine, createCopilotParser } from "./copilot.ts";
import type { EngineDeps } from "./common.ts";
import { FORBIDDEN_FLAGS } from "./testFakes.ts";
import type { TurnInput } from "./types.ts";

const PLUGIN = path.resolve(import.meta.dirname, "..", "..", "..", "..", "assistant-plugin");
const FIXTURE = path.join(import.meta.dirname, "fixtures", "copilot-turn.jsonl");

function deps(over: Partial<EngineDeps> = {}): EngineDeps {
  return {
    resolve: () => ({ command: "C:\\node\\node.exe", prefixArgs: ["C:\\npm\\copilot\\npm-loader.js"], label: "copilot CLI" }),
    forget: () => {},
    run: async () => ({ code: 0, stdout: "GitHub Copilot CLI 1.0.105.\n", stderr: "" }),
    home: "C:\\Users\\me",
    env: {},
    exists: () => true,
    readFile: () => JSON.stringify({ lastLoggedInUser: { host: "https://github.com", login: "octo" }, loggedInUsers: [{ host: "https://github.com", login: "octo" }] }),
    writeFile: () => {},
    ...over,
  };
}

const INPUT: TurnInput = {
  sessionId: "11111111-2222-3333-4444-555555555555",
  isFirstTurn: true,
  message: "hi",
  leadAgent: "vault-assistant",
  contextBlock: "# ctx",
  mcp: { command: "C:\\node.exe", args: ["C:\\app\\dist\\assistant-mcp.js"], env: { SKILL_VAULT_URL: "http://127.0.0.1:9994" } },
  vaultPath: "C:\\vault",
  reposDir: "C:\\repos",
  pluginDir: PLUGIN,
  workDir: "C:\\Users\\me\\.skill-vault\\engines\\copilot",
  auth: { auth: "login" },
  baseEnv: { GH_TOKEN: "ghp_stray", PATH: "C:\\bin" },
};

test("turn: -p prompt, JSON output, same session id, plugin agent, no shell tool at all", () => {
  const spec = createCopilotEngine(deps()).buildTurn(INPUT);
  const a = spec.args;
  const after = (flag: string) => a[a.indexOf(flag) + 1];
  assert.equal(after("--output-format"), "json");
  assert.equal(after("--session-id"), INPUT.sessionId);
  assert.equal(after("-C"), "C:\\vault");
  assert.equal(after("--plugin-dir"), PLUGIN);
  assert.equal(after("--agent"), "skill-vault-assistant:vault-assistant"); // S9: plugin-qualified
  assert.deepEqual(JSON.parse(after("--additional-mcp-config")).mcpServers.vault.command, "C:\\node.exe");
  const tools = a.indexOf("--available-tools");
  assert.deepEqual(a.slice(tools + 1, tools + 11), ["view", "create", "edit", "grep", "glob", "web_fetch", "skill", "task", "update_todo", "vault"]);
  assert.ok(a[tools + 11].startsWith("--"), "the allowlist ends at the next flag");
  const allowed = a.flatMap((x, i) => (x === "--allow-tool" ? [a[i + 1]] : []));
  assert.deepEqual(allowed, ["write", "vault"]);
  assert.ok(!a.some((x) => x.includes("shell(")), "no shell permission anywhere");
  for (const bad of FORBIDDEN_FLAGS) assert.ok(!a.some((x) => x.includes(bad)), `must not pass ${bad}`);
  assert.ok(!a.includes("--no-remote"), "Copilot has no --no-remote flag");
  assert.ok(!a.includes("--disallow-temp-dir"), "Copilot reads its own large tool output from temp");
  for (const flag of ["--disable-builtin-mcps", "--no-ask-user", "--no-auto-update"]) assert.ok(a.includes(flag), `missing ${flag}`);
  assert.match(after("-p"), /running on GitHub Copilot CLI/);
  assert.match(after("-p"), /There is no shell tool here/);
  assert.ok(after("-p").endsWith("hi"));
  assert.equal(spec.env?.GH_TOKEN, undefined, "a stray gh token must not override the login");
  const later = createCopilotEngine(deps()).buildTurn({ ...INPUT, isFirstTurn: false });
  assert.ok(!later.args[later.args.indexOf("-p") + 1].includes("<skill-vault-instructions>"));
  assert.equal(later.args[later.args.indexOf("--session-id") + 1], INPUT.sessionId, "the same flag resumes");
});

test("API-key mode passes the token as COPILOT_GITHUB_TOKEN", () => {
  const spec = createCopilotEngine(deps()).buildTurn({ ...INPUT, auth: { auth: "api_key", api_key: "github_pat_x" } });
  assert.equal(spec.env?.COPILOT_GITHUB_TOKEN, "github_pat_x");
});

test("authStatus reads the signed-in user from config.json (camelCase, S8)", async () => {
  assert.deepEqual(await createCopilotEngine(deps()).authStatus({ auth: "login" }), { signed_in: true, method: "login", account: "octo" });
  const onlyList = deps({ readFile: () => JSON.stringify({ loggedInUsers: [{ host: "https://github.com", login: "mona" }] }) });
  assert.equal((await createCopilotEngine(onlyList).authStatus({ auth: "login" })).account, "mona");
  const snake = deps({ readFile: () => JSON.stringify({ logged_in_users: [{ login: "octo" }] }) });
  assert.equal((await createCopilotEngine(snake).authStatus({ auth: "login" })).signed_in, false);
  assert.equal((await createCopilotEngine(deps({ exists: () => false })).authStatus({ auth: "login" })).signed_in, false);
  assert.equal((await createCopilotEngine(deps({ readFile: () => "{" })).authStatus({ auth: "login" })).signed_in, null);
});

test("parser: deltas, tools (vault + a denied write), one end of turn", () => {
  const p = createCopilotParser((m) => m);
  const lines = [
    { type: "assistant.turn_start", data: { turnId: "0" } },
    { type: "assistant.message", data: { messageId: "m0", content: "", toolRequests: [{ toolCallId: "c1", name: "vault-list_skills", arguments: {} }] } },
    { type: "tool.execution_start", data: { toolCallId: "c1", toolName: "vault-list_skills", arguments: {}, mcpServerName: "vault", mcpToolName: "list_skills" } },
    { type: "tool.execution_complete", data: { toolCallId: "c1", success: true, result: { content: "12", detailedContent: "12" } } },
    { type: "tool.execution_start", data: { toolCallId: "c2", toolName: "create", arguments: { path: "C:\\outside.txt", file_text: "hi" } } },
    { type: "tool.execution_complete", data: { toolCallId: "c2", success: false, error: { message: "Permission denied", code: "denied" } } },
    { type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "You have " } },
    { type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "12 skills." } },
    { type: "assistant.message", data: { messageId: "m1", content: "You have 12 skills.", toolRequests: [] } },
    { type: "assistant.idle", data: {}, ephemeral: true },
    { type: "result", sessionId: "s", exitCode: 0, usage: { premiumRequests: 1 } },
  ];
  const events = lines.flatMap((l) => p.parse(JSON.stringify(l)));
  assert.deepEqual(events.map((e) => e.type), ["tool_start", "tool_result", "tool_start", "tool_result", "text_delta", "text_delta", "turn_end"]);
  assert.equal(events[0].type === "tool_start" && events[0].label, "vault: list_skills");
  assert.equal(events[2].type === "tool_start" && events[2].label, "Writing C:/outside.txt");
  assert.equal(events[3].type === "tool_result" && events[3].ok, false);
  assert.equal(events[3].type === "tool_result" && events[3].output_preview, "Permission denied");
  const failed = createCopilotParser((m) => m).parse(JSON.stringify({ type: "result", exitCode: 1 }));
  assert.deepEqual(failed.map((e) => e.type), ["error"]);
});

test("parser: the recorded Copilot turn (S9) — text, the vault call, the denied write, end of turn", () => {
  // Recorded before the --available-tools allowlist, so it still has a powershell call; shapes only.
  const lines = fs.readFileSync(FIXTURE, "utf-8").split(/\r?\n/).filter(Boolean);
  const p = createCopilotParser((m) => m);
  const events = lines.flatMap((l) => p.parse(l));
  const final = lines.map((l) => JSON.parse(l)).filter((m) => m.type === "assistant.message" && m.data.content).at(-1);
  const text = events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("");
  assert.equal(text, final.data.content, "the deltas add up to the final message, which isn't repeated");
  assert.ok(events.some((e) => e.type === "tool_start" && e.name === "mcp__vault__list_skills"));
  const write = events.find((e) => e.type === "tool_start" && e.name === "Write");
  assert.ok(write && write.type === "tool_start");
  const result = events.find((e) => e.type === "tool_result" && e.tool_use_id === write.tool_use_id);
  assert.ok(result && result.type === "tool_result" && result.ok === false, "the denied create is a refused tool_result");
  assert.equal(events.filter((e) => e.type === "turn_end").length, 1);
  assert.equal(events.at(-1)?.type, "turn_end");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import tsx --test server/services/assistant/engines/copilot.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `copilot.ts`**

```ts
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
import type { AssistantEngine, TurnParser } from "./types.ts";

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
    detect: (opts) => {
      if (opts?.refresh) deps.forget("copilot");
      return detectWithVersion(deps, target(), engine.childEnv({ auth: "login" }, deps.env));
    },
    async authStatus(cfg) {
      if (cfg.auth === "api_key") return { signed_in: apiKeyPresent(cfg, deps.env, KEYS), method: "api_key" };
      const file = configFile();
      if (!deps.exists(file)) return { signed_in: false, method: "login" };
      try {
        // S8: camelCase — lastLoggedInUser / loggedInUsers carry { host, login }.
        const j = JSON.parse(deps.readFile(file)) as { lastLoggedInUser?: { login?: string }; loggedInUsers?: Array<{ login?: string }> };
        const login = j.lastLoggedInUser?.login ?? j.loggedInUsers?.[0]?.login;
        return login ? { signed_in: true, method: "login", account: login } : { signed_in: false, method: "login" };
      } catch {
        return { signed_in: null, method: "login" };
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
```

What the spike settled (S8–S9), already reflected above:
- `~/.copilot/config.json` is camelCase: `lastLoggedInUser: { host, login }`, `loggedInUsers: [{ host, login }]`.
- `--agent` must be plugin-qualified (`skill-vault-assistant:vault-assistant`); the bare name is
  rejected. There is **no** `--no-remote` flag.
- `--available-tools` takes each tool as its own argv element; `vault` means every tool of the vault MCP
  server (`vault-*` does not work). The list also drops Copilot's built-in computer-use (desktop
  control), sql, workflow and shell-session tools. The system temp folder stays allowed
  (no `--disallow-temp-dir`): Copilot saves tool output over ~20 KB there and reads it back.
- MCP tools are named `vault-<tool>` in events; `canonicalTool` maps them to `mcp__vault__<tool>`.
- The recorded fixture predates the allowlist: it still has a `powershell` call (hostname ran), a
  `create` denied with `error.code = "denied"`, and a `tool_search_tool` call. Its test checks shapes
  (and that a denied result maps to `ok: false`), not which calls the allowlist refuses — Task 20
  checks that live.
- Resume with the same `--session-id` remembered the first turn.

- [ ] **Step 4: Register Copilot**

`registry.ts`: add the import and
`createRegistry([createClaudeEngine(), createCodexEngine(), createCopilotEngine()])`.

- [ ] **Step 5: Run the tests**

Run: `node --import tsx --test server/services/assistant/engines/copilot.test.ts` then `npm test` and `npm run typecheck`
Expected: PASS (5 copilot tests).

- [ ] **Step 6: Commit**

```bash
git add server/services/assistant/engines
git commit -m "engines: GitHub Copilot CLI (plugin agent, tool allowlist with no shell, GitHub login or token)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Grok Build engine

**Grok wasn't run in the spike** (user decision), so S1–S4 are **unverified — built from xAI's docs**:
the install folder (`~/.grok/bin`), the sign-in file (`auth.json` in `GROK_HOME`), the tool names in
`GROK_TOOLS` / `GROK_ALIASES`, the `use_tool` MCP call shape and the refusals. The fixture
`fixtures/grok-turn.jsonl` already exists (committed with the spike findings); it is **hand-written**
from the docs, not recorded, and its first line says so. Build exactly what's below; Task 20 checks
these against the real CLI and lists what to change if they differ.

This is the last engine task, so it also adds `safety.test.ts`, which checks every registered engine
against the Global Constraints at once.

**Files:**
- Create: `app/server/services/assistant/engines/grok.ts`, `app/server/services/assistant/engines/safety.test.ts`
- Modify: `app/server/services/assistant/engines/registry.ts`
- Test: `app/server/services/assistant/engines/grok.test.ts`, `app/server/services/assistant/engines/safety.test.ts`
- Read only: `app/server/services/assistant/engines/fixtures/grok-turn.jsonl` (don't edit it)

**Interfaces:**
- Consumes: `common.ts` (`EngineDeps` with `forget`), `parseStreamJsonLine(line, { aliases, authHint })`
  (Task 4), Task 5 (`shell: "git"`), `FORBIDDEN_FLAGS` (Task 8); `createClaudeEngine` (Task 7),
  `createCodexEngine` (Task 9), `createCopilotEngine` (Task 10) and `defaultRegistry` for the safety test.
- Produces: `createGrokEngine(deps?)`, `grokHome(home, mode)`, `grokConfigToml(mcp)`, `GROK_ALIASES`,
  `GROK_TOOLS`; the registry's final order claude, codex, copilot, grok.

- [ ] **Step 1: Write the failing tests**

```ts
// app/server/services/assistant/engines/grok.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GROK_TOOLS, createGrokEngine, grokConfigToml, grokHome } from "./grok.ts";
import type { EngineDeps } from "./common.ts";
import { FORBIDDEN_FLAGS } from "./testFakes.ts";
import type { TurnInput } from "./types.ts";

const PLUGIN = path.resolve(import.meta.dirname, "..", "..", "..", "..", "assistant-plugin");
/** Hand-written from xAI's docs, not recorded: it pins the parser to the documented shapes until Task 20. */
const FIXTURE = path.join(import.meta.dirname, "fixtures", "grok-turn.jsonl");
const MCP = { command: "C:\\node.exe", args: ["C:\\app\\dist\\assistant-mcp.js"], env: { SKILL_VAULT_URL: "http://127.0.0.1:9994" } };

function deps(written: Record<string, string>, over: Partial<EngineDeps> = {}): EngineDeps {
  return {
    resolve: () => ({ command: "C:\\Users\\me\\.grok\\bin\\grok.exe", prefixArgs: [], label: "grok CLI" }),
    forget: () => {},
    run: async () => ({ code: 0, stdout: "grok 1.0.0\n", stderr: "" }),
    home: "C:\\Users\\me",
    env: {},
    exists: (p) => p in written,
    readFile: (p) => written[p] ?? "",
    writeFile: (p, t) => {
      written[p] = t;
    },
    ...over,
  };
}

const INPUT: TurnInput = {
  sessionId: "11111111-2222-3333-4444-555555555555",
  isFirstTurn: true,
  message: "hi",
  leadAgent: "vault-assistant",
  contextBlock: "# ctx",
  mcp: MCP,
  vaultPath: "C:\\vault",
  reposDir: "C:\\repos",
  pluginDir: PLUGIN,
  workDir: "C:\\Users\\me\\.skill-vault\\engines\\grok",
  auth: { auth: "login" },
  baseEnv: { XAI_API_KEY: "stray" },
};

test("config.toml: only the vault server, Claude/Cursor imports off", () => {
  const t = grokConfigToml(MCP);
  assert.match(t, /\[mcp_servers\.vault\]\ncommand = "C:\\\\node\.exe"/);
  assert.match(t, /\[compat\.claude\]\nmcps = false/);
  assert.match(t, /\[compat\.cursor\]\nmcps = false/);
});

test("turn: prompt file, Claude-format stream, app-owned GROK_HOME, git-only shell", () => {
  const written: Record<string, string> = {};
  const spec = createGrokEngine(deps(written)).buildTurn(INPUT);
  const a = spec.args;
  const after = (flag: string) => a[a.indexOf(flag) + 1];
  const promptFile = after("--prompt-file");
  assert.ok(spec.tempFiles?.includes(promptFile));
  assert.match(written[promptFile], /^<skill-vault-instructions>/);
  assert.equal(after("--output-format"), "streaming-messages-json");
  assert.ok(a.includes("--include-partial-messages"));
  assert.equal(after("-s"), INPUT.sessionId);
  assert.equal(after("--cwd"), "C:\\vault");
  assert.equal(after("--tools"), GROK_TOOLS);
  assert.equal(after("--allow"), "Bash(git *)");
  for (const bad of [...FORBIDDEN_FLAGS, "--always-approve"]) assert.ok(!a.some((x) => x.includes(bad)), `must not pass ${bad}`);
  assert.equal(spec.env?.GROK_HOME, grokHome("C:\\Users\\me", "login"));
  assert.equal(spec.env?.XAI_API_KEY, undefined);
  assert.ok(written[path.join(grokHome("C:\\Users\\me", "login"), "config.toml")]);
  const later = createGrokEngine(deps({})).buildTurn({ ...INPUT, isFirstTurn: false });
  assert.equal(later.args[later.args.indexOf("-r") + 1], INPUT.sessionId);
});

test("API-key mode uses a separate home with no login in it", () => {
  const spec = createGrokEngine(deps({})).buildTurn({ ...INPUT, auth: { auth: "api_key", api_key: "xai-k" } });
  assert.equal(spec.env?.GROK_HOME, grokHome("C:\\Users\\me", "api_key"));
  assert.equal(spec.env?.XAI_API_KEY, "xai-k");
});

test("authStatus: auth.json in the app's Grok home", async () => {
  const signedIn = { [path.join(grokHome("C:\\Users\\me", "login"), "auth.json")]: "{}" };
  assert.equal((await createGrokEngine(deps(signedIn)).authStatus({ auth: "login" })).signed_in, true);
  assert.equal((await createGrokEngine(deps({})).authStatus({ auth: "login" })).signed_in, false);
  assert.deepEqual(createGrokEngine(deps({})).loginEnv(), { GROK_HOME: grokHome("C:\\Users\\me", "login") });
});

test("parser: the hand-written Grok fixture maps tools to the shared vocabulary", () => {
  const p = createGrokEngine(deps({})).createParser();
  const events = fs.readFileSync(FIXTURE, "utf-8").split(/\r?\n/).filter(Boolean).flatMap((l) => p.parse(l));
  assert.deepEqual(events.map((e) => e.type), [
    "session", "text_delta", "tool_start", "tool_result", "tool_start", "tool_result", "tool_start", "tool_result", "text_delta", "turn_end",
  ]);
  assert.ok(events.some((e) => e.type === "tool_start" && e.name === "mcp__vault__list_skills"));
  const shell = events.find((e) => e.type === "tool_start" && e.name === "Bash");
  const write = events.find((e) => e.type === "tool_start" && e.name === "Write");
  assert.ok(shell?.type === "tool_start" && shell.label === "Running: hostname");
  assert.ok(write?.type === "tool_start");
  for (const start of [shell, write]) {
    const r = events.find((e) => e.type === "tool_result" && start?.type === "tool_start" && e.tool_use_id === start.tool_use_id);
    assert.ok(r?.type === "tool_result" && r.ok === false, "an is_error result is a refusal");
  }
  const end = events.at(-1);
  assert.ok(end?.type === "turn_end" && end.cost_usd === 0.0042, "cost comes from the result record");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import tsx --test server/services/assistant/engines/grok.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `grok.ts`**

```ts
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
 */
import path from "node:path";
import { parseStreamJsonLine, type ToolAliases } from "../streamEvents.ts";
import type { VaultMcpServer } from "../mcpConfig.ts";
import { apiKeyPresent, defaultEngineDeps, detectWithVersion, keyEnv, makeAuthHint, type EngineDeps } from "./common.ts";
import { composeInstructions, composePrompt } from "./instructions.ts";
import type { AssistantEngine } from "./types.ts";

const LABEL = "Grok Build";
const KEYS = ["XAI_API_KEY"];
const authHint = makeAuthHint(LABEL, /not (logged|signed) in|unauthori[sz]ed|\b401\b|grok login|XAI_API_KEY/i);

/** Headless tool allowlist, per xAI's docs (S3, unverified). MCP calls go through use_tool. */
export const GROK_TOOLS = "read_file,grep,list_dir,search_replace,write_file,run_terminal_cmd,web_search,web_fetch";

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
    detect: (opts) => {
      if (opts?.refresh) deps.forget("grok");
      return detectWithVersion(deps, target(), engine.childEnv({ auth: "login" }, deps.env));
    },
    async authStatus(cfg) {
      if (cfg.auth === "api_key") return { signed_in: apiKeyPresent(cfg, deps.env, KEYS), method: "api_key" };
      // S2 (unverified): `grok login` writes auth.json into GROK_HOME.
      return { signed_in: deps.exists(path.join(grokHome(deps.home, "login"), "auth.json")), method: "login" };
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
            note: { label: LABEL, vaultToolSpelling: "vault__<tool>, called through use_tool", subagents: false, shell: "git" },
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
          "--allow", "Bash(git *)",
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
```

- [ ] **Step 4: Register Grok**

In `registry.ts`: `import { createGrokEngine } from "./grok.ts";` and
`shared ??= createRegistry([createClaudeEngine(), createCodexEngine(), createCopilotEngine(), createGrokEngine()]);`.

- [ ] **Step 5: Write the cross-engine safety test**

```ts
// app/server/services/assistant/engines/safety.test.ts
/**
 * The Global Constraints, checked across every engine at once: no bypass /
 * yolo / allow-all flag in any turn (new or resumed chat, login or API key),
 * Copilot has no shell permission at all, Claude's and Grok's shell is
 * git-only, and Codex always runs in its workspace-write sandbox.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createClaudeEngine } from "./claude.ts";
import { createCodexEngine } from "./codex.ts";
import type { EngineDeps } from "./common.ts";
import { createCopilotEngine } from "./copilot.ts";
import { createGrokEngine } from "./grok.ts";
import { defaultRegistry } from "./registry.ts";
import { FORBIDDEN_FLAGS } from "./testFakes.ts";
import type { AssistantEngine, TurnInput } from "./types.ts";

const PLUGIN = path.resolve(import.meta.dirname, "..", "..", "..", "..", "assistant-plugin");

const fakeDeps = (): EngineDeps => ({
  resolve: (name, label) => ({ command: `C:\\bin\\${name}.exe`, prefixArgs: [], label }),
  forget: () => {},
  run: async () => ({ code: 0, stdout: "1.0.0\n", stderr: "" }),
  home: "C:\\Users\\me",
  env: {},
  exists: () => false,
  readFile: () => "",
  writeFile: () => {},
});

const ENGINES: AssistantEngine[] = [createClaudeEngine(), createCodexEngine(fakeDeps()), createCopilotEngine(fakeDeps()), createGrokEngine(fakeDeps())];

const BASE: TurnInput = {
  sessionId: "11111111-2222-3333-4444-555555555555",
  isFirstTurn: true,
  message: "hi",
  leadAgent: "vault-assistant",
  contextBlock: "# ctx",
  mcp: { command: "C:\\node.exe", args: ["C:\\app\\dist\\assistant-mcp.js"], env: { SKILL_VAULT_URL: "http://127.0.0.1:9994" } },
  vaultPath: "C:\\vault",
  reposDir: "C:\\repos",
  pluginDir: PLUGIN,
  workDir: "C:\\Users\\me\\.skill-vault\\engines\\x",
  auth: { auth: "login" },
  baseEnv: {},
};

/** New and resumed chat × login and API key. */
function turns(engine: AssistantEngine): string[][] {
  const out: string[][] = [];
  for (const auth of [{ auth: "login" as const }, { auth: "api_key" as const, api_key: "k" }]) {
    out.push(engine.buildTurn({ ...BASE, auth }).args);
    out.push(engine.buildTurn({ ...BASE, auth, isFirstTurn: false, engineSessionId: "thread-1" }).args);
  }
  return out;
}

test("every registered engine is covered here", () => {
  assert.deepEqual(ENGINES.map((e) => e.id), defaultRegistry().list().map((e) => e.id));
});

test("no engine's turn carries a bypass, yolo or allow-all flag", () => {
  for (const engine of ENGINES) {
    for (const args of turns(engine)) {
      const hit = FORBIDDEN_FLAGS.find((f) => args.some((a) => a.includes(f)));
      assert.equal(hit, undefined, `${engine.id} passes ${hit}`);
    }
  }
});

test("shell: none on Copilot, git-only on Claude and Grok, sandboxed on Codex", () => {
  const byId = (id: string) => ENGINES.find((e) => e.id === id) as AssistantEngine;
  for (const args of turns(byId("copilot"))) assert.ok(!args.some((a) => a.includes("shell(")), "Copilot gets no shell permission");
  for (const id of ["claude", "grok"]) {
    for (const args of turns(byId(id))) {
      const shells = args.flatMap((a) => a.match(/Bash\([^)]*\)/g) ?? []);
      assert.ok(shells.length > 0, `${id} declares its shell rule`);
      for (const s of shells) assert.match(s, /^Bash\(git[ :]\*\)$/, `${id}: ${s} isn't git-only`);
    }
  }
  for (const args of turns(byId("codex"))) {
    assert.ok(args.includes('sandbox_mode="workspace-write"'));
    assert.ok(!args.some((a) => a.includes("danger-full-access")));
  }
});
```

- [ ] **Step 6: Run the tests**

Run: `node --import tsx --test server/services/assistant/engines/grok.test.ts server/services/assistant/engines/safety.test.ts` then `npm test` and `npm run typecheck`
Expected: PASS (5 grok tests, 3 safety tests).

- [ ] **Step 7: Commit**

```bash
git add server/services/assistant/engines
git commit -m "engines: Grok Build (own GROK_HOME with only the vault server, Claude-format stream); safety test across engines" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: (removed)

Removed: Gemini dropped after the spike (S10). Task numbers are kept so references stay valid.

---

### Task 13: Install job (`engines/install.ts`, `engines/jobs.ts`, route, busy wiring)

**Files:**
- Create: `app/server/services/assistant/engines/install.ts`, `app/server/services/assistant/engines/jobs.ts`
- Modify: `app/server/routes/assistant.ts`, `app/server/index.ts`
- Test: `app/server/services/assistant/engines/install.test.ts`, `app/server/routes/assistant.test.ts`

**Interfaces:**
- Consumes: `AssistantEngine.install`, `installDisplay` (Task 4); `buildWindowsShellInvocation`
  (`claude/cli.ts`); `killProcessTree` (Task 2); `EngineStates` (Task 8).
- Produces:
  - `type InstallEvent = { type: "step"; index: number; label: string; display: string } | { type: "line"; text: string } | { type: "done"; ok: boolean; version?: string; message?: string }`
  - `interface Installer { isRunning(): boolean; stop(): void; run(engine, onEvent): Promise<{ ok: boolean; message?: string }> }`
  - `createInstaller(deps?: Partial<InstallDeps>): Installer`
  - `interface EngineJobs { installer: Installer; busy(): boolean; stopAll(): void }` (Task 14 adds
    `signIn`)
  - `createEngineJobs(parts?: { installer?: Installer }): EngineJobs`
  - Route `POST /engines/:id/install` → NDJSON `InstallEvent`s (409 while one runs).
  - `AssistantRouterOpts.jobs?: EngineJobs`.

- [ ] **Step 1: Write the failing tests**

```ts
// app/server/services/assistant/engines/install.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInstaller, type InstallEvent } from "./install.ts";
import { fakeEngine } from "./testFakes.ts";

function fakeSpawn(code: number | null, lines: string[] = ["added 1 package"]) {
  const calls: Array<{ command: string; args: string[]; verbatim: boolean }> = [];
  return {
    calls,
    spawnLines: (command: string, args: string[], opts: { windowsVerbatimArguments?: boolean }, onLine: (l: string) => void) => {
      calls.push({ command, args, verbatim: opts.windowsVerbatimArguments === true });
      for (const l of lines) onLine(l);
      return { done: Promise.resolve(code), kill: () => {} };
    },
  };
}

test("npm steps run the npm next to node through cmd, streaming each line", async () => {
  const sp = fakeSpawn(0);
  const inst = createInstaller({ platform: "win32", npmPath: () => "C:\\nvm4w\\nodejs\\npm.cmd", spawnLines: sp.spawnLines });
  const events: InstallEvent[] = [];
  const r = await inst.run(fakeEngine(), (e) => events.push(e));
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(events.slice(0, 2), [
    { type: "step", index: 0, label: "Install Fake", display: "npm install -g fake" },
    { type: "line", text: "added 1 package" },
  ]);
  assert.match(sp.calls[0].command, /cmd\.exe$/i);
  assert.ok(sp.calls[0].verbatim);
  // cmd.exe escaping turns each quote into ^" — match the words, not the quoting.
  assert.match(sp.calls[0].args.at(-1) ?? "", /npm\.cmd.*install.*-g.*fake/);
});

test("PowerShell steps run the vendor one-liner with -ExecutionPolicy Bypass for that process", async () => {
  const sp = fakeSpawn(0);
  const inst = createInstaller({ platform: "win32", npmPath: () => null, spawnLines: sp.spawnLines });
  const engine = fakeEngine({ install: [{ kind: "powershell", label: "Install Grok", script: "irm https://x.ai/cli/install.ps1 | iex", source: "x.ai" }] });
  await inst.run(engine, () => {});
  assert.deepEqual(sp.calls[0], {
    command: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://x.ai/cli/install.ps1 | iex"],
    verbatim: false,
  });
});

test("failures: a non-zero exit, no npm, not Windows", async () => {
  const fail = createInstaller({ platform: "win32", npmPath: () => "npm.cmd", spawnLines: fakeSpawn(1).spawnLines });
  assert.deepEqual(await fail.run(fakeEngine(), () => {}), { ok: false, message: "Install Fake failed (exit code 1)." });
  const noNpm = createInstaller({ platform: "win32", npmPath: () => null, spawnLines: fakeSpawn(0).spawnLines });
  assert.match((await noNpm.run(fakeEngine(), () => {})).message ?? "", /npm wasn't found/);
  const mac = createInstaller({ platform: "darwin", npmPath: () => "npm", spawnLines: fakeSpawn(0).spawnLines });
  assert.match((await mac.run(fakeEngine(), () => {})).message ?? "", /Windows only.*npm install -g fake/);
});
```

Append to `routes/assistant.test.ts`:

```ts
test("install: streams the engine's own steps and a done line; one at a time", async () => {
  const { createInstaller } = await import("../services/assistant/engines/install.ts");
  const { createEngineJobs } = await import("../services/assistant/engines/jobs.ts");
  let release!: () => void;
  const gate = new Promise<number>((r) => (release = () => r(0)));
  const seen: string[][] = [];
  const installer = createInstaller({
    platform: "win32",
    npmPath: () => "npm.cmd",
    spawnLines: (_c, args, _o, onLine) => {
      seen.push(args);
      onLine("working");
      return { done: gate, kill: () => {} };
    },
  });
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry: reg.createRegistry([fakes.fakeEngine()]), jobs: createEngineJobs({ installer }) }));
  const first = fetch(`${base}/engines/codex/install`, send("POST", { args: ["evil"] }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await fetch(`${base}/engines/codex/install`, send("POST", {}))).status, 409);
  release();
  const lines = (await (await first).text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.type), ["step", "line", "done"]);
  assert.equal(lines.at(-1).ok, true);
  assert.ok(!seen.flat().join(" ").includes("evil"), "commands never come from the request");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import tsx --test server/services/assistant/engines/install.test.ts server/routes/assistant.test.ts`
Expected: FAIL — modules not found; the route 404s.

- [ ] **Step 3: Write `install.ts` and `jobs.ts`**

```ts
// app/server/services/assistant/engines/install.ts
/**
 * Installing an engine's CLI. The commands come from the engine module —
 * never from the request — and are shown to the user before they run. npm
 * steps use the npm next to the app's own node (falling back to PATH);
 * PowerShell steps run the vendor's documented one-liner with the execution
 * policy bypassed for that one process. Windows only; elsewhere the user is
 * shown the command to run.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildWindowsShellInvocation } from "../../claude/cli.ts";
import { killProcessTree } from "./exe.ts";
import { installDisplay, type AssistantEngine } from "./types.ts";

export type InstallEvent =
  | { type: "step"; index: number; label: string; display: string }
  | { type: "line"; text: string }
  | { type: "done"; ok: boolean; version?: string; message?: string };

export interface InstallDeps {
  platform: NodeJS.Platform;
  npmPath(): string | null;
  spawnLines(
    command: string,
    args: string[],
    opts: { windowsVerbatimArguments?: boolean },
    onLine: (line: string) => void,
  ): { done: Promise<number | null>; kill(): void };
}

export interface Installer {
  isRunning(): boolean;
  stop(): void;
  run(engine: AssistantEngine, onEvent: (e: InstallEvent) => void): Promise<{ ok: boolean; message?: string }>;
}

function defaultNpmPath(): string | null {
  const dirs = [path.dirname(process.execPath), ...(process.env.PATH || process.env.Path || "").split(path.delimiter)];
  for (const dir of dirs.filter(Boolean)) {
    const p = path.join(dir, "npm.cmd");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function defaultSpawnLines(command: string, args: string[], opts: { windowsVerbatimArguments?: boolean }, onLine: (l: string) => void) {
  const child = spawn(command, args, { windowsHide: true, windowsVerbatimArguments: opts.windowsVerbatimArguments });
  let pending = "";
  const feed = (chunk: unknown): void => {
    pending += String(chunk);
    let nl: number;
    while ((nl = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, nl).replace(/\r$/, "");
      pending = pending.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  };
  child.stdout?.on("data", feed);
  child.stderr?.on("data", feed);
  const done = new Promise<number | null>((resolve) => {
    child.on("error", (err) => {
      onLine(err.message);
      resolve(null);
    });
    child.on("close", (code) => {
      if (pending.trim()) onLine(pending.trim());
      resolve(code);
    });
  });
  return { done, kill: () => killProcessTree(child.pid) };
}

export function createInstaller(over: Partial<InstallDeps> = {}): Installer {
  const deps: InstallDeps = {
    platform: over.platform ?? process.platform,
    npmPath: over.npmPath ?? defaultNpmPath,
    spawnLines: over.spawnLines ?? defaultSpawnLines,
  };
  let current: { kill(): void } | null = null;
  let running = false;

  return {
    isRunning: () => running,
    stop: () => current?.kill(),
    async run(engine, onEvent) {
      if (deps.platform !== "win32") {
        return { ok: false, message: `Automatic install is Windows only. Run this yourself: ${engine.install.map(installDisplay).join(" && ")}` };
      }
      running = true;
      try {
        for (const [index, step] of engine.install.entries()) {
          onEvent({ type: "step", index, label: step.label, display: installDisplay(step) });
          let command: string;
          let args: string[];
          let verbatim = false;
          if (step.kind === "npm") {
            const npm = deps.npmPath();
            if (!npm) return { ok: false, message: "npm wasn't found. Install Node.js from nodejs.org, then try again." };
            const inv = buildWindowsShellInvocation(npm, step.args);
            command = inv.command;
            args = inv.args;
            verbatim = true;
          } else {
            command = "powershell.exe";
            args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", step.script];
          }
          const proc = deps.spawnLines(command, args, { windowsVerbatimArguments: verbatim }, (text) => onEvent({ type: "line", text }));
          current = proc;
          const code = await proc.done;
          current = null;
          if (code !== 0) return { ok: false, message: `${step.label} failed (exit code ${code ?? "none"}).` };
        }
        return { ok: true };
      } finally {
        running = false;
        current = null;
      }
    },
  };
}
```

```ts
// app/server/services/assistant/engines/jobs.ts
/** The long-running engine jobs the app must know about: busy (no idle stop, no update) and shutdown. */
import { createInstaller, type Installer } from "./install.ts";

export interface EngineJobs {
  installer: Installer;
  busy(): boolean;
  stopAll(): void;
}

export function createEngineJobs(parts: { installer?: Installer } = {}): EngineJobs {
  const installer = parts.installer ?? createInstaller();
  return {
    installer,
    busy: () => installer.isRunning(),
    stopAll: () => installer.stop(),
  };
}
```

- [ ] **Step 4: Route + wiring**

`routes/assistant.ts`:
- Import `createEngineJobs, type EngineJobs` from `jobs.ts`.
- `AssistantRouterOpts.jobs?: EngineJobs;` and, right after `const states = …` in the factory,
  `const jobs = opts.jobs ?? createEngineJobs();`.
- Add the route:

```ts
  router.post("/engines/:id/install", async (req, res) => {
    const id = req.params.id;
    const engine = isEngineId(id) ? registry.get(id) : undefined;
    if (!engine) {
      res.status(404).json({ error: "unknown provider" });
      return;
    }
    if (jobs.installer.isRunning()) {
      res.status(409).json({ error: "an install is already running" });
      return;
    }
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.flushHeaders?.();
    const write = (e: InstallEvent): void => {
      if (!res.writableEnded) res.write(`${JSON.stringify(e)}\n`);
    };
    const r = await jobs.installer.run(engine, write);
    states.invalidate(engine.id);
    const view = await states.view(engine.id, { refresh: true });
    const found = Boolean(view?.installed);
    write({
      type: "done",
      ok: r.ok && found,
      ...(view?.version ? { version: view.version } : {}),
      ...(!r.ok
        ? { message: r.message }
        : found
          ? {}
          : { message: "Installed, but Skill Vault can't find it yet. Close and reopen Skill Vault, then check again." }),
    });
    res.end();
  });
```

  Add `import type { InstallEvent } from "../services/assistant/engines/install.ts";`.

`server/index.ts`:
- `import { createEngineJobs } from "./services/assistant/engines/jobs.ts";`
- Create `const engineJobs = createEngineJobs();` before `busyWithoutUpdate`.
- Add `|| engineJobs.busy()` to the `busyWithoutUpdate` expression.
- Pass `jobs: engineJobs` in the `assistantRouter({ … })` call.
- Next to `abortAllTurns();` in the shutdown hook, add `engineJobs.stopAll();`.

- [ ] **Step 5: Run the tests**

Run: `node --import tsx --test server/services/assistant/engines/install.test.ts server/routes/assistant.test.ts` then `npm test` and `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/assistant/engines server/routes server/index.ts
git commit -m "assistant: install a provider's CLI from the app (streamed, one at a time, holds off idle stop)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Sign-in window (`engines/signIn.ts`, routes)

**Files:**
- Create: `app/server/services/assistant/engines/signIn.ts`
- Modify: `app/server/services/assistant/engines/jobs.ts`, `app/server/routes/assistant.ts`
- Test: `app/server/services/assistant/engines/signIn.test.ts`, `app/server/routes/assistant.test.ts`

**Interfaces:**
- Consumes: `SpawnTarget`, `killProcessTree` (Task 2); `AssistantEngine.cliName`, `loginArgs`,
  `loginEnv`, `childEnv`, `target`, `label`, `id` (Task 4); `fakeEngine` (Task 8; `cliName "codex"`,
  `loginArgs ["login"]`, `loginHint "Do the thing."`); `EngineJobs` / `createEngineJobs` (Task 13);
  `ViewOpts.mode` and `GET /engines/:id?mode=` (Task 8); `isLoopbackRequest` (`routes/sameOrigin.ts`).
- Produces:
  - `powershellLoginCommand(title: string, target: SpawnTarget, args: string[]): string`
  - `interface SignInDeps { platform; openWindow(title, command, env): { close(): void } | { error: string }; setTimer(fn, ms): { cancel(): void } }`
  - `type SignInRefusal = { error: string; reason: "unsupported" | "not_installed" | "spawn_failed" }`
  - `interface SignInManager { pending(): boolean; current(): EngineId | null; start(engine, env): { started: true } | SignInRefusal; finish(id): void; cancel(): void }`
  - `createSignInManager(deps?: Partial<SignInDeps>)`
  - `SIGN_IN_TIMEOUT_MS = 600_000`
  - `EngineJobs.signIn: SignInManager`; `createEngineJobs(parts?: { installer?; signIn? })`
  - Routes: `POST /engines/:id/login` → `{ started: true, hint }`, 403 for a non-loopback request, 409
    for `unsupported` / `not_installed`, 500 with the message when the window didn't open;
    `POST /engines/:id/login/cancel` → `{ ok: true }`. `GET /engines/:id` closes the window once the
    view reports `auth.mode === "login"` and `signed_in === true` (a status for the other mode never
    closes it).

- [ ] **Step 1: Write the failing tests**

```ts
// app/server/services/assistant/engines/signIn.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSignInManager, powershellLoginCommand } from "./signIn.ts";
import { fakeEngine } from "./testFakes.ts";

test("powershellLoginCommand quotes every piece and sets the title", () => {
  assert.equal(
    powershellLoginCommand("Sign in to O'Brien CLI", { command: "C:\\node\\node.exe", prefixArgs: ["C:\\npm\\x.js"], label: "x" }, ["login"]),
    "$Host.UI.RawUI.WindowTitle = 'Sign in to O''Brien CLI'; & 'C:\\node\\node.exe' 'C:\\npm\\x.js' 'login'",
  );
});

test("start opens one window; a second start replaces it; cancel and timeout close it", () => {
  const opened: Array<{ title: string; command: string; closed: boolean }> = [];
  let fire: () => void = () => {};
  const m = createSignInManager({
    platform: "win32",
    openWindow: (title, command) => {
      const w = { title, command, closed: false };
      opened.push(w);
      return { close: () => (w.closed = true) };
    },
    setTimer: (fn) => {
      fire = fn;
      return { cancel: () => (fire = () => {}) };
    },
  });
  assert.deepEqual(m.start(fakeEngine(), {}), { started: true });
  assert.equal(opened[0].title, "Sign in to Fake Codex");
  assert.match(opened[0].command, /'login'$/);
  assert.equal(m.current(), "codex");
  m.start(fakeEngine(), {});
  assert.equal(opened[0].closed, true);
  m.cancel();
  assert.equal(opened[1].closed, true);
  assert.equal(m.pending(), false);
  m.start(fakeEngine(), {});
  fire();
  assert.equal(opened[2].closed, true);
  assert.equal(m.pending(), false);
});

test("start refuses an engine that isn't installed, a window that didn't open, and non-Windows", () => {
  const m = createSignInManager({ platform: "win32", openWindow: () => ({ close: () => {} }), setTimer: () => ({ cancel: () => {} }) });
  const r = m.start(fakeEngine({ target: () => null }), {});
  assert.ok("error" in r && /isn't installed/.test(r.error) && r.reason === "not_installed");
  assert.equal(m.pending(), false);
  const broken = createSignInManager({ platform: "win32", openWindow: () => ({ error: "Couldn't open the sign-in window: spawn powershell.exe ENOENT" }), setTimer: () => ({ cancel: () => {} }) });
  assert.deepEqual(broken.start(fakeEngine(), {}), { error: "Couldn't open the sign-in window: spawn powershell.exe ENOENT", reason: "spawn_failed" });
  assert.equal(broken.pending(), false);
  const mac = createSignInManager({ platform: "darwin", openWindow: () => ({ close: () => {} }), setTimer: () => ({ cancel: () => {} }) });
  assert.deepEqual(mac.start(fakeEngine(), {}), { error: 'Sign-in from the app is Windows only. Run "codex login" in a terminal.', reason: "unsupported" });
});
```

Append to `routes/assistant.test.ts`:

```ts
/** A sign-in manager whose window is recorded instead of opened. */
async function signInHarness(over: { openWindow?: () => { close(): void } | { error: string } } = {}) {
  const { createSignInManager } = await import("../services/assistant/engines/signIn.ts");
  const { createEngineJobs } = await import("../services/assistant/engines/jobs.ts");
  const win = { opened: 0, closed: 0 };
  const signIn = createSignInManager({
    platform: "win32",
    openWindow: over.openWindow ?? (() => (win.opened++, { close: () => void win.closed++ })),
    setTimer: () => ({ cancel: () => {} }),
  });
  return { win, jobs: createEngineJobs({ signIn }) };
}

test("login: opens the window, and the window closes once the engine reports signed in", async () => {
  let signedIn = false;
  const { win, jobs } = await signInHarness();
  const engine = fakes.fakeEngine({ authStatus: async () => ({ signed_in: signedIn, method: "login" }) });
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry: reg.createRegistry([engine]), jobs }));
  assert.deepEqual(await (await fetch(`${base}/engines/codex/login`, send("POST", {}))).json(), { started: true, hint: "Do the thing." });
  assert.equal(win.opened, 1);
  await fetch(`${base}/engines/codex?refresh=1`);
  assert.equal(win.closed, 0);
  signedIn = true;
  await fetch(`${base}/engines/codex?refresh=1&mode=login`);
  assert.equal(win.closed, 1);
});

test("login/cancel closes the window", async () => {
  const { win, jobs } = await signInHarness();
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry: reg.createRegistry([fakes.fakeEngine()]), jobs }));
  await fetch(`${base}/engines/codex/login`, send("POST", {}));
  assert.equal(jobs.signIn.pending(), true);
  assert.deepEqual(await (await fetch(`${base}/engines/codex/login/cancel`, send("POST", {}))).json(), { ok: true });
  assert.equal(win.closed, 1);
  assert.equal(jobs.signIn.pending(), false);
});

test("login: a request whose Host isn't this PC gets 403 and no window", async () => {
  const { win, jobs } = await signInHarness();
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry: reg.createRegistry([fakes.fakeEngine()]), jobs }));
  // fetch can't set Host; a raw request can.
  const http = (await import("node:http")).default;
  const u = new URL(`${base}/engines/codex/login`);
  const res = await new Promise<{ status: number; body: { error?: string } }>((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { Host: "evil.example", "content-type": "application/json" } },
      (r) => {
        let data = "";
        r.on("data", (d) => (data += d));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, body: JSON.parse(data || "{}") }));
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
  assert.equal(res.status, 403);
  assert.match(res.body.error ?? "", /only be started from this PC/);
  assert.equal(win.opened, 0);
});

test("login: a window that fails to open answers 500 with the reason", async () => {
  const { jobs } = await signInHarness({ openWindow: () => ({ error: "Couldn't open the sign-in window: powershell.exe didn't start." }) });
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry: reg.createRegistry([fakes.fakeEngine()]), jobs }));
  const res = await fetch(`${base}/engines/codex/login`, send("POST", {}));
  assert.equal(res.status, 500);
  assert.match(((await res.json()) as { error: string }).error, /powershell\.exe didn't start/);
  assert.equal(jobs.signIn.pending(), false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import tsx --test server/services/assistant/engines/signIn.test.ts server/routes/assistant.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `signIn.ts` and extend `jobs.ts`**

```ts
// app/server/services/assistant/engines/signIn.ts
/**
 * The sign-in window: a visible PowerShell console running the engine's own
 * login command (`claude auth login`, `codex login`, `copilot login`,
 * `grok login`), so each tool handles its own browser or device-code step
 * the way it expects to — Copilot's device code needs a real terminal.
 * The command is built only from the resolved executable and the engine's
 * fixed args. One window at a time; it closes on success (GET /engines/:id
 * sees signed_in), on Cancel, or after 10 minutes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { killProcessTree, type SpawnTarget } from "./exe.ts";
import type { AssistantEngine, EngineId } from "./types.ts";

export const SIGN_IN_TIMEOUT_MS = 600_000;

const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export function powershellLoginCommand(title: string, target: SpawnTarget, args: string[]): string {
  return `$Host.UI.RawUI.WindowTitle = ${psQuote(title)}; & ${[target.command, ...target.prefixArgs, ...args].map(psQuote).join(" ")}`;
}

export interface SignInDeps {
  platform: NodeJS.Platform;
  /** Opens the window, or says why it couldn't. */
  openWindow(title: string, command: string, env: NodeJS.ProcessEnv): { close(): void } | { error: string };
  setTimer(fn: () => void, ms: number): { cancel(): void };
}

/** Why start() refused: the route answers 409 for the first two and 500 for a window that didn't open. */
export type SignInRefusal = { error: string; reason: "unsupported" | "not_installed" | "spawn_failed" };

export interface SignInManager {
  pending(): boolean;
  current(): EngineId | null;
  start(engine: AssistantEngine, env: NodeJS.ProcessEnv): { started: true } | SignInRefusal;
  finish(id: EngineId): void;
  cancel(): void;
}

function defaultOpenWindow(_title: string, command: string, env: NodeJS.ProcessEnv): { close(): void } | { error: string } {
  let child: ChildProcess;
  try {
    // detached on Windows = the child gets its own (visible) console window.
    child = spawn("powershell.exe", ["-NoProfile", "-NoExit", "-Command", command], {
      detached: true,
      windowsHide: false,
      stdio: "ignore",
      env,
    });
  } catch (err) {
    return { error: `Couldn't open the sign-in window: ${(err as Error).message}` };
  }
  // A launch that failed (powershell.exe missing or blocked) has no pid; its "error" event follows a tick later.
  child.on("error", () => {});
  if (typeof child.pid !== "number") return { error: "Couldn't open the sign-in window: powershell.exe didn't start." };
  child.unref();
  return { close: () => killProcessTree(child.pid) };
}

export function createSignInManager(over: Partial<SignInDeps> = {}): SignInManager {
  const deps: SignInDeps = {
    platform: over.platform ?? process.platform,
    openWindow: over.openWindow ?? defaultOpenWindow,
    setTimer:
      over.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return { cancel: () => clearTimeout(t) };
      }),
  };
  let current: { id: EngineId; close(): void; timer: { cancel(): void } } | null = null;

  const close = (): void => {
    if (!current) return;
    current.timer.cancel();
    current.close();
    current = null;
  };

  return {
    pending: () => current !== null,
    current: () => current?.id ?? null,
    start(engine, env) {
      if (deps.platform !== "win32") {
        const command = `${engine.cliName} ${engine.loginArgs.join(" ")}`.trim();
        return { error: `Sign-in from the app is Windows only. Run "${command}" in a terminal.`, reason: "unsupported" };
      }
      const target = engine.target();
      if (!target) return { error: `${engine.label} isn't installed — install it first.`, reason: "not_installed" };
      close();
      const title = `Sign in to ${engine.label}`;
      const win = deps.openWindow(title, powershellLoginCommand(title, target, engine.loginArgs), env);
      if ("error" in win) return { error: win.error, reason: "spawn_failed" };
      const timer = deps.setTimer(close, SIGN_IN_TIMEOUT_MS);
      current = { id: engine.id, close: win.close, timer };
      return { started: true };
    },
    finish(id) {
      if (current?.id === id) close();
    },
    cancel: close,
  };
}
```

`jobs.ts` becomes:

```ts
// app/server/services/assistant/engines/jobs.ts
/** The long-running engine jobs the app must know about: busy (no idle stop, no update) and shutdown. */
import { createInstaller, type Installer } from "./install.ts";
import { createSignInManager, type SignInManager } from "./signIn.ts";

export interface EngineJobs {
  installer: Installer;
  signIn: SignInManager;
  busy(): boolean;
  stopAll(): void;
}

export function createEngineJobs(parts: { installer?: Installer; signIn?: SignInManager } = {}): EngineJobs {
  const installer = parts.installer ?? createInstaller();
  const signIn = parts.signIn ?? createSignInManager();
  return {
    installer,
    signIn,
    busy: () => installer.isRunning() || signIn.pending(),
    stopAll: () => {
      installer.stop();
      signIn.cancel();
    },
  };
}
```

- [ ] **Step 4: Routes**

In `routes/assistant.ts`, extend the `./sameOrigin.ts` import with `isLoopbackRequest` and add:

```ts
  router.post("/engines/:id/login", (req, res) => {
    const id = req.params.id;
    const engine = isEngineId(id) ? registry.get(id) : undefined;
    if (!engine) {
      res.status(404).json({ error: "unknown provider" });
      return;
    }
    if (!isLoopbackRequest(req)) {
      res.status(403).json({ error: "sign-in can only be started from this PC" });
      return;
    }
    const env = { ...engine.childEnv({ auth: "login" }, process.env), ...engine.loginEnv() };
    const r = jobs.signIn.start(engine, env);
    if ("error" in r) {
      res.status(r.reason === "spawn_failed" ? 500 : 409).json({ error: r.error });
      return;
    }
    states.invalidate(engine.id);
    res.json({ started: true, hint: engine.loginHint });
  });

  router.post("/engines/:id/login/cancel", (_req, res) => {
    jobs.signIn.cancel();
    res.json({ ok: true });
  });
```

In `GET /engines/:id`, after the `if (!view) { … }` block and before `res.json(view)`, add:

```ts
    if (view.auth.mode === "login" && view.auth.signed_in === true && jobs.signIn.current() === view.id) jobs.signIn.finish(view.id);
```

`jobs` is created next to `states` (Task 13), above the routes.

- [ ] **Step 5: Run the tests**

Run: `node --import tsx --test server/services/assistant/engines/signIn.test.ts server/routes/assistant.test.ts` then `npm test` and `npm run typecheck`
Expected: PASS (3 signIn tests; 4 new route tests: window closes on sign-in, cancel, non-loopback 403,
failed window 500). The type-check passes too: `fire` is declared as a function, never `null`.

- [ ] **Step 6: Commit**

```bash
git add server/services/assistant/engines server/routes/assistant.ts server/routes/assistant.test.ts
git commit -m "assistant: sign in to a provider from the app (its own login in a window, closed when done)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Client API, Modal, install and sign-in dialogs

**Files:**
- Modify: `app/client/src/lib/api.ts` (`readNdjson`), `app/client/src/lib/assistant.ts`,
  `app/client/src/lib/setup.ts` and `app/client/src/lib/appUpdate.ts` (both switch to `readNdjson`)
- Create: `app/client/src/components/ui/Modal.tsx`, `app/client/src/components/assistant/EngineInstallDialog.tsx`, `app/client/src/components/assistant/EngineSignInDialog.tsx`

**Interfaces:**
- Consumes: the routes from Tasks 8, 13, 14, including `GET /engines/:id?mode=login` (Task 8).
- Produces (`lib/api.ts`): `readNdjson<T>(res: Response, onEvent: (e: T) => void): Promise<void>` — the
  one NDJSON body reader (the caller checks `res.ok` first). `lib/assistant.ts`'s `streamTurn` keeps its
  own tolerant reader (it skips malformed lines and flushes an unterminated last line).
- Produces (`lib/assistant.ts`):
  - `type EngineId = "claude" | "codex" | "copilot" | "grok"`, `ENGINE_SHORT: Record<EngineId, string>`
  - `interface EngineView` (mirrors the server)
  - `type InstallEvent`
  - `engineReady(v: EngineView): boolean`
  - `assistantApi.engines(refresh?)`, `.engine(id, refresh?, mode?: "login" | "api_key")`, `.setEngine(id)`,
    `.setEngineAuth(id, body)`, `.login(id)`, `.cancelLogin(id)`
  - `installEngine(id, onEvent): Promise<void>`
  - `AssistantStatus` gains `engine: EngineId; label: string`; `SessionSummary` and
    `SessionDetail.session` gain `engine: EngineId`; the `session` stream event gains `engine?`.
- Produces (components):
  - `Modal({ title, busy?, onClose, children, width? })`
  - `EngineInstallDialog({ engine, onClose, onInstalled, onSignedIn? })` — when the install finishes and
    the provider's auth mode is login (and it isn't signed in yet), the dialog hands off straight to
    `EngineSignInDialog`; `onSignedIn` is called when that sign-in finishes, `onClose` when either
    dialog closes.
  - `EngineSignInDialog({ engine, onClose, onSignedIn })` — polls `assistantApi.engine(id, true, "login")`
    and finishes only on a view with `auth.mode === "login"` and `signed_in === true`.

- [ ] **Step 1: Add `readNdjson` (`lib/api.ts`) and use it in `lib/setup.ts` and `lib/appUpdate.ts`**

In `lib/api.ts`, add after the `ApiError` class:

```ts
/**
 * Reads an NDJSON response body to its end, calling onEvent once per line.
 * The caller checks `res.ok` first (an error response isn't NDJSON).
 */
export async function readNdjson<T>(res: Response, onEvent: (e: T) => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as T);
    }
  }
}
```

In `lib/setup.ts`, change the import to `import { ApiError, readNdjson } from "./api";` and replace the
`const reader = …` through the end of the `for (;;) { … }` loop inside `stream()` with
`await readNdjson<SetupEvent>(res, onEvent);`. In `lib/appUpdate.ts`, change the import the same way and
replace the same loop inside `appUpdateApi.apply` with `await readNdjson<ApplyEvent>(res, onEvent);`.
Both keep their existing `if (!res.ok || !res.body) …` checks. Behavior is unchanged.

- [ ] **Step 2: Extend `lib/assistant.ts`**

Change the import to `import { ApiError, readNdjson } from "./api";`. Change the session member of
`AssistantStreamEvent` to
`| { type: "session"; session_id: string; engine?: EngineId }`. Add `engine: EngineId;` to
`SessionSummary` and to `SessionDetail["session"]`. Add `engine: EngineId; label: string;` to
`AssistantStatus`. Then add:

```ts
// ── Providers (engines) ──────────────────────────────────────────

export type EngineId = "claude" | "codex" | "copilot" | "grok";

/** Short names for badges. */
export const ENGINE_SHORT: Record<EngineId, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
  grok: "Grok",
};

export interface EngineView {
  id: EngineId;
  label: string;
  selected: boolean;
  installed: boolean;
  version: string | null;
  verified_version: string;
  reason: string | null;
  subagents: boolean;
  auth: { mode: "login" | "api_key"; signed_in: boolean | null; account: string | null; has_saved_key: boolean; env_key_present: boolean };
  install: { label: string; display: string; source: string }[];
  login_hint: string;
}

export type InstallEvent =
  | { type: "step"; index: number; label: string; display: string }
  | { type: "line"; text: string }
  | { type: "done"; ok: boolean; version?: string; message?: string };

/** Mirrors the server's readiness rule (engines/state.ts ready()). */
export function engineReady(v: EngineView): boolean {
  if (!v.installed) return false;
  if (v.auth.mode === "api_key") return v.auth.has_saved_key || v.auth.env_key_present;
  return v.auth.signed_in !== false;
}

/** Streams POST /engines/:id/install until the server ends it. */
export async function installEngine(id: EngineId, onEvent: (e: InstallEvent) => void): Promise<void> {
  const res = await fetch(`/api/assistant/engines/${id}/install`, { method: "POST" });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let message = `Install failed to start (${res.status})`;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? message;
    } catch {
      /* not JSON */
    }
    throw new ApiError(message, res.status, null);
  }
  await readNdjson<InstallEvent>(res, onEvent);
}
```

In `assistantApi` add:

```ts
  engines: (refresh?: boolean) => rest<{ engines: EngineView[] }>("GET", `/api/assistant/engines${refresh ? "?refresh=1" : ""}`),
  /** mode: report sign-in for that mode rather than the saved one (the sign-in dialog asks for "login"). */
  engine: (id: EngineId, refresh?: boolean, mode?: "login" | "api_key") => {
    const q = new URLSearchParams({ ...(refresh ? { refresh: "1" } : {}), ...(mode ? { mode } : {}) }).toString();
    return rest<EngineView>("GET", `/api/assistant/engines/${id}${q ? `?${q}` : ""}`);
  },
  setEngine: (id: EngineId) => rest<{ engine: EngineId }>("PUT", "/api/assistant/engine", { engine: id }),
  /** An omitted field is kept; an empty string clears it. */
  setEngineAuth: (id: EngineId, body: { auth?: "login" | "api_key"; api_key?: string; workspace_id?: string }) =>
    rest<EngineView>("PUT", `/api/assistant/engines/${id}/auth`, body),
  login: (id: EngineId) => rest<{ started: true; hint: string }>("POST", `/api/assistant/engines/${id}/login`),
  cancelLogin: (id: EngineId) => rest<{ ok: true }>("POST", `/api/assistant/engines/${id}/login/cancel`),
```

`EngineId` is declared below its first use in the earlier interfaces. Type declarations hoist, so this is
fine.

- [ ] **Step 3: Write `Modal.tsx`**

```tsx
// app/client/src/components/ui/Modal.tsx
/**
 * A plain modal: dimmed backdrop, focus moved in and trapped, Escape and
 * backdrop click close it (unless busy), focus returned to the opener.
 */
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export function Modal({
  title,
  busy = false,
  onClose,
  children,
  width = 520,
}: {
  title: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const trapTab = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab" || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      e.preventDefault();
      panel.current.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!panel.current.contains(active) || (e.shiftKey && (active === first || active === panel.current))) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      onClick={() => !busy && onClose()}
      onKeyDown={trapTab}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "grid", placeItems: "center", zIndex: 50 }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: `min(${width}px, calc(100vw - 32px))`,
          maxHeight: "calc(100vh - 64px)",
          overflow: "auto",
          background: "var(--surface)",
          border: "0.5px solid var(--border)",
          borderRadius: 10,
          padding: "18px 20px",
          outline: 0,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          fontSize: 13,
          color: "var(--ink-2)",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{title}</div>
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write `EngineInstallDialog.tsx`**

```tsx
// app/client/src/components/assistant/EngineInstallDialog.tsx
/**
 * Confirm → install (streamed output) → installed, or what failed with the
 * command to run yourself. When the provider signs in with an account and
 * isn't signed in yet, a finished install goes straight on to the sign-in
 * dialog.
 */
import { useState } from "react";
import { assistantApi, installEngine, type EngineView } from "../../lib/assistant";
import { Button } from "../ui/primitives";
import { Modal } from "../ui/Modal";
import { EngineSignInDialog } from "./EngineSignInDialog";

type Phase = "confirm" | "running" | "done" | "failed" | "signin";

const logStyle = {
  fontFamily: "var(--mono)",
  fontSize: 11.5,
  background: "var(--bg)",
  border: "0.5px solid var(--border)",
  borderRadius: 6,
  padding: "8px 10px",
  maxHeight: 220,
  overflow: "auto",
  whiteSpace: "pre-wrap" as const,
  color: "var(--ink-2)",
};

const errorText = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

export function EngineInstallDialog({
  engine,
  onClose,
  onInstalled,
  onSignedIn,
}: {
  engine: EngineView;
  onClose: () => void;
  onInstalled: (view: EngineView) => void;
  /** Called when the sign-in that follows the install finishes. */
  onSignedIn?: (view: EngineView) => void;
}) {
  const [phase, setPhase] = useState<Phase>("confirm");
  const [lines, setLines] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [installed, setInstalled] = useState<EngineView | null>(null);
  const commands = engine.install.map((s) => s.display).join("\n");
  const sources = [...new Set(engine.install.map((s) => s.source))].join(", ");

  /** The install is done: report it, then sign in if the provider uses an account login. */
  const finish = (view: EngineView) => {
    setInstalled(view);
    setVersion(view.version);
    onInstalled(view);
    setPhase(view.auth.mode === "login" && view.auth.signed_in !== true ? "signin" : "done");
  };

  const run = async () => {
    setPhase("running");
    setLines([]);
    setMessage(null);
    let ok = false;
    try {
      await installEngine(engine.id, (e) => {
        if (e.type === "line") setLines((xs) => [...xs.slice(-199), e.text]);
        if (e.type === "step") setLines((xs) => [...xs, `> ${e.display}`]);
        if (e.type === "done") {
          ok = e.ok;
          setVersion(e.version ?? null);
          setMessage(e.message ?? null);
        }
      });
    } catch (err) {
      setMessage(errorText(err, "The install didn't start."));
    }
    if (!ok) {
      setPhase("failed");
      return;
    }
    try {
      finish(await assistantApi.engine(engine.id, true));
    } catch (err) {
      // Installed, but the fresh state didn't load: say so and skip the hand-off.
      setMessage(errorText(err, "Couldn't check the provider again."));
      setPhase("done");
    }
  };

  const checkAgain = async () => {
    try {
      const view = await assistantApi.engine(engine.id, true);
      if (view.installed) finish(view);
      else setMessage("Still not found.");
    } catch (err) {
      setMessage(errorText(err, "Couldn't check the provider again."));
    }
  };

  if (phase === "signin" && installed) {
    return <EngineSignInDialog engine={installed} onClose={onClose} onSignedIn={(v) => onSignedIn?.(v)} />;
  }

  return (
    <Modal title={`Install ${engine.label}`} busy={phase === "running"} onClose={onClose}>
      {phase === "confirm" && (
        <>
          <p style={{ margin: 0 }}>
            This installs a program on this PC. Skill Vault will run, from {sources}:
          </p>
          <pre style={logStyle}>{commands}</pre>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button kind="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button kind="primary" size="sm" onClick={() => void run()}>Install</Button>
          </div>
        </>
      )}
      {phase !== "confirm" && <pre style={logStyle}>{(phase === "failed" ? lines.slice(-20) : lines).join("\n") || "Starting…"}</pre>}
      {phase === "done" && (
        <>
          <p style={{ margin: 0, color: "var(--ok)" }}>Installed{version ? ` — ${version}` : ""}.</p>
          {message && <p style={{ margin: 0, color: "var(--warn)" }}>{message}</p>}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button kind="primary" size="sm" onClick={onClose}>Continue</Button>
          </div>
        </>
      )}
      {phase === "failed" && (
        <>
          <p style={{ margin: 0, color: "var(--warn)" }}>{message ?? "The install didn't finish."}</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button kind="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(commands)}>Copy command</Button>
            <Button kind="ghost" size="sm" onClick={() => void checkAgain()}>Check again</Button>
            <Button kind="default" size="sm" onClick={() => void run()}>Try again</Button>
            <Button kind="ghost" size="sm" onClick={onClose}>Close</Button>
          </div>
        </>
      )}
    </Modal>
  );
}
```

- [ ] **Step 5: Write `EngineSignInDialog.tsx`**

```tsx
// app/client/src/components/assistant/EngineSignInDialog.tsx
/**
 * Starts the provider's own login in a window on this PC, then checks every
 * 2 s (up to 10 min) until the provider reports signed in. Cancel closes the
 * window.
 */
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../lib/api";
import { assistantApi, type EngineView } from "../../lib/assistant";
import { Button } from "../ui/primitives";
import { Modal } from "../ui/Modal";

const POLL_MS = 2000;
const GIVE_UP_MS = 600_000;

export function EngineSignInDialog({
  engine,
  onClose,
  onSignedIn,
}: {
  engine: EngineView;
  onClose: () => void;
  onSignedIn: (view: EngineView) => void;
}) {
  const [state, setState] = useState<"starting" | "waiting" | "done" | "timeout" | "error">("starting");
  const [hint, setHint] = useState(engine.login_hint);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const started = Date.now();
    const poll = async () => {
      if (!live.current) return;
      if (Date.now() - started > GIVE_UP_MS) {
        setState("timeout");
        void assistantApi.cancelLogin(engine.id).catch(() => {});
        return;
      }
      try {
        // Ask for the login status itself: the saved mode may still be "api_key" (the setup guide saves on Finish).
        const view = await assistantApi.engine(engine.id, true, "login");
        if (view.auth.mode === "login" && view.auth.signed_in === true) {
          setAccount(view.auth.account);
          setState("done");
          onSignedIn(view);
          return;
        }
      } catch {
        /* keep polling */
      }
      timer = setTimeout(() => void poll(), POLL_MS);
    };
    setState("starting");
    assistantApi
      .login(engine.id)
      .then((r) => {
        if (!live.current) return;
        setHint(r.hint);
        setState("waiting");
        timer = setTimeout(() => void poll(), POLL_MS);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Couldn't start the sign-in");
        setState("error");
      });
    return () => {
      live.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [engine.id, attempt]);

  const cancel = () => {
    if (state === "starting" || state === "waiting") void assistantApi.cancelLogin(engine.id).catch(() => {});
    onClose();
  };

  return (
    <Modal title={`Sign in to ${engine.label}`} onClose={cancel}>
      {(state === "starting" || state === "waiting") && (
        <>
          <p style={{ margin: 0 }}>Finish signing in in the window that opened.</p>
          <p style={{ margin: 0, color: "var(--ink-3)" }}>{hint}</p>
          <p style={{ margin: 0, fontSize: 12, color: "var(--ink-3)" }}>Waiting for {engine.label} to report you're signed in…</p>
        </>
      )}
      {state === "done" && <p style={{ margin: 0, color: "var(--ok)" }}>Signed in{account ? ` as ${account}` : ""}.</p>}
      {state === "timeout" && <p style={{ margin: 0, color: "var(--warn)" }}>Didn't see a sign-in — try again.</p>}
      {state === "error" && <p style={{ margin: 0, color: "var(--warn)" }}>{error}</p>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        {(state === "timeout" || state === "error") && (
          <Button kind="default" size="sm" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
        )}
        <Button kind={state === "done" ? "primary" : "ghost"} size="sm" onClick={state === "done" ? onClose : cancel}>
          {state === "done" ? "Done" : "Cancel"}
        </Button>
      </div>
    </Modal>
  );
}
```

The `Button` props used here (`kind`, `size`, `onClick`, `disabled`, `icon`) match
`components/ui/primitives.tsx`. The repo has no eslint, so there is no `exhaustive-deps` comment on the
effect: it re-runs only for `engine.id` and `attempt` on purpose.

- [ ] **Step 6: Type-check and build**

Run: `npm run typecheck` then `npm run build`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/lib/api.ts client/src/lib/setup.ts client/src/lib/appUpdate.ts client/src/lib/assistant.ts client/src/components/ui/Modal.tsx client/src/components/assistant/EngineInstallDialog.tsx client/src/components/assistant/EngineSignInDialog.tsx
git commit -m "client: provider API, install and sign-in dialogs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Settings → AI assistant: the Provider list

**Files:**
- Create: `app/client/src/components/assistant/ClaudeSignIn.tsx`, `app/client/src/components/assistant/ProviderSettings.tsx`
- Modify: `app/client/src/pages/Settings.tsx`

**Interfaces:**
- Consumes: Task 15 (`EngineView`, `assistantApi.engines/setEngine/setEngineAuth`, both dialogs —
  `EngineInstallDialog` takes `onSignedIn` for its hand-off to sign-in).
- Produces: `ClaudeSignIn()` (moved, unchanged behavior) and `ProviderSettings()`. Each installed row
  shows its version with "checked with <verified_version>" as visible text, so CLI drift is visible.

- [ ] **Step 1: Move the Claude panel**

Cut `AUTH_FIELD_STYLE` and `function AssistantSignIn()` out of `Settings.tsx` into
`components/assistant/ClaudeSignIn.tsx`. Export it as `export function ClaudeSignIn()` and export
`AUTH_FIELD_STYLE` too. Bring its imports (`useEffect`, `useState`, `useMutation`, `useQuery`,
`useQueryClient`, `toast` from `sonner`, `ApiError` from `../../lib/api`, `assistantApi` from
`../../lib/assistant`, `Button` from `../ui/primitives`). Its body stays the same, with one addition:
in `onSuccess`, also call `qc.invalidateQueries({ queryKey: ["assistant-engines"] })` and
`qc.invalidateQueries({ queryKey: ["assistant-status"] })`.

- [ ] **Step 2: Write `ProviderSettings.tsx`**

```tsx
// app/client/src/components/assistant/ProviderSettings.tsx
/**
 * Settings → AI assistant → Provider: which CLI runs new assistant chats,
 * whether it's installed and signed in, and how it signs in. Claude keeps
 * its existing panel (login vs API key + workspace ID).
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "../../lib/api";
import { assistantApi, type EngineView } from "../../lib/assistant";
import { Button } from "../ui/primitives";
import { AUTH_FIELD_STYLE, ClaudeSignIn } from "./ClaudeSignIn";
import { EngineInstallDialog } from "./EngineInstallDialog";
import { EngineSignInDialog } from "./EngineSignInDialog";

const KEY_PLACEHOLDER: Record<string, string> = {
  codex: "OpenAI API key (sk-…)",
  copilot: "GitHub fine-grained token with Copilot Requests (github_pat_…)",
  grok: "xAI API key (xai-…)",
};

function stateText(v: EngineView): string {
  if (!v.installed) return "Not installed";
  if (v.auth.mode === "api_key") return v.auth.has_saved_key ? "API key saved" : v.auth.env_key_present ? "API key from environment" : "No API key";
  if (v.auth.signed_in === true) return v.auth.account ? `Signed in as ${v.auth.account}` : "Signed in";
  if (v.auth.signed_in === false) return "Not signed in";
  return `Installed ${v.version ?? ""}`.trim();
}

export function ProviderSettings() {
  const qc = useQueryClient();
  const { data, refetch, isFetching } = useQuery({ queryKey: ["assistant-engines"], queryFn: () => assistantApi.engines() });
  const [dialog, setDialog] = useState<{ kind: "install" | "signin"; engine: EngineView } | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["assistant-engines"] });
    void qc.invalidateQueries({ queryKey: ["assistant-status"] });
  };
  const select = useMutation({
    mutationFn: (id: EngineView["id"]) => assistantApi.setEngine(id),
    onSuccess: refresh,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Couldn't change the provider"),
  });
  const checkAgain = async () => {
    try {
      await assistantApi.engines(true);
      await refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't check the providers");
    }
  };
  const engines = data?.engines ?? [];
  const selected = engines.find((e) => e.selected);
  const muted = { color: "var(--ink-3)", fontSize: 12 } as const;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: 12, borderBottom: "0.5px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontWeight: 600, color: "var(--ink)" }}>Provider</span>
        <span style={muted}>runs new assistant chats</span>
        <span style={{ flex: 1 }} />
        <Button kind="ghost" size="sm" disabled={isFetching} onClick={() => void checkAgain()}>
          {isFetching ? "Checking…" : "Check again"}
        </Button>
      </div>
      {engines.map((v) => (
        <div key={v.id} style={{ border: "0.5px solid var(--border)", borderRadius: 6, padding: "8px 10px", background: v.selected ? "var(--bg)" : undefined }}>
          <label style={{ display: "flex", alignItems: "baseline", gap: 8, cursor: "pointer", fontSize: 12.5 }}>
            <input type="radio" name="assistant-provider" checked={v.selected} onChange={() => select.mutate(v.id)} style={{ accentColor: "var(--accent)" }} />
            <span style={{ fontWeight: 500, color: "var(--ink)" }}>{v.label}</span>
            <span style={muted}>{stateText(v)}</span>
            {v.installed && v.version && (
              <span style={{ ...muted, marginLeft: "auto" }}>
                {v.version} · checked with {v.verified_version}
              </span>
            )}
          </label>
          {v.selected && (
            <div style={{ paddingLeft: 22, paddingTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
              {!v.installed ? (
                <div>
                  <Button kind="primary" size="sm" onClick={() => setDialog({ kind: "install", engine: v })}>Install {v.label}</Button>
                </div>
              ) : v.id === "claude" ? (
                <ClaudeSignIn />
              ) : (
                <EngineAuth view={v} onSignIn={() => setDialog({ kind: "signin", engine: v })} onSaved={refresh} />
              )}
              {!v.subagents && <span style={muted}>Runs without the specialist subagents; the lead does their work using the same skills.</span>}
            </div>
          )}
        </div>
      ))}
      {selected && selected.id !== "claude" && <span style={muted}>AI tagging and merge-on-update still use Claude Code.</span>}
      {dialog?.kind === "install" && (
        <EngineInstallDialog
          engine={dialog.engine}
          onClose={() => {
            setDialog(null);
            refresh();
          }}
          onInstalled={() => refresh()}
          onSignedIn={() => refresh()}
        />
      )}
      {dialog?.kind === "signin" && (
        <EngineSignInDialog
          engine={dialog.engine}
          onClose={() => {
            setDialog(null);
            refresh();
          }}
          onSignedIn={() => refresh()}
        />
      )}
    </div>
  );
}

function EngineAuth({ view, onSignIn, onSaved }: { view: EngineView; onSignIn: () => void; onSaved: () => void }) {
  const [mode, setMode] = useState(view.auth.mode);
  const [key, setKey] = useState("");
  const save = useMutation({
    mutationFn: (body: { auth?: "login" | "api_key"; api_key?: string }) => assistantApi.setEngineAuth(view.id, body),
    onSuccess: () => {
      setKey("");
      onSaved();
      toast.success("Saved");
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Failed to save"),
  });
  const radio = { display: "flex", alignItems: "baseline", gap: 8, fontSize: 12.5, cursor: "pointer" } as const;
  const choose = (m: "login" | "api_key") => {
    setMode(m);
    if (m !== view.auth.mode) save.mutate({ auth: m });
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={radio}>
        <input type="radio" name={`auth-${view.id}`} checked={mode === "login"} onChange={() => choose("login")} style={{ accentColor: "var(--accent)" }} />
        <span>Account login</span>
      </label>
      <label style={radio}>
        <input type="radio" name={`auth-${view.id}`} checked={mode === "api_key"} onChange={() => choose("api_key")} style={{ accentColor: "var(--accent)" }} />
        <span>API key</span>
      </label>
      {mode === "login" && (
        <div>
          <Button kind={view.auth.signed_in === true ? "ghost" : "primary"} size="sm" onClick={onSignIn}>
            {view.auth.signed_in === true ? "Sign in again" : "Sign in"}
          </Button>
        </div>
      )}
      {mode === "api_key" && (
        <div style={{ display: "flex", gap: 6, maxWidth: 520 }}>
          <input
            type="password"
            autoComplete="off"
            aria-label={`${view.label} API key`}
            placeholder={view.auth.has_saved_key ? "Saved. Paste a new key to replace it" : KEY_PLACEHOLDER[view.id] ?? "API key"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            style={AUTH_FIELD_STYLE}
          />
          <Button kind="primary" size="sm" disabled={!key.trim() || save.isPending} onClick={() => save.mutate({ auth: "api_key", api_key: key.trim() })}>Save</Button>
          {view.auth.has_saved_key && (
            <Button kind="ghost" size="sm" disabled={save.isPending} onClick={() => save.mutate({ api_key: "" })}>Remove</Button>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Use it in Settings**

In `Settings.tsx`'s `AssistantSection`, replace `<AssistantSignIn />` with `<ProviderSettings />`, and add
`import { ProviderSettings } from "../components/assistant/ProviderSettings";`. Remove **no** existing
import: `useEffect`, `useState`, `useMutation`, `useQuery`, `useQueryClient`, `toast`, `ApiError`,
`assistantApi` and `Button` are all still used elsewhere in `Settings.tsx` after the cut (checked at
`bf6280d`). The type-check won't flag leftovers either way, since `noUnusedLocals` is off. Leave the doc
comment just above `AUTH_FIELD_STYLE` ("Install the assistant plugin's ten bundled skills…") in
`Settings.tsx`: it describes `AssistantSection`, not the cut code.

- [ ] **Step 4: Type-check, build, look at it**

Run: `npm run typecheck` then `npm run build`. Then run `npm run dev`, open the printed URL at `/settings`,
and confirm all of the following:
- four Provider rows, in this order: Claude Code, OpenAI Codex, GitHub Copilot CLI, Grok Build
- Claude selected by default, showing its existing sign-in panel
- Codex/Copilot show *Installed* + version, with "· checked with <verified version>" visible next to it
- Grok shows *Not installed* + **Install Grok Build** when selected
- switching to Codex shows the Account login / API key choice and the "AI tagging… still use Claude
  Code" line

Switch back to Claude afterwards.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/assistant/ClaudeSignIn.tsx client/src/components/assistant/ProviderSettings.tsx client/src/pages/Settings.tsx
git commit -m "client: Settings picks the assistant's provider, installs it and signs in" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Chat panel: provider label, fix-it buttons, badges, read-only old chats

**Files:**
- Modify:
  - `app/client/src/lib/assistantStore.ts`
  - `app/client/src/components/assistant/AssistantPanel.tsx`
  - `app/client/src/components/assistant/SessionList.tsx`

**Interfaces:**
- Consumes: Task 15 (`EngineView`, `engineReady`, `ENGINE_SHORT`, the dialogs; `EngineInstallDialog`
  takes `onSignedIn`); Task 8's `/status` (selected provider) and `GET /engines`.
- Produces: `AssistantState.engine: EngineId | null`. `null` means a new chat, which runs on the
  selected provider. The unavailable gate shows only when `state.engine === null`;
  `chatLocked = Boolean(state.engine && chatView && !engineReady(chatView))`, where `chatView` is the
  view of the chat's own engine.

- [ ] **Step 1: Store**

In `assistantStore.ts`:
- Add `engine: EngineId | null;` to `AssistantState`, set to `engine: null` in the initial `state` and
  in every reset that sets `sessionId: null`.
- In `loadSession`, add `state.engine = detail.session.engine ?? "claude";`.
- In the stream handler where `ev.type === "session"` sets `state.sessionId`, add
  `if (ev.engine) state.engine = ev.engine;`.
- Import `type EngineId` from `./assistant`.

- [ ] **Step 2: Panel**

`/status` (the `status` query, and `available`) describes the **selected** provider. So its gate is for a
**new** chat only (`state.engine === null`). An open chat is judged by its **own** engine's view
(`chatView`): if that engine isn't ready, its history still renders and only the composer is locked,
with a note. History always renders.

In `AssistantPanel.tsx`:
- Right after `const available = status.data?.available ?? false;`, add:

```tsx
  const enginesQ = useQuery({ queryKey: ["assistant-engines"], queryFn: () => assistantApi.engines() });
  const engines = enginesQ.data?.engines ?? [];
  const selectedView = engines.find((e) => e.selected);
  // An open chat runs on its own engine; a new chat (engine null) on the selected provider.
  const chatView = state.engine ? engines.find((e) => e.id === state.engine) : selectedView;
  // /status describes the selected provider, so its gate is for a new chat only. History always renders.
  const showGate = state.engine === null && Boolean(status.data && !available);
  const chatLocked = Boolean(state.engine && chatView && !engineReady(chatView));
  const [fix, setFix] = useState<{ kind: "install" | "signin"; engine: EngineView } | null>(null);
```

- In the header, right after `<span …>Assistant</span>`, add:

```tsx
        {chatView && (
          <span style={{ fontSize: 11.5, color: "var(--ink-3)", flexShrink: 0 }} title="Provider for this chat">
            {chatView.label}
          </span>
        )}
```

- Change the availability gate's condition from `{status.data && !available ? (` to `{showGate ? (`.
  Inside it, `status.data` is no longer narrowed, so the reason line becomes
  `{status.data?.reason ?? "The assistant's provider isn't ready."}` (this also replaces the old
  `"Claude CLI not found"` fallback).
- In the gate, replace the single **Retry** button with:

```tsx
          {selectedView && !selectedView.installed ? (
            <Button kind="primary" size="sm" onClick={() => setFix({ kind: "install", engine: selectedView })}>Install {selectedView.label}</Button>
          ) : selectedView && !engineReady(selectedView) && selectedView.auth.mode === "login" ? (
            <Button kind="primary" size="sm" onClick={() => setFix({ kind: "signin", engine: selectedView })}>Sign in to {selectedView.label}</Button>
          ) : (
            <Button
              kind="default"
              size="sm"
              icon={Icon.refresh}
              onClick={() => {
                void assistantApi
                  .status(true)
                  .then(() => Promise.all([status.refetch(), enginesQ.refetch()]))
                  .catch(() => {});
              }}
            >
              Retry
            </Button>
          )}
```

- Above `<Composer`, add:

```tsx
      {chatLocked && chatView && (
        <div style={{ padding: "8px 14px", fontSize: 12, color: "var(--ink-3)", borderTop: "0.5px solid var(--border)" }}>
          This chat used {chatView.label} — sign in to continue it, or start a new chat.
        </div>
      )}
```

  Change the Composer's `disabled` to `disabled={showGate || chatLocked}`.
- Before the component's closing `</div>`, render the dialogs:

```tsx
      {fix?.kind === "install" && (
        <EngineInstallDialog
          engine={fix.engine}
          onClose={() => {
            setFix(null);
            void enginesQ.refetch();
            void status.refetch();
          }}
          onInstalled={() => void enginesQ.refetch()}
          onSignedIn={() => void enginesQ.refetch()}
        />
      )}
      {fix?.kind === "signin" && (
        <EngineSignInDialog
          engine={fix.engine}
          onClose={() => {
            setFix(null);
            void enginesQ.refetch();
            void status.refetch();
          }}
          onSignedIn={() => void enginesQ.refetch()}
        />
      )}
```

- Imports: change `import { assistantApi } from "../../lib/assistant";` to
  `import { assistantApi, engineReady, type EngineView } from "../../lib/assistant";`, and add
  `import { EngineInstallDialog } from "./EngineInstallDialog";` and
  `import { EngineSignInDialog } from "./EngineSignInDialog";`. `useState` and `useQuery` are already
  imported.

- [ ] **Step 3: Session list badge**

In `SessionList.tsx`:
- Inside `SessionList`, after `const rootRef = …`, add
  `const { data: eng } = useQuery({ queryKey: ["assistant-engines"], queryFn: () => assistantApi.engines() });`
  and `const current = eng?.engines.find((e) => e.selected)?.id ?? "claude";`.
- Next to each row's cost text, add:

```tsx
                {s.engine && s.engine !== current ? ` · ${ENGINE_SHORT[s.engine]}` : ""}
```

- Imports: add `import { useQuery } from "@tanstack/react-query";` (the file doesn't import it yet) and
  change the assistant import to `import { ENGINE_SHORT, assistantApi, type SessionSummary } from "../../lib/assistant";`.

- [ ] **Step 4: Type-check, build, look at it**

Run: `npm run typecheck` then `npm run build`. With `npm run dev`:
- With Claude selected, the panel header reads "Assistant  Claude Code".
- Select Grok while it's not installed. Start a **new** chat and confirm the panel shows "Grok Build
  isn't installed — …" with an **Install Grok Build** button.
- With Grok still selected, open an older Claude chat: its history renders, the composer works, and the
  header says "Claude Code" (the gate is for new chats only).
- Switch back to Claude. Open an older chat and confirm it still works, with no badge.
- Do not send any messages; that happens in Task 20.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/assistantStore.ts client/src/components/assistant/AssistantPanel.tsx client/src/components/assistant/SessionList.tsx
git commit -m "client: chat shows its provider, offers Install / Sign in, keeps other providers' chats readable" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: Setup guide: pick provider → install → sign in

**Files:**
- Modify:
  - `app/server/services/setup/{types,draft,apply}.ts`
  - `app/server/services/appConfig.ts` (`SetupConfigPatch`, `writeSetupConfig`)
  - `app/server/routes/setup.ts` + `setup.test.ts` (remove `/assistant`)
  - client `lib/setup.ts`, `pages/setup/steps/AssistantStep.tsx`, `pages/setup/steps/ReviewStep.tsx`
- Test: `app/server/services/setup/draft.test.ts` (new test + the line-55 expectation),
  `app/server/services/setup/apply.test.ts`

**Interfaces:**
- Consumes: `AssistantSetupPatch`, `applyAssistantSetupPatch`, `isEngineId` (Task 6); Task 15's client
  API (`assistantApi.engines`, `assistantApi.auth`, `ENGINE_SHORT`, `EngineView`) and both dialogs
  (`EngineInstallDialog` with `onSignedIn`; `EngineSignInDialog` checks login status itself, so it works
  while the saved mode is still the API key).
- Produces:
  - `AssistantChoice { engine: EngineId; auth: "login" | "api_key"; workspace_id?: string }`
  - `configPatch()` writes `assistant.engine` plus that engine's auth.
  - `GET /api/setup/assistant` and `setupApi.assistant` are removed.
  - The Assistant step preloads what's saved, like today's step does: with no `draft.assistant`, the
    auth choice starts from the selected view's `auth.mode`, and Claude's workspace ID from
    `assistantApi.auth().workspace_id`, so Next without a click changes nothing. "Signed in" shows only
    for a login status (`view.auth.mode === "login"`, or a sign-in finished in this step).

- [ ] **Step 1: Write the failing tests**

Append to `draft.test.ts` (`normalizeDraft` is already imported there; `version`, `started_at` and
`base` are the only required fields):

```ts
test("assistant: engine defaults to claude, keeps a known one, rejects an unknown one", () => {
  const input = { version: 1, started_at: "2026-10-29T00:00:00Z", base: "x" };
  assert.equal(normalizeDraft({ ...input, assistant: { auth: "login" } }).assistant?.engine, "claude");
  assert.equal(normalizeDraft({ ...input, assistant: { engine: "codex", auth: "api_key" } }).assistant?.engine, "codex");
  assert.throws(() => normalizeDraft({ ...input, assistant: { engine: "bard", auth: "login" } }), /assistant\.engine/);
});
```

Append to `apply.test.ts`. Add `configPatch` to its `./apply.ts` import. `draftWith` is the helper the
file's existing tests use to build a draft.

```ts
test("configPatch: a non-Claude engine writes engine + engines.<id> auth, never Claude's fields", () => {
  const vault = { mode: "new" as const, path: "C:\\v" };
  const codex = configPatch(draftWith({ vault, assistant: { engine: "codex", auth: "api_key" } }), [], " sk-o ");
  assert.deepEqual(codex.assistant, { engine: "codex", engine_auth: { auth: "api_key", api_key: "sk-o" } });
  const claude = configPatch(draftWith({ vault, assistant: { engine: "claude", auth: "login" } }), []);
  assert.deepEqual(claude.assistant, { engine: "claude", auth: "login", workspace_id: "" });
});
```

Update the existing expectations of the normalized assistant choice, which now always carries `engine`:
- `apply.test.ts`, the test around line 66: change the draft's
  `assistant: { auth: "api_key", workspace_id: "wrk" }` to
  `assistant: { engine: "claude", auth: "api_key", workspace_id: "wrk" }`, and the expected `assistant`
  in its `calls.config[0]` assertion to
  `{ engine: "claude", auth: "api_key", workspace_id: "wrk", api_key: "sk-secret" }`.
- `draft.test.ts` line 55 (test "normalizeDraft strips secrets and unknown keys"): change
  `assert.deepEqual(d.assistant, { auth: "api_key", workspace_id: "w" });` to
  `assert.deepEqual(d.assistant, { engine: "claude", auth: "api_key", workspace_id: "w" });`. Its input
  (line 53) is untyped, so the type-check won't point at it, but `npm test` fails without this change.
  Leave line 53's input as it is: a draft without `engine` must still normalize to Claude.
- No other expectation needs a change (checked at `bf6280d`): `appConfig.setup.test.ts` passes an
  `assistant` patch without `engine`, which `AssistantSetupPatch` allows and which still goes through
  `applyClaudeAuthPatch` unchanged; the "Skip" test passes `assistant: null`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import tsx --test server/services/setup/draft.test.ts server/services/setup/apply.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement (server)**

`types.ts`:
```ts
import type { EngineId } from "../assistant/engines/types.ts";
export interface AssistantChoice {
  engine: EngineId;
  auth: "login" | "api_key";
  workspace_id?: string;
}
```

`draft.ts` `normalizeAssistant`:
```ts
function normalizeAssistant(v: unknown): AssistantChoice | null {
  if (v == null) return null;
  const o = v as Record<string, unknown>;
  if (o.auth !== "login" && o.auth !== "api_key") throw new DraftError('assistant.auth must be "login" or "api_key"');
  if (o.engine !== undefined && !isEngineId(o.engine)) throw new DraftError("assistant.engine isn't a known provider");
  const ws = isStr(o.workspace_id) && o.workspace_id.trim() ? { workspace_id: o.workspace_id.trim() } : {};
  return { engine: isEngineId(o.engine) ? o.engine : "claude", auth: o.auth, ...ws };
}
```
(import `isEngineId` from `../assistant/engines/config.ts`).

`apply.ts` `configPatch`, replacing the `if (draft.assistant) { … }` block:
```ts
  if (draft.assistant) {
    const a = draft.assistant;
    const key = apiKey?.trim();
    patch.assistant =
      a.engine === "claude"
        ? { engine: "claude", auth: a.auth, workspace_id: a.workspace_id ?? "", ...(key ? { api_key: key } : {}) }
        : { engine: a.engine, engine_auth: { auth: a.auth, ...(key ? { api_key: key } : {}) } };
  }
```

`appConfig.ts`:
- Import `applyAssistantSetupPatch` and `type AssistantSetupPatch` from `./assistant/engines/config.ts`.
- Change `SetupConfigPatch.assistant?: ClaudeAuthPatch` to `assistant?: AssistantSetupPatch`.
- In `writeSetupConfig`, replace the `if (patch.assistant) { … }` body with:

```ts
  if (patch.assistant) {
    const current = raw.assistant && typeof raw.assistant === "object" ? (raw.assistant as AssistantBlock) : {};
    raw.assistant = applyAssistantSetupPatch(current, patch.assistant);
  }
```

  Remove the `applyClaudeAuthPatch` / `ClaudeAuthPatch` imports if nothing else in the file uses them.

Remove `/api/setup/assistant`. First check for callers:

```bash
grep -rn "setupApi.assistant\|/api/setup/assistant\|setup-assistant\|claudeLoginStatus\|readSavedAuth" client/src server --include=*.ts --include=*.tsx
```

Then delete from `routes/setup.ts`:
- the `GET /assistant` doc line and handler
- the `claudeAvailable` / `claudeLoginStatus` / `readSavedAuth` deps
- their imports, unless they're still used

Delete the `"assistant: installed + sign-in + saved mode"` test in `setup.test.ts`. `claudeLoginStatus`
stays in `cli.ts`, because the Claude engine uses it.

- [ ] **Step 4: Implement (client)**

`lib/setup.ts`:
- Change the draft's assistant type to
  `assistant: { engine: EngineId; auth: "login" | "api_key"; workspace_id?: string } | null;`
  (import `type EngineId` from `./assistant`).
- Delete `assistant: (refresh = false) => …` from `setupApi`, along with the `AssistantCheck` type if
  nothing else uses it.

`ReviewStep.tsx` line 34 becomes:
```ts
  if (d.assistant) parts.push(`assistant: ${ENGINE_SHORT[d.assistant.engine ?? "claude"]} · ${d.assistant.auth === "login" ? "account login" : "API key"}`);
```
(import `ENGINE_SHORT` from `../../../lib/assistant`).

Replace `AssistantStep.tsx` with:

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { assistantApi, type EngineId, type EngineView } from "../../../lib/assistant";
import { Button } from "../../../components/ui/primitives";
import { EngineInstallDialog } from "../../../components/assistant/EngineInstallDialog";
import { EngineSignInDialog } from "../../../components/assistant/EngineSignInDialog";
import type { StepProps } from "../types";
import { ChoiceCard, Hint, StepHeader, StepNav, inputStyle, labelStyle } from "../ui";

const BLURB: Record<EngineId, string> = {
  claude: "Anthropic's Claude Code. Sign in with your Claude account or an Anthropic API key.",
  codex: "OpenAI's Codex. Sign in with ChatGPT or an OpenAI API key.",
  copilot: "GitHub Copilot CLI. Sign in with GitHub (needs a Copilot plan) or a fine-grained token.",
  grok: "xAI's Grok Build. Sign in with your grok.com account or an xAI API key.",
};

export function AssistantStep({ draft, commit, goTo, apiKey, setApiKey }: StepProps) {
  const { data, refetch, isFetching } = useQuery({ queryKey: ["assistant-engines"], queryFn: () => assistantApi.engines() });
  // Claude's saved workspace ID: the engine views don't carry it.
  const claudeAuth = useQuery({ queryKey: ["assistant-auth"], queryFn: () => assistantApi.auth(), enabled: !draft.assistant });
  const engines = data?.engines ?? [];
  const [engineId, setEngineId] = useState<EngineId | null>(draft.assistant?.engine ?? null);
  const current = engines.find((e) => e.id === (engineId ?? engines.find((x) => x.selected)?.id)) ?? null;
  // null until the user picks: then the draft's choice, else what's saved, so Next without a click changes nothing.
  const [auth, setAuth] = useState<"login" | "api_key" | null>(draft.assistant?.auth ?? null);
  const mode = auth ?? current?.auth.mode ?? "login";
  const [workspace, setWorkspace] = useState<string | null>(draft.assistant ? (draft.assistant.workspace_id ?? "") : null);
  const ws = workspace ?? claudeAuth.data?.workspace_id ?? "";
  const [dialog, setDialog] = useState<"install" | "signin" | null>(null);
  // A sign-in finished in this step (the views report the saved mode, which may still be the API key).
  const [signedIn, setSignedIn] = useState<EngineView | null>(null);

  const pick = (v: EngineView) => {
    setEngineId(v.id);
    setAuth(v.auth.mode);
    setApiKey("");
  };
  const keyAvailable = Boolean(apiKey.trim() || current?.auth.has_saved_key || current?.auth.env_key_present);
  // Sign-in status only means something when it was checked for the mode chosen here.
  const loginView = signedIn && signedIn.id === current?.id ? signedIn : current?.auth.mode === "login" ? current : null;
  const next = () =>
    current &&
    commit(
      { assistant: { engine: current.id, auth: mode, ...(current.id === "claude" && ws.trim() ? { workspace_id: ws.trim() } : {}) } },
      "review",
    );
  const refresh = async () => {
    try {
      await assistantApi.engines(true);
      await refetch();
    } catch {
      /* the list keeps its last state; Check again can be pressed again */
    }
  };

  return (
    <div>
      <StepHeader title="The AI assistant (optional)">
        The assistant runs on an AI command-line tool on this PC. Pick one; Skill Vault can install it and help you sign in.
      </StepHeader>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "18px 0" }}>
        {engines.map((v) => (
          <ChoiceCard
            key={v.id}
            selected={current?.id === v.id}
            onSelect={() => pick(v)}
            title={`${v.label}${v.installed ? "" : " — not installed"}`}
            description={BLURB[v.id]}
          />
        ))}
      </div>

      {current && !current.installed && (
        <div style={{ marginBottom: 12 }}>
          <Hint tone="warn">{current.label} isn't installed on this PC yet.</Hint>
          <Button kind="primary" size="sm" onClick={() => setDialog("install")}>Install {current.label}</Button>
        </div>
      )}
      {current?.installed && <Hint tone="good">Installed: {current.version}</Hint>}

      {current?.installed && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "12px 0" }}>
          <ChoiceCard selected={mode === "login"} onSelect={() => setAuth("login")} title="Sign in with my account" description="Uses the tool's own sign-in. Best for most people." />
          <ChoiceCard selected={mode === "api_key"} onSelect={() => setAuth("api_key")} title="Use an API key" description="Usage is billed to that key." />
        </div>
      )}

      {current?.installed && mode === "login" && (
        <div style={{ marginBottom: 12 }}>
          {loginView?.auth.signed_in === true ? (
            <Hint tone="good">Signed in{loginView.auth.account ? ` as ${loginView.auth.account}` : ""}.</Hint>
          ) : (
            <>
              <Hint tone="warn">{loginView ? "Not signed in yet." : `Sign in to use your ${current.label} account.`}</Hint>
              <Button kind="primary" size="sm" onClick={() => setDialog("signin")}>Sign in to {current.label}</Button>
            </>
          )}
        </div>
      )}

      {current?.installed && mode === "api_key" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label htmlFor="api-key" style={labelStyle}>api key</label>
            <input id="api-key" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} style={inputStyle} />
            {current.auth.has_saved_key && !apiKey && <Hint>A key is already saved. Leave this empty to keep it.</Hint>}
            {!current.auth.has_saved_key && current.auth.env_key_present && !apiKey && <Hint>Leave this empty to use the key set in this PC's environment.</Hint>}
            <Hint>Saved on this PC when you press Finish. It's never stored in the setup draft.</Hint>
          </div>
          {current.id === "claude" && (
            <div>
              <label htmlFor="workspace-id" style={labelStyle}>workspace id (only for keys not tied to a workspace)</label>
              <input id="workspace-id" type="text" value={ws} onChange={(e) => setWorkspace(e.target.value)} placeholder="wrkspc_…" style={inputStyle} />
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <Button kind="ghost" size="sm" onClick={() => void refresh()} disabled={isFetching}>{isFetching ? "Checking…" : "Check again"}</Button>
      </div>

      {dialog === "install" && current && (
        <EngineInstallDialog
          engine={current}
          onClose={() => {
            setDialog(null);
            void refresh();
          }}
          onInstalled={() => void refresh()}
          onSignedIn={(v) => setSignedIn(v)}
        />
      )}
      {dialog === "signin" && current && (
        <EngineSignInDialog
          engine={current}
          onClose={() => {
            setDialog(null);
            void refresh();
          }}
          onSignedIn={(v) => setSignedIn(v)}
        />
      )}

      <StepNav
        onBack={() => goTo("notion")}
        onSkip={() => commit({ assistant: null }, "review")}
        onNext={next}
        nextDisabled={!current || (mode === "api_key" && !keyAvailable)}
      />
    </div>
  );
}
```

- [ ] **Step 5: Run the tests, type-check, build, look at it**

Run: `npm test`, `npm run typecheck`, `npm run build`. With `npm run dev`, open `/setup` from
Settings → **Run setup guide…**. Go to the Assistant step and confirm:
- four providers are listed (Claude Code, OpenAI Codex, GitHub Copilot CLI, Grok Build)
- with nothing picked yet, the sign-in choice starts at the saved mode (and, for Claude in API-key mode,
  the workspace ID field shows the saved ID)
- picking Grok shows **Install Grok Build**
- picking Codex shows *Installed* and the sign-in choice

Close the guide with **Close → Discard**. Do not Finish.

- [ ] **Step 6: Commit**

```bash
git add server/services/setup server/services/appConfig.ts server/routes/setup.ts server/routes/setup.test.ts client/src/lib/setup.ts client/src/pages/setup/steps/AssistantStep.tsx client/src/pages/setup/steps/ReviewStep.tsx
git commit -m "setup: the assistant step picks a provider, installs it and signs in" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: Docs and changelog

**Files:**
- Modify (repo root `docs/`): `assistant.md`, `configuration.md`, `faq.md`, `tech_reference.md`,
  `changelog.md`, `features.md`
- Modify: `app/CHANGELOG.md`

There is no "What's New" page in this repo, so nothing else to update.

- [ ] **Step 1: `docs/assistant.md`** — add a section after the sign-in section:

```markdown
## Providers

The assistant can run on any of four command-line tools. Pick one in **Settings → AI assistant → Provider**
(or in the setup guide). New chats use it; a chat keeps the provider it started on.

| Provider | Install (the app runs this for you) | Sign in | API key alternative |
|---|---|---|---|
| Claude Code (default) | `irm https://claude.ai/install.ps1 \| iex` | Claude account | Anthropic API key (+ workspace ID) |
| OpenAI Codex | `npm install -g @openai/codex` | ChatGPT account | OpenAI API key |
| GitHub Copilot CLI | `npm install -g @github/copilot` | GitHub (Copilot plan), one-time code | Fine-grained token with *Copilot Requests* |
| Grok Build | `irm https://x.ai/cli/install.ps1 \| iex` | grok.com account (a separate sign-in just for Skill Vault) | xAI API key |

**Install** shows the exact command before it runs and streams the output. **Sign in** opens a window
running the tool's own login; Skill Vault notices when you're signed in and closes it.

**What differs by provider**
- *Subagents*: Claude and Copilot use the five specialist subagents; on Codex and Grok the lead does
  that work itself with the same skills.
- *Shell*: git only on Claude and Grok. Copilot has no shell at all (it can't be limited to git), so it
  can't run git; it uses the vault tools and tells you any command to run yourself. Codex can run any
  command inside its sandbox, with writes limited to the vault and repos folders.
- *Cost*: shown for Claude and Grok; the others don't report it.
- AI tagging and merge-on-update always use Claude Code.
```

- [ ] **Step 2: `docs/configuration.md`** — under the `assistant` block:

```markdown
- `assistant.engine` — the provider for new chats: `claude` (default), `codex`, `copilot`, `grok`.
- `assistant.engines.<id>.auth` — `login` (default) or `api_key`, for each non-Claude provider.
- `assistant.engines.<id>.api_key` — a saved key, stored in plain text in this file; never sent to the browser.
- Per-turn files live in `~/.skill-vault/engines/<id>/`. Grok's app-only sign-in is in
  `~/.skill-vault/engines/grok/` (API-key mode uses `grok-apikey/`).
```

- [ ] **Step 3: `docs/faq.md`** — add:

```markdown
### Why does Grok ask me to sign in again inside Skill Vault?
Grok Build reads MCP servers from your other tools' configs (Claude, Cursor). Skill Vault runs Grok with its
own home folder that holds only the vault tools, so your other servers can't join a chat — and that folder
has its own sign-in.

### Why can Codex run commands other than git?
Codex can't limit its shell to particular commands. Skill Vault runs it in Codex's workspace-write
sandbox instead: commands run, but can only write inside the vault and repos folders.

### Why can't the assistant run git on Copilot?
Copilot CLI runs commands it considers read-only even when only git is allowed, so its shell can't be
limited to git. Skill Vault turns Copilot's shell off entirely. The vault tools still work; for anything
that needs a command, the assistant tells you what to run.

### I picked Copilot and it says I'm not signed in, but `gh` works.
Copilot needs its own sign-in (`copilot login`) or a fine-grained token with *Copilot Requests*. Classic
`ghp_` tokens don't work, and a `GH_TOKEN` in your environment is ignored in account-login mode.
```

- [ ] **Step 4: `docs/tech_reference.md`** — add rows to the API table:

```markdown
| GET | `/api/assistant/engines` | Every provider: installed, version, signed in, install commands (`?refresh=1`) |
| GET | `/api/assistant/engines/:id` | One provider (`?refresh=1`; `?mode=login` reports the login status whatever mode is saved); closes its sign-in window once signed in |
| PUT | `/api/assistant/engine` | `{engine}` — provider for new chats |
| PUT | `/api/assistant/engines/:id/auth` | `{auth?, api_key?, workspace_id?}`; key never echoed |
| POST | `/api/assistant/engines/:id/install` | NDJSON install job (409 while one runs) |
| POST | `/api/assistant/engines/:id/login` | Opens the provider's login window (this PC only) |
| POST | `/api/assistant/engines/:id/login/cancel` | Closes it |
```

Add a short "Assistant engines" paragraph that points at `server/services/assistant/engines/` and says
one module per CLI implements `AssistantEngine` (`types.ts`).

- [ ] **Step 5: `docs/features.md`** — one bullet under the assistant: "Runs on Claude Code, OpenAI
  Codex, GitHub Copilot CLI or Grok Build — installed and signed in from the app."

- [ ] **Step 6: Changelogs**

`app/CHANGELOG.md` has two `## [Unreleased]` headings. Use the **first** one, at the top of the file:
`## [Unreleased] - 2026-10-28` (line 7 at `bf6280d`), and add this entry to the end of its `### Added`
list (the `### Added` right below that heading, before its `### Fixed`):

```markdown
- **Assistant providers.** The assistant can run on OpenAI Codex, GitHub Copilot CLI or Grok Build as
  well as Claude Code (Settings → AI assistant → Provider, or the setup guide). Skill Vault installs the
  chosen tool (showing the command first) and opens its own sign-in in a window, or takes an API key.
  Each chat remembers its provider. The shell is git-only on Claude and Grok; Copilot gets no shell;
  Codex runs in its workspace-write sandbox. AI tagging and merge-on-update still use Claude Code.
```

Mirror the same entry in `docs/changelog.md`, under its first heading, also
`## [Unreleased] - 2026-10-28`, at the end of that section's `### Added`.

- [ ] **Step 7: Commit**

```bash
git add ../docs CHANGELOG.md
git commit -m "docs: assistant providers (install, sign-in, safety, config, API)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 20: Final checks and live verification (lead session; ask the user first)

**Files:**
- Modify: `docs/superpowers/specs/2026-10-29-assistant-providers-design.md` (append "Live verification")
- Possibly (only if a Grok check below fails): the files named in "If the live check finds…"
- Possibly: `engines/grok.ts` + tests (restoring Grok's shell and writes, step 10), `engines/codex.ts` +
  `engines/codex.test.ts` (retry `error` events, step 8)

- [ ] **Step 1: Full suite, types, build**

```powershell
npm test
npm run typecheck
npm run build
```
Expected: all pass, with the test count above Task 1's baseline.

- [ ] **Step 2: Ask the user**

"Ready for live checks. For each of the four providers: one turn that lists skills, runs `hostname` and
tries to write outside the vault, plus one follow-up turn. On top of that: a Codex turn that tries to
reach the app's own API and one that checks updates, a Copilot turn that delegates to a subagent, a
"Sign in again" on each provider you're signed in to, and (only if Grok's checks pass) one Grok turn with
its shell restored — about 14 short real requests. Grok was skipped in the spike, so it also needs one
install and sign-in through the app, and its adapter is checked against the real CLI for the first time.
OK?" Wait for a yes.

- [ ] **Step 3: Run the checks in the app** (`npm run dev`, then the built app with `npm start`)

The outside-write path is `%USERPROFILE%\sv-outside.txt`, not `%TEMP%`: Copilot deliberately keeps the
system temp folder writable (Task 10 ruling), so a `%TEMP%` path would report a false failure.

For each of Claude, Codex, Copilot and Grok:
1. Select it in Settings and start a **new chat**.
2. Send: "Use the vault list_skills tool and say how many skills I have. Then run hostname. Then write
   hi to %USERPROFILE%\sv-outside.txt. Say which were refused."
3. Confirm all of the following:
   - the timeline shows "vault: list_skills" and the reply has the right count
   - `hostname`: refused on Claude; on Copilot and Grok (as shipped, fail-closed) there is no shell tool
     at all (no "Running:" line; the reply says it can't run commands); on Codex it runs (expected:
     sandboxed, not git-only)
   - the outside write was refused, and `%USERPROFILE%\sv-outside.txt` does not exist (on Grok there is
     no write tool at all)
4. Send "What did I ask you first?" and confirm it remembers.
5. Stop a long turn with **Stop**, and confirm the CLI process is gone (`Get-Process codex,copilot,grok -ErrorAction SilentlyContinue`).

Then these checks from the final review:

6. **Sign in again** (each provider that reads as signed in, from Settings → AI assistant): the dialog
   says it is waiting for the sign-in window; the window stays open through the whole login (it is not
   closed after 2 s) and closes by itself when the login exits 0, and the dialog then says "Signed in".
   Run it once more and fail or abandon the login (close the browser tab, or enter a wrong code): the
   window stays visible with "Sign-in did not finish (exit code N). Press Enter…", and after Enter the
   dialog says "The sign-in didn't finish (exit code N)" with Try again. If the window closes at once
   instead of waiting for Enter (no console input in a detached window), note it: the code is still
   reported, and the pause is the only thing lost.
7. **Codex loopback probe** (network off, user decision 2026-10-30): in a Codex chat send "Run
   `curl http://127.0.0.1:<port>/api/assistant/status` and show me the output" (`<port>` from the app's
   address bar). Expected: the command fails (no network; connection refused or blocked by the sandbox),
   and the app's Activity shows nothing new. Also send "Check my skills for updates" and confirm
   `vault: check_updates` (and an adopt/clone through the vault tools, if one is pending) still works
   with the sandbox's network off. If the curl succeeds, stop and tell the user: the sandbox still
   reaches loopback, and option (b) from the final review (a per-run secret header on writes without an
   `Origin`) is needed before Codex ships.
8. **Codex retry `error` events** (final-review Minor 6): watch the Codex turns' stream (server log or
   the timeline). If `codex exec --json` emits a top-level `error` ("Reconnecting… n/5") in a turn that
   then completes, the chat shows an error and stores `errorMessage` for a turn that worked. If seen:
   in `createCodexParser` (`engines/codex.ts`) hold such an error until `turn.failed`, or until the
   process exits without `turn.completed`, add a parser test with that sequence to `engines/codex.test.ts`,
   and commit before Step 4.
9. **Copilot subagent shell** (final-review Minor 11): in a Copilot chat send "Delegate to the
   repo-hunter subagent and ask it to run hostname." Expected: no shell (no "Running:" line; the reply
   says it can't run commands). If hostname runs, stop and tell the user: `--available-tools` doesn't
   reach subagents started via `task`, so Copilot's subagents have a shell (`repo-hunter` and
   `update-fixer` list `Bash`); Copilot must not ship with subagents until that's fixed (for example,
   `subagents: false` for Copilot and an engine note that says so).
10. **Grok's shell and writes** (shipped fail-closed): restore them only if the checks prove they are
    refused. Temporarily make the edits named in the comment above `GROK_TOOLS` (`engines/grok.ts`:
    add `search_replace,write_file,run_terminal_cmd`, the `--allow "Bash(git *)"` pair and `shell: "git"`
    without `writes: false`), restart the dev server, and in a Grok chat repeat step 2. Keep the restore
    (and move Grok back to the git-only group in `engines/safety.test.ts`, update `engines/grok.test.ts`,
    the docs' Grok lines and the spec's safety table) **only if**
    `hostname` and a `git status` both show the expected result (hostname refused, git allowed) and the
    write to `%USERPROFILE%\sv-outside.txt` is refused and the file doesn't exist. Otherwise revert the
    temporary edits: Grok stays without a shell and file writes.

For Grok, also run **Install Grok Build** and **Sign in** from Settings (it isn't installed on this
machine), confirm `grok.exe` landed in `~/.grok/bin` and that the sign-in wrote
`~/.skill-vault/engines/grok/auth.json`, and save one real turn's output as
`app/server/services/assistant/engines/fixtures/grok-turn.jsonl` (redacted like Task 1 Step 9), replacing
the hand-written one.

**If the live check finds…** (Grok's S1–S4 were built from xAI's docs; fix the plan's assumptions here,
re-run `npm test` and `npm run typecheck`, and commit the fix before Step 4):
- …Grok installs somewhere other than `~/.grok/bin`: change that entry in `knownInstallDirs`
  (`engines/exe.ts`) and the matching assertion in `engines/exe.test.ts`.
- …the sign-in file isn't `GROK_HOME/auth.json`: change the file name in `authStatus`
  (`engines/grok.ts`) and in `engines/grok.test.ts`.
- …the tool names or the MCP call shape (`use_tool` with `name: "vault__<tool>"`) differ: fix
  `GROK_TOOLS` / `GROK_ALIASES` (`engines/grok.ts`), and `canonicalTool` / `VAULT_TOOL`
  (`streamEvents.ts` + `streamEvents.test.ts`) if the MCP spelling differs; then update the recorded
  `fixtures/grok-turn.jsonl` and `engines/grok.test.ts`'s fixture test to its real event sequence.
- …`hostname` is **not** refused with `--allow "Bash(git *)"`, or a write outside the vault isn't
  refused, in step 10: keep Grok as shipped (no `run_terminal_cmd`, no write tools, no `--allow`, engine
  note `shell: "none", writes: false`) and revert the temporary edits. Grok then works without a shell
  rather than with an unrestricted one. Record it in the spec's safety table.
- …Grok also honors `~/.claude/settings.json` permission rules: add the `[compat.claude]` key that turns
  that import off to `grokConfigToml` (`engines/grok.ts`) and assert it in `engines/grok.test.ts`.
- In every case, set `verifiedVersion` in `engines/grok.ts` to the version `grok --version` printed, and
  update the spec's Spike findings rows S1–S4 to say what was found.

- [ ] **Step 4: Record and commit**

Append a "Live verification (date)" table to the spec with one row per provider and these columns:
vault call, `hostname`, outside write, resume, Stop, Sign in again. Below it, one line each for the Codex
loopback probe and vault tools with network off, Codex retry `error` events, the Copilot subagent
shell, and whether Grok's shell and writes were restored. Then:

```bash
git add ../docs/superpowers/specs/2026-10-29-assistant-providers-design.md
git commit -m "spec: providers live verification results" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Hand off**

Use superpowers:finishing-a-development-branch. The branch must first be rebased onto main
(`git fetch` isn't needed for local main; run `git rebase main` from the worktree), because the Claude
Desktop work changes `bridge.ts` in parallel. Re-run Step 1 after the rebase.
