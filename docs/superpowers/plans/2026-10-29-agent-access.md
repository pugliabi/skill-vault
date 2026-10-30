# Agent Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude Desktop, Claude Code and any agent with a shell work with the Skill Vault through the
existing vault MCP bridge, and ship a public `skill-vault` skill that tells them how.

**Architecture:** One bridge (`app/server/assistant-mcp/`) gains three tools, a command mode and its own
server discovery (app.lock + health, else start the app hidden via `launch.ps1 -Headless`). A new
Settings → Agent access card writes the Claude Desktop MCP entry, runs `claude mcp add` for Claude Code,
and adopts the bundled skill into the vault so normal targets carry it everywhere. The server counts
bridge calls as activity so a background-started app idles out 10 minutes after the last call.

**Tech Stack:** Node 20+ / TypeScript (tsx), Express 5, `@modelcontextprotocol/sdk`, zod 3,
`zod-to-json-schema`, React + TanStack Query, `node --test`, Windows PowerShell 5.1.

**Spec:** `docs/superpowers/specs/2026-10-29-agent-access-design.md`

## Global Constraints

- Work only in the worktree `<worktree>` (branch `feat/agent-access`, based on `main` `a25a664`). Other sessions use the main checkout.
- Do not modify: `app/client/src/components/Layout.tsx`, `app/client/src/components/AppUpdate.tsx`, `app/vite.config.ts`, `app/server/services/appUpdate.ts`, `app/server/routes/notion.ts`, `app/server/services/notion/connection.ts`.
- The repo is public: no machine names, personal paths, emails or Notion IDs in code, tests, docs or the skill.
- Bridge tools stay provider-agnostic (plain names, no client-specific behavior); other assistant providers share the table.
- MCP server name everywhere: `skill-vault`. Bundled skill name: `skill-vault`.
- Client header: `X-Skill-Vault-Client` with values `claude-desktop`, `claude-code`, `command`, `assistant` (default).
- Agent idle window: 10 minutes (`SKILL_VAULT_AGENT_IDLE_MS` overrides).
- Server start wait: 60 s, poll every 500 ms. Health probe timeout: 2 s.
- `save_skill`: text only, 1 MB per file, 5 MB per call; create → manifest `{ targets: [], stage: "staging", source: "saved from <client label>" }`.
- `read_skill_files`: ~256 KB total budget.
- New POST routes go behind `refuseCrossSiteWrites` (`app/server/routes/sameOrigin.ts`).
- CHANGELOG entries go under `## [Unreleased]` in `app/CHANGELOG.md` (combined 0.2.0 release).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- All commands run from `app/` unless a step says otherwise. Tests: `npm test` (`node --import tsx --test "server/**/*.test.ts"`); one file: `node --import tsx --test server/path/file.test.ts`.

## Before Task 1

- [ ] Install dependencies in the worktree (it has no `node_modules`):

```bash
cd <worktree>/app && npm ci
```

- [ ] Baseline: `npm test` passes (606 tests on `a25a664`) and `npm run typecheck` is clean.

## File Structure

| File | Responsibility |
|---|---|
| `app/server/services/agentActivity.ts` (new) | Client header name, client labels, "agent called recently" tracker + middleware |
| `app/server/services/saveSkill.ts` (new) | Validate and write a skill from file contents (create/update) |
| `app/server/routes/skills.ts` (modify) | `POST /:name/save` route |
| `app/server/assistant-mcp/bridge.ts` (modify) | Client header in `createHttp`; tools `read_skill_files`, `save_skill`, `package_for_desktop` |
| `app/server/assistant-mcp/server.ts` (new) | Find the server via app.lock + health, or start it headless; resolving fetch with one retry |
| `app/server/assistant-mcp/cli.ts` (new) | Bridge argument parsing, `tools` listing, command-mode runner, stdin reader |
| `app/server/assistant-mcp/main.ts` (modify) | Entry: MCP mode or command mode; picks direct URL or resolving fetch |
| `app/scripts/launch.ps1` (modify) | `-Headless` switch |
| `app/bundled-skills/skill-vault/SKILL.md` (new) | The public skill |
| `app/server/services/agentAccess/bundledSkill.ts` (new) | Bundled skill paths, SKILL.md reader, install prompt |
| `app/server/services/agentAccess/desktopConfig.ts` (new) | Desktop config path, pure merge/remove, entry state, read/write with backup |
| `app/server/services/agentAccess/claudeCode.ts` (new) | Claude Code entry status from `~/.claude.json`; `claude mcp add/remove` |
| `app/server/services/agentAccess/commandShim.ts` (new) | Write `~/.skill-vault/bin/skill-vault(.cmd)` |
| `app/server/services/desktopPackaging.ts` (modify) | Zip any folder; `recordDesktopPackage` moves here |
| `app/server/routes/desktop.ts` (modify) | Import `recordDesktopPackage` from the service |
| `app/server/routes/agentAccess.ts` (new) | `/api/agent-access` status + actions |
| `app/server/index.ts` (modify) | Save-path JSON limit, agent middleware, isBusy, shims at production start, router mount |
| `app/server/types/vault.ts` (modify) | `AgentAccessStatus` |
| `app/client/src/lib/types.ts`, `app/client/src/lib/api.ts` (modify) | Client types + API calls |
| `app/client/src/components/AgentAccessCard.tsx` (new) | The Settings card |
| `app/client/src/pages/Settings.tsx` (modify) | Place the card |
| `docs/features.md`, `docs/configuration.md`, `docs/faq.md`, `app/CHANGELOG.md` (modify) | Docs |

---

### Task 1: Agent client header and idle activity

**Files:**
- Create: `app/server/services/agentActivity.ts`
- Test: `app/server/services/agentActivity.test.ts`
- Modify: `app/server/index.ts` (imports; after `app.use(express.json(...))`; the `app.locals.isBusy` line)

**Interfaces:**
- Produces: `AGENT_CLIENT_HEADER = "x-skill-vault-client"`, `agentIdleMs(): number`, `clientLabel(id: string | undefined): string`, `createAgentActivity(now?: () => number): { track(req, res, next): void; within(ms: number): boolean }`

- [ ] **Step 1: Write the failing test**

`app/server/services/agentActivity.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { AGENT_CLIENT_HEADER, agentIdleMs, clientLabel, createAgentActivity } from "./agentActivity.ts";

function call(activity: ReturnType<typeof createAgentActivity>, client?: string): void {
  const req = { get: (h: string) => (h.toLowerCase() === AGENT_CLIENT_HEADER ? client : undefined) } as unknown as Request;
  let nextCalled = false;
  activity.track(req, {} as Response, (() => { nextCalled = true; }) as NextFunction);
  assert.equal(nextCalled, true);
}

test("an agent call holds activity until the window passes", () => {
  let t = 1_000;
  const a = createAgentActivity(() => t);
  assert.equal(a.within(600_000), false);
  call(a, "claude-desktop");
  t += 599_999;
  assert.equal(a.within(600_000), true);
  t += 1;
  assert.equal(a.within(600_000), false);
});

test("assistant calls and calls without the header don't count", () => {
  const a = createAgentActivity(() => 5);
  call(a, "assistant");
  call(a, undefined);
  assert.equal(a.within(600_000), false);
});

test("clientLabel names known clients and falls back", () => {
  assert.equal(clientLabel("claude-desktop"), "Claude Desktop");
  assert.equal(clientLabel("claude-code"), "Claude Code");
  assert.equal(clientLabel("command"), "a shell agent");
  assert.equal(clientLabel("something-else"), "an agent");
  assert.equal(clientLabel(undefined), "an agent");
});

test("agentIdleMs defaults to 10 minutes and honors SKILL_VAULT_AGENT_IDLE_MS", () => {
  const prev = process.env.SKILL_VAULT_AGENT_IDLE_MS;
  try {
    delete process.env.SKILL_VAULT_AGENT_IDLE_MS;
    assert.equal(agentIdleMs(), 600_000);
    process.env.SKILL_VAULT_AGENT_IDLE_MS = "1500";
    assert.equal(agentIdleMs(), 1500);
  } finally {
    if (prev === undefined) delete process.env.SKILL_VAULT_AGENT_IDLE_MS;
    else process.env.SKILL_VAULT_AGENT_IDLE_MS = prev;
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test server/services/agentActivity.test.ts`
Expected: FAIL — cannot find module `./agentActivity.ts`.

- [ ] **Step 3: Implement**

`app/server/services/agentActivity.ts`:

```ts
/**
 * Agent calls through the vault bridge (Claude Desktop, Claude Code, the
 * shared `skill-vault` command) count as app activity, so a server the
 * bridge started in the background stays up while an agent is working and
 * idles out afterwards (server/index.ts folds `within` into isBusy).
 *
 * The bridge names its client in the X-Skill-Vault-Client header. The
 * in-app assistant sends "assistant" and doesn't count: its turns are
 * already busy work.
 */
import type { NextFunction, Request, Response } from "express";

export const AGENT_CLIENT_HEADER = "x-skill-vault-client";

/** 10 minutes; SKILL_VAULT_AGENT_IDLE_MS overrides it (tests shorten it). */
export function agentIdleMs(): number {
  const raw = process.env.SKILL_VAULT_AGENT_IDLE_MS;
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0 ? n : 10 * 60_000;
}

const LABELS: Record<string, string> = {
  "claude-desktop": "Claude Desktop",
  "claude-code": "Claude Code",
  command: "a shell agent",
  assistant: "the assistant",
};

/** Human label for a client id, used in `source` and activity messages. */
export function clientLabel(id: string | undefined): string {
  return (id !== undefined && LABELS[id]) || "an agent";
}

export function createAgentActivity(now: () => number = Date.now): {
  track(req: Request, res: Response, next: NextFunction): void;
  within(ms: number): boolean;
} {
  let last: number | null = null;
  return {
    track(req, _res, next) {
      const client = req.get(AGENT_CLIENT_HEADER);
      if (client && client !== "assistant") last = now();
      next();
    },
    within(ms) {
      return last !== null && now() - last < ms;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test server/services/agentActivity.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire it into the server**

In `app/server/index.ts`, add the import next to the other service imports:

```ts
import { agentIdleMs, createAgentActivity } from "./services/agentActivity.ts";
```

Replace

```ts
  const app = express();
  app.use(express.json({ limit: "1mb" }));
```

with

```ts
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  // Bridge calls from Claude Desktop, Claude Code and the skill-vault command
  // hold off the idle stop (see services/agentActivity.ts).
  const agentActivity = createAgentActivity();
  app.use("/api", agentActivity.track);
```

and replace the isBusy line

```ts
  app.locals.isBusy = (): boolean => busyWithoutUpdate() || updater.isApplying() || notionSignInPending();
```

with

```ts
  app.locals.isBusy = (): boolean =>
    busyWithoutUpdate() || updater.isApplying() || notionSignInPending() || agentActivity.within(agentIdleMs());
```

Also extend the comment above it: `// An agent call in the last 10 minutes counts too (services/agentActivity.ts).`

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test`
Expected: clean; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/services/agentActivity.ts server/services/agentActivity.test.ts server/index.ts
git commit -m "server: count bridge agent calls as activity for the idle stop

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Save a skill from file contents

**Files:**
- Create: `app/server/services/saveSkill.ts`
- Test: `app/server/services/saveSkill.test.ts`, `app/server/routes/skillsSave.test.ts`
- Modify: `app/server/routes/skills.ts` (imports; new route after the `PUT /:name/files/*filepath` route), `app/server/index.ts` (JSON limit for the save path)

**Interfaces:**
- Consumes: `AGENT_CLIENT_HEADER`, `clientLabel` (Task 1); `validateSkillName(vaultPath, name)` (`services/skillName.ts`); `frontmatterValueOf(md, key)` (`services/skillNames.ts`); `resolveSkillFilePath`, `readSkillFile`, `skillDir`, `upsertManifestSkill` (`services/vault.ts`); `IGNORE_NAMES` (`services/skillHash.ts`); `withHistory`, `recordVersion` (`services/history.ts`); `isSafeNameSegment` (`routes/skills.ts`); `refuseCrossSiteWrites` (`routes/sameOrigin.ts`)
- Produces: `POST /api/skills/:name/save` body `{ mode: "create" | "update", files: [{ path, content, expected_sha256? }] }` → 201 (create) / 200 (update) `{ name, mode, written: string[], unchanged: string[] }`; errors `{ error, conflicts?: [{ path, current_sha256: string | null }] }` with 400/404/409/413. Service: `parseSaveRequest(body): SaveRequest`, `saveSkill(vaultPath, name, req, source): SaveResult`, `class SaveError { status; conflicts? }`.

- [ ] **Step 1: Write the failing service tests**

`app/server/services/saveSkill.test.ts`:

```ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SaveError, parseSaveRequest, saveSkill } from "./saveSkill.ts";
import { initVault, readManifest } from "./vault.ts";

let vault: string;
beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "sv-save-"));
  initVault(vault);
});
afterEach(() => fs.rmSync(vault, { recursive: true, force: true }));

const md = (name: string, body = "Body") => `---\nname: ${name}\ndescription: test\n---\n\n${body}\n`;
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const file = (name: string, rel: string) => path.join(vault, "skills", name, ...rel.split("/"));
const read = (name: string, rel: string) => fs.readFileSync(file(name, rel), "utf-8");
function refused(fn: () => unknown, status: number, match?: RegExp): SaveError {
  let caught: unknown;
  assert.throws(fn, (e: unknown) => {
    caught = e;
    return e instanceof SaveError && e.status === status && (!match || match.test(e.message));
  });
  return caught as SaveError;
}
const create = (name: string, files = [{ path: "SKILL.md", content: md(name) }]) =>
  saveSkill(vault, name, { mode: "create", files }, "saved from Claude Desktop");

test("create writes every file and adds a staging manifest entry", () => {
  const r = create("demo", [
    { path: "SKILL.md", content: md("demo") },
    { path: "references/api.md", content: "API" },
  ]);
  assert.deepEqual(r, { name: "demo", mode: "create", written: ["SKILL.md", "references/api.md"], unchanged: [] });
  assert.equal(read("demo", "references/api.md"), "API");
  const entry = readManifest(vault).skills.demo;
  assert.deepEqual(entry.targets, []);
  assert.equal(entry.stage, "staging");
  assert.equal(entry.source, "saved from Claude Desktop");
});

test("create refuses a taken name, a bad name, a missing SKILL.md, and a mismatched frontmatter name", () => {
  create("demo");
  refused(() => create("demo"), 409);
  refused(() => create("Bad Name", [{ path: "SKILL.md", content: md("Bad Name") }]), 409);
  refused(() => create("other", [{ path: "notes.md", content: "x" }]), 400, /SKILL\.md/);
  refused(() => create("other", [{ path: "SKILL.md", content: md("different") }]), 400, /frontmatter name/);
  assert.equal(fs.existsSync(path.join(vault, "skills", "other")), false);
});

test("update changes files with matching hashes, adds new files, keeps the rest, reports unchanged", () => {
  create("demo", [
    { path: "SKILL.md", content: md("demo") },
    { path: "a.md", content: "A" },
    { path: "keep.md", content: "K" },
  ]);
  const r = saveSkill(
    vault,
    "demo",
    {
      mode: "update",
      files: [
        { path: "SKILL.md", content: md("demo"), expected_sha256: sha(md("demo")) },
        { path: "a.md", content: "A2", expected_sha256: sha("A") },
        { path: "new/b.md", content: "B" },
      ],
    },
    "saved from Claude Code",
  );
  assert.deepEqual(r.written, ["a.md", "new/b.md"]);
  assert.deepEqual(r.unchanged, ["SKILL.md"]);
  assert.equal(read("demo", "a.md"), "A2");
  assert.equal(read("demo", "new/b.md"), "B");
  assert.equal(read("demo", "keep.md"), "K");
  assert.equal(readManifest(vault).skills.demo.source, "saved from Claude Desktop");
});

test("update writes nothing when any hash is stale, and lists every conflict", () => {
  create("demo", [
    { path: "SKILL.md", content: md("demo") },
    { path: "a.md", content: "A" },
  ]);
  const err = refused(
    () =>
      saveSkill(vault, "demo", {
        mode: "update",
        files: [
          { path: "a.md", content: "A2", expected_sha256: "stale" },
          { path: "b.md", content: "B" },
          { path: "gone.md", content: "G", expected_sha256: sha("G") },
        ],
      }, "x"),
    409,
    /files changed/,
  );
  assert.deepEqual(err.conflicts, [
    { path: "a.md", current_sha256: sha("A") },
    { path: "gone.md", current_sha256: null },
  ]);
  assert.equal(read("demo", "a.md"), "A");
  assert.equal(fs.existsSync(file("demo", "b.md")), false);
});

test("update requires expected_sha256 for existing files and refuses unknown skills", () => {
  create("demo");
  refused(() => saveSkill(vault, "demo", { mode: "update", files: [{ path: "SKILL.md", content: md("demo") }] }, "x"), 400, /expected_sha256/);
  refused(() => saveSkill(vault, "nope", { mode: "update", files: [{ path: "a.md", content: "A" }] }, "x"), 404);
});

test("paths must be relative, /-separated, unique and not ignored", () => {
  for (const bad of ["../x.md", "/abs.md", "C:/x.md", "a\\b.md", "a//b.md", "./a.md", ".git/config"]) {
    refused(() => create("demo", [{ path: "SKILL.md", content: md("demo") }, { path: bad, content: "x" }]), 400, /invalid file path/);
  }
  refused(() => create("demo", [{ path: "SKILL.md", content: md("demo") }, { path: "skill.md", content: "x" }]), 400, /duplicate/);
});

test("binary content and size limits are refused", () => {
  refused(() => create("demo", [{ path: "SKILL.md", content: md("demo") }, { path: "b.bin", content: "a\0b" }]), 400, /binary/);
  const big = "x".repeat(1_048_577);
  refused(() => create("demo", [{ path: "SKILL.md", content: md("demo") }, { path: "big.md", content: big }]), 413);
  const mb = "y".repeat(1_000_000);
  const many = Array.from({ length: 6 }, (_, i) => ({ path: `f${i}.md`, content: mb }));
  refused(() => create("demo", [{ path: "SKILL.md", content: md("demo") }, ...many]), 413, /5 MB/);
});

test("parseSaveRequest checks the body shape", () => {
  assert.throws(() => parseSaveRequest({ mode: "replace", files: [] }), SaveError);
  assert.throws(() => parseSaveRequest({ mode: "create", files: [] }), SaveError);
  assert.throws(() => parseSaveRequest({ mode: "create", files: [{ path: "a" }] }), SaveError);
  assert.throws(() => parseSaveRequest({ mode: "create", files: [{ path: "a", content: "b", expected_sha256: 1 }] }), SaveError);
  assert.deepEqual(parseSaveRequest({ mode: "update", files: [{ path: "a", content: "b", expected_sha256: "h" }] }), {
    mode: "update",
    files: [{ path: "a", content: "b", expected_sha256: "h" }],
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test server/services/saveSkill.test.ts`
Expected: FAIL — cannot find module `./saveSkill.ts`.

- [ ] **Step 3: Implement the service**

`app/server/services/saveSkill.ts`:

```ts
/**
 * Save a skill from file contents: the server side of the bridge's
 * `save_skill` tool (POST /api/skills/:name/save). An agent that wrote or
 * edited a skill in a chat has no folder on disk to adopt from, so it sends
 * the files themselves.
 *
 * Everything is validated before anything is written. Update is
 * optimistic: every existing file being changed must carry the sha256 the
 * agent read, and one mismatch writes nothing. Files left out are
 * untouched; nothing is ever deleted.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { IGNORE_NAMES } from "./skillHash.ts";
import { frontmatterValueOf } from "./skillNames.ts";
import { validateSkillName } from "./skillName.ts";
import { readSkillFile, resolveSkillFilePath, skillDir, upsertManifestSkill } from "./vault.ts";

export const SAVE_FILE_CAP_BYTES = 1_048_576;
export const SAVE_TOTAL_CAP_BYTES = 5 * 1_048_576;

export interface SaveFile {
  path: string;
  content: string;
  expected_sha256?: string;
}

export interface SaveRequest {
  mode: "create" | "update";
  files: SaveFile[];
}

export interface SaveResult {
  name: string;
  mode: "create" | "update";
  written: string[];
  unchanged: string[];
}

export interface SaveConflict {
  path: string;
  /** null when the file no longer exists. */
  current_sha256: string | null;
}

/** A refused save; `status` is the HTTP status the route answers with. */
export class SaveError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 413,
    message: string,
    public conflicts?: SaveConflict[],
  ) {
    super(message);
  }
}

const sha256 = (buf: Buffer): string => crypto.createHash("sha256").update(buf).digest("hex");

/** Shape-check the JSON body. */
export function parseSaveRequest(body: unknown): SaveRequest {
  const b = (body ?? {}) as { mode?: unknown; files?: unknown };
  if (b.mode !== "create" && b.mode !== "update") throw new SaveError(400, 'mode must be "create" or "update"');
  if (!Array.isArray(b.files) || b.files.length === 0) throw new SaveError(400, "files must be a non-empty array");
  const files = b.files.map((f, i): SaveFile => {
    const x = (f ?? {}) as Record<string, unknown>;
    if (typeof x.path !== "string" || typeof x.content !== "string") {
      throw new SaveError(400, `files[${i}] needs a string path and content`);
    }
    if (x.expected_sha256 !== undefined && typeof x.expected_sha256 !== "string") {
      throw new SaveError(400, `files[${i}].expected_sha256 must be a string`);
    }
    return {
      path: x.path,
      content: x.content,
      ...(typeof x.expected_sha256 === "string" ? { expected_sha256: x.expected_sha256 } : {}),
    };
  });
  return { mode: b.mode, files };
}

/** "/"-separated and relative, with no empty, ".", ".." or ignored segments; null otherwise. */
function cleanRelPath(p: string): string | null {
  if (p.includes("\\") || p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null;
  const segs = p.split("/");
  if (segs.some((s) => s === "" || s === "." || s === ".." || IGNORE_NAMES.has(s))) return null;
  return segs.join("/");
}

interface PlannedWrite {
  rel: string;
  abs: string;
  content: string;
  expected?: string;
}

export function saveSkill(vaultPath: string, name: string, req: SaveRequest, source: string): SaveResult {
  // 1. Paths, duplicates, content and sizes.
  let total = 0;
  const seen = new Set<string>();
  const plan: PlannedWrite[] = [];
  for (const f of req.files) {
    const rel = cleanRelPath(f.path);
    const abs = rel ? resolveSkillFilePath(vaultPath, name, rel) : null;
    if (!rel || !abs) throw new SaveError(400, `invalid file path: ${f.path}`);
    const key = rel.toLowerCase();
    if (seen.has(key)) throw new SaveError(400, `duplicate file path: ${rel}`);
    seen.add(key);
    if (f.content.includes("\0")) throw new SaveError(400, `binary content is not supported: ${rel}`);
    const bytes = Buffer.byteLength(f.content, "utf-8");
    if (bytes > SAVE_FILE_CAP_BYTES) throw new SaveError(413, `${rel} is larger than 1 MB`);
    total += bytes;
    plan.push({ rel, abs, content: f.content, expected: f.expected_sha256 });
  }
  if (total > SAVE_TOTAL_CAP_BYTES) throw new SaveError(413, "the files total more than 5 MB");

  // 2. SKILL.md, when sent, must carry this skill's name.
  const skillMd = plan.find((p) => p.rel === "SKILL.md");
  if (req.mode === "create" && !skillMd) throw new SaveError(400, "a new skill needs a SKILL.md");
  if (skillMd && frontmatterValueOf(skillMd.content, "name") !== name) {
    throw new SaveError(400, `SKILL.md's frontmatter name must be "${name}"`);
  }

  // 3. Create: the name is free. Update: the skill exists and nothing changed underneath.
  const dir = skillDir(vaultPath, name);
  if (req.mode === "create") {
    const v = validateSkillName(vaultPath, name);
    if (!v.ok) throw new SaveError(409, v.reason);
  } else {
    if (!fs.existsSync(dir)) throw new SaveError(404, `skill not found: ${name}`);
    const conflicts: SaveConflict[] = [];
    for (const p of plan) {
      if (!fs.existsSync(p.abs)) {
        if (p.expected !== undefined) conflicts.push({ path: p.rel, current_sha256: null });
        continue;
      }
      if (!fs.statSync(p.abs).isFile()) throw new SaveError(400, `not a file: ${p.rel}`);
      const current = readSkillFile(p.abs);
      if (current.binary || current.too_large) throw new SaveError(400, `cannot overwrite ${p.rel} (binary or larger than 1 MB)`);
      if (p.expected === undefined) throw new SaveError(400, `${p.rel} already exists: pass the expected_sha256 you read`);
      if (p.expected !== current.sha256) conflicts.push({ path: p.rel, current_sha256: current.sha256 });
    }
    if (conflicts.length > 0) throw new SaveError(409, "files changed", conflicts);
  }

  // 4. Write (temp + rename per file); identical content is left alone.
  fs.mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const unchanged: string[] = [];
  for (const p of plan) {
    const next = Buffer.from(p.content, "utf-8");
    if (fs.existsSync(p.abs) && sha256(fs.readFileSync(p.abs)) === sha256(next)) {
      unchanged.push(p.rel);
      continue;
    }
    fs.mkdirSync(path.dirname(p.abs), { recursive: true });
    const tmp = `${p.abs}.tmp`;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, p.abs);
    written.push(p.rel);
  }
  if (req.mode === "create") upsertManifestSkill(vaultPath, name, { targets: [], stage: "staging", source });
  return { name, mode: req.mode, written, unchanged };
}
```

- [ ] **Step 4: Run the service tests**

Run: `node --import tsx --test server/services/saveSkill.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Write the failing route test**

`app/server/routes/skillsSave.test.ts` (same sandbox pattern as `routes/history.test.ts`):

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";

let vault: string;
let fakeHome: string;
let server: Server;
let url: string;

before(async () => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "sv-home-"));
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "sv-vault-"));
  fs.mkdirSync(path.join(fakeHome, ".skill-vault"), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, ".skill-vault", "config.json"), JSON.stringify({ vault_path: vault }) + "\n");
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;

  const express = (await import("express")).default;
  const { skillsRouter } = await import("./skills.ts");
  const { initVault } = await import("../services/vault.ts");
  initVault(vault);

  const app = express();
  app.use("/api/skills/:name/save", express.json({ limit: "6mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/skills", skillsRouter());
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api/skills`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(vault, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

const md = (name: string) => `---\nname: ${name}\ndescription: t\n---\n`;
const post = (name: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}/${encodeURIComponent(name)}/save`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("create answers 201 and labels the source from the client header", async () => {
  const res = await post("from-code", { mode: "create", files: [{ path: "SKILL.md", content: md("from-code") }] }, { "x-skill-vault-client": "claude-code" });
  assert.equal(res.status, 201);
  const manifest = JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf-8"));
  assert.equal(manifest.skills["from-code"].source, "saved from Claude Code");
});

test("a stale hash answers 409 with the conflicts", async () => {
  await post("conflicted", { mode: "create", files: [{ path: "SKILL.md", content: md("conflicted") }] });
  const res = await post("conflicted", { mode: "update", files: [{ path: "SKILL.md", content: md("conflicted"), expected_sha256: "old" }] });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string; conflicts: Array<{ path: string }> };
  assert.equal(body.error, "files changed");
  assert.deepEqual(body.conflicts.map((c) => c.path), ["SKILL.md"]);
});

test("bodies over 1 MB are accepted on the save path", async () => {
  const big = "z".repeat(1_500_000);
  const res = await post("bigger", { mode: "create", files: [{ path: "SKILL.md", content: md("bigger") }, { path: "a.md", content: big.slice(0, 1_000_000) }, { path: "b.md", content: big.slice(0, 600_000) }] });
  assert.equal(res.status, 201);
});

test("cross-site requests and unsafe names are refused", async () => {
  const cross = await post("x", { mode: "create", files: [{ path: "SKILL.md", content: md("x") }] }, { origin: "https://evil.example" });
  assert.equal(cross.status, 403);
  const unsafe = await post("a..b", { mode: "update", files: [{ path: "a.md", content: "a" }] });
  assert.equal(unsafe.status, 400);
});
```

Note: this test file mirrors `index.ts`'s parser order on purpose (the 6 MB parser before the 1 MB one).

- [ ] **Step 6: Run it to verify it fails**

Run: `node --import tsx --test server/routes/skillsSave.test.ts`
Expected: FAIL — 404 from the router (no save route yet).

- [ ] **Step 7: Add the route**

In `app/server/routes/skills.ts`, add imports:

```ts
import { SaveError, parseSaveRequest, saveSkill, type SaveRequest } from "../services/saveSkill.ts";
import { AGENT_CLIENT_HEADER, clientLabel } from "../services/agentActivity.ts";
import { refuseCrossSiteWrites } from "./sameOrigin.ts";
```

Add `POST /api/skills/:name/save — create or update a skill from file contents (bridge save_skill)` to the endpoint list in the router's doc comment, and add this route directly after the `PUT /:name/files/*filepath` handler:

```ts
  /**
   * POST /:name/save — create or update a skill from file contents (the
   * bridge's save_skill tool; services/saveSkill.ts has the rules).
   *
   * Body: { mode: "create" | "update", files: [{ path, content, expected_sha256? }] }
   * index.ts raises the JSON limit for this path (up to 5 MB of files).
   * The X-Skill-Vault-Client header names who saved it, for `source` and
   * the activity log.
   */
  router.post("/:name/save", refuseCrossSiteWrites, (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const vaultPath = cfg.vault_path;
    const name = req.params.name;
    if (!isSafeNameSegment(name)) {
      res.status(400).json({ error: "invalid skill name" });
      return;
    }
    let body: SaveRequest;
    try {
      body = parseSaveRequest(req.body);
    } catch (err) {
      res.status((err as SaveError).status ?? 400).json({ error: (err as Error).message });
      return;
    }
    const source = `saved from ${clientLabel(req.get(AGENT_CLIENT_HEADER))}`;
    const kind = body.mode === "create" ? "adopt" : "update";
    try {
      const result =
        body.mode === "update"
          ? withHistory(vaultPath, name, "vault-edit", () => saveSkill(vaultPath, name, body, source))
          : saveSkill(vaultPath, name, body, source);
      if (body.mode === "create") {
        try {
          recordVersion(vaultPath, name, { source: "vault-edit", note: "created" });
        } catch (err) {
          console.error(`[history] save ${name}: ${(err as Error).message}`);
        }
      }
      recordActivity({
        kind,
        skill: name,
        ok: true,
        message: body.mode === "create" ? source : `${source} (${result.written.length} files)`,
      });
      res.status(body.mode === "create" ? 201 : 200).json(result);
    } catch (err) {
      if (err instanceof SaveError) {
        res.status(err.status).json({ error: err.message, ...(err.conflicts ? { conflicts: err.conflicts } : {}) });
        return;
      }
      recordActivity({ kind, skill: name, ok: false, message: (err as Error).message });
      throw err;
    }
  });
```

- [ ] **Step 8: Raise the JSON limit for the save path**

In `app/server/index.ts`, replace

```ts
  app.use(express.json({ limit: "1mb" }));
```

with

```ts
  // POST /api/skills/:name/save carries whole skills (up to 5 MB of files).
  // Parsed here first: body-parser skips a body that's already been read, so
  // the 1 MB default below never sees it.
  app.use("/api/skills/:name/save", express.json({ limit: "6mb" }));
  app.use(express.json({ limit: "1mb" }));
```

- [ ] **Step 9: Run the tests**

Run: `node --import tsx --test server/routes/skillsSave.test.ts server/services/saveSkill.test.ts`
Expected: PASS. Then `npm run typecheck && npm test` — all pass.

- [ ] **Step 10: Commit**

```bash
git add server/services/saveSkill.ts server/services/saveSkill.test.ts server/routes/skills.ts server/routes/skillsSave.test.ts server/index.ts
git commit -m "server: save a skill from file contents (POST /api/skills/:name/save)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Bridge client header and three new tools

**Files:**
- Modify: `app/server/assistant-mcp/bridge.ts`
- Test: `app/server/assistant-mcp/bridge.test.ts` (append tests)

**Interfaces:**
- Consumes: `POST /api/skills/:name/save` (Task 2); existing `GET /api/skills/:name`, `GET /api/skills/:name/files/*`, `POST /api/desktop`, `POST /api/desktop/reveal`
- Produces: `createHttp(baseUrl: string, fetchFn?: typeof fetch, client?: string): BridgeHttp`; tools `read_skill_files { name, paths? }` → `{ files: [{ path, content, sha256, size }], skipped: [{ path, reason: "binary" | "too_large" | "over_budget" }] }`, `save_skill { name, mode, files }`, `package_for_desktop { skill, reveal? }`; `READ_BUDGET_BYTES = 256 * 1024`

- [ ] **Step 1: Write the failing tests**

Append to `app/server/assistant-mcp/bridge.test.ts`:

```ts
test("createHttp names the client on every call when given one", async () => {
  const seen: Array<RequestInit | undefined> = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(init);
    return { status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;
  const http = createHttp("http://127.0.0.1:1", fetchFn, "claude-desktop");
  await http("GET", "/api/skills");
  await http("POST", "/api/push", { skill: "x" });
  assert.deepEqual(seen[0]?.headers, { "x-skill-vault-client": "claude-desktop" });
  assert.deepEqual(seen[1]?.headers, { "content-type": "application/json", "x-skill-vault-client": "claude-desktop" });
});

const textFile = (content: string) => ({
  status: 200,
  json: { binary: false, too_large: false, size: Buffer.byteLength(content), sha256: `sha-${content.length}`, content },
});

test("read_skill_files reads SKILL.md first, skips binaries, normalizes Windows paths", async () => {
  const http = fakeHttp([
    {
      status: 200,
      json: {
        files: {
          name: "demo", path: "", type: "dir",
          children: [
            { name: "references", path: "references", type: "dir", children: [{ name: "a.md", path: "references\\a.md", type: "file", size: 3 }] },
            { name: "logo.png", path: "logo.png", type: "file", size: 10 },
            { name: "SKILL.md", path: "SKILL.md", type: "file", size: 5 },
          ],
        },
      },
    },
    textFile("hello"),
    { status: 200, json: { binary: true, too_large: false, size: 10, sha256: null, content: null } },
    textFile("abc"),
  ]);
  const out = (await TOOLS.read_skill_files.handler({ name: "demo" }, http, noSleep)) as {
    files: Array<{ path: string; content: string }>;
    skipped: Array<{ path: string; reason: string }>;
  };
  assert.deepEqual(http.calls.map((c) => c.path), [
    "/api/skills/demo",
    "/api/skills/demo/files/SKILL.md",
    "/api/skills/demo/files/logo.png",
    "/api/skills/demo/files/references/a.md",
  ]);
  assert.deepEqual(out.files.map((f) => [f.path, f.content]), [["SKILL.md", "hello"], ["references/a.md", "abc"]]);
  assert.deepEqual(out.skipped, [{ path: "logo.png", reason: "binary" }]);
});

test("read_skill_files stops at the budget but always returns the first file", async () => {
  const big = 200 * 1024;
  const http = fakeHttp([
    {
      status: 200,
      json: {
        files: {
          name: "demo", path: "", type: "dir",
          children: [
            { name: "SKILL.md", path: "SKILL.md", type: "file", size: big },
            { name: "b.md", path: "b.md", type: "file", size: big },
            { name: "c.md", path: "c.md", type: "file", size: 10 },
          ],
        },
      },
    },
    textFile("x".repeat(big)),
    textFile("c".repeat(10)),
  ]);
  const out = (await TOOLS.read_skill_files.handler({ name: "demo" }, http, noSleep)) as {
    files: Array<{ path: string }>;
    skipped: Array<{ path: string; reason: string }>;
  };
  assert.deepEqual(out.files.map((f) => f.path), ["SKILL.md", "c.md"]);
  assert.deepEqual(out.skipped, [{ path: "b.md", reason: "over_budget" }]);
});

test("read_skill_files with paths reads only those files", async () => {
  const http = fakeHttp([textFile("api")]);
  const out = (await TOOLS.read_skill_files.handler({ name: "my skill", paths: ["references/api.md"] }, http, noSleep)) as {
    files: Array<{ path: string }>;
  };
  assert.deepEqual(http.calls, [{ method: "GET", path: "/api/skills/my%20skill/files/references/api.md" }]);
  assert.deepEqual(out.files.map((f) => f.path), ["references/api.md"]);
});

test("save_skill posts the files and turns a conflict into a re-read instruction", async () => {
  const files = [{ path: "SKILL.md", content: "x", expected_sha256: "h" }];
  const ok = fakeHttp([{ status: 200, json: { name: "demo", mode: "update", written: ["SKILL.md"], unchanged: [] } }]);
  await TOOLS.save_skill.handler({ name: "demo", mode: "update", files }, ok, noSleep);
  assert.deepEqual(ok.calls, [{ method: "POST", path: "/api/skills/demo/save", body: { mode: "update", files } }]);

  const conflict = fakeHttp([{ status: 409, json: { error: "files changed", conflicts: [{ path: "SKILL.md", current_sha256: "z" }] } }]);
  await assert.rejects(
    TOOLS.save_skill.handler({ name: "demo", mode: "update", files }, conflict, noSleep),
    (e: unknown) => e instanceof BridgeToolError && /SKILL\.md/.test(e.message) && /read_skill_files/.test(e.message),
  );
});

test("package_for_desktop packages, and opens the folder only when asked", async () => {
  const plain = fakeHttp([{ status: 200, json: { zip_path: "Z" } }]);
  assert.deepEqual(await TOOLS.package_for_desktop.handler({ skill: "demo" }, plain, noSleep), { zip_path: "Z" });
  assert.deepEqual(plain.calls, [{ method: "POST", path: "/api/desktop", body: { skill: "demo" } }]);

  const reveal = fakeHttp([{ status: 200, json: { zip_path: "Z" } }, { status: 200, json: { ok: true } }]);
  await TOOLS.package_for_desktop.handler({ skill: "demo", reveal: true }, reveal, noSleep);
  assert.deepEqual(reveal.calls.map((c) => c.path), ["/api/desktop", "/api/desktop/reveal"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test server/assistant-mcp/bridge.test.ts`
Expected: FAIL — `TOOLS.read_skill_files` is undefined; header assertion fails.

- [ ] **Step 3: Implement**

In `app/server/assistant-mcp/bridge.ts`, update the header comment's second paragraph to say the bridge is launched by the in-app assistant per turn **and** by Claude Desktop, Claude Code and the shared `skill-vault` command (see `main.ts`). Replace `createHttp` with:

```ts
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
```

Add after `trimSkill`:

```ts
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
    wanted = detail.files ? treeFiles(detail.files) : [];
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
```

Add these entries to `TOOLS` — `read_skill_files` at the end of the read-only group (after `get_suggestions`), the other two at the end of the mutating group (after `fix_repair`):

```ts
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
```

```ts
  save_skill: {
    description:
      'Save a skill into the vault from file contents. mode "create" makes a new staging skill: SKILL.md is required and its frontmatter name must equal `name`. mode "update" changes an existing skill: pass expected_sha256 (from read_skill_files) for every existing file you change and none for new files; files you leave out stay as they are and nothing is deleted. A "files changed" error means re-read and confirm with the user again.',
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
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test server/assistant-mcp/bridge.test.ts`
Expected: PASS (existing + 7 new). The existing "createHttp joins base + path" test still sees `headers: undefined` for a body-less call without a client.

- [ ] **Step 5: Commit**

```bash
git add server/assistant-mcp/bridge.ts server/assistant-mcp/bridge.test.ts
git commit -m "bridge: read_skill_files, save_skill, package_for_desktop; client header

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Bridge finds or starts the server

**Files:**
- Create: `app/server/assistant-mcp/server.ts`
- Test: `app/server/assistant-mcp/server.test.ts`

**Interfaces:**
- Consumes: `readLock(): InstanceLock | null` (`services/instanceLock.ts`)
- Produces: `interface ServerDeps { readLock; health(port): Promise<{ ok?: boolean; pid?: number } | null>; startHeadless(): void; sleep(ms): Promise<void>; now(): number; platform: NodeJS.Platform }`, `findOrStartServer(deps): Promise<string>` (base URL, e.g. `http://127.0.0.1:9994`), `class ServerUnavailableError`, `realServerDeps(appDir: string): ServerDeps`, `createResolvingFetch(resolve: () => Promise<string>, fetchFn?): typeof fetch` (takes a path, not a full URL), `START_TIMEOUT_MS = 60_000`

- [ ] **Step 1: Write the failing test**

`app/server/assistant-mcp/server.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ServerUnavailableError, createResolvingFetch, findOrStartServer, type ServerDeps } from "./server.ts";

const lock = (pid: number, port: number) => ({ pid, port, started_at: "t", version: "v", mode: "production" as const });

function deps(over: Partial<ServerDeps> & { liveAfter?: number } = {}): ServerDeps & { starts: number } {
  let t = 0;
  let polls = 0;
  const d = {
    starts: 0,
    readLock: () => lock(42, 9994),
    health: async () => {
      polls++;
      return over.liveAfter !== undefined && polls > over.liveAfter ? { ok: true, pid: 42 } : null;
    },
    startHeadless: () => {
      d.starts++;
    },
    sleep: async (ms: number) => {
      t += ms;
    },
    now: () => t,
    platform: "win32" as NodeJS.Platform,
    ...over,
  };
  return d;
}

test("a healthy server named by app.lock is used as is", async () => {
  const d = deps({ health: async () => ({ ok: true, pid: 42 }) });
  assert.equal(await findOrStartServer(d), "http://127.0.0.1:9994");
  assert.equal(d.starts, 0);
});

test("a lock whose pid doesn't answer health counts as no server", async () => {
  const d = deps({ health: async () => ({ ok: true, pid: 7 }), platform: "darwin" });
  await assert.rejects(findOrStartServer(d), (e: unknown) => e instanceof ServerUnavailableError && /Open Skill Vault/.test(e.message));
});

test("on Windows it starts the app headless once and waits for it", async () => {
  const d = deps({ liveAfter: 3 });
  assert.equal(await findOrStartServer(d), "http://127.0.0.1:9994");
  assert.equal(d.starts, 1);
});

test("it gives up after 60 seconds and points at launch.log", async () => {
  const d = deps({ readLock: () => null });
  await assert.rejects(findOrStartServer(d), (e: unknown) => e instanceof ServerUnavailableError && /launch\.log/.test(e.message));
  assert.equal(d.starts, 1);
});

const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });

test("the resolving fetch caches the server and re-resolves once after a refused connection", async () => {
  const bases = ["http://a", "http://b"];
  let resolves = 0;
  const urls: string[] = [];
  let failNext = false;
  const fetchFn = (async (url: string | URL | Request) => {
    urls.push(String(url));
    if (failNext) {
      failNext = false;
      throw refused();
    }
    return new Response("{}");
  }) as typeof fetch;
  const f = createResolvingFetch(async () => bases[resolves++], fetchFn);
  await f("/api/x");
  await f("/api/y");
  failNext = true;
  await f("/api/z");
  assert.equal(resolves, 2);
  assert.deepEqual(urls, ["http://a/api/x", "http://a/api/y", "http://a/api/z", "http://b/api/z"]);
});

test("other network errors aren't retried", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    throw new TypeError("boom");
  }) as typeof fetch;
  const f = createResolvingFetch(async () => "http://a", fetchFn);
  await assert.rejects(f("/api/x"), /boom/);
  assert.equal(calls, 1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test server/assistant-mcp/server.test.ts`
Expected: FAIL — cannot find module `./server.ts`.

- [ ] **Step 3: Implement**

`app/server/assistant-mcp/server.ts`:

```ts
/**
 * Where the bridge finds the app server when the app didn't launch it
 * (Claude Desktop, Claude Code, the shared `skill-vault` command):
 *
 * 1. ~/.skill-vault/app.lock names the running server, and GET /api/health
 *    must answer with the same pid.
 * 2. Otherwise, on Windows, start it hidden through scripts/launch.ps1
 *    -Headless (the Start Menu launch's mutex, stale-lock cleanup and
 *    rebuild step, without the window) and wait up to 60 s.
 *
 * Everything that touches the OS comes in through ServerDeps so tests can
 * drive the timing.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { readLock, type InstanceLock } from "../services/instanceLock.ts";

export interface ServerDeps {
  readLock: () => InstanceLock | null;
  health: (port: number) => Promise<{ ok?: boolean; pid?: number } | null>;
  startHeadless: () => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  platform: NodeJS.Platform;
}

export const START_TIMEOUT_MS = 60_000;
const POLL_MS = 500;

export class ServerUnavailableError extends Error {}

async function liveUrl(deps: ServerDeps): Promise<string | null> {
  const lock = deps.readLock();
  if (!lock) return null;
  const h = await deps.health(lock.port);
  return h?.ok && h.pid === lock.pid ? `http://127.0.0.1:${lock.port}` : null;
}

export async function findOrStartServer(deps: ServerDeps): Promise<string> {
  const live = await liveUrl(deps);
  if (live) return live;
  if (deps.platform !== "win32") {
    throw new ServerUnavailableError("Skill Vault isn't running. Open Skill Vault, then retry.");
  }
  deps.startHeadless();
  const deadline = deps.now() + START_TIMEOUT_MS;
  for (;;) {
    await deps.sleep(POLL_MS);
    const url = await liveUrl(deps);
    if (url) return url;
    if (deps.now() >= deadline) {
      const log = path.join(os.homedir(), ".skill-vault", "logs", "launch.log");
      throw new ServerUnavailableError(`Skill Vault didn't start within ${START_TIMEOUT_MS / 1000} seconds. See ${log}.`);
    }
  }
}

export function realServerDeps(appDir: string): ServerDeps {
  return {
    readLock,
    health: async (port) => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
        return res.ok ? ((await res.json()) as { ok?: boolean; pid?: number }) : null;
      } catch {
        return null;
      }
    },
    startHeadless: () => {
      const script = path.join(appDir, "scripts", "launch.ps1");
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script, "-Headless"],
        { detached: true, stdio: "ignore", windowsHide: true },
      );
      child.on("error", () => {
        /* reported by the 60 s wait instead */
      });
      child.unref();
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    platform: process.platform,
  };
}

const isRefused = (err: unknown): boolean => (err as { cause?: { code?: string } })?.cause?.code === "ECONNREFUSED";

/**
 * A fetch over paths ("/api/...") that finds the server on first use and
 * caches it. A refused connection (the server idled out, or moved ports)
 * forgets it and finds it again, once. Use with createHttp("", ...).
 */
export function createResolvingFetch(resolve: () => Promise<string>, fetchFn: typeof fetch = fetch): typeof fetch {
  let base: string | null = null;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    for (let attempt = 0; ; attempt++) {
      base ??= await resolve();
      try {
        return await fetchFn(`${base}${String(input)}`, init);
      } catch (err) {
        base = null;
        if (attempt >= 1 || !isRefused(err)) throw err;
      }
    }
  }) as typeof fetch;
}
```

- [ ] **Step 4: Run the test**

Run: `node --import tsx --test server/assistant-mcp/server.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/assistant-mcp/server.ts server/assistant-mcp/server.test.ts
git commit -m "bridge: find the app server from app.lock or start it headless

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Bridge command mode and entry point

**Files:**
- Create: `app/server/assistant-mcp/cli.ts`
- Test: `app/server/assistant-mcp/cli.test.ts`
- Modify: `app/server/assistant-mcp/main.ts`, `app/package.json` + `app/package-lock.json` (add `zod-to-json-schema`)

**Interfaces:**
- Consumes: `TOOLS`, `createHttp`, `registerTools` (Task 3); `createResolvingFetch`, `findOrStartServer`, `realServerDeps` (Task 4)
- Produces: `parseBridgeArgs(argv): { client: string; command: string | null }` (client defaults to `"assistant"`), `listTools(): Array<{ name, description, input_schema }>`, `runCommand(command, stdinText, http, sleep): Promise<{ code: 0 | 1; out: unknown }>`, `readStdinWithin(stream: NodeJS.ReadableStream, firstByteMs: number): Promise<string>`. CLI: `assistant-mcp.js [--client <id>] [tools | <tool>]`.

- [ ] **Step 1: Add the dependency**

```bash
npm install zod-to-json-schema@^3.25.1
```

Expected: `package.json` gains `"zod-to-json-schema": "^3.25.1"` (already in the lockfile as an MCP SDK dependency).

- [ ] **Step 2: Write the failing test**

`app/server/assistant-mcp/cli.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { BridgeHttp } from "./bridge.ts";
import { listTools, parseBridgeArgs, readStdinWithin, runCommand } from "./cli.ts";

const noSleep = async (): Promise<void> => {};
const httpReturning = (json: unknown, status = 200): BridgeHttp & { calls: unknown[] } => {
  const calls: unknown[] = [];
  const http = (async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return { status, json };
  }) as BridgeHttp & { calls: unknown[] };
  http.calls = calls;
  return http;
};

test("parseBridgeArgs reads --client and the first positional", () => {
  assert.deepEqual(parseBridgeArgs([]), { client: "assistant", command: null });
  assert.deepEqual(parseBridgeArgs(["--client", "claude-desktop"]), { client: "claude-desktop", command: null });
  assert.deepEqual(parseBridgeArgs(["--client=command", "list_skills", "extra"]), { client: "command", command: "list_skills" });
});

test("listTools gives every tool a JSON schema", () => {
  const tools = listTools();
  const save = tools.find((t) => t.name === "save_skill");
  assert.ok(save);
  const schema = save.input_schema as { type: string; properties: Record<string, unknown>; required: string[] };
  assert.equal(schema.type, "object");
  assert.deepEqual(Object.keys(schema.properties).sort(), ["files", "mode", "name"]);
  assert.deepEqual(schema.required.sort(), ["files", "mode", "name"]);
});

test("runCommand runs a tool with JSON args from stdin", async () => {
  const http = httpReturning({ matches: [] });
  const r = await runCommand("search_skills", '{"query":"pdf"}', http, noSleep);
  assert.deepEqual(r, { code: 0, out: { matches: [] } });
  assert.deepEqual(http.calls, [{ method: "GET", path: "/api/skills/search?q=pdf", body: undefined }]);
});

test("runCommand treats empty stdin as no arguments", async () => {
  const r = await runCommand("get_config", "  \n", httpReturning({ vault_path: "v" }), noSleep);
  assert.deepEqual(r, { code: 0, out: { vault_path: "v" } });
});

test("runCommand reports unknown tools, bad JSON, invalid args and tool errors with exit code 1", async () => {
  const http = httpReturning({ error: "nope" }, 500);
  assert.match(((await runCommand("nope", "", http, noSleep)).out as { error: string }).error, /unknown tool/);
  assert.match(((await runCommand("get_skill", "{", http, noSleep)).out as { error: string }).error, /must be JSON/);
  const invalid = await runCommand("get_skill", "{}", http, noSleep);
  assert.equal(invalid.code, 1);
  assert.match((invalid.out as { error: string }).error, /invalid arguments for get_skill: name/);
  const failed = await runCommand("get_skill", '{"name":"x"}', http, noSleep);
  assert.equal(failed.code, 1);
  assert.match((failed.out as { error: string }).error, /get_skill failed \(500\): nope/);
});

test("runCommand tools lists the tools", async () => {
  const r = await runCommand("tools", "", httpReturning({}), noSleep);
  assert.equal(r.code, 0);
  assert.ok((r.out as Array<{ name: string }>).some((t) => t.name === "read_skill_files"));
});

test("readStdinWithin returns piped input, or empty when nothing arrives in time", async () => {
  const piped = new PassThrough();
  const p = readStdinWithin(piped, 1_000);
  piped.end('{"a":1}');
  assert.equal(await p, '{"a":1}');

  const silent = new PassThrough();
  assert.equal(await readStdinWithin(silent, 20), "");
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --import tsx --test server/assistant-mcp/cli.test.ts`
Expected: FAIL — cannot find module `./cli.ts`.

- [ ] **Step 4: Implement `cli.ts`**

`app/server/assistant-mcp/cli.ts`:

```ts
/**
 * Arguments and command mode for the bridge entry (main.ts):
 *
 *   assistant-mcp.js [--client <id>]           MCP over stdio
 *   assistant-mcp.js [--client <id>] tools     every tool with its JSON schema
 *   assistant-mcp.js [--client <id>] <tool>    JSON arguments on stdin → JSON result on stdout
 *
 * The shared ~/.skill-vault/bin/skill-vault command runs the last two with
 * --client command, so agents without MCP get the same tools.
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { TOOLS, type BridgeHttp } from "./bridge.ts";

export interface BridgeArgs {
  client: string;
  command: string | null;
}

export function parseBridgeArgs(argv: string[]): BridgeArgs {
  let client = "assistant";
  let command: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--client") client = argv[++i] ?? client;
    else if (a.startsWith("--client=")) client = a.slice("--client=".length);
    else if (command === null) command = a;
  }
  return { client, command };
}

export function listTools(): Array<{ name: string; description: string; input_schema: unknown }> {
  return Object.entries(TOOLS).map(([name, def]) => ({
    name,
    description: def.description,
    input_schema: zodToJsonSchema(z.object(def.schema), { $refStrategy: "none" }),
  }));
}

/** One command-mode run. Never throws: failures come back as { code: 1, out: { error } }. */
export async function runCommand(
  command: string,
  stdinText: string,
  http: BridgeHttp,
  sleep: (ms: number) => Promise<void>,
): Promise<{ code: 0 | 1; out: unknown }> {
  if (command === "tools") return { code: 0, out: listTools() };
  const def = TOOLS[command];
  if (!def) return { code: 1, out: { error: `unknown tool: ${command}. Run "skill-vault tools" for the list.` } };
  let raw: unknown = {};
  if (stdinText.trim()) {
    try {
      raw = JSON.parse(stdinText);
    } catch (err) {
      return { code: 1, out: { error: `arguments must be JSON: ${(err as Error).message}` } };
    }
  }
  const parsed = z.object(def.schema).safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(arguments)"}: ${i.message}`).join("; ");
    return { code: 1, out: { error: `invalid arguments for ${command}: ${detail}` } };
  }
  try {
    return { code: 0, out: (await def.handler(parsed.data, http, sleep)) ?? null };
  } catch (err) {
    return { code: 1, out: { error: err instanceof Error ? err.message : String(err) } };
  }
}

/**
 * Read all of stdin, or "" when nothing arrives within `firstByteMs`: some
 * agents run commands with stdin left open and never send anything.
 */
export function readStdinWithin(stream: NodeJS.ReadableStream, firstByteMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      if (chunks.length > 0) return;
      stream.removeAllListeners("data");
      stream.removeAllListeners("end");
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      resolve("");
    }, firstByteMs);
    stream.on("data", (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    stream.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
```

- [ ] **Step 5: Run the test**

Run: `node --import tsx --test server/assistant-mcp/cli.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Rewrite the entry**

Replace `app/server/assistant-mcp/main.ts` with:

```ts
/**
 * Entry for the vault bridge (built to dist/assistant-mcp.js).
 *
 *   - The in-app assistant launches it per turn with SKILL_VAULT_URL set
 *     (services/assistant/mcpConfig.ts).
 *   - Claude Desktop and Claude Code launch it as the "skill-vault" MCP
 *     server, and ~/.skill-vault/bin/skill-vault runs its command mode
 *     (cli.ts). With no SKILL_VAULT_URL it finds or starts the server
 *     itself (server.ts).
 *
 * Kept separate from bridge.ts so the tool table stays importable by unit
 * tests without touching a transport.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHttp, registerTools } from "./bridge.ts";
import { parseBridgeArgs, readStdinWithin, runCommand } from "./cli.ts";
import { createResolvingFetch, findOrStartServer, realServerDeps } from "./server.ts";

const args = parseBridgeArgs(process.argv.slice(2));

// <app>/dist/assistant-mcp.js when built, <app>/server/assistant-mcp/main.ts in dev.
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.basename(here) === "dist" ? path.dirname(here) : path.resolve(here, "..", "..");

const http = process.env.SKILL_VAULT_URL
  ? createHttp(process.env.SKILL_VAULT_URL, fetch, args.client)
  : createHttp("", createResolvingFetch(() => findOrStartServer(realServerDeps(appDir))), args.client);

if (args.command) {
  const stdinText = args.command === "tools" || process.stdin.isTTY ? "" : await readStdinWithin(process.stdin, 2_000);
  const { code, out } = await runCommand(args.command, stdinText, http, (ms) => new Promise((r) => setTimeout(r, ms)));
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  process.exitCode = code;
} else {
  const server = new McpServer({ name: "vault", version: "1.0.0" });
  registerTools(server, http);
  await server.connect(new StdioServerTransport());
}
```

- [ ] **Step 7: Smoke-test command mode without a server**

Run (from `app/`): `node --import tsx server/assistant-mcp/main.ts tools | head -c 300`
Expected: JSON array starting with `[` and a `"name": "list_skills"` entry. (No server needed for `tools`.)

Run: `echo '{}' | node --import tsx server/assistant-mcp/main.ts get_skill`
Expected: exit code 1 and `{ "error": "invalid arguments for get_skill: name: Required" }` (validation happens before any server lookup).

- [ ] **Step 8: Verify and commit**

Run: `npm run typecheck && npm test && npm run build`
Expected: clean, all pass, build writes `dist/assistant-mcp.js`.

```bash
git add server/assistant-mcp/cli.ts server/assistant-mcp/cli.test.ts server/assistant-mcp/main.ts package.json package-lock.json
git commit -m "bridge: command mode (tools / <tool>) and self-hosted server discovery

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `launch.ps1 -Headless`

**Files:**
- Modify: `app/scripts/launch.ps1`

**Interfaces:**
- Produces: `launch.ps1 -Headless` — steps 1–2 only (reuse or start the server), no window, failures logged and exit 1 without a message box. Used by `realServerDeps().startHeadless` (Task 4).

- [ ] **Step 1: Add the switch and document it**

In the header comment, after step 3 add:

```
  -Headless (used by the vault bridge for Claude Desktop, Claude Code and
  the skill-vault command): steps 1-2 only, no window. Failures go to the
  log and exit 1 without a message box, so repeated agent calls don't
  stack dialogs.
```

Immediately after the closing `#>` and before `$ErrorActionPreference = 'Stop'`, add:

```powershell
param([switch]$Headless)
```

- [ ] **Step 2: No message box when headless**

Replace `Stop-WithError` with:

```powershell
function Stop-WithError([string]$Message) {
  Write-Log "ERROR: $Message"
  if ($Headless) { exit 1 }
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("$Message`n`nDetails: $LaunchLog", 'Skill Vault', 'OK', 'Error') | Out-Null
  exit 1
}
```

- [ ] **Step 3: Skip the window when headless**

Replace `  Write-Log '--- launch'` with:

```powershell
  Write-Log $(if ($Headless) { '--- launch (headless)' } else { '--- launch' })
```

and replace `    Open-AppWindow ([int]$live.port)` with:

```powershell
    if ($Headless) { Write-Log 'headless: no window' } else { Open-AppWindow ([int]$live.port) }
```

- [ ] **Step 4: Verify the script parses**

Run (PowerShell tool, from `app/`):

```powershell
$errs = $null; [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path 'scripts/launch.ps1'), [ref]$null, [ref]$errs); if ($errs) { $errs; exit 1 } else { 'parsed ok' }
```

Expected: `parsed ok`. Do **not** run the launcher here: it would start or reuse the user's installed app (shared `~/.skill-vault/app.lock`). The real run is in the post-merge manual check.

- [ ] **Step 5: Commit**

```bash
git add scripts/launch.ps1
git commit -m "launcher: -Headless starts or reuses the server without a window

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The bundled `skill-vault` skill

**Files:**
- Create: `app/bundled-skills/skill-vault/SKILL.md`, `app/server/services/agentAccess/bundledSkill.ts`
- Test: `app/server/services/agentAccess/bundledSkill.test.ts`

**Interfaces:**
- Consumes: `TOOLS` (Task 3); `frontmatterValueOf` (`services/skillNames.ts`)
- Produces: `BUNDLED_SKILL_NAME = "skill-vault"`, `bundledSkillsRoot(appRoot): string` (`<app>/bundled-skills`), `bundledSkillDir(appRoot): string`, `readBundledSkillMd(appRoot): string`, `installPrompt(skillMd: string): string`

- [ ] **Step 1: Write the failing test**

`app/server/services/agentAccess/bundledSkill.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../../assistant-mcp/bridge.ts";
import { frontmatterValueOf } from "../skillNames.ts";
import { BUNDLED_SKILL_NAME, bundledSkillDir, installPrompt, readBundledSkillMd } from "./bundledSkill.ts";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const md = readBundledSkillMd(APP_ROOT);

test("the bundled skill is a single SKILL.md named skill-vault", () => {
  assert.equal(BUNDLED_SKILL_NAME, "skill-vault");
  assert.deepEqual(fs.readdirSync(bundledSkillDir(APP_ROOT)), ["SKILL.md"]);
  assert.equal(frontmatterValueOf(md, "name"), "skill-vault");
  assert.ok((frontmatterValueOf(md, "description") ?? "").length > 80);
});

test("the bundled skill holds nothing personal", () => {
  assert.doesNotMatch(md, /[A-Za-z]:\\Users\\/);
  assert.doesNotMatch(md, /\/Users\/|\/home\//);
  assert.doesNotMatch(md, /[\w.+-]+@[\w-]+\.[\w.]+/);
});

test("every tool the skill names exists in the bridge", () => {
  const named = [
    "list_skills", "search_skills", "get_skill", "read_skill_files", "save_skill", "get_config",
    "push_to_provider", "pull_from_provider", "package_for_desktop", "notion_status", "notion_plan",
    "notion_run", "notion_push", "check_updates", "apply_update", "audit_vault",
  ];
  for (const name of named) {
    assert.ok(md.includes(`\`${name}`), `SKILL.md should mention ${name}`);
    assert.ok(name in TOOLS, `bridge should have ${name}`);
  }
});

test("the install prompt carries SKILL.md verbatim inside a fence it can't break", () => {
  const prompt = installPrompt(md);
  assert.ok(prompt.includes(md.trimEnd()));
  assert.match(prompt, /^Please install this as a Claude skill/);
  assert.ok(prompt.includes("````markdown\n"));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test server/services/agentAccess/bundledSkill.test.ts`
Expected: FAIL — cannot find module `./bundledSkill.ts`.

- [ ] **Step 3: Write the skill**

`app/bundled-skills/skill-vault/SKILL.md`:

````markdown
---
name: skill-vault
description: Work with the user's Skill Vault, the local skill library managed by the Skill Vault app. Use when the user asks to save or push a skill to their vault, load or use a skill from their vault, list or search what's in the vault, push a vault skill to another tool (Claude Code, Cursor, Codex, Copilot, Windsurf, OpenClaw), install a vault skill in Claude Desktop or claude.ai, sync skills with Notion, or check whether vault skills are in sync or have updates.
---

# Skill Vault

The user keeps their agent skills in a **Skill Vault**: a folder of skills managed by the Skill Vault
app on their computer. The app links vault skills into each tool's skills folder (its *targets*),
packages them for Claude Desktop, and syncs them with Notion. This skill lets you do that work from a
chat.

## Step 1: reach the vault

Use the first of these that works:

1. **Vault tools.** If you have tools named `list_skills`, `get_skill`, `read_skill_files` and
   `save_skill` (under any server name, usually `skill-vault`), call them directly.
2. **The shared command.** If you can run shell commands, use the command the app installs:
   `~/.skill-vault/bin/skill-vault` (in Windows `cmd` or PowerShell:
   `%USERPROFILE%\.skill-vault\bin\skill-vault.cmd`).
   - `skill-vault tools` lists every tool and its arguments.
   - `skill-vault <tool>` reads the tool's arguments as JSON on stdin and prints the JSON result:

     ```bash
     echo '{"query":"pdf"}' | ~/.skill-vault/bin/skill-vault search_skills
     ```

     ```powershell
     '{"query":"pdf"}' | & "$env:USERPROFILE\.skill-vault\bin\skill-vault.cmd" search_skills
     ```

   - For `save_skill`, write the JSON arguments to a temporary file and pipe it in
     (`skill-vault save_skill < args.json`) instead of quoting file contents on the command line.
3. **Neither.** Tell the user this app isn't connected to their vault yet, and that they can connect
   it in the Skill Vault app under **Settings → Agent access**. Don't guess vault paths or edit vault
   folders directly.

The first call can take up to a minute when the Skill Vault app has to start in the background.

## Find skills

- `list_skills`: every skill with its status, stage, targets and tags. Group or filter the results for
  the user instead of listing hundreds of names.
- `search_skills { query }`: full-text search across SKILL.md files.
- `get_skill { name }`: one skill's targets, origin, Notion link and file tree.

## Use a vault skill in this chat

1. `read_skill_files { name }` returns SKILL.md first, then the other text files, each with its
   `sha256`. If `skipped` lists files as `over_budget`, ask for them with `paths` when the task needs
   them.
2. Follow the skill as written for the rest of the conversation, as if it were installed.

## Save a skill from this chat to the vault

**A new skill:**

1. Pick a name: lowercase letters, digits and hyphens, 2 to 64 characters. SKILL.md's frontmatter
   `name` must be the same.
2. `save_skill { name, mode: "create", files: [{ path: "SKILL.md", content }, …] }`. Paths are
   relative and use `/`, for example `references/api.md`.
3. Tell the user it's saved as a **staging** skill with no targets yet, and offer to push it to their
   tools (next section).

**Changes to a skill that's already in the vault:**

1. `read_skill_files { name }` for the current files and their `sha256`.
2. Show the user what will change (a short diff per file) and wait for a yes.
3. `save_skill { name, mode: "update", files: [{ path, content, expected_sha256 }, …] }`. Pass the
   `sha256` you read for every existing file you change, and leave `expected_sha256` out for new
   files. Files you leave out stay as they are; nothing is deleted.
4. If it fails because files changed, someone edited them after you read them. Read them again, show
   the new differences, and ask again. Never retry blindly.

## Push a vault skill to the user's other tools

1. `get_config` shows the configured targets (such as `claude`, `cursor`, `codex`) and the
   `default_targets`.
2. `push_to_provider { skill, provider_id }` links the skill into that tool. Repeat for each tool the
   user wants.
3. To bring a tool's edited copy back into the vault: `pull_from_provider { skill, provider_id }`.

## Install a vault skill in Claude Desktop or claude.ai

Claude Desktop and claude.ai keep skills in the user's Claude account, and nothing can install them
there for the user.

1. `package_for_desktop { skill, reveal: true }` builds `<skill>.zip` and opens the folder holding it.
2. Tell the user to upload that zip in Claude Desktop under **Settings → Capabilities → Skills**.

## Notion, status and updates

- `notion_status`: whether Notion is connected and which skills are linked, changed or in conflict.
- `notion_plan`, then `notion_run`; or `notion_push { skills }`. Show the plan and get a yes before
  running it. One Notion job runs at a time: if a tool says one is busy, tell the user and stop.
- `check_updates { skills }`, then `apply_update`: update skills from where they came from (GitHub, a
  folder).
- `audit_vault`: problems such as broken links or folders missing from the manifest.

## Rules

- Never overwrite a vault skill without showing the changes and getting a yes.
- Never delete skills or files. If the user wants that, point them to the Skill Vault app.
- Don't save secrets (API keys, tokens, passwords) into a skill. Point them out and leave them out.
- Report tool errors to the user in plain words; don't retry silently.
````

- [ ] **Step 4: Implement `bundledSkill.ts`**

`app/server/services/agentAccess/bundledSkill.ts`:

```ts
/**
 * The skill-vault skill that ships with the app (app/bundled-skills/).
 * Settings → Agent access adopts it into the vault like any other skill,
 * with a `dir` origin pointing back here, so app updates that change it
 * show up as "Update available".
 */
import fs from "node:fs";
import path from "node:path";

export const BUNDLED_SKILL_NAME = "skill-vault";

/** The origin root recorded when the skill is adopted. */
export function bundledSkillsRoot(appRoot: string): string {
  return path.join(appRoot, "bundled-skills");
}

export function bundledSkillDir(appRoot: string): string {
  return path.join(bundledSkillsRoot(appRoot), BUNDLED_SKILL_NAME);
}

export function readBundledSkillMd(appRoot: string): string {
  return fs.readFileSync(path.join(bundledSkillDir(appRoot), "SKILL.md"), "utf-8");
}

/**
 * The copy-paste prompt for Claude Desktop. SKILL.md contains ``` fences,
 * so it goes inside a four-backtick fence.
 */
export function installPrompt(skillMd: string): string {
  return [
    "Please install this as a Claude skill for me. Create a zip named skill-vault.zip that contains one",
    "folder, skill-vault/, with this exact file as skill-vault/SKILL.md (don't change any of it), and give",
    "me the zip so I can save it to my skills.",
    "",
    "````markdown",
    skillMd.trimEnd(),
    "````",
    "",
  ].join("\n");
}
```

- [ ] **Step 5: Run the test**

Run: `node --import tsx --test server/services/agentAccess/bundledSkill.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add bundled-skills/skill-vault/SKILL.md server/services/agentAccess/bundledSkill.ts server/services/agentAccess/bundledSkill.test.ts
git commit -m "skill-vault: the public skill any agent uses to work with the vault

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Claude Desktop config

**Files:**
- Create: `app/server/services/agentAccess/desktopConfig.ts`
- Test: `app/server/services/agentAccess/desktopConfig.test.ts`

**Interfaces:**
- Produces: `SERVER_NAME = "skill-vault"`; `type JsonObject = Record<string, unknown>`; `interface McpEntry { command: string; args: string[] }`; `interface PathEnv { platform; appData?; localAppData?; home; exists(p); list(dir) }`; `realPathEnv(): PathEnv`; `desktopConfigPath(env): string | null`; `bridgeEntry(nodePath, bridgePath, client): McpEntry`; `isOurEntry(entry: unknown): boolean`; `type EntryState = "not_connected" | "connected" | "broken" | "name_taken"`; `entryState(entry, exists): EntryState`; `getEntry(config): unknown`; `withEntry(config, entry): JsonObject`; `withoutEntry(config): JsonObject`; `class DesktopConfigError`; `readDesktopConfig(file): JsonObject`; `writeDesktopConfig(file, config): void`

- [ ] **Step 1: Write the failing test**

`app/server/services/agentAccess/desktopConfig.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DesktopConfigError, bridgeEntry, desktopConfigPath, entryState, getEntry, isOurEntry,
  readDesktopConfig, withEntry, withoutEntry, writeDesktopConfig, type PathEnv,
} from "./desktopConfig.ts";

const ours = bridgeEntry("C:/node/node.exe", "C:/apps/skill-vault/app/dist/assistant-mcp.js", "claude-desktop");
const foreign = { command: "npx", args: ["some-other-server"] };

function env(over: Partial<PathEnv> & { dirs?: string[]; listing?: Record<string, string[]> }): PathEnv {
  const dirs = new Set(over.dirs ?? []);
  return {
    platform: "win32",
    appData: "R",
    localAppData: "L",
    home: "H",
    exists: (p) => dirs.has(p),
    list: (d) => over.listing?.[d] ?? [],
    ...over,
  };
}

test("desktopConfigPath prefers %APPDATA%\\Claude", () => {
  assert.equal(
    desktopConfigPath(env({ dirs: [path.join("R", "Claude")] })),
    path.join("R", "Claude", "claude_desktop_config.json"),
  );
});

test("desktopConfigPath falls back to a Microsoft Store install", () => {
  const store = path.join("L", "Packages", "Claude_abc123", "LocalCache", "Roaming", "Claude");
  assert.equal(
    desktopConfigPath(env({ dirs: [store], listing: { [path.join("L", "Packages")]: ["Other_x", "Claude_abc123"] } })),
    path.join(store, "claude_desktop_config.json"),
  );
});

test("desktopConfigPath is null when Claude Desktop isn't installed, and knows macOS", () => {
  assert.equal(desktopConfigPath(env({})), null);
  const mac = path.join("H", "Library", "Application Support", "Claude");
  assert.equal(desktopConfigPath(env({ platform: "darwin", dirs: [mac] })), path.join(mac, "claude_desktop_config.json"));
  assert.equal(desktopConfigPath(env({ platform: "linux" })), null);
});

test("withEntry adds our server and keeps every other key and server in order", () => {
  const before = { mcpServers: { a: foreign }, preferences: { x: 1 }, other: "keep" };
  const after = withEntry(before, ours);
  assert.deepEqual(Object.keys(after), ["mcpServers", "preferences", "other"]);
  assert.deepEqual(after.mcpServers, { a: foreign, "skill-vault": ours });
  assert.deepEqual(withEntry(after, ours), after);
  assert.deepEqual(withEntry({}, ours), { mcpServers: { "skill-vault": ours } });
  assert.deepEqual(before.mcpServers, { a: foreign }, "input is not mutated");
});

test("withEntry refuses a foreign skill-vault entry and a non-object mcpServers", () => {
  assert.throws(() => withEntry({ mcpServers: { "skill-vault": foreign } }, ours), DesktopConfigError);
  assert.throws(() => withEntry({ mcpServers: [] }, ours), DesktopConfigError);
});

test("withoutEntry removes only our entry", () => {
  assert.deepEqual(withoutEntry({ mcpServers: { a: foreign, "skill-vault": ours }, p: 1 }), { mcpServers: { a: foreign }, p: 1 });
  const theirs = { mcpServers: { "skill-vault": foreign } };
  assert.deepEqual(withoutEntry(theirs), theirs);
  assert.deepEqual(withoutEntry({ p: 1 }), { p: 1 });
});

test("isOurEntry and entryState", () => {
  assert.equal(isOurEntry(ours), true);
  assert.equal(isOurEntry({ command: "node", args: ["C:\\x\\dist\\assistant-mcp.js"] }), true);
  assert.equal(isOurEntry(foreign), false);
  const all = () => true;
  assert.equal(entryState(undefined, all), "not_connected");
  assert.equal(entryState(foreign, all), "name_taken");
  assert.equal(entryState(ours, all), "connected");
  assert.equal(entryState(ours, (p) => p !== ours.command), "broken");
  assert.equal(getEntry({ mcpServers: { "skill-vault": ours } }), ours);
});

test("readDesktopConfig: missing or empty file is {}, a BOM is fine, bad JSON and non-objects are refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-desk-"));
  try {
    const f = path.join(dir, "claude_desktop_config.json");
    assert.deepEqual(readDesktopConfig(f), {});
    fs.writeFileSync(f, "");
    assert.deepEqual(readDesktopConfig(f), {});
    fs.writeFileSync(f, '\uFEFF{"a":1}');
    assert.deepEqual(readDesktopConfig(f), { a: 1 });
    fs.writeFileSync(f, "{ nope");
    assert.throws(() => readDesktopConfig(f), (e: unknown) => e instanceof DesktopConfigError && /valid JSON/.test(e.message));
    fs.writeFileSync(f, "[1]");
    assert.throws(() => readDesktopConfig(f), DesktopConfigError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeDesktopConfig backs up the old file and writes atomically", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-desk-"));
  try {
    const f = path.join(dir, "claude_desktop_config.json");
    fs.writeFileSync(f, '{"old":true}');
    writeDesktopConfig(f, { new: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf-8")), { new: true });
    assert.equal(fs.readFileSync(`${f}.skill-vault.bak`, "utf-8"), '{"old":true}');
    assert.deepEqual(fs.readdirSync(dir).sort(), ["claude_desktop_config.json", "claude_desktop_config.json.skill-vault.bak"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test server/services/agentAccess/desktopConfig.test.ts`
Expected: FAIL — cannot find module `./desktopConfig.ts`.

- [ ] **Step 3: Implement**

`app/server/services/agentAccess/desktopConfig.ts`:

```ts
/**
 * Claude Desktop's MCP config (claude_desktop_config.json): find it, and
 * add or remove the "skill-vault" server entry that runs this app's bridge.
 *
 * withEntry / withoutEntry are pure (config in → config out); every key
 * other than mcpServers["skill-vault"] comes back exactly as parsed.
 * readDesktopConfig / writeDesktopConfig do the disk work, with a backup
 * and an atomic rename.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SERVER_NAME = "skill-vault";
const CONFIG_FILE = "claude_desktop_config.json";

export type JsonObject = Record<string, unknown>;

export interface McpEntry {
  command: string;
  args: string[];
}

export interface PathEnv {
  platform: NodeJS.Platform;
  appData?: string;
  localAppData?: string;
  home: string;
  exists: (p: string) => boolean;
  list: (dir: string) => string[];
}

export function realPathEnv(): PathEnv {
  return {
    platform: process.platform,
    appData: process.env.APPDATA,
    localAppData: process.env.LOCALAPPDATA,
    home: os.homedir(),
    exists: (p) => fs.existsSync(p),
    list: (dir) => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
  };
}

/** The config file Claude Desktop reads, or null when Claude Desktop isn't installed for this user. */
export function desktopConfigPath(env: PathEnv): string | null {
  if (env.platform === "win32") {
    if (env.appData && env.exists(path.join(env.appData, "Claude"))) {
      return path.join(env.appData, "Claude", CONFIG_FILE);
    }
    if (env.localAppData) {
      const packages = path.join(env.localAppData, "Packages");
      for (const name of env.list(packages)) {
        if (!name.startsWith("Claude_")) continue;
        const dir = path.join(packages, name, "LocalCache", "Roaming", "Claude");
        if (env.exists(dir)) return path.join(dir, CONFIG_FILE);
      }
    }
    return null;
  }
  if (env.platform === "darwin") {
    const dir = path.join(env.home, "Library", "Application Support", "Claude");
    return env.exists(dir) ? path.join(dir, CONFIG_FILE) : null;
  }
  return null;
}

export function bridgeEntry(nodePath: string, bridgePath: string, client: string): McpEntry {
  return { command: nodePath, args: [bridgePath, "--client", client] };
}

/** True when the entry runs a Skill Vault bridge (from any install location). */
export function isOurEntry(entry: unknown): boolean {
  const args = (entry as { args?: unknown } | null | undefined)?.args;
  return Array.isArray(args) && typeof args[0] === "string" && args[0].replace(/\\/g, "/").endsWith("dist/assistant-mcp.js");
}

export type EntryState = "not_connected" | "connected" | "broken" | "name_taken";

export function entryState(entry: unknown, exists: (p: string) => boolean): EntryState {
  if (entry === undefined) return "not_connected";
  if (!isOurEntry(entry)) return "name_taken";
  const e = entry as McpEntry;
  return exists(e.command) && exists(e.args[0]) ? "connected" : "broken";
}

export class DesktopConfigError extends Error {}

function serversOf(config: JsonObject): JsonObject | undefined {
  const s = config.mcpServers;
  if (s === undefined) return undefined;
  if (s === null || typeof s !== "object" || Array.isArray(s)) {
    throw new DesktopConfigError("mcpServers in the Claude Desktop config isn't an object");
  }
  return s as JsonObject;
}

export function getEntry(config: JsonObject): unknown {
  return serversOf(config)?.[SERVER_NAME];
}

export function withEntry(config: JsonObject, entry: McpEntry): JsonObject {
  const servers = serversOf(config);
  const existing = servers?.[SERVER_NAME];
  if (existing !== undefined && !isOurEntry(existing)) {
    throw new DesktopConfigError(`Claude Desktop already has an MCP server named "${SERVER_NAME}" that isn't from Skill Vault`);
  }
  return { ...config, mcpServers: { ...(servers ?? {}), [SERVER_NAME]: entry } };
}

export function withoutEntry(config: JsonObject): JsonObject {
  const servers = serversOf(config);
  if (!servers || !isOurEntry(servers[SERVER_NAME])) return config;
  const rest = { ...servers };
  delete rest[SERVER_NAME];
  return { ...config, mcpServers: rest };
}

/** Parse the config. A missing or empty file is {}; anything but a JSON object throws. */
export function readDesktopConfig(file: string): JsonObject {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new DesktopConfigError(`Couldn't read ${file}: ${(err as Error).message}`);
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (err) {
    throw new DesktopConfigError(`${file} isn't valid JSON (${(err as Error).message}). Fix it, then try again.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DesktopConfigError(`${file} doesn't hold a JSON object`);
  }
  return parsed as JsonObject;
}

/** Copy the current file to <file>.skill-vault.bak, then write through a temp file and rename. */
export function writeDesktopConfig(file: string, config: JsonObject): void {
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, `${file}.skill-vault.bak`);
    } catch (err) {
      throw new DesktopConfigError(`Couldn't back up ${file}: ${(err as Error).message}`);
    }
  }
  const tmp = `${file}.skill-vault.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}
```

- [ ] **Step 4: Run the test**

Run: `node --import tsx --test server/services/agentAccess/desktopConfig.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/agentAccess/desktopConfig.ts server/services/agentAccess/desktopConfig.test.ts
git commit -m "agent access: find and edit Claude Desktop's MCP config safely

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Claude Code connection

**Files:**
- Create: `app/server/services/agentAccess/claudeCode.ts`
- Test: `app/server/services/agentAccess/claudeCode.test.ts`

**Interfaces:**
- Consumes: `defaultRunner`, `type ClaudeRunner` (`services/claude/cli.ts` — `(args, stdin, { cwd, timeoutMs }) => Promise<{ stdout, stderr, code }>`); `isOurEntry`, `SERVER_NAME` (Task 8)
- Produces: `claudeCodeConfigPath(home?): string`, `readClaudeCodeEntry(file?): unknown`, `addArgs(nodePath, bridgePath): string[]`, `REMOVE_ARGS: string[]`, `class ClaudeCodeError`, `connectClaudeCode(nodePath, bridgePath, entry: unknown, runner?): Promise<void>`, `disconnectClaudeCode(entry: unknown, runner?): Promise<void>`

Design note: status is read from `~/.claude.json` (where `claude mcp add --scope user` writes) rather than `claude mcp get`, because `get` health-checks by starting the server. Changes always go through the CLI.

- [ ] **Step 1: Write the failing test**

`app/server/services/agentAccess/claudeCode.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClaudeRunner } from "../claude/cli.ts";
import { ClaudeCodeError, REMOVE_ARGS, addArgs, connectClaudeCode, disconnectClaudeCode, readClaudeCodeEntry } from "./claudeCode.ts";

const ours = { type: "stdio", command: "node", args: ["C:/a/dist/assistant-mcp.js", "--client", "claude-code"] };
const foreign = { type: "stdio", command: "npx", args: ["other"] };

function runner(results: Array<{ code: number; stderr?: string }> = []): ClaudeRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const queue = results.slice();
  const r = (async (args: string[]) => {
    calls.push(args);
    const next = queue.shift() ?? { code: 0 };
    return { stdout: "", stderr: next.stderr ?? "", code: next.code };
  }) as ClaudeRunner & { calls: string[][] };
  r.calls = calls;
  return r;
}

test("addArgs registers the bridge at user scope", () => {
  assert.deepEqual(addArgs("N", "B"), ["mcp", "add", "--scope", "user", "skill-vault", "--", "N", "B", "--client", "claude-code"]);
  assert.deepEqual(REMOVE_ARGS, ["mcp", "remove", "--scope", "user", "skill-vault"]);
});

test("connect adds when missing, and replaces our own entry", async () => {
  const fresh = runner();
  await connectClaudeCode("N", "B", undefined, fresh);
  assert.deepEqual(fresh.calls, [addArgs("N", "B")]);

  const again = runner();
  await connectClaudeCode("N", "B", ours, again);
  assert.deepEqual(again.calls, [REMOVE_ARGS, addArgs("N", "B")]);
});

test("connect refuses a foreign entry and reports CLI failures", async () => {
  const r = runner();
  await assert.rejects(connectClaudeCode("N", "B", foreign, r), ClaudeCodeError);
  assert.deepEqual(r.calls, []);

  const failing = runner([{ code: 1, stderr: "boom" }]);
  await assert.rejects(connectClaudeCode("N", "B", undefined, failing), (e: unknown) => e instanceof ClaudeCodeError && /boom/.test(e.message));

  const missing = (async () => {
    throw new Error("spawn claude ENOENT");
  }) as unknown as ClaudeRunner;
  await assert.rejects(connectClaudeCode("N", "B", undefined, missing), (e: unknown) => e instanceof ClaudeCodeError && /claude CLI/.test(e.message));
});

test("disconnect removes only our entry", async () => {
  const r = runner();
  await disconnectClaudeCode(ours, r);
  await disconnectClaudeCode(foreign, r);
  await disconnectClaudeCode(undefined, r);
  assert.deepEqual(r.calls, [REMOVE_ARGS]);
});

test("readClaudeCodeEntry reads the user-scope entry and tolerates a missing or broken file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-cc-"));
  try {
    const f = path.join(dir, ".claude.json");
    assert.equal(readClaudeCodeEntry(f), undefined);
    fs.writeFileSync(f, JSON.stringify({ mcpServers: { "skill-vault": ours }, projects: {} }));
    assert.deepEqual(readClaudeCodeEntry(f), ours);
    fs.writeFileSync(f, "{");
    assert.equal(readClaudeCodeEntry(f), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test server/services/agentAccess/claudeCode.test.ts`
Expected: FAIL — cannot find module `./claudeCode.ts`.

- [ ] **Step 3: Implement**

`app/server/services/agentAccess/claudeCode.ts`:

```ts
/**
 * Claude Code's user-scope MCP entry for the vault bridge.
 *
 * Status is read from ~/.claude.json, where `claude mcp add --scope user`
 * writes; `claude mcp get` would start the server to health-check it.
 * Changes always go through the CLI, never by editing that file: Claude
 * Code rewrites it constantly.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRunner, type ClaudeRunner } from "../claude/cli.ts";
import { SERVER_NAME, isOurEntry } from "./desktopConfig.ts";

export function claudeCodeConfigPath(home = os.homedir()): string {
  return path.join(home, ".claude.json");
}

/** The user-scope "skill-vault" entry, or undefined (none, or the file can't be read). */
export function readClaudeCodeEntry(file = claudeCodeConfigPath()): unknown {
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf-8")) as { mcpServers?: Record<string, unknown> };
    return json?.mcpServers?.[SERVER_NAME];
  } catch {
    return undefined;
  }
}

export function addArgs(nodePath: string, bridgePath: string): string[] {
  return ["mcp", "add", "--scope", "user", SERVER_NAME, "--", nodePath, bridgePath, "--client", "claude-code"];
}

export const REMOVE_ARGS = ["mcp", "remove", "--scope", "user", SERVER_NAME];

export class ClaudeCodeError extends Error {}

async function run(runner: ClaudeRunner, args: string[]): Promise<void> {
  let r: { stdout: string; stderr: string; code: number | null };
  try {
    r = await runner(args, "", { cwd: os.tmpdir(), timeoutMs: 30_000 });
  } catch (err) {
    throw new ClaudeCodeError(`Couldn't run the claude CLI: ${(err as Error).message}`);
  }
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim() || `exit code ${r.code}`;
    throw new ClaudeCodeError(`claude ${args.slice(0, 2).join(" ")} failed: ${detail}`);
  }
}

/** Add the entry, replacing our own if it's there. A foreign entry with the same name is refused. */
export async function connectClaudeCode(
  nodePath: string,
  bridgePath: string,
  entry: unknown,
  runner: ClaudeRunner = defaultRunner,
): Promise<void> {
  if (entry !== undefined && !isOurEntry(entry)) {
    throw new ClaudeCodeError(`Claude Code already has an MCP server named "${SERVER_NAME}" that isn't from Skill Vault`);
  }
  if (entry !== undefined) await run(runner, REMOVE_ARGS);
  await run(runner, addArgs(nodePath, bridgePath));
}

export async function disconnectClaudeCode(entry: unknown, runner: ClaudeRunner = defaultRunner): Promise<void> {
  if (entry === undefined || !isOurEntry(entry)) return;
  await run(runner, REMOVE_ARGS);
}
```

- [ ] **Step 4: Run the test**

Run: `node --import tsx --test server/services/agentAccess/claudeCode.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/agentAccess/claudeCode.ts server/services/agentAccess/claudeCode.test.ts
git commit -m "agent access: connect Claude Code with claude mcp add --scope user

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The shared `skill-vault` command

**Files:**
- Create: `app/server/services/agentAccess/commandShim.ts`
- Test: `app/server/services/agentAccess/commandShim.test.ts`
- Modify: `app/server/index.ts` (write shims at production start)

**Interfaces:**
- Produces: `shimDir(home?): string` (`~/.skill-vault/bin`), `shimContents(nodePath, bridgePath): { cmd: string; sh: string }`, `writeCommandShims(nodePath, bridgePath, dir?): string[]` (files written)

- [ ] **Step 1: Write the failing test**

`app/server/services/agentAccess/commandShim.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shimContents, shimDir, writeCommandShims } from "./commandShim.ts";

test("shimContents runs the bridge in command mode for cmd and sh", () => {
  const { cmd, sh } = shimContents("C:\\node\\node.exe", "C:\\app\\dist\\assistant-mcp.js");
  assert.equal(cmd, '@echo off\r\n"C:\\node\\node.exe" "C:\\app\\dist\\assistant-mcp.js" --client command %*\r\n');
  assert.equal(sh, '#!/bin/sh\nexec "C:/node/node.exe" "C:/app/dist/assistant-mcp.js" --client command "$@"\n');
});

test("shimDir is ~/.skill-vault/bin", () => {
  assert.equal(shimDir("H"), path.join("H", ".skill-vault", "bin"));
});

test("writeCommandShims writes both files and rewrites only on change", () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sv-shim-")), "bin");
  try {
    assert.deepEqual(writeCommandShims("N1", "B", dir).map((f) => path.basename(f)).sort(), ["skill-vault", "skill-vault.cmd"]);
    assert.deepEqual(writeCommandShims("N1", "B", dir), []);
    assert.equal(writeCommandShims("N2", "B", dir).length, 2);
    assert.match(fs.readFileSync(path.join(dir, "skill-vault.cmd"), "utf-8"), /"N2"/);
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test server/services/agentAccess/commandShim.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

`app/server/services/agentAccess/commandShim.ts`:

```ts
/**
 * ~/.skill-vault/bin/skill-vault(.cmd): the shared command that gives any
 * agent with a shell the vault tools (the bridge's command mode, see
 * assistant-mcp/cli.ts). Rewritten at every production start so the node
 * and app paths stay current.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function shimDir(home = os.homedir()): string {
  return path.join(home, ".skill-vault", "bin");
}

export function shimContents(nodePath: string, bridgePath: string): { cmd: string; sh: string } {
  const fwd = (p: string) => p.replace(/\\/g, "/");
  return {
    cmd: `@echo off\r\n"${nodePath}" "${bridgePath}" --client command %*\r\n`,
    sh: `#!/bin/sh\nexec "${fwd(nodePath)}" "${fwd(bridgePath)}" --client command "$@"\n`,
  };
}

/** Write both shims; a file is rewritten only when its content differs. Returns the files written. */
export function writeCommandShims(nodePath: string, bridgePath: string, dir = shimDir()): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const { cmd, sh } = shimContents(nodePath, bridgePath);
  const written: string[] = [];
  for (const [file, content, executable] of [
    [path.join(dir, "skill-vault.cmd"), cmd, false],
    [path.join(dir, "skill-vault"), sh, true],
  ] as const) {
    let current: string | null = null;
    try {
      current = fs.readFileSync(file, "utf-8");
    } catch {
      /* not written yet */
    }
    if (current === content) continue;
    fs.writeFileSync(file, content, "utf-8");
    if (executable && process.platform !== "win32") fs.chmodSync(file, 0o755);
    written.push(file);
  }
  return written;
}
```

- [ ] **Step 4: Run the test**

Run: `node --import tsx --test server/services/agentAccess/commandShim.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the shims at production start**

In `app/server/index.ts` add the import:

```ts
import { writeCommandShims } from "./services/agentAccess/commandShim.ts";
```

and directly after `if (opts.mode === "production") updater.start();` add:

```ts
  // ~/.skill-vault/bin/skill-vault: the vault tools for agents with a shell
  // (services/agentAccess/commandShim.ts). Built app only: it runs dist/.
  if (opts.mode === "production") {
    try {
      writeCommandShims(process.execPath, path.join(APP_ROOT, "dist", "assistant-mcp.js"));
    } catch (err) {
      console.error(`[agent-access] couldn't write the skill-vault command: ${(err as Error).message}`);
    }
  }
```

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm test`
Expected: clean, all pass.

```bash
git add server/services/agentAccess/commandShim.ts server/services/agentAccess/commandShim.test.ts server/index.ts
git commit -m "agent access: write the shared skill-vault command at production start

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Agent access routes

**Files:**
- Create: `app/server/routes/agentAccess.ts`
- Test: `app/server/routes/agentAccess.test.ts`
- Modify: `app/server/services/desktopPackaging.ts` (zip any folder; move `recordDesktopPackage` here), `app/server/routes/desktop.ts` (import it), `app/server/types/vault.ts` (`AgentAccessStatus`), `app/server/index.ts` (mount)

**Interfaces:**
- Consumes: Tasks 7–10; `importSkills(vaultPath, sourceDir, names, providerId?, paths?, items?, opts?)` (`services/adoption.ts`); `pushSkillToProvider(vaultPath, skill, provider)` (`services/pushSkill.ts`); `claudeAvailable()` (`services/claude/cli.ts`); `readAppConfig()`, `readClaudeDesktopStage()` (`services/appConfig.ts`); `hashSkillDirNormalized` (`services/skillHash.ts`); `readManifest`, `writeManifest`, `skillDir` (`services/vault.ts`); `refuseCrossSiteWrites`
- Produces: `packageFolderForClaudeDesktop(folder, stageDir, name): Promise<string>`, `recordDesktopPackage(vaultPath, skill, contentHash, packagedAt): void` (moved), `agentAccessRouter(opts: AgentAccessOptions): Router`, `AgentAccessStatus` (below). Routes as in the spec table.

```ts
// server/types/vault.ts
export type AgentEntryState = "not_connected" | "connected" | "broken" | "name_taken";
export interface AgentAccessStatus {
  bridge_built: boolean;
  skill: { state: "no_vault" | "not_in_vault" | "in_vault" | "update_available" | "name_taken"; targets: string[] };
  claude_desktop: { state: AgentEntryState | "not_installed" | "unreadable"; config_path: string | null; error?: string };
  claude_code: { state: AgentEntryState | "cli_missing"; reason?: string };
  command: { windows: string; posix: string };
}
```

- [ ] **Step 1: Generalize packaging**

In `app/server/services/desktopPackaging.ts`, add `import { readManifest, writeManifest } from "./vault.ts";` and replace `packageForClaudeDesktop` with:

```ts
export async function packageForClaudeDesktop(
  vaultPath: string,
  stageDir: string,
  skillName: string,
): Promise<string> {
  return packageFolderForClaudeDesktop(path.join(vaultPath, "skills", skillName), stageDir, skillName);
}

/** Zip any skill folder in the claude.ai upload format (used for the bundled skill-vault skill too). */
export async function packageFolderForClaudeDesktop(
  skillFolder: string,
  stageDir: string,
  skillName: string,
): Promise<string> {
  if (!fs.existsSync(skillFolder) || !fs.statSync(skillFolder).isDirectory()) {
    throw new Error(`skill folder not found: ${skillFolder}`);
  }
  fs.mkdirSync(stageDir, { recursive: true });
  const outputPath = path.join(stageDir, `${skillName}.zip`);
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    // Wrapper folder = the claude.ai upload contract.
    archive.directory(skillFolder, skillName);
    archive.finalize();
  });
  return outputPath;
}
```

Move `recordDesktopPackage` (with its doc comment) from `routes/desktop.ts` into `desktopPackaging.ts` as an export, unchanged. In `routes/desktop.ts` delete the local copy, drop `writeManifest` from its `../services/vault.ts` import if now unused, and import `recordDesktopPackage` from `../services/desktopPackaging.ts`.

Run: `npm run typecheck && npm test` — expected clean/pass (pure refactor).

- [ ] **Step 2: Add the status type**

Append the `AgentEntryState` / `AgentAccessStatus` block above to `app/server/types/vault.ts`.

- [ ] **Step 3: Write the failing route test**

`app/server/routes/agentAccess.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";

let root: string;
let fakeHome: string;
let vault: string;
let appRoot: string;
let claudeDir: string;
let providerDir: string;
let stageDir: string;
let server: Server;
let url: string;
let ccEntry: unknown;
const ccCalls: string[][] = [];
const opened: string[] = [];

const SKILL_MD = "---\nname: skill-vault\ndescription: test skill for the agent access routes\n---\n\nBody\n";

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-agent-"));
  fakeHome = path.join(root, "home");
  vault = path.join(root, "vault");
  appRoot = path.join(root, "app");
  claudeDir = path.join(root, "appdata", "Claude");
  providerDir = path.join(root, "claude-skills");
  stageDir = path.join(root, "stage");
  for (const d of [fakeHome, vault, claudeDir, providerDir, path.join(appRoot, "bundled-skills", "skill-vault"), path.join(appRoot, "dist")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(path.join(appRoot, "bundled-skills", "skill-vault", "SKILL.md"), SKILL_MD);
  fs.writeFileSync(path.join(appRoot, "dist", "assistant-mcp.js"), "// bridge");
  fs.mkdirSync(path.join(fakeHome, ".skill-vault"), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, ".skill-vault", "config.json"),
    JSON.stringify({ vault_path: vault, agent_locations: { claude: providerDir }, default_targets: ["claude"], claude_desktop_stage: stageDir }) + "\n",
  );
  fs.writeFileSync(path.join(claudeDir, "claude_desktop_config.json"), JSON.stringify({ mcpServers: { other: { command: "x", args: [] } }, preferences: { a: 1 } }));
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;

  const express = (await import("express")).default;
  const { agentAccessRouter } = await import("./agentAccess.ts");
  const { initVault } = await import("../services/vault.ts");
  initVault(vault);

  const app = express();
  app.use(express.json());
  app.use(
    "/api/agent-access",
    agentAccessRouter({
      appRoot,
      nodePath: process.execPath,
      pathEnv: () => ({
        platform: "win32",
        appData: path.dirname(claudeDir),
        home: fakeHome,
        exists: (p) => fs.existsSync(p),
        list: () => [],
      }),
      claudeAvailable: async () => ({ available: true }),
      claudeCodeEntry: () => ccEntry,
      claudeRunner: async (args) => {
        ccCalls.push(args);
        if (args[1] === "add") ccEntry = { command: args[6], args: args.slice(7) };
        if (args[1] === "remove") ccEntry = undefined;
        return { stdout: "", stderr: "", code: 0 };
      },
      openFolder: async (dir) => {
        opened.push(dir);
      },
    }),
  );
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api/agent-access`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

const get = async () => (await fetch(url)).json() as Promise<Record<string, any>>;
const post = (p: string, headers: Record<string, string> = {}) => fetch(`${url}${p}`, { method: "POST", headers });

test("status before anything is connected", async () => {
  const s = await get();
  assert.equal(s.bridge_built, true);
  assert.equal(s.skill.state, "not_in_vault");
  assert.equal(s.claude_desktop.state, "not_connected");
  assert.equal(s.claude_code.state, "not_connected");
  assert.match(s.command.windows, /skill-vault\.cmd$/);
});

test("add to vault adopts the bundled skill with a dir origin and pushes it to the default targets", async () => {
  const res = await post("/skill/add");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { pushed: string[] };
  assert.deepEqual(body.pushed, ["claude"]);
  const entry = JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf-8")).skills["skill-vault"];
  assert.equal(entry.origin.type, "dir");
  assert.equal(entry.origin.subpath, "skill-vault");
  assert.ok(fs.existsSync(path.join(providerDir, "skill-vault", "SKILL.md")));
  assert.equal((await get()).skill.state, "in_vault");
});

test("a changed bundled copy shows update available, and add refreshes it", async () => {
  fs.writeFileSync(path.join(appRoot, "bundled-skills", "skill-vault", "SKILL.md"), SKILL_MD + "\nMore\n");
  assert.equal((await get()).skill.state, "update_available");
  assert.equal((await post("/skill/add")).status, 200);
  const s = await get();
  assert.equal(s.skill.state, "in_vault");
  assert.deepEqual(s.skill.targets, ["claude"]);
});

test("the prompt carries the bundled SKILL.md", async () => {
  const { prompt } = (await (await fetch(`${url}/skill/prompt`)).json()) as { prompt: string };
  assert.ok(prompt.includes("name: skill-vault"));
});

test("zip builds skill-vault.zip in the staging folder and opens it", async () => {
  const res = await post("/skill/zip");
  assert.equal(res.status, 200);
  assert.ok(fs.existsSync(path.join(stageDir, "skill-vault.zip")));
  assert.deepEqual(opened, [stageDir]);
});

test("Claude Desktop connect and disconnect keep the rest of the config", async () => {
  const file = path.join(claudeDir, "claude_desktop_config.json");
  assert.equal((await post("/desktop/connect")).status, 200);
  const cfg = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.deepEqual(Object.keys(cfg.mcpServers), ["other", "skill-vault"]);
  assert.deepEqual(cfg.preferences, { a: 1 });
  assert.equal(cfg.mcpServers["skill-vault"].args[1], "--client");
  assert.ok(fs.existsSync(`${file}.skill-vault.bak`));
  assert.equal((await get()).claude_desktop.state, "connected");
  assert.equal((await post("/desktop/disconnect")).status, 200);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf-8")).mcpServers), ["other"]);
});

test("Claude Desktop connect refuses a broken config and leaves it alone", async () => {
  const file = path.join(claudeDir, "claude_desktop_config.json");
  const good = fs.readFileSync(file, "utf-8");
  fs.writeFileSync(file, "{ broken");
  const res = await post("/desktop/connect");
  assert.equal(res.status, 409);
  assert.equal(fs.readFileSync(file, "utf-8"), "{ broken");
  assert.equal((await get()).claude_desktop.state, "unreadable");
  fs.writeFileSync(file, good);
});

test("Claude Code connect runs claude mcp add, disconnect runs remove", async () => {
  assert.equal((await post("/claude-code/connect")).status, 200);
  assert.deepEqual(ccCalls[0].slice(0, 6), ["mcp", "add", "--scope", "user", "skill-vault", "--"]);
  assert.equal((await get()).claude_code.state, "connected");
  assert.equal((await post("/claude-code/disconnect")).status, 200);
  assert.deepEqual(ccCalls[1], ["mcp", "remove", "--scope", "user", "skill-vault"]);
});

test("cross-site writes are refused", async () => {
  assert.equal((await post("/desktop/connect", { origin: "https://evil.example" })).status, 403);
});

test("a vault skill named skill-vault from elsewhere blocks add", async () => {
  const manifestFile = path.join(vault, "skills.json");
  const m = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
  delete m.skills["skill-vault"].origin;
  fs.writeFileSync(manifestFile, JSON.stringify(m));
  assert.equal((await get()).skill.state, "name_taken");
  assert.equal((await post("/skill/add")).status, 409);
});
```

Note: `connected` for Claude Code requires both paths to exist; the fake runner's entry uses `process.execPath` and the fake `dist/assistant-mcp.js`, which do.

- [ ] **Step 4: Run it to verify it fails**

Run: `node --import tsx --test server/routes/agentAccess.test.ts`
Expected: FAIL — cannot find module `./agentAccess.ts`.

- [ ] **Step 5: Implement the router**

`app/server/routes/agentAccess.ts`:

```ts
/**
 * Settings → Agent access: give Claude Desktop, Claude Code and any agent
 * with a shell the vault tools, and put the bundled skill-vault skill in the
 * vault (docs/superpowers/specs/2026-10-29-agent-access-design.md).
 *
 *   GET  /api/agent-access                         status of every row
 *   POST /api/agent-access/skill/add               adopt (or refresh) the bundled skill; new → push to default targets
 *   GET  /api/agent-access/skill/prompt            the copy-paste install prompt
 *   POST /api/agent-access/skill/zip               upload-ready zip, then open the staging folder
 *   POST /api/agent-access/desktop/connect         add the MCP entry to claude_desktop_config.json
 *   POST /api/agent-access/desktop/disconnect
 *   POST /api/agent-access/claude-code/connect     claude mcp add --scope user
 *   POST /api/agent-access/claude-code/disconnect
 *
 * Connect/disconnect are settings changes: they log to the server log, not
 * the activity feed (ActivityKind has no kind for them).
 */
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import open from "open";
import { readAppConfig, readClaudeDesktopStage } from "../services/appConfig.ts";
import { recordActivity } from "../services/activity.ts";
import { importSkills } from "../services/adoption.ts";
import { claudeAvailable as realClaudeAvailable, type ClaudeRunner } from "../services/claude/cli.ts";
import { defaultStageDir, packageFolderForClaudeDesktop, recordDesktopPackage } from "../services/desktopPackaging.ts";
import { pushSkillToProvider } from "../services/pushSkill.ts";
import { hashSkillDirNormalized } from "../services/skillHash.ts";
import { readManifest, skillDir } from "../services/vault.ts";
import {
  BUNDLED_SKILL_NAME, bundledSkillDir, bundledSkillsRoot, installPrompt, readBundledSkillMd,
} from "../services/agentAccess/bundledSkill.ts";
import {
  DesktopConfigError, bridgeEntry, desktopConfigPath, entryState, getEntry, readDesktopConfig,
  realPathEnv, withEntry, withoutEntry, writeDesktopConfig, type PathEnv,
} from "../services/agentAccess/desktopConfig.ts";
import { ClaudeCodeError, connectClaudeCode, disconnectClaudeCode, readClaudeCodeEntry } from "../services/agentAccess/claudeCode.ts";
import { shimDir } from "../services/agentAccess/commandShim.ts";
import type { AgentAccessStatus } from "../types/vault.ts";
import { refuseCrossSiteWrites } from "./sameOrigin.ts";

export interface AgentAccessOptions {
  appRoot: string;
  /** The node that runs the bridge; defaults to the one running this server. */
  nodePath?: string;
  pathEnv?: () => PathEnv;
  claudeRunner?: ClaudeRunner;
  claudeAvailable?: () => Promise<{ available: boolean; reason?: string }>;
  claudeCodeEntry?: () => unknown;
  openFolder?: (dir: string) => Promise<unknown>;
}

const samePath = (a: string | undefined, b: string): boolean =>
  !!a && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export function agentAccessRouter(opts: AgentAccessOptions): Router {
  const router = Router();
  router.use(refuseCrossSiteWrites);

  const nodePath = opts.nodePath ?? process.execPath;
  const bridgePath = path.join(opts.appRoot, "dist", "assistant-mcp.js");
  const pathEnv = opts.pathEnv ?? realPathEnv;
  const isAvailable = opts.claudeAvailable ?? (() => realClaudeAvailable());
  const ccEntry = opts.claudeCodeEntry ?? (() => readClaudeCodeEntry());
  const openFolder = opts.openFolder ?? ((dir: string) => open(dir));

  function skillRow(): AgentAccessStatus["skill"] {
    const cfg = readAppConfig();
    if (!cfg.vault_path) return { state: "no_vault", targets: [] };
    const entry = readManifest(cfg.vault_path).skills[BUNDLED_SKILL_NAME];
    const onDisk = fs.existsSync(skillDir(cfg.vault_path, BUNDLED_SKILL_NAME));
    if (!entry && !onDisk) return { state: "not_in_vault", targets: [] };
    const origin = entry?.origin;
    const ours =
      origin?.type === "dir" && samePath(origin.path, bundledSkillsRoot(opts.appRoot)) && origin.subpath === BUNDLED_SKILL_NAME;
    if (!entry || !ours) return { state: "name_taken", targets: entry?.targets ?? [] };
    const same =
      hashSkillDirNormalized(skillDir(cfg.vault_path, BUNDLED_SKILL_NAME)) === hashSkillDirNormalized(bundledSkillDir(opts.appRoot));
    return { state: same ? "in_vault" : "update_available", targets: entry.targets };
  }

  function desktopRow(): AgentAccessStatus["claude_desktop"] {
    const file = desktopConfigPath(pathEnv());
    if (!file) return { state: "not_installed", config_path: null };
    try {
      return { state: entryState(getEntry(readDesktopConfig(file)), (p) => fs.existsSync(p)), config_path: file };
    } catch (err) {
      return { state: "unreadable", config_path: file, error: (err as Error).message };
    }
  }

  async function claudeCodeRow(): Promise<AgentAccessStatus["claude_code"]> {
    const avail = await isAvailable();
    if (!avail.available) return { state: "cli_missing", ...(avail.reason ? { reason: avail.reason } : {}) };
    return { state: entryState(ccEntry(), (p) => fs.existsSync(p)) };
  }

  const bridgeMissing = (res: import("express").Response): boolean => {
    if (fs.existsSync(bridgePath)) return false;
    res.status(409).json({ error: "Build the app first: the bridge (dist/assistant-mcp.js) isn't built yet." });
    return true;
  };

  router.get("/", async (_req, res) => {
    const out: AgentAccessStatus = {
      bridge_built: fs.existsSync(bridgePath),
      skill: skillRow(),
      claude_desktop: desktopRow(),
      claude_code: await claudeCodeRow(),
      command: { windows: path.join(shimDir(), "skill-vault.cmd"), posix: path.join(shimDir(), "skill-vault") },
    };
    res.json(out);
  });

  router.post("/skill/add", (_req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const vaultPath = cfg.vault_path;
    const row = skillRow();
    if (row.state === "name_taken") {
      res.status(409).json({ error: `Your vault already has a skill named "${BUNDLED_SKILL_NAME}" from somewhere else. Rename it to add this one.` });
      return;
    }
    const sourceRoot = bundledSkillsRoot(opts.appRoot);
    const result = importSkills(
      vaultPath,
      sourceRoot,
      [],
      undefined,
      undefined,
      [{ name: BUNDLED_SKILL_NAME, path: bundledSkillDir(opts.appRoot) }],
      { overwrite: row.state === "update_available", originContext: { type: "dir", root: sourceRoot } },
    );
    recordActivity({
      kind: "adopt",
      skill: BUNDLED_SKILL_NAME,
      ok: true,
      message: row.state === "update_available" ? "updated from the app's copy" : "added from the app",
    });
    // New to the vault: push to the default targets. A refresh keeps its
    // targets, and linked targets already point at the vault copy.
    const pushed: string[] = [];
    const failed: Array<{ provider_id: string; error: string }> = [];
    if (row.state === "not_in_vault") {
      for (const id of cfg.default_targets ?? []) {
        const provider = cfg.providers.find((p) => p.id === id);
        if (!provider) {
          failed.push({ provider_id: id, error: "not configured" });
          continue;
        }
        try {
          pushSkillToProvider(vaultPath, BUNDLED_SKILL_NAME, provider);
          pushed.push(id);
          recordActivity({ kind: "push", skill: BUNDLED_SKILL_NAME, provider_id: id, ok: true, message: "pushed" });
        } catch (err) {
          failed.push({ provider_id: id, error: (err as Error).message });
          recordActivity({ kind: "push", skill: BUNDLED_SKILL_NAME, provider_id: id, ok: false, message: (err as Error).message });
        }
      }
    }
    res.json({ ...result, pushed, failed, skill: skillRow() });
  });

  router.get("/skill/prompt", (_req, res) => {
    res.json({ prompt: installPrompt(readBundledSkillMd(opts.appRoot)) });
  });

  router.post("/skill/zip", async (_req, res) => {
    const cfg = readAppConfig();
    const stageDir = readClaudeDesktopStage() ?? (cfg.vault_path ? defaultStageDir(cfg.vault_path) : null);
    if (!stageDir) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const state = skillRow().state;
    const fromVault = !!cfg.vault_path && (state === "in_vault" || state === "update_available");
    const folder = fromVault ? skillDir(cfg.vault_path!, BUNDLED_SKILL_NAME) : bundledSkillDir(opts.appRoot);
    const zipPath = await packageFolderForClaudeDesktop(folder, stageDir, BUNDLED_SKILL_NAME);
    if (fromVault) {
      recordDesktopPackage(cfg.vault_path!, BUNDLED_SKILL_NAME, hashSkillDirNormalized(folder) ?? "empty", new Date().toISOString());
    }
    await openFolder(stageDir);
    res.json({ zip_path: zipPath, stage_dir: stageDir, from_vault: fromVault });
  });

  router.post("/desktop/connect", (_req, res) => {
    if (bridgeMissing(res)) return;
    const file = desktopConfigPath(pathEnv());
    if (!file) {
      res.status(404).json({ error: "Claude Desktop isn't installed for this user." });
      return;
    }
    try {
      writeDesktopConfig(file, withEntry(readDesktopConfig(file), bridgeEntry(nodePath, bridgePath, "claude-desktop")));
    } catch (err) {
      if (err instanceof DesktopConfigError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
    console.log(`[agent-access] connected Claude Desktop (${file})`);
    res.json(desktopRow());
  });

  router.post("/desktop/disconnect", (_req, res) => {
    const file = desktopConfigPath(pathEnv());
    if (!file) {
      res.status(404).json({ error: "Claude Desktop isn't installed for this user." });
      return;
    }
    try {
      const config = readDesktopConfig(file);
      const next = withoutEntry(config);
      if (next !== config) writeDesktopConfig(file, next);
    } catch (err) {
      if (err instanceof DesktopConfigError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
    console.log(`[agent-access] disconnected Claude Desktop (${file})`);
    res.json(desktopRow());
  });

  router.post("/claude-code/connect", async (_req, res) => {
    if (bridgeMissing(res)) return;
    try {
      await connectClaudeCode(nodePath, bridgePath, ccEntry(), opts.claudeRunner);
    } catch (err) {
      if (err instanceof ClaudeCodeError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
    console.log("[agent-access] connected Claude Code");
    res.json(await claudeCodeRow());
  });

  router.post("/claude-code/disconnect", async (_req, res) => {
    try {
      await disconnectClaudeCode(ccEntry(), opts.claudeRunner);
    } catch (err) {
      if (err instanceof ClaudeCodeError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
    console.log("[agent-access] disconnected Claude Code");
    res.json(await claudeCodeRow());
  });

  return router;
}
```

- [ ] **Step 6: Mount it**

In `app/server/index.ts` add `import { agentAccessRouter } from "./routes/agentAccess.ts";` with the route imports, and after `app.use("/api/desktop", desktopRouter());` add:

```ts
  app.use("/api/agent-access", agentAccessRouter({ appRoot: APP_ROOT }));
```

- [ ] **Step 7: Run the tests**

Run: `node --import tsx --test server/routes/agentAccess.test.ts`
Expected: PASS (10 tests). Then `npm run typecheck && npm test` — all pass.

- [ ] **Step 8: Commit**

```bash
git add server/routes/agentAccess.ts server/routes/agentAccess.test.ts server/routes/desktop.ts server/services/desktopPackaging.ts server/types/vault.ts server/index.ts
git commit -m "agent access: /api/agent-access status, skill add/zip/prompt, Desktop and Claude Code connect

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The Agent access card

**Files:**
- Create: `app/client/src/components/AgentAccessCard.tsx`
- Modify: `app/client/src/lib/types.ts`, `app/client/src/lib/api.ts`, `app/client/src/pages/Settings.tsx`

**Interfaces:**
- Consumes: `/api/agent-access` routes (Task 11); `Button`, `Rule` (`components/ui/primitives.tsx`); `api`, `ApiError` (`lib/api.ts`); `toast` (`sonner`)
- Produces: `<AgentAccessCard />` (no props)

- [ ] **Step 1: Client types**

Append to `app/client/src/lib/types.ts` (mirror of the server type):

```ts
export type AgentEntryState = "not_connected" | "connected" | "broken" | "name_taken";
export interface AgentAccessStatus {
  bridge_built: boolean;
  skill: { state: "no_vault" | "not_in_vault" | "in_vault" | "update_available" | "name_taken"; targets: string[] };
  claude_desktop: { state: AgentEntryState | "not_installed" | "unreadable"; config_path: string | null; error?: string };
  claude_code: { state: AgentEntryState | "cli_missing"; reason?: string };
  command: { windows: string; posix: string };
}
```

- [ ] **Step 2: API calls**

In `app/client/src/lib/api.ts` add `AgentAccessStatus` to the type import list, and add after the Claude Desktop block:

```ts
  // ── agent access (Settings → Agent access) ─────────────────
  agentAccess: () => request<AgentAccessStatus>("GET", "/api/agent-access"),
  addVaultSkill: () =>
    request<{ pushed: string[]; failed: Array<{ provider_id: string; error: string }> }>("POST", "/api/agent-access/skill/add"),
  vaultSkillPrompt: () => request<{ prompt: string }>("GET", "/api/agent-access/skill/prompt"),
  vaultSkillZip: () => request<{ zip_path: string; stage_dir: string }>("POST", "/api/agent-access/skill/zip"),
  connectDesktop: () => request<AgentAccessStatus["claude_desktop"]>("POST", "/api/agent-access/desktop/connect"),
  disconnectDesktop: () => request<AgentAccessStatus["claude_desktop"]>("POST", "/api/agent-access/desktop/disconnect"),
  connectClaudeCode: () => request<AgentAccessStatus["claude_code"]>("POST", "/api/agent-access/claude-code/connect"),
  disconnectClaudeCode: () => request<AgentAccessStatus["claude_code"]>("POST", "/api/agent-access/claude-code/disconnect"),
```

- [ ] **Step 3: The card**

`app/client/src/components/AgentAccessCard.tsx`:

```tsx
/**
 * Settings → Agent access: connect Claude Desktop and Claude Code to the
 * vault tools, put the skill-vault skill in the vault, and show the shared
 * command for other agents (server: routes/agentAccess.ts).
 */
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import type { AgentAccessStatus } from "../lib/types";
import { Button, Rule } from "./ui/primitives";

const ENTRY_TEXT: Record<string, string> = {
  not_connected: "Not connected",
  connected: "Connected",
  broken: "Broken: the entry points at a file that's gone. Reconnect to fix it.",
  name_taken: 'Another MCP server is already named "skill-vault". Rename it to connect this one.',
  not_installed: "Claude Desktop isn't installed for this user.",
  unreadable: "Can't read the Claude Desktop config.",
  cli_missing: "Claude Code CLI not found.",
};

const SKILL_TEXT: Record<AgentAccessStatus["skill"]["state"], string> = {
  no_vault: "Set up a vault first.",
  not_in_vault: "Not in your vault yet.",
  in_vault: "In your vault.",
  update_available: "Update available: this app has a newer copy.",
  name_taken: 'Your vault already has a skill named "skill-vault" from somewhere else.',
};

const errText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

function Row({ title, status, children }: { title: string; status: ReactNode; children?: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 0", borderTop: "0.5px solid var(--border)" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", minWidth: 120 }}>{title}</span>
        <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{status}</span>
      </div>
      {children && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", paddingLeft: 130 }}>{children}</div>}
    </div>
  );
}

export function AgentAccessCard() {
  const qc = useQueryClient();
  const { data: s } = useQuery({ queryKey: ["agent-access"], queryFn: () => api.agentAccess() });
  const refresh = () => qc.invalidateQueries({ queryKey: ["agent-access"] });

  const run = (fn: () => Promise<unknown>, ok: string, fail: string) => ({
    mutationFn: fn,
    onSuccess: () => {
      toast.success(ok);
      refresh();
    },
    onError: (err: unknown) => toast.error(errText(err, fail)),
  });

  const addSkill = useMutation({
    mutationFn: () => api.addVaultSkill(),
    onSuccess: (r) => {
      toast.success(r.pushed.length ? `Added; pushed to ${r.pushed.join(", ")}` : "skill-vault is up to date in your vault");
      for (const f of r.failed) toast.error(`Couldn't push to ${f.provider_id}: ${f.error}`);
      refresh();
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) => toast.error(errText(err, "Couldn't add the skill")),
  });
  const zip = useMutation(run(() => api.vaultSkillZip(), "skill-vault.zip is ready: upload it in Claude Desktop", "Couldn't build the zip"));
  const prompt = useMutation({
    mutationFn: async () => navigator.clipboard.writeText((await api.vaultSkillPrompt()).prompt),
    onSuccess: () => toast.success("Install prompt copied: paste it into a Claude Desktop chat"),
    onError: (err) => toast.error(errText(err, "Couldn't copy the prompt")),
  });
  const desktopOn = useMutation(run(() => api.connectDesktop(), "Connected. Quit Claude Desktop from the tray icon and reopen it.", "Couldn't connect Claude Desktop"));
  const desktopOff = useMutation(run(() => api.disconnectDesktop(), "Disconnected Claude Desktop", "Couldn't disconnect Claude Desktop"));
  const codeOn = useMutation(run(() => api.connectClaudeCode(), "Connected Claude Code", "Couldn't connect Claude Code"));
  const codeOff = useMutation(run(() => api.disconnectClaudeCode(), "Disconnected Claude Code", "Couldn't disconnect Claude Code"));

  const notBuilt = s && !s.bridge_built ? "Build the app first" : undefined;
  const desktop = s?.claude_desktop;
  const code = s?.claude_code;

  return (
    <>
      <Rule label="Agent access" />
      <div
        style={{
          background: "var(--surface)",
          border: "0.5px solid var(--border)",
          borderRadius: 8,
          padding: "14px 18px",
          marginBottom: 22,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
          Let Claude Desktop, Claude Code and other agents save skills to your vault, load them, push them to your
          tools and run Notion syncs. The <code style={{ fontFamily: "var(--mono)" }}>skill-vault</code> skill tells
          them how.
        </p>

        <Row title="skill-vault skill" status={s ? `${SKILL_TEXT[s.skill.state]}${s.skill.targets.length ? ` Targets: ${s.skill.targets.join(", ")}.` : ""}` : "…"}>
          {(s?.skill.state === "not_in_vault" || s?.skill.state === "update_available") && (
            <Button size="sm" kind="primary" onClick={() => addSkill.mutate()} disabled={addSkill.isPending}>
              {s.skill.state === "update_available" ? "Update" : "Add to vault"}
            </Button>
          )}
        </Row>

        <Row
          title="Claude Desktop"
          status={desktop ? `${ENTRY_TEXT[desktop.state]}${desktop.error ? ` ${desktop.error}` : ""}` : "…"}
        >
          {desktop && desktop.state !== "not_installed" && desktop.state !== "unreadable" && desktop.state !== "name_taken" && (
            <>
              {desktop.state === "connected" ? (
                <Button size="sm" onClick={() => desktopOff.mutate()} disabled={desktopOff.isPending}>Disconnect</Button>
              ) : (
                <Button size="sm" kind="primary" onClick={() => desktopOn.mutate()} disabled={!!notBuilt || desktopOn.isPending} title={notBuilt}>
                  {desktop.state === "broken" ? "Reconnect" : "Connect"}
                </Button>
              )}
              <Button size="sm" onClick={() => zip.mutate()} disabled={zip.isPending}>Download skill zip</Button>
              <Button size="sm" onClick={() => prompt.mutate()} disabled={prompt.isPending}>Copy install prompt</Button>
            </>
          )}
        </Row>
        {desktop?.state === "connected" && (
          <p style={{ margin: "0 0 6px 130px", fontSize: 12, color: "var(--ink-3)" }}>
            After connecting, quit Claude Desktop from the tray icon and reopen it. Install the skill with the zip
            (Settings → Capabilities → Skills) or the prompt.
          </p>
        )}

        <Row title="Claude Code" status={code ? `${ENTRY_TEXT[code.state]}${code.reason ? ` (${code.reason})` : ""}` : "…"}>
          {code && code.state !== "cli_missing" && code.state !== "name_taken" &&
            (code.state === "connected" ? (
              <Button size="sm" onClick={() => codeOff.mutate()} disabled={codeOff.isPending}>Disconnect</Button>
            ) : (
              <Button size="sm" kind="primary" onClick={() => codeOn.mutate()} disabled={!!notBuilt || codeOn.isPending} title={notBuilt}>
                {code.state === "broken" ? "Reconnect" : "Connect"}
              </Button>
            ))}
        </Row>

        <Row
          title="Other agents"
          status={
            <>
              Agents with a shell run{" "}
              <code style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>{s?.command.posix ?? "~/.skill-vault/bin/skill-vault"}</code>{" "}
              (<code style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>skill-vault.cmd</code> on Windows). Push the
              skill to their targets as usual.
            </>
          }
        />
      </div>
    </>
  );
}
```

- [ ] **Step 4: Place it in Settings**

In `app/client/src/pages/Settings.tsx` add `import { AgentAccessCard } from "../components/AgentAccessCard";` and insert directly before `<Rule label="Vault" />`:

```tsx
        <AgentAccessCard />
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run build`
Expected: clean; build succeeds.

Visual check without touching real configs: start the dev server from the worktree on a spare port and open Settings in the built-in browser. **Look only; don't click Connect, Disconnect or Add** (they act on this user's real Claude Desktop config, Claude Code config and vault).

```bash
npm run dev -- --port 5599 --no-open
```

Open `http://localhost:5599/settings`; confirm the Agent access card renders with four rows and readable status text in light and dark mode. Stop the dev server afterwards.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/AgentAccessCard.tsx client/src/lib/types.ts client/src/lib/api.ts client/src/pages/Settings.tsx
git commit -m "client: Settings → Agent access card

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Docs and changelog

**Files:**
- Modify: `docs/features.md`, `docs/configuration.md`, `docs/faq.md`, `app/CHANGELOG.md`

- [ ] **Step 1: CHANGELOG**

In `app/CHANGELOG.md`, under `## [Unreleased]` → `### Added`, add:

```markdown
- **Agent access** (Settings → Agent access): Claude Desktop, Claude Code and any
  agent with a shell can now work with the vault: save a skill from a chat, load a
  vault skill, push skills to your other tools, build a Claude Desktop zip, and run
  Notion syncs.
  - **Claude Desktop**: **Connect** adds a `skill-vault` MCP server to
    `claude_desktop_config.json` (backed up first; other servers untouched).
  - **Claude Code**: **Connect** runs `claude mcp add --scope user skill-vault`.
  - **Other agents**: `~/.skill-vault/bin/skill-vault <tool>` (JSON in, JSON out).
  - **The `skill-vault` skill** ships with the app. **Add to vault** adopts it and
    pushes it to your default targets; install it in Claude Desktop with the zip or
    the copy-paste prompt.
  - Vault tools start the app in the background when it isn't open (Windows); it
    stops again 10 minutes after the last call.
  - New bridge tools: `read_skill_files`, `save_skill`, `package_for_desktop`.
```

- [ ] **Step 2: features.md**

After the `## Packaging and sharing` section, add:

```markdown
## Agent access — Claude Desktop, Claude Code and other agents

Settings → **Agent access** gives other agents the same vault tools the in-app assistant uses, so a
chat can save the skill it just wrote, load a vault skill, push skills to your other tools, build a
Claude Desktop zip, or run a Notion sync.

- **The `skill-vault` skill** tells an agent how. **Add to vault** adopts it like any other skill and
  pushes it to your default targets; app updates that change it show as *Update available*.
- **Claude Desktop**: **Connect** adds a `skill-vault` MCP server to Claude Desktop's config. Quit
  Claude Desktop from the tray and reopen it, then install the skill with **Download skill zip**
  (upload it in Settings → Capabilities → Skills) or **Copy install prompt** (paste it into a chat).
- **Claude Code**: **Connect** registers the same server for every project
  (`claude mcp add --scope user`). The skill reaches Claude Code through the `claude` target.
- **Other agents** (Cursor, Codex, Copilot, Windsurf, OpenClaw) run the shared command:
  `echo '{"query":"pdf"}' | ~/.skill-vault/bin/skill-vault search_skills`. `skill-vault tools` lists
  every tool.

When the app isn't open, the first tool call starts it in the background (Windows) and it stops 10
minutes after the last call. Saving from a chat never overwrites without the agent showing you the
changes first, and a skill edited since the agent read it is refused.
```

- [ ] **Step 3: configuration.md**

After `## Assistant state files (per machine)` section, add:

```markdown
## Agent access files (per machine)

| Path | Written by | What |
|---|---|---|
| `~/.skill-vault/bin/skill-vault`, `skill-vault.cmd` | the built app, at every start | The shared command: runs the vault bridge in command mode |
| `%APPDATA%\Claude\claude_desktop_config.json` → `mcpServers["skill-vault"]` | Agent access → Claude Desktop → Connect | Claude Desktop's MCP entry for the vault bridge |
| `claude_desktop_config.json.skill-vault.bak` | each Connect / Disconnect | The Desktop config as it was before the last change |
| `~/.claude.json` → `mcpServers["skill-vault"]` | `claude mcp add --scope user` (Agent access → Claude Code → Connect) | Claude Code's entry; the app only reads this file |

`SKILL_VAULT_AGENT_IDLE_MS` (environment) changes how long a bridge call keeps a background-started
app running (default 600000, 10 minutes).
```

- [ ] **Step 4: faq.md**

Add at the end:

```markdown
**Can Claude Desktop save skills to my vault?**
Yes. In Settings → Agent access, connect Claude Desktop and install the `skill-vault` skill (zip or
copy-paste prompt). Then ask a Desktop chat to "save this skill to my vault". It shows you the changes
before it overwrites anything.

**Why do I have to restart Claude Desktop after connecting?**
Claude Desktop reads its MCP servers only when it starts. Quit it from the tray icon (closing the
window isn't enough) and reopen it.
```

- [ ] **Step 5: Check for personal data and commit**

Run (from the worktree root): `grep -rnE "[A-Za-z]:\\\\Users\\\\|/Users/|/home/|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}" docs/features.md docs/configuration.md docs/faq.md app/CHANGELOG.md app/bundled-skills || echo clean`
Expected: `clean` (no user paths or email addresses).

```bash
git add docs/features.md docs/configuration.md docs/faq.md app/CHANGELOG.md
git commit -m "docs: agent access (Claude Desktop, Claude Code, other agents)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Final verification

- [ ] **Step 1: Full suite, types, build**

Run (from `app/`): `npm test && npm run typecheck && npm run build`
Expected: all tests pass (606 + the new ones), typecheck clean, build writes `dist/` including `dist/assistant-mcp.js`.

- [ ] **Step 2: Command mode against the built bundle**

Run: `node dist/assistant-mcp.js tools > /dev/null && echo ok` → `ok`.
Run: `echo '{}' | node dist/assistant-mcp.js get_skill; echo "exit $?"` → the invalid-arguments error and `exit 1`.

- [ ] **Step 3: Spec coverage check**

Walk the spec's Goals and Errors tables and confirm each has a test or a manual-check item below. Note anything missing in the hand-off.

- [ ] **Step 4: Manual check list (after merge, on the installed app — not from the worktree)**

Record these for the user; they need the installed app and real Claude Desktop:

1. Settings → Agent access → **Add to vault**; the skill appears in the vault and in `~/.claude/skills`.
2. **Connect** Claude Desktop; quit from the tray and reopen; the `skill-vault` tools appear.
3. Install the skill (zip and, separately, the prompt).
4. In a Desktop chat: list skills, use one, save a new skill, update it (see the diff and the yes), push it to another target, package it, run `notion_status`.
5. **Connect** Claude Code; in a new Claude Code session call `list_skills`.
6. From Git Bash and from PowerShell: `skill-vault list_skills` via the shims.
7. Close the app; a Desktop tool call starts it hidden; it stops ~10 minutes after the last call.
