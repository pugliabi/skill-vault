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

### Changed
- Skill detail popup's Ask AI closes the popup so the chat is visible.
- `Ctrl/⌘+J` reserved for the assistant (Skills-page `j/k` navigation now
  ignores modified keypresses).

*(For earlier history — Notion sync, legacy page upgrades, name agreement,
desktop packaging, version history, and more — see
[app/CHANGELOG.md](../app/CHANGELOG.md).)*
