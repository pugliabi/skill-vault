# Getting Started

This guide walks through installing the Skill Vault App, creating your first vault, adopting the skills you already have, and pushing them to your agents — then adds the optional `sv` CLI. For the two-minute version, see the [README quick start](../README.md#quickstart).

## Prerequisites

- **Node.js 20+** — for the Skill Vault App
- **Python 3.10+** — only if you also want the `sv` CLI
- **git** — required for adopting skills from git URLs and multi-device sync; optional otherwise
- At least one agent tool that loads skills from a directory (Claude Code, Cursor, OpenClaw, Codex, Copilot, Windsurf, …). Not strictly required — you can build a vault first and add providers later.

## Install and launch the app

```bash
git clone https://github.com/pugliabi/skill-vault.git
cd skill-vault/app
npm install
npm run dev
# → opens http://localhost:9994
```

On Windows, `app\run.bat` does the same and prints the resolved port/host first. Port, host, and browser auto-open are configurable — see [Configuration](./configuration.md).

## First-run setup

The first launch shows a **Setup** page:

1. **Pick a vault directory** — the folder that will hold your skill library (e.g. `C:\Github\my-skills` or `~/skills-vault`). Choose somewhere you back up, ideally a git repo; the vault is the source of truth. The app creates the layout:

   ```
   <vault>/
   ├── skills.json     # manifest: one entry per skill
   ├── skills/         # one folder per production skill
   ├── staging/        # skills not yet promoted to production
   └── snapshots/      # per-device state files (multi-device sync)
   ```

2. **Add providers** — go to **Settings → Providers** and add each agent tool: a name plus the directory it reads skills from (`~/.claude/skills`, `~/.cursor/skills`, and so on). Path validation is live, and "★ All providers" adds every detected tool in one click.

3. **Set defaults** — the Defaults section picks which providers new skills push to unless you say otherwise.

Everything is stored in `~/.skill-vault/config.json`, shared with the CLI.

## Bring in the skills you already have

Open **Adopt**. Pick a source — **Discover** scans all your providers at once for skills that aren't in the vault yet; **Path** scans any folder; **Git URL** clones a repo and harvests its skills. Scan, tick the skills you want, and import. Duplicates and things already in the vault are flagged so you don't import twice.

## Push to your agents

Open **Skills** and switch to the **coverage matrix** layout (grid icon). Click a provider's column header to push everything missing there, or individual cells for one skill at a time. Pushes are symlinks by default, so future edits in the vault are live everywhere immediately; the push drawer's `auto` method falls back to a Windows junction, then a full copy, when symlinks aren't available.

Then check the **Dashboard** — the status cards and per-provider health bars should show your pushes, and any drift shows up as a one-click fix action.

## Verify everything works

1. The Dashboard shows your skill count and providers with green/amber health bars.
2. Skills page: pushed skills show a `synced` badge for their providers.
3. Open your agent tool — the pushed skills should be available (for Claude Code, look in `~/.claude/skills`).

## Add the CLI (optional)

Same vault, same config, for terminals and scripts:

```bash
cd skill-vault
pip install .        # or: pipx install .
sv --help
```

If you set up in the app, `sv status` immediately shows your vault — no re-entry. Starting fresh from the CLI instead? `sv init` runs the same setup as a wizard. The daily commands:

```bash
sv quick             # discover → adopt → push, guided
sv sync              # two-way sync plan (the Sync page's engine)
sv push [skill]      # push all or one; -t <provider> to limit
sv status            # sync state per skill × provider
sv list              # what's in the vault
```

Also available: `sv add`, `sv remove`, `sv adopt`, `sv adopt-remote`, `sv scan`, `sv share`, `sv package`, `sv watch`, `sv promote`/`sv demote`, `sv snapshot`/`sv devices`/`sv sync-from`, `sv fix`, `sv config`.

## Common first-run issues

- **Symlink creation fails on Windows** — enable Developer Mode (Settings → System → For developers), or use the `copy` method in the push drawer (`sv push --copy`).
- **App port already in use** — the launcher picks the next free port automatically; pin one with `npm run dev -- --port 5500`.
- **`sv: command not found`** — pip's scripts directory isn't on PATH; use `pipx`, or `python -m skill_vault`.

More in [Troubleshooting](./troubleshooting.md).
