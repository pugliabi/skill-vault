---
name: vault-format
description: The Skill Vault on-disk contract — skills.json manifest entries, the structured origin block (git/dir/provider), the three-way content-hash update semantics, and SKILL.md conventions. Use when reading or repairing manifest entries, origins, or interpreting update statuses.
---

# Vault format essentials

A vault is a directory with `skills.json` (manifest) + `skills/<name>/`
(one folder per skill). Staging lives in `staging/<name>/`; version history in
`.history/` (app-managed — never touch it).

## Manifest entry (`skills.json` → `skills.<name>`)

```jsonc
{
  "targets": ["claude", "cursor"],   // providers it's pushed to; [] = unlinked
  "stage": "production",             // or "staging"; missing = production
  "source": "adopted from X",        // free-form display provenance
  "tags": ["fabric"],
  "origin": { ... },                 // structured provenance, below
  "notion": { ... }                  // Notion link (app-managed; don't hand-edit)
}
```

Unknown fields must round-trip untouched. `set_origin` handles this for
origins — another reason to never hand-edit the manifest for operations.

## The origin block

```jsonc
{
  "type": "git",                            // "git" | "dir" | "provider"
  "url": "https://github.com/x/skills.git", // git: remote URL
  "path": "C:\\Github\\skills-repos\\x",    // dir/provider: absolute source root
  "provider_id": "claude",                  // provider only
  "subpath": "skills/my-skill",             // skill dir relative to root, "/"-separated; "" = root
  "ref": "main",                            // git branch, optional
  "adopted_at": "...",                      // stamped by the server
  "content_hash": "..."                     // stamped by the server — vault copy's hash at adopt/update
}
```

- `git` without `path` = pure remote: checks shallow-clone to temp.
- `dir` pointing at a local git clone = best of both: the checker runs
  `git pull --ff-only` on it automatically before comparing.
- `set_origin` accepts only the location fields; stamps are server-side.

## Update statuses (three-way hash: recorded vs vault-now vs upstream-now)

| status | meaning | action |
|---|---|---|
| `up_to_date` | upstream == vault | none |
| `update_available` | vault untouched since adopt, upstream moved on | `apply_update` — safe |
| `local_changed` | vault edited, upstream unchanged | nothing to pull; local is ahead |
| `conflict` | both changed | user decides — never auto-overwrite |
| `upstream_missing` | source root exists but the subpath is gone (moved/deleted upstream) | find new location → `set_origin` |
| `source_missing` | the recorded local path no longer exists | re-clone or point at the new path → `set_origin` |
| `no_origin` | never recorded | adopt-from-source again with origin_context, or `set_origin` if you know the source |
| `error` | clone/network failure | read the message; often a dead URL → repo moved |

A check message like "moved to <rel>" means the checker already located the
skill inside the same source — `set_origin` with that subpath.

## SKILL.md conventions

Frontmatter `name:` MUST equal the folder name (kebab-case); `description:`
drives discovery — specific trigger phrases beat prose. Hash normalization
ignores CRLF/LF and trailing-whitespace differences, so those never count as
changes.
