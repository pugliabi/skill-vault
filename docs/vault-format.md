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
├── snapshots/                  # per-device state snapshots (optional)
│   └── <machine-id>.json
└── .history/                   # version history (optional, written by the app)
    ├── .gitattributes          # "* -text"
    ├── config.json             # { "max_versions": 50 }
    ├── objects/<aa>/<sha256>   # raw file contents, stored once
    └── skills/<name>/versions.json
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
  "desktop_package": { /* DesktopPackageInfo */ },  // optional last Claude Desktop packaging
  "notion": { /* NotionLink */ }    // optional link to a native Notion Skill page
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
| `notion` | `NotionLink` | Link between this skill and a Notion Skill page. Optional (additive, compatibility rule 1). |

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

### `SkillEntry.notion` — Notion link

Records a link between this vault skill and a page in a Notion "Skills"
database, when the user has connected Notion (see `notion.json` below) and
linked the skill. Entries without `notion` were never linked, or the link
was explicitly cleared.

```jsonc
{
  "page_id": "…",                         // Notion page id
  "state": "linked",                      // "linked" | "legacy" | "unlinked" | "vault-only"
  "linked_at": "2026-07-23T15:04:00Z",    // ISO 8601 UTC — when the link was created
  "synced_at": "2026-07-23T15:10:00Z",    // ISO 8601 UTC — last moment both sides were known equivalent; ABSENT = never synced
  "vault_hash": "<sha256>",               // normalized hash of the vault copy at synced_at
  "notion_version_id": "…",               // Notion's version id for the skill at synced_at (or at link time for conflicts)
  "notion_edited_at": "2026-07-23T15:09:00Z",  // Notion "Last edited" value at the same moment
  "base_vault_version": "…",              // vault-side history version id used as the sync baseline
  "base_notion_version": "…",             // notion-side history version id used as the sync baseline
  "notion_title": "My Skill",             // Notion page title at link time — display only
  "vault_name": "my-skill"                // vault folder name at last link/sync — absent on older links
}
```

| Field | Type | Meaning |
|---|---|---|
| `page_id` | `string` | Id of the linked Notion page. Required. |
| `state` | `"linked"` \| `"legacy"` \| `"unlinked"` \| `"vault-only"` | Link lifecycle. `linked` — an ordinary two-way link to a Notion-native page. `legacy` — the Notion page was detected as a converted copy of this vault skill (see the legacy-conversion rule below); content is not compared for sync purposes. `unlinked` — the user explicitly disconnected this skill from Notion; it is excluded from auto-matching until relinked. `vault-only` — the user marked this skill as intentionally not represented in Notion. |
| `linked_at` | `string` | ISO 8601 UTC timestamp of when the link was created. Preserved across relinks to the same page. |
| `synced_at` | `string` | ISO 8601 UTC timestamp of the last moment the vault copy and the Notion copy were known to be equivalent (first link if the content matched, or a completed sync). **Absent means the two sides have never been confirmed equivalent** — readers MUST treat this as a conflict, not as "unknown"/neutral. |
| `vault_hash` | `string` | Normalized content hash (see "Content hash algorithm" below) of the vault copy at `synced_at`. Compared against the vault copy's current hash to detect vault-side drift. |
| `notion_version_id` | `string` | Notion's version identifier for the page's content at `synced_at` (or at link time, for links recorded as a conflict). Compared against the latest known Notion version to detect Notion-side drift. |
| `notion_edited_at` | `string` | Notion's "Last edited" timestamp captured at the same moment as `notion_version_id`. |
| `base_vault_version` | `string` | Id of the vault-side `.history` version used as the common ancestor for the last sync, when available. |
| `base_notion_version` | `string` | Id of the notion-side `.history` version used as the common ancestor for the last sync, when available. |
| `notion_title` | `string` | The Notion page's title at link time, kept only for display. |
| `vault_name` | `string` | The vault skill folder's name as of the last link or sync. Used only to detect vault-side renames (comparing it against the folder's current name); absent on links created before this field existed, which simply never produce a rename detection until their next sync. |

**Legacy conversion.** A Notion page is treated as a `legacy` copy of a
vault skill (rather than a Notion-native skill to sync against) when its
title is a display variant of the vault skill's name (title differs from
the vault name, but normalizing the title — lowercase, every run of
non-`[a-z0-9]` characters collapsed to `-`, trimmed — equals the vault
name) **and** it looks like a converted summary rather than the full
skill: either the Notion page has no attached files while the vault copy
has files beyond `SKILL.md`, or the Notion page's `SKILL.md` body contains
the phrase "What Claude automates". Legacy links are excluded from
content-drift comparison.

**Notion-native pages** that have no vault match and whose title is not a
valid skill-folder name (`^[a-z0-9]+(-[a-z0-9]+)*$`) are surfaced
separately from ordinary "Notion-only" matches, since they cannot be
represented as a vault skill folder as-is.

Readers MUST ignore unknown fields inside `notion` and writers SHOULD
preserve them (same round-trip rule as the entry itself). Any reader that
rewrites a `SkillEntry` it does not otherwise understand MUST preserve an
existing `notion` field unchanged.

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

## `notion.json` — Notion settings

Optional file at `<vault>/notion.json`, shared vault-wide settings for the
Notion connection. Committed with the vault like `skills.json`; it holds no
credentials or per-machine state.

```jsonc
{
  "data_source_id": "…",              // chosen Notion Skills data source
  "data_source_name": "My Skills",    // display name for that data source
  "last_edited_property": "Last edited",  // name of the last-edited-time property added to the data source, or null if declined/unavailable
  "linked_at": "2026-07-23T15:04:00Z" // ISO 8601 UTC — last time a link/relink pass completed
}
```

| Field | Type | Meaning |
|---|---|---|
| `data_source_id` | `string` | Id of the Notion data source (database) the user picked as their Skills source. Absent = not connected/configured. |
| `data_source_name` | `string` | Display name of that data source, for the UI. |
| `last_edited_property` | `string \| null` | Name of the last-edited-time property added to the data source so drift can be detected. `null` means the user declined adding it, or it wasn't available. |
| `linked_at` | `string` | ISO 8601 UTC timestamp of the last completed link/relink pass. |

Readers MUST ignore unknown fields and writers SHOULD preserve them
(round-trip safe), same as the other top-level vault files.

Notion sign-in (OAuth tokens) and the last-known Notion-side row cache are
**per-machine** and live outside the vault entirely — they are never
written to `<vault>/notion.json` or committed with the vault.

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

## `.history/` — version history

Optional directory at `<vault>/.history/`, written by the web app to keep a
version history of each skill's files. The Python `sv` CLI does not write
or read it: it only reads `skills.json` and `skills/`, so `.history/`
living outside `skills/` means it is invisible to any tool that just scans
skill folders. **Readers other than the app that manages this directory
MUST ignore `.history/` entirely** — it is not part of the portable vault
contract in the way `skills.json` and `skills/` are.

```jsonc
// .history/config.json
{
  "max_versions": 50   // per-skill cap; oldest versions are dropped once exceeded
}
```

No `.gitattributes` is written inside `.history/`: its files follow the
vault repository's own line-ending settings, the same as the skill files
they copy.

### Objects

`.history/objects/<sha256[0:2]>/<sha256>` holds the **uncompressed** bytes
of one file version, named by the SHA-256 of those bytes as they were read
when the version was recorded. Storing objects uncompressed (not gzipped)
is deliberate: because objects follow the repository's EOL settings, git
stores an unchanged file and its history object as the same blob, so it
costs the repository nothing extra. After a checkout on a machine with
different line-ending settings, an object's bytes on disk may no longer
hash to its filename; that is expected, and readers MUST treat object
names as opaque lookup keys rather than re-verifying them. Objects are content-addressed and shared
across skills and versions; the same file contents anywhere in history
resolve to the same object. Objects are **not reference-counted on write**
— an object with no version left pointing to it (e.g. after old versions
age out past `max_versions`) is simply unreferenced and MAY be removed by
a garbage-collection pass that walks every `versions.json` and deletes any
object not mentioned in a `files` map.

### `skills/<name>/versions.json` — per-skill version list

```jsonc
{
  "skill": "my-skill",
  "versions": [
    {
      "id": "m5x2ab-1a2b3c",              // <base36 timestamp>-<6 hex chars>
      "at": "2026-07-23T15:04:00.000Z",   // ISO 8601 UTC
      "side": "vault",                    // "vault" | "notion"
      "source": "vault-edit",             // see source list below
      "note": "restored version from …",  // optional, free-form
      "files": {                          // "/"-separated relative path → sha256
        "SKILL.md": "3f2c9a…",
        "scripts/run.py": "9be0d1…"
      },
      "normalized_hash": "8ac41e…"        // or null if the dir was missing/empty at snapshot time
      // "manifest_entry": { ... }        // optional, see below
    }
  ]
}
```

Versions are stored **oldest first on disk** (append-only); readers that
want newest-first reverse the array. `id` values are lexically sortable by
creation order within the same process clock resolution but MUST NOT be
assumed globally unique across vaults — treat them as opaque within one
`versions.json`.

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Opaque version id, `<base36 ms timestamp>-<6 hex chars>`. |
| `at` | `string` | ISO 8601 UTC timestamp of the snapshot. |
| `side` | `"vault"` \| `"notion"` | Which copy this version snapshots. |
| `source` | `string` | What triggered the snapshot; see the source list below. |
| `note` | `string` | Optional free-form annotation (e.g. why a snapshot was taken). |
| `files` | `Record<string,string>` | `/`-separated relative path → SHA-256 of that file's raw bytes at snapshot time. |
| `normalized_hash` | `string \| null` | The normalized content hash (see "Content hash algorithm" above) of the snapshotted directory, or `null` if it couldn't be computed. |
| `manifest_entry` | *(opaque)* | Optional. The skill's `skills.json` entry, captured at record time. Currently only recorded on the version taken immediately before a skill is deleted. |

Recognized `source` values: `vault-edit`, `external-edit`, `pull`,
`push-notion-copy`, `notion-edit`, `claude-merge`, `force-push`,
`force-pull`, `restore`, `rename`, `delete`, `adopt`, `update`,
`legacy-snapshot`.

The Notion-sync sources record which side of a Notion link changed and why,
so history stays a truthful record of both copies even though only the
vault copy lives on disk:

- **`push-notion-copy`** (`notion` side) — recorded right after an ordinary
  push, from a fresh re-download of what Notion now holds. Confirms what
  Notion actually stored (Notion may reformat content on write; see
  `docs/notion-sync.md`).
- **`notion-edit`** (`notion` side) — a snapshot of Notion's copy taken for
  a reason other than "we just pushed it": before an about-to-happen force
  push overwrites it, on every pull (before the merge/replace decision),
  when a Notion-only page is adopted into the vault, during first-time
  linking, or when the background Notion checker notices a linked page's
  version changed (no vault write happens in that last case — it only
  updates what "changed-notion" is compared against).
- **`claude-merge`** (`vault` side) — a Conflicts-page resolution built from
  a Claude-assisted merge, written to the vault immediately before it is
  force-pushed back to Notion. (`vault-edit` is used instead when the
  resolution is "keep my own hand-edited copy" rather than Claude's
  output — it is not Notion-specific, but Conflicts reuses it as the other
  resolution tag.)
- **`force-push`** (`vault` side) — recorded at the start of a force push,
  right after Notion's about-to-be-overwritten copy is captured as
  `notion-edit`. Marks "this vault copy is the one that won."
- **`force-pull`** (`vault` side) — the vault folder replacement written by
  a force pull (Notion's copy overlaid onto the vault; vault-only
  frontmatter fields are preserved). Used instead of `pull` specifically
  because a force pull skips the 3-way merge.

See `docs/notion-sync.md` for the full push/pull/merge/force user flows
these sources come from.

**Deduplication:** a new version is only appended when it differs from the
most recent version on the *same* `side`. A state counts as identical when
either its `files` map matches exactly, or both its `normalized_hash` and
the previous version's `normalized_hash` are non-null and equal (so a
line-ending-only difference is not a new version). Recording an identical
state is a no-op (unless the caller explicitly forces it, e.g.
`restore` always appends so the restore itself is visible in history).
External edits are recorded after the app observes **60 seconds** of
filesystem quiet on a skill folder, and the app also scans for
out-of-band changes at startup.

**Deletion:** when a skill is deleted, a marker version is appended with
`source: "delete"`. A deletion marker repeats the previous version's
`files` map unchanged (it marks *that* state as the last one before
deletion, it does not snapshot new content) and, unlike other versions,
may also carry `manifest_entry` — a copy of the skill's `skills.json`
entry (`targets`, `stage`, `source`, etc.) at the moment of deletion. Since
deleting a skill removes both its folder and its manifest entry, this is
the only place that entry survives. Restoring a deleted skill re-creates
the folder from the chosen version and, if the manifest has no entry for
that skill name, re-creates the manifest entry too: from the newest
recorded `manifest_entry` in that skill's history if one exists, otherwise
from `{ "targets": [] }`. An existing manifest entry is never overwritten
by a restore.

**Rename:** renaming a skill moves `.history/skills/<old-name>/` to
`.history/skills/<new-name>/`. If history already exists under the new
name (e.g. a previously deleted skill is being replaced by that name),
the two timelines are merged: all versions from both are combined and
sorted by `at` ascending, so the merged file's version order stays
chronological even though the two histories were recorded independently.

**Cap:** each skill keeps at most `max_versions` versions (default **50**,
configurable via `.history/config.json`); once the count is exceeded, the
oldest versions are dropped from the front of the array.

**Unreadable `versions.json`:** a missing `versions.json` means the skill
has no history yet. A `versions.json` that exists but can't be parsed (for
example, one left with merge-conflict markers after syncing the vault
between machines) is **never overwritten**: the app skips recording
history for that skill, reports an error when asked to list it, and skips
garbage collection of objects entirely until the file is repaired, since
it can't tell which objects that file still references.

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
