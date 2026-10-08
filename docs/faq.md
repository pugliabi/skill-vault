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

**Is it safe to expose the app on my network?**
The app binds `127.0.0.1` by default. Binding `0.0.0.0` makes the dashboard — which can modify your vault and agent directories — reachable by anyone on the LAN. There is no authentication. Only do this on networks you trust.

**Does the app work without the dev toolchain?**
`npm run build` then `npm run start` runs the bundled server (`dist/launcher.js`) — no tsx/Vite at runtime. Once published to npm, `npx skill-vault-app` is the intended one-liner.

**How do I rename a skill everywhere?**
Use Rename in the app's skill detail — it cascades through the manifest and provider directories. Renaming a folder by hand leaves stale entries; run `sv fix` if you did.

**License?** MIT — see [LICENSE](../LICENSE).

**What does the AI assistant cost to run?**
Chat turns run through your local Claude Code CLI on your existing Claude subscription — roughly $0.05–0.20 for a plain answer or single check and $1–1.50 for a research-heavy turn that delegates to a specialist; the cost is shown after each reply. Everything else is free: the proactive **For you** suggestions, the background source sweep, and all badges are computed deterministically with no AI calls. The only AI spends are turns you start: messages, **Fix with AI** cards you send, and the **AI briefing** button.

**Can the assistant break my vault?**
It edits through the same audited API the UI uses, so every change appears in Activity and is restorable from version history. Deleting skills, force-overwriting Notion, arbitrary shell commands, and anything outside the vault/clones folders are excluded from its toolset by design — those remain manual, in the UI.

**Why doesn't the mic button show in the assistant?**
Voice input uses the browser's built-in speech recognition (Chrome and Edge ship it; Firefox doesn't). The button hides itself where the API is unavailable, and the first use asks for microphone permission.

**Does the background sweep change my clones?**
It runs the same `git pull --ff-only` a manual *Check updates* does on local clones, and nothing else — it never modifies the vault. Statuses are cached (survives restarts) and shown with their age; disable by simply not running the app, or re-check on demand with the refresh link.
