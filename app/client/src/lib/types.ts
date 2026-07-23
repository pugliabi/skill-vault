/**
 * Client-side re-export of the server's vault types.
 *
 * We copy-paste the interfaces here rather than importing from
 * `@server/types/vault` because Vite bundles the client separately
 * from the server — pulling a server-path import would drag fs/path
 * into the browser bundle. Keeping the two in sync is an editor
 * exercise; both sides conform to `docs/vault-format.md`.
 */

/**
 * Structured provenance recorded at adopt/import time so a skill can later
 * be checked and updated from its original source (mirrors
 * server/types/vault.ts SkillOrigin).
 */
export interface SkillOrigin {
  type: "git" | "dir" | "provider";
  url?: string;
  path?: string;
  provider_id?: string;
  subpath: string;
  ref?: string;
  adopted_at: string;
  content_hash: string;
}

export type TargetStatus = "synced" | "stale" | "missing" | "error";
export type SkillStatus =
  | "synced"
  | "stale"
  | "vault-only"
  | "staging"
  | "missing";

export interface Skill {
  name: string;
  targets: string[];
  tags: string[];
  stage: "staging" | "production";
  source: string;
  file_count: number;
  has_skill_md: boolean;
  description: string;
  modified_at: string;
  /** ISO timestamp of folder birthtime (falls back to mtime on filesystems
   * that don't track creation time). Server-derived. */
  created_at: string;
  /** Per-target sync state, keyed by provider id. */
  target_status: Record<string, TargetStatus>;
  /** Aggregate status — server-derived. */
  status: SkillStatus;
  /** Structured provenance when the skill was adopted from a trackable source. */
  origin?: SkillOrigin;
}

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

export interface Provider {
  /** Slug matching the key in the CLI's `agent_locations` map. */
  id: string;
  /** Absolute path to the provider's skills directory. */
  path: string;
}

export interface AppConfig {
  vault_path: string | null;
  providers: Provider[];
  /** Read-only mirror of the CLI config's `default_targets`, if set. */
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
}

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
  /** Client-only: distinct content versions sharing this name when grouped. */
  variant_count?: number;
  file_count: number;
  has_skill_md: boolean;
  /** First line of the SKILL.md description, if any. Empty when absent. */
  description?: string;
  already_in_vault: boolean;
  /**
   * Only meaningful when `already_in_vault` — true when the incoming copy's
   * content differs from the vault copy (re-adopting would change it).
   */
  update_available?: boolean;
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

export interface UpdateCheckResult {
  name: string;
  status: UpdateStatus;
  origin?: SkillOrigin;
  vault_hash?: string;
  upstream_hash?: string;
  recorded_hash?: string;
  /** Absolute dir holding the upstream copy (local dir or inside a temp clone). */
  upstream_path?: string;
  /** Set when a temp clone was made; echo to /update and /cleanup. */
  tmp_path?: string;
  git_pulled?: boolean;
  message?: string;
}

export interface ApplyUpdatesResult {
  updated: string[];
  skipped: { name: string; reason: string }[];
}

export type LinkMethod = "symlink" | "junction" | "copy" | "auto";

export interface PushResult {
  skill: string;
  target_path: string;
  method: "symlink" | "junction" | "copy";
}

export interface UpdateSkillRequest {
  stage?: "production" | "staging";
  targets?: string[];
  source?: string;
  tags?: string[];
}

export interface PullResult {
  skill: string;
  source_path: string;
  vault_path: string;
  action: "copied" | "no-op";
}

export interface SyncPlan {
  push: Array<{ skill: string; provider_id: string; reason: "stale" | "missing" }>;
  pull: Array<{ skill: string; provider_id: string; reason: string }>;
  adopt: Array<{ name: string; provider_id: string; file_count: number }>;
  promote: Array<{ name: string; modified_at: string }>;
  /**
   * Claude Desktop re-packaging — production skills whose upload-ready zip
   * went stale since it was built. Opt-in: only skills already packaged
   * once appear here (claude-desktop is a package target, not a link
   * target). Run an item to rebuild the zip in the stage dir.
   */
  package: Array<{ skill: string; reason: "stale"; zip_path: string }>;
}

export type DiffLine =
  | { type: "ctx"; text: string }
  | { type: "add"; text: string }
  | { type: "del"; text: string };

export interface FileDiff {
  path: string;
  change: "added" | "removed" | "modified" | "same";
  reason?: "binary" | "too-large";
  vault_size?: number;
  target_size?: number;
  hunks?: DiffLine[];
}

export interface SkillDiff {
  files: FileDiff[];
  summary: { added: number; removed: number; modified: number; same: number };
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
  | "rename";

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
