# Technical Reference

Architecture notes for contributors and integrators. The on-disk contract is
specified separately in [vault-format.md](./vault-format.md) — this page covers
the two implementations and the app's HTTP surface.

## Two implementations, one contract

- **`app/`** — the Skill Vault App: Express 5 + TypeScript server (`app/server/`),
  React 18 + Vite client (`app/client/`). Dev runs through `tsx`; production
  bundles with esbuild (server) and Vite (client) via `scripts/build.mjs`.
  Tests: `node:test` via `npm test` in `app/`.
- **`src/skill_vault/`** — the `sv` CLI: Python 3.10+, click.

They share no code. Both read/write the same vault format and
`~/.skill-vault/config.json`; interop is defined entirely by
[vault-format.md](./vault-format.md).

## App server layout

- `server/routes/*` — one Express router per area, mounted under `/api/*` in
  `server/index.ts`. Mutations record to the activity ring
  (`services/activity.ts`) and broadcast over SSE (`routes/events.ts`).
- `server/services/*` — the logic: vault/manifest IO (`vault.ts`), per-target
  sync status, update-from-source three-way checks (`updates.ts`), adoption,
  linking, version history (`.history/`), Notion sync (`services/notion/*`),
  Claude CLI integration (`services/claude/*`), and the assistant
  (`services/assistant/*`).
- Live updates: a chokidar watcher + an SSE channel (`GET /api/events`) with
  typed events (`skill_changed`, `provider_changed`, `activity`,
  `suggestions_changed`); the client maps them to react-query invalidations.
- App lifecycle: `server/launcher.ts` (flags, port choice, lock, idle stop,
  same-port restart) with `services/{instanceLock,portProbe,logFile,idleStop,appUpdate}.ts`
  and `routes/app.ts`; see [Install, launch, and self-update](#install-launch-and-self-update).

## HTTP API surface (summary)

All JSON under `/api`. The notable groups:

| Area | Endpoints |
|---|---|
| Config | `GET/PATCH /api/config`, provider CRUD |
| Skills | `GET /api/skills`, `GET/PATCH/DELETE /api/skills/:name`, `GET /api/skills/search`, `PATCH /api/skills/:name/origin` (origin repair + optional verify; `origin: null` clears it) |
| Updates & adoption | `POST /api/adopt/{scan,clone,import,check-updates,update,cleanup,discover}` |
| Push/pull/sync | `POST /api/push`, `POST /api/pull`, `GET /api/sync/plan` |
| Notion | `GET /api/notion/{status,summary,plan,guard}`, `POST /api/notion/{run,force,push-selected,…}` (job polling via `GET /api/notion/run/:id`) |
| History | `GET /api/history/...` (versions, restore, deleted skills) |
| Assistant | `GET /api/assistant/status` · `GET/PUT /api/assistant/auth` (sign-in mode; never returns the saved key) · `POST /api/assistant/stream` (NDJSON chat turn) · sessions CRUD + stop · `GET /api/assistant/suggestions`, `POST …/suggestions/{dismiss,restore,sweep}` · `POST /api/assistant/install-skills` |
| App | `GET /api/health` (pid, port, version, mode) · `GET /api/app/update` · `POST /api/app/update/check` · `POST /api/app/update` (NDJSON progress; cross-site POSTs refused) |
| Events | `GET /api/events` (SSE) |

## Install, launch, and self-update

Windows install and launch, and the git-based self-update. Design and
decisions: [specs/2026-10-27-install-and-launch-design.md](./superpowers/specs/2026-10-27-install-and-launch-design.md).

### Build

`npm run build` → `scripts/build.mjs`: Vite (client → `dist/public`) and
esbuild (`dist/launcher.js`, `dist/index.js`, `dist/assistant-mcp.js`), then
`dist/.build-stamp` (`{ built_at, git_sha }`). `--out <dir>` builds elsewhere
(the updater stages into `dist-next/`). `node scripts/build-state.mjs` exits
**0** when `dist/` is current and **10** when any watched source (`server/`,
`client/`, `assistant-plugin/`, package and build config files; test files
excluded) is newer than the stamp.

### Setup and the Start Menu launcher

`setup.ps1` (via `setup.cmd`) installs packages with `npm ci --include=dev`
(`NODE_ENV` removed), builds, and writes per-user shortcuts with WScript.Shell.
The **Skill Vault** shortcut runs
`conhost.exe --headless powershell.exe -File app\scripts\launch.ps1`, so no
console or Terminal window appears. `launch.ps1`:

1. Takes the per-user mutex `Local\SkillVaultLauncher` (one launch at a time).
2. Reuses a running server when `app.lock`'s pid is a live `node` process
   started before the lock was written and `/api/health` answers with that
   pid; a stale lock is removed.
3. Otherwise rebuilds if `build-state.mjs` exits 10, then starts
   `node dist/launcher.js --no-open --host 127.0.0.1 --exit-when-idle --log-file ~/.skill-vault/logs/server.log`
   hidden with `NODE_ENV=production`, and waits up to 20 s for the lock + health.
4. Opens `msedge --app=http://localhost:<port>/` (default browser if Edge
   isn't registered under App Paths).

Any failure shows a message box naming `~/.skill-vault/logs/launch.log`.

### Server lifecycle flags

| Flag | Effect |
|---|---|
| `--exit-when-idle` | Stop once no `/api/events` client has been connected for 60 s (120 s before the first window) and nothing is busy: a Notion job, an assistant turn, a user-started skill update check, or an app update. |
| `--log-file <path>` | Tee stdout/stderr (and uncaught exceptions) into `<path>`, rotated at 5 MB, 3 kept. |
| `--strict-port` | Use exactly `--port`, waiting up to 10 s for it; used by the update restart so the open window's URL stays valid. |

`app.lock` (`{ pid, port, started_at, version, mode }`) is written after
`listen` only when no live process holds it, and removed on shutdown only by
its owner. For a loopback host a port counts as free only if it binds and
nothing accepts connections on `127.0.0.1` or `::1` (Windows lets a loopback
bind succeed beside a wildcard listener); the check connects rather than
binding `0.0.0.0`, so it can't raise a Windows Firewall prompt.

### Self-update (`services/appUpdate.ts`)

- **Check** (built app only; 30 s after start, then every 6 h, skipped while
  busy): `git fetch origin`, then branch, ahead/behind against `origin/main`,
  `status --porcelain`, and the incoming commit subjects.
- **Refused** (with a reason) when: not a git checkout, `app/` isn't directly
  inside it, no origin or no `origin/main`, running from source, not on
  `main`, uncommitted changes, local commits not on GitHub, already up to
  date, an update already running, or a job running.
- **Apply** (one at a time, NDJSON `{ step, state, message? }`):
  `git pull --ff-only` → `npm ci --include=dev` only if `package-lock.json`
  changed → `node scripts/build.mjs --out dist-next` → rename `dist` →
  `dist-old`, `dist-next` → `dist` (never a copy over the live build) → if a
  job is running, emit `restart:wait` and wait → `restart:start` and hand over:
  the old server releases the lock, spawns
  `dist/launcher.js --strict-port …` on the same port, and shuts down once the
  successor has spawned. If it can't spawn, the old server takes the lock back
  and keeps running.
- **Failure** before the hand-over: the failing step's full output goes to the
  server log, the checkout is reset with `git reset --keep <old sha>` (refuses
  rather than discarding edits made meanwhile), packages are reinstalled if
  they were changed, and the running build keeps serving.

## The AI assistant internals

One chat turn = one headless `claude -p` spawn (Claude Code CLI) with:

- `--session-id`/`--resume` for conversation memory (sessions are keyed by
  cwd, which is pinned to the vault path);
- `--output-format stream-json` adapted server-side into a compact NDJSON
  event stream on the `POST /api/assistant/stream` response (`text_delta`,
  `tool_start`/`tool_result`, `turn_end` with cost, `error`). Tool labels
  are computed server-side in `streamEvents.ts` (`labelForTool`), which
  handles both the `Task` and `Agent` delegation tool names and strips the
  plugin namespace from agent and skill names;
- `--plugin-dir app/assistant-plugin` providing the vault-assistant lead,
  five thin skill-backed subagents (repo-hunter, update-fixer, skill-scout,
  error-triager, notion-doctor), and ten skills with references/ files
  (readable at runtime via a second --add-dir of the plugin dir);
- `--mcp-config` launching `server/assistant-mcp/` — a stdio MCP server whose
  tools call back into the app's own HTTP API (hence auditing/history for
  free). ~19 tools; deliberately no delete, no Notion force, no OAuth;
- an allowlist as the safety boundary: file tools scoped to the vault,
  `Bash(git:*)` only, web search/fetch, `mcp__vault__*`.

Proactive suggestions are deterministic: `services/assistant/suggestions.ts`
composes ranked cards from live signals (statuses, audit, activity, Notion
state from `listSkills`) plus the background sweep
(`services/assistant/updateSweep.ts` — 45 s after boot, then 6-hourly,
single-flight, yields to foreground checks, lite cache in
`~/.skill-vault/update-sweep.json`). Dismissals persist server-side with
fingerprint-revival semantics. Voice input is the browser Web Speech API
(`client/src/lib/speech.ts`).

## Repository roles

Since 2026-10-06 this repository is the single home of the product: the app
(`app/`), the `sv` CLI (`src/skill_vault/`), and all documentation are
developed directly here. The user's skill library itself (the vault that
`vault_path` points at) lives in a separate private repository — this repo
ships the tools, not the skills. (Historical note: before the split, code was
mirrored in from that private repo; those `[sv-sync]` commits are the residue.)
