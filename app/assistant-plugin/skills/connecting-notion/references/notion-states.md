# Notion link states — the full machine

## How a skill enters each state

| State | Entered by | Manifest `notion` fields present |
|---|---|---|
| linked | First-time linking matched the skill to a native page, or adoption from Notion, or relink | page_id, state:"linked", linked_at, usually synced_at + vault_hash + notion_version_id |
| legacy | Linking detected the page is an old converted SUMMARY of the skill (title is a display variant AND the page lacks the real files) | page_id, state:"legacy" — content drift is NOT compared |
| unlinked | User explicitly disconnected the skill | state:"unlinked" — excluded from auto-matching until relinked |
| vault-only | User marked it as intentionally not in Notion | state:"vault-only" |
| (no block) | Never linked and never explicitly excluded | — appears as not-in-notion |

## Drift verdicts (`notion_status` on each skill)

Computed by comparing NOW against the link's `synced_at`-era stamps:

| Verdict | vault_hash vs now | notion_version vs now | Meaning / action |
|---|---|---|---|
| synced | equal | equal | Nothing to do |
| changed-vault | differs | equal | Vault is ahead → push |
| changed-notion | equal | differs | Notion is ahead → pull |
| conflict | differs | differs | Both moved (or synced_at ABSENT — never confirmed equivalent counts as conflict, not neutral) → user resolves on /notion/conflicts |
| missing-in-notion | — | page gone from the data source | Relink / re-push / unlink — ask |
| unchecked | — | no valid local cache of Notion's side yet | The background checker refreshes every ~10 min; don't guess |

## What each operation does per state

- `notion_plan` rows only cover linked skills (plus adoptable notion-only
  pages on pull); legacy/unlinked/vault-only are skipped by design.
- `notion_push` (non-force): pushes `changed-vault` and first-fill of empty
  linked pages; REFUSES when Notion changed (protects their edit).
- `notion_run` executes exactly the reviewed rows; per-row `action` values
  come from the plan (push/pull/adopt/skip variants).
- Pull merges through a 3-way when base versions exist; force variants and
  merge resolution are UI-only.

## Timing facts worth citing

- One Notion job app-wide; the bridge polls to completion (≤10 min) so
  tools look synchronous.
- The app's background checker refreshes the Notion-side cache every ~10
  minutes — "unchecked" and stale counts self-heal; say when data is from
  a cache rather than a live check.
- After a push the app re-downloads what Notion stored (Notion may reflow
  formatting) — cosmetic differences right after a push are expected.
