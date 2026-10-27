# Summary of Changes

Running log of change sets, newest first. Detailed per-release notes live in
[changelog.md](./changelog.md) and [app/CHANGELOG.md](../app/CHANGELOG.md).

## 2026-10-27 — Install & launch: one-script Windows setup, hidden launcher, in-app updates

### Changes Made
- **Setup**: `setup.cmd` / `setup.ps1` at the repo root check Node 20+ and git
  (printing the `winget` fix when missing), run `npm ci --include=dev` and the
  build, and create a per-user **Start Menu → Skill Vault** folder (plus an
  Uninstall shortcut). Options `-Desktop`, `-Uninstall`, `-NoLaunch`, `-WhatIf`;
  safe to re-run; removes the old hand-made `Apps\Skill Vault App` shortcut
  when it points at the same checkout.
- **Launcher**: the shortcut runs `app/scripts/launch.ps1` through
  `conhost.exe --headless` (no console window, even with Windows Terminal as
  the default console). One launch at a time (named mutex); reuses a running
  server (`~/.skill-vault/app.lock` + `GET /api/health`); rebuilds when the
  source is newer than `dist/`; starts the built server hidden on `127.0.0.1`
  with idle stop and a log file; opens an Edge app window. Every failure
  shows a message box naming `~/.skill-vault/logs/launch.log`.
- **Server lifecycle**: `scripts/build.mjs` (one build, `dist/.build-stamp`),
  `scripts/build-state.mjs` (exit 0 fresh / 10 stale), instance lock,
  `GET /api/health`, `--log-file` (rotating 5 MB × 3, crash output included),
  `--exit-when-idle` (stop ~60 s after the last window closes unless a job
  runs), `--strict-port` (same-port restart), a connect-based port probe that
  never shadows another local server, and a chunked startup history scan.
- **In-app updates**: a background `git fetch` (built app only) drives an
  **Update available** pill; the dialog re-checks when opened. Apply = pull
  (ff-only) → `npm ci` only if the lockfile changed → staged build in
  `dist-next/` swapped in by rename → wait for running jobs → restart on the
  same port. Any failure before the hand-over rolls back (`git reset --keep`),
  logs the failing step in full, and keeps the running build. Cross-site
  POSTs to `/api/app/*` are refused (Sec-Fetch-Site and Origin).
- **Startup speed**: cold start to skills data ~1.55 s (was ~12 s + 2.7 s in
  dev mode); warm launch ~0.43 s (was ~5 s).

### Files Modified
- `setup.cmd`, `setup.ps1`, `app/scripts/{build.mjs,build-state.mjs,launch.ps1}` — new
- `app/server/services/{instanceLock,logFile,idleStop,portProbe,appUpdate}.ts`,
  `app/server/routes/app.ts` (+ tests, incl. real-process launcher tests) — new
- `app/server/{launcher,index}.ts`, `routes/events.ts`,
  `services/historyRecorder.ts`, `services/assistant/session.ts`
- `app/client/src/lib/appUpdate.ts`, `components/AppUpdate.tsx` — new;
  `components/Layout.tsx`
- `app/package.json`, `app/.gitignore`
- Docs: `README.md`, `docs/{getting-started,configuration,troubleshooting,faq,features,tech_reference,changelog}.md`, `app/CHANGELOG.md`

### Impact
- Anyone can install with one command and launch from the Start Menu without
  a terminal; launching is roughly ten times faster; installed copies keep
  themselves up to date and never end up half-updated.

## 2026-10-27 — Fixes: Notion single-file skills; assistant sign-in

### Changes Made
- Notion now returns a skill that is just a `SKILL.md` as inline text rather
  than an archive link. Downloads accept both, so push, pull, linking and the
  background Notion check work for single-file skills again; skills left
  half-linked by the old failure are repaired by running **Link skills** once.
- Assistant sign-in: **Settings → AI assistant → Sign in with** Claude login
  (default — `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are removed from the
  `claude` CLI's environment) or API key (saved, or from the environment, plus
  an optional workspace ID sent via `ANTHROPIC_CUSTOM_HEADERS`). Fixes chats
  failing with "This API key is not scoped to a workspace" when a user-level
  key is set. Covers the assistant, AI tagging and Claude merge.
- Dev mode: Vite is pointed at `app/vite.config.ts` explicitly, and `tsx watch`
  ignores Vite's timestamp files.

### Files Modified
- `app/server/services/notion/{api,archive,sync,linker,checker}.ts`,
  `app/server/routes/{notion,notionSync}.ts` (+ tests)
- `app/server/services/claude/{auth.ts (new),cli.ts}`, `services/appConfig.ts`,
  `routes/assistant.ts`, `services/assistant/{streamEvents,turn}.ts`,
  `app/client/src/{lib/assistant.ts,pages/Settings.tsx}`
- `app/server/index.ts`, `app/package.json`

### Impact
- Notion sync works for every skill again; the assistant works regardless of
  stray API keys in the environment.

## 2026-10-08 — Assistant docs: screenshots, README showcase, usage guide

### Changes Made
- Four screenshots of the assistant added (For you suggestions, GitHub skill
  discovery, an update check with its tool timeline, a skill-scoped chat).
- Fixed: a table wider than the chat pane ran off its edge; it now scrolls
  sideways inside the reply.
- README assistant section rewritten as a showcase with three of the shots.
- `docs/assistant.md` gained a "Using it: what to ask" section (task table,
  how decisions are handed back, skill-scoped chats) and inline screenshots;
  cost guidance corrected to match observed turns.
- Fixed: bulleted and numbered lists in rendered markdown had no markers or
  indentation (the CSS reset stripped them), so a numbered menu from the
  assistant showed no numbers. Affects the chat and the file preview.
- Fixed: timeline labels for newer Claude Code CLIs. Delegations now read
  `agent: <name> — <task>` (the tool is named `Agent` there, and plugin agent
  names arrive namespaced), skill loads read `Loading skill: <name>`.
- Origin clearing for confirmed-dead sources: `PATCH /api/skills/:name/origin`
  accepts `origin: null`; the `set_origin` vault tool gained `clear: true`.

### Files Modified
- `docs/images/assistant-{for-you,discovery,timeline,skill-scope}.png` — new
- `README.md`, `docs/assistant.md`, `docs/faq.md`, `docs/changelog.md`,
  `docs/tech_reference.md`
- `app/client/src/index.css` — list markers in `.sv-markdown`
- `app/server/services/assistant/streamEvents.ts` (+test),
  `app/client/src/components/assistant/ToolActivityLine.tsx` — labels/icons

### Impact
- The README and guide now show the agent working; numbered option menus are
  readable; the timeline names which specialist and skill are in use.

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
