# Changelog

All notable changes to the Skill Vault App are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com); versions use semver
(the app package is `0.x` — minor bumps carry user-facing feature batches).

## [Unreleased]

### Added
- **Voice input in the assistant** — a mic button in the chat composer
  dictates into the draft (browser Web Speech API; Chrome/Edge — hidden
  where unsupported). Final phrases append to the draft, the in-flight
  guess shows as a live hint, and dictation stops on send, toggle, or
  closing the panel.
- **Proactive suggestions ("For you")** — the assistant now knows what needs
  attention before you ask. A zero-AI-cost engine composes ranked cards from
  the app's own signals (broken/available updates, failed operations, Notion
  conflicts and drift, stale/missing provider copies, audit findings, name
  mismatches, origin-less skills, outdated Desktop packages, lingering
  staging, untagged), kept fresh by a background update sweep (boot + every
  6 h, yields to foreground checks, cleans its temp clones, cache survives
  restarts). Cards appear in the assistant's empty state and a header
  lightbulb popover, with severity tints, "Fix with AI" (pre-seeds the chat),
  deep links, and dismiss (7 days or until the card's content changes —
  stored server-side so the sidebar badge, panel, and agents agree). The
  sidebar Assistant button shows an action-count badge; a one-click **AI
  briefing** turns the current cards into a prioritized plan. Agents see the
  same cards via the new `get_suggestions` vault tool, and `checkUpdates`
  gained a `pull` option. Strictly suggest-only: the background sweep never
  changes the vault.
- **AI assistant** — a docked, collapsible chat pane available on every page
  (sidebar button or Ctrl/Cmd+J). Context-routed agents, not one generalist:
  a **vault agent** for app-wide work (bulk update checks, push/sync, finding
  and fixing errors) and a **skill agent** when a specific skill is in focus,
  backed by specialist subagents (repo-hunter, update-fixer, notion-doctor,
  error-triager) and bundled skills (vault-operations, vault-format,
  finding-skill-origins, syncing-from-github, connecting-notion). Runs on the
  local `claude` CLI with streaming responses, a compact tool-activity
  timeline, per-turn cost, multi-session history with resume (survives app
  restarts), and Stop. The agent acts through the app's own API via an MCP
  bridge, so every change lands in the activity feed and version history;
  skill deletion and Notion force-overwrite are excluded from its toolset.
  It can research the web and git history to repair broken update sources
  (`gone upstream`) end-to-end: locate the moved skill, rewrite its origin
  (new `PATCH /api/skills/:name/origin`), verify, and apply the update.
  **Ask AI** entry points: failing rows in Check-for-updates, sync errors
  and failure toasts, skill panels, Notion review/conflicts pages, the
  multi-select bar (selection as context) and the Skills toolbar (active
  filters as context); Ask AI from the skill detail popup closes the popup
  so the chat is visible. Settings → AI assistant installs the bundled
  skills/agents into the vault for direct use from Claude Code.
- **Upgrade legacy Notion pages** (Notion ▾ → Upgrade legacy pages (N), or
  click a skill's `legacy` badge): compare the full vault skill with the
  Notion summary page, then replace the summary with the full skill in the
  same page (title set to the skill name, summary kept in history). The
  link becomes an ordinary in-sync link. Bulk push / force still skip
  legacy links and now say where to upgrade them.
- **Name agreement** — Notion title, folder name and `SKILL.md` `name` must
  match. A push, page creation, upgrade or resolution for a skill whose
  folder and `SKILL.md` name differ fails up front ("Name mismatch … — fix
  it in Names") without touching Notion. New **Name mismatches** page
  (Notion ▾ → Name mismatches (N)) fixes a skill by renaming its folder or
  its `SKILL.md` name; renaming onto an existing skill is refused as a
  duplicate (also under Import ▾). Uploads now set the Notion title to the
  skill name (no more display-title restore), and push review offers opt-in
  **Fix name in Notion** rows for titles that differ (title-only when the
  skill is otherwise in sync).
- **Blank Notion pages are reused** — a newly matched page that Notion
  reports blank (and has no files) is linked awaiting its first upload (the
  next push fills it, re-checking it's still blank), and creating a page
  reuses a blank page already titled with the skill name instead of making
  a duplicate.
- **Connect Notion** (Settings → Notion): sign in, pick your Skills database,
  link skills by page ID, legacy and Notion-native detection, Notion status
  filter on the Skills page.
- **Notion Push/Pull review pages** — a plan grouped into Update · New ·
  Rename · Deleted · Conflict, with a live per-row vault-vs-Notion diff,
  select/run only what you choose, and keyboard navigation (J/K, Space).
- **Conflicts page** for skills that need a decision, with a full per-file
  diff against the last common base, and three resolutions: keep vault,
  keep Notion, or **Merge with Claude** — a section-based merge (only the
  differing, non-binary sections are sent to the local `claude` CLI;
  formatting-only differences are auto-resolved) with an editable
  recommendation preview. Nothing is written until you click Apply. When
  Claude isn't available (or the change is too large for it), **Edit
  manually** resolves the conflict by hand instead.
- **Force push / force pull** (Notion ▾ only), with a pre-run confirmation
  showing the skill count, and the overwritten copy always saved to history
  first; force pull skips skills already in sync.
- **Notion ▾ toolbar menu** (Push to Notion…, Pull from Notion…,
  Conflicts (N), Force push…/Force pull…, Check Notion now, Notion
  settings), plus a **Push to Notion** bulk action from the Skills page's
  multi-select bar — a normal push of the selected skills that never
  overwrites a Notion edit (those are reported for Conflicts).
- **Relink** for unlinked skills (Settings → Notion), so the next Link run
  matches them again.
- **Background Notion check** — periodically refreshes Notion status while
  the app is open, without ever writing to the vault or running while a
  foreground sync job is active.
- **Multi-device git guard** — before a Push/Pull run or force action, the
  vault (if a git repo) is fetched and compared against its remote; a vault
  that's behind is blocked with a banner and an explicit "run anyway"
  override, so a stale device can't sync over a newer one.
- **AI auto-tag.** Auto-tag can now classify skills with Claude through
  your local Claude Code CLI (`claude -p`, no API key): it reads each
  skill's name, description and a SKILL.md excerpt, prefers your existing
  tags, and gives a one-line reason per skill. AI mode covers all skills in
  scope (not only untagged ones), or the selected skills when a selection
  exists. It can also suggest removing tags that don't fit (e.g. a stray
  `cli` on a Fabric skill), but removals are opt-in: they start unchecked
  until you turn on **Include removals**, custom tags are only removed when
  Claude gives a reason, and over-tagged skills are only trimmed to 5. Runs
  in batches with progress and Stop; nothing is written until you apply.
  Falls back to the keyword rules when `claude` isn't available (with a
  **Re-check** link) or a batch fails. Uses the shared headless Claude
  launcher with structured (`--json-schema`) output. Optional env:
  `SKILL_VAULT_AUTOTAG_MODEL` (default `sonnet`), `SKILL_VAULT_AI_TAGS=0`
  to disable.
  - New API: `GET /api/tags/ai-status` (`?refresh=1` re-checks the CLI),
    `POST /api/tags/suggest` (`{ skills }` → per-skill `tags`, `reason`,
    `new_tags`, `remove`, `remove_reasons`, plus `failed`), and
    `POST /api/tags/bulk` accepts `prune_known: false` to keep removed
    tags in `known_tags`.

### Changed
- Keyword auto-tag rules: new `fabric` tag (lakehouse, warehouse, OneLake,
  dataflows, eventhouse/eventstream, Spark, medallion, Databricks/Synapse
  migrations), no longer lumped into `powerbi`; `cli` is only suggested for
  skills that are about a command-line tool, not ones that merely use one;
  `sqldb-*` skills and "… in Fabric" descriptions get `fabric`; at most 5
  suggestions per skill.

### Fixed
- **EISDIR on skills with a folder where `SKILL.md` belongs** — on
  case-insensitive disks a folder named `skill.md/` answered to `SKILL.md`,
  so reads crashed with "EISDIR: illegal operation on a directory". Every
  `SKILL.md` check now requires a regular file.
- Two flaky tests (Notion checker timer window, archive temp-dir count) no
  longer fail under a loaded full-suite run on Windows.
- Notion file uploads no longer send a duplicate/conflicting
  `Content-Length` header when Notion's upload URL already provides one.
- Renaming a linked skill now updates `SKILL.md`'s `name` field on both
  sides before pushing/pulling, so the Notion page title and the vault
  frontmatter stay consistent through a rename.
- **Version history.** Every skill change — in-app edits, pulls, updates,
  adopts, renames, deletes, and edits made outside the app — is now saved
  to `.history/` in the vault. New **History** tab on a skill's detail page
  shows the timeline with diff-against-current and one-click restore.
  Deleted skills can be restored from history, bringing back their tags and
  targets along with their files. The version cap (default 50 per skill) is
  configurable from Settings.
- Skills search gains a **scope selector** (`Name` is the default), so you
  can widen a search to file contents when you need to.
- Skill descriptions written as YAML block scalars (`description: >`)
  showed as `>` in the skill list; they are now read in full.

## [0.2.0] — 2026-07-02

A large feature batch centered on making skill→provider coverage visible and
actionable, curating the library, and adding an OpenClaw export path.

### Added
- **Filter skills by target.** A first-class `Target` control next to the status
  pills — pick a provider and a state (`configured` · `synced` · `stale` ·
  `missing`). Turns "show me everything missing from Cursor" into two clicks.
- **`Missing` status pill** on the Skills toolbar (surfaces the previously
  unfilterable missing skills).
- **Coverage matrix layout** — a skills × providers grid; click a column header
  to push everything missing/stale to that provider, or a single cell to push
  one skill.
- **Dashboard provider health bars** (`synced/total`, color-coded) and
  **clickable status tiles**, all deep-linking into the target filter.
- **Auto-tagging** — an "Auto-tag" review dialog that suggests tags from each
  skill's name + description (heuristic, dependency-free). ~78% of untagged
  skills get a suggestion.
- **Full-text search** over `SKILL.md` bodies (unioned into the existing
  name/description search box).
- **Command palette (⌘K/Ctrl-K) jump-to-skill** — type to jump straight to any
  skill, alongside the existing route commands.
- **Health board** (new "Health" button on Skills) with two tabs:
  - **Trigger collisions** — flags skills with near-identical descriptions that
    could make an agent fire the wrong one.
  - **Needs work** — a SKILL.md quality score (A–F) with per-skill issues.
- **Saved views** — name and recall filter/sort/layout presets from the Skills
  toolbar.
- **Global activity drawer** — a slide-in recent-activity feed reachable from
  the sidebar on every page (reuses the SSE stream).
- **Keyboard cheatsheet** — press `?` anywhere for the shortcut list.
- **Live provider-path validation** in Settings — a per-provider status dot
  (`ready` / `read-only` / `path missing` / `unreachable`).
- **"★ All providers"** one-click bulk action to add every configured provider
  to the selected skills.
- **Graph/Topology deep-links** — provider nodes/edges now navigate to the
  target-filtered Skills view (warn nodes → the `missing` set).
- **Diff-before-run on Sync** — a `diff` button on push/pull rows opens the
  file diff before you run the action.
- **Export to OpenClaw** — install vault skills into the isolated OpenClaw WSL
  gateway (which has no filesystem bridge) via `openclaw skills install`, run
  over `wsl.exe` + `tar`. Available as a bulk action and a single-skill dialog
  (`--global` / `--force`); self-hides when the distro isn't detected.

### Changed
- The `/api` error handler now returns **400** for malformed/absent JSON bodies
  instead of flattening everything to 500.
- `Adopt`/provider errors now distinguish *missing* vs *permission-denied* vs
  *unreachable* (e.g. a dropped WSL/network share) instead of always reporting
  "does not exist".

### Fixed
- **Invisible stale-target filter**: a persisted `target` filter for a provider
  that no longer exists (e.g. after removing OpenClaw) silently filtered the list
  to 0 while the dropdown read "any". The filter now ignores unknown providers
  and self-heals the saved preference.
- Removed the openclaw provider and stripped 99 stale `openclaw` target entries
  from the vault manifest.

### Removed
- Orphaned dead module `server/services/files.ts` (superseded by `vault.ts`;
  had zero importers) — `npm run typecheck` is now clean.

### New API
- `GET  /api/skills/search?q=` — full-text SKILL.md search.
- `GET  /api/config/providers/check` — per-provider path validation.
- `GET  /api/openclaw/status` · `POST /api/openclaw/export` — OpenClaw export.

## [0.1.0]

Initial app: dashboard, skills list/detail, adopt, sync, devices, graph,
settings — a Node/React UI over the shared `sv` vault format.
