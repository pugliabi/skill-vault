# Changelog

User-facing history of the Skill Vault project (app + CLI). The app keeps a
more detailed log in [app/CHANGELOG.md](../app/CHANGELOG.md). Versions follow
semver; the project is pre-1.0, so minor versions carry feature batches.

## [Unreleased]

### Fixed
- **The Claude assistant now keeps to its documented limits.** Its file edits stay in the vault and repos
  folders, and its shell runs plain `git` for history and clones and nothing else. Before, it could write
  anywhere and run read-only commands such as `hostname`. It can no longer `git push`, `commit` or
  `config`, or chain and pipe commands.
- **The assistant's `git clone` stays in the vault and repos folders.** A clone written with `--` could
  land anywhere; the git gate now refuses that form.
- **The file editor can no longer write into a skill's `.git` folder.** Saving now follows the same path
  rules as `save_skill`, so it also refuses other ignored folders such as `dist` and `node_modules`.
- **Large skills reach Claude Code whole.** `read_skill_files` could return more than Claude Code passes
  to the model, which then saw only a short preview with no error. It now stops at about 44,000
  characters and lists the rest to ask for by name. A single file over 50,000 characters still comes
  back as a preview.
- **Agent access:** `skill-vault` with no tool name prints usage instead of hanging, a background start
  keeps the node folder it started with, and the Settings card shows the right PowerShell command.

## [0.2.0] - 2026-10-30

The app now installs with `setup.cmd` and opens from the Start Menu, a setup guide walks you through first use, and Notion connection errors say why. Two features are in beta testing and have only been tested on Windows so far: **agent access** and **assistant providers**.

### Added
- **First-run setup guide** — six steps (vault, tools, skills, Notion,
  assistant, review) with nothing saved until **Finish**: start a new vault,
  use a folder you have, or clone one from GitHub with a preview; a Windows
  folder dialog behind **Browse…**; detected tools with default targets;
  adopt and push checklists; Notion and assistant steps; live progress with
  **Retry failed items**; resume after closing; and re-run from **Settings →
  Run setup guide…** or the command bar. ([getting started](./getting-started.md#first-run-the-setup-guide))
- **Agent access (beta)** — Claude Desktop, Claude Code and any agent with a shell can work with the
  vault: save a skill from a chat, load a vault skill, push skills to your other tools, and run Notion
  syncs (Settings → Agent access).
- **Assistant providers (beta).** The assistant can run on OpenAI Codex, GitHub Copilot CLI or Grok Build as
  well as Claude Code (Settings → AI assistant → Provider, or the setup guide). Skill Vault installs the
  chosen tool (showing the command first) and opens its own sign-in in a window, or takes an API key.
  Each chat remembers its provider. The shell is git-only on Claude; Codex, Copilot and Grok get no
  shell, because none of them can be limited to git; Grok also gets no direct file edits. AI tagging
  and merge-on-update still use Claude Code.

- **One-script Windows install** — `.\setup.cmd` checks Node 20+ and git,
  installs, builds, and adds **Start Menu → Skill Vault**; `-Uninstall`
  removes only the shortcuts. ([getting started](./getting-started.md#install-and-launch-the-app))
- **Start Menu launcher** — opens the built app in its own Edge window with
  no console, reuses a running server, and stops it about a minute after the
  last window closes. Logs in `~/.skill-vault/logs/`.
- **In-app updates** — an **Update available** button when GitHub's `main` is
  ahead; **Update & restart** pulls, rebuilds, waits for running jobs, and
  restarts in place, rolling back cleanly if any step fails.
- **Assistant sign-in choice** — Settings → AI assistant: Claude login
  (default) or an API key with an optional workspace ID.
- `GET /api/health`; launcher flags `--exit-when-idle`, `--log-file`,
  `--strict-port`.
- **AI assistant** — docked chat pane on every page (Ctrl/⌘+J) powered by the
  local Claude Code CLI: context-routed agents (vault-wide / per-skill) with
  specialist subagents, streaming replies with a tool timeline and per-turn
  cost, multi-session history that survives restarts, and Ask-AI entry points
  across failures, skill views, Notion pages, selections, and filters. Acts
  through the app's own audited API; destructive operations excluded by
  design. Bundled agent skills installable into the vault from Settings.
  ([guide](./assistant.md))
- **Proactive suggestions ("For you")** — ranked, zero-AI-cost suggestion
  cards (broken sources, available updates, failed operations, Notion drift,
  integrity and hygiene issues) kept fresh by a background source sweep;
  Fix-with-AI and deep-link actions, server-side dismissals, sidebar
  action-count badge, one-click AI briefing, and a `get_suggestions` tool so
  the agents start from the same picture.
- **Voice input** — mic dictation in the assistant composer (Chrome/Edge).
- **Origin repair API** — `PATCH /api/skills/:name/origin` rewrites a skill's
  update source with server-side stamping and optional immediate re-check;
  `checkUpdates` gained a `pull` opt-out.
- **Clearing a dead origin** — `PATCH /api/skills/:name/origin` accepts
  `origin: null`, and the assistant can do it once you confirm a source is
  retired with no successor.
- **Assistant documentation** — screenshots, a README showcase, and a
  "what to ask" usage section in the [guide](./assistant.md).

### Fixed
- Notion sign-in returns to the page that started it, and a slow Notion
  sign-in no longer lets the installed app stop itself.

- **Notion sync for single-file skills** — Notion returns these as inline
  text instead of an archive link; push, pull, linking and the background
  check now handle both. Re-run **Link skills** once to repair skills left
  half-linked by the old error ("returned no archive").
- **Assistant "API key is not scoped to a workspace"** — a user-level
  `ANTHROPIC_API_KEY` no longer overrides your Claude login (see the new
  sign-in choice above).
- Bulleted and numbered lists in rendered markdown (assistant replies and the
  file preview) now show their markers and indentation.
- Assistant timeline labels on newer Claude Code CLIs: delegations read
  `agent: <name> — <task>` and skill loads read `Loading skill: <name>`.
- A table wider than the assistant pane scrolls inside the reply instead of
  running off the edge.

### Changed
- Push and Notion database selection share services with the setup guide.


- **Startup runs from a production build** — about 1.5 s from a cold start
  to your skills (was ~12 s plus ~2.7 s in dev mode), ~0.4 s when the app is
  already running. `npm run build` is now `node scripts/build.mjs` and writes
  `dist/.build-stamp`.
- **Assistant bundle v2.0.0** — rebuilt around one comprehensive
  `vault-assistant` lead agent plus five thin, skill-backed specialist
  subagents (repo-hunter, update-fixer, new skill-scout, read-only
  error-triager, notion-doctor) and **ten skills** (five deepened with
  reference files, five new: triaging-errors, analyzing-suggestions,
  navigating-app-features, authoring-skills, discovering-skills). The
  assistant can now search GitHub for star-ranked skills to adopt, write and
  review skills to a quality checklist, explain every app feature with deep
  links, and run bulk repairs with parallel subagents. The AI briefing routes
  through analyzing-suggestions; plugin reference files are readable at
  runtime.
- **This repository is now the single development home** for the app, the
  `sv` CLI, and docs (the former private→public code mirror is retired; the
  private repo keeps only the skill library).
- **Default port is now 9994** (was 5174) — quickstart URL, launcher help,
  and `.env.example` updated; if the port is busy the launcher still walks to
  the next free one.
- Skill detail popup's Ask AI closes the popup so the chat is visible.
- `Ctrl/⌘+J` reserved for the assistant (Skills-page `j/k` navigation now
  ignores modified keypresses).

*(For earlier history — Notion sync, legacy page upgrades, name agreement,
desktop packaging, version history, and more — see
[app/CHANGELOG.md](../app/CHANGELOG.md).)*
