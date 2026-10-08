# Technical Reference

Architecture notes for contributors and integrators. The on-disk contract is
specified separately in [vault-format.md](./vault-format.md) — this page covers
the two implementations and the app's HTTP surface.

## Two implementations, one contract

- **`app/`** — the Skill Vault App: Express 5 + TypeScript server (`app/server/`),
  React 18 + Vite client (`app/client/`). Dev runs through `tsx`; production
  bundles with esbuild (server) and Vite (client). Tests: `node:test` via
  `npm test` in `app/`.
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
| Assistant | `GET /api/assistant/status` · `POST /api/assistant/stream` (NDJSON chat turn) · sessions CRUD + stop · `GET /api/assistant/suggestions`, `POST …/suggestions/{dismiss,restore,sweep}` · `POST /api/assistant/install-skills` |
| Events | `GET /api/events` (SSE) |

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
