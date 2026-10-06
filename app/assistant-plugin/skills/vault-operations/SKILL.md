---
name: vault-operations
description: Recipes for every Skill Vault operation via the mcp__vault__* tools — list/inspect skills, check and apply updates, repair origins, adopt from directories or clones, push/pull to providers, audit and repair the vault, and read the activity log. Use before any vault mutation.
---

# Vault operations — tool recipes

The vault tools call the Skill Vault app's own HTTP API: every mutation lands
in the activity log, broadcasts live to the UI, and snapshots to version
history first. Prior state is restorable — act, don't hedge. What's *not*
available by design: deleting skills, Notion force overwrite, OAuth connect.

## Inspect

- `list_skills {status?, target?}` — everything, trimmed. Statuses: `synced`,
  `stale` (provider copy differs), `vault-only`, `staging`, `new`, `missing`.
- `get_skill {name}` — full detail: manifest entry, origin, file tree,
  per-target status, Notion link.
- `search_skills {query}` — full-text over SKILL.md bodies.
- `recent_activity {only_errors?, limit?}` — what just happened; failures have
  `ok:false` + message.
- `get_config {}` — vault path, providers (id → path), repos dir.

## Update from source (full pipeline in syncing-from-github)

- `check_updates {skills?}` — read-only three-way check. Omit `skills` for all.
- `apply_update {items:[{name, upstream_path?, tmp_path?}]}` — overwrite vault
  copies from upstream. ALWAYS echo `upstream_path`/`tmp_path` from the check
  result — they let the apply reuse the clone the check already made.
- `set_origin {name, origin, verify:true}` — repair provenance (see
  vault-format for the origin shape). Keep `verify:true`: the response tells
  you immediately whether the repair worked.

## Adopt

1. Source already on disk? `scan_dir_for_skills {path}` → candidates.
   Remote repo? `Bash: git clone --depth 1 <url> <repos_dir>/<repo-name>`
   first (repos dir from `get_config`), then scan the clone.
2. `adopt_skills {source_path, items, origin_context}` — ALWAYS pass
   `origin_context` (`{type:"git", root:<clone dir>, url, ref?}` for clones,
   `{type:"dir", root}` for plain dirs) so the skill gets an origin and stays
   updatable. `overwrite:true` only for deliberate re-adopts.

## Providers (claude / cursor / copilot / ...)

- `push_to_provider {skill, provider_id, method:"auto"}` — link or copy into
  the provider's skills dir. Auto picks symlink/junction/copy per platform.
- `pull_from_provider {skill, provider_id}` — copy a provider-side edit back
  into the vault (no-op when the provider holds a live link).
- A `stale` status = provider copy differs from vault → push (vault wins) or
  pull (provider wins); check which side the user edited.

## Health

- `audit_vault {}` — orphan folders, dangling manifest entries, broken links.
- `fix_repair {kind, target, action}` — one finding at a time:
  `orphan_folder`→`remove_folder`|`add_to_manifest`,
  `dangling_entry`→`remove_from_manifest`,
  `broken_link`→`remove_link`|`recreate_link`.
  `remove_folder` deletes files (history keeps a snapshot) — prefer
  `add_to_manifest` when the folder looks like a real skill.

## Ground rules

- Busy (409) = another job is running → report, never spin-retry.
- Conflicts / `local_changed` = user decision — show both sides, don't pick.
- File edits (Edit/Write) are for skill *content*; operations go through tools.
