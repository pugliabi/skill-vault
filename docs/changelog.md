# Changelog

User-facing history of the Skill Vault project (app + CLI). The app keeps a
more detailed log in [app/CHANGELOG.md](../app/CHANGELOG.md). Versions follow
semver; the project is pre-1.0, so minor versions carry feature batches.

## [Unreleased] - 2026-10-06

### Added
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
- Bulleted and numbered lists in rendered markdown (assistant replies and the
  file preview) now show their markers and indentation.
- Assistant timeline labels on newer Claude Code CLIs: delegations read
  `agent: <name> — <task>` and skill loads read `Loading skill: <name>`.
- A table wider than the assistant pane scrolls inside the reply instead of
  running off the edge.

### Changed
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
