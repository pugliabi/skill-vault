# Changelog

User-facing history of the Skill Vault project (app + CLI). The app keeps a
more detailed log in [app/CHANGELOG.md](../app/CHANGELOG.md). Versions follow
semver; the project is pre-1.0, so minor versions carry feature batches.

## [0.3.0] - 2026-10-29 — Agents preview

Adds the first agent-definition (subagent) porting support as a CLI-only
preview. Agents aren't stored in the vault or shown in the app yet; that is
planned for 0.4.0 ([#1](https://github.com/pugliabi/skill-vault/issues/1)).

### Added
- **Port agent definitions between harnesses (CLI preview)** — `sv agents list`
  and `sv agents port <name> --from claude --to copilot` (or the reverse)
  translate subagent frontmatter, tool names, MCP tool references, and Claude
  model IDs. Fields with no equivalent are dropped with a warning; ports that
  would widen tool access are refused. ([features](./features.md#porting-agent-definitions-subagents--cli-preview))
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
