# Manifest & vault format — field-level spec

Distilled from the authoritative docs/vault-format.md in the Skill Vault
repository. Everything here is READ reference; writes go through the vault
tools, which enforce these rules.

## skills.json top level

```jsonc
{
  "version": "1.0",               // optional legacy field
  "machine_id": "DESKTOP-01",     // optional, writer's machine
  "default_targets": ["claude"],  // optional
  "known_tags": ["ai", "cli"],    // optional tag vocabulary
  "skills": { "<name>": { /* SkillEntry */ } }
}
```
All top-level fields except `skills` are optional; readers tolerate absence;
writers preserve fields they didn't originate.

## SkillEntry

| Field | Type | Notes |
|---|---|---|
| targets | string[] (required) | Provider ids to push to; `[]` is valid (vault-only) |
| stage | "staging" \| "production" | Missing = production. Staging skills are hidden from normal flows and not pushed |
| source | string | Free-form display provenance ("adopted from claude", "pulled from X") |
| tags | string[] | User organization |
| origin | SkillOrigin | Structured provenance (below) — update checks require it |
| desktop_package | {packaged_at, content_hash} | Last Claude Desktop zip packaging; current-vs-outdated is derived by comparing content_hash to the live hash |
| notion | NotionLink | App-managed two-way link state (below) — never hand-modify |

Unknown fields round-trip untouched.

## SkillOrigin

| Field | Applies to | Meaning |
|---|---|---|
| type | all | "git" (remote; no path = shallow temp clone per check) · "dir" (local root; if it's a git checkout it gets `git pull --ff-only` before compare) · "provider" (an agent's skills dir) |
| url | git | Remote URL |
| path | dir/provider | Absolute source root |
| provider_id | provider | Provider id |
| subpath | all | Skill folder relative to the root, "/"-separated; "" = the root IS the skill |
| ref | git | Branch recorded at adopt; optional |
| adopted_at | all | ISO UTC; server-stamped at adopt/update/set_origin |
| content_hash | all | Normalized hash of the VAULT copy at that moment — the "recorded" leg of the three-way compare |

Three-way semantics: upstream==vault → up_to_date · vault==recorded →
update_available · upstream==recorded → local_changed · all different →
conflict. Checks are read-only; only applying rewrites the folder and
refreshes the stamps.

## NotionLink (read-only for the assistant)

Key fields: `page_id` · `state` ("linked" | "legacy" | "unlinked" |
"vault-only") · `linked_at` · `synced_at` (ABSENT = never confirmed
equivalent → treated as conflict, not neutral) · `vault_hash` (vault copy at
synced_at) · `notion_version_id` + `notion_edited_at` (Notion side at
synced_at) · `base_vault_version`/`base_notion_version` (3-way merge
ancestors) · `notion_title` (display) · `vault_name` (rename detection).
Drift derives from comparing current hashes/versions to these; the per-skill
`notion_status` in list_skills/get_skill is the computed verdict
(connecting-notion's reference has the full state machine).

## Content hash algorithm

Collect every file under the skill dir, skipping `node_modules`,
`__pycache__`, `.git`, `.DS_Store`, `Thumbs.db` components → order by
lowercased "/"-relative path → SHA-256 per file, where known-binary
extensions hash raw bytes and everything else is normalized as UTF-8 text
(line endings → \n, trailing whitespace stripped per line, trailing blank
lines stripped) → the directory hash is the SHA-256 of the concatenated
per-file digests. Empty-but-present dir hashes to the literal "empty".
Consequence: CRLF/LF or trailing-space churn NEVER registers as a change.

## .history/ (never touch)

`objects/<aa>/<sha256>` content-addressed file snapshots +
`skills/<name>/versions.json` (append-only version list with per-file hash
maps; sources include vault-edit, external-edit, pull, adopt, update,
restore, delete markers that also preserve the manifest entry). Cap 50
versions/skill. This store is why assistant mutations are reversible —
and why `.history/` must never be edited directly.

## Other files

`notion.json` (vault-level Notion settings; committed) ·
`.sync-log.json` (CLI push history) · `snapshots/<machine>.json`
(device snapshots for multi-device sync). All tolerate absence.
