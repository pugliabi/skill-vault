/**
 * Types shared between server and client.
 *
 * These match the on-disk vault format documented in `docs/vault-format.md`,
 * with a few fields derived at read-time from the filesystem rather than
 * from `skills.json` itself (file_count, has_skill_md, description).
 */

// ── On-disk manifest (skills.json) ──────────────────────────────

/**
 * Structured provenance recorded at adopt/import time so a skill can later
 * be checked and updated from its original source. See docs/vault-format.md
 * § "SkillEntry.origin". Optional — entries adopted before this feature
 * simply have no origin and are excluded from update checks.
 */
export interface SkillOrigin {
  /** Where the skill came from: a git remote, a local directory, or a provider dir. */
  type: "git" | "dir" | "provider";
  /** Remote URL — `git` origins only. */
  url?: string;
  /** Absolute path of the source root — `dir`/`provider` origins. */
  path?: string;
  /** Provider id (e.g. "claude") — `provider` origins only. */
  provider_id?: string;
  /** Skill dir relative to the source root, "/"-separated. "" = the root itself. */
  subpath: string;
  /** Branch used at adopt time — `git` origins, optional. */
  ref?: string;
  /** ISO 8601 UTC timestamp; refreshed on every update-from-source. */
  adopted_at: string;
  /** Normalized content hash of the VAULT copy at adopt/update time. */
  content_hash: string;
}

/**
 * Record of the last Claude Desktop packaging of a skill. Written when the
 * upload-ready zip is built (POST /api/desktop) or seeded by the backfill
 * from an existing zip. Claude Desktop skills live in the user's claude.ai
 * account with no list/upload API, so this record — not the account — is
 * what desktop staleness is computed against ("packaged = uploaded" proxy).
 */
export interface DesktopPackageInfo {
  /** ISO 8601 UTC timestamp of the packaging (zip mtime when backfilled). */
  packaged_at: string;
  /** Normalized content hash of the vault copy when the zip was built. */
  content_hash: string;
}

/** Link between a vault skill and a native Notion Skill page. See docs/vault-format.md "SkillEntry.notion". */
export interface NotionLink {
  page_id: string;
  state: "linked" | "legacy" | "unlinked" | "vault-only";
  linked_at: string;
  /** Set when both sides were known to be equivalent (first link or a completed sync). Absent = never synced (conflict). */
  synced_at?: string;
  /** Normalized hash of the vault copy at synced_at. */
  vault_hash?: string;
  /** Notion's version_id for the skill at synced_at (or at link time for conflicts). */
  notion_version_id?: string;
  /** Notion "Last edited" value at the same moment. */
  notion_edited_at?: string;
  base_vault_version?: string;
  base_notion_version?: string;
  /** Notion Skill name at link time (display only). */
  notion_title?: string;
}

export type NotionStatus =
  | "synced" | "changed-vault" | "changed-notion" | "conflict"
  | "not-in-notion" | "vault-only" | "legacy" | "unlinked"
  /** Linked + synced, but the Notion side has not been checked (no valid cache / no version). */
  | "unchecked"
  /** Linked + synced, but the page is no longer in the chosen Skills data source. */
  | "missing-in-notion";

/** One entry in the `skills` map in `skills.json`. */
export interface ManifestSkill {
  /** Which providers this skill should be pushed to (e.g. "claude", "cursor"). */
  targets: string[];
  /** Lifecycle stage. Optional — treat missing as "production". */
  stage?: "staging" | "production";
  /** Free-form provenance string ("adopted from claude", "searched from X"). */
  source?: string;
  /** User-assigned tags for organization/filtering. */
  tags?: string[];
  /** Structured provenance for update-from-source. Optional. */
  origin?: SkillOrigin;
  /** Last Claude Desktop packaging, if the skill was ever packaged. */
  desktop_package?: DesktopPackageInfo;
  /** Link to a native Notion Skill page. */
  notion?: NotionLink;
}

/** Top-level shape of `<vault>/skills.json`. */
export interface SkillsManifest {
  /** Optional top-level fields older manifests set at the repo root. */
  version?: string;
  machine_id?: string;
  default_targets?: string[];
  known_tags?: string[];
  skills: Record<string, ManifestSkill>;
}

// ── Client-facing skill shape ───────────────────────────────────
//
// Everything the API returns to the browser. Combines manifest fields with
// derived filesystem metadata. Drift/sync-status fields are deferred to v2
// — this v1 returns only what can be computed cheaply from a single read.

export type TargetStatus = "synced" | "stale" | "missing" | "error";
export type SkillStatus =
  | "synced"
  | "stale"
  | "vault-only"
  | "staging"
  | "missing";

/**
 * Claude Desktop packaging state, kept separate from the aggregate
 * SkillStatus because claude-desktop is a package target, not a `targets`
 * entry (see routes/desktop.ts).
 *   - current      — desktop_package.content_hash matches the vault copy
 *   - outdated     — vault changed since packaging → re-package + re-upload
 *   - not-packaged — never packaged (no desktop_package record)
 */
export type DesktopStatus = "current" | "outdated" | "not-packaged";

export interface Skill {
  name: string;
  targets: string[];
  tags: string[];
  stage: "staging" | "production";
  source: string;
  /** Number of files inside `<vault>/skills/<name>/`, recursively. */
  file_count: number;
  /** True if `<vault>/skills/<name>/SKILL.md` exists. */
  has_skill_md: boolean;
  /** First paragraph of SKILL.md if present, otherwise empty. */
  description: string;
  /** `mtime` of the skill directory, ISO string. */
  modified_at: string;
  /** `birthtime` (or fallback `mtime`) of the skill directory, ISO string. */
  created_at: string;
  /** Per-target sync state, computed at request time. */
  target_status: Record<string, TargetStatus>;
  /** Aggregate state derived from target_status + stage + targets. */
  status: SkillStatus;
  /** Claude Desktop packaging state (hash-compared at read time). */
  desktop_status: DesktopStatus;
  /** Last Desktop packaging record, when the skill was ever packaged. */
  desktop_package?: DesktopPackageInfo;
  /** Structured provenance when the skill was adopted from a trackable source. */
  origin?: SkillOrigin;
  /** Notion sync status when Notion is connected. */
  notion_status?: NotionStatus;
}

/** A single node in the detail-view file tree. */
export interface FileNode {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  children?: FileNode[];
}

export interface SkillDetail extends Skill {
  files: FileNode;
}

// ── App config ─────────────────────────────────────────────────
//
// The app does NOT own its own config file. It reads and writes the
// same `~/.skill-vault/config.json` the CLI uses, so a user who ran
// `sv init` earlier sees their vault and providers immediately when
// they first open the app, and vice versa.
//
// `Provider` mirrors one entry in the CLI config's `agent_locations`
// map: `{ "<id>": "<path>" }`. Display labels come from the id itself
// since that map has no separate name field — keeping this shape
// one-to-one with the CLI avoids any round-trip information loss.

export interface Provider {
  /** Slug used as the key in `agent_locations` (e.g. "claude", "cursor"). */
  id: string;
  /** Absolute path to the provider's skills directory. */
  path: string;
}

export interface AppConfig {
  /** Always present once first-run is complete. */
  vault_path: string | null;
  /** Known provider directories, projected from `agent_locations`. */
  providers: Provider[];
  /** Default targets from the CLI config, surfaced for display only. */
  default_targets?: string[];
  /**
   * Claude Desktop packaging stage dir (CLI config key
   * `claude_desktop_stage`). Null = unset; the server resolves the
   * default (<vault>/../.claude-desktop-packages) at request time.
   */
  claude_desktop_stage?: string | null;
}

/** Result of POST /api/desktop — packaging a skill for Claude Desktop. */
export interface DesktopPackageResult {
  skill: string;
  zip_path: string;
  stage_dir: string;
  /** Normalized vault hash recorded in the skill's desktop_package. */
  content_hash: string;
  packaged_at: string;
}

/** Result of POST /api/desktop/backfill — seeding records from existing zips. */
export interface DesktopBackfillResult {
  /** Skills that got a desktop_package record seeded from a found zip. */
  seeded: Array<{
    skill: string;
    zip_path: string;
    /** Status right after seeding — outdated means the zip predates vault edits. */
    desktop_status: "current" | "outdated";
  }>;
  /** Zips that were found but skipped, with the reason. */
  skipped: Array<{ zip: string; reason: string }>;
}

// ── API payloads ───────────────────────────────────────────────

export interface AdoptScanResult {
  name: string;
  /** Absolute path to the skill folder — the authoritative selection key. */
  path: string;
  /** Path relative to the scan root (e.g. `repoA/skills/pdf`). */
  rel_path?: string;
  /** Top-level folder under the scan root — the repo name when scanning many. */
  source?: string;
  /** sha1 of the SKILL.md content — identical copies share a signature. */
  sig?: string;
  /** How many byte-identical copies were collapsed into this row (≥1). */
  dup_count?: number;
  file_count: number;
  has_skill_md: boolean;
  /** First line of the SKILL.md description, if any. Empty when absent. */
  description?: string;
  /** True if the vault already has a skill of this name. */
  already_in_vault: boolean;
  /**
   * Only meaningful when `already_in_vault` — true when the incoming copy's
   * content differs from the vault copy, i.e. re-adopting would change it.
   */
  update_available?: boolean;
}

export interface AdoptImportRequest {
  source_path: string;
  /**
   * Explicit {name, path} pairs to import. Preferred form — sent by the
   * scan-based flows so duplicate names from different sources stay
   * distinct (selection is keyed by absolute path, not name).
   */
  items?: { name: string; path: string }[];
  /**
   * Legacy form: skill names. Used by Discover. When `items` is present
   * this is ignored.
   */
  skills?: string[];
  /**
   * Absolute path to each chosen skill folder, keyed by name. Legacy
   * companion to `skills`. Optional — flat flows fall back to the
   * `source_path/<name>` join.
   */
  paths?: Record<string, string>;
  /** Optional provider id to record in the skill's `source` field. */
  provider_id?: string;
  /**
   * Allow overwriting skills that are already in the vault. Off by default
   * so a stray selection can never clobber local edits; the UI sends it
   * when the user explicitly selected "update available" rows.
   */
  overwrite?: boolean;
  /**
   * Where this import came from, used to record `origin` on each imported
   * skill. `root` is the scan root the items' paths are relative to (for
   * the clone flow it's the temp clone dir, and `url`/`ref` describe the
   * remote instead of a persistent local path).
   */
  origin_context?: {
    type: "git" | "dir" | "provider";
    url?: string;
    ref?: string;
    root: string;
    provider_id?: string;
  };
}

// ── Update-from-source payloads ────────────────────────────────

export type UpdateStatus =
  | "up_to_date"
  | "update_available"
  | "local_changed"
  | "conflict"
  | "no_origin"
  | "source_missing"
  | "upstream_missing"
  | "error";

/** One row of POST /api/adopt/check-updates — read-only, no manifest writes. */
export interface UpdateCheckResult {
  name: string;
  status: UpdateStatus;
  origin?: SkillOrigin;
  /** Normalized hash of the vault copy right now. */
  vault_hash?: string;
  /** Normalized hash of the source copy right now. */
  upstream_hash?: string;
  /** origin.content_hash — the vault copy's hash when last adopted/updated. */
  recorded_hash?: string;
  /** Absolute dir holding the upstream copy (local dir or inside a temp clone). */
  upstream_path?: string;
  /** Set when a temp clone was made; echo to /update and /cleanup. */
  tmp_path?: string;
  /** True when a local `git pull --ff-only` ran successfully before comparing. */
  git_pulled?: boolean;
  /** Human detail: pull failures, "moved to <rel>", clone stderr, etc. */
  message?: string;
}

export interface CheckUpdatesRequest {
  /** Skill names to check. Empty/omitted = every skill with an origin. */
  skills?: string[];
}

export interface ApplyUpdatesRequest {
  items: {
    name: string;
    /** Upstream dir from the check result — reused when it still exists. */
    upstream_path?: string;
    /** Temp clone the check created, if any. */
    tmp_path?: string;
  }[];
}

export interface ApplyUpdatesResult {
  updated: string[];
  skipped: { name: string; reason: string }[];
}

export type LinkMethod = "symlink" | "junction" | "copy" | "auto";

export interface PushRequest {
  skill: string;
  provider_id: string;
  method: LinkMethod;
}

export interface PushResult {
  skill: string;
  target_path: string;
  /** Which method actually succeeded (never "auto" — it gets resolved). */
  method: "symlink" | "junction" | "copy";
}

export interface UpdateSkillRequest {
  stage?: "production" | "staging";
  targets?: string[];
  source?: string;
}

// ── Activity log + SSE events (Phase 1) ────────────────────────

export type ActivityKind =
  | "push"
  | "pull"
  | "adopt"
  | "update"
  | "promote"
  | "demote"
  | "remove"
  | "rename"
  | "restore"
  | "notion-link"
  | "notion-check";

/**
 * One entry in the in-memory activity ring buffer. Recorded by route
 * handlers at the moment a mutation is requested; broadcast to all
 * connected SSE clients as a `data:` payload.
 *
 * The ring buffer is intentionally not persisted in v1 — see
 * PERSIST-01 (v2). Pre-restart history is acceptably lost.
 */
export interface ActivityEntry {
  /** ISO 8601 timestamp captured at record() time. */
  at: string;
  kind: ActivityKind;
  /** Skill name the action targeted. */
  skill: string;
  /** Optional provider id (push/pull/adopt have it; promote/demote do not). */
  provider_id?: string;
  /** Outcome — false for failures so the UI can render ✗. */
  ok: boolean;
  /** Optional detail (error.message on failure, link method on push, etc.). */
  message?: string;
}

/** Discriminated union for every payload `/api/events` emits. */
export type SseEvent =
  | { type: "skill_changed"; name: string }
  | { type: "provider_changed"; provider_id: string; skill?: string }
  | { type: "activity"; entry: ActivityEntry };

// ── Phase 2: create / edit / rename payloads ───────────────────

/**
 * POST /api/skills body. `description` becomes the `description:`
 * field in the seeded SKILL.md frontmatter; empty when omitted.
 * Server validates `name` via services/skillName.ts:validateSkillName
 * (slug regex + IGNORE_NAMES + on-disk and manifest uniqueness).
 */
export interface CreateSkillRequest {
  name: string;
  description?: string;
}

/**
 * POST /api/skills/:name/rename body. Server validates new_name via
 * the same validateSkillName() helper used by CreateSkillRequest, then
 * fs.renameSync the folder and rewrites the manifest key (preserving
 * targets/stage/source and any unknown keys per the round-trip rule).
 */
export interface RenameSkillRequest {
  new_name: string;
}

/**
 * GET /api/skills/:name/files/* response. Binary files (any \0 byte
 * in the first 8 KB) and files larger than 1 MB return content=null
 * with the appropriate flag set; the client renders a notice instead
 * of the editor.
 */
export interface FileContent {
  binary: boolean;
  too_large: boolean;
  /** File size in bytes (always set; truthful even when binary/too_large). */
  size: number;
  /** SHA-256 of the bytes; null when binary OR too_large. Used as the optimistic-concurrency baseline. */
  sha256: string | null;
  /** UTF-8 file content; null when binary OR too_large. */
  content: string | null;
}

/**
 * PUT /api/skills/:name/files/* body. expected_sha256 must match the
 * server's freshly-rehashed file or the write is rejected with 409
 * `{ error: "file changed on disk — reload" }`. content is plain UTF-8
 * (binary writes are rejected with 400).
 */
export interface WriteFileRequest {
  content: string;
  expected_sha256: string;
}
