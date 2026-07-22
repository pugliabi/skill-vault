# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Scope

This CLAUDE.md applies to **`app/`** — the standalone Node/React web UI ("Skill Vault App"). The Python `sv` CLI lives at `../src/skill_vault/` and is referenced here only because the two tools **share configuration and on-disk format**, not code. Work inside `src/skill_vault/` follows different conventions (Python, click, separate CLAUDE context).

## Common commands

Run from `app/`:

```bash
npm install            # first time only
npm run dev            # tsx watch — server + Vite middleware on http://localhost:5174
npm run build          # build:client (vite) + build:server (esbuild → dist/)
npm run build:client   # vite build only — output to dist/public
npm run build:server   # esbuild bundle of launcher.ts + index.ts → dist/
npm run start          # run the built bundle (node dist/launcher.js)
npm run typecheck      # tsc --noEmit
```

There is **no test runner, linter, or formatter configured** in `app/package.json`. Don't invent npm scripts that don't exist; if you need them, ask first.

CLI flags are forwarded after `--`: `npm run dev -- --port 5500 --host 0.0.0.0 --no-open`. Config precedence is: CLI flag → env (`PORT`, `HOST`, `OPEN_BROWSER=0|1`) → `.env` → `app` block in `~/.skill-vault/config.json` → built-in defaults (port `5174`, host `127.0.0.1`, browser auto-open on).

When `--host 0.0.0.0` is used, Vite's host-header check is disabled via `allowedHosts: true` in `server/index.ts` so the dev server is reachable over the LAN. Windows Firewall may still block inbound to `node.exe` on first bind.

## Architecture: single-process server + Vite middleware

The whole app is **one Node process**:

- `server/launcher.ts` is the entry point. Parses argv, resolves port/host (incl. fallback to `~/.skill-vault/config.json` `app` block via `services/appConfig.ts:readCliAppBlock`), finds a free port, calls `createApp()`, calls `app.listen()`, optionally opens the browser.
- `server/index.ts` exports `createApp({ mode })` which returns the Express app **without** listening. Listen lives in the launcher so routes are easy to test with supertest later. In `mode: "development"` it mounts Vite in **middleware mode** (`createViteServer({ middlewareMode: true, allowedHosts: true })`) so HMR works from the same port. In `mode: "production"` it serves `dist/public/` static + SPA fallback.
- API is mounted under `/api/*` (config, skills, adopt, push). A JSON error handler scoped to `/api` converts thrown errors into `500 { error: "..." }` so route handlers can throw freely.

Anything not under `/api` is served by Vite/static. A blank screen with a "Blocked request" overlay almost always means Vite's host check; a connection refused on LAN is almost always Windows Firewall.

## Architecture: shared state with the `sv` CLI

This is the single most important fact about this codebase. **The app does not own its config.** It reads and writes the same files the Python `sv` CLI uses:

| File | Owner of format | App reads/writes via |
|---|---|---|
| `~/.skill-vault/config.json` | `src/skill_vault/config.py` | `app/server/services/appConfig.ts` |
| `<vault>/skills.json` | `docs/vault-format.md` | `app/server/services/vault.ts` |
| `<vault>/skills/<name>/...` | `docs/vault-format.md` | `app/server/services/vault.ts` |

Rules when touching either file:

1. **Round-trip preservation.** `~/.skill-vault/config.json` has top-level keys the app does not understand (`repo_url`, `machine_id`, `perplexity_stage`, `ai_scanner`, …). Always read the raw JSON, mutate only the keys you own, write it back. Never project to a typed shape and re-serialize — that drops keys silently. See `appConfig.ts:writeRaw`.
2. **`agent_locations` ↔ `providers` projection.** The CLI stores `{ id: path }`. The app exposes `Provider[]` (`{ id, path }`). Convert at the boundary in `appConfig.ts:readAppConfig` / `writeAppConfig`. The CLI's `agent_locations` map is the source of truth.
3. **Shared format = documentation contract.** When you change something that touches the on-disk format, update `../docs/vault-format.md` and verify the equivalent Python module (e.g. `src/skill_vault/linking.py` ↔ `app/server/services/linking.ts`). The two implementations don't share code; they share the spec.
4. **Trailing newline.** `appConfig.writeRaw` appends `\n` because the Python writer does. Keep them aligned to minimize diff churn when both tools rewrite the file.

When incorporating CLI features into the app, the pattern is: port the algorithm into TypeScript against the same docs/vault-format.md contract, do not shell out to the Python CLI. That's an explicit design rule (see `app/README.md` § "Relationship to the `sv` CLI" and `services/linking.ts` header).

## Backend layout

```
server/
├── launcher.ts        # CLI entry, port/host resolution, listen
├── index.ts           # createApp() — Express + Vite middleware
├── routes/
│   ├── config.ts      # GET/PUT /api/config, providers CRUD
│   ├── skills.ts      # list / detail (reads skills.json + filesystem)
│   ├── adopt.ts       # POST /scan, /import — pull skills from a directory
│   └── push.ts        # POST / — link a skill into a provider's directory
├── services/
│   ├── appConfig.ts   # raw read/write of ~/.skill-vault/config.json
│   ├── vault.ts       # read/write <vault>/skills.json + skills/ tree
│   ├── adoption.ts    # scanForSkills, importSkills
│   └── linking.ts     # symlink → junction → copy fallback (port of linking.py)
└── types/vault.ts     # types shared with the client (re-exported via lib/types.ts)
```

Routes are thin: validate body, call into a service, return JSON. Routes guard `vault_path` being null with `409 vault not configured` — the client treats this as "redirect to /setup".

## Frontend layout

React 18 + Vite + Tailwind + TanStack Query + wouter (router) + Radix-based shadcn primitives.

- `client/src/App.tsx` — top-level router. Fetches `/api/config` once, redirects to `/setup` if `vault_path` is null. Otherwise routes to `/skills`, `/skills/:name`, `/adopt`, `/settings`.
- `client/src/lib/api.ts` — the **only** module that calls `fetch`. All UI code goes through `api.*`. Errors throw `ApiError` with the server's `error` field as the message.
- `client/src/lib/types.ts` — re-exports types from `server/types/vault.ts` (single source of types across the boundary).
- `client/src/pages/` — one file per route, no nested routing.
- `client/src/components/Layout.tsx` — the only shared chrome.

The `@/` import alias points to `client/src/` (see `vite.config.ts`). Use it for cross-folder imports inside the client.

There is no global state library. TanStack Query is the cache; pages call `useQuery({ queryKey: [...], queryFn: () => api.X() })` directly. Mutations invalidate by query key.

## When porting from the `sv` CLI

The Python CLI is large (`src/skill_vault/cli.py` is the click entry point with commands like `init`, `add`, `push`, `pull`, `adopt`, `list`, `scan`, `import`, `sync-from`, …). When pulling a CLI feature into the app:

1. Read the Python implementation in `src/skill_vault/<module>.py` to understand the exact behavior, especially edge cases around symlinks, conflicts, and manifest writes.
2. Look at `docs/vault-format.md` to confirm what's contract vs. implementation detail.
3. Implement in TypeScript inside `server/services/` (algorithm) + a thin route in `server/routes/` (transport) + a query/mutation in `client/src/lib/api.ts` (client).
4. Reuse existing helpers: `vault.ts` for manifest I/O, `appConfig.ts` for config I/O, `linking.ts` for symlink/junction/copy, `adoption.ts` for scanning.
5. Don't add a Python or subprocess dependency. The npm package must be installable on a machine that has never seen Python.
