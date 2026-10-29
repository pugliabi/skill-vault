# Agent Access (Claude Desktop, Claude Code, any agent) — Design

**Date:** 2026-10-29 · **Status:** approved design, awaiting spec review · Builds on `main` at
`a25a664` (setup guide and Notion fixes merged). Ships in the combined **0.2.0** release.

**Amended during implementation (2026-10-29):** (1) Claude Code status is read from `~/.claude.json`, not `claude mcp get`; (2) the `.cmd` shim is `@echo off` + CRLF + `"<node>" "<bridge>" --client command %*`; (3) the install prompt wraps SKILL.md in a four-backtick fence; (4) the card's **Update** applies only to an untouched vault copy (local edits go through Updates).

## Problem

- Claude Desktop is a *package target* only: the app builds an upload-ready zip and the user uploads it.
  A Desktop chat has no way to reach the vault, so it can't save a skill it just wrote, load a vault
  skill, or run a Notion sync. Desktop chats run skills in a cloud sandbox; a skill on its own can't
  touch local files.
- The vault MCP bridge (`app/server/assistant-mcp/`) already exposes the vault as tools, but only the
  in-app assistant launches it, per turn, with `SKILL_VAULT_URL` pointing at the running server.
- No bridge tool takes skill **content** (files written in a chat) and saves it. `adopt_skills` copies
  from a folder already on disk; `get_skill` returns the file tree, not file contents.
- The installed app stops 60 s after its last window closes, so anything that depends on the server
  fails whenever the app isn't open.
- Users who want an agent to work with their vault write their own instructions with hard-coded paths.
  There is no shipped skill that any agent can use.

## Goals

1. A new public **`skill-vault` skill**, shipped with the app, that any agent can use to work with the
   vault: browse/search, use a vault skill in the chat, save a chat skill to the vault, push vault
   skills to other targets, install a skill in Claude Desktop, and run Notion/status checks.
2. The skill is an **ordinary vault skill**: one click adds it to the vault with an origin pointing at
   the app's bundled copy, so existing targets push it to Claude Code, Cursor, Codex, Copilot, Windsurf,
   OpenClaw, and the Claude Desktop package target zips it. App updates that change it show up as
   *Update available*.
3. **Claude Desktop and Claude Code get the vault tools over MCP**, connected from one Settings card.
4. **Every other agent with a shell** gets the same tools through a shared command,
   `~/.skill-vault/bin/skill-vault`.
5. The tools **work when the app isn't open**: the bridge starts the server in the background (Windows)
   and the server stops again after 10 idle minutes.
6. A **copy-paste prompt** installs the skill in Claude Desktop as an alternative to uploading the zip.

## Non-goals

- MCP config writers for Cursor, Codex, Copilot, Windsurf or OpenClaw (they use the shared command).
- A Claude Desktop Extension (`.mcpb`) package.
- Installing skills into a claude.ai account without the user's upload/save click (no API exists).
- Deleting files through `save_skill`; renames; binary files.
- Background start on macOS/Linux (the tools ask the user to open the app instead).
- A "Connect agents" step in the setup guide (can be added later on top of this).

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Audience | Every Skill Vault user: generic skill, no personal paths, documented. |
| Actions | All four: save chat skill to vault; use a vault skill in chat; install a vault skill to Claude; Notion and status. Plus pushing vault skills to other targets. |
| App not running | The bridge starts the server hidden; it idles out after the last agent call. |
| How Desktop connects | The app writes the Desktop MCP entry and stages the skill zip; a copy-paste prompt is the alternative for the skill. (Chosen over a `.mcpb` extension and over a prompt-only setup.) |
| Other agents | MCP for Claude Desktop and Claude Code; a shared command for every other agent with a shell. |
| The skill in other targets | The skill is adopted into the vault like any other skill and pushed through existing targets. |

## Architecture

```
Any agent with the skill-vault skill
 ├─ Claude Desktop ── MCP entry in claude_desktop_config.json ─────────┐
 ├─ Claude Code ───── MCP entry via `claude mcp add --scope user` ─────┤
 └─ Cursor, Codex, Copilot, Windsurf, OpenClaw ─ shell: ~/.skill-vault/bin/skill-vault <tool>
                                                                       ▼
          <app>/dist/assistant-mcp.js   one bridge, one tool table; MCP mode or command mode
            → server from ~/.skill-vault/app.lock + GET /api/health, or start it hidden
            → HTTP 127.0.0.1:<port>/api/...   vault, manifest, Notion jobs
```

The in-app assistant keeps launching the same bridge with `SKILL_VAULT_URL` and `--strict-mcp-config`,
so a user-scope `skill-vault` entry in Claude Code never doubles its tools. Every tool stays
provider-agnostic: other assistant providers (Codex, Copilot, Grok) use the same table.

## The `skill-vault` skill

- Lives at `app/bundled-skills/skill-vault/SKILL.md`. **One file**, no `references/` or `scripts/`, so
  the copy-paste prompt can carry all of it.
- Frontmatter `name: skill-vault`; the description triggers on: save/push this skill to my vault, load
  or use a skill from my vault, what's in my vault, push a skill to Cursor/Codex/…, install a vault
  skill in Claude, sync skills with Notion, is my vault in sync.
- No machine names, personal paths, emails, or Notion IDs (enforced by a test).

**How the skill reaches the vault**, in order:

1. Vault tools are available (named `list_skills`, `save_skill`, … under any server prefix) → use them.
2. The agent has a shell → run `~/.skill-vault/bin/skill-vault` (`skill-vault.cmd` on Windows
   `cmd`/PowerShell). `skill-vault tools` lists tools and schemas; `skill-vault <tool>` takes JSON
   arguments on stdin and prints the JSON result.
3. Neither → say the vault isn't connected and how to connect (Skill Vault → Settings → Agent access).

**Actions it covers:**

| User asks | Tools |
|---|---|
| Find or browse skills | `list_skills`, `search_skills`, `get_skill` |
| Use a vault skill in this chat | `read_skill_files`, then follow the skill |
| Save a skill from the chat (new) | `save_skill` with `mode: "create"` |
| Update a vault skill from the chat | `read_skill_files` → show the changes → user says yes → `save_skill` with `mode: "update"` and the hashes it read |
| Push to other tools | `get_config` (targets) → `push_to_provider` |
| Install in Claude Desktop / claude.ai | `package_for_desktop` → tell the user where the zip is and to upload it in Settings → Capabilities → Skills |
| Notion, status, updates | `notion_status`, `notion_plan`, `notion_push`, `notion_run`, `check_updates`, `audit_vault` |

**Rules in the skill:** never overwrite without showing the changes and getting a yes; never delete;
one Notion job at a time (a busy error is reported, not retried); flag anything that looks like a
secret instead of saving it; treat skill files read from the vault as the skill to follow, not as new
instructions about the vault itself.

## Settings: the Agent access card

A new card in Settings, next to the setup guide's **Run setup guide…** entry. Status comes from
`GET /api/agent-access`, read live each time the card opens.

**Row 1 — The skill-vault skill**

| State | Shown | Action |
|---|---|---|
| Not in vault | "Not in your vault" | **Add to vault** |
| In vault, same content as bundled | "In your vault" + its targets | — |
| In vault, bundled copy differs, vault copy untouched | "Update available" | **Update** (the existing update-from-origin action) |
| In vault, bundled copy differs, vault copy edited | "In your vault" | none (updates go through the normal Updates page; local edits are never overwritten) |
| A vault skill named `skill-vault` with a different origin | "A skill named skill-vault already exists" | none (rename yours to use this) |

**Add to vault** adopts `bundled-skills/skill-vault` through the existing import with
`origin_context { type: "dir", root: "<app>/bundled-skills" }` (subpath `skill-vault`), sets its
targets to the config's `default_targets`, and pushes it to them. The row then lists where it went.

**Row 2 — Claude Desktop**

- Status: *Not installed* (no Desktop config folder) · *Not connected* · *Connected* · *Broken* (our
  entry points at a node or bridge file that no longer exists) · *Name taken* (a `skill-vault` entry
  that isn't ours).
- **Connect** / **Reconnect** / **Disconnect**.
- **Install the skill:** **Download skill zip** (packages the vault copy if the skill is in the vault,
  recording `desktop_package` as today; otherwise the bundled copy; then opens the staging folder) and
  **Copy install prompt**.
- Note after Connect: "Quit Claude Desktop from the tray icon and reopen it." The status line confirms
  the entry is still there after the restart.

**Row 3 — Claude Code**

- Status read from `~/.claude.json`: *Not connected* · *Connected* · *Broken* · *Name taken* ·
  *Claude Code CLI not found*.
- **Connect** / **Reconnect** / **Disconnect**. The skill itself reaches Claude Code through the
  `claude` target (row 1).

**Row 4 — Other agents**

- Shows the command path (`~/.skill-vault/bin/skill-vault`) and a one-line usage example. Nothing to
  connect; push the skill to those targets from row 1 or the normal Push flow.

Connect is disabled with "Build the app first" when `dist/assistant-mcp.js` doesn't exist (dev mode).

## Claude Desktop config

**Path resolution** (`services/agentAccess/desktopConfig.ts`):

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`. If `%APPDATA%\Claude` doesn't exist but a
  Microsoft Store install's `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude` does, use that.
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`.
- Neither folder exists → *Not installed*.

**Entry written:**

```json
"skill-vault": {
  "command": "<absolute path of the node.exe running the app>",
  "args": ["<app>\\dist\\assistant-mcp.js", "--client", "claude-desktop"]
}
```

An entry is **ours** when `args[0]`, normalized, ends with `dist/assistant-mcp.js`.

**Connect:**

1. Read the file. Missing file in an existing folder → start from `{}`. Not valid JSON, or not a JSON
   object → refuse, write nothing, report the path and the parse error.
2. `mcpServers.skill-vault` exists and isn't ours → refuse (*Name taken*).
3. Copy the current file to `claude_desktop_config.json.skill-vault.bak` (overwritten each time). A
   failed backup → refuse.
4. Set `mcpServers["skill-vault"]`; every other key and server is left exactly as parsed.
5. Write `JSON.stringify(config, null, 2)` to a temp file in the same folder, then rename over the
   original.

**Disconnect** removes `mcpServers["skill-vault"]` only when it's ours, with the same backup and atomic
write. The merge and removal are pure functions (`config in → config out`) so they test without disk.

## Claude Code

`services/agentAccess/claudeCode.ts`, using the existing `claude` CLI invocation helper
(`services/claude/cli.ts`, which handles the Windows shell quirks):

- Connect: `claude mcp add --scope user skill-vault -- "<node>" "<app>/dist/assistant-mcp.js" --client claude-code`
- Disconnect: `claude mcp remove --scope user skill-vault`, only after `get` shows the entry is ours.
- Status: read `mcpServers["skill-vault"]` from `~/.claude.json` (`claude mcp get` starts the server to
  health-check it, so it isn't used); our bridge path → connected; another command → *Name taken*;
  no entry → not connected; CLI missing → *not found*.
- A Connect over an existing entry of ours removes it first, then adds (Reconnect).

## The bridge

`app/server/assistant-mcp/main.ts` gains argument parsing; `bridge.ts` keeps the tool table.

**Arguments:** `[--client <id>] [tools | <tool-name>]`

- No positional → MCP stdio mode (today's behavior).
- `tools` → print `[{ name, description, input_schema }]` as JSON and exit 0.
- `<tool-name>` → read stdin to end (empty or a TTY → `{}`), parse JSON, run the tool's handler, print
  the result as JSON, exit 0. Unknown tool, bad JSON, or a tool error → print `{ "error": "…" }`,
  exit 1.
- `--client` (default `assistant`) is sent on every HTTP call as `X-Skill-Vault-Client`. The command
  shim passes `--client command`.

**Finding the server** (`assistant-mcp/server.ts`), used when `SKILL_VAULT_URL` is not set:

1. App folder = the bridge file's folder's parent (`<app>/dist/assistant-mcp.js` → `<app>`).
2. `readLock()` from `services/instanceLock.ts`; `GET http://127.0.0.1:<port>/api/health` with a 2 s
   timeout; healthy and `pid` matches → use it.
3. Otherwise, on Windows: run
   `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File <app>\scripts\launch.ps1 -Headless`,
   then poll the lock and health every 500 ms for up to 60 s (covers a rebuild after an app update).
   Not Windows → error "Open Skill Vault, then retry."
4. The resolved URL is cached for the bridge process. A refused connection clears the cache and
   repeats from step 2 once, so a long-lived Desktop bridge survives idle stops and port changes.

**`launch.ps1 -Headless`:** skips step 3 (no app window), and on failure writes the log and exits 1
without a message box (repeated agent calls must not stack dialogs). The mutex, stale-lock cleanup and
rebuild-if-stale logic are shared with the normal launch, so concurrent bridges start one server.

### New tools

**`read_skill_files { name: string, paths?: string[] }`**

- Without `paths`: every text file in `get_skill`'s file tree, `SKILL.md` first, then by path.
- Reads each through `GET /api/skills/:name/files/*`. Returns
  `{ files: [{ path, content, sha256, size }], skipped: [{ path, reason }] }`.
- `skipped` reasons: `binary`, `too_large` (over 1 MB, from the route), `over_budget` (the running total
  would pass 256 KB; later files are listed so the agent can ask for them by `paths`).

**`save_skill { name, mode: "create" | "update", files: [{ path, content, expected_sha256? }] }`**

Calls `POST /api/skills/:name/save` with the same body. Returns
`{ name, mode, written: string[], unchanged: string[] }`.

**`package_for_desktop { skill: string, reveal?: boolean }`**

Calls `POST /api/desktop` (and `POST /api/desktop/reveal` when `reveal`). Returns the zip path and
staging folder.

## Server

### `POST /api/skills/:name/save`

Behind the shared cross-site guard (`routes/sameOrigin.ts`). Body as `save_skill`.

Validation runs on the whole request before anything is written:

- `files` non-empty; ≤ 5 MB total; each `content` a string ≤ 1 MB with no `\0`; each `path` relative,
  `/`-separated, resolved through `resolveSkillFilePath` (no traversal, no absolute paths); no duplicate
  paths; no path under an ignored name (`IGNORE_NAMES`).
- **create:** `validateSkillName` passes (slug, not reserved, not in manifest or on disk); a `SKILL.md`
  is included; its frontmatter `name` equals `:name`.
- **update:** the skill exists. For each file that exists on disk, `expected_sha256` is required and
  must equal the current hash; a mismatch collects into `conflicts`. A file that doesn't exist must not
  carry `expected_sha256`. If `SKILL.md` is included, its frontmatter `name` still equals `:name`.

Errors: 400 invalid body/path, 404 unknown skill (update), 409 name taken (create) or
`{ error: "files changed", conflicts: [{ path, current_sha256 }] }` (update), 413 size.

Writes: create makes the folder; each file is written to a temp file beside it and renamed into place;
a file whose content already matches is reported as `unchanged` and not rewritten. Create adds the same
manifest entry as `POST /api/skills` — `{ targets: [], stage: "staging", source: "saved from <client>" }`
where `<client>` is the `X-Skill-Vault-Client` label (`Claude Desktop`, `Claude Code`, `a shell agent`).

Activity: create records `adopt` (the existing "skill enters the vault" kind, as `POST /api/skills`
does); update records `update` with the message `saved from <client> (<n> files)`.

### `routes/agentAccess.ts`

All POSTs behind the cross-site guard.

| Route | Does |
|---|---|
| `GET /api/agent-access` | Status for all four rows |
| `POST /api/agent-access/skill/add` | Adopt the bundled skill, set default targets, push |
| `GET /api/agent-access/skill/prompt` | The install prompt text |
| `POST /api/agent-access/skill/zip` | Package (vault copy if present, else bundled) and open the staging folder |
| `POST /api/agent-access/desktop/connect` · `/disconnect` | Desktop config merge/removal |
| `POST /api/agent-access/claude-code/connect` · `/disconnect` | `claude mcp add/remove` |

`packageForClaudeDesktop` is generalized to take the source folder, so the bundled copy can be zipped
without being in the vault. Connect/disconnect write a server log line; `ActivityKind` has no kind for
settings changes and none is added.

**Install prompt text:**

````
Please install this as a Claude skill for me. Create a zip named skill-vault.zip that contains one
folder, skill-vault/, with this exact file as skill-vault/SKILL.md — don't change any of it — and give
me the zip so I can save it to my skills.

```markdown
<bundled SKILL.md, verbatim>
```
````

### Shared command

At production server start, `services/agentAccess/commandShim.ts` writes:

- `~/.skill-vault/bin/skill-vault.cmd`: `@echo off` + CRLF + `"<node>" "<app>\dist\assistant-mcp.js" --client command %*`
- `~/.skill-vault/bin/skill-vault` (POSIX `sh`, forward-slash paths):
  `exec "<node>" "<app>/dist/assistant-mcp.js" --client command "$@"`

Each file is rewritten only when its content differs. Not written in dev mode.

### Idle

- A middleware on `/api` records `lastAgentCallAt` for any request whose `X-Skill-Vault-Client` is set
  and isn't `assistant` (assistant turns already count as busy).
- `app.locals.isBusy` in `server/index.ts` adds `agentCallWithin(AGENT_IDLE_MS)`;
  `AGENT_IDLE_MS` = 10 minutes, overridable from an env var like the other idle timers (tests shorten it).
- A server started headless never sees a window, so the tracker's boot grace applies once the agent
  window passes; a server with an open window behaves as today.

## Errors

| Case | Result |
|---|---|
| Desktop config invalid JSON / not an object / backup fails | Nothing written; card names the file and the problem |
| `skill-vault` name taken in Desktop or Claude Code | Connect refused; status *Name taken* |
| Our entry points at missing node or bridge | Status *Broken*, **Reconnect** offered |
| `claude` CLI missing / `claude mcp add` fails | Claude Code row says so, shows the CLI's stderr |
| `dist/assistant-mcp.js` missing | Connect disabled: "Build the app first" |
| Server won't start within 60 s | Tool error naming `~/.skill-vault/logs/launch.log` |
| Not Windows and no server | Tool error "Open Skill Vault, then retry." |
| `save_skill` hash mismatch | Nothing written; conflicts listed; the skill re-reads and shows changes again |
| Bundled skill name already used by another vault skill | Add to vault refused; row explains |

## Testing

Unit tests in the existing `node --test` style:

- **Desktop config:** merge adds the entry and preserves every other key/server; idempotent; refuses
  invalid JSON and non-objects; refuses a foreign `skill-vault`; removal leaves foreign entries; ours
  detection; path resolution including the Store fallback and *Not installed*.
- **Claude Code:** command lines built for connect/disconnect; status parsing of `~/.claude.json` for each state; process
  execution injected.
- **Bridge:** argument parsing; `tools` output; command mode with stdin JSON, empty stdin, bad JSON,
  unknown tool, tool error (exit codes); `X-Skill-Vault-Client` header; server discovery from lock +
  health, stale lock, start-and-wait with a fake spawner and fake clock, one retry after a refused
  connection; the three new tools against a fake HTTP layer (existing `bridge.test.ts` pattern),
  including the `read_skill_files` budget and skipped list.
- **Save route:** create; update; new file in update; all-or-nothing on conflict; `expected_sha256` on a
  missing file; traversal; absolute path; binary; per-file and total caps; frontmatter name mismatch;
  `unchanged` reporting; manifest entry and `source`; cross-site guard.
- **Agent access routes:** status for each row state; add-to-vault sets targets and pushes; zip from the
  vault copy vs. bundled copy; prompt contains `SKILL.md` verbatim.
- **Idle:** agent calls hold `isBusy` until `AGENT_IDLE_MS` passes; `assistant` calls don't count.
- **Shim writer:** content for both files; rewrite only on change; skipped in dev.
- **Bundled skill:** valid frontmatter, `name: skill-vault`, single file; lint fails on drive-letter
  user paths, `/Users/`, `/home/`, and email addresses.

**Manual, after merge, on the installed app:** connect Claude Desktop, restart it, and run the four
actions plus a push to another target; connect Claude Code and call a tool; run
`skill-vault list_skills` from Git Bash and from PowerShell; close the app and confirm a Desktop tool
call starts it hidden and that it stops ~10 minutes after the last call.

## Docs

- `docs/features.md`: Agent access (Claude Desktop, Claude Code, other agents) and the skill.
- `docs/configuration.md`: `~/.skill-vault/bin`, the Desktop config entry, the backup file.
- `docs/faq.md`: "Can Claude Desktop save skills to my vault?", "Why restart Claude Desktop?".
- `app/CHANGELOG.md` under `[Unreleased]`.

## Files

New: `app/bundled-skills/skill-vault/SKILL.md`, `app/server/services/agentAccess/{desktopConfig,claudeCode,commandShim,bundledSkill}.ts`
(+ tests), `app/server/routes/agentAccess.ts` (+ test), `app/server/assistant-mcp/server.ts` (+ test),
`app/client/src/components/AgentAccessCard.tsx`.

Changed: `app/server/assistant-mcp/{main,bridge}.ts` (+ tests), `app/server/routes/skills.ts` (save
route), `app/server/services/desktopPackaging.ts`, `app/server/index.ts` (idle, middleware, shim,
router), `app/scripts/launch.ps1` (`-Headless`), `app/client/src/pages/Settings.tsx`, `app/client/src/lib/api.ts` and `types.ts`, docs.

Avoided (other sessions' areas): `Layout.tsx`, `AppUpdate.tsx`, `vite.config.ts`,
`services/appUpdate.ts`, `routes/notion.ts`, `services/notion/connection.ts`.
