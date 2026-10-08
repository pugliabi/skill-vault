# Feature catalog — page by page

Related vault tools and sv commands listed per area so "how do I" answers
can offer to do it, script it, or point at it.

## Dashboard (`/`)
Status cards (synced/stale/missing counts), per-provider health bars, and an
"actions available" list where each row is a one-click fix with its CLI
equivalent shown. Tools: `list_skills`, `get_suggestions`.

## Skills (`/skills`)
- **Find**: search box (names, descriptions, full SKILL.md text), status
  pills (All·Production·Staging·Stale·Missing·Vault-only·Desktop), Target
  dropdown (provider × state), Notion dropdown, saved Views, advanced
  Filter bar (providers/tags/has-SKILL.md/min-files).
- **Layouts**: list · cards · grouped · coverage matrix (rows=skills,
  columns=providers, click a cell to push one, a column header to push all
  missing/stale there).
- **Multi-select bulk bar**: push, pull, remove, promote/demote, add
  provider(s), check updates, tag, zip, OpenClaw export, Notion push,
  ✦ Ask AI (selection becomes chat context).
- **Toolbar**: + New (starter SKILL.md), Add existing, Auto-tag, Import
  (vault merge), Notion menu, Health, Deleted (restore), ✦ Ask AI (carries
  active filters).
- **Side panel / detail overlay** (`/skills/<name>`): overview (stage,
  source, path, tags), targets tab (per-provider state), files tab (preview
  + in-place EDIT — pushes are symlinks by default so saves propagate
  instantly), history tab (version restore), actions: Push, Pull, Zip,
  OpenClaw, Rename (cascades), Remove, ✦ Ask AI.
Tools: `list_skills`, `get_skill`, `search_skills`, `push_to_provider`,
`pull_from_provider`, `check_updates`, `apply_update`. CLI: `sv list`,
`sv push`, `sv status`.

## Check for updates (dialog from Skills)
Groups results: Updates available (pre-checked) · Conflicts (unchecked,
warns) · No action (incl. gone-upstream rows with ✦ Ask AI to fix). Applies
selected; temp clones cleaned on close. Tools: `check_updates`,
`apply_update`, `set_origin`.

## Sync (`/sync`)
The two-way plan: push (drifted/missing), pull (provider edits), adopt
(new in providers), promote (staging), package (Desktop). Per-row diff
preview, run-selected, per-row ✦ Ask AI on failures. CLI: `sv sync`.

## Adopt (`/adopt`)
Four sources: Path (recursive scan), Provider, Discover (all providers),
Git URL (clone + harvest). Scan results flag duplicates/already-in-vault.
Optional AI repo scanner for messy repos. Tools: `scan_dir_for_skills`,
`adopt_skills`. CLI: `sv adopt`, `sv adopt-remote`, `sv discover`, `sv scan`.

## Devices (`/devices`)
Per-machine snapshots of the vault; Save snapshot → commit/push the vault
repo → on another machine Sync from → cherry-pick skills. CLI: `sv
snapshot`, `sv devices`, `sv sync-from`.

## Graph (`/graph`)
Visual skills↔providers map; spot coverage gaps visually.

## Notion (`/notion/*`)
- Push/Pull review pages: per-skill rows with actions, guard banner, ✦ Ask
  AI. - Conflicts: fresh Notion snapshot, vault-vs-Notion diff, Keep vault /
  Keep Notion / Merge with Claude / edit manually. - Legacy: upgrade old
  summary pages in place. Tools: `notion_status`, `notion_plan`,
  `notion_run`, `notion_push` (rest is UI).

## Skill names (`/skill-names`)
Folder vs SKILL.md `name:` disagreements; fix by renaming either side;
Notion pushes refuse mismatched skills until fixed.

## Settings (`/settings`)
Vault path · Providers (add/remove, live validation, ★ all) · Claude
Desktop staging folder + Scan existing zips · Defaults (push targets) ·
Version history cap · Notion (connect, data source, check now, link
skills) · Audit & repair · Manage tags (merge/rename/delete) · Import
vault · **AI assistant** (install this bundle's skills + agents into the
vault) · App runtime notes. Tools: `get_config`, `audit_vault`,
`fix_repair`.

## Activity drawer & live updates
Sidebar → Activity: the recent operations feed (same data as
`recent_activity`); everything updates live over SSE, including suggestion
refreshes after the background sweep.

## The assistant panel
Docked right pane: scope chip (VAULT / SKILL·name), context chips, For-you
suggestion cards + ✦ AI briefing, streaming replies with the tool timeline
(click a line for input/output), Stop, per-turn cost, session history
(restart-safe), 🎤 dictation, resize/collapse, Ctrl/⌘+J.
