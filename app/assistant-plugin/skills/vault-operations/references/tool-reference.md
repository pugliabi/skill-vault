# mcp__vault__* tool reference

Exact inputs, outputs, and error behavior for every vault tool. All tools
return JSON-as-text; a failed call returns a readable error MESSAGE (not an
exception) — read it, it usually names the fix.

## Shared error semantics

| Signal | Meaning | Response |
|---|---|---|
| `… failed (409): a Notion job is already running` / `busy` | One job at a time, app-wide | Report; retry only after the running job finishes |
| `… failed (409): vault is behind its remote` (guard) | The vault's git checkout needs a pull | Tell the user to pull; overriding the guard is UI-only |
| `Notion is not connected (…) Ask the user to connect Notion in Settings.` (401) | Connection absent or lapsed | Point to Settings → Notion → Connect; stop |
| `… failed (400): <detail>` | Malformed input | Fix the arguments per this reference |
| `… failed (404): skill not found` | Name wrong or skill deleted | `list_skills` to re-check the name |

## Read-only tools

### list_skills `{status?: string, target?: string}`
Returns `{total, skills: [{name, status, stage, targets, tags?, description (≤140 chars), origin?, notion_status?}]}`.
`status` filters client-side (synced/stale/vault-only/staging/new/missing); `target` filters to skills pushed to that provider id.

### get_skill `{name}`
Returns the full detail: manifest entry (targets, stage, source, tags), `origin`, `desktop_status`, `notion_status`, per-target `target_status` map, and the file tree. The heavyweight inspect — prefer context-block facts when present.

### search_skills `{query}`
Full-text over SKILL.md bodies → `{matches: [{name, snippet}]}`.

### check_updates `{skills?: string[]}`
Omit `skills` = every skill with an origin. Returns `{results: [{name, status, origin?, recorded_hash?, vault_hash?, upstream_hash?, upstream_path?, tmp_path?, git_pulled?, message?}]}`.
Statuses: `up_to_date | update_available | local_changed | conflict | upstream_missing | source_missing | no_origin | error` (decision table: vault-format skill).
`git_pulled` = a local clone was ff-pulled before comparing. `message` may contain the gold shortcut `moved to <rel>`.
Side effects: may ff-pull local clones and create temp clones (`tmp_path`) that apply_update reuses.

### recent_activity `{only_errors?: boolean, limit?: 1-200}`
Returns `{entries: [{at, kind, skill, ok, provider_id?, message?}]}` — newest last, default limit 50. Kinds include push/pull/adopt/update/promote/demote/remove/rename/restore/notion-*.

### audit_vault `{}`
Returns `{issues: [{id, kind: "orphan_folder"|"dangling_entry"|"broken_link", target, description, fixes: [{label, action}]}]}`. Cheap; safe anytime.

### notion_status `{}`
Returns `{status: {connected, data_source…}, summary: {…counts…} | null}` (summary null when it needs a connection). Always the first Notion call.

### notion_plan `{direction: "push"|"pull"}`
Returns the per-skill plan rows `{rows: [{id, skill, action, …}]}` — preview only, nothing runs.

### scan_dir_for_skills `{path, recursive?: boolean (default true)}`
Scans a local directory for adoptable skills → `{source, results: [{name, path, …duplicate/in-vault flags}], truncated}`.

### get_config `{}`
Returns `{vault_path, providers: [{id, path}], default_targets?, …}` (repos dir included).

### get_suggestions `{}`
Returns `{cards: [{id, kind, severity, title, detail?, count, skills?, actions, fingerprint, freshness?}], generated_at, sweep: {checked_at, running}, dismissed}`. Interpretation: analyzing-suggestions skill.

## Mutating tools

### apply_update `{items: [{name, upstream_path?, tmp_path?}] (min 1)}`
Overwrites the vault copies from upstream and refreshes origin stamps. Returns `{updated: [names], skipped: [{name, reason}]}`. ALWAYS echo `upstream_path`/`tmp_path` from the matching check result — omitting them forces fresh clones. Prior state stays in version history.

### set_origin `{name, origin: {type: "git"|"dir"|"provider", url?, path?, provider_id?, subpath?, ref?}, verify?: boolean (default true)}`
Rewrites a skill's update source. Rules: `git` needs `url` (or a local clone `path`); `dir` needs `path`; `provider` needs `provider_id`; `subpath` is "/"-separated relative, "" = root. Server stamps `adopted_at` + `content_hash` — never send them. With verify, the response includes `check` (a fresh UpdateCheckResult) — expect `update_available`/`up_to_date`; `upstream_missing` again = the repair is wrong.

### adopt_skills `{source_path, items: [{name, path}] (min 1), overwrite?, origin_context?: {type, root, url?, ref?, provider_id?}}`
Copies scanned skills into the vault. Returns `{imported, updated, skipped}`. ALWAYS pass `origin_context` so each skill gets an origin. `overwrite:true` only when deliberately replacing an existing skill.

### push_to_provider `{skill, provider_id, method?: "auto"|"symlink"|"junction"|"copy" (default auto)}`
Links/copies into the provider dir. Returns `{skill, target_path, method}` (the method that actually worked).

### pull_from_provider `{skill, provider_id}`
Copies the provider's copy back into the vault. Returns `{action: "copied"|"no-op"}` (no-op when the provider holds a live link).

### notion_push `{skills: [names] (min 1)}`
Full-folder upload to each skill's Notion page. Synchronous from your view (the bridge polls the job): returns `{results: [{id, ok, message?/error?}], error?}`. A Notion edit is never overwritten by this (non-force).

### notion_run `{direction, rows: [{id, action?}] (min 1)}`
Executes reviewed plan rows (ids from notion_plan). Same synchronous polling + result shape as notion_push.

### fix_repair `{kind, target, action}`
One audit finding at a time. Valid pairs: `orphan_folder`→`remove_folder` (deletes files; history keeps a snapshot) or `add_to_manifest` (registers — also the step after hand-authoring a skill) · `dangling_entry`→`remove_from_manifest` · `broken_link`→`remove_link`|`recreate_link`.
