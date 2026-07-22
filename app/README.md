# Skill Vault App

Standalone web UI for managing a Skill Vault directory. Independent of the
Python `sv` CLI in code and process, but **shares configuration** with it:
both tools read and write the same `~/.skill-vault/config.json` and the
same on-disk vault format (see [../docs/vault-format.md](../docs/vault-format.md)).

A user who already ran `sv init` sees their vault and providers here
immediately — no re-entry. A user who configured things in the app can
run `sv push` in a terminal and it Just Works.

## Features

- **Skills browser** — list / cards / grouped / **coverage-matrix** layouts,
  search (name, description, and full **SKILL.md** body), sort, multi-select
  with a bulk action bar, side-panel preview + full detail overlay.
- **Target-aware filtering** — filter by provider and sync state
  (`configured` / `synced` / `stale` / `missing`); the coverage matrix and
  Dashboard health bars make the "what's not synced where" gap visible and
  one-click fixable.
- **Curation** — heuristic **auto-tagging**, and a **Health board** that flags
  trigger collisions (near-duplicate descriptions) and low-quality skills
  (SKILL.md quality score).
- **Sync** — smart two-way plan (push / pull / adopt / promote / package) with
  per-row **diff-before-run**.
- **Providers** — CRUD with live path validation; "★ All providers" bulk add;
  Claude Desktop packaging; **Export to OpenClaw** (installs into the isolated
  OpenClaw WSL gateway via its own CLI).
- **Devices** — snapshot + cross-machine compare/sync.
- **Command palette** (⌘K) — jump to any skill or run a command.
- **Topology** graph of vault → providers, deep-linking into filtered views.

See [CHANGELOG.md](./CHANGELOG.md) for the full history.

## Install & run

```bash
cd app
npm install
npm run dev
# → opens http://localhost:5174
```

Or once published to npm:

```bash
npx skill-vault-app
```

## Configuration

### Runtime (port, host, auto-open)

Precedence — highest wins:

1. **CLI flags** — pass after `--` when using npm:
   ```bash
   npm run dev -- --port 5500 --host 0.0.0.0 --no-open
   ```
   Or directly when using the binary:
   ```bash
   skill-vault-app --port 5500 --host 0.0.0.0
   skill-vault-app --help
   ```
2. **Environment variables** — `PORT`, `HOST`, `OPEN_BROWSER` (`0` or `1`).
3. **`.env` file** — copy `.env.example` to `.env` in this directory.
   This file is gitignored, so local customization stays local.
4. **`app` block in `~/.skill-vault/config.json`** — the same block the
   old `sv app` command used. If you customized `app.port` / `app.host`
   / `app.auto_open_browser` back then, those values still apply.
5. **Built-in defaults** — port `5174` (deliberately not `5000` to dodge
   any stale `sv app` process), host `127.0.0.1`, open browser on.

### Vault + providers

These live in `~/.skill-vault/config.json`, shared with the CLI:

- **`vault_path`** — the directory that holds `skills.json` and the
  `skills/` tree. Set via the first-run Setup page, or via
  `sv init` / `sv config set vault_path ...`.
- **`agent_locations`** — `{ slug → path }` map. The app projects this
  into the **Providers** list in the Settings page. Add, rename, or
  remove providers in either tool — changes are visible to both.

All other top-level keys the CLI writes (`repo_url`, `machine_id`,
`perplexity_stage`, `ai_scanner`, `default_targets`, …) are preserved
round-trip by the app. The app never rewrites keys it doesn't own.

## Relationship to the `sv` CLI

```
┌──────────────┐     reads/writes    ┌─────────────────────────┐
│  sv (CLI)    │──┬───────────────▶  │ ~/.skill-vault/         │
│  Python      │  │                  │   config.json           │
└──────────────┘  │                  └─────────────────────────┘
                  │
┌──────────────┐  │                  ┌─────────────────────────┐
│ skill-vault- │──┴───────────────▶  │ <vault>/                │
│   app (Node) │     reads/writes    │   skills.json           │
└──────────────┘                     │   skills/<name>/...     │
                                     └─────────────────────────┘
```

No shared code. No subprocess calls. No npm bootstrap from the CLI, no
Python bundled in the npm package. Just two implementations against a
documented pair of JSON schemas and a directory layout. Either tool can
be installed standalone, used exclusively, and interoperate with the
other at any point.

## Tech stack

- Node 20 + Express 5 + TypeScript (server)
- React 18 + Vite + Tailwind + shadcn/ui + TanStack Query + wouter (client)
- dotenv for `.env` loading
- No SQLite, no native dependencies. The vault filesystem is the source
  of truth; the server keeps a small in-memory cache per request.
