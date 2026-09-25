import type {
  ActivityEntry,
  ClaudeStatus,
  ConflictResolveBody,
  DiffLine,
  MergeResult,
  NotionConflict,
  NotionConflictItem,
  NotionDirection,
  NotionGuardStatus,
  NotionPlan,
  NotionPlanDiff,
  NotionRunJob,
  NotionLegacyDetail,
  NotionLegacyItem,
  SkillNameMismatch,
  AdoptScanResult,
  AppConfig,
  ApplyUpdatesResult,
  CreateSkillRequest,
  DeletedSkill,
  DesktopBackfillResult,
  DesktopPackageResult,
  FileContent,
  HistoryVersionSummary,
  NotionDataSourceCandidate,
  NotionLinkJob,
  NotionStatusResponse,
  Provider,
  PullResult,
  PushResult,
  RenameSkillRequest,
  Skill,
  SkillDetail,
  SkillDiff,
  SyncPlan,
  UpdateCheckResult,
  UpdateSkillRequest,
  WriteFileRequest,
} from "./types";

/**
 * Thin wrapper around fetch that:
 *  - defaults to JSON bodies
 *  - throws typed errors with the server's `error` field when non-2xx
 *  - returns `null` for 204s
 *
 * Callers wrap these in TanStack Query hooks (see queries.ts) so the
 * UI layer never touches fetch directly.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public raw: unknown,
  ) {
    super(message);
  }
}

/**
 * Encode a relative file path for use in /files/<relpath> URLs.
 * Each segment is encoded INDEPENDENTLY so legal '/' separators are
 * preserved while filename oddities (spaces, unicode, etc.) are
 * percent-escaped. Server-side resolveSkillFilePath() rejects any
 * "../" attempt, so this helper does no path validation of its own.
 */
function encodeFilePath(relpath: string): string {
  return relpath
    .split("/")
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join("/");
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  if (res.status === 204) return null as T;

  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (!res.ok) {
    const d = data as { error?: string; message?: string } | null;
    // "busy" is a code; its message is the readable text.
    const msg =
      ((d?.error === "busy" || d?.error === "in_use") && d.message) || (d?.error ?? `Request failed (${res.status})`);
    throw new ApiError(msg, res.status, data);
  }

  return data as T;
}

// ── config ──────────────────────────────────────────────────────

export const api = {
  getConfig: () => request<AppConfig>("GET", "/api/config"),
  updateConfig: (body: Partial<AppConfig>) =>
    request<AppConfig>("PUT", "/api/config", body),
  setVaultPath: (path: string) =>
    request<AppConfig>("PUT", "/api/config/vault-path", { path }),
  upsertProvider: (provider: Provider) =>
    request<AppConfig>("POST", "/api/config/providers", provider),
  removeProvider: (id: string) =>
    request<AppConfig>("DELETE", `/api/config/providers/${encodeURIComponent(id)}`),
  searchSkills: (q: string) =>
    request<{ matches: { name: string; snippet: string }[] }>(
      "GET", `/api/skills/search?q=${encodeURIComponent(q)}`,
    ),
  checkProviders: () =>
    request<{
      checks: Record<
        string,
        {
          status: "ok" | "missing" | "not_dir" | "readonly" | "denied" | "unreachable";
          message?: string;
        }
      >;
    }>("GET", "/api/config/providers/check"),

  // ── skills ────────────────────────────────────────────────────
  listSkills: (params: { q?: string; target?: string; source?: string } = {}) => {
    const usp = new URLSearchParams();
    if (params.q) usp.set("q", params.q);
    if (params.target) usp.set("target", params.target);
    if (params.source) usp.set("source", params.source);
    const qs = usp.toString();
    return request<{ skills: Skill[]; total: number }>(
      "GET",
      `/api/skills${qs ? `?${qs}` : ""}`,
    );
  },
  getSkill: (name: string) =>
    request<SkillDetail>("GET", `/api/skills/${encodeURIComponent(name)}`),
  createSkill: (body: CreateSkillRequest) =>
    request<SkillDetail>("POST", "/api/skills", body),
  renameSkill: (name: string, body: RenameSkillRequest) =>
    request<SkillDetail>(
      "POST",
      `/api/skills/${encodeURIComponent(name)}/rename`,
      body,
    ),
  updateSkill: (name: string, body: UpdateSkillRequest) =>
    request<SkillDetail>("PATCH", `/api/skills/${encodeURIComponent(name)}`, body),
  removeSkill: (name: string) =>
    request<null>("DELETE", `/api/skills/${encodeURIComponent(name)}`),

  // ── skill files ───────────────────────────────────────────────
  getFile: (skill: string, relpath: string) =>
    request<FileContent>(
      "GET",
      `/api/skills/${encodeURIComponent(skill)}/files/${encodeFilePath(relpath)}`,
    ),
  writeFile: (skill: string, relpath: string, body: WriteFileRequest) =>
    request<{ sha256: string; size: number }>(
      "PUT",
      `/api/skills/${encodeURIComponent(skill)}/files/${encodeFilePath(relpath)}`,
      body,
    ),

  // ── adopt ─────────────────────────────────────────────────────
  scanForAdopt: (path: string, recursive = false) =>
    request<{ source: string; results: AdoptScanResult[]; recursive: boolean; truncated: boolean }>(
      "POST",
      "/api/adopt/scan",
      { path, recursive },
    ),
  importAdopt: (body: {
    source_path: string;
    items?: { name: string; path: string }[];
    skills?: string[];
    paths?: Record<string, string>;
    provider_id?: string;
    /** Allow replacing in-vault skills — only sent for "update available" rows. */
    overwrite?: boolean;
    /** Source description recorded as each imported skill's `origin`. */
    origin_context?: {
      type: "git" | "dir" | "provider";
      url?: string;
      ref?: string;
      root: string;
      provider_id?: string;
    };
  }) =>
    request<{ imported: string[]; updated: string[]; skipped: string[] }>(
      "POST",
      "/api/adopt/import",
      body,
    ),
  checkUpdates: (skills?: string[]) =>
    request<{ results: UpdateCheckResult[] }>(
      "POST",
      "/api/adopt/check-updates",
      { skills },
    ),
  applyUpdates: (items: { name: string; upstream_path?: string; tmp_path?: string }[]) =>
    request<ApplyUpdatesResult>("POST", "/api/adopt/update", { items }),
  adoptClone: (body: { url: string; branch?: string }) =>
    request<{ tmp_path: string; results: AdoptScanResult[]; truncated?: boolean }>(
      "POST",
      "/api/adopt/clone",
      body,
    ),
  adoptCleanup: (body: { tmp_path: string }) =>
    request<{ ok: boolean }>(
      "POST",
      "/api/adopt/cleanup",
      body,
    ),
  adoptBrowse: (path?: string) =>
    request<{
      path: string;
      parent: string | null;
      dirs: { name: string; path: string }[];
    }>("POST", "/api/adopt/browse", { path }),

  // ── push ──────────────────────────────────────────────────────
  push: (body: { skill: string; provider_id: string; method: string }) =>
    request<PushResult>("POST", "/api/push", body),

  // ── pull ──────────────────────────────────────────────────────
  pull: (body: { skill: string; provider_id: string }) =>
    request<PullResult>("POST", "/api/pull", body),

  // ── sync ──────────────────────────────────────────────────────
  syncPlan: () => request<SyncPlan>("GET", "/api/sync/plan?include_pulls=true"),

  // ── diff ──────────────────────────────────────────────────────
  diff: (skill: string, provider_id: string) =>
    request<SkillDiff>(
      "GET",
      `/api/diff?skill=${encodeURIComponent(skill)}&provider_id=${encodeURIComponent(provider_id)}`,
    ),

  // ── devices ─────────────────────────────────────────────────
  listDevices: () =>
    request<{ devices: Array<{ machine_id: string; skill_count: number; timestamp: string; is_current: boolean }>; current_machine: string }>(
      "GET", "/api/devices",
    ),
  saveSnapshot: () =>
    request<{ machine_id: string; timestamp: string; skill_count: number }>(
      "POST", "/api/devices/snapshot",
    ),
  compareDevice: (name: string) =>
    request<{ comparisons: Array<{ skill: string; local_stage: string | null; remote_stage: string | null; local_hash: string | null; remote_hash: string | null; status: string }> }>(
      "GET", `/api/devices/${encodeURIComponent(name)}/compare`,
    ),
  syncFromDevice: (name: string, decisions: Array<{ skill: string; action: string }>) =>
    request<{ applied: string[]; skipped: string[] }>(
      "POST", `/api/devices/${encodeURIComponent(name)}/sync`, { decisions },
    ),
  deleteDevice: (name: string) =>
    request<null>("DELETE", `/api/devices/${encodeURIComponent(name)}`),

  // ── discover ───────────────────────────────────────────────────
  discover: () =>
    request<{ results: Array<{ provider_id: string; skills: Array<{ name: string; path: string; file_count: number; has_skill_md: boolean; provider_id: string; status: string }> }> }>(
      "POST", "/api/adopt/discover",
    ),

  // ── import ─────────────────────────────────────────────────────
  importScan: (path: string) =>
    request<{ source: string; results: Array<{ name: string; stage: string; targets: string[]; conflict: boolean }> }>(
      "POST", "/api/import/scan", { path },
    ),
  importMerge: (path: string, skills: string[]) =>
    request<{ imported: string[]; skipped: string[] }>(
      "POST", "/api/import/merge", { path, skills },
    ),

  // ── add existing ───────────────────────────────────────────────
  addExistingSkill: (body: { path: string; name?: string; targets?: string[] }) =>
    request<SkillDetail>("POST", "/api/skills/add", body),

  // ── tags ────────────────────────────────────────────────────
  listTags: () => request<{ tags: string[] }>("GET", "/api/tags"),
  bulkTag: (body: { skills: string[]; add?: string[]; remove?: string[]; prune_known?: boolean }) =>
    request<{ ok: boolean; updated: number }>("POST", "/api/tags/bulk", body),
  createTag: (tag: string) =>
    request<{ ok: boolean; tag: string }>("POST", "/api/tags", { tag }),
  aiTagStatus: (refresh = false) =>
    request<{ available: boolean; version?: string; reason?: string; model: string }>(
      "GET", `/api/tags/ai-status${refresh ? "?refresh=1" : ""}`,
    ),
  suggestTagsAI: (skills: string[], signal?: AbortSignal) =>
    request<{
      results: Record<
        string,
        {
          tags: string[];
          reason: string;
          new_tags: string[];
          remove: string[];
          remove_reasons: Record<string, string>;
        }
      >;
      failed: { names: string[]; error: string }[];
    }>("POST", "/api/tags/suggest", { skills }, signal),
  zipSkills: (skills: string[]) =>
    request<{ zips: Array<{ skill: string; path: string }>; failed: Array<{ skill: string; error: string }> }>(
      "POST", "/api/skills/zip", { skills },
    ),

  // ── activity ──────────────────────────────────────────────────
  getActivity: () => request<{ entries: ActivityEntry[] }>("GET", "/api/activity"),

  // ── fix / audit ──────────────────────────────────────────────
  runAudit: () =>
    request<{ issues: Array<{ id: string; kind: string; target: string; description: string; fixes: Array<{ label: string; action: string }> }> }>(
      "POST", "/api/fix/audit",
    ),
  repairIssue: (body: { kind: string; target: string; action: string }) =>
    request<{ ok: boolean }>("POST", "/api/fix/repair", body),

  // ── package / export ──────────────────────────────────────────
  packageSkill: (name: string, body: { output_dir: string }) =>
    request<{ output_path: string }>(
      "POST", `/api/skills/${encodeURIComponent(name)}/package`, body,
    ),

  // ── tag manager (Settings) ────────────────────────────────────
  // Appended at the bottom to minimize merge conflicts with parallel
  // edits higher up in the file. Functionally a peer of listTags/bulkTag.
  listTagsWithCounts: () =>
    request<{ tags: { tag: string; count: number }[] }>(
      "GET", "/api/tags?withCounts=1",
    ),
  renameTag: (body: { from: string; to: string }) =>
    request<{ ok: boolean; updated: number }>(
      "POST", "/api/tags/rename", body,
    ),

  // ── claude desktop (package target) ────────────────────────
  // Claude Desktop has no local skills directory — "pushing" builds an
  // upload-ready zip in a staging folder (see routes/desktop.ts).
  packageForDesktop: (skill: string) =>
    request<DesktopPackageResult>("POST", "/api/desktop", { skill }),
  revealDesktopStage: () =>
    request<{ ok: boolean; stage_dir: string }>("POST", "/api/desktop/reveal"),
  setDesktopStage: (path: string) =>
    request<AppConfig>("PUT", "/api/desktop/stage", { path }),
  // Seed desktop_package records from zips built before tracking existed
  // (stage dir + provider dirs). Safe to re-run: existing records are
  // never overwritten.
  desktopBackfill: () =>
    request<DesktopBackfillResult>("POST", "/api/desktop/backfill"),

  // ── openclaw (export target) ───────────────────────────────
  // OpenClaw runs in an isolated WSL distro with no filesystem bridge, so
  // it is NOT a provider — export shells to `openclaw skills install`
  // inside the distro (see routes/openclaw.ts). win32-only; status.available
  // is false elsewhere and the UI hides the action.
  openclawStatus: () =>
    request<{ available: boolean; distro?: string; installed?: number }>(
      "GET", "/api/openclaw/status",
    ),
  exportToOpenClaw: (
    skill: string,
    opts: { global?: boolean; force?: boolean } = {},
  ) =>
    request<{ ok: boolean; skill: string; output: string }>(
      "POST", "/api/openclaw/export", { skill, ...opts },
    ),

  // ── history (Phase 1, Task 5/6) ────────────────────────────────
  listHistory: (name: string) =>
    request<{ versions: HistoryVersionSummary[] }>("GET", `/api/history/${encodeURIComponent(name)}`),
  historyDiff: (name: string, id: string, against = "current") =>
    request<SkillDiff>(
      "GET",
      `/api/history/${encodeURIComponent(name)}/${encodeURIComponent(id)}/diff?against=${encodeURIComponent(against)}`,
    ),
  restoreVersion: (name: string, id: string) =>
    request<{ version: HistoryVersionSummary }>(
      "POST",
      `/api/history/${encodeURIComponent(name)}/${encodeURIComponent(id)}/restore`,
    ),
  listDeletedSkills: () => request<{ skills: DeletedSkill[] }>("GET", "/api/history/_deleted"),
  getHistoryConfig: () => request<{ max_versions: number }>("GET", "/api/history/_config"),
  setHistoryConfig: (max_versions: number) =>
    request<{ max_versions: number }>("PUT", "/api/history/_config", { max_versions }),

  // ── notion (Phase 2: connect + link) ────────────────────────────
  notionStatus: () => request<NotionStatusResponse>("GET", "/api/notion/status"),
  notionConnect: () =>
    request<{ status: "connected" } | { status: "redirect"; url: string }>(
      "POST", "/api/notion/connect",
    ),
  notionDisconnect: () => request<{ ok: boolean }>("POST", "/api/notion/disconnect"),
  notionDataSources: () =>
    request<{ data_sources: NotionDataSourceCandidate[] }>("GET", "/api/notion/data-sources"),
  notionSetDataSource: (body: { id: string; name: string; add_last_edited: boolean }) =>
    request<{ ok: boolean; last_edited_property: string | null; warning?: string }>(
      "POST", "/api/notion/data-source", body,
    ),
  notionCheck: () =>
    request<{ checked_at: string; rows: number }>("POST", "/api/notion/check"),
  notionStartLink: () => request<{ job_id: string }>("POST", "/api/notion/link"),
  notionLinkJob: (id: string) =>
    request<NotionLinkJob>("GET", `/api/notion/link/${encodeURIComponent(id)}`),
  notionSummary: () =>
    request<{
      notion_only_compatible: Array<{ page_id: string; title: string }>;
      notion_only_native: Array<{ page_id: string; title: string }>;
    }>("GET", "/api/notion/summary"),
  notionUnlink: (name: string) =>
    request<{ ok: boolean }>("POST", `/api/notion/skills/${encodeURIComponent(name)}/unlink`),
  /** Forget an "unlinked" link so the next Link run can match the skill again. */
  notionRelink: (name: string) =>
    request<{ ok: boolean }>("POST", `/api/notion/skills/${encodeURIComponent(name)}/relink`),
  notionVaultOnly: (name: string) =>
    request<{ ok: boolean }>("POST", `/api/notion/skills/${encodeURIComponent(name)}/vault-only`),

  // ── notion conflicts + Claude merge (Phase 4) ───────────────────
  notionConflicts: () =>
    request<{ skills: NotionConflictItem[] }>("GET", "/api/notion/conflicts"),
  notionConflict: (name: string) =>
    request<NotionConflict>("GET", `/api/notion/conflicts/${encodeURIComponent(name)}`),
  notionMerge: (name: string, expected_notion_version: string) =>
    request<MergeResult>("POST", `/api/notion/conflicts/${encodeURIComponent(name)}/merge`, {
      expected_notion_version,
    }),
  notionResolve: (name: string, body: ConflictResolveBody) =>
    request<{ ok: true; status: string | null }>(
      "POST", `/api/notion/conflicts/${encodeURIComponent(name)}/resolve`, body,
    ),
  claudeStatus: () => request<ClaudeStatus>("GET", "/api/claude/status"),

  // ── notion push/pull review, run, force (Phase 3) ───────────────
  notionPlan: (direction: NotionDirection) =>
    request<NotionPlan>("GET", `/api/notion/plan?direction=${direction}`),
  notionPlanDiff: (direction: NotionDirection, row: string) =>
    request<NotionPlanDiff>(
      "GET", `/api/notion/plan/diff?direction=${direction}&row=${encodeURIComponent(row)}`,
    ),
  notionRun: (body: {
    direction: NotionDirection;
    rows: Array<{ id: string; action?: string }>;
    override_guard?: boolean;
  }) => request<{ job_id: string }>("POST", "/api/notion/run", body),
  notionForce: (body: { direction: NotionDirection; skills?: string[]; override_guard?: boolean }) =>
    request<{ job_id: string }>("POST", "/api/notion/force", body),
  /** Non-force push of the selected skills (a Notion edit is never overwritten). */
  notionPushSelected: (body: { skills: string[]; override_guard?: boolean }) =>
    request<{ job_id: string }>("POST", "/api/notion/push-selected", body),
  notionRunJob: (id: string) =>
    request<NotionRunJob>("GET", `/api/notion/run/${encodeURIComponent(id)}`),

  // ── legacy summary pages → full skills ──────────────────────────
  notionLegacy: () => request<{ skills: NotionLegacyItem[] }>("GET", "/api/notion/legacy"),
  notionLegacyDetail: (name: string) =>
    request<NotionLegacyDetail>("GET", `/api/notion/legacy/${encodeURIComponent(name)}`),
  /** Replace each skill's legacy summary page with the full skill (job; progress via notionRunJob). */
  notionUpgradeLegacy: (body: { skills: string[]; override_guard?: boolean }) =>
    request<{ job_id: string }>("POST", "/api/notion/legacy/upgrade", body),

  // ── name agreement (folder == SKILL.md name) ────────────────────
  skillNameMismatches: () =>
    request<{ skills: SkillNameMismatch[] }>("GET", "/api/skills/name-mismatches"),
  fixSkillName: (folder: string, use: "name" | "folder") =>
    request<{ name: string; providers: Array<{ provider_id: string; outcome: string; message: string }> }>(
      "POST", `/api/skills/${encodeURIComponent(folder)}/fix-name`, { use },
    ),
  notionGuard: () => request<NotionGuardStatus>("GET", "/api/notion/guard"),
  diffText: (a: string, b: string) =>
    request<{ hunks: DiffLine[] | null; reason?: string }>("POST", "/api/diff/text", { a, b }),
};
