---
name: vault-operations
description: Use this skill when performing any Skill Vault operation through the mcp__vault__* tools — listing or inspecting skills, checking and applying updates, repairing origins with set_origin, adopting skills from directories or git clones, pushing or pulling provider copies, auditing and repairing vault structure, or reading the activity log and suggestions. Triggers include "update my skills", "push to claude/cursor/copilot", "adopt this repo", "pull the provider copy", "audit the vault", "repair", "apply updates", "what just happened", and any request that will mutate the vault. Load before the first vault tool call of a session.
---

# Vault operations — the tool recipes

The `mcp__vault__*` tools are thin wrappers over the Skill Vault app's own
HTTP API. Every mutation lands in the activity feed, broadcasts live to the
UI, and snapshots prior state to version history first — so act directly;
nothing here is unrecoverable. Deliberately absent from the toolset: skill
deletion, Notion force-overwrite, OAuth. Those are UI-only.

See ./references/tool-reference.md for every tool's exact input fields,
result shape, and error semantics — consult it before any unfamiliar call.

## Inspect

- `list_skills {status?, target?}` — the whole library, trimmed. Status
  legend: `synced` (all targets match) · `stale` (a provider copy differs —
  find out which side changed before acting) · `vault-only` (no targets;
  normal, not a problem) · `staging` · `new` · `missing` (a target copy or
  link is broken).
- `get_skill {name}` — one skill in full: manifest entry, origin, file tree,
  per-target status, Notion link. Prefer the session context block when it
  already carries these facts.
- `search_skills {query}` — full-text across SKILL.md bodies.
- `recent_activity {only_errors?, limit?}` — what just happened; failures
  carry `ok:false` + message.
- `get_suggestions {}` — the app's own ranked "what needs attention" cards.
  One call; beats re-deriving triage. Interpretation: analyzing-suggestions.
- `get_config {}` — vault path, providers (id → path), repos dir.

## Update from source

Pipeline detail lives in syncing-from-github; the tool mechanics:

1. `check_updates {skills?}` — read-only three-way check (omit `skills` for
   everything with an origin). Results carry `status`, `message`, and —
   critical — `upstream_path` / `tmp_path`.
2. `apply_update {items:[{name, upstream_path?, tmp_path?}]}` — overwrite
   vault copies from upstream. ALWAYS echo each result's `upstream_path` and
   `tmp_path` so the clones the check made get reused, not re-made.
3. `set_origin {name, origin, verify:true}` — repair provenance. The server
   stamps `adopted_at`/`content_hash`; keep `verify:true` so the response
   proves the repair (expect `update_available` or `up_to_date`).

Status meanings and the decision table: vault-format.

## Adopt

1. Source on disk already? `scan_dir_for_skills {path, recursive:true}`.
   Remote repo? First `git clone --depth 1 <url> <repos_dir>/<repo-name>`
   (repos dir from `get_config`), then scan the clone.
2. `adopt_skills {source_path, items, origin_context}` — ALWAYS pass
   `origin_context` (`{type:"git", root:<clone>, url, ref?}` for clones,
   `{type:"dir", root}` for plain dirs); skipping it orphans the skills from
   every future update check. `overwrite:true` only for deliberate re-adopts.

## Providers

- `push_to_provider {skill, provider_id, method:"auto"}` — link or copy into
  the provider's skills dir; auto picks symlink → junction → copy.
- `pull_from_provider {skill, provider_id}` — copy a provider-side edit back
  (no-op when the provider holds a live link).
- `stale` means the copies differ: check WHICH side was edited (file mtimes,
  activity log, asking the user) before choosing push vs pull.

## Health

- `audit_vault {}` — orphan folders, dangling manifest entries, broken links.
- `fix_repair {kind, target, action}` — one finding at a time:
  `orphan_folder` → `remove_folder` | `add_to_manifest` ·
  `dangling_entry` → `remove_from_manifest` ·
  `broken_link` → `remove_link` | `recreate_link`.
  Prefer `add_to_manifest` when the folder looks like a real skill;
  `remove_folder` deletes files (history keeps a snapshot).
  `add_to_manifest` is also the REGISTRATION step after hand-writing a new
  skill folder (authoring-skills).

## Notion tools

`notion_status` / `notion_plan` / `notion_push` / `notion_run` exist in this
toolset; their semantics, states, and etiquette live in connecting-notion.
One Notion job runs app-wide at a time.

## Ground rules

- A `busy` (409) error = another job is running → report and stop; never
  spin-retry. 401 on Notion = reconnect in the UI.
- `conflict` / `local_changed` = user decisions — present both sides.
- Edit/Write is for skill *content* inside `skills/<name>/` only; every
  operation goes through these tools; never hand-edit `skills.json`.
