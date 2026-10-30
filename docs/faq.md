# FAQ

**Do I need both the CLI and the app?**
No. Either works standalone. They share `~/.skill-vault/config.json` and the same on-disk vault format, so you can start with one and add the other at any point — configuration carries over with zero re-entry.

**Does the app shell out to the CLI (or vice versa)?**
No. No shared code, no subprocess calls. Two independent implementations of the same documented JSON schemas and directory layout ([vault-format.md](./vault-format.md)).

**Which agent tools are supported?**
Anything that loads skills from a directory can be a provider. Auto-detected: Claude Code, OpenClaw, Cursor, Codex, Copilot, Windsurf. Any other path can be added as a custom provider. Claude Desktop is supported via zip packaging (it loads skills from your claude.ai account, not a local folder), and OpenClaw's WSL gateway via a dedicated export.

**Symlinks or copies?**
Symlinks by default — edit once in the vault, every agent sees it immediately. Use `sv push --copy` where symlinks aren't practical (Windows without Developer Mode, tools that don't follow links). Copies can drift; `sv status` flags stale ones and `sv sync` reconciles both directions.

**What exactly is a "skill"?**
A folder with a `SKILL.md` (YAML frontmatter: `name`, `description`; then instructions), plus optional supporting files (`references/`, `scripts/`, examples). The vault stores each skill once under `skills/<name>/`.

**Can I keep my vault in git?**
Yes — recommended. The vault is plain files, and the multi-device workflow (`sv snapshot` / `sv devices` / `sv sync-from`) assumes you move state between machines through a git remote (`repo_url` in config).

**What's the difference between production and staging?**
`skills/` is production; `staging/` holds skills you're not ready to distribute. Staged skills are excluded from normal pushes until `sv promote` moves them over. `sv demote` goes the other way.

**What do the sync states mean?**
Per skill × provider: `configured` (provider is set as a target), `synced` (content identical), `stale` (vault differs from what the target has), `missing` (target doesn't have it). Vault-only skills aren't configured for any provider yet.

**Is my skill content sent anywhere?**
No. Everything is local file operations. The only network calls are ones you invoke explicitly: `sv adopt-remote` (git clone) and the optional AI scanner for `sv scan` (Claude CLI or Anthropic API, if you configure it).

**How do I install it on Windows?**
Clone the repo and run `.\setup.cmd` (needs Node 20+ and git; it prints the `winget` command for anything missing). It installs packages, builds the app, and adds **Start Menu → Skill Vault**. No admin rights are needed — the shortcuts are per-user — and `.\setup.cmd -Uninstall` removes only the shortcuts, never your clone, vault or settings. See [Getting Started](./getting-started.md#install-and-launch-the-app).

**How does the app update itself — is it safe?**
It checks GitHub in the background and shows **Update available** when `main` has new commits. **Update & restart** pulls them, rebuilds into a separate folder, swaps the new build in only once it's complete, waits for any running job, then restarts in place. If any step fails, the checkout is put back and your current version keeps running. It only updates a clean `main` checkout — if you've edited or committed locally, it tells you and leaves things alone.

**When does the update prompt pop up on its own?**
Only for a new *version*: when `version` in `app/package.json` on GitHub's `main` is higher than the installed one. The update dialog then opens at startup (once per app window) with that version's section of `app/CHANGELOG.md` as release notes. Ordinary commits without a version bump just light the **Update available** pill. To release one: bump `version` in `app/package.json`, rename the CHANGELOG's `## [Unreleased]` heading to `## [0.2.0] - <date>` (matching the new version), and push to `main`.

**Is it safe to expose the app on my network?**
The app binds `127.0.0.1` by default, and the Start Menu app always does. Binding `0.0.0.0` (from a terminal: `npm run dev -- --host 0.0.0.0`) makes the dashboard — which can modify your vault and agent directories — reachable by anyone on the LAN. There is no authentication. Only do this on networks you trust.

**Does the app work without the dev toolchain?**
Yes. On Windows, `setup.cmd` builds it and the Start Menu shortcut runs the bundled server (`dist/launcher.js`) — no tsx/Vite at runtime. Elsewhere: `npm run build`, then start `node dist/launcher.js` with `NODE_ENV=production`. Once published to npm, `npx skill-vault-app` is the intended one-liner.

**How do I rename a skill everywhere?**
Use Rename in the app's skill detail — it cascades through the manifest and provider directories. Renaming a folder by hand leaves stale entries; run `sv fix` if you did.

**License?** MIT — see [LICENSE](../LICENSE).

**What does the AI assistant cost to run?**
Chat turns run through your local Claude Code CLI on your existing Claude subscription — roughly $0.05–0.20 for a plain answer or single check and $1–1.50 for a research-heavy turn that delegates to a specialist; the cost is shown after each reply. Everything else is free: the proactive **For you** suggestions, the background source sweep, and all badges are computed deterministically with no AI calls. The only AI spends are turns you start: messages, **Fix with AI** cards you send, and the **AI briefing** button.

**Does the assistant use my Claude login or an API key?**
Your Claude login by default — even if `ANTHROPIC_API_KEY` is set in your environment for some other tool. To bill an API account instead, choose **API key** under **Settings → AI assistant → Sign in with**, paste a key (or use the environment's), and add a workspace ID if the key isn't scoped to one. A saved key is stored in plain text in `~/.skill-vault/config.json`.

**Can the assistant break my vault?**
It edits through the same audited API the UI uses, so every change appears in Activity and is restorable from version history. Deleting skills, force-overwriting Notion, arbitrary shell commands, and anything outside the vault/clones folders are excluded from its toolset by design — those remain manual, in the UI.

**Why doesn't the mic button show in the assistant?**
Voice input uses the browser's built-in speech recognition (Chrome and Edge ship it; Firefox doesn't). The button hides itself where the API is unavailable, and the first use asks for microphone permission.

**Does the background sweep change my clones?**
It runs the same `git pull --ff-only` a manual *Check updates* does on local clones, and nothing else — it never modifies the vault. Statuses are cached (survives restarts) and shown with their age; disable by simply not running the app, or re-check on demand with the refresh link.

**Can I run the setup guide again?**
Yes. Open **Settings → Run setup guide…** or use the command bar's "Setup guide". It opens with your current settings filled in, and nothing changes until you press **Finish**.

**Does the guide store my API key?**
Only when you press **Finish** with "Use an API key" chosen, and then only in `~/.skill-vault/config.json`, the same place Settings keeps it. It is never written to the guide's draft file, and it is kept in the page's memory until Finish (a reload means typing it again).

**Can I use a vault that lives inside a bigger repo?**
Yes. When you clone from GitHub, the guide finds `skills.json` at the repo root or one folder down (like `agent-skills/skills/`) and uses that folder as the vault. If it finds two candidates it asks which one; if it finds none, it offers to use the repo root as a new vault.

### Why does Grok ask me to sign in again inside Skill Vault?
Grok Build reads MCP servers from your other tools' configs (Claude, Cursor). Skill Vault runs Grok with its
own home folder that holds only the vault tools, so your other servers can't join a chat — and that folder
is expected to have its own sign-in. (Grok support hasn't been checked against the real Grok CLI yet.)

### Why can Codex run commands other than git?
Codex can't limit its shell to particular commands. Skill Vault runs it in Codex's workspace-write
sandbox instead: commands run, but can only write inside the vault and repos folders.

### Why can't the assistant run git on Copilot?
Copilot CLI runs commands it considers read-only even when only git is allowed, so its shell can't be
limited to git. Skill Vault turns Copilot's shell off entirely. The vault tools still work; for anything
that needs a command, the assistant tells you what to run.

### I picked Copilot and it says I'm not signed in, but `gh` works.
Copilot needs its own sign-in (`copilot login`) or a fine-grained token with *Copilot Requests*. Classic
`ghp_` tokens don't work, and a `GH_TOKEN` in your environment is ignored in account-login mode.
