# Getting Started

This guide walks through installing the Skill Vault App, creating your first vault, adopting the skills you already have, and pushing them to your agents — then adds the optional `sv` CLI. For the two-minute version, see the [README quick start](../README.md#quickstart).

## Prerequisites

- **Node.js 20+** — for the Skill Vault App
- **Python 3.10+** — only if you also want the `sv` CLI
- **git** — required on Windows for `setup.cmd` and in-app updates, and anywhere for adopting skills from git URLs and multi-device sync
- At least one agent tool that loads skills from a directory (Claude Code, Cursor, OpenClaw, Codex, Copilot, Windsurf, …). Not strictly required — you can build a vault first and add providers later.

## Install and launch the app

On Windows:

```powershell
git clone https://github.com/pugliabi/skill-vault.git
cd skill-vault
.\setup.cmd
```

Setup checks for Node 20+ and git (and prints the `winget` command if one is missing), installs packages, builds the app, and creates **Start Menu → Skill Vault**. Options: `-Desktop` (also a desktop shortcut), `-WhatIf` (show what it would do), `-Uninstall` (remove the shortcuts only: your clone, vault and `~/.skill-vault` are never touched).

The shortcut opens Skill Vault in its own window (Microsoft Edge in app mode, or your default browser if Edge isn't installed). There's no console window to keep open:

- **First click** starts the app in the background, usually in about a second. If the app's code changed since the last build (after you pull, say), it rebuilds first, which takes 10–20 seconds.
- **Clicking again** while it's running just opens another window onto the same app; quick double-clicks never start a second copy.
- **Closing the last window** stops the app about a minute later, unless something is still running (a Notion sync, an assistant reply, an update check), in which case it waits for that to finish.
- The Start Menu app only listens on this computer (`127.0.0.1`). To reach it from another device, run it from a terminal instead (see below).
- If something goes wrong, a message box says so and names the log: `~/.skill-vault/logs/launch.log`, with the app's own output in `server.log` next to it.

**Updating.** When GitHub has newer commits on `main`, an **Update available** button appears at the bottom of the sidebar. Opening it checks GitHub again and lists what's new; **Update & restart** pulls the changes, reinstalls packages if they changed, rebuilds, and restarts the app in place — the window reloads itself when the new version is ready. If a Notion sync or assistant reply is running, the restart waits for it. Updates only run on a clean `main` checkout (the dialog says what's in the way otherwise), and if any step fails, the checkout is put back and the version you had keeps running.

**Developing / macOS / Linux.** `cd app && npm install && npm run dev` runs from source with hot reload (→ http://localhost:9994); on Windows, `app\run.bat` does the same. Port, host and browser auto-open are configurable; see [Configuration](./configuration.md).

## First-run setup

### First run: the setup guide

The first time Skill Vault opens, a short guide walks you through:

1. **Vault**: start a new vault, use a folder you already have, or clone a vault repo from GitHub. **Browse…** opens the normal Windows folder picker; you can also paste a path. A folder that exists but can't be read is flagged ("Skill Vault can't open this folder. Check its permissions or pick another one.").
2. **Tools**: Claude Code, Cursor, Copilot and the other known tools are detected. Tick the ones you use; "default" tools also get every new skill.
3. **Skills** (optional): adopt skills found in your tools into the vault, and push vault skills out to your default tools. Each list has checkboxes. If you come back to this step, your picks are restored exactly (Skip means nothing moves); skills that turn up later start unticked.
4. **Notion** (optional): connect and pick your Skills database.
5. **Assistant** (optional): pick the tool the assistant runs on (Claude Code, OpenAI Codex, GitHub Copilot CLI or Grok Build). Skill Vault can install it; then sign in with your account or use an API key.
6. **Finish**: a list of exactly what will happen, then live progress.

Nothing is saved until you press **Finish**. If you close the window halfway, the guide offers to resume. Run it again any time from **Settings → Run setup guide…** or the command bar ("Setup guide"); it opens with your current settings filled in.

When you clone from GitHub, **Next** takes a quick look inside the repo (a temporary copy, deleted straight away) and lists the skills it found. If the repo can't be read part-way (a dropped connection, an expired sign-in), the preview says so instead of showing a partial list.

If Finish ends with "items need attention", your vault and settings are already saved; see [Troubleshooting](./troubleshooting.md#setup-finished-with-items-need-attention).

The vault folder ends up laid out like this:

```
<vault>/
├── skills.json     # manifest: one entry per skill
├── skills/         # one folder per production skill
├── staging/        # skills not yet promoted to production
└── snapshots/      # per-device state files (multi-device sync)
```

Choose somewhere you back up, ideally a git repo; the vault is the source of truth. Everything is stored in `~/.skill-vault/config.json`, shared with the CLI. You can still change tools and defaults later in **Settings → Providers** and **Defaults**.

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
