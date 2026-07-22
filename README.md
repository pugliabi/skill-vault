# Skill Vault

One library of agent skills, synced everywhere.

Skill Vault is a local-first tool for managing agent skills — the `SKILL.md` folder convention used by Claude Code, Claude Desktop, OpenClaw, Cursor, Codex, Copilot, Windsurf, and others. Instead of maintaining separate copies of each skill per tool, you keep a single **vault** directory on disk and push skills out to every agent that should have them.

It ships as two independent tools that share the same configuration and on-disk format:

- **`sv`** — a Python CLI for init, discover, adopt, push/pull, two-way sync, packaging, and multi-device snapshots.
- **Skill Vault App** (`app/`) — a Node/React web dashboard for the same vault: skills browser, coverage matrix, health board, diff-before-run sync, provider management, and device compare.

Both read and write `~/.skill-vault/config.json` and the same vault layout, so you can use either one — or both interchangeably. The format is documented in [docs/vault-format.md](docs/vault-format.md).

![Skill Vault dashboard](docs/images/dashboard.jpg)

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

## Repository layout

```
src/skill_vault/    the sv CLI (Python 3.10+, click)
app/                the Skill Vault App (Node 20+, Express + React/Vite)
docs/vault-format.md   the shared vault + config format spec
pyproject.toml      packaging for the CLI (installs `sv` and `skill-vault`)
```

## Install the CLI

Requires Python 3.10+.

```bash
git clone https://github.com/pugliabi/skill-vault.git
cd skill-vault
pip install .        # or: pipx install .
sv --help
```

## Install the app

Requires Node 20+.

```bash
cd app
npm install
npm run dev
# → opens http://localhost:5174
```

Port, host, and auto-open are configurable — see [app/README.md](app/README.md) and [app/.env.example](app/.env.example). On Windows, `app/run.bat` is a convenience launcher.

## Quickstart

```bash
sv init          # wizard: choose a vault directory, detect agent tools
sv discover      # scan agent directories for skills you already have
sv adopt         # pick discovered skills to import into the vault
sv push          # push vault skills out to your agents (symlinks by default)
sv status        # see what's synced, stale, or missing per target
sv sync          # smart two-way sync: detects changes everywhere, proposes a plan
```

Or run `sv quick` for a guided discover → adopt → push in one step. The app's first-run Setup page does the same job in the browser.

## Adding your own skills

A skill is a folder containing a `SKILL.md` (YAML frontmatter with `name` and `description`, then instructions), plus any supporting files or scripts:

```
my-skill/
├── SKILL.md
├── references/     (optional)
└── scripts/        (optional)
```

Add it to the vault and push it everywhere:

```bash
sv add ./my-skill
sv push my-skill
```

Or create it in the app: **Skills → New skill**, edit the `SKILL.md` in place, then push from the coverage matrix. You can also pull in third-party skills with `sv adopt-remote <git-url>`.

Other useful commands: `sv list`, `sv share` (cross-publish one skill to more providers), `sv package` (build a target-specific package, e.g. a Claude Desktop zip), `sv watch` (auto-push on change), `sv snapshot` / `sv devices` / `sv sync-from` (multi-machine sync via your vault repo), `sv fix` (audit and repair vault state).

## Configuration

Everything lives in `~/.skill-vault/config.json`, shared by both tools:

- `vault_path` — the directory holding `skills.json` and `skills/`
- `agent_locations` — map of provider slug → skills directory (defaults cover `~/.claude/skills`, `~/.openclaw/skills`, `~/.cursor/skills`, `~/.codex/skills`, `~/.copilot/skills`, `~/.windsurf/skills`)

Change it via `sv config`, the app's Settings page, or by editing the file — each tool preserves keys it doesn't own.

## Documentation

- [Getting Started](docs/getting-started.md) — full installation and setup guide
- [Features & Use Cases](docs/features.md) — the app and CLI feature tour, with screenshots
- [Configuration Reference](docs/configuration.md) — every setting: config.json, env vars, CLI flags
- [Examples](docs/examples.md) — copy-pasteable recipes for common workflows
- [Troubleshooting](docs/troubleshooting.md) — common issues and fixes
- [FAQ](docs/faq.md) — frequently asked questions
- [Vault Format](docs/vault-format.md) — the on-disk contract both tools implement

## License

[MIT](LICENSE)
