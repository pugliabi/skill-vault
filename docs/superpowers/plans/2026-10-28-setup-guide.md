# First-Run Setup Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one-field first-run page with a step-by-step setup guide (vault → targets → skills → Notion → assistant → review) that saves nothing until Finish and can be re-run from Settings.

**Architecture:** A new `/api/setup` router backed by small single-purpose services in `app/server/services/setup/` (draft file, folder inspection, target detection, clone preview, skills plan, Finish job, Windows folder dialog, assistant check). Answers live in `~/.skill-vault/setup-draft.json` until Finish, which runs one server job that streams NDJSON progress. The client is a new `pages/setup/` folder: shared UI, one component per step, and a shell that loads/saves the draft.

**Tech Stack:** Node ≥ 20, Express, TypeScript (tsx), `node:test` + `node:assert/strict`, React 18 + TanStack Query + wouter + sonner, PowerShell 5.1 (folder dialog script).

**Spec:** `docs/superpowers/specs/2026-10-27-setup-guide-design.md`

## Global Constraints

- All commands run from `app/` unless a step says otherwise. Tests: `npm test` (all) or `node --import tsx --test <file>` (one file). Types: `npm run typecheck`. Build: `npm run build`.
- Tests never touch the real `~/.skill-vault`: services take an injected home/run/config; any test that imports `appConfig.ts` (directly or through a router) sets `process.env.USERPROFILE` and `process.env.HOME` to a temp folder **before** the first dynamic `import()`.
- Every POST / PUT / DELETE under `/api/setup` is refused (403 `{ error: "cross-site request refused" }`) when `Sec-Fetch-Site` is present and not `same-origin`, or `Origin` is present and isn't this server.
- `POST /api/setup/pick-folder` additionally requires `process.platform === "win32"`, a loopback socket address and a loopback `Host`.
- The draft file never contains the assistant API key or Notion tokens. The API key is never written to events, logs or `GET /apply/status`.
- Finish order is fixed: 1 vault folder → 2 config → 3 adopt → 4 push → 5 Notion. Steps 1–2 stop the job on failure (config untouched); steps 3–5 continue item by item.
- The draft is deleted once Finish step 2 succeeds, and on Start over / Discard.
- Known targets mirror the CLI's `DEFAULT_AGENT_LOCATIONS` (`src/skill_vault/config.py`): claude, openclaw, cursor, codex, copilot, windsurf → `<home>/.<id>/skills`.
- PowerShell scripts must run on Windows PowerShell 5.1.
- UI copy: plain words, no jargon; errors say what to do next.
- Commit messages end with a blank line then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (use a second `-m`).

## Rulings made while planning (deviations from the spec text)

- **Assistant "signed in" check** uses `claude auth status` (JSON: `loggedIn`, `authMethod`, `email`), run with the API-key env removed. If the CLI's output isn't that JSON (older CLI), the step shows "couldn't check" instead of failing.
- **Repo URL** is not separately clearable on Review: the draft's `vault.repo_url` is the whole truth (pre-filled from config on re-run, from the clone URL, or from an existing folder's `origin`), and Finish writes it (empty string when absent).
- **Notion database display** for a different vault: `inspect` and the clone preview also read that vault's `notion.json`, so the Notion step can say "this vault already uses …".
- **Skills step** starts with every adopt and push candidate ticked; the user unticks, and Skip moves nothing.
- **Notion `return_to`** is stored in `notion-auth.json` (survives a restart); the pending-sign-in busy flag is in memory (it only matters to this process's idle stop).

## File Structure

| File | Responsibility |
|---|---|
| `server/routes/sameOrigin.ts` | Shared cross-site write guard + loopback check (used by `/api/app` and `/api/setup`) |
| `server/routes/setup.ts` | `/api/setup/*` endpoints; thin, delegates to services |
| `server/services/setup/types.ts` | Draft and shared setup types |
| `server/services/setup/draft.ts` | Draft file read/write/normalise, fresh draft, config fingerprint |
| `server/services/setup/inspect.ts` | What a folder contains (vault, skills folder, empty…), git root/origin, Notion DB |
| `server/services/setup/targets.ts` | Known tools + detection status |
| `server/services/setup/clonePreview.ts` | Temporary blobless clone → vault candidates; git error wording; tree removal |
| `server/services/setup/plan.ts` | Effective targets + adopt/push/differs lists |
| `server/services/setup/apply.ts` | The Finish job (pure logic, injected deps) |
| `server/services/setup/applyDeps.ts` | Real dependencies for the Finish job |
| `server/services/setup/folderDialog.ts` | Spawns the Windows folder dialog; one at a time |
| `scripts/pick-folder.ps1` | Modern `IFileOpenDialog` folder picker, top-most owner |
| `server/services/pushSkill.ts` | Push one skill to one provider (extracted from `routes/push.ts`) |
| `server/services/notion/dataSource.ts` | Choose the Skills data source (extracted from `routes/notion.ts`) + `openNotionApiAt` |
| `server/services/appConfig.ts` | + `readSetupBase()`, `writeSetupConfig()` |
| `server/services/claude/cli.ts` | + `parseAuthStatus()`, `claudeLoginStatus()` |
| `server/services/notion/connection.ts` | + pending sign-in tracking |
| `client/src/lib/setup.ts` | Setup API client + types + NDJSON reader |
| `client/src/pages/setup/types.ts` | `StepProps` |
| `client/src/pages/setup/ui.tsx` | Shared step UI (header, hints, folder field, choice card, nav) |
| `client/src/pages/setup/steps/*.tsx` | One file per step |
| `client/src/pages/setup/SetupGuide.tsx` | Shell: draft load/save, rail, Welcome, close/discard |

---

### Task 1: Shared write guard + setup router skeleton

**Files:**
- Create: `server/routes/sameOrigin.ts`, `server/routes/sameOrigin.test.ts`, `server/routes/setup.ts`, `server/routes/setup.test.ts`
- Modify: `server/routes/app.ts` (use the shared guard), `server/index.ts` (mount `/api/setup`)

**Interfaces:**
- Produces: `isOwnOrigin(origin, host)`, `isCrossSite(req)`, `refuseCrossSiteWrites` (Express middleware), `isLoopbackRequest(req)` from `sameOrigin.ts`; `setupRouter(deps?: SetupRouterDeps): Router` with `SetupRouterDeps.platform?: NodeJS.Platform`; `GET /api/setup/capabilities → { folder_dialog: boolean }`.

- [ ] **Step 1: Write the failing guard test** — `server/routes/sameOrigin.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { isLoopbackRequest, isOwnOrigin, refuseCrossSiteWrites } from "./sameOrigin.ts";

let server: Server;
let port: number;

before(async () => {
  const app = express();
  app.use(refuseCrossSiteWrites);
  app.all("/x", (req, res) => res.json({ ok: true, loopback: isLoopbackRequest(req) }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  port = (server.address() as AddressInfo).port;
});
after(() => new Promise<void>((r) => server.close(() => r())));

function call(method: string, headers: Record<string, string>): Promise<{ status: number; body: { loopback?: boolean } }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/x", method, headers }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data || "{}") }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("isOwnOrigin matches only this host", () => {
  assert.equal(isOwnOrigin("http://127.0.0.1:9994", "127.0.0.1:9994"), true);
  assert.equal(isOwnOrigin("http://evil.example", "127.0.0.1:9994"), false);
  assert.equal(isOwnOrigin("null", "127.0.0.1:9994"), false);
});

test("writes from another site are refused; reads and header-less writes pass", async () => {
  assert.equal((await call("POST", { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await call("PUT", { Origin: "http://evil.example" })).status, 403);
  assert.equal((await call("DELETE", { Origin: `http://127.0.0.1:${port}` })).status, 200);
  assert.equal((await call("POST", {})).status, 200);
  assert.equal((await call("GET", { "Sec-Fetch-Site": "cross-site" })).status, 200);
});

test("isLoopbackRequest needs a loopback socket and a loopback Host", async () => {
  assert.equal((await call("GET", {})).body.loopback, true);
  assert.equal((await call("GET", { Host: "evil.example" })).body.loopback, false);
  assert.equal((await call("GET", { Host: `localhost:${port}` })).body.loopback, true);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --import tsx --test server/routes/sameOrigin.test.ts`
Expected: FAIL — cannot find module `./sameOrigin.ts`.

- [ ] **Step 3: Implement** — `server/routes/sameOrigin.ts`:

```ts
/**
 * Guards for state-changing requests (used by /api/app and /api/setup).
 *
 * A browser marks a request from another site with Sec-Fetch-Site, and always
 * sends Origin on a POST/PUT/DELETE; either one naming someone else means the
 * request came from a page that isn't this app. A request with neither header
 * (curl, tests) isn't from a web page and is allowed.
 */
import type { NextFunction, Request, Response } from "express";

/** The Origin header names the host the request was sent to ("null" and junk never match). */
export function isOwnOrigin(origin: string, host: string | undefined): boolean {
  try {
    return host !== undefined && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function isCrossSite(req: Request): boolean {
  const site = req.get("sec-fetch-site");
  const origin = req.get("origin");
  return (site !== undefined && site !== "same-origin") || (origin !== undefined && !isOwnOrigin(origin, req.get("host")));
}

/** 403 for cross-site writes (anything but GET / HEAD / OPTIONS). */
export function refuseCrossSiteWrites(req: Request, res: Response, next: NextFunction): void {
  const write = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
  if (write && isCrossSite(req)) {
    res.status(403).json({ error: "cross-site request refused" });
    return;
  }
  next();
}

const LOOPBACK_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True when the request came from this PC: a loopback socket AND a loopback Host header. */
export function isLoopbackRequest(req: Request): boolean {
  const addr = req.socket.remoteAddress ?? "";
  const host = (req.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
  return LOOPBACK_ADDRS.has(addr) && LOOPBACK_HOSTS.has(host);
}
```

- [ ] **Step 4: Use it in `server/routes/app.ts`** — delete the local `isOwnOrigin` function, add `import { isCrossSite } from "./sameOrigin.ts";`, and replace the `/app` middleware body with:

```ts
  router.use("/app", (req, res, next) => {
    if (req.method === "POST" && isCrossSite(req)) {
      res.status(403).json({ error: "cross-site request refused" });
      return;
    }
    next();
  });
```

- [ ] **Step 5: Write the failing router test** — `server/routes/setup.test.ts` (later tasks append to this file; keep the helpers at the top):

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Router } from "express";

// setup.ts imports appConfig.ts (config path fixed at import time): point HOME at
// a temp folder BEFORE the first import so nothing here can touch ~/.skill-vault.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "sv-setup-home-"));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;

type SetupModule = typeof import("./setup.ts");
let setup: SetupModule;
const servers: Array<() => Promise<void>> = [];

before(async () => {
  setup = await import("./setup.ts");
});
after(async () => {
  for (const close of servers) await close();
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

async function serve(router: Router): Promise<string> {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/setup", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  servers.push(() => new Promise<void>((r) => server.close(() => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/setup`;
}

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("capabilities: folder dialog only on Windows from this PC", async () => {
  const win = await serve(setup.setupRouter({ platform: "win32" }));
  assert.deepEqual(await (await fetch(`${win}/capabilities`)).json(), { folder_dialog: true });
  const linux = await serve(setup.setupRouter({ platform: "linux" }));
  assert.deepEqual(await (await fetch(`${linux}/capabilities`)).json(), { folder_dialog: false });
});

test("writes from another site are refused", async () => {
  const base = await serve(setup.setupRouter({ platform: "win32" }));
  const res = await fetch(`${base}/anything`, { method: "POST", headers: { Origin: "http://evil.example" } });
  assert.equal(res.status, 403);
});
```

(`json` is used by later tasks.)

- [ ] **Step 6: Run it to see it fail**

Run: `node --import tsx --test server/routes/setup.test.ts`
Expected: FAIL — cannot find module `./setup.ts`.

- [ ] **Step 7: Implement** — `server/routes/setup.ts`:

```ts
/**
 * First-run setup guide endpoints (mounted at /api/setup). Design:
 * docs/superpowers/specs/2026-10-27-setup-guide-design.md. Every write is
 * refused when a browser marks it as coming from another site.
 *
 *   GET  /capabilities   { folder_dialog } — Windows + a request from this PC
 */
import { Router } from "express";
import { isLoopbackRequest, refuseCrossSiteWrites } from "./sameOrigin.ts";

export interface SetupRouterDeps {
  platform?: NodeJS.Platform;
}

export function setupRouter(deps: SetupRouterDeps = {}): Router {
  const router = Router();
  const platform = deps.platform ?? process.platform;
  router.use(refuseCrossSiteWrites);

  router.get("/capabilities", (req, res) => {
    res.json({ folder_dialog: platform === "win32" && isLoopbackRequest(req) });
  });

  return router;
}
```

- [ ] **Step 8: Mount it** — in `server/index.ts` add `import { setupRouter } from "./routes/setup.ts";` and, after `app.use("/api/config", configRouter());`, add `app.use("/api/setup", setupRouter());`.

- [ ] **Step 9: Run the tests**

Run: `node --import tsx --test server/routes/sameOrigin.test.ts server/routes/setup.test.ts server/routes/app.test.ts`
Expected: PASS (app.test.ts unchanged and green).

- [ ] **Step 10: Commit**

```bash
git add server/routes/sameOrigin.ts server/routes/sameOrigin.test.ts server/routes/setup.ts server/routes/setup.test.ts server/routes/app.ts server/index.ts
git commit -m "setup: shared cross-site guard and /api/setup skeleton" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Draft file

**Files:**
- Create: `server/services/setup/types.ts`, `server/services/setup/draft.ts`, `server/services/setup/draft.test.ts`
- Modify: `server/services/appConfig.ts` (+ `readSetupBase`), `server/routes/setup.ts`, `server/routes/setup.test.ts`

**Interfaces:**
- Consumes: `setupRouter`, `SetupRouterDeps` (Task 1).
- Produces: types `SetupStep`, `SetupTarget`, `SetupVault`, `NotionRef`, `NotionChoice`, `AssistantChoice`, `SetupDraft`, `SetupBase`; `draftPath(home?)`, `configFingerprint(base)`, `startDraft(base, now?)`, `normalizeDraft(input)`, `DraftError`, `readDraft(home?)`, `writeDraft(draft, home?)`, `deleteDraft(home?)`; `readSetupBase(): SetupBase`; `SetupRouterDeps.home?: () => string`, `SetupRouterDeps.readBase?: () => SetupBase`; routes `GET /draft → { draft, stale }`, `POST /draft/start → { draft }`, `PUT /draft → { draft }`, `DELETE /draft → 204`.

- [ ] **Step 1: Types** — `server/services/setup/types.ts`:

```ts
/** Shared shapes for the setup guide (draft file, API bodies). */

export type SetupStep = "welcome" | "vault" | "targets" | "skills" | "notion" | "assistant" | "review";

export interface NotionRef {
  id: string;
  name: string;
}

export interface SetupVault {
  mode: "new" | "existing" | "clone";
  /** Vault root to use. For a clone: <dest>/<subdir> (derived by normalizeDraft). */
  path: string;
  clone?: { url: string; dest: string; subdir: string; skill_names: string[]; notion: NotionRef | null };
  /** Saved as config repo_url on Finish (empty when absent). */
  repo_url?: string;
}

export interface SetupTarget {
  id: string;
  path: string;
  enabled: boolean;
  is_default: boolean;
  known: boolean;
}

export interface NotionChoice {
  data_source_id: string;
  data_source_name: string;
  add_last_edited: boolean;
}

export interface AssistantChoice {
  auth: "login" | "api_key";
  workspace_id?: string;
}

/**
 * The guide's answers until Finish (~/.skill-vault/setup-draft.json).
 * null on targets / notion / assistant = "leave as it is" (Skip). Never holds
 * the API key or Notion tokens.
 */
export interface SetupDraft {
  version: 1;
  started_at: string;
  /** configFingerprint() of the config when the draft started. */
  base: string;
  step: SetupStep;
  vault: SetupVault | null;
  machine_id?: string;
  targets: SetupTarget[] | null;
  skills: { adopt: { name: string; from: string }[]; push: string[] };
  notion: NotionChoice | null;
  assistant: AssistantChoice | null;
}

/** The config fields the guide reads (appConfig.readSetupBase). */
export interface SetupBase {
  vault_path: string | null;
  agent_locations: Record<string, string>;
  default_targets: string[];
  machine_id: string | null;
  repo_url: string | null;
}
```

- [ ] **Step 2: Write the failing test** — `server/services/setup/draft.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DraftError,
  configFingerprint,
  deleteDraft,
  draftPath,
  normalizeDraft,
  readDraft,
  startDraft,
  writeDraft,
} from "./draft.ts";
import type { SetupBase } from "./types.ts";

const base: SetupBase = {
  vault_path: "C:\\v",
  agent_locations: { claude: "C:\\h\\.claude\\skills", cursor: "C:\\h\\.cursor\\skills" },
  default_targets: ["claude"],
  machine_id: "PC1",
  repo_url: "https://github.com/me/vault.git",
};
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "sv-draft-"));

test("startDraft fills in from config", () => {
  const d = startDraft(base, new Date("2026-10-28T00:00:00Z"));
  assert.equal(d.started_at, "2026-10-28T00:00:00.000Z");
  assert.equal(d.step, "vault");
  assert.deepEqual(d.vault, { mode: "existing", path: "C:\\v", repo_url: "https://github.com/me/vault.git" });
  assert.equal(d.machine_id, "PC1");
  assert.equal(d.targets, null);
  assert.equal(d.notion, null);
  assert.equal(d.assistant, null);
  assert.deepEqual(d.skills, { adopt: [], push: [] });
  assert.equal(d.base, configFingerprint(base));
});

test("startDraft on first run has no vault and uses the computer name", () => {
  const d = startDraft({ vault_path: null, agent_locations: {}, default_targets: [], machine_id: null, repo_url: null });
  assert.equal(d.vault, null);
  assert.equal(d.machine_id, os.hostname());
});

test("fingerprint ignores key order but sees target changes", () => {
  const reordered = { ...base, agent_locations: { cursor: base.agent_locations.cursor, claude: base.agent_locations.claude } };
  assert.equal(configFingerprint(reordered), configFingerprint(base));
  assert.notEqual(configFingerprint({ ...base, default_targets: ["cursor"] }), configFingerprint(base));
});

test("normalizeDraft strips secrets and unknown keys", () => {
  const raw = { ...startDraft(base), assistant: { auth: "api_key", workspace_id: "w", api_key: "sk-secret" }, extra: 1 };
  const d = normalizeDraft(raw);
  assert.deepEqual(d.assistant, { auth: "api_key", workspace_id: "w" });
  assert.ok(!JSON.stringify(d).includes("sk-secret"));
  assert.ok(!("extra" in d));
});

test("normalizeDraft derives a clone's vault path from dest + subdir", () => {
  const d = normalizeDraft({
    ...startDraft(base),
    vault: {
      mode: "clone",
      path: "ignored",
      clone: { url: "https://github.com/me/v.git", dest: path.join("C:", "x", "v"), subdir: "skills", skill_names: ["a", 3], notion: null },
    },
  });
  assert.equal(d.vault?.path, path.join("C:", "x", "v", "skills"));
  assert.deepEqual(d.vault?.clone?.skill_names, ["a"]);
});

test("normalizeDraft keeps targets with spaces and rejects bad shapes", () => {
  const ok = normalizeDraft({ ...startDraft(base), targets: [{ id: "Prompting BI", path: "C:\\p", enabled: true, is_default: true, known: false }] });
  assert.equal(ok.targets?.[0].id, "Prompting BI");
  assert.throws(() => normalizeDraft({ version: 2 }), DraftError);
  assert.throws(() => normalizeDraft({ ...startDraft(base), targets: [{ id: "a/b", path: "C:\\p" }] }), DraftError);
  assert.throws(
    () => normalizeDraft({ ...startDraft(base), targets: [{ id: "a", path: "C:\\p" }, { id: "a", path: "C:\\q" }] }),
    DraftError,
  );
  assert.throws(() => normalizeDraft({ ...startDraft(base), notion: { data_source_id: "nope", data_source_name: "x" } }), DraftError);
  assert.throws(() => normalizeDraft({ ...startDraft(base), skills: { adopt: [{ name: "..", from: "claude" }], push: [] } }), DraftError);
});

test("a default target must be enabled", () => {
  const d = normalizeDraft({ ...startDraft(base), targets: [{ id: "a", path: "C:\\p", enabled: false, is_default: true }] });
  assert.equal(d.targets?.[0].is_default, false);
});

test("write, read and delete round-trip; a corrupt file reads as none", () => {
  const home = tmpHome();
  try {
    assert.equal(readDraft(home), null);
    const d = startDraft(base);
    writeDraft(d, home);
    assert.deepEqual(readDraft(home), d);
    deleteDraft(home);
    assert.equal(readDraft(home), null);
    deleteDraft(home); // no file: no throw
    fs.mkdirSync(path.dirname(draftPath(home)), { recursive: true });
    fs.writeFileSync(draftPath(home), "{not json");
    assert.equal(readDraft(home), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `node --import tsx --test server/services/setup/draft.test.ts`
Expected: FAIL — cannot find module `./draft.ts`.

- [ ] **Step 4: Implement** — `server/services/setup/draft.ts`:

```ts
/**
 * The setup guide's draft: answers held until Finish, in
 * ~/.skill-vault/setup-draft.json (per machine, never in the vault).
 * normalizeDraft() is the only way in — it rebuilds the object field by
 * field, so unknown keys (and any secret a client sends) are dropped.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AssistantChoice,
  NotionChoice,
  NotionRef,
  SetupBase,
  SetupDraft,
  SetupStep,
  SetupTarget,
  SetupVault,
} from "./types.ts";

export class DraftError extends Error {}

const STEPS: SetupStep[] = ["welcome", "vault", "targets", "skills", "notion", "assistant", "review"];
const DATA_SOURCE_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
/** Target names are config keys: any text without path separators or control characters. */
const TARGET_ID = /^[^\\/\x00-\x1f]{1,64}$/;
const isStr = (v: unknown): v is string => typeof v === "string";
const isSafeName = (v: unknown): v is string => isStr(v) && /^[^\\/\x00-\x1f]+$/.test(v) && v !== "." && v !== "..";

export function draftPath(home: string = os.homedir()): string {
  return path.join(home, ".skill-vault", "setup-draft.json");
}

/** Stable fingerprint of the config fields the guide edits (vault, targets, defaults). */
export function configFingerprint(c: Pick<SetupBase, "vault_path" | "agent_locations" | "default_targets">): string {
  const locations = Object.entries(c.agent_locations).sort(([a], [b]) => a.localeCompare(b));
  const json = JSON.stringify([c.vault_path ?? null, locations, [...c.default_targets].sort()]);
  return crypto.createHash("sha1").update(json).digest("hex");
}

/** A new draft pre-filled from the current config. */
export function startDraft(base: SetupBase, now: Date = new Date()): SetupDraft {
  return {
    version: 1,
    started_at: now.toISOString(),
    base: configFingerprint(base),
    step: "vault",
    vault: base.vault_path
      ? { mode: "existing", path: base.vault_path, ...(base.repo_url ? { repo_url: base.repo_url } : {}) }
      : null,
    machine_id: base.machine_id ?? os.hostname(),
    targets: null,
    skills: { adopt: [], push: [] },
    notion: null,
    assistant: null,
  };
}

function normalizeNotionRef(v: unknown): NotionRef | null {
  if (v == null) return null;
  const o = v as Record<string, unknown>;
  return isStr(o.id) && DATA_SOURCE_ID.test(o.id) ? { id: o.id, name: isStr(o.name) ? o.name : "" } : null;
}

function normalizeVault(v: unknown): SetupVault | null {
  if (v == null) return null;
  const o = v as Record<string, unknown>;
  if (o.mode !== "new" && o.mode !== "existing" && o.mode !== "clone") {
    throw new DraftError("vault.mode must be new, existing or clone");
  }
  const repo = isStr(o.repo_url) && o.repo_url.trim() ? { repo_url: o.repo_url.trim() } : {};
  if (o.mode === "clone") {
    const c = (o.clone ?? {}) as Record<string, unknown>;
    if (!isStr(c.url) || !c.url.trim() || !isStr(c.dest) || !c.dest.trim() || !isStr(c.subdir) || !Array.isArray(c.skill_names)) {
      throw new DraftError("vault.clone needs url, dest, subdir and skill_names");
    }
    const dest = c.dest.trim();
    return {
      mode: "clone",
      path: c.subdir ? path.join(dest, c.subdir) : dest,
      clone: {
        url: c.url.trim(),
        dest,
        subdir: c.subdir,
        skill_names: c.skill_names.filter(isSafeName),
        notion: normalizeNotionRef(c.notion),
      },
      ...repo,
    };
  }
  if (!isStr(o.path) || !o.path.trim()) throw new DraftError("vault.path is required");
  return { mode: o.mode, path: o.path.trim(), ...repo };
}

function normalizeTargets(v: unknown): SetupTarget[] | null {
  if (v == null) return null;
  if (!Array.isArray(v)) throw new DraftError("targets must be a list");
  const seen = new Set<string>();
  return v.map((t) => {
    const o = (t ?? {}) as Record<string, unknown>;
    const id = isStr(o.id) ? o.id.trim() : "";
    if (!TARGET_ID.test(id)) throw new DraftError(`bad target name: ${String(o.id)}`);
    if (seen.has(id)) throw new DraftError(`target ${id} is listed twice`);
    seen.add(id);
    if (!isStr(o.path) || !o.path.trim()) throw new DraftError(`target ${id} needs a folder`);
    const enabled = o.enabled === true;
    return { id, path: o.path.trim(), enabled, is_default: enabled && o.is_default === true, known: o.known === true };
  });
}

function normalizeSkills(v: unknown): SetupDraft["skills"] {
  const o = (v ?? {}) as Record<string, unknown>;
  const adoptIn = Array.isArray(o.adopt) ? o.adopt : [];
  const pushIn = Array.isArray(o.push) ? o.push : [];
  const adopt = adoptIn.map((a) => {
    const r = (a ?? {}) as Record<string, unknown>;
    if (!isSafeName(r.name) || !isStr(r.from) || !TARGET_ID.test(r.from)) throw new DraftError("bad adopt item");
    return { name: r.name, from: r.from };
  });
  const push = pushIn.map((p) => {
    if (!isSafeName(p)) throw new DraftError("bad push item");
    return p;
  });
  return { adopt, push };
}

function normalizeNotion(v: unknown): NotionChoice | null {
  if (v == null) return null;
  const o = v as Record<string, unknown>;
  if (!isStr(o.data_source_id) || !DATA_SOURCE_ID.test(o.data_source_id)) {
    throw new DraftError("notion.data_source_id must be a Notion data source id");
  }
  return {
    data_source_id: o.data_source_id,
    data_source_name: isStr(o.data_source_name) ? o.data_source_name : "",
    add_last_edited: o.add_last_edited === true,
  };
}

function normalizeAssistant(v: unknown): AssistantChoice | null {
  if (v == null) return null;
  const o = v as Record<string, unknown>;
  if (o.auth !== "login" && o.auth !== "api_key") throw new DraftError('assistant.auth must be "login" or "api_key"');
  const ws = isStr(o.workspace_id) && o.workspace_id.trim() ? { workspace_id: o.workspace_id.trim() } : {};
  return { auth: o.auth, ...ws };
}

export function normalizeDraft(input: unknown): SetupDraft {
  const o = (input ?? {}) as Record<string, unknown>;
  if (o.version !== 1) throw new DraftError("unsupported draft version");
  if (!isStr(o.started_at) || !isStr(o.base)) throw new DraftError("draft is missing started_at or base");
  return {
    version: 1,
    started_at: o.started_at,
    base: o.base,
    step: STEPS.includes(o.step as SetupStep) ? (o.step as SetupStep) : "welcome",
    vault: normalizeVault(o.vault),
    ...(isStr(o.machine_id) && o.machine_id.trim() ? { machine_id: o.machine_id.trim() } : {}),
    targets: normalizeTargets(o.targets),
    skills: normalizeSkills(o.skills),
    notion: normalizeNotion(o.notion),
    assistant: normalizeAssistant(o.assistant),
  };
}

/** The saved draft, or null when there is none or it can't be read. */
export function readDraft(home?: string): SetupDraft | null {
  try {
    return normalizeDraft(JSON.parse(fs.readFileSync(draftPath(home), "utf8")));
  } catch {
    return null;
  }
}

export function writeDraft(draft: SetupDraft, home?: string): void {
  const file = draftPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(normalizeDraft(draft), null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

export function deleteDraft(home?: string): void {
  fs.rmSync(draftPath(home), { force: true });
}
```

- [ ] **Step 5: Run the service test**

Run: `node --import tsx --test server/services/setup/draft.test.ts`
Expected: PASS.

- [ ] **Step 6: `readSetupBase` in `server/services/appConfig.ts`** — add `import type { SetupBase } from "./setup/types.ts";` and, after `readCliAppBlock`:

```ts
/** The config fields the setup guide starts from (services/setup/draft.ts). */
export function readSetupBase(): SetupBase {
  const raw = readRaw();
  return {
    vault_path: raw.vault_path ?? null,
    agent_locations: { ...(raw.agent_locations ?? {}) },
    default_targets: Array.isArray(raw.default_targets) ? raw.default_targets : [],
    machine_id: typeof raw.machine_id === "string" && raw.machine_id ? raw.machine_id : null,
    repo_url: typeof raw.repo_url === "string" && raw.repo_url ? raw.repo_url : null,
  };
}
```

- [ ] **Step 7: Append the failing route tests** to `server/routes/setup.test.ts`:

```ts
const sampleBase = {
  vault_path: null,
  agent_locations: {},
  default_targets: [],
  machine_id: "PC1",
  repo_url: null,
};

test("draft: start, save, read, stale, delete", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sv-setup-d-"));
  let base = { ...sampleBase };
  const url = await serve(setup.setupRouter({ home: () => home, readBase: () => base }));

  assert.deepEqual(await (await fetch(`${url}/draft`)).json(), { draft: null, stale: false });

  const { draft } = await (await fetch(`${url}/draft/start`, { method: "POST" })).json();
  assert.equal(draft.machine_id, "PC1");
  assert.equal(draft.vault, null);

  const saved = await fetch(`${url}/draft`, { ...json({ ...draft, step: "targets", extra: 1 }), method: "PUT" });
  assert.equal(saved.status, 200);
  const read = await (await fetch(`${url}/draft`)).json();
  assert.equal(read.draft.step, "targets");
  assert.equal(read.stale, false);
  assert.ok(!("extra" in read.draft));

  base = { ...sampleBase, vault_path: "C:\\elsewhere" };
  assert.equal((await (await fetch(`${url}/draft`)).json()).stale, true);

  const bad = await fetch(`${url}/draft`, { ...json({ version: 9 }), method: "PUT" });
  assert.equal(bad.status, 400);

  assert.equal((await fetch(`${url}/draft`, { method: "DELETE" })).status, 204);
  assert.equal((await (await fetch(`${url}/draft`)).json()).draft, null);
  fs.rmSync(home, { recursive: true, force: true });
});
```

- [ ] **Step 8: Run to see it fail**

Run: `node --import tsx --test server/routes/setup.test.ts`
Expected: FAIL — `/draft` returns 404.

- [ ] **Step 9: Add the draft routes** to `server/routes/setup.ts`. Add imports:

```ts
import os from "node:os";
import { readSetupBase } from "../services/appConfig.ts";
import { DraftError, configFingerprint, deleteDraft, normalizeDraft, readDraft, startDraft, writeDraft } from "../services/setup/draft.ts";
import type { SetupBase } from "../services/setup/types.ts";
```

Extend `SetupRouterDeps`:

```ts
  /** Home folder for the draft file (tests pass a temp folder). */
  home?: () => string;
  /** Current config fields the guide starts from. */
  readBase?: () => SetupBase;
```

Inside `setupRouter`, after `const platform = …`:

```ts
  const home = deps.home ?? (() => os.homedir());
  const readBase = deps.readBase ?? readSetupBase;
```

Before `return router;`:

```ts
  router.get("/draft", (_req, res) => {
    const draft = readDraft(home());
    res.json({ draft, stale: draft ? draft.base !== configFingerprint(readBase()) : false });
  });

  router.post("/draft/start", (_req, res) => {
    const draft = startDraft(readBase());
    writeDraft(draft, home());
    res.json({ draft });
  });

  router.put("/draft", (req, res) => {
    let draft;
    try {
      draft = normalizeDraft(req.body);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    writeDraft(draft, home());
    res.json({ draft });
  });

  router.delete("/draft", (_req, res) => {
    deleteDraft(home());
    res.status(204).end();
  });
```

Also update the header comment's endpoint list with the four draft routes.

- [ ] **Step 10: Run the tests**

Run: `node --import tsx --test server/services/setup/draft.test.ts server/routes/setup.test.ts`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add server/services/setup/types.ts server/services/setup/draft.ts server/services/setup/draft.test.ts server/services/appConfig.ts server/routes/setup.ts server/routes/setup.test.ts
git commit -m "setup: draft file (start, save, stale check, discard)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Folder inspection

**Files:**
- Create: `server/services/setup/inspect.ts`, `server/services/setup/inspect.test.ts`
- Modify: `server/routes/setup.ts`, `server/routes/setup.test.ts`

**Interfaces:**
- Consumes: `Run`, `RunResult`, `defaultRun` from `server/services/appUpdate.ts`; `NotionRef` (Task 2).
- Produces: `FolderKind`, `FolderInfo`, `inspectFolder(path, { run }): Promise<FolderInfo>`; `SetupRouterDeps.run?: Run`; `POST /api/setup/inspect { path } → FolderInfo`.

- [ ] **Step 1: Write the failing test** — `server/services/setup/inspect.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Run } from "../appUpdate.ts";
import { inspectFolder } from "./inspect.ts";

const notGit: Run = async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sv-inspect-"));
const skill = (dir: string, name: string) => {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), "---\nname: x\n---\n");
};

test("missing, file and empty folders", async () => {
  const root = tmp();
  try {
    const missing = await inspectFolder(path.join(root, "nope"), { run: notGit });
    assert.equal(missing.kind, "missing");
    assert.equal(missing.writable, true);
    assert.equal(missing.git, null);
    fs.writeFileSync(path.join(root, "f.txt"), "x");
    assert.equal((await inspectFolder(path.join(root, "f.txt"), { run: notGit })).kind, "not_dir");
    fs.mkdirSync(path.join(root, "empty"));
    assert.equal((await inspectFolder(path.join(root, "empty"), { run: notGit })).kind, "empty");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a vault counts manifest entries and skill folders once each", async () => {
  const v = tmp();
  try {
    skill(path.join(v, "skills"), "a");
    skill(path.join(v, "skills"), "b");
    fs.writeFileSync(path.join(v, "skills.json"), JSON.stringify({ skills: { a: { targets: [] }, c: { targets: [] } } }));
    fs.writeFileSync(
      path.join(v, "notion.json"),
      JSON.stringify({ data_source_id: "11111111-2222-3333-4444-555555555555", data_source_name: "Skills" }),
    );
    const info = await inspectFolder(v, { run: notGit });
    assert.equal(info.kind, "vault");
    assert.equal(info.skill_count, 3);
    assert.deepEqual(info.notion, { id: "11111111-2222-3333-4444-555555555555", name: "Skills" });
  } finally {
    fs.rmSync(v, { recursive: true, force: true });
  }
});

test("skills/ without a manifest, a target's skills folder, and anything else", async () => {
  const root = tmp();
  try {
    skill(path.join(root, "nomanifest", "skills"), "a");
    assert.deepEqual(
      [(await inspectFolder(path.join(root, "nomanifest"), { run: notGit })).kind, (await inspectFolder(path.join(root, "nomanifest"), { run: notGit })).skill_count],
      ["vault_no_manifest", 1],
    );
    skill(path.join(root, "target"), "x");
    skill(path.join(root, "target"), "y");
    const t = await inspectFolder(path.join(root, "target"), { run: notGit });
    assert.equal(t.kind, "skills_folder");
    assert.equal(t.skill_count, 2);
    fs.mkdirSync(path.join(root, "other"));
    fs.writeFileSync(path.join(root, "other", "README.md"), "hi");
    assert.equal((await inspectFolder(path.join(root, "other"), { run: notGit })).kind, "other");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reports the enclosing git repo and its origin", async () => {
  const root = tmp();
  try {
    const calls: string[][] = [];
    const run: Run = async (_cmd, args) => {
      calls.push(args);
      if (args[0] === "rev-parse") return { code: 0, stdout: `${root}\n`, stderr: "" };
      return { code: 0, stdout: "https://github.com/me/vault.git\n", stderr: "" };
    };
    const info = await inspectFolder(root, { run });
    assert.deepEqual(info.git, { root: path.resolve(root), origin: "https://github.com/me/vault.git" });
    assert.deepEqual(calls[0], ["rev-parse", "--show-toplevel"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --import tsx --test server/services/setup/inspect.test.ts`
Expected: FAIL — cannot find module `./inspect.ts`.

- [ ] **Step 3: Implement** — `server/services/setup/inspect.ts`:

```ts
/**
 * What's in a folder the user picked: nothing yet, a vault (skills.json),
 * a vault missing its manifest, a tool's skills folder (SKILL.md folders
 * directly inside — a target, not a vault), or something else. Also the
 * enclosing git repo and the vault's Notion database, for display.
 */
import fs from "node:fs";
import path from "node:path";
import type { Run } from "../appUpdate.ts";
import type { NotionRef } from "./types.ts";

export type FolderKind = "missing" | "not_dir" | "empty" | "vault" | "vault_no_manifest" | "skills_folder" | "other";

export interface FolderInfo {
  path: string;
  kind: FolderKind;
  /** The folder (or, when missing, its nearest existing parent) can be written. */
  writable: boolean;
  skill_count: number;
  git: { root: string; origin: string | null } | null;
  notion: NotionRef | null;
}

const hasSkillMd = (dir: string) => fs.existsSync(path.join(dir, "SKILL.md"));

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function nearestExisting(p: string): string | null {
  let cur = p;
  for (;;) {
    if (fs.existsSync(cur)) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

function isWritable(p: string): boolean {
  const at = nearestExisting(p);
  if (!at) return false;
  try {
    fs.accessSync(at, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function vaultSkillNames(vault: string): Set<string> {
  const names = new Set(subdirs(path.join(vault, "skills")).filter(hasSkillMd).map((d) => path.basename(d)));
  try {
    const m = JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf8")) as { skills?: Record<string, unknown> };
    for (const k of Object.keys(m.skills ?? {})) names.add(k);
  } catch {
    /* no or unreadable manifest: folders only */
  }
  return names;
}

function readNotionRef(vault: string): NotionRef | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(vault, "notion.json"), "utf8")) as Record<string, unknown>;
    return typeof s.data_source_id === "string" && s.data_source_id
      ? { id: s.data_source_id, name: typeof s.data_source_name === "string" ? s.data_source_name : "" }
      : null;
  } catch {
    return null;
  }
}

async function gitInfo(dir: string, run: Run): Promise<FolderInfo["git"]> {
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: dir, timeoutMs: 10_000 });
  if (top.code !== 0 || !top.stdout.trim()) return null;
  const root = path.resolve(top.stdout.trim());
  const origin = await run("git", ["remote", "get-url", "origin"], { cwd: root, timeoutMs: 10_000 });
  return { root, origin: origin.code === 0 && origin.stdout.trim() ? origin.stdout.trim() : null };
}

export async function inspectFolder(input: string, deps: { run: Run }): Promise<FolderInfo> {
  const abs = path.resolve(input);
  let stat: fs.Stats | null;
  try {
    stat = fs.statSync(abs);
  } catch {
    stat = null;
  }
  let kind: FolderKind;
  let skill_count = 0;
  if (!stat) kind = "missing";
  else if (!stat.isDirectory()) kind = "not_dir";
  else if (fs.readdirSync(abs).length === 0) kind = "empty";
  else if (fs.existsSync(path.join(abs, "skills.json"))) {
    kind = "vault";
    skill_count = vaultSkillNames(abs).size;
  } else {
    const inSkills = subdirs(path.join(abs, "skills")).filter(hasSkillMd).length;
    const direct = subdirs(abs).filter(hasSkillMd).length;
    if (inSkills > 0) {
      kind = "vault_no_manifest";
      skill_count = inSkills;
    } else if (direct > 0) {
      kind = "skills_folder";
      skill_count = direct;
    } else kind = "other";
  }
  const exists = kind !== "missing" && kind !== "not_dir";
  return {
    path: abs,
    kind,
    writable: kind !== "not_dir" && isWritable(abs),
    skill_count,
    git: exists ? await gitInfo(abs, deps.run) : null,
    notion: kind === "vault" || kind === "vault_no_manifest" ? readNotionRef(abs) : null,
  };
}
```

- [ ] **Step 4: Run the service test**

Run: `node --import tsx --test server/services/setup/inspect.test.ts`
Expected: PASS.

- [ ] **Step 5: Append the failing route test** to `server/routes/setup.test.ts`:

```ts
test("inspect: needs a path, then describes the folder", async () => {
  const notGit = async () => ({ code: 128, stdout: "", stderr: "" });
  const url = await serve(setup.setupRouter({ run: notGit }));
  assert.equal((await fetch(`${url}/inspect`, json({}))).status, 400);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-setup-i-"));
  const info = await (await fetch(`${url}/inspect`, json({ path: dir }))).json();
  assert.equal(info.kind, "empty");
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 6: Add the route** — in `server/routes/setup.ts` add imports `import { defaultRun, type Run } from "../services/appUpdate.ts";` and `import { inspectFolder } from "../services/setup/inspect.ts";`; add to `SetupRouterDeps`:

```ts
  /** Runs git (tests pass a fake). */
  run?: Run;
```

after `readBase`: `const run = deps.run ?? defaultRun;` and before `return router;`:

```ts
  router.post("/inspect", async (req, res) => {
    const p = (req.body as { path?: unknown } | undefined)?.path;
    if (typeof p !== "string" || !p.trim()) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    res.json(await inspectFolder(p.trim(), { run }));
  });
```

- [ ] **Step 7: Run the tests**

Run: `node --import tsx --test server/services/setup/inspect.test.ts server/routes/setup.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/services/setup/inspect.ts server/services/setup/inspect.test.ts server/routes/setup.ts server/routes/setup.test.ts
git commit -m "setup: inspect a picked folder" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Target detection

**Files:**
- Create: `server/services/setup/targets.ts`, `server/services/setup/targets.test.ts`
- Modify: `server/routes/setup.ts`, `server/routes/setup.test.ts`

**Interfaces:**
- Consumes: `Provider`, `AppConfig` from `server/types/vault.ts`; `readAppConfig` from `appConfig.ts`.
- Produces: `KNOWN_TARGETS`, `TargetStatus`, `DetectedTarget`, `targetStatus(path)`, `detectTargets(home, cfg)`; `SetupRouterDeps.readConfig?: () => AppConfig`; `GET /api/setup/targets → { targets: DetectedTarget[] }`.

- [ ] **Step 1: Write the failing test** — `server/services/setup/targets.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KNOWN_TARGETS, detectTargets } from "./targets.ts";

test("known tools are found, installed or not found; custom targets are kept", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sv-targets-"));
  try {
    fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
    fs.mkdirSync(path.join(home, ".cursor"));
    const custom = path.join(home, "repo", ".cursor", "skills");
    fs.mkdirSync(custom, { recursive: true });
    const list = detectTargets(home, {
      providers: [{ id: "claude", path: path.join(home, ".claude", "skills") }, { id: "Prompting BI", path: custom }],
      default_targets: ["claude"],
    });
    assert.deepEqual(list.slice(0, KNOWN_TARGETS.length).map((t) => t.id), ["claude", "openclaw", "cursor", "codex", "copilot", "windsurf"]);
    const byId = Object.fromEntries(list.map((t) => [t.id, t]));
    assert.equal(byId.claude.status, "found");
    assert.equal(byId.claude.configured, true);
    assert.equal(byId.claude.is_default, true);
    assert.equal(byId.cursor.status, "installed");
    assert.equal(byId.cursor.path, path.join(home, ".cursor", "skills"));
    assert.equal(byId.codex.status, "not_found");
    assert.equal(byId["Prompting BI"].known, false);
    assert.equal(byId["Prompting BI"].status, "found");
    assert.equal(byId["Prompting BI"].label, "Prompting BI");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a configured known tool keeps its configured folder", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sv-targets-"));
  try {
    const list = detectTargets(home, { providers: [{ id: "copilot", path: "D:\\elsewhere\\skills" }] });
    assert.equal(list.find((t) => t.id === "copilot")?.path, "D:\\elsewhere\\skills");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --import tsx --test server/services/setup/targets.test.ts`
Expected: FAIL — cannot find module `./targets.ts`.

- [ ] **Step 3: Implement** — `server/services/setup/targets.ts`:

```ts
/**
 * The tools the setup guide offers as targets. Same list and rule as the
 * CLI's `sv init` (src/skill_vault/config.py DEFAULT_AGENT_LOCATIONS and
 * discovery.detect_agent_dirs): a tool counts as installed when the parent
 * of its skills folder exists (e.g. ~/.cursor). Keep the two lists in step.
 */
import fs from "node:fs";
import path from "node:path";
import type { Provider } from "../../types/vault.ts";

export const KNOWN_TARGETS: ReadonlyArray<{ id: string; label: string; dir: string }> = [
  { id: "claude", label: "Claude Code", dir: ".claude" },
  { id: "openclaw", label: "OpenClaw", dir: ".openclaw" },
  { id: "cursor", label: "Cursor", dir: ".cursor" },
  { id: "codex", label: "Codex", dir: ".codex" },
  { id: "copilot", label: "Copilot", dir: ".copilot" },
  { id: "windsurf", label: "Windsurf", dir: ".windsurf" },
];

export type TargetStatus = "found" | "installed" | "not_found";

export interface DetectedTarget {
  id: string;
  label: string;
  path: string;
  status: TargetStatus;
  configured: boolean;
  is_default: boolean;
  known: boolean;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function targetStatus(p: string): TargetStatus {
  if (isDir(p)) return "found";
  if (isDir(path.dirname(p))) return "installed";
  return "not_found";
}

export function detectTargets(home: string, cfg: { providers: Provider[]; default_targets?: string[] }): DetectedTarget[] {
  const configured = new Map(cfg.providers.map((p) => [p.id, p.path]));
  const defaults = new Set(cfg.default_targets ?? []);
  const known = KNOWN_TARGETS.map((k) => {
    const p = configured.get(k.id) ?? path.join(home, k.dir, "skills");
    return {
      id: k.id,
      label: k.label,
      path: p,
      status: targetStatus(p),
      configured: configured.has(k.id),
      is_default: defaults.has(k.id),
      known: true,
    };
  });
  const custom = [...configured]
    .filter(([id]) => !KNOWN_TARGETS.some((k) => k.id === id))
    .map(([id, p]) => ({ id, label: id, path: p, status: targetStatus(p), configured: true, is_default: defaults.has(id), known: false }));
  return [...known, ...custom];
}
```

- [ ] **Step 4: Run the service test**

Run: `node --import tsx --test server/services/setup/targets.test.ts`
Expected: PASS.

- [ ] **Step 5: Append the failing route test** to `server/routes/setup.test.ts`:

```ts
test("targets: lists the known tools for the injected home", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sv-setup-t-"));
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  const url = await serve(
    setup.setupRouter({ home: () => home, readConfig: () => ({ vault_path: null, providers: [], default_targets: [] }) }),
  );
  const { targets } = await (await fetch(`${url}/targets`)).json();
  assert.equal(targets[0].id, "claude");
  assert.equal(targets[0].status, "found");
  fs.rmSync(home, { recursive: true, force: true });
});
```

- [ ] **Step 6: Add the route** — in `server/routes/setup.ts` change the appConfig import to `import { readAppConfig, readSetupBase } from "../services/appConfig.ts";`, add `import type { AppConfig } from "../types/vault.ts";` and `import { detectTargets } from "../services/setup/targets.ts";`. Add to `SetupRouterDeps`:

```ts
  /** Current app config (providers, default targets). */
  readConfig?: () => AppConfig;
```

After `const run = …`: `const readConfig = deps.readConfig ?? readAppConfig;` and before `return router;`:

```ts
  router.get("/targets", (_req, res) => {
    res.json({ targets: detectTargets(home(), readConfig()) });
  });
```

- [ ] **Step 7: Run the tests**

Run: `node --import tsx --test server/services/setup/targets.test.ts server/routes/setup.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/services/setup/targets.ts server/services/setup/targets.test.ts server/routes/setup.ts server/routes/setup.test.ts
git commit -m "setup: detect known tools as targets" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Clone preview

**Files:**
- Create: `server/services/setup/clonePreview.ts`, `server/services/setup/clonePreview.test.ts`
- Modify: `server/services/appUpdate.ts` (`Run` gains `interactiveAuth`), `server/routes/setup.ts`, `server/routes/setup.test.ts`

**Interfaces:**
- Consumes: `Run`, `defaultRun` (Task 3 import); `NotionRef`.
- Produces: `Run` options `{ cwd; env?; timeoutMs?; interactiveAuth?: boolean }`; `isCloneUrl(url)`, `CloneError`, `friendlyGitError(stderr)`, `VaultCandidate { subdir; skill_names; notion }`, `findVaultManifests(paths)`, `previewClone(url, { run, tmpRoot?, timeoutMs? }): Promise<VaultCandidate[]>`, `removeTree(dir)`; `SetupRouterDeps.tmpRoot?: string`; `POST /api/setup/clone-preview { url } → { candidates }`.

- [ ] **Step 1: Let git show its sign-in window when asked** — in `server/services/appUpdate.ts` change the `Run` type's options to:

```ts
  opts: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    /** git only: allow Git Credential Manager's own sign-in window (still never a terminal prompt). */
    interactiveAuth?: boolean;
  },
```

and in `defaultRun` replace the `env` line with:

```ts
    const env: NodeJS.ProcessEnv =
      cmd === "git"
        ? { ...baseEnv, GIT_TERMINAL_PROMPT: "0", ...(opts.interactiveAuth ? {} : { GCM_INTERACTIVE: "never" }) }
        : baseEnv;
```

- [ ] **Step 2: Write the failing test** — `server/services/setup/clonePreview.test.ts` (uses the real `git`):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRun } from "../appUpdate.ts";
import { CloneError, findVaultManifests, friendlyGitError, isCloneUrl, previewClone } from "./clonePreview.ts";

function makeRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-repo-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  if (Object.keys(files).length > 0) {
    git("add", "-A");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init");
  }
  return dir;
}

async function preview(repo: string) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sv-prev-"));
  try {
    const out = await previewClone(repo, { run: defaultRun, tmpRoot });
    assert.deepEqual(fs.readdirSync(tmpRoot), [], "temporary copy removed");
    return out;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

const SKILL = "---\nname: x\n---\n";

test("URL check", () => {
  assert.equal(isCloneUrl("https://github.com/me/vault.git"), true);
  assert.equal(isCloneUrl("ssh://git@github.com/me/vault.git"), true);
  assert.equal(isCloneUrl("git@github.com:me/vault.git"), true);
  assert.equal(isCloneUrl("C:\\repos\\vault"), false);
  assert.equal(isCloneUrl("http://github.com/me/vault"), false);
});

test("findVaultManifests keeps the shallowest skills.json in the top two levels", () => {
  assert.deepEqual(findVaultManifests(["skills.json", "skills/skills.json"]), ["skills.json"]);
  assert.deepEqual(findVaultManifests(["a/skills.json", "b/skills.json", "a/b/skills.json"]), ["a/skills.json", "b/skills.json"]);
  assert.deepEqual(findVaultManifests(["a/b/skills.json", "README.md"]), []);
});

test("friendly git errors", () => {
  assert.match(friendlyGitError("remote: Repository not found.\nfatal: repository 'x' not found"), /wasn't found/);
  assert.match(friendlyGitError("x\ntimed out after 120s"), /Timed out/);
  assert.equal(friendlyGitError("Cloning into 'x'...\nfatal: something odd"), "fatal: something odd");
});

test("vault at the repo root", async () => {
  const repo = makeRepo({
    "skills.json": JSON.stringify({ skills: { a: { targets: [] }, c: { targets: [] } } }),
    "skills/a/SKILL.md": SKILL,
    "skills/b/SKILL.md": SKILL,
    "notion.json": JSON.stringify({ data_source_id: "11111111-2222-3333-4444-555555555555", data_source_name: "Skills" }),
  });
  assert.deepEqual(await preview(repo), [
    { subdir: "", skill_names: ["a", "b", "c"], notion: { id: "11111111-2222-3333-4444-555555555555", name: "Skills" } },
  ]);
});

test("vault in a subfolder (like agent-skills/skills)", async () => {
  const repo = makeRepo({ "README.md": "hi", "skills/skills.json": "{\"skills\":{}}", "skills/skills/z/SKILL.md": SKILL });
  assert.deepEqual(await preview(repo), [{ subdir: "skills", skill_names: ["z"], notion: null }]);
});

test("two candidates at the same depth, and no vault at all", async () => {
  const two = makeRepo({ "a/skills.json": "{}", "b/skills.json": "{}" });
  assert.deepEqual((await preview(two)).map((c) => c.subdir), ["a", "b"]);
  const none = makeRepo({ "README.md": "hi" });
  assert.deepEqual(await preview(none), []);
});

test("an empty repo has no vault", async () => {
  assert.deepEqual(await preview(makeRepo({})), []);
});

test("a repo that doesn't exist is a CloneError and leaves no temp folder", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sv-prev-"));
  try {
    await assert.rejects(previewClone(path.join(tmpRoot, "missing-repo"), { run: defaultRun, tmpRoot }), CloneError);
    assert.deepEqual(fs.readdirSync(tmpRoot).filter((n) => n.startsWith("sv-clone-preview-")), []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `node --import tsx --test server/services/setup/clonePreview.test.ts`
Expected: FAIL — cannot find module `./clonePreview.ts`.

- [ ] **Step 4: Implement** — `server/services/setup/clonePreview.ts`:

```ts
/**
 * Look inside a vault repo before Finish without keeping a copy: a shallow,
 * blobless, no-checkout clone into a temp folder gives the file list; the
 * manifest (and notion.json) are read with `git show`, which fetches just
 * those blobs. The temp folder is always removed. The real clone happens on
 * Finish (services/setup/apply.ts).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Run } from "../appUpdate.ts";
import type { NotionRef } from "./types.ts";

const CLONE_URL = /^(?:https:\/\/|ssh:\/\/)\S+$|^[\w.-]+@[\w.-]+:\S+$/;

export function isCloneUrl(url: string): boolean {
  return CLONE_URL.test(url.trim());
}

export class CloneError extends Error {}

/** One plain sentence for a failed git command. */
export function friendlyGitError(stderr: string): string {
  if (/timed out/i.test(stderr)) return "Timed out. Check the URL and your connection, then try again.";
  if (/repository not found|not found|authentication failed|could not read username|permission denied|access denied|\b403\b/i.test(stderr)) {
    return "The repo wasn't found, or it needs a sign-in this PC doesn't have.";
  }
  if (/could not resolve host/i.test(stderr)) return "Couldn't reach the server. Check the URL and your connection.";
  const line = stderr
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s && !/^warning:/i.test(s) && !/^Cloning into/i.test(s));
  return line ?? "git clone failed";
}

export interface VaultCandidate {
  /** Folder inside the repo that holds skills.json ("" = repo root). */
  subdir: string;
  skill_names: string[];
  notion: NotionRef | null;
}

/** skills.json paths in the top two levels of the repo, shallowest only. */
export function findVaultManifests(paths: string[]): string[] {
  const hits = paths.filter((p) => /^(?:[^/]+\/)?skills\.json$/.test(p));
  if (hits.length === 0) return [];
  const depth = (p: string) => p.split("/").length;
  const min = Math.min(...hits.map(depth));
  return hits.filter((p) => depth(p) === min).sort();
}

function skillDirsUnder(paths: string[], subdir: string): string[] {
  const prefix = subdir ? `${subdir}/skills/` : "skills/";
  const names = new Set<string>();
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length).split("/");
    if (rest.length === 2 && rest[1] === "SKILL.md") names.add(rest[0]);
  }
  return [...names];
}

/** rm -rf that also clears read-only bits (git marks pack files read-only on Windows). */
export function removeTree(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    return;
  } catch {
    /* fall through: clear read-only bits, then retry */
  }
  const walk = (p: string): void => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    try {
      fs.chmodSync(p, st.isDirectory() ? 0o777 : 0o666);
    } catch {
      /* ignore */
    }
    if (st.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
  };
  walk(dir);
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    console.error(`[setup] couldn't remove ${dir}: ${(err as Error).message}`);
  }
}

async function showJson(run: Run, cwd: string, file: string): Promise<Record<string, unknown> | null> {
  const r = await run("git", ["show", `HEAD:${file}`], { cwd, timeoutMs: 60_000, interactiveAuth: true });
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function previewClone(
  url: string,
  deps: { run: Run; tmpRoot?: string; timeoutMs?: number },
): Promise<VaultCandidate[]> {
  const tmp = fs.mkdtempSync(path.join(deps.tmpRoot ?? os.tmpdir(), "sv-clone-preview-"));
  try {
    const clone = await deps.run(
      "git",
      ["clone", "--depth", "1", "--filter=blob:none", "--no-checkout", "--quiet", url, tmp],
      { cwd: path.dirname(tmp), timeoutMs: deps.timeoutMs ?? 120_000, interactiveAuth: true },
    );
    if (clone.code !== 0) throw new CloneError(friendlyGitError(clone.stderr));
    const tree = await deps.run("git", ["-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", "HEAD"], {
      cwd: tmp,
      timeoutMs: 30_000,
    });
    if (tree.code !== 0) {
      if (/not a valid object name|ambiguous argument 'HEAD'/i.test(tree.stderr)) return []; // empty repo
      throw new CloneError(friendlyGitError(tree.stderr));
    }
    const paths = tree.stdout.split(/\r?\n/).filter(Boolean);
    const out: VaultCandidate[] = [];
    for (const manifest of findVaultManifests(paths)) {
      const subdir = manifest.includes("/") ? manifest.slice(0, manifest.lastIndexOf("/")) : "";
      const names = new Set(skillDirsUnder(paths, subdir));
      const m = await showJson(deps.run, tmp, manifest);
      const skills = m?.skills;
      if (skills && typeof skills === "object") for (const k of Object.keys(skills)) names.add(k);
      const notionFile = subdir ? `${subdir}/notion.json` : "notion.json";
      const n = paths.includes(notionFile) ? await showJson(deps.run, tmp, notionFile) : null;
      out.push({
        subdir,
        skill_names: [...names].sort((a, b) => a.localeCompare(b)),
        notion:
          n && typeof n.data_source_id === "string" && n.data_source_id
            ? { id: n.data_source_id, name: typeof n.data_source_name === "string" ? n.data_source_name : "" }
            : null,
      });
    }
    return out;
  } finally {
    removeTree(tmp);
  }
}
```

- [ ] **Step 5: Run the service test**

Run: `node --import tsx --test server/services/setup/clonePreview.test.ts server/services/appUpdate.test.ts`
Expected: PASS.

- [ ] **Step 6: Append the failing route test** to `server/routes/setup.test.ts`:

```ts
test("clone-preview: only git URLs are accepted", async () => {
  const url = await serve(setup.setupRouter({ run: async () => ({ code: 0, stdout: "", stderr: "" }) }));
  const res = await fetch(`${url}/clone-preview`, json({ url: "C:\\repo" }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /https:\/\/, ssh:\/\/ or git@/);
});

test("clone-preview: a git failure is a 400 with a plain message", async () => {
  const failing = async () => ({ code: 128, stdout: "", stderr: "remote: Repository not found." });
  const url = await serve(setup.setupRouter({ run: failing }));
  const res = await fetch(`${url}/clone-preview`, json({ url: "https://github.com/me/nope.git" }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /wasn't found/);
});
```

- [ ] **Step 7: Add the route** — in `server/routes/setup.ts` add `import { CloneError, isCloneUrl, previewClone } from "../services/setup/clonePreview.ts";`, add to `SetupRouterDeps`:

```ts
  /** Parent folder for temporary clone previews (default: the OS temp folder). */
  tmpRoot?: string;
```

and before `return router;`:

```ts
  router.post("/clone-preview", async (req, res) => {
    const url = (req.body as { url?: unknown } | undefined)?.url;
    if (typeof url !== "string" || !isCloneUrl(url)) {
      res.status(400).json({ error: "Enter an https://, ssh:// or git@ URL." });
      return;
    }
    try {
      res.json({ candidates: await previewClone(url.trim(), { run, tmpRoot: deps.tmpRoot }) });
    } catch (err) {
      if (err instanceof CloneError) res.status(400).json({ error: err.message });
      else res.status(500).json({ error: (err as Error).message });
    }
  });
```

- [ ] **Step 8: Run the tests**

Run: `node --import tsx --test server/routes/setup.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/services/appUpdate.ts server/services/setup/clonePreview.ts server/services/setup/clonePreview.test.ts server/routes/setup.ts server/routes/setup.test.ts
git commit -m "setup: preview a vault repo before cloning" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Skills plan (adopt / push / differs)

**Files:**
- Create: `server/services/setup/plan.ts`, `server/services/setup/plan.test.ts`
- Modify: `server/routes/setup.ts`, `server/routes/setup.test.ts`

**Interfaces:**
- Consumes: `hashSkillDirNormalized(dir): string | null` from `server/services/skillHash.ts`; `SetupDraft`; `normalizeDraft`; `readConfig` (Task 4).
- Produces: `EffectiveTarget { id; path; is_default }`, `effectiveTargets(draft, cfg)`, `PlanInput`, `SkillsPlan { adopt; adopt_conflicts; push; differs }`, `planSkills(input)`; `POST /api/setup/plan { draft } → SkillsPlan`.

- [ ] **Step 1: Write the failing test** — `server/services/setup/plan.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { effectiveTargets, planSkills } from "./plan.ts";
import { startDraft } from "./draft.ts";

const skill = (dir: string, name: string, body = "A") => {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\n---\n${body}\n`);
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-plan-"));
  const vault = path.join(root, "vault");
  const vs = path.join(vault, "skills");
  const t1 = path.join(root, "t1");
  const t2 = path.join(root, "t2");
  for (const d of [vs, t1, t2]) fs.mkdirSync(d, { recursive: true });
  skill(vs, "linked");
  fs.symlinkSync(path.join(vs, "linked"), path.join(t1, "linked"), "junction");
  skill(vs, "same");
  skill(t1, "same");
  skill(vs, "changed", "A");
  skill(t1, "changed", "B");
  skill(t1, "newone");
  skill(t2, "newone");
  skill(t1, "split", "A");
  skill(t2, "split", "B");
  skill(vs, "vaultonly");
  return { root, vault, t1, t2 };
}

test("existing vault: linked and identical skills are left alone", () => {
  const f = fixture();
  try {
    const plan = planSkills({
      vault: { mode: "existing", path: f.vault },
      targets: [
        { id: "t1", path: f.t1, is_default: true },
        { id: "t2", path: f.t2, is_default: false },
      ],
    });
    assert.deepEqual(plan.adopt, [{ name: "newone", from: "t1", path: path.join(f.t1, "newone") }]);
    assert.deepEqual(plan.adopt_conflicts, [{ name: "split", targets: ["t1", "t2"] }]);
    assert.deepEqual(plan.differs, [{ name: "changed", target: "t1", unknown: false }]);
    assert.deepEqual(plan.push, [{ name: "vaultonly", missing_in: ["t1"] }]);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("new vault: everything in the targets is adoptable", () => {
  const f = fixture();
  try {
    const plan = planSkills({ vault: { mode: "new", path: path.join(f.root, "fresh") }, targets: [{ id: "t1", path: f.t1, is_default: true }] });
    assert.deepEqual(plan.adopt.map((a) => a.name), ["changed", "linked", "newone", "same", "split"]);
    assert.deepEqual(plan.push, []);
    assert.deepEqual(plan.differs, []);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("clone: same-name skills can't be compared yet", () => {
  const f = fixture();
  try {
    const plan = planSkills({
      vault: { mode: "clone", path: path.join(f.root, "clone"), clone_skill_names: ["changed", "x"] },
      targets: [{ id: "t1", path: f.t1, is_default: true }],
    });
    assert.deepEqual(plan.differs, [{ name: "changed", target: "t1", unknown: true }]);
    assert.deepEqual(plan.push, [{ name: "x", missing_in: ["t1"] }]);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("effectiveTargets: draft targets when chosen, else the config's", () => {
  const draft = startDraft({ vault_path: "C:\\v", agent_locations: {}, default_targets: [], machine_id: null, repo_url: null });
  const cfg = { vault_path: "C:\\v", providers: [{ id: "claude", path: "C:\\c" }, { id: "cursor", path: "C:\\u" }], default_targets: ["cursor"] };
  assert.deepEqual(effectiveTargets(draft, cfg), [
    { id: "claude", path: "C:\\c", is_default: false },
    { id: "cursor", path: "C:\\u", is_default: true },
  ]);
  const chosen = { ...draft, targets: [{ id: "a", path: "C:\\a", enabled: true, is_default: true, known: false }, { id: "b", path: "C:\\b", enabled: false, is_default: false, known: false }] };
  assert.deepEqual(effectiveTargets(chosen, cfg), [{ id: "a", path: "C:\\a", is_default: true }]);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --import tsx --test server/services/setup/plan.test.ts`
Expected: FAIL — cannot find module `./plan.ts`.

- [ ] **Step 3: Implement** — `server/services/setup/plan.ts`:

```ts
/**
 * The setup guide's optional Skills step: which skills in the chosen targets
 * aren't in the vault (adopt), which vault skills aren't in the default
 * targets (push), and which names exist on both sides with different content
 * (never moved — sorted out later on the Adopt page). A target entry that is
 * a link into the vault, or an identical copy, needs nothing.
 */
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../../types/vault.ts";
import { hashSkillDirNormalized } from "../skillHash.ts";
import type { SetupDraft } from "./types.ts";

export interface EffectiveTarget {
  id: string;
  path: string;
  is_default: boolean;
}

/** The targets Finish will save: the draft's (enabled only) when chosen, else the config's. */
export function effectiveTargets(draft: SetupDraft, cfg: Pick<AppConfig, "providers" | "default_targets">): EffectiveTarget[] {
  if (draft.targets) return draft.targets.filter((t) => t.enabled).map((t) => ({ id: t.id, path: t.path, is_default: t.is_default }));
  const defaults = new Set(cfg.default_targets ?? []);
  return cfg.providers.map((p) => ({ id: p.id, path: p.path, is_default: defaults.has(p.id) }));
}

export interface PlanInput {
  vault: { mode: "new" | "existing" | "clone"; path: string; clone_skill_names?: string[] };
  targets: EffectiveTarget[];
}

export interface SkillsPlan {
  adopt: { name: string; from: string; path: string }[];
  /** Not in the vault, but different in two targets: can't pick one here. */
  adopt_conflicts: { name: string; targets: string[] }[];
  push: { name: string; missing_in: string[] }[];
  /** In the vault and in a target with different content; unknown = the vault isn't cloned yet. */
  differs: { name: string; target: string; unknown: boolean }[];
}

/** name → folder for every entry (folder or link) that has a SKILL.md. */
function skillEntries(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if ((e.isDirectory() || e.isSymbolicLink()) && fs.existsSync(path.join(p, "SKILL.md"))) out.set(e.name, p);
  }
  return out;
}

function presentNames(dir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(dir));
  } catch {
    return new Set();
  }
}

function real(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

export function planSkills(input: PlanInput): SkillsPlan {
  const vaultSkills = new Map<string, string | null>();
  if (input.vault.mode === "existing") {
    for (const [name, dir] of skillEntries(path.join(input.vault.path, "skills"))) vaultSkills.set(name, dir);
  } else if (input.vault.mode === "clone") {
    for (const name of input.vault.clone_skill_names ?? []) vaultSkills.set(name, null);
  }

  const hashCache = new Map<string, string | null>();
  const hash = (dir: string) => {
    const key = real(dir);
    if (!hashCache.has(key)) hashCache.set(key, hashSkillDirNormalized(dir));
    return hashCache.get(key) ?? null;
  };

  const differs: SkillsPlan["differs"] = [];
  const candidates = new Map<string, { target: string; path: string }[]>();
  for (const t of input.targets) {
    for (const [name, entry] of skillEntries(t.path)) {
      if (!vaultSkills.has(name)) {
        candidates.set(name, [...(candidates.get(name) ?? []), { target: t.id, path: entry }]);
        continue;
      }
      const vaultDir = vaultSkills.get(name) ?? null;
      if (vaultDir === null) {
        differs.push({ name, target: t.id, unknown: true });
      } else if (real(entry) !== real(vaultDir) && hash(entry) !== hash(vaultDir)) {
        differs.push({ name, target: t.id, unknown: false });
      }
    }
  }

  const adopt: SkillsPlan["adopt"] = [];
  const adopt_conflicts: SkillsPlan["adopt_conflicts"] = [];
  for (const [name, copies] of candidates) {
    const first = hash(copies[0].path);
    if (copies.every((c) => hash(c.path) === first)) adopt.push({ name, from: copies[0].target, path: copies[0].path });
    else adopt_conflicts.push({ name, targets: copies.map((c) => c.target) });
  }

  const defaults = input.targets.filter((t) => t.is_default).map((t) => ({ id: t.id, present: presentNames(t.path) }));
  const push: SkillsPlan["push"] = [];
  for (const name of vaultSkills.keys()) {
    const missing_in = defaults.filter((d) => !d.present.has(name)).map((d) => d.id);
    if (missing_in.length > 0) push.push({ name, missing_in });
  }

  return {
    adopt: adopt.sort(byName),
    adopt_conflicts: adopt_conflicts.sort(byName),
    push: push.sort(byName),
    differs: differs.sort(byName),
  };
}
```

- [ ] **Step 4: Run the service test**

Run: `node --import tsx --test server/services/setup/plan.test.ts`
Expected: PASS. (In the first test `linked` is present in t1 and missing only in t2, which isn't a default target, so it doesn't appear in `push`.)

- [ ] **Step 5: Append the failing route test** to `server/routes/setup.test.ts`:

```ts
test("plan: needs a vault in the draft", async () => {
  const { startDraft } = await import("../services/setup/draft.ts");
  const url = await serve(setup.setupRouter({ readConfig: () => ({ vault_path: null, providers: [], default_targets: [] }) }));
  const draft = startDraft({ vault_path: null, agent_locations: {}, default_targets: [], machine_id: null, repo_url: null });
  assert.equal((await fetch(`${url}/plan`, json({ draft }))).status, 400);
  const withVault = { ...draft, vault: { mode: "new", path: path.join(os.tmpdir(), "sv-none-xyz") } };
  const plan = await (await fetch(`${url}/plan`, json({ draft: withVault }))).json();
  assert.deepEqual(plan, { adopt: [], adopt_conflicts: [], push: [], differs: [] });
});
```

- [ ] **Step 6: Add the route** — in `server/routes/setup.ts` add `import { effectiveTargets, planSkills } from "../services/setup/plan.ts";` and before `return router;`:

```ts
  router.post("/plan", (req, res) => {
    let draft;
    try {
      draft = normalizeDraft((req.body as { draft?: unknown } | undefined)?.draft);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    if (!draft.vault) {
      res.status(400).json({ error: "Choose a vault first." });
      return;
    }
    res.json(
      planSkills({
        vault: { mode: draft.vault.mode, path: draft.vault.path, clone_skill_names: draft.vault.clone?.skill_names },
        targets: effectiveTargets(draft, readConfig()),
      }),
    );
  });
```

- [ ] **Step 7: Run the tests**

Run: `node --import tsx --test server/services/setup/plan.test.ts server/routes/setup.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/services/setup/plan.ts server/services/setup/plan.test.ts server/routes/setup.ts server/routes/setup.test.ts
git commit -m "setup: plan which skills to adopt and push" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Reusable push, Notion database and config writers

**Files:**
- Create: `server/services/pushSkill.ts`, `server/services/pushSkill.test.ts`, `server/services/notion/dataSource.ts`, `server/services/notion/dataSource.test.ts`, `server/services/appConfig.setup.test.ts`
- Modify: `server/routes/push.ts`, `server/routes/notion.ts`, `server/services/appConfig.ts`

**Interfaces:**
- Consumes: `linkSkillDir(source, target, { forceCopy? })` from `services/linking.ts`; `skillDir`, `readManifest`, `writeManifest` from `services/vault.ts`; `NotionApi`, `getNotionClient`, `callToolJson`, `writeNotionSettings`; `applyClaudeAuthPatch`, `ClaudeAuthPatch`, `ClaudeAuthConfig`.
- Produces: `pushSkillToProvider(vaultPath, skill, provider, opts?): PushResult`, `PushSkipError`; `LAST_EDITED_PROPERTY`, `DATA_SOURCE_ID`, `chooseDataSource(api, vaultPath, choice)`, `openNotionApiAt(redirectUrl)`, `NotionApiConn`; `SetupConfigPatch`, `writeSetupConfig(patch): AppConfig`.

- [ ] **Step 1: Write the failing push test** — `server/services/pushSkill.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pushSkillToProvider } from "./pushSkill.ts";

test("links the skill into the provider and records the target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-push-"));
  try {
    const vault = path.join(root, "vault");
    fs.mkdirSync(path.join(vault, "skills", "a"), { recursive: true });
    fs.writeFileSync(path.join(vault, "skills", "a", "SKILL.md"), "---\nname: a\n---\n");
    fs.writeFileSync(path.join(vault, "skills.json"), JSON.stringify({ skills: { a: { targets: [] } } }));
    const provider = { id: "claude", path: path.join(root, "claude") };
    fs.mkdirSync(provider.path);
    const r = pushSkillToProvider(vault, "a", provider);
    assert.equal(r.skill, "a");
    assert.ok(fs.existsSync(path.join(provider.path, "a", "SKILL.md")));
    const manifest = JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf8"));
    assert.deepEqual(manifest.skills.a.targets, ["claude"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --import tsx --test server/services/pushSkill.test.ts`
Expected: FAIL — cannot find module `./pushSkill.ts`.

- [ ] **Step 3: Implement** — `server/services/pushSkill.ts`:

```ts
/**
 * Push one skill to one provider: link (symlink → junction → copy, see
 * linking.ts) the provider's <skill> folder to the vault copy, then record the
 * provider in the skill's `targets` in skills.json. Shared by POST /api/push
 * and the setup guide's Finish job.
 */
import path from "node:path";
import { linkSkillDir } from "./linking.ts";
import { readManifest, skillDir, writeManifest } from "./vault.ts";
import type { Provider, PushResult } from "../types/vault.ts";

/** linkSkillDir refused (circular or invalid path). */
export class PushSkipError extends Error {}

export function pushSkillToProvider(
  vaultPath: string,
  skill: string,
  provider: Provider,
  opts: { forceCopy?: boolean } = {},
): PushResult {
  const result = linkSkillDir(skillDir(vaultPath, skill), path.join(provider.path, skill), opts);
  if (result.method === "skip") throw new PushSkipError(result.reason ?? "skipped (circular or invalid path)");
  const manifest = readManifest(vaultPath);
  const entry = manifest.skills[skill] ?? { targets: [] };
  if (!entry.targets.includes(provider.id)) {
    entry.targets = [...entry.targets, provider.id];
    manifest.skills[skill] = entry;
    writeManifest(vaultPath, manifest);
  }
  return { skill, target_path: result.target, method: result.method as PushResult["method"] };
}
```

- [ ] **Step 4: Use it in `server/routes/push.ts`** — replace the imports of `path`, `skillDir/readManifest/writeManifest` and `linkSkillDir` with `import { PushSkipError, pushSkillToProvider } from "../services/pushSkill.ts";`, delete the `source`/`target`/`forceCopy` consts, and replace the `try { … } catch { … }` block (after the "starting" activity record) with:

```ts
    try {
      const out = pushSkillToProvider(cfg.vault_path, body.skill, provider, { forceCopy: body.method === "copy" });
      recordActivity({
        kind: "push",
        skill: body.skill,
        provider_id: body.provider_id,
        ok: true,
        message: `linked via ${out.method}`,
      });
      res.json(out);
    } catch (err) {
      recordActivity({
        kind: "push",
        skill: body.skill,
        provider_id: body.provider_id,
        ok: false,
        message: (err as Error).message,
      });
      res.status(err instanceof PushSkipError ? 409 : 500).json({ error: (err as Error).message });
    }
```

(Remove the now-unused `PushResult` type import if TypeScript flags it.)

- [ ] **Step 5: Write the failing data-source test** — `server/services/notion/dataSource.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LAST_EDITED_PROPERTY, chooseDataSource } from "./dataSource.ts";

const ID = "11111111-2222-3333-4444-555555555555";

test("adds the Last edited property when asked and saves the choice", async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "sv-ds-"));
  try {
    let added = false;
    const api = {
      hasProperty: async () => added,
      addLastEditedProperty: async () => {
        added = true;
      },
    };
    const r = await chooseDataSource(api, vault, { id: ID, name: "Skills", add_last_edited: true });
    assert.deepEqual(r, { last_edited_property: LAST_EDITED_PROPERTY });
    const saved = JSON.parse(fs.readFileSync(path.join(vault, "notion.json"), "utf8"));
    assert.equal(saved.data_source_id, ID);
    assert.equal(saved.data_source_name, "Skills");
    assert.equal(saved.last_edited_property, LAST_EDITED_PROPERTY);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test("without the property and not asked: null, plus a warning when adding fails", async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "sv-ds-"));
  try {
    const none = { hasProperty: async () => false, addLastEditedProperty: async () => {} };
    assert.deepEqual(await chooseDataSource(none, vault, { id: ID, name: "", add_last_edited: false }), { last_edited_property: null });
    const broken = { hasProperty: async () => false, addLastEditedProperty: async () => { throw new Error("no access"); } };
    const r = await chooseDataSource(broken, vault, { id: ID, name: "", add_last_edited: true });
    assert.equal(r.last_edited_property, null);
    assert.match(r.warning ?? "", /no access/);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `node --import tsx --test server/services/notion/dataSource.test.ts`
Expected: FAIL — cannot find module `./dataSource.ts`.

- [ ] **Step 7: Implement** — `server/services/notion/dataSource.ts`:

```ts
/**
 * Choosing the Notion Skills data source (shared by POST /api/notion/data-source
 * and the setup guide's Finish job), and opening a connected NotionApi.
 */
import { NotionApi } from "./api.ts";
import { callToolJson, getNotionClient } from "./connection.ts";
import { writeNotionSettings } from "./store.ts";

export const LAST_EDITED_PROPERTY = "Last edited";
/** A Notion data source id: a UUID, with or without dashes. */
export const DATA_SOURCE_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export interface NotionApiConn {
  api: NotionApi;
  close(): Promise<void>;
}

export async function openNotionApiAt(redirectUrl: string): Promise<NotionApiConn> {
  const client = await getNotionClient(redirectUrl);
  return {
    api: new NotionApi((name, args) => callToolJson(client, name, args)),
    close: () => client.close(),
  };
}

/** Save the chosen data source to <vault>/notion.json, adding "Last edited" first when asked. */
export async function chooseDataSource(
  api: Pick<NotionApi, "hasProperty" | "addLastEditedProperty">,
  vaultPath: string,
  choice: { id: string; name: string; add_last_edited: boolean },
): Promise<{ last_edited_property: string | null; warning?: string }> {
  let has = await api.hasProperty(choice.id, LAST_EDITED_PROPERTY, "last_edited_time");
  let warning: string | undefined;
  if (!has && choice.add_last_edited) {
    try {
      await api.addLastEditedProperty(choice.id, LAST_EDITED_PROPERTY);
      has = await api.hasProperty(choice.id, LAST_EDITED_PROPERTY, "last_edited_time");
      if (!has) warning = `Could not verify the "${LAST_EDITED_PROPERTY}" property after adding it`;
    } catch (err) {
      warning = `Could not add "${LAST_EDITED_PROPERTY}": ${(err as Error).message}`;
    }
  }
  const last_edited_property = has ? LAST_EDITED_PROPERTY : null;
  writeNotionSettings(vaultPath, { data_source_id: choice.id, data_source_name: choice.name, last_edited_property });
  return { last_edited_property, ...(warning ? { warning } : {}) };
}
```

- [ ] **Step 8: Use it in `server/routes/notion.ts`**
  - Add `import { DATA_SOURCE_ID, LAST_EDITED_PROPERTY, chooseDataSource, openNotionApiAt } from "../services/notion/dataSource.ts";` and `export { LAST_EDITED_PROPERTY };` (other modules import it from here — keep that working).
  - Delete the local `export const LAST_EDITED_PROPERTY = …` and `const DATA_SOURCE_ID = …` lines.
  - Replace the body of `getApi` with `return openNotionApiAt(redirectUrlFor(req));` (the `ApiConn` type stays compatible).
  - In `POST /data-source`, replace the `try { … }` block with:

```ts
    try {
      const r = await withApi(req, (api) => chooseDataSource(api, vp, { id, name: dsName, add_last_edited: add_last_edited === true }));
      res.json({ ok: true, ...r });
    } catch (err) {
      sendError(res, err);
    }
```

  - Remove imports that become unused (`NotionApi`, `callToolJson`, `writeNotionSettings`) only if TypeScript flags them.

- [ ] **Step 9: Write the failing config test** — `server/services/appConfig.setup.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// appConfig.ts fixes the config path at import time: point HOME at a temp folder first.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "sv-cfg-"));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
const file = path.join(fakeHome, ".skill-vault", "config.json");

let cfg: typeof import("./appConfig.ts");
before(async () => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      vault_path: "C:\\old",
      perplexity_stage: "C:\\stage",
      machine_id: "OLD",
      repo_url: "",
      agent_locations: { claude: "C:\\c" },
      default_targets: ["claude"],
      assistant: { auth: "login", api_key: "sk-old" },
    }),
  );
  cfg = await import("./appConfig.ts");
});
after(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

test("readSetupBase reads the guide's fields", () => {
  assert.deepEqual(cfg.readSetupBase(), {
    vault_path: "C:\\old",
    agent_locations: { claude: "C:\\c" },
    default_targets: ["claude"],
    machine_id: "OLD",
    repo_url: null,
  });
});

test("writeSetupConfig writes everything in one go and keeps other keys", () => {
  cfg.writeSetupConfig({
    vault_path: "C:\\new",
    providers: [{ id: "cursor", path: "C:\\u" }],
    default_targets: ["cursor"],
    repo_url: "https://github.com/me/v.git",
    machine_id: "PC2",
    assistant: { auth: "api_key", workspace_id: "wrk" },
  });
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.vault_path, "C:\\new");
  assert.deepEqual(raw.agent_locations, { cursor: "C:\\u" });
  assert.deepEqual(raw.default_targets, ["cursor"]);
  assert.equal(raw.repo_url, "https://github.com/me/v.git");
  assert.equal(raw.machine_id, "PC2");
  assert.equal(raw.perplexity_stage, "C:\\stage");
  assert.deepEqual(raw.assistant, { auth: "api_key", api_key: "sk-old", workspace_id: "wrk" });
});

test("writeSetupConfig leaves targets and assistant alone when not given", () => {
  cfg.writeSetupConfig({ vault_path: "C:\\third" });
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.vault_path, "C:\\third");
  assert.deepEqual(raw.agent_locations, { cursor: "C:\\u" });
  assert.equal(raw.assistant.auth, "api_key");
});
```

- [ ] **Step 10: Run it to see it fail**

Run: `node --import tsx --test server/services/appConfig.setup.test.ts`
Expected: FAIL — `cfg.writeSetupConfig is not a function`.

- [ ] **Step 11: Implement** — in `server/services/appConfig.ts` change the auth import to `import { applyClaudeAuthPatch, type ClaudeAuthConfig, type ClaudeAuthPatch } from "./claude/auth.ts";` and add after `writeAppConfig`:

```ts
/** Everything the setup guide saves on Finish (services/setup/apply.ts, step 2). */
export interface SetupConfigPatch {
  vault_path: string;
  providers?: Provider[];
  default_targets?: string[];
  repo_url?: string;
  machine_id?: string;
  assistant?: ClaudeAuthPatch;
}

/** One atomic write for the setup guide. Keys the app doesn't own are preserved. */
export function writeSetupConfig(patch: SetupConfigPatch): AppConfig {
  const raw = readRaw();
  raw.vault_path = patch.vault_path;
  if (patch.providers) raw.agent_locations = Object.fromEntries(patch.providers.map((p) => [p.id, p.path]));
  if (patch.default_targets) raw.default_targets = patch.default_targets;
  if (patch.repo_url !== undefined) raw.repo_url = patch.repo_url;
  if (patch.machine_id) raw.machine_id = patch.machine_id;
  if (patch.assistant) {
    const current = raw.assistant && typeof raw.assistant === "object" ? (raw.assistant as ClaudeAuthConfig) : {};
    raw.assistant = applyClaudeAuthPatch(current, patch.assistant);
  }
  writeRaw(raw);
  return readAppConfig();
}
```

- [ ] **Step 12: Run everything touched**

Run: `node --import tsx --test server/services/pushSkill.test.ts server/services/notion/dataSource.test.ts server/services/appConfig.setup.test.ts server/routes/notion.test.ts`
Then: `npm test` and `npm run typecheck`
Expected: PASS everywhere.

- [ ] **Step 13: Commit**

```bash
git add server/services/pushSkill.ts server/services/pushSkill.test.ts server/services/notion/dataSource.ts server/services/notion/dataSource.test.ts server/services/appConfig.ts server/services/appConfig.setup.test.ts server/routes/push.ts server/routes/notion.ts
git commit -m "refactor: shared push, Notion database and setup config writers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The Finish job

**Files:**
- Create: `server/services/setup/apply.ts`, `server/services/setup/apply.test.ts`, `server/services/setup/applyDeps.ts`
- Modify: `server/routes/setup.ts`, `server/routes/setup.test.ts`, `server/index.ts`, `server/routes/notion.ts` (export `redirectUrlFor` — already exported; just import it)

**Interfaces:**
- Consumes: `effectiveTargets`, `EffectiveTarget` (Task 6); `friendlyGitError` (Task 5); `SetupConfigPatch`, `writeSetupConfig`, `readAppConfig`; `pushSkillToProvider`; `chooseDataSource`, `openNotionApiAt`; `importSkills(vault, sourceDir, names, providerId?, paths?, items?)` from `services/adoption.ts`; `initVault`; `rebuildWatcher` from `services/watcher.ts`; `deleteDraft`; `redirectUrlFor(req)` from `routes/notion.ts`.
- Produces: `ApplyStep`, `SetupEvent`, `FailedItem`, `SetupJobState`, `ApplyRequest`, `SetupApplyDeps`, `SetupApplier { isRunning; status; apply; retry }`, `SetupBusyError`, `createSetupApplier(deps)`, `configPatch(draft, targets, apiKey?)`; `defaultApplyDeps(home?)`; `SetupRouterDeps.applier?: SetupApplier`; routes `POST /apply` (NDJSON), `POST /apply/retry` (NDJSON), `GET /apply/status`.

- [ ] **Step 1: Write the failing test** — `server/services/setup/apply.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Run } from "../appUpdate.ts";
import type { SetupConfigPatch } from "../appConfig.ts";
import { SetupBusyError, createSetupApplier, type SetupApplyDeps, type SetupEvent } from "./apply.ts";
import { startDraft } from "./draft.ts";
import type { SetupDraft } from "./types.ts";

const emptyBase = { vault_path: null, agent_locations: {}, default_targets: [], machine_id: "PC", repo_url: null };

function harness(over: Partial<SetupApplyDeps> = {}) {
  const calls = { init: [] as string[], config: [] as SetupConfigPatch[], adopt: [] as string[], push: [] as string[], notion: 0, draftDeleted: 0, watcher: 0 };
  const deps: SetupApplyDeps = {
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    readConfig: () => ({ vault_path: null, providers: [], default_targets: [] }),
    initVault: (p) => {
      calls.init.push(p);
      fs.mkdirSync(path.join(p, "skills"), { recursive: true });
    },
    writeConfig: (p) => {
      calls.config.push(p);
    },
    rebuildWatcher: () => {
      calls.watcher++;
    },
    adopt: (_v, item) => {
      calls.adopt.push(item.name);
      return "imported";
    },
    push: (_v, skill, provider) => {
      calls.push.push(`${skill}->${provider.id}`);
    },
    saveNotion: async () => {
      calls.notion++;
      return {};
    },
    deleteDraft: () => {
      calls.draftDeleted++;
    },
    ...over,
  };
  return { deps, calls, applier: createSetupApplier(deps) };
}

function draftWith(patch: Partial<SetupDraft>): SetupDraft {
  return { ...startDraft(emptyBase), ...patch };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sv-apply-"));

test("new vault: folder, config, items, then the draft is deleted", async () => {
  const root = tmp();
  try {
    const t1 = path.join(root, "t1");
    fs.mkdirSync(path.join(t1, "found"), { recursive: true });
    const { applier, calls } = harness();
    const events: SetupEvent[] = [];
    const draft = draftWith({
      vault: { mode: "new", path: path.join(root, "vault") },
      targets: [{ id: "t1", path: t1, enabled: true, is_default: true, known: false }],
      skills: { adopt: [{ name: "found", from: "t1" }], push: ["mine"] },
      notion: { data_source_id: "11111111-2222-3333-4444-555555555555", data_source_name: "Skills", add_last_edited: true },
      assistant: { auth: "api_key", workspace_id: "wrk" },
    });
    const state = await applier.apply({ draft, api_key: "sk-secret" }, (e) => events.push(e));
    assert.equal(state.ok, true);
    assert.ok(fs.existsSync(path.join(root, "vault")));
    assert.deepEqual(calls.init, [path.join(root, "vault")]);
    assert.deepEqual(calls.config[0], {
      vault_path: path.join(root, "vault"),
      providers: [{ id: "t1", path: t1 }],
      default_targets: ["t1"],
      repo_url: "",
      machine_id: "PC",
      assistant: { auth: "api_key", workspace_id: "wrk", api_key: "sk-secret" },
    });
    assert.equal(calls.watcher, 1);
    assert.deepEqual(calls.adopt, ["found"]);
    assert.deepEqual(calls.push, ["mine->t1"]);
    assert.equal(calls.notion, 1);
    assert.equal(calls.draftDeleted, 1);
    assert.deepEqual(events.map((e) => `${e.step}:${e.state}`), [
      "vault:start", "vault:done", "config:start", "config:done",
      "adopt:start", "adopt:done", "push:start", "push:done", "notion:start", "notion:done", "done:done",
    ]);
    assert.ok(!JSON.stringify(events).includes("sk-secret"), "API key never in events");
    assert.ok(!JSON.stringify(applier.status()).includes("sk-secret"), "API key never in status");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a new vault folder that isn't empty stops before config", async () => {
  const root = tmp();
  try {
    fs.writeFileSync(path.join(root, "x.txt"), "x");
    const { applier, calls } = harness();
    const state = await applier.apply({ draft: draftWith({ vault: { mode: "new", path: root } }) }, () => {});
    assert.equal(state.ok, false);
    assert.equal(state.vault_path, null);
    assert.match(state.events.at(-1)?.message ?? "", /isn't empty/);
    assert.equal(calls.config.length, 0);
    assert.equal(calls.draftDeleted, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("clone: failure is plain words; success clones into dest and saves the repo URL", async () => {
  const root = tmp();
  try {
    const clone = { url: "https://github.com/me/v.git", dest: path.join(root, "v"), subdir: "skills", skill_names: [], notion: null };
    const failing: Run = async () => ({ code: 128, stdout: "", stderr: "remote: Repository not found." });
    const bad = harness({ run: failing });
    const failed = await bad.applier.apply({ draft: draftWith({ vault: { mode: "clone", path: path.join(clone.dest, "skills"), clone } }) }, () => {});
    assert.equal(failed.ok, false);
    assert.match(failed.events.at(-1)?.message ?? "", /wasn't found/);
    assert.equal(bad.calls.config.length, 0);

    const seen: string[][] = [];
    const cloning: Run = async (_cmd, args) => {
      seen.push(args);
      fs.mkdirSync(path.join(clone.dest, "skills"), { recursive: true });
      return { code: 0, stdout: "", stderr: "" };
    };
    const good = harness({ run: cloning });
    const ok = await good.applier.apply({ draft: draftWith({ vault: { mode: "clone", path: path.join(clone.dest, "skills"), clone } }) }, () => {});
    assert.equal(ok.ok, true);
    assert.deepEqual(seen[0], ["clone", "--quiet", clone.url, clone.dest]);
    assert.equal(good.calls.config[0].vault_path, path.join(clone.dest, "skills"));
    assert.equal(good.calls.config[0].repo_url, clone.url);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a config write failure after a clone names the cloned folder", async () => {
  const root = tmp();
  try {
    const clone = { url: "https://github.com/me/v.git", dest: path.join(root, "v"), subdir: "", skill_names: [], notion: null };
    const { applier } = harness({
      run: async () => {
        fs.mkdirSync(clone.dest, { recursive: true });
        return { code: 0, stdout: "", stderr: "" };
      },
      writeConfig: () => {
        throw new Error("disk full");
      },
    });
    const state = await applier.apply({ draft: draftWith({ vault: { mode: "clone", path: clone.dest, clone } }) }, () => {});
    assert.equal(state.ok, false);
    assert.match(state.events.at(-1)?.message ?? "", /disk full/);
    assert.ok((state.events.at(-1)?.message ?? "").includes(clone.dest));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("item failures don't stop the job; retry re-runs only the failed ones", async () => {
  const root = tmp();
  try {
    const t1 = path.join(root, "t1");
    fs.mkdirSync(t1);
    let adoptFails = true;
    const { applier, calls } = harness({
      adopt: (_v, item) => {
        calls.adopt.push(item.name);
        if (adoptFails && item.name === "bad") throw new Error("locked");
        return "imported";
      },
      saveNotion: async () => ({ warning: "Could not add \"Last edited\"" }),
    });
    const draft = draftWith({
      vault: { mode: "new", path: path.join(root, "vault") },
      targets: [{ id: "t1", path: t1, enabled: true, is_default: true, known: false }],
      skills: { adopt: [{ name: "bad", from: "t1" }, { name: "good", from: "t1" }, { name: "gone", from: "nope" }], push: ["p"] },
      notion: { data_source_id: "11111111-2222-3333-4444-555555555555", data_source_name: "Skills", add_last_edited: true },
    });
    const first = await applier.apply({ draft }, () => {});
    assert.equal(first.ok, false);
    assert.deepEqual(first.failed.map((f) => f.item).sort(), ["bad (from t1)", "gone"]);
    assert.deepEqual(calls.push, ["p->t1"]);
    assert.ok(first.events.some((e) => e.step === "notion" && e.message?.includes("Last edited")));

    adoptFails = false;
    calls.adopt.length = 0;
    const second = await applier.retry(() => {});
    assert.deepEqual(calls.adopt, ["bad"]);
    assert.deepEqual(second.failed.map((f) => f.item), ["gone"]);
    assert.equal(second.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("one job at a time", async () => {
  const root = tmp();
  try {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { applier } = harness({
      saveNotion: async () => {
        await gate;
        return {};
      },
    });
    const draft = draftWith({
      vault: { mode: "new", path: path.join(root, "vault") },
      notion: { data_source_id: "11111111-2222-3333-4444-555555555555", data_source_name: "", add_last_edited: false },
    });
    const first = applier.apply({ draft }, () => {});
    assert.equal(applier.isRunning(), true);
    await assert.rejects(applier.apply({ draft }, () => {}), SetupBusyError);
    release();
    await first;
    assert.equal(applier.isRunning(), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Skip on targets and assistant leaves them out of the config patch", async () => {
  const root = tmp();
  try {
    const { applier, calls } = harness();
    await applier.apply({ draft: draftWith({ vault: { mode: "new", path: path.join(root, "vault") } }) }, () => {});
    assert.deepEqual(Object.keys(calls.config[0]).sort(), ["machine_id", "repo_url", "vault_path"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --import tsx --test server/services/setup/apply.test.ts`
Expected: FAIL — cannot find module `./apply.ts`.

- [ ] **Step 3: Implement** — `server/services/setup/apply.ts`:

```ts
/**
 * The setup guide's Finish job. Fixed order:
 *   1 vault folder (create / check / git clone) + initVault
 *   2 config (one write) + watcher rebuild — then the draft is deleted
 *   3 adopt, 4 push, 5 Notion database — item by item
 * Steps 1–2 stop the job on failure (config untouched). Steps 3–5 record a
 * failed item and carry on; retry() re-runs only those. One job at a time.
 * The API key goes straight into the config patch and never into an event.
 */
import fs from "node:fs";
import path from "node:path";
import type { Run } from "../appUpdate.ts";
import type { SetupConfigPatch } from "../appConfig.ts";
import type { AppConfig, Provider } from "../../types/vault.ts";
import { friendlyGitError } from "./clonePreview.ts";
import { effectiveTargets, type EffectiveTarget } from "./plan.ts";
import type { NotionChoice, SetupDraft, SetupVault } from "./types.ts";

export type ApplyStep = "vault" | "config" | "adopt" | "push" | "notion";

export interface SetupEvent {
  step: ApplyStep | "done";
  state: "start" | "done" | "skip" | "error";
  item?: string;
  message?: string;
}

export interface FailedItem {
  step: "adopt" | "push" | "notion";
  item: string;
  message: string;
}

export interface SetupJobState {
  running: boolean;
  /** null until a job finished; true = everything done. */
  ok: boolean | null;
  /** Set once config was saved (steps 1–2 succeeded). */
  vault_path: string | null;
  events: SetupEvent[];
  failed: FailedItem[];
}

export interface ApplyRequest {
  draft: SetupDraft;
  api_key?: string;
  /** Notion OAuth redirect URL for this server (routes/notion.ts redirectUrlFor). */
  notion_redirect_url?: string;
}

export interface SetupApplyDeps {
  run: Run;
  readConfig: () => Pick<AppConfig, "providers" | "default_targets">;
  initVault: (vaultPath: string) => void;
  writeConfig: (patch: SetupConfigPatch) => void;
  rebuildWatcher: () => void;
  adopt: (vaultPath: string, item: { name: string; path: string; providerId: string }) => "imported" | "skipped";
  push: (vaultPath: string, skill: string, provider: Provider) => void;
  saveNotion: (vaultPath: string, choice: NotionChoice, redirectUrl?: string) => Promise<{ warning?: string }>;
  deleteDraft: () => void;
  cloneTimeoutMs?: number;
}

export interface SetupApplier {
  isRunning(): boolean;
  status(): SetupJobState;
  apply(req: ApplyRequest, onEvent: (e: SetupEvent) => void): Promise<SetupJobState>;
  retry(onEvent: (e: SetupEvent) => void): Promise<SetupJobState>;
}

export class SetupBusyError extends Error {}

type WorkItem =
  | { kind: "adopt"; label: string; name: string; path: string; providerId: string }
  | { kind: "push"; label: string; name: string; provider: Provider }
  | { kind: "notion"; label: string; choice: NotionChoice };

function isEmptyOrMissing(p: string): boolean {
  try {
    return fs.readdirSync(p).length === 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function prepareVault(v: SetupVault, run: Run, timeoutMs: number): Promise<void> {
  if (v.mode === "existing") {
    if (!fs.existsSync(v.path) || !fs.statSync(v.path).isDirectory()) throw new Error(`The folder doesn't exist: ${v.path}`);
    return;
  }
  if (v.mode === "new") {
    if (!isEmptyOrMissing(v.path)) throw new Error(`The folder isn't empty: ${v.path}`);
    fs.mkdirSync(v.path, { recursive: true });
    return;
  }
  const clone = v.clone;
  if (!clone) throw new Error("The clone details are missing.");
  if (!isEmptyOrMissing(clone.dest)) throw new Error(`The clone folder isn't empty: ${clone.dest}`);
  fs.mkdirSync(path.dirname(clone.dest), { recursive: true });
  const r = await run("git", ["clone", "--quiet", clone.url, clone.dest], {
    cwd: path.dirname(clone.dest),
    timeoutMs,
    interactiveAuth: true,
  });
  if (r.code !== 0) throw new Error(friendlyGitError(r.stderr));
}

function vaultStartMessage(v: SetupVault): string {
  if (v.mode === "new") return `Creating ${v.path}`;
  if (v.mode === "existing") return `Using ${v.path}`;
  return `Cloning ${v.clone?.url ?? ""}`;
}

/** Finish step 2: the whole config write. Skipped areas (null) are left out. */
export function configPatch(draft: SetupDraft, targets: EffectiveTarget[], apiKey?: string): SetupConfigPatch {
  const vault = draft.vault as SetupVault;
  const patch: SetupConfigPatch = {
    vault_path: vault.path,
    repo_url: vault.mode === "clone" && vault.clone ? vault.clone.url : (vault.repo_url ?? ""),
  };
  if (draft.targets) {
    patch.providers = targets.map((t) => ({ id: t.id, path: t.path }));
    patch.default_targets = targets.filter((t) => t.is_default).map((t) => t.id);
  }
  if (draft.machine_id) patch.machine_id = draft.machine_id;
  if (draft.assistant) {
    patch.assistant = {
      auth: draft.assistant.auth,
      workspace_id: draft.assistant.workspace_id ?? "",
      ...(apiKey?.trim() ? { api_key: apiKey.trim() } : {}),
    };
  }
  return patch;
}

function workItems(draft: SetupDraft, targets: EffectiveTarget[]): { items: WorkItem[]; unretryable: FailedItem[] } {
  const items: WorkItem[] = [];
  const unretryable: FailedItem[] = [];
  for (const a of draft.skills.adopt) {
    const t = targets.find((x) => x.id === a.from);
    if (!t) {
      unretryable.push({ step: "adopt", item: a.name, message: `${a.from} is no longer a selected target` });
      continue;
    }
    items.push({ kind: "adopt", label: `${a.name} (from ${t.id})`, name: a.name, path: path.join(t.path, a.name), providerId: t.id });
  }
  for (const name of draft.skills.push) {
    for (const t of targets.filter((x) => x.is_default)) {
      if (fs.existsSync(path.join(t.path, name))) continue;
      items.push({ kind: "push", label: `${name} → ${t.id}`, name, provider: { id: t.id, path: t.path } });
    }
  }
  if (draft.notion) {
    items.push({ kind: "notion", label: draft.notion.data_source_name || draft.notion.data_source_id, choice: draft.notion });
  }
  return { items, unretryable };
}

export function createSetupApplier(deps: SetupApplyDeps): SetupApplier {
  let running = false;
  let state: SetupJobState = { running: false, ok: null, vault_path: null, events: [], failed: [] };
  let retryItems: WorkItem[] = [];
  let unretryable: FailedItem[] = [];
  let redirectUrl: string | undefined;

  const snapshot = (): SetupJobState => ({ ...state, events: [...state.events], failed: [...state.failed] });

  const emitter = (onEvent: (e: SetupEvent) => void) => (e: SetupEvent) => {
    state.events.push(e);
    try {
      onEvent(e);
    } catch {
      /* a closed stream must not stop the job */
    }
  };

  async function runItems(items: WorkItem[], vaultPath: string, emit: (e: SetupEvent) => void): Promise<WorkItem[]> {
    const failed: WorkItem[] = [];
    let current: ApplyStep | null = null;
    for (const it of items) {
      if (it.kind !== current) {
        current = it.kind;
        emit({ step: it.kind, state: "start" });
      }
      try {
        if (it.kind === "adopt") {
          const r = deps.adopt(vaultPath, { name: it.name, path: it.path, providerId: it.providerId });
          emit(r === "imported" ? { step: "adopt", state: "done", item: it.label } : { step: "adopt", state: "skip", item: it.label, message: "already in the vault" });
        } else if (it.kind === "push") {
          deps.push(vaultPath, it.name, it.provider);
          emit({ step: "push", state: "done", item: it.label });
        } else {
          const r = await deps.saveNotion(vaultPath, it.choice, redirectUrl);
          emit({ step: "notion", state: "done", item: it.label, ...(r.warning ? { message: r.warning } : {}) });
        }
      } catch (err) {
        const message = (err as Error).message;
        failed.push(it);
        state.failed.push({ step: it.kind, item: it.label, message });
        emit({ step: it.kind, state: "error", item: it.label, message });
      }
    }
    return failed;
  }

  function finish(emit: (e: SetupEvent) => void): void {
    state.ok = state.failed.length === 0;
    emit({
      step: "done",
      state: state.ok ? "done" : "error",
      message: state.ok ? "Setup finished" : `${state.failed.length} item(s) need attention`,
    });
  }

  return {
    isRunning: () => running,
    status: snapshot,

    async apply(req, onEvent) {
      if (running) throw new SetupBusyError("Setup is already running");
      running = true;
      state = { running: true, ok: null, vault_path: null, events: [], failed: [] };
      retryItems = [];
      unretryable = [];
      redirectUrl = req.notion_redirect_url;
      const emit = emitter(onEvent);
      try {
        const { draft } = req;
        const vault = draft.vault;
        if (!vault) {
          emit({ step: "vault", state: "error", message: "Choose a vault first." });
          state.ok = false;
          return snapshot();
        }

        emit({ step: "vault", state: "start", message: vaultStartMessage(vault) });
        try {
          await prepareVault(vault, deps.run, deps.cloneTimeoutMs ?? 600_000);
          deps.initVault(vault.path);
        } catch (err) {
          emit({ step: "vault", state: "error", message: (err as Error).message });
          state.ok = false;
          return snapshot();
        }
        emit({ step: "vault", state: "done", message: vault.path });

        emit({ step: "config", state: "start" });
        const targets = effectiveTargets(draft, deps.readConfig());
        try {
          deps.writeConfig(configPatch(draft, targets, req.api_key));
          deps.rebuildWatcher();
        } catch (err) {
          const where = vault.mode === "clone" && vault.clone
            ? ` The repo was cloned to ${vault.clone.dest}: delete that folder, or choose it as an existing vault.`
            : "";
          emit({ step: "config", state: "error", message: `Couldn't save settings: ${(err as Error).message}.${where}` });
          state.ok = false;
          return snapshot();
        }
        emit({ step: "config", state: "done" });
        state.vault_path = vault.path;
        try {
          deps.deleteDraft();
        } catch {
          /* best effort: a stale draft is caught by its fingerprint */
        }

        const work = workItems(draft, targets);
        unretryable = work.unretryable;
        for (const f of unretryable) {
          state.failed.push(f);
          emit({ step: f.step, state: "error", item: f.item, message: f.message });
        }
        retryItems = await runItems(work.items, vault.path, emit);
        finish(emit);
        return snapshot();
      } finally {
        running = false;
        state.running = false;
      }
    },

    async retry(onEvent) {
      if (running) throw new SetupBusyError("Setup is already running");
      if (!state.vault_path || retryItems.length === 0) return snapshot();
      running = true;
      state.running = true;
      const emit = emitter(onEvent);
      try {
        state.failed = [...unretryable];
        retryItems = await runItems(retryItems, state.vault_path, emit);
        finish(emit);
        return snapshot();
      } finally {
        running = false;
        state.running = false;
      }
    },
  };
}
```

- [ ] **Step 4: Run the service test**

Run: `node --import tsx --test server/services/setup/apply.test.ts`
Expected: PASS.

- [ ] **Step 5: Real dependencies** — `server/services/setup/applyDeps.ts`:

```ts
/** The real dependencies of the Finish job (tests use fakes; see apply.test.ts). */
import fs from "node:fs";
import path from "node:path";
import { defaultRun } from "../appUpdate.ts";
import { readAppConfig, writeSetupConfig } from "../appConfig.ts";
import { importSkills } from "../adoption.ts";
import { pushSkillToProvider } from "../pushSkill.ts";
import { getServerPort } from "../runtime.ts";
import { initVault } from "../vault.ts";
import { rebuildWatcher } from "../watcher.ts";
import { chooseDataSource, openNotionApiAt } from "../notion/dataSource.ts";
import { deleteDraft } from "./draft.ts";
import type { SetupApplyDeps } from "./apply.ts";

export function defaultApplyDeps(home?: () => string): SetupApplyDeps {
  return {
    run: defaultRun,
    readConfig: readAppConfig,
    initVault,
    writeConfig: (patch) => {
      writeSetupConfig(patch);
    },
    rebuildWatcher,
    adopt: (vaultPath, item) => {
      const r = importSkills(vaultPath, path.dirname(item.path), [], item.providerId, undefined, [{ name: item.name, path: item.path }]);
      return r.imported.length + r.updated.length > 0 ? "imported" : "skipped";
    },
    push: (vaultPath, skill, provider) => {
      fs.mkdirSync(provider.path, { recursive: true });
      pushSkillToProvider(vaultPath, skill, provider);
    },
    saveNotion: async (vaultPath, choice, redirectUrl) => {
      const conn = await openNotionApiAt(redirectUrl ?? `http://localhost:${getServerPort()}/api/notion/callback`);
      try {
        return await chooseDataSource(conn.api, vaultPath, {
          id: choice.data_source_id,
          name: choice.data_source_name,
          add_last_edited: choice.add_last_edited,
        });
      } finally {
        await conn.close().catch(() => {});
      }
    },
    deleteDraft: () => deleteDraft(home?.()),
  };
}
```

- [ ] **Step 6: Append the failing route tests** to `server/routes/setup.test.ts`:

```ts
function fakeApplier(over: Partial<import("../services/setup/apply.ts").SetupApplier> = {}) {
  const idle = { running: false, ok: null, vault_path: null, events: [], failed: [] };
  return {
    isRunning: () => false,
    status: () => idle,
    apply: async (_req: unknown, onEvent: (e: unknown) => void) => {
      onEvent({ step: "vault", state: "start" });
      onEvent({ step: "done", state: "done", message: "Setup finished" });
      return { ...idle, ok: true };
    },
    retry: async () => idle,
    ...over,
  };
}

test("apply: streams NDJSON events; 400 for a bad draft; 409 while running", async () => {
  const { startDraft } = await import("../services/setup/draft.ts");
  const draft = startDraft({ vault_path: "C:\\v", agent_locations: {}, default_targets: [], machine_id: null, repo_url: null });
  const url = await serve(setup.setupRouter({ applier: fakeApplier() }));
  const res = await fetch(`${url}/apply`, json({ draft, api_key: "sk-x" }));
  assert.equal(res.headers.get("content-type"), "application/x-ndjson");
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.step), ["vault", "done"]);

  assert.equal((await fetch(`${url}/apply`, json({ draft: { version: 7 } }))).status, 400);

  const busy = await serve(setup.setupRouter({ applier: fakeApplier({ isRunning: () => true }) }));
  assert.equal((await fetch(`${busy}/apply`, json({ draft }))).status, 409);
  assert.deepEqual(await (await fetch(`${url}/apply/status`)).json(), { running: false, ok: null, vault_path: null, events: [], failed: [] });
});
```

- [ ] **Step 7: Add the routes** — in `server/routes/setup.ts` change the express import to `import { Router, type Response } from "express";` and add:

```ts
import { redirectUrlFor } from "./notion.ts";
import { SetupBusyError, createSetupApplier, type SetupApplier, type SetupEvent } from "../services/setup/apply.ts";
import { defaultApplyDeps } from "../services/setup/applyDeps.ts";
```

Add to `SetupRouterDeps`:

```ts
  /** The Finish job (server/index.ts passes the shared one so busy checks see it). */
  applier?: SetupApplier;
```

After `const readConfig = …`: `const applier = deps.applier ?? createSetupApplier(defaultApplyDeps(deps.home));`

Add a helper above `setupRouter`:

```ts
/** Run a job and stream its events as NDJSON (same format as POST /api/app/update). */
async function streamJob(res: Response, job: (onEvent: (e: SetupEvent) => void) => Promise<unknown>): Promise<void> {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  try {
    await job((e) => res.write(`${JSON.stringify(e)}\n`));
  } catch (err) {
    res.write(`${JSON.stringify({ step: "done", state: "error", message: (err as Error).message })}\n`);
  }
  res.end();
}
```

Before `return router;`:

```ts
  router.post("/apply", async (req, res) => {
    const body = (req.body ?? {}) as { draft?: unknown; api_key?: unknown };
    let draft;
    try {
      draft = normalizeDraft(body.draft);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    if (applier.isRunning()) {
      res.status(409).json({ error: "Setup is already running" });
      return;
    }
    const api_key = typeof body.api_key === "string" ? body.api_key : undefined;
    await streamJob(res, (onEvent) => applier.apply({ draft, api_key, notion_redirect_url: redirectUrlFor(req) }, onEvent));
  });

  router.post("/apply/retry", async (_req, res) => {
    if (applier.isRunning()) {
      res.status(409).json({ error: "Setup is already running" });
      return;
    }
    await streamJob(res, (onEvent) => applier.retry(onEvent));
  });

  router.get("/apply/status", (_req, res) => {
    res.json(applier.status());
  });
```

(`SetupBusyError` is caught by `streamJob`'s catch if a race slips past the `isRunning` check; keep the import for clarity or drop it if unused.)

- [ ] **Step 8: Wire the shared job into `server/index.ts`** — add imports:

```ts
import { createSetupApplier } from "./services/setup/apply.ts";
import { defaultApplyDeps } from "./services/setup/applyDeps.ts";
```

Before `const busyWithoutUpdate = …` add `const setupApplier = createSetupApplier(defaultApplyDeps());`, change `busyWithoutUpdate` to:

```ts
  const busyWithoutUpdate = (): boolean =>
    anyNotionJobRunning() || anyTurnRunning() || foregroundCheckActive() || setupApplier.isRunning();
```

and change the mount to `app.use("/api/setup", setupRouter({ applier: setupApplier }));`.

- [ ] **Step 9: Run the tests**

Run: `node --import tsx --test server/services/setup/apply.test.ts server/routes/setup.test.ts` then `npm test` and `npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server/services/setup/apply.ts server/services/setup/apply.test.ts server/services/setup/applyDeps.ts server/routes/setup.ts server/routes/setup.test.ts server/index.ts
git commit -m "setup: Finish job with streamed progress, retry and busy flag" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Notion sign-in returns to the guide and keeps the server up

**Files:**
- Create: `server/services/notion/connection.signin.test.ts`
- Modify: `server/services/notion/connection.ts`, `server/services/notion/store.ts`, `server/routes/notion.ts`, `server/routes/notion.test.ts`, `server/index.ts`, `client/src/lib/api.ts`

**Interfaces:**
- Consumes: `startNotionAuth(redirectUrl, connect?)`, `finishNotionAuth(redirectUrl, code, state, finish?)`, `disconnectNotion()`, `readNotionAuth`/`writeNotionAuth`.
- Produces: `notionSignInPending(now?: number): boolean`; `NotionAuthFile.return_to?: "settings" | "setup"`; `POST /api/notion/connect { return_to? }`; callback redirects to `/setup?notion=…` or `/settings?notion=…`; client `api.notionConnect(returnTo?: "setup")`.

- [ ] **Step 1: Write the failing test** — `server/services/notion/connection.signin.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

// The Notion store resolves ~/.skill-vault at call time: a temp HOME keeps this sandboxed.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "sv-signin-"));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;

let conn: typeof import("./connection.ts");
before(async () => {
  conn = await import("./connection.ts");
});
after(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

const REDIRECT = "http://localhost:9994/api/notion/callback";
const needsSignIn = async (_client: unknown, provider: { redirectToAuthorization(u: URL): void }) => {
  provider.redirectToAuthorization(new URL("https://notion.example/authorize"));
  throw new UnauthorizedError("sign in");
};

test("a started sign-in is pending for at most 10 minutes", async () => {
  assert.equal(conn.notionSignInPending(), false);
  const r = await conn.startNotionAuth(REDIRECT, needsSignIn as never);
  assert.equal(r.status, "redirect");
  assert.equal(conn.notionSignInPending(), true);
  assert.equal(conn.notionSignInPending(Date.now() + 11 * 60_000), false);
  await conn.disconnectNotion();
  assert.equal(conn.notionSignInPending(), false);
});

test("finishing (even with a bad state) clears the pending flag", async () => {
  await conn.startNotionAuth(REDIRECT, needsSignIn as never);
  assert.equal(conn.notionSignInPending(), true);
  await assert.rejects(conn.finishNotionAuth(REDIRECT, "code", "wrong-state", async () => {}));
  assert.equal(conn.notionSignInPending(), false);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --import tsx --test server/services/notion/connection.signin.test.ts`
Expected: FAIL — `conn.notionSignInPending is not a function`.

- [ ] **Step 3: Implement** — in `server/services/notion/connection.ts`, above `startNotionAuth`:

```ts
/** A sign-in sends the app window to notion.com; the idle auto-stop must wait for it — up to this long. */
const SIGN_IN_BUSY_MS = 10 * 60_000;
let signInStartedAt: number | null = null;

/** True while a Notion sign-in started here hasn't come back yet (capped at 10 minutes). */
export function notionSignInPending(now: number = Date.now()): boolean {
  return signInStartedAt !== null && now - signInStartedAt < SIGN_IN_BUSY_MS;
}
```

In `startNotionAuth`, change the redirect return to:

```ts
    if (err instanceof UnauthorizedError && url) {
      signInStartedAt = Date.now();
      return { status: "redirect", url };
    }
```

In `finishNotionAuth`'s `finally`, add `signInStartedAt = null;` next to `clearState();`. In `disconnectNotion`, add `signInStartedAt = null;` before `clearNotionAuth();`.

- [ ] **Step 4: Run the test**

Run: `node --import tsx --test server/services/notion/connection.signin.test.ts`
Expected: PASS.

- [ ] **Step 5: Append the failing route tests** to `server/routes/notion.test.ts`:

```ts
test("the sign-in callback returns to the page that started it", async () => {
  const authFile = path.join(fakeHome, ".skill-vault", "notion-auth.json");
  fs.writeFileSync(authFile, JSON.stringify({ return_to: "setup" }));
  const toSetup = await fetch(`${base}/notion/callback?error=access_denied`, { redirect: "manual" });
  assert.equal(toSetup.status, 302);
  assert.match(toSetup.headers.get("location") ?? "", /^\/setup\?notion=error&message=/);
  assert.equal(JSON.parse(fs.readFileSync(authFile, "utf8")).return_to, undefined, "return_to is single-use");

  const toSettings = await fetch(`${base}/notion/callback?error=access_denied`, { redirect: "manual" });
  assert.match(toSettings.headers.get("location") ?? "", /^\/settings\?notion=error&message=/);
});
```

- [ ] **Step 6: Run to see it fail**

Run: `node --import tsx --test server/routes/notion.test.ts`
Expected: FAIL — the first redirect goes to `/settings`.

- [ ] **Step 7: Implement**
  - `server/services/notion/store.ts`: add to `NotionAuthFile`:

```ts
  /** Which page the OAuth callback returns to (set by POST /connect; single-use). */
  return_to?: "settings" | "setup";
```

  - `server/routes/notion.ts`: add `writeNotionAuth` to the store import, then replace the `/connect` and `/callback` handlers with:

```ts
  router.post("/connect", async (req, res) => {
    const returnTo = (req.body as { return_to?: unknown } | undefined)?.return_to === "setup" ? "setup" : "settings";
    try {
      const r = await startNotionAuth(redirectUrlFor(req));
      if (r.status === "connected") await probeTools(req);
      else writeNotionAuth({ ...readNotionAuth(), return_to: returnTo });
      res.json(r);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get("/callback", async (req, res) => {
    const { return_to, ...rest } = readNotionAuth();
    if (return_to) writeNotionAuth(rest);
    const page = return_to === "setup" ? "/setup" : "/settings";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    try {
      if (!code) {
        const denied = typeof req.query.error === "string" ? req.query.error : "no authorization code";
        throw new Error(`Notion sign-in failed: ${denied}`);
      }
      await finishNotionAuth(redirectUrlFor(req), code, state);
      await probeTools(req);
      res.redirect(302, `${page}?notion=connected`);
    } catch (err) {
      res.redirect(302, `${page}?notion=error&message=${encodeURIComponent((err as Error).message)}`);
    }
  });
```

  Update the router's header comment: `GET /callback … → 302 to /settings or /setup ?notion=…`.
  - `server/index.ts`: change the notion import to also bring `notionSignInPending` from `./services/notion/connection.ts` (`import { notionSignInPending } from "./services/notion/connection.ts";`) and change the idle-stop busy line to:

```ts
  // Work that must not be cut off by an idle stop (launcher --exit-when-idle). A
  // pending Notion sign-in counts: the app window is on notion.com meanwhile.
  app.locals.isBusy = (): boolean => busyWithoutUpdate() || updater.isApplying() || notionSignInPending();
```

  - `client/src/lib/api.ts`: replace `notionConnect` with:

```ts
  notionConnect: (returnTo?: "setup") =>
    request<{ status: "connected" } | { status: "redirect"; url: string }>(
      "POST", "/api/notion/connect", returnTo ? { return_to: returnTo } : undefined,
    ),
```

- [ ] **Step 8: Run the tests**

Run: `node --import tsx --test server/routes/notion.test.ts server/services/notion/connection.signin.test.ts` then `npm test` and `npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/services/notion/connection.ts server/services/notion/connection.signin.test.ts server/services/notion/store.ts server/routes/notion.ts server/routes/notion.test.ts server/index.ts client/src/lib/api.ts
git commit -m "notion: sign-in returns to the page that started it and holds off the idle stop" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Windows folder dialog

**Files:**
- Create: `scripts/pick-folder.ps1`, `server/services/setup/folderDialog.ts`, `server/services/setup/folderDialog.test.ts`
- Modify: `server/routes/setup.ts`, `server/routes/setup.test.ts`, `server/index.ts`

**Interfaces:**
- Consumes: `ChildProcessLike`, `defaultKillTree` from `services/claude/cli.ts`; `isLoopbackRequest` (Task 1).
- Produces: `PickFolderOptions`, `PickResult`, `pickFolderInvocation(appRoot, opts, env?)`, `PickerBusyError`, `FolderPicker`, `createFolderPicker(deps)`; `SetupRouterDeps.picker?: FolderPicker`, `SetupRouterDeps.appRoot?: string`; `POST /api/setup/pick-folder { title?, initial? } → { path } | { cancelled: true }`.

- [ ] **Step 1: The dialog script** — `scripts/pick-folder.ps1` (Windows PowerShell 5.1):

```powershell
# Skill Vault: modern Windows "Select folder" dialog for the setup guide.
# Started by server/services/setup/folderDialog.ts. Title and starting folder
# arrive in environment variables (never pasted into this script). Prints the
# chosen folder on stdout; prints nothing when cancelled.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class SvFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  private class FileOpenDialogRCW {}

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr hwndOwner);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
    void GetResults(out IntPtr ppenum);
    void GetSelectedItems(out IntPtr ppsai);
  }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  private static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, out IShellItem ppv);

  private const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_PATHMUSTEXIST = 0x800;
  private const uint SIGDN_FILESYSPATH = 0x80058000;

  public static string Pick(IntPtr owner, string title, string initial) {
    IFileOpenDialog dlg = (IFileOpenDialog)new FileOpenDialogRCW();
    dlg.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
    if (!String.IsNullOrEmpty(title)) dlg.SetTitle(title);
    if (!String.IsNullOrEmpty(initial)) {
      try {
        Guid iid = typeof(IShellItem).GUID;
        IShellItem item;
        SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out item);
        dlg.SetFolder(item);
      } catch { }
    }
    if (dlg.Show(owner) != 0) return null;
    IShellItem result;
    dlg.GetResult(out result);
    string path;
    result.GetDisplayName(SIGDN_FILESYSPATH, out path);
    return path;
  }
}
"@

# An invisible, always-on-top owner so the dialog opens in front of the app window.
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Width = 1
$owner.Height = 1
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
try {
  $initial = $env:SV_PICK_INITIAL
  if ($initial -and -not (Test-Path -LiteralPath $initial -PathType Container)) { $initial = $null }
  $picked = [SvFolderPicker]::Pick($owner.Handle, $env:SV_PICK_TITLE, $initial)
  if ($picked) { [Console]::Out.Write($picked) }
} finally {
  $owner.Close()
}
```

- [ ] **Step 2: Write the failing test** — `server/services/setup/folderDialog.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PickerBusyError, createFolderPicker, pickFolderInvocation } from "./folderDialog.ts";

test("the starting folder and title travel in the environment, never in the arguments", () => {
  const nasty = 'C:\\x"; Remove-Item -Recurse C:\\ ; "$(calc)';
  const inv = pickFolderInvocation("C:\\app", { title: "Pick", initial: nasty }, { SystemRoot: "C:\\Windows" });
  assert.equal(inv.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(inv.args, ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", path.join("C:\\app", "scripts", "pick-folder.ps1")]);
  assert.equal(inv.env.SV_PICK_INITIAL, nasty);
  assert.equal(inv.env.SV_PICK_TITLE, "Pick");
  assert.ok(!inv.args.join(" ").includes("calc"));
});

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: null,
    kill: () => true,
  });
  return child;
}

test("returns the picked folder, or cancelled; one dialog at a time", async () => {
  const children: ReturnType<typeof fakeChild>[] = [];
  const picker = createFolderPicker({
    appRoot: "C:\\app",
    spawn: () => {
      const c = fakeChild();
      children.push(c);
      return c as never;
    },
  });
  const first = picker.pick({});
  assert.equal(picker.isOpen(), true);
  await assert.rejects(picker.pick({}), PickerBusyError);
  children[0].stdout.emit("data", Buffer.from("C:\\Users\\me\\vault"));
  children[0].emit("close", 0);
  assert.deepEqual(await first, { path: "C:\\Users\\me\\vault" });
  assert.equal(picker.isOpen(), false);

  const second = picker.pick({});
  children[1].emit("close", 0);
  assert.deepEqual(await second, { cancelled: true });

  const third = picker.pick({});
  children[2].stderr.emit("data", Buffer.from("Add-Type : boom\nmore"));
  children[2].emit("close", 1);
  await assert.rejects(third, /boom/);
});

test("a dialog left open is closed after the timeout", async () => {
  let killed = false;
  const picker = createFolderPicker({
    appRoot: "C:\\app",
    timeoutMs: 20,
    spawn: () => fakeChild() as never,
    killTree: () => {
      killed = true;
    },
  });
  assert.deepEqual(await picker.pick({}), { cancelled: true });
  assert.equal(killed, true);
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `node --import tsx --test server/services/setup/folderDialog.test.ts`
Expected: FAIL — cannot find module `./folderDialog.ts`.

- [ ] **Step 4: Implement** — `server/services/setup/folderDialog.ts`:

```ts
/**
 * The Windows "Select folder" dialog for the setup guide's Browse buttons:
 * runs scripts/pick-folder.ps1 (modern IFileOpenDialog, top-most owner).
 * The title and starting folder go through environment variables so no path
 * is ever pasted into PowerShell code. One dialog at a time; a dialog left
 * open is closed after 10 minutes.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { defaultKillTree, type ChildProcessLike } from "../claude/cli.ts";

export interface PickFolderOptions {
  title?: string;
  initial?: string;
}

export type PickResult = { path: string } | { cancelled: true };

export class PickerBusyError extends Error {}

export function pickFolderInvocation(
  appRoot: string,
  opts: PickFolderOptions,
  baseEnv: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const systemRoot = baseEnv.SystemRoot ?? baseEnv.SYSTEMROOT ?? "C:\\Windows";
  return {
    file: path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", path.join(appRoot, "scripts", "pick-folder.ps1")],
    env: { ...baseEnv, SV_PICK_TITLE: opts.title ?? "Select a folder", SV_PICK_INITIAL: opts.initial ?? "" },
  };
}

type SpawnLike = (
  file: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; windowsHide: boolean; stdio: ["ignore", "pipe", "pipe"] },
) => ChildProcessLike;

export interface FolderPicker {
  isOpen(): boolean;
  pick(opts: PickFolderOptions): Promise<PickResult>;
}

export function createFolderPicker(deps: {
  appRoot: string;
  spawn?: SpawnLike;
  killTree?: (child: ChildProcessLike) => void;
  timeoutMs?: number;
}): FolderPicker {
  const spawnFn: SpawnLike = deps.spawn ?? ((f, a, o) => spawn(f, a, o) as unknown as ChildProcessLike);
  let open = false;
  return {
    isOpen: () => open,
    pick(opts) {
      if (open) return Promise.reject(new PickerBusyError("A folder dialog is already open."));
      open = true;
      const inv = pickFolderInvocation(deps.appRoot, opts);
      return new Promise<PickResult>((resolve, reject) => {
        const child = spawnFn(inv.file, inv.args, { env: inv.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let settled = false;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          open = false;
          fn();
        };
        const timer = setTimeout(() => {
          (deps.killTree ?? defaultKillTree)(child);
          settle(() => resolve({ cancelled: true }));
        }, deps.timeoutMs ?? 10 * 60_000);
        child.stdout?.on("data", (d) => out.push(Buffer.from(d as Buffer)));
        child.stderr?.on("data", (d) => err.push(Buffer.from(d as Buffer)));
        child.on("error", (e) => settle(() => reject(e)));
        child.on("close", (code) =>
          settle(() => {
            const picked = Buffer.concat(out).toString("utf8").trim();
            if (code === 0) resolve(picked ? { path: picked } : { cancelled: true });
            else reject(new Error(Buffer.concat(err).toString("utf8").trim().split(/\r?\n/)[0] || `folder dialog failed (exit ${code})`));
          }),
        );
      });
    },
  };
}
```

- [ ] **Step 5: Run the service test**

Run: `node --import tsx --test server/services/setup/folderDialog.test.ts`
Expected: PASS.

- [ ] **Step 6: Append the failing route tests** to `server/routes/setup.test.ts`:

```ts
test("pick-folder: only on Windows, only from this PC, one at a time", async () => {
  const picker = { isOpen: () => false, pick: async () => ({ path: "C:\\picked" }) };
  const win = await serve(setup.setupRouter({ platform: "win32", picker }));
  assert.deepEqual(await (await fetch(`${win}/pick-folder`, json({ title: "Vault" }))).json(), { path: "C:\\picked" });

  const linux = await serve(setup.setupRouter({ platform: "linux", picker }));
  assert.equal((await fetch(`${linux}/pick-folder`, json({}))).status, 403);

  const { PickerBusyError } = await import("../services/setup/folderDialog.ts");
  const busy = await serve(setup.setupRouter({ platform: "win32", picker: { isOpen: () => true, pick: async () => { throw new PickerBusyError("open"); } } }));
  assert.equal((await fetch(`${busy}/pick-folder`, json({}))).status, 409);

  const none = await serve(setup.setupRouter({ platform: "win32" }));
  assert.equal((await fetch(`${none}/pick-folder`, json({}))).status, 503);
});
```

- [ ] **Step 7: Add the route** — in `server/routes/setup.ts` add `import { PickerBusyError, createFolderPicker, type FolderPicker } from "../services/setup/folderDialog.ts";`, add to `SetupRouterDeps`:

```ts
  /** The folder dialog (tests pass a fake). */
  picker?: FolderPicker;
  /** The app folder (holds scripts/pick-folder.ps1); without it the dialog is unavailable. */
  appRoot?: string;
```

After `const applier = …`: `const picker = deps.picker ?? (deps.appRoot ? createFolderPicker({ appRoot: deps.appRoot }) : null);` and before `return router;`:

```ts
  router.post("/pick-folder", async (req, res) => {
    if (platform !== "win32" || !isLoopbackRequest(req)) {
      res.status(403).json({ error: "The folder dialog only works on this PC. Type the path instead." });
      return;
    }
    if (!picker) {
      res.status(503).json({ error: "The folder dialog isn't available. Type the path instead." });
      return;
    }
    const body = (req.body ?? {}) as { title?: unknown; initial?: unknown };
    try {
      res.json(
        await picker.pick({
          title: typeof body.title === "string" ? body.title.slice(0, 200) : undefined,
          initial: typeof body.initial === "string" ? body.initial : undefined,
        }),
      );
    } catch (err) {
      res.status(err instanceof PickerBusyError ? 409 : 500).json({ error: (err as Error).message });
    }
  });
```

- [ ] **Step 8: Pass the app folder** — in `server/index.ts` change the mount to `app.use("/api/setup", setupRouter({ applier: setupApplier, appRoot: APP_ROOT }));`.

- [ ] **Step 9: Run the tests**

Run: `node --import tsx --test server/services/setup/folderDialog.test.ts server/routes/setup.test.ts` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Manual check on Windows (one minute)** — run from `app/`:

```bash
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File scripts/pick-folder.ps1
```

Expected: the modern "Select folder" dialog opens in front; picking a folder prints its path; Cancel prints nothing.

- [ ] **Step 11: Commit**

```bash
git add scripts/pick-folder.ps1 server/services/setup/folderDialog.ts server/services/setup/folderDialog.test.ts server/routes/setup.ts server/routes/setup.test.ts server/index.ts
git commit -m "setup: Windows folder dialog for Browse" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Assistant check

**Files:**
- Create: `server/services/claude/authStatus.test.ts`
- Modify: `server/services/claude/cli.ts`, `server/routes/setup.ts`, `server/routes/setup.test.ts`

**Interfaces:**
- Consumes: `createRunner`, `realSpawn`, `defaultKillTree`, `claudeAvailable`, `resetClaudeAvailableCache` (cli.ts); `claudeChildEnv`, `claudeAuthStatus`, `ClaudeAuthStatus` (auth.ts); `readAssistantBlock` (appConfig.ts).
- Produces: `ClaudeLoginStatus { logged_in; auth_method; email }`, `parseAuthStatus(stdout)`, `claudeLoginStatus(runner?)`; `SetupRouterDeps.claudeAvailable?`, `.claudeLoginStatus?`, `.readSavedAuth?`; `GET /api/setup/assistant[?refresh=1] → { installed, version, reason, login, saved }`.

- [ ] **Step 1: Write the failing test** — `server/services/claude/authStatus.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeLoginStatus, parseAuthStatus, type ClaudeRunner } from "./cli.ts";

test("parseAuthStatus reads claude auth status JSON", () => {
  assert.deepEqual(parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","email":"me@example.com","orgId":"x"}'), {
    logged_in: true,
    auth_method: "claude.ai",
    email: "me@example.com",
  });
  assert.deepEqual(parseAuthStatus('{"loggedIn":false}'), { logged_in: false, auth_method: null, email: null });
  assert.equal(parseAuthStatus("Usage: claude [options]"), null);
  assert.equal(parseAuthStatus('{"something":1}'), null);
});

test("claudeLoginStatus runs `claude auth status` and tolerates failures", async () => {
  const seen: string[][] = [];
  const ok: ClaudeRunner = async (args) => {
    seen.push(args);
    return { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: "", code: 0 };
  };
  assert.deepEqual(await claudeLoginStatus(ok), { logged_in: true, auth_method: "claude.ai", email: null });
  assert.deepEqual(seen[0], ["auth", "status"]);
  const notLoggedIn: ClaudeRunner = async () => ({ stdout: '{"loggedIn":false}', stderr: "", code: 1 });
  assert.deepEqual(await claudeLoginStatus(notLoggedIn), { logged_in: false, auth_method: null, email: null });
  const broken: ClaudeRunner = async () => {
    throw new Error("spawn failed");
  };
  assert.equal(await claudeLoginStatus(broken), null);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --import tsx --test server/services/claude/authStatus.test.ts`
Expected: FAIL — `parseAuthStatus` is not exported.

- [ ] **Step 3: Implement** — in `server/services/claude/cli.ts`, after `export const defaultRunner …`:

```ts
// ── Sign-in check (setup guide) ──────────────────────────────────────────

export interface ClaudeLoginStatus {
  logged_in: boolean;
  auth_method: string | null;
  email: string | null;
}

/** `claude auth status` prints JSON; null when the output isn't that JSON (e.g. an older CLI). */
export function parseAuthStatus(stdout: string): ClaudeLoginStatus | null {
  try {
    const j = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown; email?: unknown };
    if (typeof j.loggedIn !== "boolean") return null;
    return {
      logged_in: j.loggedIn,
      auth_method: typeof j.authMethod === "string" ? j.authMethod : null,
      email: typeof j.email === "string" ? j.email : null,
    };
  } catch {
    return null;
  }
}

/** Checked with the API-key env removed — the same environment the assistant uses in Claude-login mode. */
const loginRunner: ClaudeRunner = createRunner(realSpawn, defaultKillTree, { env: () => claudeChildEnv({ auth: "login" }) });

/** Is the claude CLI signed in with a Claude account? null = couldn't tell. */
export async function claudeLoginStatus(runner: ClaudeRunner = loginRunner): Promise<ClaudeLoginStatus | null> {
  try {
    const { stdout } = await runner(["auth", "status"], "", { cwd: os.tmpdir(), timeoutMs: 15_000 });
    return parseAuthStatus(stdout.trim());
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test**

Run: `node --import tsx --test server/services/claude/authStatus.test.ts`
Expected: PASS.

- [ ] **Step 5: Append the failing route test** to `server/routes/setup.test.ts`:

```ts
test("assistant: installed + sign-in + saved mode", async () => {
  const url = await serve(
    setup.setupRouter({
      claudeAvailable: async () => ({ available: true, version: "2.1.0 (Claude Code)" }),
      claudeLoginStatus: async () => ({ logged_in: true, auth_method: "claude.ai", email: "me@example.com" }),
      readSavedAuth: () => ({ auth: "login", has_saved_key: false, env_key_present: true, workspace_id: null }),
    }),
  );
  assert.deepEqual(await (await fetch(`${url}/assistant`)).json(), {
    installed: true,
    version: "2.1.0 (Claude Code)",
    reason: null,
    login: { logged_in: true, auth_method: "claude.ai", email: "me@example.com" },
    saved: { auth: "login", has_saved_key: false, env_key_present: true, workspace_id: null },
  });

  const missing = await serve(
    setup.setupRouter({
      claudeAvailable: async () => ({ available: false, reason: "not found" }),
      claudeLoginStatus: async () => {
        throw new Error("must not be called");
      },
      readSavedAuth: () => ({ auth: "login", has_saved_key: false, env_key_present: false, workspace_id: null }),
    }),
  );
  const body = await (await fetch(`${missing}/assistant`)).json();
  assert.equal(body.installed, false);
  assert.equal(body.login, null);
});
```

- [ ] **Step 6: Add the route** — in `server/routes/setup.ts` add:

```ts
import { readAssistantBlock } from "../services/appConfig.ts";
import { claudeAuthStatus, type ClaudeAuthStatus } from "../services/claude/auth.ts";
import { claudeAvailable, claudeLoginStatus, resetClaudeAvailableCache, type ClaudeLoginStatus } from "../services/claude/cli.ts";
```

(merge `readAssistantBlock` into the existing appConfig import). Add to `SetupRouterDeps`:

```ts
  claudeAvailable?: () => Promise<{ available: boolean; version?: string; reason?: string }>;
  claudeLoginStatus?: () => Promise<ClaudeLoginStatus | null>;
  readSavedAuth?: () => ClaudeAuthStatus;
```

Before `return router;`:

```ts
  router.get("/assistant", async (req, res) => {
    if (req.query.refresh === "1" && !deps.claudeAvailable) resetClaudeAvailableCache();
    const cli = await (deps.claudeAvailable ?? (() => claudeAvailable()))();
    const login = cli.available ? await (deps.claudeLoginStatus ?? (() => claudeLoginStatus()))() : null;
    res.json({
      installed: cli.available,
      version: cli.version ?? null,
      reason: cli.reason ?? null,
      login,
      saved: (deps.readSavedAuth ?? (() => claudeAuthStatus(readAssistantBlock())))(),
    });
  });
```

- [ ] **Step 7: Run the tests**

Run: `node --import tsx --test server/services/claude/authStatus.test.ts server/routes/setup.test.ts` then `npm test` and `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/services/claude/cli.ts server/services/claude/authStatus.test.ts server/routes/setup.ts server/routes/setup.test.ts
git commit -m "setup: check the claude CLI and its sign-in" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Client API module and shared step UI

**Files:**
- Create: `client/src/lib/setup.ts`, `client/src/pages/setup/types.ts`, `client/src/pages/setup/ui.tsx`

**Interfaces:**
- Consumes: every `/api/setup/*` endpoint from Tasks 1–11; `ApiError` from `client/src/lib/api.ts`; `Button` from `components/ui/primitives`.
- Produces: client types mirroring the server (`SetupDraft`, `SetupTarget`, `SetupVault`, `NotionRef`, `FolderInfo`, `DetectedTarget`, `VaultCandidate`, `SkillsPlan`, `SetupEvent`, `SetupJobState`, `AssistantCheck`), `setupApi`, `joinPath(dir, name)`, `repoNameFromUrl(url)`; `StepProps`; UI pieces `labelStyle`, `inputStyle`, `StepHeader`, `Hint`, `FolderField`, `ChoiceCard`, `StepNav`.

- [ ] **Step 1: API module** — `client/src/lib/setup.ts`:

```ts
/**
 * Setup guide API (server: routes/setup.ts). Finish and Retry stream NDJSON
 * progress events, like the in-app update (lib/appUpdate.ts).
 */
import { ApiError } from "./api";

export type SetupStep = "welcome" | "vault" | "targets" | "skills" | "notion" | "assistant" | "review";

export interface NotionRef {
  id: string;
  name: string;
}

export interface SetupVault {
  mode: "new" | "existing" | "clone";
  path: string;
  clone?: { url: string; dest: string; subdir: string; skill_names: string[]; notion: NotionRef | null };
  repo_url?: string;
}

export interface SetupTarget {
  id: string;
  path: string;
  enabled: boolean;
  is_default: boolean;
  known: boolean;
}

export interface SetupDraft {
  version: 1;
  started_at: string;
  base: string;
  step: SetupStep;
  vault: SetupVault | null;
  machine_id?: string;
  targets: SetupTarget[] | null;
  skills: { adopt: { name: string; from: string }[]; push: string[] };
  notion: { data_source_id: string; data_source_name: string; add_last_edited: boolean } | null;
  assistant: { auth: "login" | "api_key"; workspace_id?: string } | null;
}

export type FolderKind = "missing" | "not_dir" | "empty" | "vault" | "vault_no_manifest" | "skills_folder" | "other";

export interface FolderInfo {
  path: string;
  kind: FolderKind;
  writable: boolean;
  skill_count: number;
  git: { root: string; origin: string | null } | null;
  notion: NotionRef | null;
}

export interface DetectedTarget {
  id: string;
  label: string;
  path: string;
  status: "found" | "installed" | "not_found";
  configured: boolean;
  is_default: boolean;
  known: boolean;
}

export interface VaultCandidate {
  subdir: string;
  skill_names: string[];
  notion: NotionRef | null;
}

export interface SkillsPlan {
  adopt: { name: string; from: string; path: string }[];
  adopt_conflicts: { name: string; targets: string[] }[];
  push: { name: string; missing_in: string[] }[];
  differs: { name: string; target: string; unknown: boolean }[];
}

export interface SetupEvent {
  step: "vault" | "config" | "adopt" | "push" | "notion" | "done";
  state: "start" | "done" | "skip" | "error";
  item?: string;
  message?: string;
}

export interface SetupJobState {
  running: boolean;
  ok: boolean | null;
  vault_path: string | null;
  events: SetupEvent[];
  failed: { step: "adopt" | "push" | "notion"; item: string; message: string }[];
}

export interface AssistantCheck {
  installed: boolean;
  version: string | null;
  reason: string | null;
  login: { logged_in: boolean; auth_method: string | null; email: string | null } | null;
  saved: { auth: "login" | "api_key"; has_saved_key: boolean; env_key_present: boolean; workspace_id: string | null };
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(msg, res.status, data);
  }
  return data as T;
}

async function stream(url: string, body: unknown, onEvent: (e: SetupEvent) => void): Promise<void> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => null);
    throw new ApiError((data as { error?: string } | null)?.error ?? `Setup failed to start (${res.status})`, res.status, data);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as SetupEvent);
    }
  }
}

export const setupApi = {
  capabilities: () => call<{ folder_dialog: boolean }>("GET", "/api/setup/capabilities"),
  getDraft: () => call<{ draft: SetupDraft | null; stale: boolean }>("GET", "/api/setup/draft"),
  startDraft: () => call<{ draft: SetupDraft }>("POST", "/api/setup/draft/start"),
  saveDraft: (draft: SetupDraft) => call<{ draft: SetupDraft }>("PUT", "/api/setup/draft", draft),
  discardDraft: () => call<null>("DELETE", "/api/setup/draft"),
  pickFolder: (opts: { title?: string; initial?: string }) =>
    call<{ path: string } | { cancelled: true }>("POST", "/api/setup/pick-folder", opts),
  inspect: (path: string) => call<FolderInfo>("POST", "/api/setup/inspect", { path }),
  targets: () => call<{ targets: DetectedTarget[] }>("GET", "/api/setup/targets"),
  clonePreview: (url: string) => call<{ candidates: VaultCandidate[] }>("POST", "/api/setup/clone-preview", { url }),
  plan: (draft: SetupDraft) => call<SkillsPlan>("POST", "/api/setup/plan", { draft }),
  assistant: (refresh = false) => call<AssistantCheck>("GET", `/api/setup/assistant${refresh ? "?refresh=1" : ""}`),
  apply: (draft: SetupDraft, apiKey: string, onEvent: (e: SetupEvent) => void) =>
    stream("/api/setup/apply", { draft, ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}) }, onEvent),
  retry: (onEvent: (e: SetupEvent) => void) => stream("/api/setup/apply/retry", {}, onEvent),
  applyStatus: () => call<SetupJobState>("GET", "/api/setup/apply/status"),
};

/** Join a folder and a name with the folder's own separator (paths come from Windows or POSIX). */
export function joinPath(dir: string, name: string): string {
  if (!name) return dir;
  const sep = dir.includes("\\") || !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${name}`;
}

/** "https://github.com/me/my-vault.git" → "my-vault". */
export function repoNameFromUrl(url: string): string {
  const last = url.trim().replace(/[?#].*$/, "").replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/i, "") || "skill-vault";
}
```

- [ ] **Step 2: Step props** — `client/src/pages/setup/types.ts`:

```ts
import type { SetupDraft, SetupStep } from "../../lib/setup";

/** What every step component gets from the guide's shell (SetupGuide.tsx). */
export interface StepProps {
  draft: SetupDraft;
  /** Save `patch` into the draft and go to `to`. */
  commit: (patch: Partial<SetupDraft>, to: SetupStep) => Promise<void>;
  /** Go to another step without changing anything else. */
  goTo: (to: SetupStep) => void;
  /** The Windows folder dialog can be used (Browse buttons). */
  folderDialog: boolean;
  /** The assistant API key, kept in page memory only (never in the draft). */
  apiKey: string;
  setApiKey: (key: string) => void;
  /** Called after a successful Finish. */
  onFinished: () => void;
}
```

- [ ] **Step 3: Shared UI** — `client/src/pages/setup/ui.tsx`:

```tsx
import { useState, type CSSProperties, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "../../components/ui/primitives";
import { setupApi } from "../../lib/setup";

export const labelStyle: CSSProperties = {
  display: "block",
  fontFamily: "var(--mono)",
  fontSize: 11,
  color: "var(--ink-3)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  fontWeight: 600,
  marginBottom: 6,
};

export const inputStyle: CSSProperties = {
  width: "100%",
  fontFamily: "var(--mono)",
  fontSize: 13,
  color: "var(--ink)",
  background: "var(--surface)",
  border: "0.5px solid var(--border-2)",
  borderRadius: 6,
  padding: "0 12px",
  height: 36,
  outline: 0,
};

export function StepHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h1 style={{ margin: "0 0 8px", fontSize: 22, fontWeight: 600, color: "var(--ink)", letterSpacing: "-0.02em" }}>{title}</h1>
      {children && <p style={{ margin: 0, fontSize: 14, color: "var(--ink-2)", lineHeight: 1.6 }}>{children}</p>}
    </div>
  );
}

const TONE = { info: "var(--ink-2)", good: "var(--ok)", warn: "var(--warn)", bad: "var(--bad)" } as const;

export function Hint({ tone = "info", children }: { tone?: keyof typeof TONE; children: ReactNode }) {
  return <p style={{ margin: "8px 0 0", fontSize: 12.5, lineHeight: 1.6, color: TONE[tone] }}>{children}</p>;
}

/** A path box with an optional Browse… button that opens the Windows folder dialog. */
export function FolderField({
  id,
  label,
  value,
  onChange,
  folderDialog,
  dialogTitle,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  folderDialog: boolean;
  dialogTitle: string;
  placeholder?: string;
}) {
  const [picking, setPicking] = useState(false);
  const browse = async () => {
    setPicking(true);
    try {
      const r = await setupApi.pickFolder({ title: dialogTitle, initial: value.trim() || undefined });
      if ("path" in r) onChange(r.path);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPicking(false);
    }
  };
  return (
    <div>
      <label htmlFor={id} style={labelStyle}>
        {label}
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <input id={id} type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={inputStyle} />
        {folderDialog && (
          <Button size="lg" onClick={browse} disabled={picking}>
            {picking ? "Waiting…" : "Browse…"}
          </Button>
        )}
      </div>
    </div>
  );
}

export function ChoiceCard({
  selected,
  title,
  description,
  onSelect,
}: {
  selected: boolean;
  title: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{
        textAlign: "left",
        width: "100%",
        padding: "12px 14px",
        borderRadius: 8,
        cursor: "pointer",
        background: selected ? "var(--surface-2)" : "var(--surface)",
        border: `0.5px solid ${selected ? "var(--ink)" : "var(--border-2)"}`,
        fontFamily: "var(--sans)",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{title}</div>
      <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 4, lineHeight: 1.5 }}>{description}</div>
    </button>
  );
}

/** Back / Skip / Next row at the bottom of a step. */
export function StepNav({
  onBack,
  onSkip,
  onNext,
  nextLabel = "Next",
  nextDisabled,
  busy,
}: {
  onBack?: () => void;
  onSkip?: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  busy?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 28, alignItems: "center" }}>
      {onBack && (
        <Button kind="ghost" size="md" onClick={onBack} disabled={busy}>
          Back
        </Button>
      )}
      <div style={{ flex: 1 }} />
      {onSkip && (
        <Button kind="ghost" size="md" onClick={onSkip} disabled={busy}>
          Skip
        </Button>
      )}
      <Button kind="primary" size="md" onClick={onNext} disabled={nextDisabled || busy}>
        {busy ? "Working…" : nextLabel}
      </Button>
    </div>
  );
}

export const listBox: CSSProperties = {
  background: "var(--surface)",
  border: "0.5px solid var(--border)",
  borderRadius: 8,
  padding: "6px 0",
  maxHeight: 260,
  overflowY: "auto",
};

export const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "6px 14px",
  fontSize: 13,
  color: "var(--ink)",
};
```

- [ ] **Step 4: Type check**

Run: `npm run typecheck`
Expected: PASS (the new files compile; nothing uses them yet).

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/setup.ts client/src/pages/setup/types.ts client/src/pages/setup/ui.tsx
git commit -m "setup client: API module and shared step UI" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Vault step

**Files:**
- Create: `client/src/pages/setup/steps/VaultStep.tsx`

**Interfaces:**
- Consumes: `StepProps`; `setupApi.inspect`, `setupApi.clonePreview`, `joinPath`, `repoNameFromUrl`, `FolderInfo`, `VaultCandidate`, `SetupVault`; `StepHeader`, `Hint`, `FolderField`, `ChoiceCard`, `StepNav`, `labelStyle`, `inputStyle`.
- Produces: `VaultStep(props: StepProps)` — commits `{ vault, machine_id }` and goes to `"targets"`.

- [ ] **Step 1: Implement** — `client/src/pages/setup/steps/VaultStep.tsx`:

```tsx
import { useEffect, useState } from "react";
import { setupApi, joinPath, repoNameFromUrl, type FolderInfo, type SetupVault, type VaultCandidate } from "../../../lib/setup";
import type { StepProps } from "../types";
import { ChoiceCard, FolderField, Hint, StepHeader, StepNav, inputStyle, labelStyle } from "../ui";

type Mode = SetupVault["mode"];

/** Plain-words summary of an inspected folder for the chosen mode; `ok` = Next may proceed. */
function describe(mode: Mode, info: FolderInfo | null): { text: string; tone: "info" | "good" | "warn" | "bad"; ok: boolean } | null {
  if (!info) return null;
  if (info.kind === "not_dir") return { text: "That's a file, not a folder.", tone: "bad", ok: false };
  if (!info.writable) return { text: "Skill Vault can't write to this folder.", tone: "bad", ok: false };
  if (mode === "new") {
    if (info.kind === "missing") return { text: "The folder will be created when you press Finish.", tone: "good", ok: true };
    if (info.kind === "empty") return { text: "Empty folder: the vault will be set up here.", tone: "good", ok: true };
    return { text: "This folder isn't empty. Pick an empty or new folder, or choose \"Use a folder I have\".", tone: "bad", ok: false };
  }
  switch (info.kind) {
    case "missing":
      return { text: "That folder doesn't exist.", tone: "bad", ok: false };
    case "vault":
      return { text: `Vault found: ${info.skill_count} skill${info.skill_count === 1 ? "" : "s"}.`, tone: "good", ok: true };
    case "vault_no_manifest":
      return { text: `${info.skill_count} skill folders and no skills.json yet: one will be created.`, tone: "good", ok: true };
    case "empty":
      return { text: "Empty folder: skills.json and a skills folder will be created.", tone: "good", ok: true };
    case "skills_folder":
      return {
        text: `This looks like a tool's skills folder (${info.skill_count} skills), not a vault. Add it as a target on the next step, and pick or create a separate vault folder here.`,
        tone: "bad",
        ok: false,
      };
    default:
      return { text: "skills.json and a skills folder will be created in this folder.", tone: "info", ok: true };
  }
}

export function VaultStep({ draft, commit, folderDialog }: StepProps) {
  const v = draft.vault;
  const [mode, setMode] = useState<Mode | null>(v?.mode ?? null);
  const [folder, setFolder] = useState(v && v.mode !== "clone" ? v.path : "");
  const [info, setInfo] = useState<FolderInfo | null>(null);
  const [url, setUrl] = useState(v?.clone?.url ?? "");
  const [parent, setParent] = useState(v?.clone ? v.clone.dest.replace(/[\\/][^\\/]+$/, "") : "");
  const [dest, setDest] = useState(v?.clone?.dest ?? "");
  const [destTouched, setDestTouched] = useState(Boolean(v?.clone));
  const [destInfo, setDestInfo] = useState<FolderInfo | null>(null);
  const [candidates, setCandidates] = useState<VaultCandidate[] | null>(v?.clone ? [{ subdir: v.clone.subdir, skill_names: v.clone.skill_names, notion: v.clone.notion }] : null);
  const [subdir, setSubdir] = useState<string | null>(v?.clone?.subdir ?? null);
  const [useAsNew, setUseAsNew] = useState(false);
  const [checking, setChecking] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [machineId, setMachineId] = useState(draft.machine_id ?? "");
  const [more, setMore] = useState(false);

  // Inspect the folder (new / existing) a moment after typing stops.
  useEffect(() => {
    if (mode === "clone" || !folder.trim()) {
      setInfo(null);
      return;
    }
    const t = setTimeout(() => {
      setupApi.inspect(folder.trim()).then(setInfo).catch(() => setInfo(null));
    }, 350);
    return () => clearTimeout(t);
  }, [mode, folder]);

  // Default clone destination: <parent>\<repo name>, until the user edits it.
  useEffect(() => {
    if (!destTouched && parent.trim() && url.trim()) setDest(joinPath(parent.trim(), repoNameFromUrl(url)));
  }, [parent, url, destTouched]);

  useEffect(() => {
    if (mode !== "clone" || !dest.trim()) {
      setDestInfo(null);
      return;
    }
    const t = setTimeout(() => {
      setupApi.inspect(dest.trim()).then(setDestInfo).catch(() => setDestInfo(null));
    }, 350);
    return () => clearTimeout(t);
  }, [mode, dest]);

  // A new URL means the old preview no longer applies.
  const changeUrl = (next: string) => {
    setUrl(next);
    setCandidates(null);
    setSubdir(null);
    setUseAsNew(false);
    setCloneError(null);
  };

  const folderState = mode && mode !== "clone" ? describe(mode, info) : null;
  const destOk = destInfo && (destInfo.kind === "missing" || destInfo.kind === "empty") && destInfo.writable;
  const picked = candidates?.find((c) => c.subdir === subdir) ?? null;

  const checkRepo = async () => {
    setChecking(true);
    setCloneError(null);
    try {
      const r = await setupApi.clonePreview(url.trim());
      setCandidates(r.candidates);
      setSubdir(r.candidates.length === 1 ? r.candidates[0].subdir : null);
    } catch (err) {
      setCloneError((err as Error).message);
      setCandidates(null);
    } finally {
      setChecking(false);
    }
  };

  const next = async () => {
    const machine_id = machineId.trim() || undefined;
    if (mode === "clone") {
      if (!candidates) return void (await checkRepo());
      const chosen = useAsNew ? { subdir: "", skill_names: [], notion: null } : picked;
      if (!chosen) return;
      const vault: SetupVault = {
        mode: "clone",
        path: joinPath(dest.trim(), chosen.subdir),
        clone: { url: url.trim(), dest: dest.trim(), subdir: chosen.subdir, skill_names: chosen.skill_names, notion: chosen.notion },
        repo_url: url.trim(),
      };
      await commit({ vault, machine_id }, "targets");
      return;
    }
    if (!mode) return;
    const samePath = v && v.mode !== "clone" && v.path === folder.trim();
    const repo_url = samePath ? v?.repo_url : (info?.git?.origin ?? undefined);
    await commit({ vault: { mode, path: folder.trim(), ...(repo_url ? { repo_url } : {}) }, machine_id }, "targets");
  };

  const cloneReady = Boolean(url.trim() && dest.trim() && destOk);
  const nextDisabled =
    !mode ||
    (mode === "clone"
      ? !cloneReady || (candidates !== null && !useAsNew && !picked)
      : !folder.trim() || !folderState?.ok);

  return (
    <div>
      <StepHeader title="Where your skills live">
        Your vault is the one folder that holds every skill. Skill Vault links each skill from here into the tools you use.
      </StepHeader>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
        <ChoiceCard selected={mode === "new"} onSelect={() => setMode("new")} title="Start a new vault" description="Pick an empty or new folder." />
        <ChoiceCard selected={mode === "existing"} onSelect={() => setMode("existing")} title="Use a folder I have" description="A vault you already use, or a folder to turn into one." />
        <ChoiceCard selected={mode === "clone"} onSelect={() => setMode("clone")} title="Clone from GitHub" description="Copy a vault repo to this PC, for a second computer or a shared team vault." />
      </div>

      {mode && mode !== "clone" && (
        <>
          <FolderField
            id="vault-folder"
            label="vault folder"
            value={folder}
            onChange={setFolder}
            folderDialog={folderDialog}
            dialogTitle={mode === "new" ? "Choose a folder for your new vault" : "Choose your vault folder"}
            placeholder="C:\\Users\\you\\skill-vault"
          />
          {folderState && <Hint tone={folderState.tone}>{folderState.text}</Hint>}
          {info?.git && (
            <Hint>
              Inside the git repo {info.git.root}
              {info.git.origin ? ` (${info.git.origin})` : ""}.
            </Hint>
          )}
        </>
      )}

      {mode === "clone" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label htmlFor="clone-url" style={labelStyle}>
              repo url
            </label>
            <input id="clone-url" type="text" value={url} onChange={(e) => changeUrl(e.target.value)} placeholder="https://github.com/you/skill-vault.git" style={inputStyle} />
          </div>
          <FolderField id="clone-parent" label="put it in" value={parent} onChange={setParent} folderDialog={folderDialog} dialogTitle="Choose where to put the cloned vault" placeholder="C:\\Github" />
          <div>
            <label htmlFor="clone-dest" style={labelStyle}>
              clone folder
            </label>
            <input
              id="clone-dest"
              type="text"
              value={dest}
              onChange={(e) => {
                setDest(e.target.value);
                setDestTouched(true);
              }}
              style={inputStyle}
            />
            {destInfo && !destOk && <Hint tone="bad">This folder must be new or empty.</Hint>}
          </div>
          {cloneError && <Hint tone="bad">{cloneError}</Hint>}
          {candidates && candidates.length === 1 && (
            <Hint tone="good">
              Vault found {candidates[0].subdir ? `in ${candidates[0].subdir}/` : "at the top of the repo"}: {candidates[0].skill_names.length} skills.
            </Hint>
          )}
          {candidates && candidates.length > 1 && (
            <div>
              <span style={labelStyle}>this repo has more than one vault: pick one</span>
              {candidates.map((c) => (
                <label key={c.subdir} style={{ display: "flex", gap: 8, fontSize: 13, padding: "4px 0", color: "var(--ink)" }}>
                  <input type="radio" name="vault-subdir" checked={subdir === c.subdir} onChange={() => setSubdir(c.subdir)} />
                  {c.subdir}/ ({c.skill_names.length} skills)
                </label>
              ))}
            </div>
          )}
          {candidates && candidates.length === 0 && (
            <div>
              <Hint tone="warn">No vault (skills.json) in this repo.</Hint>
              <label style={{ display: "flex", gap: 8, fontSize: 13, marginTop: 6, color: "var(--ink)" }}>
                <input type="checkbox" checked={useAsNew} onChange={(e) => setUseAsNew(e.target.checked)} />
                Use it as a new vault anyway
              </label>
            </div>
          )}
          <Hint>The repo is only cloned when you press Finish. Checking it now uses a quick temporary copy.</Hint>
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        <button type="button" onClick={() => setMore(!more)} style={{ background: "none", border: 0, padding: 0, color: "var(--ink-2)", fontSize: 12.5, cursor: "pointer" }}>
          {more ? "▾" : "▸"} More
        </button>
        {more && (
          <div style={{ marginTop: 10 }}>
            <label htmlFor="machine-id" style={labelStyle}>
              this pc's name
            </label>
            <input id="machine-id" type="text" value={machineId} onChange={(e) => setMachineId(e.target.value)} style={inputStyle} />
            <Hint>Used to tell your computers apart when you sync between them.</Hint>
          </div>
        )}
      </div>

      <StepNav onNext={next} nextLabel={mode === "clone" && !candidates ? "Check repo" : "Next"} nextDisabled={nextDisabled} busy={checking} />
    </div>
  );
}
```

- [ ] **Step 2: Type check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/setup/steps/VaultStep.tsx
git commit -m "setup client: vault step (new, existing, clone)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Targets step

**Files:**
- Create: `client/src/pages/setup/steps/TargetsStep.tsx`

**Interfaces:**
- Consumes: `StepProps`; `setupApi.targets`, `DetectedTarget`, `SetupTarget`; `useQuery`; UI pieces.
- Produces: `TargetsStep(props: StepProps)` — Next commits `{ targets: SetupTarget[] }`; Skip commits `{ targets: null }`; both go to `"skills"`. Back → `"vault"`.

- [ ] **Step 1: Implement** — `client/src/pages/setup/steps/TargetsStep.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { setupApi, type DetectedTarget, type SetupTarget } from "../../../lib/setup";
import { Button } from "../../../components/ui/primitives";
import type { StepProps } from "../types";
import { FolderField, Hint, StepHeader, StepNav, inputStyle, labelStyle, listBox, rowStyle } from "../ui";

interface Row extends SetupTarget {
  label: string;
  status?: DetectedTarget["status"];
}

const STATUS_TEXT: Record<DetectedTarget["status"], string> = {
  found: "Found",
  installed: "Installed, no skills folder yet",
  not_found: "Not found",
};

/** First visit: configured targets keep their settings; on a first run, found tools start ticked and default. */
function initialRows(detected: DetectedTarget[], saved: SetupTarget[] | null): Row[] {
  if (saved) {
    const byId = new Map(detected.map((d) => [d.id, d]));
    const rows: Row[] = saved.map((t) => ({ ...t, label: byId.get(t.id)?.label ?? t.id, status: byId.get(t.id)?.status }));
    for (const d of detected) if (!saved.some((t) => t.id === d.id)) rows.push({ id: d.id, path: d.path, enabled: false, is_default: false, known: d.known, label: d.label, status: d.status });
    return rows;
  }
  const anyConfigured = detected.some((d) => d.configured);
  return detected.map((d) => {
    const enabled = d.configured || (!anyConfigured && d.status === "found");
    return { id: d.id, path: d.path, enabled, is_default: d.configured ? d.is_default : enabled, known: d.known, label: d.label, status: d.status };
  });
}

export function TargetsStep({ draft, commit, goTo, folderDialog }: StepProps) {
  const { data, error } = useQuery({ queryKey: ["setup-targets"], queryFn: () => setupApi.targets() });
  const [rows, setRows] = useState<Row[] | null>(null);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");

  useEffect(() => {
    if (data && !rows) setRows(initialRows(data.targets, draft.targets));
  }, [data, rows, draft.targets]);

  const update = (id: string, patch: Partial<Row>) =>
    setRows((rs) => (rs ?? []).map((r) => (r.id === id ? { ...r, ...patch, is_default: (patch.enabled ?? r.enabled) && (patch.is_default ?? r.is_default) } : r)));

  const nameTaken = rows?.some((r) => r.id.toLowerCase() === name.trim().toLowerCase()) ?? false;
  const badName = /[\\/]/.test(name);
  const addCustom = () => {
    setRows((rs) => [...(rs ?? []), { id: name.trim(), path: folder.trim(), enabled: true, is_default: true, known: false, label: name.trim() }]);
    setName("");
    setFolder("");
  };

  const next = () => commit({ targets: (rows ?? []).map(({ id, path, enabled, is_default, known }) => ({ id, path, enabled, is_default, known })) }, "skills");

  return (
    <div>
      <StepHeader title="The tools you use">
        Each tool you tick gets your vault's skills. "Default" tools also get every new skill you add.
      </StepHeader>

      {error && <Hint tone="bad">{(error as Error).message}</Hint>}
      {rows && (
        <div style={listBox}>
          <div style={{ ...rowStyle, color: "var(--ink-3)", fontSize: 11, fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            <span style={{ width: 22 }}>use</span>
            <span style={{ flex: 1 }}>tool</span>
            <span style={{ width: 64, textAlign: "center" }}>default</span>
          </div>
          {rows.map((r) => (
            <div key={r.id} style={rowStyle}>
              <input type="checkbox" aria-label={`Use ${r.label}`} checked={r.enabled} onChange={(e) => update(r.id, { enabled: e.target.checked })} style={{ width: 22 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>{r.label}</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--ink-3)", wordBreak: "break-all" }}>
                  {r.path}
                  {r.status ? ` · ${STATUS_TEXT[r.status]}` : ""}
                </div>
              </div>
              <input
                type="checkbox"
                aria-label={`${r.label} is a default target`}
                checked={r.is_default}
                disabled={!r.enabled}
                onChange={(e) => update(r.id, { is_default: e.target.checked })}
                style={{ width: 64 }}
              />
            </div>
          ))}
        </div>
      )}
      <Hint>Unticking a tool you already use only removes it from Skill Vault's settings. No files are deleted.</Hint>

      <div style={{ marginTop: 22 }}>
        <span style={labelStyle}>add a custom target</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input aria-label="Target name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. my-project" style={inputStyle} />
          <FolderField id="custom-target" label="its skills folder" value={folder} onChange={setFolder} folderDialog={folderDialog} dialogTitle="Choose the tool's skills folder" />
          <div>
            <Button onClick={addCustom} disabled={!name.trim() || !folder.trim() || nameTaken || badName}>
              Add target
            </Button>
          </div>
          {nameTaken && <Hint tone="bad">That name is already in the list.</Hint>}
          {badName && <Hint tone="bad">Names can't contain \ or /.</Hint>}
        </div>
      </div>

      <StepNav onBack={() => goTo("vault")} onSkip={() => commit({ targets: null }, "skills")} onNext={next} nextDisabled={!rows} />
    </div>
  );
}
```

- [ ] **Step 2: Type check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/setup/steps/TargetsStep.tsx
git commit -m "setup client: targets step" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Skills step

**Files:**
- Create: `client/src/pages/setup/steps/SkillsStep.tsx`

**Interfaces:**
- Consumes: `StepProps`; `setupApi.plan`, `SkillsPlan`; `useChecklistSelection`, `SelectAllControl` from `components/Checklist`; UI pieces.
- Produces: `SkillsStep(props: StepProps)` — Next commits `{ skills: { adopt: {name, from}[], push: string[] } }`; Skip commits empty lists; both → `"notion"`. Back → `"targets"`.

- [ ] **Step 1: Implement** — `client/src/pages/setup/steps/SkillsStep.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { setupApi, type SkillsPlan } from "../../../lib/setup";
import { SelectAllControl, useChecklistSelection } from "../../../components/Checklist";
import type { StepProps } from "../types";
import { Hint, StepHeader, StepNav, labelStyle, listBox, rowStyle } from "../ui";

function Checklist({
  title,
  rows,
  picked,
  setPicked,
}: {
  title: string;
  rows: { key: string; label: string; detail: string }[];
  picked: Set<string>;
  setPicked: (s: Set<string>) => void;
}) {
  const keys = rows.map((r) => r.key);
  const sel = useChecklistSelection(keys, picked, setPicked);
  if (rows.length === 0) return null;
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
        <span style={{ ...labelStyle, marginBottom: 0, flex: 1 }}>
          {title} ({picked.size} of {rows.length})
        </span>
        <SelectAllControl selection={sel} />
      </div>
      <div style={listBox}>
        {rows.map((r) => (
          <label key={r.key} style={{ ...rowStyle, cursor: "pointer" }} onClick={(e) => { e.preventDefault(); sel.onItemClick(r.key, e); }}>
            <input type="checkbox" readOnly checked={picked.has(r.key)} />
            <span style={{ flex: 1 }}>{r.label}</span>
            <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{r.detail}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function SkillsStep({ draft, commit, goTo }: StepProps) {
  const { data: plan, error, isLoading } = useQuery<SkillsPlan>({
    queryKey: ["setup-plan", draft.vault, draft.targets],
    queryFn: () => setupApi.plan(draft),
  });
  const [adopt, setAdopt] = useState<Set<string> | null>(null);
  const [push, setPush] = useState<Set<string> | null>(null);

  // Start with everything ticked, or with the earlier picks when coming back.
  useEffect(() => {
    if (!plan || adopt) return;
    const hadPicks = draft.skills.adopt.length > 0 || draft.skills.push.length > 0;
    setAdopt(new Set(hadPicks ? draft.skills.adopt.map((a) => a.name) : plan.adopt.map((a) => a.name)));
    setPush(new Set(hadPicks ? draft.skills.push : plan.push.map((p) => p.name)));
  }, [plan, adopt, draft.skills]);

  const next = () => {
    if (!plan || !adopt || !push) return;
    void commit(
      {
        skills: {
          adopt: plan.adopt.filter((a) => adopt.has(a.name)).map((a) => ({ name: a.name, from: a.from })),
          push: plan.push.filter((p) => push.has(p.name)).map((p) => p.name),
        },
      },
      "notion",
    );
  };

  const nothing = plan && plan.adopt.length === 0 && plan.push.length === 0;

  return (
    <div>
      <StepHeader title="Bring your skills together">
        Nothing moves until you press Finish. Untick anything you'd rather leave where it is, or skip this step.
      </StepHeader>

      {isLoading && <Hint>Comparing your vault and your tools…</Hint>}
      {error && <Hint tone="bad">{(error as Error).message}</Hint>}
      {nothing && <Hint tone="good">Nothing to move: your vault and your tools already match.</Hint>}

      {plan && adopt && push && (
        <>
          <Checklist
            title="in your tools, not in the vault: adopt"
            rows={plan.adopt.map((a) => ({ key: a.name, label: a.name, detail: `from ${a.from}` }))}
            picked={adopt}
            setPicked={setAdopt}
          />
          <Checklist
            title="in the vault, not in your default tools: push"
            rows={plan.push.map((p) => ({ key: p.name, label: p.name, detail: `to ${p.missing_in.join(", ")}` }))}
            picked={push}
            setPicked={setPush}
          />
          {(plan.differs.length > 0 || plan.adopt_conflicts.length > 0) && (
            <div>
              <span style={labelStyle}>left alone: sort these out later on the Adopt page</span>
              <div style={listBox}>
                {plan.differs.map((d) => (
                  <div key={`${d.name}:${d.target}`} style={rowStyle}>
                    <span style={{ flex: 1 }}>{d.name}</span>
                    <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                      {d.unknown ? `also in ${d.target}; compare after cloning` : `different in ${d.target}`}
                    </span>
                  </div>
                ))}
                {plan.adopt_conflicts.map((c) => (
                  <div key={c.name} style={rowStyle}>
                    <span style={{ flex: 1 }}>{c.name}</span>
                    <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>different in {c.targets.join(" and ")}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <StepNav onBack={() => goTo("targets")} onSkip={() => commit({ skills: { adopt: [], push: [] } }, "notion")} onNext={next} nextDisabled={!plan} />
    </div>
  );
}
```

(`SelectAllControl({ selection })` and `onItemClick(key, { shiftKey, ctrlKey, metaKey })` are the signatures in `components/Checklist.tsx`; a React mouse event satisfies the second argument.)

- [ ] **Step 2: Type check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/setup/steps/SkillsStep.tsx
git commit -m "setup client: skills step (adopt and push checklists)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Notion step

**Files:**
- Create: `client/src/pages/setup/steps/NotionStep.tsx`

**Interfaces:**
- Consumes: `StepProps`; `api.notionStatus`, `api.notionConnect("setup")`, `api.notionDataSources`; `setupApi.inspect`, `setupApi.saveDraft`; `NotionRef`.
- Produces: `NotionStep(props: StepProps)` — Next commits `{ notion: NotionChoice | null }`; Skip commits `{ notion: null }`; both → `"assistant"`. Back → `"skills"`.

- [ ] **Step 1: Implement** — `client/src/pages/setup/steps/NotionStep.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../../../lib/api";
import { setupApi, type NotionRef } from "../../../lib/setup";
import { Button } from "../../../components/ui/primitives";
import type { StepProps } from "../types";
import { Hint, StepHeader, StepNav, labelStyle, listBox, rowStyle } from "../ui";

export function NotionStep({ draft, commit, goTo }: StepProps) {
  const qc = useQueryClient();
  const { data: status, refetch } = useQuery({ queryKey: ["notion-status"], queryFn: () => api.notionStatus() });
  const connected = Boolean(status?.connected);
  const { data: sources, error: sourcesError, isLoading: loadingSources } = useQuery({
    queryKey: ["notion-data-sources"],
    queryFn: () => api.notionDataSources(),
    enabled: connected,
  });
  const [current, setCurrent] = useState<NotionRef | null>(null);
  const [choice, setChoice] = useState<string | null>(draft.notion?.data_source_id ?? null);
  const [addLastEdited, setAddLastEdited] = useState(draft.notion?.add_last_edited ?? true);
  const [connecting, setConnecting] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

  // Back from Notion's sign-in page: ?notion=connected | error&message=…
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const result = params.get("notion");
    if (!result) return;
    if (result === "connected") {
      toast.success("Notion connected");
      void qc.invalidateQueries({ queryKey: ["notion-status"] });
    } else {
      setSignInError(params.get("message") ?? "Notion sign-in didn't finish.");
    }
    history.replaceState(null, "", location.pathname);
  }, [qc]);

  // The database this vault already uses, if any (its notion.json).
  useEffect(() => {
    const v = draft.vault;
    if (!v) return;
    if (v.mode === "clone") setCurrent(v.clone?.notion ?? null);
    else setupApi.inspect(v.path).then((i) => setCurrent(i.notion)).catch(() => setCurrent(null));
  }, [draft.vault]);

  const connect = async () => {
    setConnecting(true);
    setSignInError(null);
    try {
      await setupApi.saveDraft({ ...draft, step: "notion" }); // the sign-in leaves this page
      const r = await api.notionConnect("setup");
      if (r.status === "redirect") window.location.href = r.url;
      else await refetch();
    } catch (err) {
      setSignInError((err as Error).message);
    } finally {
      setConnecting(false);
    }
  };

  const list = sources?.data_sources ?? [];
  const chosen = list.find((s) => s.id === choice) ?? null;
  const next = () =>
    commit(
      { notion: chosen ? { data_source_id: chosen.id, data_source_name: chosen.name, add_last_edited: addLastEdited } : null },
      "assistant",
    );

  return (
    <div>
      <StepHeader title="Notion (optional)">
        Keep a copy of your skills in a Notion database, so you can read and edit them there.
      </StepHeader>

      {current && (
        <Hint tone="good">
          This vault already uses the Notion database "{current.name || current.id}". It stays that way unless you pick another one.
        </Hint>
      )}
      {signInError && <Hint tone="bad">{signInError}</Hint>}

      {!connected && (
        <div style={{ marginTop: 16 }}>
          <Button kind="primary" onClick={connect} disabled={connecting}>
            {connecting ? "Opening Notion…" : "Connect Notion"}
          </Button>
          <Hint>Signing in saves the Notion sign-in on this PC right away. Everything else waits for Finish.</Hint>
        </div>
      )}

      {connected && (
        <div style={{ marginTop: 16 }}>
          <Hint tone="good">Notion is connected.</Hint>
          {loadingSources && <Hint>Looking for your Skills database…</Hint>}
          {sourcesError && <Hint tone="bad">{(sourcesError as Error).message}</Hint>}
          {list.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <span style={labelStyle}>skills database</span>
              <div style={listBox}>
                <label style={rowStyle}>
                  <input type="radio" name="notion-ds" checked={choice === null} onChange={() => setChoice(null)} />
                  {current ? "Keep the current one" : "Don't choose one now"}
                </label>
                {list.map((s) => (
                  <label key={s.id} style={rowStyle}>
                    <input type="radio" name="notion-ds" checked={choice === s.id} onChange={() => setChoice(s.id)} />
                    {s.name || s.id}
                  </label>
                ))}
              </div>
              {chosen && (
                <label style={{ display: "flex", gap: 8, fontSize: 13, marginTop: 10, color: "var(--ink)" }}>
                  <input type="checkbox" checked={addLastEdited} onChange={(e) => setAddLastEdited(e.target.checked)} />
                  Add a "Last edited" property (helps spot changes made in Notion)
                </label>
              )}
            </div>
          )}
          {!loadingSources && !sourcesError && list.length === 0 && (
            <Hint tone="warn">No Skills database found in your Notion workspace yet. You can set it up later in Settings → Notion.</Hint>
          )}
        </div>
      )}

      <StepNav onBack={() => goTo("skills")} onSkip={() => commit({ notion: null }, "assistant")} onNext={next} />
    </div>
  );
}
```

- [ ] **Step 2: Type check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/setup/steps/NotionStep.tsx
git commit -m "setup client: Notion step" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Assistant step

**Files:**
- Create: `client/src/pages/setup/steps/AssistantStep.tsx`

**Interfaces:**
- Consumes: `StepProps` (including `apiKey`, `setApiKey`); `setupApi.assistant`, `AssistantCheck`.
- Produces: `AssistantStep(props: StepProps)` — Next commits `{ assistant: { auth, workspace_id? } }`; Skip commits `{ assistant: null }`; both → `"review"`. Back → `"notion"`.

- [ ] **Step 1: Implement** — `client/src/pages/setup/steps/AssistantStep.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { setupApi } from "../../../lib/setup";
import { Button } from "../../../components/ui/primitives";
import type { StepProps } from "../types";
import { ChoiceCard, Hint, StepHeader, StepNav, inputStyle, labelStyle } from "../ui";

export function AssistantStep({ draft, commit, goTo, apiKey, setApiKey }: StepProps) {
  const [refresh, setRefresh] = useState(0);
  const { data: check, isFetching } = useQuery({
    queryKey: ["setup-assistant", refresh],
    queryFn: () => setupApi.assistant(refresh > 0),
  });
  const [auth, setAuth] = useState<"login" | "api_key" | null>(draft.assistant?.auth ?? null);
  const [workspace, setWorkspace] = useState(draft.assistant?.workspace_id ?? "");

  useEffect(() => {
    if (check && auth === null) {
      setAuth(check.saved.auth);
      if (!draft.assistant) setWorkspace(check.saved.workspace_id ?? "");
    }
  }, [check, auth, draft.assistant]);

  const keyAvailable = Boolean(apiKey.trim() || check?.saved.has_saved_key || check?.saved.env_key_present);
  const next = () => commit({ assistant: { auth: auth ?? "login", ...(workspace.trim() ? { workspace_id: workspace.trim() } : {}) } }, "review");

  return (
    <div>
      <StepHeader title="The AI assistant (optional)">
        The assistant uses the Claude Code command-line tool on this PC to help with your skills.
      </StepHeader>

      {check && !check.installed && (
        <div>
          <Hint tone="warn">The claude command-line tool isn't installed{check.reason ? ` (${check.reason})` : ""}.</Hint>
          <Hint>Install it in a terminal with: npm install -g @anthropic-ai/claude-code</Hint>
        </div>
      )}
      {check?.installed && <Hint tone="good">Installed: {check.version}</Hint>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "18px 0" }}>
        <ChoiceCard
          selected={auth === "login"}
          onSelect={() => setAuth("login")}
          title="Sign in with my Claude account"
          description="Uses the account you signed in with in Claude Code. Best for most people."
        />
        <ChoiceCard
          selected={auth === "api_key"}
          onSelect={() => setAuth("api_key")}
          title="Use an API key"
          description="For Anthropic Console keys. Usage is billed to that key."
        />
      </div>

      {auth === "login" && check?.installed && (
        <>
          {check.login?.logged_in && (
            <Hint tone="good">
              Signed in{check.login.auth_method ? ` (${check.login.auth_method})` : ""}
              {check.login.email ? ` as ${check.login.email}` : ""}.
            </Hint>
          )}
          {check.login && !check.login.logged_in && <Hint tone="warn">Not signed in yet. Open a terminal, run claude, and sign in.</Hint>}
          {!check.login && <Hint>Couldn't check the sign-in. If the assistant asks you to sign in later, run claude in a terminal once.</Hint>}
        </>
      )}

      {auth === "api_key" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label htmlFor="api-key" style={labelStyle}>
              api key
            </label>
            <input id="api-key" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} style={inputStyle} />
            {check?.saved.has_saved_key && !apiKey && <Hint>A key is already saved. Leave this empty to keep it.</Hint>}
            {!check?.saved.has_saved_key && check?.saved.env_key_present && !apiKey && <Hint>Leave this empty to use the ANTHROPIC_API_KEY set on this PC.</Hint>}
            <Hint>Saved on this PC when you press Finish. It's never stored in the setup draft.</Hint>
          </div>
          <div>
            <label htmlFor="workspace-id" style={labelStyle}>
              workspace id (only for keys not tied to a workspace)
            </label>
            <input id="workspace-id" type="text" value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="wrkspc_…" style={inputStyle} />
          </div>
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <Button kind="ghost" size="sm" onClick={() => setRefresh((n) => n + 1)} disabled={isFetching}>
          {isFetching ? "Checking…" : "Check again"}
        </Button>
      </div>

      <StepNav
        onBack={() => goTo("notion")}
        onSkip={() => commit({ assistant: null }, "review")}
        onNext={next}
        nextDisabled={!auth || (auth === "api_key" && !keyAvailable)}
      />
    </div>
  );
}
```

- [ ] **Step 2: Type check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/setup/steps/AssistantStep.tsx
git commit -m "setup client: assistant step" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: Review & Finish step

**Files:**
- Create: `client/src/pages/setup/steps/ReviewStep.tsx`

**Interfaces:**
- Consumes: `StepProps`; `setupApi.apply`, `setupApi.retry`, `setupApi.applyStatus`, `SetupEvent`, `SetupJobState`; `useLocation` from wouter.
- Produces: `ReviewStep(props: StepProps)`; calls `onFinished()` from "Open Skill Vault". Back → `"assistant"`.

- [ ] **Step 1: Implement** — `client/src/pages/setup/steps/ReviewStep.tsx`:

```tsx
import { useState } from "react";
import { useLocation } from "wouter";
import { setupApi, type SetupDraft, type SetupEvent, type SetupJobState } from "../../../lib/setup";
import { Button } from "../../../components/ui/primitives";
import type { StepProps } from "../types";
import { Hint, StepHeader, StepNav, listBox, rowStyle } from "../ui";

const STEP_NAME: Record<SetupEvent["step"], string> = {
  vault: "Vault",
  config: "Settings",
  adopt: "Adopt",
  push: "Push",
  notion: "Notion",
  done: "Done",
};
const MARK: Record<SetupEvent["state"], string> = { start: "…", done: "✓", skip: "–", error: "✗" };

function plannedActions(d: SetupDraft): string[] {
  const out: string[] = [];
  const v = d.vault;
  if (v?.mode === "new") out.push(`Create a new vault in ${v.path}`);
  if (v?.mode === "existing") out.push(`Use the vault in ${v.path}`);
  if (v?.mode === "clone" && v.clone) out.push(`Clone ${v.clone.url} into ${v.clone.dest}${v.clone.subdir ? ` (vault in ${v.clone.subdir}/)` : ""}`);

  const parts: string[] = [];
  if (d.targets) {
    const on = d.targets.filter((t) => t.enabled);
    parts.push(on.length ? `tools: ${on.map((t) => (t.is_default ? `${t.id} (default)` : t.id)).join(", ")}` : "no tools");
  }
  if (d.machine_id) parts.push(`this PC: ${d.machine_id}`);
  if (v?.repo_url) parts.push(`repo: ${v.repo_url}`);
  if (d.assistant) parts.push(`assistant: ${d.assistant.auth === "login" ? "Claude account" : "API key"}`);
  out.push(`Save settings${parts.length ? ` (${parts.join("; ")})` : ""}`);

  if (d.skills.adopt.length) out.push(`Adopt ${d.skills.adopt.length} skill${d.skills.adopt.length === 1 ? "" : "s"} into the vault`);
  if (d.skills.push.length) out.push(`Push ${d.skills.push.length} skill${d.skills.push.length === 1 ? "" : "s"} to your default tools`);
  if (d.notion) out.push(`Use the Notion database "${d.notion.data_source_name || d.notion.data_source_id}"`);
  return out;
}

export function ReviewStep({ draft, goTo, apiKey, onFinished }: StepProps) {
  const [, navigate] = useLocation();
  const [phase, setPhase] = useState<"review" | "running" | "result">("review");
  const [events, setEvents] = useState<SetupEvent[]>([]);
  const [result, setResult] = useState<SetupJobState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (job: (onEvent: (e: SetupEvent) => void) => Promise<void>, keep: boolean) => {
    setPhase("running");
    setError(null);
    if (!keep) setEvents([]);
    try {
      await job((e) => setEvents((xs) => [...xs, e]));
    } catch (err) {
      setError((err as Error).message);
    }
    // The stream can drop; the server keeps the job's result either way.
    const state = await setupApi.applyStatus().catch(() => null);
    setResult(state);
    if (state && !state.vault_path) {
      setPhase("review"); // steps 1–2 failed: nothing was saved
      const last = state.events.at(-1);
      if (last?.state === "error") setError(last.message ?? "Setup failed.");
      return;
    }
    setPhase("result");
  };

  const finish = () => run((onEvent) => setupApi.apply(draft, apiKey, onEvent), false);
  const retry = () => run((onEvent) => setupApi.retry(onEvent), true);

  const log = (
    <div style={{ ...listBox, maxHeight: 320, marginTop: 16 }}>
      {events.map((e, i) => (
        <div key={i} style={{ ...rowStyle, alignItems: "flex-start" }}>
          <span style={{ width: 16, color: e.state === "error" ? "var(--bad)" : "var(--ink-3)" }}>{MARK[e.state]}</span>
          <span style={{ width: 70, color: "var(--ink-3)", fontSize: 12 }}>{STEP_NAME[e.step]}</span>
          <span style={{ flex: 1 }}>
            {e.item ?? e.message ?? ""}
            {e.item && e.message ? <span style={{ color: e.state === "error" ? "var(--bad)" : "var(--ink-3)" }}> — {e.message}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );

  if (phase === "running") {
    return (
      <div>
        <StepHeader title="Setting things up…">This can take a minute if you're cloning a repo.</StepHeader>
        {log}
      </div>
    );
  }

  if (phase === "result" && result) {
    return (
      <div>
        <StepHeader title={result.ok ? "You're all set" : "Almost done"}>
          {result.ok ? "Everything is saved." : "Your vault and settings are saved, but a few items didn't go through."}
        </StepHeader>
        {log}
        {!result.ok && (
          <>
            <Hint>Anything already moved stays where it is.</Hint>
            <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
              <Button onClick={retry}>Retry failed items</Button>
              <Button kind="ghost" onClick={() => navigate("/adopt")}>
                Open Adopt
              </Button>
              <Button kind="ghost" onClick={() => navigate("/settings")}>
                Open Settings
              </Button>
            </div>
          </>
        )}
        <div style={{ marginTop: 24 }}>
          <Button kind="primary" size="lg" onClick={onFinished}>
            Open Skill Vault
          </Button>
        </div>
      </div>
    );
  }

  const actions = plannedActions(draft);
  return (
    <div>
      <StepHeader title="Ready to set up">Here's exactly what will happen when you press Finish.</StepHeader>
      <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13.5, lineHeight: 1.9, color: "var(--ink)" }}>
        {actions.map((a, i) => (
          <li key={i}>{a}</li>
        ))}
      </ol>
      {error && <Hint tone="bad">{error} Nothing was saved. Fix it and press Finish again.</Hint>}
      {events.length > 0 && error && log}
      <StepNav onBack={() => goTo("assistant")} onNext={finish} nextLabel="Finish" nextDisabled={!draft.vault} />
    </div>
  );
}
```

- [ ] **Step 2: Type check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/setup/steps/ReviewStep.tsx
git commit -m "setup client: review and Finish with live progress and retry" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: Guide shell, Welcome, and entry points

**Files:**
- Create: `client/src/pages/setup/SetupGuide.tsx`
- Modify: `client/src/App.tsx`, `client/src/pages/Settings.tsx`, `client/src/components/CommandBar.tsx`
- Delete: `client/src/pages/Setup.tsx`

**Interfaces:**
- Consumes: all step components (Tasks 13–18); `StepProps`; `setupApi`; `api.getConfig`; `Logo` from `@/components/ui/Logo`.
- Produces: default export `SetupGuide` mounted at `/setup`; Settings "Run setup guide…" button; command bar entry "Setup guide".

- [ ] **Step 1: Implement** — `client/src/pages/setup/SetupGuide.tsx`:

```tsx
/**
 * The setup guide at /setup (design: docs/superpowers/specs/2026-10-27-setup-guide-design.md).
 * Holds the draft (saved to the server on every step change), the API key
 * (page memory only), and renders the current step. First run (no vault yet)
 * has no Close button; a re-run asks before discarding.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Logo } from "@/components/ui/Logo";
import { api } from "../../lib/api";
import { setupApi, type SetupDraft, type SetupStep } from "../../lib/setup";
import { Button } from "../../components/ui/primitives";
import type { StepProps } from "./types";
import { Hint, StepHeader } from "./ui";
import { VaultStep } from "./steps/VaultStep";
import { TargetsStep } from "./steps/TargetsStep";
import { SkillsStep } from "./steps/SkillsStep";
import { NotionStep } from "./steps/NotionStep";
import { AssistantStep } from "./steps/AssistantStep";
import { ReviewStep } from "./steps/ReviewStep";

const RAIL: { id: SetupStep; label: string }[] = [
  { id: "vault", label: "Vault" },
  { id: "targets", label: "Tools" },
  { id: "skills", label: "Skills" },
  { id: "notion", label: "Notion" },
  { id: "assistant", label: "Assistant" },
  { id: "review", label: "Finish" },
];

function Rail({ current }: { current: SetupStep }) {
  const at = RAIL.findIndex((s) => s.id === current);
  return (
    <ol style={{ display: "flex", gap: 6, listStyle: "none", padding: 0, margin: "0 0 32px", flexWrap: "wrap" }}>
      {RAIL.map((s, i) => (
        <li
          key={s.id}
          aria-current={s.id === current ? "step" : undefined}
          style={{
            fontSize: 12,
            padding: "4px 10px",
            borderRadius: 999,
            border: "0.5px solid var(--border-2)",
            background: s.id === current ? "var(--ink)" : "transparent",
            color: s.id === current ? "var(--bg)" : i < at ? "var(--ink-2)" : "var(--ink-3)",
            fontWeight: s.id === current ? 600 : 500,
          }}
        >
          {i + 1}. {s.label}
        </li>
      ))}
    </ol>
  );
}

function Welcome({
  firstRun,
  saved,
  stale,
  onResume,
  onStart,
}: {
  firstRun: boolean;
  saved: SetupDraft | null;
  stale: boolean;
  onResume: () => void;
  onStart: () => void;
}) {
  return (
    <div>
      <StepHeader title={firstRun ? "Welcome to Skill Vault" : "Setup guide"}>
        A few short steps: where your skills live, the tools you use, Notion and the assistant. Nothing is saved until you press Finish.
      </StepHeader>
      {saved && stale && <Hint tone="warn">Your settings changed since you last used the guide, so it starts over.</Hint>}
      <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
        {saved && !stale ? (
          <>
            <Button kind="primary" size="lg" onClick={onResume}>
              Resume where I left off
            </Button>
            <Button kind="ghost" size="lg" onClick={onStart}>
              Start over
            </Button>
          </>
        ) : (
          <Button kind="primary" size="lg" onClick={onStart}>
            {firstRun ? "Get started" : "Start"}
          </Button>
        )}
      </div>
    </div>
  );
}

export default function SetupGuide() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: () => api.getConfig() });
  const { data: caps } = useQuery({ queryKey: ["setup-capabilities"], queryFn: () => setupApi.capabilities() });
  const [saved, setSaved] = useState<{ draft: SetupDraft | null; stale: boolean } | null>(null);
  const [draft, setDraft] = useState<SetupDraft | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const firstRun = !config?.vault_path;

  useEffect(() => {
    setupApi
      .getDraft()
      .then((r) => {
        setSaved(r);
        // Back from Notion's sign-in: straight to the step the draft was on.
        if (new URLSearchParams(location.search).has("notion") && r.draft && !r.stale) setDraft(r.draft);
      })
      .catch((err) => setLoadError((err as Error).message));
  }, []);

  const save = async (next: SetupDraft) => {
    setDraft(next);
    try {
      await setupApi.saveDraft(next);
    } catch (err) {
      toast.error(`Couldn't save your progress: ${(err as Error).message}`);
    }
  };

  const start = async () => {
    try {
      setDraft((await setupApi.startDraft()).draft);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const close = async () => {
    if (!window.confirm("Discard your changes?")) return;
    await setupApi.discardDraft().catch(() => {});
    navigate("/settings");
  };

  const props: StepProps | null = draft
    ? {
        draft,
        commit: (patch, to) => save({ ...draft, ...patch, step: to }),
        goTo: (to) => void save({ ...draft, step: to }),
        folderDialog: Boolean(caps?.folder_dialog),
        apiKey,
        setApiKey,
        onFinished: () => {
          void qc.invalidateQueries();
          navigate("/");
        },
      }
    : null;

  const step = draft?.step === "welcome" ? "vault" : draft?.step;

  return (
    <div className="sv-fade-in" style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", justifyContent: "center", padding: "64px 24px" }}>
      <div style={{ width: "100%", maxWidth: 640 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28 }}>
          <Logo size={30} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", flex: 1 }}>Skill Vault</span>
          {!firstRun && (
            <Button kind="ghost" size="sm" onClick={close}>
              Close
            </Button>
          )}
        </div>

        {loadError && <Hint tone="bad">{loadError}</Hint>}
        {saved && !draft && <Welcome firstRun={firstRun} saved={saved.draft} stale={saved.stale} onResume={() => setDraft(saved.draft)} onStart={start} />}
        {props && step && (
          <>
            <Rail current={step} />
            {step === "vault" && <VaultStep {...props} />}
            {step === "targets" && <TargetsStep {...props} />}
            {step === "skills" && <SkillsStep {...props} />}
            {step === "notion" && <NotionStep {...props} />}
            {step === "assistant" && <AssistantStep {...props} />}
            {step === "review" && <ReviewStep {...props} />}
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount it** — in `client/src/App.tsx` replace `import Setup from "./pages/Setup";` with `import SetupGuide from "./pages/setup/SetupGuide";` and `<Route path="/setup" component={Setup} />` with `<Route path="/setup" component={SetupGuide} />`. Then delete the old page:

```bash
git rm client/src/pages/Setup.tsx
```

- [ ] **Step 3: Settings button** — in `client/src/pages/Settings.tsx` add `import { useLocation } from "wouter";`, add `const [, navigate] = useLocation();` at the top of `Settings()`, and in the header row, after the `<div style={{ flex: 1 }}>…</div>` block, add:

```tsx
          <Button size="sm" onClick={() => navigate("/setup")}>
            Run setup guide…
          </Button>
```

- [ ] **Step 4: Command bar** — in `client/src/components/CommandBar.tsx` change the `sv init` entry's label from `"Setup wizard"` to `"Setup guide"`.

- [ ] **Step 5: Type check and build**

Run: `npm run typecheck` then `npm run build`
Expected: both PASS (`built → dist`).

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/setup/SetupGuide.tsx client/src/App.tsx client/src/pages/Settings.tsx client/src/components/CommandBar.tsx
git commit -m "setup client: guide shell, welcome, and Settings/command bar entry points" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 20: Docs

**Files:**
- Modify (repo root `docs/`): `getting-started.md`, `features.md`, `configuration.md`, `tech_reference.md`, `troubleshooting.md`, `faq.md`, `changelog.md`, `SummaryOfChanges.md`, `INDEX.md`; and `app/CHANGELOG.md`

**Interfaces:**
- Consumes: the behaviour built in Tasks 1–19.

- [ ] **Step 1: getting-started.md** — replace the first-run paragraph(s) about typing a vault path with a "First run: the setup guide" section:

```markdown
### First run: the setup guide

The first time Skill Vault opens, a short guide walks you through:

1. **Vault**: start a new vault, use a folder you already have, or clone a vault repo from GitHub. **Browse…** opens the normal Windows folder picker; you can also paste a path.
2. **Tools**: Claude Code, Cursor, Copilot and the other known tools are detected. Tick the ones you use; "default" tools also get every new skill.
3. **Skills** (optional): adopt skills found in your tools into the vault, and push vault skills out to your default tools. Each list has checkboxes.
4. **Notion** (optional): connect and pick your Skills database.
5. **Assistant** (optional): sign in with your Claude account or use an API key.
6. **Finish**: a list of exactly what will happen, then live progress.

Nothing is saved until you press **Finish**. If you close the window halfway, the guide offers to resume. Run it again any time from **Settings → Run setup guide…** or the command bar ("Setup guide"); it opens with your current settings filled in.
```

- [ ] **Step 2: features.md** — add a "Setup guide" section with the same six steps in one line each and the two facts "nothing saved until Finish" and "re-run from Settings".

- [ ] **Step 3: configuration.md** — under "Launcher files (per machine)" (or a new "Setup guide files" heading), add:

```markdown
- `setup-draft.json` — the setup guide's answers while it's open (vault choice, tools, picks, Notion database, assistant mode). Never holds your API key or Notion sign-in. Deleted when Finish saves your settings, or when you press Start over / Close. Safe to delete.
```

  and in the `vault_path` entry change "set by `sv init` or the app's Setup page" to "set by `sv init` or the app's setup guide".

- [ ] **Step 4: tech_reference.md** — add a "## Setup guide" section: the `/api/setup` endpoint table (capabilities, draft ×4, pick-folder, inspect, targets, clone-preview, plan, assistant, apply, apply/retry, apply/status), the draft rules (normalised, no secrets, `base` fingerprint → stale), the Finish order and failure rules, the busy rules (Finish counts for idle stop + updater; a pending Notion sign-in counts for idle stop only, max 10 min), the same-origin guard and the folder dialog's Windows/loopback rule, the clone preview command (`--depth 1 --filter=blob:none --no-checkout`, temp folder removed), and the Notion `return_to` value. Add the new rows to the API table.

- [ ] **Step 5: troubleshooting.md** — add entries:

```markdown
### Browse… does nothing, or the folder dialog is behind the window

The dialog opens on top of the app; if another program took focus, look for it in the taskbar. Browse only appears when the app runs on this PC (not over the LAN or on a Mac); you can always paste a path instead.

### "The repo wasn't found, or it needs a sign-in this PC doesn't have"

Check the URL. For a private repo, sign in to GitHub with Git on this PC first (for example, clone any private repo once in a terminal so Git Credential Manager saves your sign-in), then try again.

### Notion sign-in came back with an error

The guide returns to the Notion step with Notion's reason. Press **Connect Notion** again, or skip the step and connect later in Settings → Notion.

### Setup finished with "items need attention"

Your vault and settings are saved. Press **Retry failed items**, or finish those skills on the Adopt page. Skills that were already moved stay where they are.
```

- [ ] **Step 6: faq.md** — add Q&As: "Can I run the setup guide again?" (yes, Settings → Run setup guide…, nothing changes until Finish); "Does the guide store my API key?" (only in `~/.skill-vault/config.json` when you press Finish, as Settings does; never in the draft); "Can I use a vault that lives inside a bigger repo?" (yes: clone finds `skills.json` at the repo root or one folder down, like `agent-skills/skills/`).

- [ ] **Step 7: changelog.md / app/CHANGELOG.md / SummaryOfChanges.md / INDEX.md** — add an "Unreleased — 2026-10-28" entry: *Added* setup guide (six steps, Windows folder dialog, clone with preview, target detection, adopt/push picks, Notion and assistant steps, review with live progress and retry, resume, re-run from Settings and the command bar); *Fixed* Notion sign-in returns to the page that started it, and a slow Notion sign-in no longer lets the installed app stop itself; *Changed* push and Notion database selection share services with the guide. SummaryOfChanges gets a dated entry listing the files touched. INDEX.md: getting-started description mentions the setup guide.

- [ ] **Step 8: Commit**

```bash
git add ../docs CHANGELOG.md
git commit -m "docs: setup guide" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Run from `app/`: the root docs are `../docs` and the app changelog is `CHANGELOG.md`.)

---

### Task 21: Full verification and walk-through

**Files:** none (verification only; fix anything it finds in the task that owns it).

- [ ] **Step 1: Automated checks**

Run: `npm test`, `npm run typecheck`, `npm run build`
Expected: all pass; note the test count.

- [ ] **Step 2: Sandboxed server** — never point the walk-through at the real `~/.skill-vault`. Create a scratch script outside the repo (e.g. in the session scratchpad) named `sandbox-setup.mjs`:

```js
// node --import tsx sandbox-setup.mjs <appDir> <fakeHome> <port>
import { pathToFileURL } from "node:url";
import path from "node:path";
const [appDir, home, port] = process.argv.slice(2);
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.PORT = port;
process.env.OPEN_BROWSER = "0";
process.chdir(appDir);
await import(pathToFileURL(path.join(appDir, "server", "launcher.ts")).href);
```

Make a temp home containing `.claude/skills/<two skill folders with SKILL.md>` and `.cursor/` (no skills folder), then run it in the background from `app/` with port 9977.

- [ ] **Step 3: Walk through in the browser pane** at `http://127.0.0.1:9977/` and capture a screenshot of each step:
  - First run redirects to `/setup`; Welcome shows "Get started"; no Close button.
  - Vault → "Start a new vault" with a temp path: "will be created". Try "Use a folder I have" on the `.claude/skills` folder: the "tool's skills folder" warning blocks Next.
  - Clone: enter a bad URL → plain error; (optional) a real public vault repo → "Vault found …".
  - Targets: Claude Code "Found" and ticked; Cursor "Installed, no skills folder yet".
  - Skills: the two `.claude/skills` skills are listed to adopt and ticked.
  - Notion: Skip. Assistant: shows installed/sign-in state; choose Claude account.
  - Review lists the actions; Finish streams progress; "You're all set" → Open Skill Vault shows the adopted skills.
  - Settings shows "Run setup guide…"; the re-run opens pre-filled; Close asks to discard.
  - Reload mid-guide → Welcome offers Resume.

- [ ] **Step 4: Folder dialog by hand** — ask the user to click **Browse…** once in the sandbox (or the real app after merge) and confirm the modern dialog opens in front and fills the field.

- [ ] **Step 5: Clean up** — stop the sandbox server and delete the temp home. Report what passed, what couldn't be covered (Notion sign-in round trip against real Notion, a private-repo clone), and any fixes made.
