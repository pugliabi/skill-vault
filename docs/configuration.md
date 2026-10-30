# Configuration Reference

Everything both tools read lives in **`~/.skill-vault/config.json`**, shared by the CLI and the app. The app additionally accepts runtime overrides (CLI flags, environment variables, `.env`). This page documents every surface.

Inspect or edit config from the CLI at any time:

```bash
sv config show            # pretty-print the whole config
sv config get vault_path
sv config set vault_path ~/skills-vault
sv config path            # print the config file location
sv config list            # list all keys
```

Sensitive values (API keys) are masked in `sv config show` output.

## `~/.skill-vault/config.json`

### vault_path

- **Purpose**: Absolute path to the vault root — the directory holding `skills.json`, `skills/`, `staging/`, `snapshots/`
- **Type**: string
- **Default**: Required — set by `sv init` or the app's setup guide
- **Example**: `"vault_path": "C:\\Github\\my-skills"`

### agent_locations

- **Purpose**: Map of provider slug → skills directory. This is what the app projects into its Providers list.
- **Type**: object `{ "slug": "path" }`
- **Default**: populated by `sv init` from detected tools. Detection covers `~/.claude/skills`, `~/.openclaw/skills`, `~/.cursor/skills`, `~/.codex/skills`, `~/.copilot/skills`, `~/.windsurf/skills`.
- **Example**: `"agent_locations": { "claude": "/home/me/.claude/skills", "cursor": "/home/me/.cursor/skills" }`
- **Notes**: Slugs are arbitrary — add custom providers pointing anywhere (e.g. a project repo's skills folder).

### default_targets

- **Purpose**: Providers that `sv push` targets when no `-t` flag is given; also the app's default for new skills
- **Type**: string[]
- **Default**: all providers registered at init
- **Example**: `"default_targets": ["claude", "cursor"]`

### repo_url

- **Purpose**: Git remote of the vault repo, used by multi-device workflows
- **Type**: string
- **Default**: `""`

### machine_id

- **Purpose**: This machine's name in device snapshots (`snapshots/<machine-id>.json`)
- **Type**: string
- **Default**: the machine hostname (`platform.node()`)

### repos_dir

- **Purpose**: Default directory that `sv scan` / adoption workflows use when scanning local repos
- **Type**: string
- **Default**: unset

### perplexity_stage

- **Purpose**: Staging directory for Perplexity packaging output
- **Type**: string
- **Default**: `<vault>/.perplexity-packages`

### claude_desktop_stage

- **Purpose**: Directory where Claude Desktop packaging drops upload-ready zips (Claude Desktop has no local skills folder to link into — you upload the zip in Claude Desktop → Settings → Capabilities → Skills)
- **Type**: string
- **Default**: `<vault>/../.claude-desktop-packages`

### ai_scanner

- **Purpose**: Configures the optional AI-assisted repo scanner used by `sv scan`
- **Type**: object
- **Fields**:
  - `provider` — `"claude-cli"` (default; uses a local `claude` CLI) or `"anthropic-sdk"` (direct API)
  - `api_key` — API key for the SDK provider (optional; masked in `sv config show`)
  - `api_key_env` — environment variable to read the key from instead (default `ANTHROPIC_API_KEY`)
- **Example**:
  ```json
  "ai_scanner": { "provider": "anthropic-sdk", "api_key_env": "ANTHROPIC_API_KEY" }
  ```

### assistant

- **Purpose**: How the app's `claude` CLI calls sign in — the AI assistant, AI tagging and Claude merge. Edited in **Settings → AI assistant → Sign in with**.
- **Type**: object
- **Fields**:
  - `auth` — `"login"` (default: Claude Code's own login; `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed from the CLI's environment so a key set for another tool can't take over) or `"api_key"`
  - `api_key` — saved key for `"api_key"` mode (optional; without it the environment's `ANTHROPIC_API_KEY` is used). Stored in plain text; the app never sends it back to the browser
  - `workspace_id` — sent as the `anthropic-workspace-id` header, for keys not scoped to a workspace
  - `engine` — the provider for new chats: `claude` (default), `codex`, `copilot`, `grok`
  - `engines.<id>.auth` — `login` (default) or `api_key`, for each non-Claude provider
  - `engines.<id>.api_key` — a saved key, stored in plain text in this file; never sent to the browser
- **Provider files**: per-turn files live in `~/.skill-vault/engines/<id>/`. Grok's app-only sign-in is in `~/.skill-vault/engines/grok/` (API-key mode uses `grok-apikey/`). Pick the provider in **Settings → AI assistant → Provider**; see [assistant.md](./assistant.md#providers).
- **Example**:
  ```json
  "assistant": { "auth": "api_key", "workspace_id": "wrkspc_…" }
  ```

### app

- **Purpose**: Runtime fallback settings for the web app — the lowest-precedence source before built-in defaults
- **Type**: object
- **Fields**: `port` (number), `host` (string), `auto_open_browser` (boolean)
- **Notes**: Kept for compatibility with the old `sv app` command. The app never rewrites keys it doesn't own; any other top-level keys in the file are preserved round-trip.

## App runtime configuration

Precedence, highest wins:

1. **CLI flags** — `--port`/`-p`, `--host`/`-h`, `--no-open`, `--help`, plus the launcher's `--exit-when-idle` (stop about 60 s after the last window closes), `--log-file <path>` (also write output to a file, rotated at 5 MB, 3 kept) and `--strict-port` (use exactly `--port`; wait up to 10 s, else exit). Pass after `--` with npm: `npm run dev -- --port 5500 --host 0.0.0.0 --no-open`
2. **Environment variables** — `PORT`, `HOST`, `OPEN_BROWSER` (`1`/`0`)
3. **`.env` file** in `app/` — copy [`app/.env.example`](../app/.env.example) to `app/.env`
4. **`app` block** in `~/.skill-vault/config.json`
5. **Built-in defaults** — port `9994`, host `127.0.0.1`, open browser on

If the chosen port is busy, the launcher picks the next free one automatically.

### PORT

- **Where**: env / `.env` / `--port`
- **Type**: number — **Default**: `9994`
- **Notes**: Deliberately not 5000 (the old `sv app` port) to dodge stale-process collisions.

### HOST

- **Where**: env / `.env` / `--host`
- **Type**: string — **Default**: `127.0.0.1`
- **Notes**: Set `0.0.0.0` to expose on your LAN — only on trusted networks, since the dashboard can mutate your vault and agent directories. With `0.0.0.0` the dev server disables Vite's host-header check so it's reachable over the LAN; Windows Firewall may still prompt on first bind.

### OPEN_BROWSER

- **Where**: env / `.env` / `--no-open` flag
- **Type**: `1` | `0` — **Default**: `1` (open on startup)

### NODE_ENV

- **Where**: env / `.env`
- **Default**: unset (dev). Set `production` only after `npm run build` to serve the bundled client from `dist/`. The Start Menu launcher sets it for you.

## Launcher files (per machine)

The Start Menu launcher keeps a few files in `~/.skill-vault/`:

- `app.lock` — the running server's pid, port and version, so a second click reuses it. Removed when that server stops.
- `logs/server.log` (+ `.1`–`.3`) — output of the server started by the launcher.
- `logs/launch.log` — the launcher's own steps and any rebuild output.

All are safe to delete while the app is closed.

## Setup guide files (per machine)

- `setup-draft.json` — the setup guide's answers while it's open (vault choice, tools, picks, Notion database, assistant mode). Never holds your API key or Notion sign-in. Deleted when Finish saves your settings, or when you press Start over / Close. Safe to delete.

A server started from the Start Menu always binds `127.0.0.1` (only this computer can reach it), whatever `HOST` says; to expose the app on your LAN, run it from a terminal instead: `npm run dev -- --host 0.0.0.0`.

## Assistant state files (per machine)

The AI assistant keeps its state in `~/.skill-vault/`, next to the config —
never inside the vault, never committed:

- `assistant-sessions.json` — chat history index so conversations survive app
  restarts (the Claude Code CLI holds the full transcripts and resumes them).
- `update-sweep.json` — the background source sweep's cached statuses + git
  ahead/behind, feeding the "For you" suggestion cards. Ignored automatically
  when `vault_path` changes.
- `assistant-suggestions.json` — dismissed suggestion cards (a dismissal lasts
  7 days or until the card's content changes).

All three are safe to delete; they regenerate. The assistant also uses
`repos_dir` (above) as the home for git clones it works with, and needs no
configuration of its own beyond a signed-in `claude` CLI — see
[assistant.md](./assistant.md).

## CLI flags worth knowing

Run `sv <command> --help` for the full set per command. Frequently used:

- `sv push` — `--target/-t <slug>` (repeatable), `--force/-f` (push even if hashes match), `--copy` (copy instead of symlink), `--dry-run`, `--select` (interactive per-target picker)
- `sv sync-from <device>` — `--dry-run`, `--overwrite`
- `sv discover` — scans agent dirs; options include plugin scanning
- `sv scan <path>` — repo scanner; honors `ai_scanner` config

## Vault format

The on-disk contract both tools implement — `skills.json` manifest schema, skill entry fields, snapshot schema — is specified in [vault-format.md](./vault-format.md). Anything that reads/writes those files faithfully can interoperate with both tools.
