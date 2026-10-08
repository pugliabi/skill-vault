# Summary of Changes

Running log of change sets, newest first. Detailed per-release notes live in
[changelog.md](./changelog.md) and [app/CHANGELOG.md](../app/CHANGELOG.md).

## 2026-10-08 — Assistant bundle v2: comprehensive lead + skill-backed specialists

### Changes Made
- One comprehensive `vault-assistant` lead agent (context doctrine, skill
  routing table, delegation + latency rules, playbooks) replaces the
  vault-manager/skill-agent pair.
- Five thin subagents, each backed by shared skills: repo-hunter,
  update-fixer (parallel per-source on bulk passes), NEW skill-scout
  (GitHub discovery), error-triager (read-only), notion-doctor.
- Ten skills: five rebuilt to the skill-creator standard with reference
  files (tool I/O reference, manifest spec, GitHub search recipes, Notion
  state machine), five new (triaging-errors, analyzing-suggestions,
  navigating-app-features + feature catalog, authoring-skills + review
  checklist, discovering-skills + search recipes).
- Runtime: plugin dir added as a second --add-dir so reference files load;
  briefing prompt routes through analyzing-suggestions; new discovery
  empty-state prompt.

### Files Modified
- `app/assistant-plugin/**` (6 agents → 6 files incl. new lead + scout; 10
  skill dirs, 6 references files; plugin.json v2.0.0)
- `app/server/services/assistant/{context,turn}.ts` (+tests)
- `app/client/src/{pages/Settings.tsx, lib/assistantStore.ts, components/assistant/MessageThread.tsx}`
- `docs/{assistant,features,tech_reference,changelog,SummaryOfChanges}.md`

### Impact
- The assistant handles any request through explicit routing, discovers new
  skills on GitHub by stars, authors skills to the vault standard, and runs
  bulk repairs in parallel — with simple asks staying seconds-fast.

## 2026-10-06 — Repo split: this repo is now the single dev home

### Changes Made
- The app and `sv` CLI are now developed directly in this repository; the
  private vault repo holds only the skill library. The old private→public
  code mirror is retired (its script refuses to run; the session hook flag
  is off).

### Files Modified
- `docs/tech_reference.md` — repository-roles section replaces the
  mirroring note. (Code trees and `pyproject.toml` were removed from the
  private repo; no code changed here.)

### Impact
- Contribute/edit app + CLI + docs in one place. No more mirror commits.

## 2026-10-06 — Default app port changed to 9994

### Changes Made
- Built-in default port 5174 → 9994 (launcher resolvePort, help text,
  run.bat banner, Notion OAuth callback fallback URL).
- Added `app/.env.example` (was referenced by docs but missing).

### Files Modified
- `app/server/launcher.ts`, `app/server/services/notion/checker.ts`,
  `app/run.bat`, `app/.env.example` — port default
- `README.md`, `docs/getting-started.md`, `docs/configuration.md` — docs

### Impact
- Fresh installs open on http://localhost:9994. Explicit PORT/.env/config
  values still win; busy ports still fall through to the next free one.

## 2026-10-06 — AI assistant: voice input + popup Ask-AI fix

### Changes Made
- Added a microphone button to the assistant composer: browser speech
  recognition (Chrome/Edge) dictates into the draft; live interim hint;
  auto-stops on send/toggle/panel close; hidden where unsupported.
- "Ask AI" inside the skill detail popup now closes the popup first so the
  chat pane is visible (same pattern as the update dialog's entry point).

### Files Modified
- `app/client/src/lib/speech.ts` — new Web Speech API wrapper
- `app/client/src/components/assistant/Composer.tsx` — mic button, interim hint
- `app/client/src/components/SkillDetailOverlay.tsx` — close-before-open wiring
- `app/client/src/components/ui/icons.tsx` — mic icon

### Impact
- Hands-free prompting in the assistant; Ask AI from a skill popup no longer
  leaves the chat hidden behind the popup.

## 2026-10-06 — Proactive suggestions ("For you")

### Changes Made
- Deterministic suggestions engine: ranked cards (17 kinds) composed from
  app signals — update statuses, failed operations, Notion state, provider
  drift, audit findings, hygiene — each with "Fix with AI" and/or deep links.
- Background update sweep (boot + every 6 h): re-checks all skill sources,
  caches lite results across restarts, cleans its temp clones, yields to
  foreground checks, broadcasts live refreshes over SSE.
- Server-side dismissals (7-day / fingerprint-revival semantics) so the panel,
  sidebar badge, and agents agree; `get_suggestions` MCP tool for the agents;
  one-click AI briefing; sidebar action-count badge.
- `checkUpdates` gained an opt-out `pull` option; foreground checks flagged so
  the sweep never races a user-initiated check.

### Files Modified
- `app/server/services/assistant/{suggestions,suggestionStore,updateSweep}.ts` (+tests) — new
- `app/server/services/updates.ts`, `routes/{assistant,adopt,events}.ts`, `types/vault.ts`, `index.ts`
- `app/server/assistant-mcp/bridge.ts`, `app/assistant-plugin/agents/*`
- `app/client/src/components/assistant/SuggestionCards.tsx` — new; plus panel/thread/layout/sse/store wiring

### Impact
- The assistant surfaces what's broken on open instead of waiting to be asked;
  strictly suggest-only (no background mutations).

## 2026-10-06 — AI assistant (initial feature)

### Changes Made
- Docked, collapsible chat pane on every page (Ctrl/⌘+J), streaming replies
  with a tool-activity timeline, per-turn cost, Stop, multi-session history
  that survives restarts.
- Context-routed agents (vault-wide / per-skill) + specialist subagents
  (repo-hunter, update-fixer, notion-doctor, error-triager) and five bundled
  skills; installable into the vault from Settings.
- MCP bridge exposing vault operations through the app's own HTTP API
  (audited, reversible); allowlisted tool access; destructive operations
  excluded by design. New `PATCH /api/skills/:name/origin` for origin repair.
- "Ask AI" entry points across update failures, sync errors, skill views,
  Notion pages, multi-select, and filters.

### Files Modified
- `app/server/services/assistant/*`, `app/server/assistant-mcp/*`,
  `app/server/routes/assistant.ts`, `app/server/services/origin.ts`,
  `app/server/services/claude/cli.ts` (stream runner)
- `app/assistant-plugin/**` (agents + skills bundle)
- `app/client/src/lib/{assistant,assistantStore}.ts`,
  `app/client/src/components/assistant/*`, entry-point wiring across pages

### Impact
- Broken update sources ("gone upstream") can be researched and repaired
  end-to-end from a chat; operation failures become fixable conversations.
