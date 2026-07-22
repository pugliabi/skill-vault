# Getting Started

This guide walks through installing both Skill Vault tools, creating your first vault, and syncing skills to your agents. If you just want the two-minute version, see the [README quick start](../README.md#quickstart).

## Prerequisites

- **Python 3.10+** — for the `sv` CLI
- **Node.js 20+** — for the Skill Vault App (the web dashboard). Optional; the CLI works standalone.
- **git** — required for `sv adopt-remote` and multi-device sync via a vault repo; optional otherwise
- A machine with at least one agent tool installed (Claude Code, Cursor, OpenClaw, Codex, Copilot, Windsurf, …). Not strictly required — you can build a vault first and add providers later.

## Install the CLI

```bash
git clone https://github.com/pugliabi/skill-vault.git
cd skill-vault
pip install .
```

`pipx install .` also works and keeps the tool isolated. Both install two identical entry points: `sv` (short) and `skill-vault` (long).

Verify:

```bash
sv --help
```

## Initialize your vault

```bash
sv init
```

The interactive wizard asks for:

1. **Vault path** — the directory that will hold your skill library (e.g. `C:\Github\my-skills` or `~/skills-vault`). Pick a directory you back up or keep in a git repo; the vault is the source of truth.
2. **Agent locations** — `sv` detects standard skills directories (`~/.claude/skills`, `~/.cursor/skills`, `~/.openclaw/skills`, `~/.codex/skills`, `~/.copilot/skills`, `~/.windsurf/skills`) and asks which to register as providers.
3. **Defaults** — which providers new skills should push to by default.

The wizard writes `~/.skill-vault/config.json` and creates the vault layout:

```
<vault>/
├── skills.json     # manifest: name → entry for every skill
├── skills/         # one folder per production skill
├── staging/        # skills not yet promoted to production
└── snapshots/      # per-device state files (multi-device sync)
```

## Bring in the skills you already have

Most people already have skills scattered across agent directories. Two commands pull them into the vault:

```bash
sv discover        # scan registered agent directories for skills
sv adopt           # interactively pick which discovered skills to import
```

Or do the whole loop guided:

```bash
sv quick           # discover → adopt → push in one step
```

## Push to your agents

```bash
sv push                     # push everything to your default targets
sv push my-skill            # push one skill
sv push -t claude -t cursor # limit to specific providers
```

By default `sv push` creates **symlinks** from the agent directory into the vault, so a skill edited in the vault is instantly current everywhere. Use `--copy` for real file copies (some tools or filesystems don't follow symlinks; Windows may require Developer Mode for symlink creation).

Check the result:

```bash
sv status
```

Each skill shows its state per provider: `synced` (identical), `stale` (vault changed since last push), `missing` (not present at the target), or vault-only.

## Run the app (optional)

```bash
cd app
npm install
npm run dev
# → http://localhost:5174
```

The app reads the same `~/.skill-vault/config.json` — if you ran `sv init`, your vault and providers appear immediately. If you never ran the CLI, the app shows a first-run Setup page that does the same job in the browser.

On Windows, `app\run.bat` loads `.env`, prints the resolved port/host, and starts the dev server.

## Verify everything works

1. `sv list` shows your vault's skills.
2. `sv status` shows sync state per provider.
3. The app Dashboard shows skill/provider counts, health bars per provider, and one-click fix actions for anything drifted or missing.
4. Open your agent tool — the pushed skills should be available (for Claude Code, check `~/.claude/skills`).

## Common first-run issues

- **`sv: command not found`** — the pip scripts directory isn't on PATH. Use `pipx`, or `python -m skill_vault`.
- **Symlink creation fails on Windows** — enable Developer Mode (Settings → System → For developers) or run `sv push --copy`.
- **App port already in use** — the launcher automatically picks the next free port; or set one explicitly with `npm run dev -- --port 5500`.

More in [Troubleshooting](./troubleshooting.md).
