# Skill Vault

One library of agent skills, synced everywhere.

Skill Vault manages agent skills — the `SKILL.md` folder convention used by Claude Code, Claude Desktop, OpenClaw, Cursor, Codex, Copilot, Windsurf, and others. Instead of maintaining separate copies of each skill per tool, you keep a single **vault** directory on disk and push skills out to every agent that should have them.

The main way in is the **Skill Vault App**, a local web dashboard. A Python CLI (`sv`) covers the same vault for terminal workflows and automation — both share the same configuration and on-disk format, so you can use either or both.

## Quickstart

Requires Node 20+.

```bash
git clone https://github.com/pugliabi/skill-vault.git
cd skill-vault/app
npm install
npm run dev
# → opens http://localhost:5174
```

First run shows a Setup page: pick a vault directory, then add your agent tools as providers under **Settings**. Full walkthrough in [Getting Started](docs/getting-started.md); the optional `sv` CLI is covered there too.

## A tour of what you can do

### See the state of everything

![Dashboard](docs/images/dashboard.jpg)

The **Dashboard** is home base: skill and provider counts, synced / stale / missing status cards, a health bar per provider, and an *actions available* list. Each action row is a one-click fix — "1 skill drifted — re-push to update", "87 skills missing from a target — push to restore" — with the equivalent CLI command shown on the right.

### Let the AI assistant fix things for you

Press **Ctrl/⌘ + J** anywhere to open the built-in AI assistant — a docked chat
pane powered by your local [Claude Code](https://claude.com/claude-code) CLI. It
opens already knowing what needs attention: a **For you** list of ranked
suggestion cards (broken update sources, available updates, failed operations,
Notion drift, integrity issues…) computed from the app's own signals at zero AI
cost and kept fresh by a background source sweep. Every card has a **✦ Fix with
AI** button; every failure row and skill view has an **Ask AI** entry point.

The chat routes to the right agent for the context — a vault-wide agent for bulk
work, a per-skill agent when a skill is in focus — backed by specialist
subagents (repo-hunter, update-fixer, notion-doctor, error-triager). The
flagship trick: a skill whose upstream repo moved ("gone upstream") gets traced
through git history and the web, its origin repaired, and the update applied,
while you watch the tool timeline. Everything it does flows through the app's
own API — audited in Activity, reversible via version history — and destructive
operations are excluded from its toolset by design. There's a mic button for
dictation, and a one-click **AI briefing** that turns the suggestion list into a
prioritized plan. Full guide: [AI Assistant](docs/assistant.md).

### Find skills fast

![Skills list](docs/images/skills-list.jpg)

**Skills** lists the whole library with descriptions, tags, providers, and sync state. To find something: type in the filter box (matches names, descriptions, and full SKILL.md text), click a status pill (All · Production · Staging · Stale · Missing · Vault-only), or use the **Target** dropdown to combine a provider with a state — "show me everything missing from Cursor" is two clicks. Multi-select rows to push, tag, or remove in bulk, and press Ctrl/⌘-K anywhere for the command palette.

### Add a skill

![New skill](docs/images/new-skill.jpg)

Click **+ New** on the Skills page, give it a lowercase-hyphen name and an optional description (it becomes the `description:` frontmatter agents trigger on), and hit Create. The skill lands in the vault with a starter SKILL.md ready to edit. Already have a skill folder on disk? **Add existing** imports it instead (CLI: `sv add ./my-skill`).

### Edit a skill in place

![Editing SKILL.md](docs/images/skill-editor.jpg)

Open any skill → **files** tab → pick a file → **Edit**. You get the raw markdown with Save/Cancel; the preview mode renders it like an agent would read it. Because pushes are symlinks by default, saving here updates every agent that has the skill — no re-push needed.

### Push skills to your agents — and add targets

![Coverage matrix](docs/images/coverage-matrix.png)

The **coverage matrix** layout (grid icon on the Skills page) is the fastest way to push: rows are skills, columns are providers, a dot means synced. Click a single cell to push one skill to one provider, or a column header to push everything that's missing or stale there. The **Push** button on any skill opens a drawer where you pick targets per push and choose the method (`auto` tries a symlink, then a Windows junction, then a full copy).

Targets (providers) are managed in **Settings → Providers**: add a provider by giving it a name and the directory the agent reads skills from — path validation is live, and "★ All providers" adds every detected tool at once. CLI: `sv push [skill] -t <provider>`, providers via `sv config`.

### Adopt skills you already have — or from any repo

![Adopt scan](docs/images/adopt-scan.jpg)

**Adopt** pulls existing skills *into* the vault. Four sources: a local **Path** (scan any folder, recursively), a **Provider** (skills sitting in an agent directory that aren't in the vault yet), **Discover** (scan all providers at once), or a **Git URL** (clone a repo and harvest its skills). Scan results show every SKILL.md found, flag duplicates and what's already in the vault, and let you tick the ones to import. CLI: `sv discover`, `sv adopt`, `sv adopt-remote <git-url>`.

### Sync everything with a plan you approve

![Sync plan](docs/images/sync-plan.jpg)

**Sync** is the daily driver: it computes a two-way plan — push skills that drifted or are missing, pull edits made in provider directories back into the vault, adopt new skills it finds, promote staging — and shows it as a checklist with a per-row diff before anything runs. Deselect what you don't want, then **Run selected**. CLI: `sv sync`.

### Package for Claude Desktop

![Claude Desktop packaging](docs/images/claude-desktop-package.png)

Claude Desktop loads skills from your claude.ai account, so there's no folder to symlink into. Instead, pushing to the Claude Desktop target builds an **upload-ready zip** in a staging folder; finish by uploading it in Claude Desktop → Settings → Capabilities → Skills. Configure the staging folder in Settings, or zip any single skill from its detail view. CLI: `sv package <skill>`.

### Sync between your devices

![Devices](docs/images/devices.jpg)

Keep the vault in a git repo and every machine can share it. **Devices** shows a snapshot per machine — hit **Save snapshot** after a work session, commit/push the vault repo, and on another machine use **Sync from →** to compare that device's snapshot with local state and pick which skills to bring over. CLI: `sv snapshot`, `sv devices`, `sv sync-from <device>`.

### Inspect everything about a skill

![Skill detail](docs/images/skill-detail.jpg)

The skill detail view ties it together: overview (stage, source, path, tags), per-target sync state, and the full file tree with preview. From here you can Push, Pull, Zip, export to OpenClaw, Rename (cascades through the manifest and every provider), or Remove.

## The `sv` CLI

Everything above works headless. Requires Python 3.10+:

```bash
cd skill-vault
pip install .        # or: pipx install .
sv init              # wizard: vault directory + provider detection
sv quick             # discover → adopt → push, guided
sv status            # sync state per skill × provider
sv sync              # two-way sync plan
```

Full command list and flags in [Getting Started](docs/getting-started.md) and [Configuration](docs/configuration.md).

## Repository layout

```
app/                the Skill Vault App (Node 20+, Express + React/Vite)
src/skill_vault/    the sv CLI (Python 3.10+, click)
docs/               documentation + the shared vault format spec
pyproject.toml      packaging for the CLI (installs `sv` and `skill-vault`)
```

## Documentation

- [Getting Started](docs/getting-started.md) — full installation and setup guide
- [Features & Use Cases](docs/features.md) — the app and CLI feature tour, with screenshots
- [AI Assistant](docs/assistant.md) — the built-in chat agents, proactive suggestions, and voice input
- [Configuration Reference](docs/configuration.md) — every setting: config.json, env vars, CLI flags
- [Examples](docs/examples.md) — recipes for common workflows
- [Troubleshooting](docs/troubleshooting.md) — common issues and fixes
- [FAQ](docs/faq.md) — frequently asked questions
- [Vault Format](docs/vault-format.md) — the on-disk contract both tools implement

## License

[MIT](LICENSE)
