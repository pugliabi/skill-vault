/**
 * Vault MCP bridge — the assistant's hands.
 *
 * A stdio MCP server launched per chat turn by the in-app assistant (via
 * `--mcp-config`) and by Claude Desktop, Claude Code and the shared
 * `skill-vault` command (see `main.ts`). Every tool is a thin wrapper over the app's own HTTP
 * API on localhost (`SKILL_VAULT_URL`), so agent actions flow through the
 * exact same routes, validation, activity log, SSE broadcast, and Notion
 * job guard as clicks in the UI. The bridge holds NO vault logic of its
 * own — if a capability is missing here, add an HTTP endpoint first.
 *
 * Deliberately excluded (v1): skill deletion, Notion force push/pull,
 * OAuth connect/disconnect. The agents are instructed to hand those back
 * to the user.
 *
 * Tool handlers are pure functions of (args, http) so tests inject a fake
 * `BridgeHttp` and assert the URL/method/body per tool — no server, no
 * MCP transport involved.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { IGNORE_NAMES } from "../services/skillHash.ts";

/** Minimal HTTP seam: method + path (+ optional JSON body) → status + parsed JSON. */
export type BridgeHttp = (
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
) => Promise<{ status: number; json: unknown }>;

/** `client` is sent as X-Skill-Vault-Client (server/services/agentActivity.ts). */
export function createHttp(baseUrl: string, fetchFn: typeof fetch = fetch, client?: string): BridgeHttp {
  const base = baseUrl.replace(/\/+$/, "");
  return async (method, path, body) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (client) headers["x-skill-vault-client"] = client;
    const res = await fetchFn(`${base}${path}`, {
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* empty/non-JSON body */
    }
    return { status: res.status, json };
  };
}

/** Raised by handlers for readable failures; surfaced as an MCP tool error. */
export class BridgeToolError extends Error {}

/**
 * Throw a readable error for a non-2xx response. 409s pass the server's
 * message through verbatim — "a Notion job is already running" or the
 * vault-behind guard are states the model should explain or wait out, not
 * retry blindly.
 */
function expectOk(r: { status: number; json: unknown }, what: string): unknown {
  if (r.status >= 200 && r.status < 300) return r.json;
  const detail =
    r.json && typeof r.json === "object" && typeof (r.json as { error?: unknown }).error === "string"
      ? (r.json as { error: string }).error
      : `HTTP ${r.status}`;
  if (r.status === 401) {
    throw new BridgeToolError(`${what}: Notion is not connected (${detail}). Ask the user to connect Notion in Settings.`);
  }
  throw new BridgeToolError(`${what} failed (${r.status}): ${detail}`);
}

const POLL_INTERVAL_MS = 1_000;
const POLL_CAP_MS = 10 * 60_000;

/** Poll a Notion sync job to completion; from the model's view the tool is synchronous. */
async function pollNotionJob(
  http: BridgeHttp,
  jobId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<unknown> {
  const deadline = Date.now() + POLL_CAP_MS;
  for (;;) {
    const r = await http("GET", `/api/notion/run/${encodeURIComponent(jobId)}`);
    const job = expectOk(r, "notion job poll") as { running?: boolean; results?: unknown; error?: string; done?: number; total?: number };
    if (!job.running) return { results: job.results ?? [], ...(job.error ? { error: job.error } : {}) };
    if (Date.now() > deadline) {
      throw new BridgeToolError(`notion job ${jobId} still running after ${POLL_CAP_MS / 60000} minutes (${job.done}/${job.total})`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

interface TrimmedSkill {
  name: string;
  status?: string;
  stage?: string;
  targets?: string[];
  tags?: string[];
  description?: string;
  origin?: unknown;
  notion_status?: unknown;
}

function trimSkill(s: Record<string, unknown>): TrimmedSkill {
  const desc = typeof s.description === "string" ? s.description : "";
  return {
    name: String(s.name ?? ""),
    status: typeof s.status === "string" ? s.status : undefined,
    stage: typeof s.stage === "string" ? s.stage : undefined,
    targets: Array.isArray(s.targets) ? (s.targets as string[]) : undefined,
    tags: Array.isArray(s.tags) && s.tags.length > 0 ? (s.tags as string[]) : undefined,
    description: desc ? (desc.length > 140 ? `${desc.slice(0, 139)}…` : desc) : undefined,
    origin: s.origin,
    notion_status: s.notion_status,
  };
}

/** read_skill_files stops adding files once their sizes pass this total. */
export const READ_BUDGET_BYTES = 256 * 1024;

interface TreeNode {
  path: string;
  type: "file" | "dir";
  size?: number;
  children?: TreeNode[];
}

function treeFiles(node: TreeNode): Array<{ path: string; size: number }> {
  if (node.type === "file") return [{ path: node.path.replace(/\\/g, "/"), size: node.size ?? 0 }];
  return (node.children ?? []).flatMap(treeFiles);
}

interface FileRead {
  binary: boolean;
  too_large: boolean;
  size: number;
  sha256: string | null;
  content: string | null;
}

/** SKILL.md first, then the rest by path; binaries and files past the budget are listed in `skipped`. */
async function readSkillFiles(http: BridgeHttp, name: string, only?: string[]): Promise<unknown> {
  const enc = encodeURIComponent(name);
  let wanted: Array<{ path: string; size: number }>;
  if (only && only.length > 0) {
    wanted = only.map((p) => ({ path: p.replace(/\\/g, "/"), size: 0 }));
  } else {
    const detail = expectOk(await http("GET", `/api/skills/${enc}`), "read_skill_files") as { files?: TreeNode };
    // Ignored folders (.git, node_modules...) are listed by the tree but save_skill refuses their paths.
    wanted = (detail.files ? treeFiles(detail.files) : []).filter((w) => !w.path.split("/").some((seg) => IGNORE_NAMES.has(seg)));
    wanted.sort((a, b) => (a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path)));
  }
  const files: Array<{ path: string; content: string; sha256: string | null; size: number }> = [];
  const skipped: Array<{ path: string; reason: "binary" | "too_large" | "over_budget" }> = [];
  let total = 0;
  for (const w of wanted) {
    if (files.length > 0 && total + w.size > READ_BUDGET_BYTES) {
      skipped.push({ path: w.path, reason: "over_budget" });
      continue;
    }
    const urlPath = w.path.split("/").map(encodeURIComponent).join("/");
    const f = expectOk(await http("GET", `/api/skills/${enc}/files/${urlPath}`), `read_skill_files ${w.path}`) as FileRead;
    if (f.binary) {
      skipped.push({ path: w.path, reason: "binary" });
      continue;
    }
    if (f.too_large || f.content === null) {
      skipped.push({ path: w.path, reason: "too_large" });
      continue;
    }
    if (files.length > 0 && total + f.size > READ_BUDGET_BYTES) {
      skipped.push({ path: w.path, reason: "over_budget" });
      continue;
    }
    total += f.size;
    files.push({ path: w.path, content: f.content, sha256: f.sha256, size: f.size });
  }
  return { files, skipped };
}

export interface ToolDef {
  description: string;
  /** Zod raw shape — becomes the MCP input schema. */
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, http: BridgeHttp, sleep: (ms: number) => Promise<void>) => Promise<unknown>;
}

const originShape = {
  type: z.enum(["git", "dir", "provider"]).describe("git = remote repo URL; dir = local directory; provider = a provider's skills dir"),
  url: z.string().optional().describe("Remote URL (git origins)"),
  path: z.string().optional().describe("Absolute local source-root path (dir/provider origins)"),
  provider_id: z.string().optional(),
  subpath: z.string().optional().describe('Skill folder relative to the source root, "/"-separated. "" = the root itself.'),
  ref: z.string().optional().describe("Git branch (optional)"),
};

export const TOOLS: Record<string, ToolDef> = {
  // ── Read-only ──────────────────────────────────────────────────────────
  list_skills: {
    description:
      "List every skill in the vault with status, stage, targets, tags, origin, and Notion state. Start here for any bulk task.",
    schema: {
      status: z.string().optional().describe("Filter by sync status (e.g. synced, stale, vault-only)"),
      target: z.string().optional().describe("Filter to skills pushed to this provider id"),
    },
    handler: async (args, http) => {
      const q = args.target ? `?target=${encodeURIComponent(String(args.target))}` : "";
      const data = expectOk(await http("GET", `/api/skills${q}`), "list_skills") as { skills?: Record<string, unknown>[] };
      let skills = (data.skills ?? []).map(trimSkill);
      if (args.status) skills = skills.filter((s) => s.status === args.status);
      return { total: skills.length, skills };
    },
  },
  get_skill: {
    description: "Full detail for one skill: manifest entry, origin, file tree, per-target status, Notion link.",
    schema: { name: z.string() },
    handler: async (args, http) =>
      expectOk(await http("GET", `/api/skills/${encodeURIComponent(String(args.name))}`), "get_skill"),
  },
  search_skills: {
    description: "Full-text search across SKILL.md bodies. Returns matching skill names with snippets.",
    schema: { query: z.string() },
    handler: async (args, http) =>
      expectOk(await http("GET", `/api/skills/search?q=${encodeURIComponent(String(args.query))}`), "search_skills"),
  },
  check_updates: {
    description:
      "Re-check skills against their recorded origins (three-way hash). Statuses: up_to_date, update_available, local_changed, conflict, upstream_missing (source moved/deleted — repair with set_origin), source_missing, no_origin, error. Results carry upstream_path/tmp_path for apply_update.",
    schema: { skills: z.array(z.string()).optional().describe("Omit to check every skill that has an origin") },
    handler: async (args, http) =>
      expectOk(await http("POST", "/api/adopt/check-updates", { skills: args.skills }), "check_updates"),
  },
  recent_activity: {
    description: "Recent operations (push/pull/adopt/update/notion) with ok/error outcomes — the place to diagnose 'what just failed'.",
    schema: {
      only_errors: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional().describe("Most recent N entries (default 50)"),
    },
    handler: async (args, http) => {
      const data = expectOk(await http("GET", "/api/activity"), "recent_activity") as { entries?: { ok: boolean }[] };
      let entries = data.entries ?? [];
      if (args.only_errors) entries = entries.filter((e) => !e.ok);
      const limit = typeof args.limit === "number" ? args.limit : 50;
      return { entries: entries.slice(-limit) };
    },
  },
  audit_vault: {
    description: "Audit the vault for structural issues: orphan folders, dangling manifest entries, broken provider links.",
    schema: {},
    handler: async (_args, http) => expectOk(await http("POST", "/api/fix/audit"), "audit_vault"),
  },
  notion_status: {
    description: "Notion connection state plus per-skill sync summary (in-sync / changed / conflicts / unlinked counts).",
    schema: {},
    handler: async (_args, http) => {
      const status = expectOk(await http("GET", "/api/notion/status"), "notion_status");
      let summary: unknown = null;
      try {
        summary = expectOk(await http("GET", "/api/notion/summary"), "notion summary");
      } catch {
        /* summary needs a connection; status alone still answers "connected?" */
      }
      return { status, summary };
    },
  },
  notion_plan: {
    description: "Preview what a Notion push or pull would do per skill, without doing it.",
    schema: { direction: z.enum(["push", "pull"]) },
    handler: async (args, http) =>
      expectOk(await http("GET", `/api/notion/plan?direction=${args.direction}`), "notion_plan"),
  },
  scan_dir_for_skills: {
    description: "Scan a local directory (e.g. a fresh git clone) for adoptable skill folders.",
    schema: { path: z.string(), recursive: z.boolean().optional() },
    handler: async (args, http) =>
      expectOk(await http("POST", "/api/adopt/scan", { path: args.path, recursive: args.recursive ?? true }), "scan_dir_for_skills"),
  },
  get_config: {
    description: "App config: vault path, configured providers, default targets.",
    schema: {},
    handler: async (_args, http) => expectOk(await http("GET", "/api/config"), "get_config"),
  },
  get_suggestions: {
    description:
      "The app's ranked proactive suggestions — what's broken or needs attention right now (broken sources, available updates, failed operations, Notion drift, hygiene). The best starting point for 'what needs attention' or any triage request.",
    schema: {},
    handler: async (_args, http) => expectOk(await http("GET", "/api/assistant/suggestions"), "get_suggestions"),
  },
  read_skill_files: {
    description:
      "Read a vault skill's text files, SKILL.md first, with each file's sha256. Use it to follow a vault skill in this chat, and before save_skill mode:update. Files past the ~256 KB total come back in `skipped` as over_budget; ask for them by `paths`.",
    schema: {
      name: z.string(),
      paths: z.array(z.string()).optional().describe('Only these files: relative, "/"-separated paths'),
    },
    handler: async (args, http) =>
      readSkillFiles(http, String(args.name), Array.isArray(args.paths) ? (args.paths as string[]) : undefined),
  },

  // ── Mutating ───────────────────────────────────────────────────────────
  apply_update: {
    description:
      "Overwrite vault skills with their upstream content (from a prior check_updates). Echo each result's upstream_path/tmp_path. Refreshes origin stamps; prior state stays restorable from version history.",
    schema: {
      items: z.array(
        z.object({ name: z.string(), upstream_path: z.string().optional(), tmp_path: z.string().optional() }),
      ).min(1),
    },
    handler: async (args, http) => expectOk(await http("POST", "/api/adopt/update", { items: args.items }), "apply_update"),
  },
  set_origin: {
    description:
      "Rewrite a skill's update-from-source origin — THE fix for upstream_missing/source_missing after locating where the source moved. adopted_at/content_hash are stamped server-side. verify:true re-checks immediately and returns the fresh status. Pass clear:true (no origin) ONLY when the user confirmed the source is dead with no successor — the skill keeps working but stops update-checking.",
    schema: {
      name: z.string(),
      origin: z.object(originShape).optional(),
      verify: z.boolean().optional().describe("Recommended: confirm the repair in the same call"),
      clear: z.boolean().optional().describe("Remove the origin entirely (user-confirmed dead source). Mutually exclusive with origin."),
    },
    handler: async (args, http) => {
      if (args.clear === true) {
        return expectOk(
          await http("PATCH", `/api/skills/${encodeURIComponent(String(args.name))}/origin`, { origin: null }),
          "set_origin(clear)",
        );
      }
      if (!args.origin) throw new BridgeToolError("set_origin: provide origin, or clear:true to remove it");
      return expectOk(
        await http("PATCH", `/api/skills/${encodeURIComponent(String(args.name))}/origin`, {
          origin: args.origin,
          verify: args.verify ?? true,
        }),
        "set_origin",
      );
    },
  },
  adopt_skills: {
    description:
      "Copy skills from a scanned directory into the vault (records origin for future updates). Use overwrite:true only for intentional re-adopts.",
    schema: {
      source_path: z.string().describe("The scan root"),
      items: z.array(z.object({ name: z.string(), path: z.string() })).min(1),
      overwrite: z.boolean().optional(),
      origin_context: z
        .object({
          type: z.enum(["git", "dir", "provider"]),
          root: z.string(),
          url: z.string().optional(),
          ref: z.string().optional(),
          provider_id: z.string().optional(),
        })
        .optional()
        .describe("Where the import came from, recorded as each skill's origin"),
    },
    handler: async (args, http) =>
      expectOk(
        await http("POST", "/api/adopt/import", {
          source_path: args.source_path,
          items: args.items,
          overwrite: args.overwrite,
          origin_context: args.origin_context,
        }),
        "adopt_skills",
      ),
  },
  push_to_provider: {
    description: "Push (link or copy) a vault skill into a provider's skills directory (e.g. claude, cursor).",
    schema: {
      skill: z.string(),
      provider_id: z.string(),
      method: z.enum(["auto", "symlink", "junction", "copy"]).optional(),
    },
    handler: async (args, http) =>
      expectOk(
        await http("POST", "/api/push", { skill: args.skill, provider_id: args.provider_id, method: args.method ?? "auto" }),
        "push_to_provider",
      ),
  },
  pull_from_provider: {
    description: "Pull a provider's copy of a skill back into the vault (no-op when the provider holds a live link).",
    schema: { skill: z.string(), provider_id: z.string() },
    handler: async (args, http) =>
      expectOk(await http("POST", "/api/pull", { skill: args.skill, provider_id: args.provider_id }), "pull_from_provider"),
  },
  notion_push: {
    description:
      "Push selected skills to their Notion pages (full-folder upload via the Notion Skills API) and wait for the result. One Notion job runs at a time — a busy error means report it, not retry.",
    schema: { skills: z.array(z.string()).min(1) },
    handler: async (args, http, sleep) => {
      const start = expectOk(await http("POST", "/api/notion/push-selected", { skills: args.skills }), "notion_push") as {
        job_id?: string;
      };
      if (!start.job_id) throw new BridgeToolError("notion_push: server did not return a job_id");
      return pollNotionJob(http, start.job_id, sleep);
    },
  },
  notion_run: {
    description:
      "Execute reviewed Notion plan rows (from notion_plan) in a given direction and wait for per-row results.",
    schema: {
      direction: z.enum(["push", "pull"]),
      rows: z.array(z.object({ id: z.string(), action: z.string().optional() })).min(1),
    },
    handler: async (args, http, sleep) => {
      const start = expectOk(
        await http("POST", "/api/notion/run", { direction: args.direction, rows: args.rows }),
        "notion_run",
      ) as { job_id?: string };
      if (!start.job_id) throw new BridgeToolError("notion_run: server did not return a job_id");
      return pollNotionJob(http, start.job_id, sleep);
    },
  },
  fix_repair: {
    description:
      "Repair one audit_vault finding: orphan_folder (remove_folder | add_to_manifest), dangling_entry (remove_from_manifest), broken_link (remove_link | recreate_link).",
    schema: { kind: z.string(), target: z.string(), action: z.string() },
    handler: async (args, http) =>
      expectOk(await http("POST", "/api/fix/repair", { kind: args.kind, target: args.target, action: args.action }), "fix_repair"),
  },
  save_skill: {
    description:
      'Save a skill into the vault from file contents. mode "create" makes a new staging skill: SKILL.md is required and its frontmatter name must equal `name`. mode "update" changes an existing skill: first show the user the changes and get a yes, then pass expected_sha256 (from read_skill_files) for every existing file you change and none for new files; files you leave out stay as they are and nothing is deleted. A "files changed" error means re-read and confirm with the user again.',
    schema: {
      name: z.string(),
      mode: z.enum(["create", "update"]),
      files: z
        .array(z.object({ path: z.string(), content: z.string(), expected_sha256: z.string().optional() }))
        .min(1)
        .describe('Paths are relative and "/"-separated, e.g. SKILL.md or references/api.md'),
    },
    handler: async (args, http) => {
      const r = await http("POST", `/api/skills/${encodeURIComponent(String(args.name))}/save`, {
        mode: args.mode,
        files: args.files,
      });
      const conflicts = (r.json as { conflicts?: Array<{ path: string }> } | null)?.conflicts;
      if (r.status === 409 && Array.isArray(conflicts)) {
        throw new BridgeToolError(
          `save_skill: these files changed since they were read: ${conflicts.map((c) => c.path).join(", ")}. Re-read them with read_skill_files, show the user the new differences, and ask again.`,
        );
      }
      return expectOk(r, "save_skill");
    },
  },
  package_for_desktop: {
    description:
      "Build an upload-ready zip of a vault skill for Claude Desktop / claude.ai; the user uploads it in Settings → Capabilities → Skills. reveal:true also opens the folder holding the zip.",
    schema: { skill: z.string(), reveal: z.boolean().optional() },
    handler: async (args, http) => {
      const out = expectOk(await http("POST", "/api/desktop", { skill: args.skill }), "package_for_desktop");
      if (args.reveal) expectOk(await http("POST", "/api/desktop/reveal"), "package_for_desktop (reveal)");
      return out;
    },
  },
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wire every tool onto an McpServer. Results are JSON-serialized text content. */
export function registerTools(server: McpServer, http: BridgeHttp, sleep: (ms: number) => Promise<void> = realSleep): void {
  for (const [name, def] of Object.entries(TOOLS)) {
    server.tool(name, def.description, def.schema, async (args: Record<string, unknown>) => {
      try {
        const result = await def.handler(args ?? {}, http, sleep);
        return { content: [{ type: "text" as const, text: JSON.stringify(result ?? null) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text" as const, text: message }] };
      }
    });
  }
}
