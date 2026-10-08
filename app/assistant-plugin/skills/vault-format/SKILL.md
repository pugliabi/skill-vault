---
name: vault-format
description: Use this skill when reading or interpreting the Skill Vault's on-disk contract — skills.json manifest entries, the structured origin block (git/dir/provider), content hashes and three-way update semantics, update statuses such as update_available, conflict, local_changed, upstream_missing, source_missing or no_origin, SKILL.md frontmatter conventions, or the staging and history layout. Triggers: "what does conflict mean", "manifest entry", "origin block", "skills.json", "why local_changed", "hash mismatch", "gone upstream", "what's inside the vault folder".
---

# The vault's on-disk contract

A vault is a directory with `skills.json` (the manifest) and one folder per
skill under `skills/<name>/`. Also present: `staging/<name>/` (hidden from
normal flows until promoted), `snapshots/` (per-device), and `.history/`
(the app's version store — NEVER touch it; it is how every mutation stays
reversible).

See ./references/manifest-spec.md for the field-level schema of everything
below (notion link block, desktop packaging record, hash algorithm, history
layout).

## Manifest entries (skills.json → skills.<name>)

```jsonc
{
  "targets": ["claude", "cursor"],   // providers it's pushed to; [] = vault-only (fine)
  "stage": "production",             // or "staging"; missing = production
  "source": "adopted from X",        // free-form display provenance
  "tags": ["fabric"],
  "origin": { … },                   // structured provenance — update checks run on this
  "notion": { … }                    // Notion link — app-managed, read-only for you
}
```

Round-trip rule: unknown fields must survive rewrites — one more reason all
writes go through the vault tools, never hand-edits of skills.json.

## The origin block

```jsonc
{
  "type": "git",                            // "git" | "dir" | "provider"
  "url": "https://github.com/x/skills.git", // git: remote URL
  "path": "C:\\…\\skills-repos\\x",         // dir/provider: absolute source root
  "provider_id": "claude",                  // provider only
  "subpath": "skills/my-skill",             // skill dir relative to root; "" = root itself
  "ref": "main",                            // git branch, optional
  "adopted_at": "…",                        // SERVER-stamped — never set by hand
  "content_hash": "…"                       // SERVER-stamped: vault copy's hash at adopt/update
}
```

Type behavior during a check: pure `git` (no path) = shallow temp clone each
check · `dir` pointing at a git clone = auto `git pull --ff-only` first (the
best setup — record repaired origins this way when the user keeps clones
under the repos dir) · `provider` = compared in place.

## Update statuses — the decision table

Three-way compare: `recorded` (origin.content_hash at last adopt/update) vs
`vault` (now) vs `upstream` (now).

| status | meaning | action |
|---|---|---|
| `up_to_date` | upstream == vault | none |
| `update_available` | vault untouched since adopt; upstream moved on | `apply_update` — safe |
| `local_changed` | vault edited; upstream unchanged | nothing to pull; local is ahead |
| `conflict` | BOTH changed | user decides — never auto-overwrite |
| `upstream_missing` | source root exists; the subpath is gone (moved/deleted upstream) | find the new location → `set_origin` |
| `source_missing` | the recorded local path no longer exists | re-clone or repoint → `set_origin` |
| `no_origin` | never recorded | re-adopt with origin_context, or `set_origin` if the source is known |
| `error` | clone/network failure | read the message; a dead URL usually means the repo moved |

Gold shortcut: a check message `moved to <rel>` means the checker already
located the skill inside the same source — `set_origin` with that subpath.

## Hashes and SKILL.md conventions

The normalized content hash ignores CRLF-vs-LF and trailing whitespace —
line-ending churn never counts as a change. SKILL.md frontmatter: `name:`
MUST equal the folder name (kebab-case); `description:` is what makes agents
load the skill — specific trigger phrases beat prose (authoring-skills has
the full formula).
