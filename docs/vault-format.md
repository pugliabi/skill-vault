# Skill Vault — Directory Format

**Status:** authoritative. This document is the **single source of truth**
for the on-disk format shared by:

- `src/skill_vault/` — the Python `sv` CLI
- `app/` — the standalone Node/React web app

The two tools are otherwise independent: they do not share code, processes,
or config files. The only contract between them is this format. If you
change anything in this document, both implementations must be updated to
match, and the `schema_version` field must be bumped for any breaking
change.

## Directory layout

A "vault" is any directory with the following structure. Nothing else in
the directory is interpreted; users can keep README files, notes, zip
archives, etc. alongside the managed entries without confusing either tool.

```
<vault>/
├── skills.json                 # manifest (required)
├── .sync-log.json              # push history (optional, written by CLI)
├── skills/                     # canonical skill copies (required)
│   ├── <skill-name>/
│   │   ├── SKILL.md            # optional but strongly recommended
│   │   └── ...                 # any other files the skill needs
│   └── ...
├── staging/                    # work-in-progress skills (optional)
│   └── <skill-name>/
└── snapshots/                  # per-device state snapshots (optional)
    └── <machine-id>.json
```

## `skills.json` — the manifest

JSON file at `<vault>/skills.json`. This is the only file an implementation
is required to read to list the skills it manages.

### Top-level schema

```jsonc
{
  "version": "1.0",                 // optional — legacy top-level version
  "machine_id": "DESKTOP-01",   // optional — writer's machine id
  "default_targets": ["claude"],    // optional — writer's default providers
  "skills": {
    "<skill-name>": { /* SkillEntry */ }
  }
}
```

All top-level fields except `skills` are **optional**. Readers MUST
tolerate their absence. Writers SHOULD preserve any top-level field they
did not originate (round-trip safe).

### `SkillEntry`

```jsonc
{
  "targets": ["claude", "cursor"],  // required, may be empty []
  "stage": "production",            // optional: "staging" | "production"
  "source": "adopted from claude",  // optional free-form provenance string
  "origin": { /* SkillOrigin */ },  // optional structured provenance
  "desktop_package": { /* DesktopPackageInfo */ }  // optional last Claude Desktop packaging
}
```

Field meanings:

| Field | Type | Meaning |
|---|---|---|
| `targets` | `string[]` | Provider ids the skill should be pushed to. Required; empty array is valid (unlinked skill). |
| `stage` | `"staging"` \| `"production"` | Lifecycle state. Missing = `"production"`. |
| `source` | `string` | Free-form provenance for display. Conventional prefixes: `"adopted from <x>"`, `"pulled from <x>"`, `"scanned from <x>"`, `"searched from <x>"`. |
| `origin` | `SkillOrigin` | Structured provenance for update-from-source. Optional (additive, compatibility rule 1). |
| `desktop_package` | `DesktopPackageInfo` | Record of the last Claude Desktop packaging. Optional (additive, compatibility rule 1). |

Readers MUST ignore unknown fields. Writers SHOULD preserve unknown fields
when rewriting the manifest (round-trip safe).

### `SkillEntry.origin` — structured provenance

Written at adopt/import time so the tools can later re-check the source and
offer to pull upstream changes. Entries without `origin` are simply excluded
from update checks; `source` remains the human-readable display string.

```jsonc
{
  "type": "git",                              // "git" | "dir" | "provider"
  "url": "https://github.com/x/skills.git",   // git only — remote URL
  "path": "C:\\Repos\\x",                     // dir/provider — source root; absent for pure-remote git
  "provider_id": "claude",                    // provider only
  "subpath": "skills/my-skill",               // skill dir relative to url/path root, "/"-separated
  "ref": "main",                              // git only, optional — branch used at adopt
  "adopted_at": "2026-07-23T15:04:00Z",       // ISO 8601 UTC; refreshed on every update
  "content_hash": "<sha256>"                  // normalized hash of the VAULT copy at adopt/update time
}
```

| Field | Type | Meaning |
|---|---|---|
| `type` | `"git"` \| `"dir"` \| `"provider"` | `git` = remote repo (clone to temp to check); `dir` = local directory, typically a clone the user pulls themselves; `provider` = a provider's skills directory. |
| `url` | `string` | Remote URL. `git` origins only. |
| `path` | `string` | Absolute source-root path. `dir`/`provider` origins. |
| `provider_id` | `string` | Provider id. `provider` origins only. |
| `subpath` | `string` | Skill folder relative to the source root, `/`-separated. `""` means the root itself is the skill. |
| `ref` | `string` | Git branch recorded at adopt time. Optional. |
| `adopted_at` | `string` | ISO 8601 UTC of the last adopt/update from this source. |
| `content_hash` | `string` | Normalized content hash (see below) of the vault copy taken right after adopt/update. Lets checkers distinguish "upstream changed" from "vault copy edited locally". |

Update-check semantics (both implementations): with `recorded` =
`origin.content_hash`, `vault` = hash of the vault copy now, `upstream` =
hash of the source copy now — `upstream == vault` → up to date;
`vault == recorded` (and upstream differs) → update available;
`upstream == recorded` (and vault differs) → local changes only; all three
different → conflict (pulling would overwrite local edits). Checks are
read-only; only applying an update rewrites the skill dir and refreshes
`content_hash`/`adopted_at`.

Readers MUST ignore unknown fields inside `origin` and writers SHOULD
preserve them (same round-trip rule as the entry itself).

### `SkillEntry.desktop_package` — Claude Desktop packaging record

Claude Desktop loads skills from the user's claude.ai account. Custom
skills there cannot be listed or uploaded programmatically (they don't
sync across surfaces), so the vault tracks its own side of the exchange:
when a skill is packaged into an upload-ready zip for Claude Desktop, the
packaging is recorded here. Entries without `desktop_package` were never
packaged.

```jsonc
{
  "packaged_at": "2026-07-23T15:04:00Z",  // ISO 8601 UTC of the packaging
  "content_hash": "<sha256>"              // normalized hash of the vault copy at package time
}
```

| Field | Type | Meaning |
|---|---|---|
| `packaged_at` | `string` | ISO 8601 UTC timestamp of the packaging. When the record is backfilled from a pre-existing zip, this is the zip's mtime. |
| `content_hash` | `string` | Normalized content hash (see below) of the vault copy when the zip was built. When backfilled, the hash of the zip's contents (wrapper folder stripped) — identical content produces an identical digest. |

Derived desktop status (computed at read time, never stored): comparing
`content_hash` against the vault copy's current hash yields `current`
(match — the last packaged zip still reflects the vault) or `outdated`
(vault changed since packaging; re-package and re-upload). No record
means `not-packaged`. Because there is no way to inspect the claude.ai
account, "packaged" is used as a proxy for "uploaded".

Readers MUST ignore unknown fields inside `desktop_package` and writers
SHOULD preserve them (same round-trip rule as the entry itself).

### Content hash algorithm

The "normalized content hash" used by `origin.content_hash`,
`.sync-log.json`, and `snapshots/*.json` is defined by
`src/skill_vault/hashing.py` (`hash_directory`) and mirrored exactly by
`app/server/services/skillHash.ts` (`hashSkillDirNormalized`):

1. Collect every file under the skill dir, skipping any path containing a
   component in `{node_modules, __pycache__, .git, .DS_Store, Thumbs.db}`.
2. Order files by their `/`-separated relative path, lowercased.
3. Hash each file with SHA-256. Files whose extension is in the binary set
   (images, archives, office docs, fonts, executables — see `_BINARY_EXTS`
   in `hashing.py`) hash their raw bytes. All other files are treated as
   UTF-8 text (undecodable bytes replaced) and normalized first: line
   endings to `\n`, trailing whitespace stripped per line, trailing blank
   lines stripped — so CRLF/LF and trailing-space differences never count
   as changes.
4. The directory hash is the SHA-256 of the concatenated per-file hex
   digests. An existing directory with no hashable files hashes to the
   literal string `"empty"`; a missing directory has no hash.

### Derived fields (NOT stored)

These fields are computed at read-time from the filesystem and MUST NOT
be written to `skills.json`:

- **`description`** — first `description:` value in `SKILL.md` YAML
  frontmatter, or the first non-blank paragraph of the body. Empty string
  if `SKILL.md` is missing or unparseable.
- **`file_count`** — recursive count of files under `<vault>/skills/<name>/`.
- **`has_skill_md`** — true iff `<vault>/skills/<name>/SKILL.md` exists.
- **`modified_at`** / **`last_synced_at`** — filesystem `mtime` of the
  skill directory. UIs are free to display this.

Derived fields are a convenience for UIs and MUST match what the
filesystem currently says. They become stale if the skill directory is
edited outside the tool — both tools are expected to recompute them on
every read, not cache them in `skills.json`.

## `.sync-log.json` — push history

Optional file at `<vault>/.sync-log.json`. Written by the CLI after each
push to record which content hash was pushed where. The web app reads
this file when rendering drift badges (v2+) but does not write to it.

```jsonc
{
  "<content-hash>": {
    "skill_name": "my-skill",
    "pushed_at": "2026-03-15T14:30:00.000Z",
    "target": "claude"
  }
}
```

The content hash is the normalized content hash defined in
"Content hash algorithm" above (`src/skill_vault/hashing.py`, mirrored by
`app/server/services/skillHash.ts`).

If the file is missing, empty, or malformed, readers MUST fall back to
behavior equivalent to "no push history known" — never crash.

## `snapshots/<machine-id>.json` — device snapshots

Optional files under `<vault>/snapshots/`. One file per device that has
checked into the vault. Used for multi-device sync (a v4 feature).

```jsonc
{
  "machine_id": "DESKTOP-01",
  "hostname": "desktop-01.local",
  "snapshot_at": "2026-03-15T14:30:00.000Z",
  "skills": {
    "<skill-name>": "<content-hash>"
  }
}
```

Not required for v1 functionality in either tool. Writers MUST use a
filename-safe `machine_id`; readers MUST tolerate missing files or an
empty `snapshots/` directory.

## `skills/<name>/` and `staging/<name>/`

Each subdirectory is a "skill" — a folder the tools push (via symlink,
junction, or copy) to provider directories like `~/.claude/skills/<name>`.

Conventions:

- **`SKILL.md`** at the root of a skill folder is the authoritative
  description entry point. YAML frontmatter is encouraged:
  ```markdown
  ---
  name: my-skill
  description: One-liner about what it does.
  ---

  Body here.
  ```
- Any other files in the folder are the skill's actual implementation.
- `node_modules/`, `.git/`, `__pycache__/`, `Thumbs.db`, `.DS_Store`,
  `*.tmp`, and `.temp-*` paths MUST be ignored by copy fallbacks — they
  are not part of the skill.
- `staging/` is identical in structure to `skills/`. Skills in `staging/`
  are hidden from normal browsing and are not pushed to providers.

## Schema versioning

This document corresponds to schema version **1**. The `schema_version`
field is NOT currently written to `skills.json` (legacy reasons) but
MUST be added to the top-level object when any field definition changes
in a backwards-incompatible way.

Compatibility rules:

1. **Additive changes** (new optional fields) — MAY be made without
   bumping `schema_version`, as long as readers can ignore them.
2. **Breaking changes** (removed/renamed/retyped fields) — MUST bump
   `schema_version` at the top level of `skills.json` and update this
   doc in the same commit.
3. **Readers** SHOULD warn on an unknown major `schema_version` but
   still attempt to read the file (unknown fields are ignored).
4. **Writers** MUST NOT silently downgrade the schema version.

## Implementation checklist

When implementing read/write for this format, both sides must:

- [ ] Handle missing `skills.json` by treating the vault as empty
- [ ] Tolerate extra top-level and per-entry fields (round-trip safe)
- [ ] Write atomically (temp file + rename) to avoid half-written files
- [ ] Ignore the junk patterns above during recursive scans
- [ ] Accept paths with either `/` or `\` (Windows) and normalize to
      absolute form before touching disk

The Python side lives in `src/skill_vault/` (primary: `scanner.py`,
`config.py`, `linking.py`). The TypeScript side lives in `app/server/`
(primary: `services/vault.ts`, `services/linking.ts`,
`services/adoption.ts`).
