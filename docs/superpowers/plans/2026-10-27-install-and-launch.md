# Install & Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One script installs Skill Vault on Windows with a Start Menu folder; the shortcut opens the built app in an Edge app window with no console, reuses a running server, stops it when idle, and the app updates itself from GitHub in one click.

**Architecture:** Two small PowerShell scripts (`setup.ps1` at the repo root, `app/scripts/launch.ps1`) drive install and launch. Everything testable lives in Node: a JS build script with a build stamp and a staleness check, plus server modules for the instance lock, rotating log, idle stop, and git-based self-update, wired into `launcher.ts` / `index.ts` and exposed at `/api/health` and `/api/app/update`. The client gets an "Update available" pill in the sidebar footer.

**Tech Stack:** Node ≥ 20 (ESM, TypeScript via tsx), Express 5, Vite 5 + esbuild JS APIs, React 18 + TanStack Query, node:test, Windows PowerShell 5.1, git.

**Spec:** `docs/superpowers/specs/2026-10-27-install-and-launch-design.md`

## Global Constraints

- Windows-only scripts must run on **Windows PowerShell 5.1** (`powershell.exe`): no ternaries, no `??`, no `&&` in `.ps1` files.
- Node **≥ 20**. **No new npm dependencies.**
- `npm run dev` and `app\run.bat` must behave exactly as before. The new behaviors are opt-in flags (`--exit-when-idle`, `--log-file`, `--strict-port`).
- The repo is **public**: no personal names, machine names, user-specific paths or emails in code, tests or docs.
- Files: lock `~/.skill-vault/app.lock`; server log `~/.skill-vault/logs/server.log`, rotated at **5 MB**, keeping **3** (`.1`–`.3`); launcher log `~/.skill-vault/logs/launch.log`.
- Timings: idle grace **60 s** after the last window disconnects (**120 s** before the first window connects); update check **30 s** after start, then every **6 h**; `--strict-port` waits up to **10 s**; the launcher waits up to **20 s** for health.
- `node scripts/build-state.mjs` exit codes: **0** = fresh, **10** = stale.
- Every `npm ci` is `npm ci --include=dev` with `NODE_ENV` removed from the environment (the build needs dev dependencies).
- Tests: `cd app && npm test` (node:test over `server/**/*.test.ts`) and `npm run typecheck` must pass at the end of every task.
- Every commit message ends with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Spec deviations, decided while planning: (1) the app has no top bar, so the update pill sits in the **sidebar footer** above the Assistant button. (2) The Start Menu shortcut runs `conhost.exe --headless powershell.exe …`, because a plain `powershell -WindowStyle Hidden` leaves a Windows Terminal window visible when Terminal is the default console. Task 9 verifies this and gives the fallback.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `app/scripts/build.mjs` | create | Production build (Vite + esbuild JS APIs) into `dist/` or `--out <dir>`, then `.build-stamp` |
| `app/scripts/build-state.mjs` (+ `.d.mts`) | create | `isBuildStale(appDir)`; CLI exits 0 / 10 |
| `app/server/services/buildState.test.ts` | create | Tests for `isBuildStale` |
| `app/server/services/instanceLock.ts` (+ test) | create | `app.lock` read/acquire/release, `isProcessAlive`, `buildVersion` |
| `app/server/routes/app.ts` (+ test) | create | `GET /api/health`, `GET/POST /api/app/update[...]` |
| `app/server/services/logFile.ts` (+ test) | create | Rotating log sink; tee stdout/stderr |
| `app/server/services/idleStop.ts` (+ test) | create | Idle decision + interval |
| `app/server/launcher.idle.test.ts` | create | Integration: real server process, lock, health, idle exit |
| `app/server/services/appUpdate.ts` (+ test) | create | Git facts, can-apply rules, check scheduler, apply pipeline, `swapDist` |
| `app/client/src/lib/appUpdate.ts` | create | Client API: status / check / apply stream / health polling |
| `app/client/src/components/AppUpdate.tsx` | create | `UpdatePill` + `AppUpdateDialog` |
| `app/scripts/launch.ps1` | create | Hidden launcher |
| `setup.ps1`, `setup.cmd` (repo root) | create | Installer + uninstaller |
| `app/package.json` | modify | `build` → `node scripts/build.mjs`; drop `build:client` / `build:server` |
| `app/server/launcher.ts` | modify | Flags, lock, log file, idle stop, strict port, restart |
| `app/server/index.ts` | modify | Mount `appRouter`, `isBusy`, updater, async history scan, `restart` option |
| `app/server/routes/events.ts` | modify | `sseClientCount()` |
| `app/server/services/assistant/session.ts` | modify | `anyTurnRunning()` |
| `app/server/services/historyRecorder.ts` (+ test) | modify | Generator-based scan + `scanForUnrecordedChangesAsync` |
| `app/client/src/components/Layout.tsx` | modify | Mount `<UpdatePill />` |
| `README.md`, `docs/getting-started.md`, `docs/troubleshooting.md`, `docs/configuration.md`, `app/CHANGELOG.md` | modify | Docs |

All commands below run from `C:\…\skill-vault\app` unless the step says otherwise. In bash use `cd app`.

---

### Task 1: Build script, build stamp, and staleness check

**Files:**
- Create: `app/scripts/build.mjs`, `app/scripts/build-state.mjs`, `app/scripts/build-state.d.mts`
- Test: `app/server/services/buildState.test.ts`
- Modify: `app/package.json` (scripts), `app/server/index.ts:255` (error text), `app/server/assistant-mcp/main.ts:8` and `app/server/services/assistant/mcpConfig.ts:7` (comments)

**Interfaces:**
- Produces: `isBuildStale(appDir: string): boolean` from `scripts/build-state.mjs`; `node scripts/build-state.mjs` → exit 0/10; `node scripts/build.mjs [--out <dir>]` writes `<dir>/{launcher.js,index.js,assistant-mcp.js,public/,.build-stamp}`; `.build-stamp` JSON `{ built_at: string, git_sha: string | null }`.

- [ ] **Step 1: Write the failing test**

`app/server/services/buildState.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isBuildStale } from "../../scripts/build-state.mjs";

const OLDER = new Date(Date.now() - 120_000);
const PAST = new Date(Date.now() - 60_000);
const SOURCES = ["server/index.ts", "client/src/main.tsx", "package.json"];

/** A fake app dir whose sources are all older than a build made at PAST. */
function builtApp(): string {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "sv-build-"));
  for (const rel of SOURCES) {
    fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
    fs.writeFileSync(path.join(app, rel), "x");
    fs.utimesSync(path.join(app, rel), OLDER, OLDER);
  }
  fs.mkdirSync(path.join(app, "dist", "public"), { recursive: true });
  for (const rel of ["dist/launcher.js", "dist/public/index.html", "dist/.build-stamp"]) {
    fs.writeFileSync(path.join(app, rel), "x");
    fs.utimesSync(path.join(app, rel), PAST, PAST);
  }
  return app;
}

test("fresh when every watched file is older than the build stamp", () => {
  assert.equal(isBuildStale(builtApp()), false);
});

test("stale when any build output is missing", () => {
  for (const rel of ["dist/launcher.js", "dist/public/index.html", "dist/.build-stamp"]) {
    const app = builtApp();
    fs.rmSync(path.join(app, rel));
    assert.equal(isBuildStale(app), true, rel);
  }
});

test("stale when a source file or a package file is newer than the stamp", () => {
  const app = builtApp();
  fs.utimesSync(path.join(app, "client/src/main.tsx"), new Date(), new Date());
  assert.equal(isBuildStale(app), true);
  const app2 = builtApp();
  fs.utimesSync(path.join(app2, "package.json"), new Date(), new Date());
  assert.equal(isBuildStale(app2), true);
});

test("a new or edited test file doesn't make the build stale", () => {
  const app = builtApp();
  fs.writeFileSync(path.join(app, "server", "thing.test.ts"), "x");
  assert.equal(isBuildStale(app), false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test server/services/buildState.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/build-state.mjs`.

- [ ] **Step 3: Implement `scripts/build-state.mjs` and its type declaration**

`app/scripts/build-state.mjs`:

```js
/**
 * Is the production build (dist/) older than the source? scripts/launch.ps1
 * asks before starting the built server:
 *
 *   node scripts/build-state.mjs   → exit 0 (fresh) or 10 (stale: run `npm run build`)
 *
 * Stale when dist/launcher.js, dist/public/index.html or dist/.build-stamp is
 * missing, or a watched source file is newer than the stamp. Test files never
 * make the build stale.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WATCHED_DIRS = ["server", "client", "assistant-plugin"];
const WATCHED_FILES = [
  "package.json",
  "package-lock.json",
  "vite.config.ts",
  "tsconfig.json",
  "tailwind.config.ts",
  "postcss.config.js",
  "scripts/build.mjs",
];
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

function newestMtime(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let newest = 0;
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) newest = Math.max(newest, newestMtime(p));
    } else if (e.isFile() && !TEST_FILE.test(e.name)) {
      newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  }
  return newest;
}

export function isBuildStale(appDir) {
  const dist = path.join(appDir, "dist");
  const stamp = path.join(dist, ".build-stamp");
  const outputs = [stamp, path.join(dist, "launcher.js"), path.join(dist, "public", "index.html")];
  if (!outputs.every((f) => fs.existsSync(f))) return true;
  const builtAt = fs.statSync(stamp).mtimeMs;
  if (WATCHED_DIRS.some((d) => newestMtime(path.join(appDir, d)) > builtAt)) return true;
  return WATCHED_FILES.some((f) => {
    try {
      return fs.statSync(path.join(appDir, f)).mtimeMs > builtAt;
    } catch {
      return false;
    }
  });
}

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(isBuildStale(APP_DIR) ? 10 : 0);
}
```

`app/scripts/build-state.d.mts`:

```ts
export function isBuildStale(appDir: string): boolean;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test server/services/buildState.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write `scripts/build.mjs`**

`app/scripts/build.mjs`:

```js
/**
 * Production build: the React client (Vite) and the server bundles (esbuild)
 * into one output folder, then dist/.build-stamp.
 *
 *   node scripts/build.mjs                  → dist/
 *   node scripts/build.mjs --out dist-next  → staging folder for in-app updates
 *                                             (server/services/appUpdate.ts swaps it in)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outArg = process.argv.indexOf("--out");
const out = path.resolve(APP, outArg > -1 ? process.argv[outArg + 1] : "dist");

fs.rmSync(out, { recursive: true, force: true });

await viteBuild({
  configFile: path.join(APP, "vite.config.ts"),
  logLevel: "warn",
  build: { outDir: path.join(out, "public"), emptyOutDir: true },
});

const server = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  packages: "external",
  logLevel: "warning",
};
await esbuild({
  ...server,
  entryPoints: [path.join(APP, "server", "launcher.ts"), path.join(APP, "server", "index.ts")],
  outdir: out,
});
await esbuild({
  ...server,
  entryPoints: [path.join(APP, "server", "assistant-mcp", "main.ts")],
  outfile: path.join(out, "assistant-mcp.js"),
});

let gitSha = null;
try {
  gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: APP, encoding: "utf8" }).trim();
} catch {
  /* not a git checkout */
}
fs.writeFileSync(
  path.join(out, ".build-stamp"),
  JSON.stringify({ built_at: new Date().toISOString(), git_sha: gitSha }) + "\n",
);
console.log(`built → ${path.relative(APP, out) || "."}`);
```

- [ ] **Step 6: Point `npm run build` at it and fix the three references to the old scripts**

In `app/package.json` `scripts`, replace the three lines

```json
    "build:client": "vite build",
    "build:server": "esbuild server/launcher.ts server/index.ts --bundle --platform=node --target=node20 --format=esm --packages=external --outdir=dist && esbuild server/assistant-mcp/main.ts --bundle --platform=node --target=node20 --format=esm --packages=external --outfile=dist/assistant-mcp.js",
    "build": "npm run build:client && npm run build:server",
```

with

```json
    "build": "node scripts/build.mjs",
```

In `app/server/index.ts`, change `` `Production bundle not found at ${dist}. Run 'npm run build:client' first.` `` to `` `Production bundle not found at ${dist}. Run 'npm run build' first.` ``.
In `app/server/assistant-mcp/main.ts:8` change `` `npm run build:server` `` to `` `npm run build` (scripts/build.mjs) ``.
In `app/server/services/assistant/mcpConfig.ts:7` change `(see the build:server entry in package.json)` to `(built by scripts/build.mjs)`.

- [ ] **Step 7: Verify the real build and the staleness CLI**

Run (bash):
```bash
cd app && npm run build && ls dist dist/public | head && cat dist/.build-stamp
node scripts/build-state.mjs; echo "fresh exit: $?"
touch server/index.ts && node scripts/build-state.mjs; echo "stale exit: $?"
npm run build >/dev/null && node scripts/build-state.mjs; echo "rebuilt exit: $?"
```
Expected: `dist/` contains `launcher.js index.js assistant-mcp.js public .build-stamp`; the stamp shows `built_at` and the short SHA; exits print `0`, `10`, `0`.

- [ ] **Step 8: Full suite, typecheck, commit**

Run: `npm test && npm run typecheck`
Expected: all tests pass (the earlier total plus 4), tsc exit 0.

```bash
git add app/scripts/build.mjs app/scripts/build-state.mjs app/scripts/build-state.d.mts app/server/services/buildState.test.ts app/package.json app/server/index.ts app/server/assistant-mcp/main.ts app/server/services/assistant/mcpConfig.ts
git commit -F - <<'EOF'
build: one JS build script with a build stamp and a staleness check

scripts/build.mjs builds client + server bundles via the Vite and esbuild
JS APIs into dist/ (or --out <dir> for staged update builds) and writes
dist/.build-stamp. scripts/build-state.mjs exits 0 when dist/ is current
and 10 when any watched source is newer, for the launcher.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: Instance lock and `GET /api/health`

**Files:**
- Create: `app/server/services/instanceLock.ts`, `app/server/routes/app.ts`
- Test: `app/server/services/instanceLock.test.ts`, `app/server/routes/app.test.ts`
- Modify: `app/server/index.ts` (imports; mount router), `app/server/launcher.ts` (acquire/release)

**Interfaces:**
- Consumes: `.build-stamp` from Task 1.
- Produces:
  - `interface InstanceLock { pid: number; port: number; started_at: string; version: string; mode: "development" | "production" }`
  - `lockPath(): string`, `readLock(): InstanceLock | null`, `isProcessAlive(pid: number): boolean`, `acquireLock(lock: InstanceLock, alive?: (pid: number) => boolean): boolean`, `releaseLock(pid: number): void`, `buildVersion(appRoot: string, mode: InstanceLock["mode"]): string`
  - `interface HealthInfo { ok: true; pid: number; port: number | null; version: string; mode: "development" | "production" }`
  - `appRouter(opts: { health: () => HealthInfo }): Router`, mounted at `/api` (Task 7 adds `updater` to `opts`)

- [ ] **Step 1: Write the failing lock tests**

`app/server/services/instanceLock.test.ts`:

```ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireLock,
  buildVersion,
  isProcessAlive,
  lockPath,
  readLock,
  releaseLock,
  type InstanceLock,
} from "./instanceLock.ts";

const lock = (pid: number, port = 9994): InstanceLock => ({
  pid,
  port,
  started_at: "2026-10-27T00:00:00.000Z",
  version: "abc1234",
  mode: "production",
});

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sv-lock-"));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
});

test("acquire writes the lock when none exists; release removes only our own", () => {
  assert.equal(acquireLock(lock(111)), true);
  assert.equal(readLock()?.pid, 111);
  releaseLock(222);
  assert.equal(readLock()?.pid, 111, "another pid can't clear it");
  releaseLock(111);
  assert.equal(readLock(), null);
  assert.equal(fs.existsSync(lockPath()), false);
});

test("a lock held by a live process is not taken over", () => {
  acquireLock(lock(111));
  assert.equal(acquireLock(lock(222), () => true), false);
  assert.equal(readLock()?.pid, 111);
});

test("a stale lock (its process is gone) is replaced", () => {
  acquireLock(lock(111));
  assert.equal(acquireLock(lock(222, 9995), () => false), true);
  assert.deepEqual(readLock(), lock(222, 9995));
});

test("an unreadable lock file counts as no lock", () => {
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
  fs.writeFileSync(lockPath(), "{not json");
  assert.equal(readLock(), null);
  assert.equal(acquireLock(lock(111)), true);
});

test("isProcessAlive is true for this process", () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test("buildVersion reads the stamp's SHA in production and says dev otherwise", () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "sv-ver-"));
  fs.mkdirSync(path.join(app, "dist"));
  fs.writeFileSync(path.join(app, "dist", ".build-stamp"), JSON.stringify({ built_at: "x", git_sha: "abc1234" }));
  assert.equal(buildVersion(app, "production"), "abc1234");
  assert.equal(buildVersion(app, "development"), "dev");
  assert.equal(buildVersion(path.join(app, "missing"), "production"), "unknown");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test server/services/instanceLock.test.ts`
Expected: FAIL, module `./instanceLock.ts` not found.

- [ ] **Step 3: Implement `instanceLock.ts`**

```ts
/**
 * ~/.skill-vault/app.lock — which server owns this user's app window.
 * scripts/launch.ps1 reads it to reuse a running server instead of starting
 * a second one. A server takes the lock only when no live process holds it
 * (a second server — e.g. `npm run dev` beside the built app — still runs,
 * it just doesn't own the lock) and clears it only while it still owns it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface InstanceLock {
  pid: number;
  port: number;
  started_at: string;
  version: string;
  mode: "development" | "production";
}

/** Resolved per call: tests point USERPROFILE/HOME at a sandbox. */
export function lockPath(): string {
  return path.join(os.homedir(), ".skill-vault", "app.lock");
}

export function readLock(): InstanceLock | null {
  try {
    const l = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as InstanceLock;
    return typeof l?.pid === "number" && typeof l?.port === "number" ? l : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Write the lock unless another live process holds it. True when we own it. */
export function acquireLock(lock: InstanceLock, alive: (pid: number) => boolean = isProcessAlive): boolean {
  const held = readLock();
  if (held && held.pid !== lock.pid && alive(held.pid)) return false;
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
  fs.writeFileSync(lockPath(), JSON.stringify(lock, null, 2) + "\n");
  return true;
}

/** Remove the lock only if `pid` still owns it. */
export function releaseLock(pid: number): void {
  if (readLock()?.pid === pid) fs.rmSync(lockPath(), { force: true });
}

/** The build's git SHA from dist/.build-stamp; "dev" when running from source. */
export function buildVersion(appRoot: string, mode: InstanceLock["mode"]): string {
  if (mode !== "production") return "dev";
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(appRoot, "dist", ".build-stamp"), "utf8"));
    return typeof stamp.git_sha === "string" ? stamp.git_sha : "unknown";
  } catch {
    return "unknown";
  }
}
```

- [ ] **Step 4: Run the lock tests to verify they pass**

Run: `node --import tsx --test server/services/instanceLock.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing health route test**

`app/server/routes/app.test.ts`:

```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import { appRouter, type HealthInfo } from "./app.ts";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function serve(router: express.Router): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise((r) => server.once("listening", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const HEALTH: HealthInfo = { ok: true, pid: 42, port: 9994, version: "abc1234", mode: "production" };

test("GET /api/health returns the server's identity", async () => {
  const base = await serve(appRouter({ health: () => HEALTH }));
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), HEALTH);
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `node --import tsx --test server/routes/app.test.ts`
Expected: FAIL, module `./app.ts` not found.

- [ ] **Step 7: Implement `routes/app.ts`**

```ts
/**
 * App-level endpoints (about the app itself, not the vault):
 *
 *   GET /api/health — who is serving: pid, port, build version, mode.
 *                     scripts/launch.ps1 uses it to reuse a running server;
 *                     the client uses it to spot the new process after an update.
 */
import { Router } from "express";

export interface HealthInfo {
  ok: true;
  pid: number;
  port: number | null;
  version: string;
  mode: "development" | "production";
}

export function appRouter(opts: { health: () => HealthInfo }): Router {
  const router = Router();
  router.get("/health", (_req, res) => {
    res.json(opts.health());
  });
  return router;
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `node --import tsx --test server/routes/app.test.ts`
Expected: PASS.

- [ ] **Step 9: Mount the router in `index.ts`**

Add imports next to the other route and service imports:

```ts
import { appRouter } from "./routes/app.ts";
import { buildVersion } from "./services/instanceLock.ts";
import { getServerPort } from "./services/runtime.ts";
```

Immediately before `app.use("/api/config", configRouter());` add:

```ts
  app.use(
    "/api",
    appRouter({
      health: () => ({
        ok: true,
        pid: process.pid,
        port: getServerPort(),
        version: buildVersion(APP_ROOT, opts.mode),
        mode: opts.mode,
      }),
    }),
  );
```

- [ ] **Step 10: Take and release the lock in `launcher.ts`**

Add imports:

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, buildVersion, readLock, releaseLock } from "./services/instanceLock.ts";
```

After the `const MODE = …;` statement add:

```ts
/** app/ — the same root index.ts computes (this file is server/launcher.ts or dist/launcher.js). */
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
```

In the `app.listen` callback, directly after `setServerPort(effective);`, add:

```ts
    const owned = acquireLock({
      pid: process.pid,
      port: effective,
      started_at: new Date().toISOString(),
      version: buildVersion(APP_ROOT, MODE),
      mode: MODE,
    });
    if (!owned) {
      console.log(`  [lock] another Skill Vault server (pid ${readLock()?.pid}) owns the app lock; this one runs without it.`);
    }
```

In `shutdown`, make `releaseLock(process.pid);` the first statement. After the two `process.on("SIGINT"/"SIGTERM")` registrations add:

```ts
  process.on("exit", () => releaseLock(process.pid));
```

- [ ] **Step 11: Verify against a real server**

Run (bash, from `app/`): start `npm run dev -- --port 9973 --no-open` in the background, then:
```bash
curl -s http://127.0.0.1:9973/api/health; echo
cat "$USERPROFILE/.skill-vault/app.lock"
```
Expected: health JSON with `"ok":true`, this server's `pid`, `"version":"dev"`. The lock file belongs to whichever server started first: if your own dev server was already running, the lock shows its pid and the test server logs `[lock] another Skill Vault server … owns the app lock`. Stop the test server (Ctrl+C or `taskkill /PID <pid> /T /F`) and check that it didn't remove a lock it didn't own.

- [ ] **Step 12: Full suite, typecheck, commit**

Run: `npm test && npm run typecheck` — expected: pass, exit 0.

```bash
git add app/server/services/instanceLock.ts app/server/services/instanceLock.test.ts app/server/routes/app.ts app/server/routes/app.test.ts app/server/index.ts app/server/launcher.ts
git commit -F - <<'EOF'
app: instance lock (~/.skill-vault/app.lock) and GET /api/health

The server records pid/port/version in app.lock when no live process
holds it and clears it only while it still owns it, so the launcher can
reuse a running server instead of starting another.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Rotating log file (`--log-file`)

**Files:**
- Create: `app/server/services/logFile.ts`
- Test: `app/server/services/logFile.test.ts`
- Modify: `app/server/launcher.ts` (parse the flag, install the tee, help text)

**Interfaces:**
- Produces: `LOG_MAX_BYTES = 5 * 1024 * 1024`, `LOG_KEEP = 3`, `rotateLog(file: string, keep: number): void`, `createLogSink(file: string, maxBytes?: number, keep?: number): (chunk: string | Uint8Array) => void`, `installLogFile(file: string): void`; launcher flag `--log-file <path>` / `--log-file=<path>` sets `args.logFile`.

- [ ] **Step 1: Write the failing test**

`app/server/services/logFile.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogSink, rotateLog } from "./logFile.ts";

const tmpLog = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sv-log-")), "logs", "server.log");
const read = (f: string) => fs.readFileSync(f, "utf8");

test("the sink appends, rotating into .1 … .keep before the file would pass maxBytes", () => {
  const file = tmpLog();
  const sink = createLogSink(file, 10, 2);
  sink("aaaaaaaa");
  sink("bbbbbbbb");
  sink("cccccccc");
  sink("dddddddd");
  assert.equal(read(file), "dddddddd");
  assert.equal(read(`${file}.1`), "cccccccc");
  assert.equal(read(`${file}.2`), "bbbbbbbb");
  assert.equal(fs.existsSync(`${file}.3`), false, "only `keep` old files are kept");
});

test("an existing file's size counts toward the limit", () => {
  const file = tmpLog();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "123456789");
  const sink = createLogSink(file, 10, 3);
  sink("xx");
  assert.equal(read(`${file}.1`), "123456789");
  assert.equal(read(file), "xx");
});

test("rotateLog shifts files and drops the oldest", () => {
  const file = tmpLog();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const [f, body] of [[file, "0"], [`${file}.1`, "1"], [`${file}.2`, "2"]] as const) fs.writeFileSync(f, body);
  rotateLog(file, 2);
  assert.equal(fs.existsSync(file), false);
  assert.equal(read(`${file}.1`), "0");
  assert.equal(read(`${file}.2`), "1");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test server/services/logFile.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `logFile.ts`**

```ts
/**
 * --log-file: a server started hidden by scripts/launch.ps1 has no console,
 * so its stdout/stderr are also appended to a file, rotated before it would
 * pass maxBytes into <file>.1 … <file>.<keep>.
 */
import fs from "node:fs";
import path from "node:path";

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_KEEP = 3;

export function rotateLog(file: string, keep: number): void {
  fs.rmSync(`${file}.${keep}`, { force: true });
  for (let i = keep - 1; i >= 1; i--) {
    if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
  }
  if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
}

export function createLogSink(
  file: string,
  maxBytes = LOG_MAX_BYTES,
  keep = LOG_KEEP,
): (chunk: string | Uint8Array) => void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    /* new file */
  }
  return (chunk) => {
    const len = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    try {
      if (size > 0 && size + len > maxBytes) {
        rotateLog(file, keep);
        size = 0;
      }
      fs.appendFileSync(file, chunk);
      size += len;
    } catch {
      /* logging must never take the server down */
    }
  };
}

/** Tee process.stdout and process.stderr into a rotating log file. */
export function installLogFile(file: string): void {
  const sink = createLogSink(file);
  sink(`\n=== ${new Date().toISOString()} pid ${process.pid} ===\n`);
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      sink(chunk);
      return write(chunk, ...rest);
    }) as typeof stream.write;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --import tsx --test server/services/logFile.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire `--log-file` into `launcher.ts`**

Add `import { installLogFile } from "./services/logFile.ts";`.
Add `logFile?: string;` to `ParsedArgs`. In `parseArgs`, before the `--no-open` branch, add:

```ts
    } else if (a === "--log-file") {
      out.logFile = argv[++i];
    } else if (a.startsWith("--log-file=")) {
      out.logFile = a.slice("--log-file=".length);
```

Directly after the `if (args.help) { … }` block add:

```ts
// Before anything else logs, so the whole run lands in the file.
if (args.logFile) installLogFile(args.logFile);
```

Add to `printHelp()`'s option list:

```
        --log-file <path>  Also write all output to <path> (rotated at 5 MB)
```

- [ ] **Step 6: Verify against a real server**

Run (bash, from `app/`):
```bash
node --import tsx server/launcher.ts --port 9973 --no-open --log-file "$TEMP/sv-logtest/server.log" &
sleep 6; head -5 "$TEMP/sv-logtest/server.log"
```
Expected: the file starts with `=== <time> pid <n> ===` followed by the `Skill Vault App — http://…:9973` banner. Stop the server (`taskkill /PID <pid> /T /F`) and delete `$TEMP/sv-logtest`.

- [ ] **Step 7: Full suite, typecheck, commit**

Run: `npm test && npm run typecheck`

```bash
git add app/server/services/logFile.ts app/server/services/logFile.test.ts app/server/launcher.ts
git commit -F - <<'EOF'
launcher: --log-file tees output into a rotating log (5 MB x 3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Stop when idle (`--exit-when-idle`)

**Files:**
- Create: `app/server/services/idleStop.ts`
- Test: `app/server/services/idleStop.test.ts`, `app/server/launcher.idle.test.ts`
- Modify: `app/server/routes/events.ts`, `app/server/services/assistant/session.ts`, `app/server/index.ts`, `app/server/launcher.ts`

**Interfaces:**
- Consumes: lock (Task 2), `dist/public` from a build (Task 1) for the integration test.
- Produces:
  - `sseClientCount(): number` (routes/events.ts)
  - `anyTurnRunning(): boolean` (services/assistant/session.ts)
  - `interface IdleOptions { clients: () => number; isBusy: () => boolean; graceMs: number; bootGraceMs: number; now?: () => number }`
  - `createIdleTracker(opts: IdleOptions): { tick(): boolean }`
  - `startIdleStop(opts: IdleOptions & { onIdle: () => void; tickMs?: number }): { stop(): void }`
  - `app.locals.isBusy: () => boolean` (index.ts). Task 7 extends it.
  - Launcher flag `--exit-when-idle`; env overrides `SKILL_VAULT_IDLE_GRACE_MS`, `SKILL_VAULT_IDLE_BOOT_GRACE_MS`, `SKILL_VAULT_IDLE_TICK_MS` (tests only).

- [ ] **Step 1: Write the failing unit tests**

`app/server/services/idleStop.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createIdleTracker, startIdleStop } from "./idleStop.ts";

test("before any window connects, it waits bootGraceMs", () => {
  let t = 0;
  const tr = createIdleTracker({ clients: () => 0, isBusy: () => false, graceMs: 60, bootGraceMs: 120, now: () => t });
  t = 119;
  assert.equal(tr.tick(), false);
  t = 120;
  assert.equal(tr.tick(), true);
});

test("after a window connected, it stops graceMs after the last one leaves", () => {
  let t = 0;
  let clients = 1;
  const tr = createIdleTracker({ clients: () => clients, isBusy: () => false, graceMs: 60, bootGraceMs: 120, now: () => t });
  assert.equal(tr.tick(), false);
  t = 40;
  assert.equal(tr.tick(), false);
  clients = 0;
  t = 99;
  assert.equal(tr.tick(), false);
  t = 100;
  assert.equal(tr.tick(), true);
});

test("a busy server is never idle, and the clock restarts when the work ends", () => {
  let t = 0;
  let busy = true;
  const tr = createIdleTracker({ clients: () => 0, isBusy: () => busy, graceMs: 60, bootGraceMs: 120, now: () => t });
  t = 500;
  assert.equal(tr.tick(), false);
  busy = false;
  t = 619;
  assert.equal(tr.tick(), false);
  t = 620;
  assert.equal(tr.tick(), true);
});

test("startIdleStop calls onIdle exactly once", async () => {
  let calls = 0;
  const s = startIdleStop({ clients: () => 0, isBusy: () => false, graceMs: 0, bootGraceMs: 0, tickMs: 5, onIdle: () => calls++ });
  await new Promise((r) => setTimeout(r, 40));
  s.stop();
  assert.equal(calls, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test server/services/idleStop.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `idleStop.ts`**

```ts
/**
 * Stop the server when nobody is using it. Only for servers started by
 * scripts/launch.ps1 (`--exit-when-idle`). Idle means no open app window
 * (no SSE client on /api/events) and nothing busy (Notion job, assistant
 * turn, skill update check, app update). Grace: bootGraceMs until the first
 * window connects, then graceMs after the last one disconnects.
 */
export interface IdleOptions {
  clients: () => number;
  isBusy: () => boolean;
  graceMs: number;
  bootGraceMs: number;
  now?: () => number;
}

export function createIdleTracker(opts: IdleOptions): { tick(): boolean } {
  const now = opts.now ?? Date.now;
  let lastActive = now();
  let everConnected = false;
  return {
    /** True once the server has been idle for the applicable grace period. */
    tick(): boolean {
      const clients = opts.clients();
      if (clients > 0) everConnected = true;
      if (clients > 0 || opts.isBusy()) {
        lastActive = now();
        return false;
      }
      return now() - lastActive >= (everConnected ? opts.graceMs : opts.bootGraceMs);
    },
  };
}

export function startIdleStop(opts: IdleOptions & { onIdle: () => void; tickMs?: number }): { stop(): void } {
  const tracker = createIdleTracker(opts);
  const timer = setInterval(() => {
    if (!tracker.tick()) return;
    clearInterval(timer);
    opts.onIdle();
  }, opts.tickMs ?? 5_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --import tsx --test server/services/idleStop.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Expose the client count and the running-turn check**

In `app/server/routes/events.ts`, after `closeAllSse()`, add:

```ts
/** Open /api/events connections — one per open app window or tab. */
export function sseClientCount(): number {
  return clients.size;
}
```

In `app/server/services/assistant/session.ts`, after `abortAllTurns()`, add:

```ts
/** True while any chat turn's CLI process is running. */
export function anyTurnRunning(): boolean {
  loadOnce();
  return [...sessions.values()].some((s) => s.running);
}
```

In `app/server/index.ts`, change `import { abortAllTurns } from "./services/assistant/session.ts";` to `import { abortAllTurns, anyTurnRunning } from "./services/assistant/session.ts";`. Directly after the `app.locals.cleanupLiveUpdates = async () => { … };` block add:

```ts
  // Work that must not be cut off by an idle stop (launcher --exit-when-idle).
  app.locals.isBusy = (): boolean => anyNotionJobRunning() || anyTurnRunning() || foregroundCheckActive();
```

- [ ] **Step 6: Wire `--exit-when-idle` into `launcher.ts`**

Add imports:

```ts
import { sseClientCount } from "./routes/events.ts";
import { startIdleStop } from "./services/idleStop.ts";
```

Add `exitWhenIdle?: boolean;` to `ParsedArgs`, and in `parseArgs` add the branch `} else if (a === "--exit-when-idle") { out.exitWhenIdle = true;`. Add to `printHelp()`:

```
        --exit-when-idle   Stop 60 s after the last app window closes (used by the Start Menu launcher)
```

Above `main()` add:

```ts
/** Positive integer from an env var (tests shorten the idle timers), else the fallback. */
function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return process.env[name] && Number.isFinite(n) && n >= 0 ? n : fallback;
}
```

At the end of `main()`, after the signal handlers, add:

```ts
  if (args.exitWhenIdle) {
    startIdleStop({
      clients: sseClientCount,
      isBusy: () => (app.locals.isBusy as () => boolean)(),
      graceMs: envMs("SKILL_VAULT_IDLE_GRACE_MS", 60_000),
      bootGraceMs: envMs("SKILL_VAULT_IDLE_BOOT_GRACE_MS", 120_000),
      tickMs: envMs("SKILL_VAULT_IDLE_TICK_MS", 5_000),
      onIdle: () => {
        console.log("[idle] no app window for a while; stopping");
        void shutdown();
      },
    });
  }
```

- [ ] **Step 7: Write the integration test**

`app/server/launcher.idle.test.ts`:

```ts
/**
 * Real server process: takes the lock, answers /api/health, keeps running
 * while an app window (SSE client) is open, and exits — removing the lock —
 * once it closes. Runs the launcher from source (tsx) in production mode,
 * so it needs dist/public from `npm run build`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = fs.existsSync(path.join(APP, "dist", "public", "index.html"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test(
  "--exit-when-idle: lock + health while a window is open, clean exit after it closes",
  { skip: built ? false : "run `npm run build` first", timeout: 30_000 },
  async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sv-idle-"));
    const lockFile = path.join(home, ".skill-vault", "app.lock");
    // Absolute file:// URL: `--import tsx` would resolve from the child's cwd.
    const tsx = pathToFileURL(path.join(APP, "node_modules", "tsx", "dist", "loader.mjs")).href;
    const child = spawn(
      process.execPath,
      ["--import", tsx, path.join(APP, "server", "launcher.ts"), "--no-open", "--port", "0", "--host", "127.0.0.1", "--exit-when-idle"],
      {
        cwd: home, // keeps app/.env (a developer's PORT/HOST) out of the test
        env: {
          ...process.env,
          USERPROFILE: home,
          HOME: home,
          NODE_ENV: "production",
          SKILL_VAULT_IDLE_GRACE_MS: "300",
          SKILL_VAULT_IDLE_BOOT_GRACE_MS: "8000",
          SKILL_VAULT_IDLE_TICK_MS: "100",
        },
        stdio: "ignore",
      },
    );
    const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
    try {
      for (let i = 0; i < 100 && !fs.existsSync(lockFile); i++) await sleep(100);
      const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      assert.equal(lock.pid, child.pid);
      const base = `http://127.0.0.1:${lock.port}`;
      const health = await (await fetch(`${base}/api/health`)).json();
      assert.equal(health.pid, child.pid);
      assert.equal(health.mode, "production");

      const window = new AbortController();
      await fetch(`${base}/api/events`, { signal: window.signal });
      await sleep(800);
      assert.equal(child.exitCode, null, "an open window keeps the server alive past the grace period");

      window.abort();
      const code = await Promise.race([exited, sleep(5_000).then(() => "timeout" as const)]);
      assert.equal(code, 0);
      assert.equal(fs.existsSync(lockFile), false, "the lock is removed on exit");
    } finally {
      if (child.exitCode === null) child.kill();
    }
  },
);
```

- [ ] **Step 8: Run the integration test**

Run: `npm run build && node --import tsx --test server/launcher.idle.test.ts`
Expected: PASS within ~5 s. If it fails with a timeout reading the lock, run the same command without `stdio: "ignore"` to see the child's output.

- [ ] **Step 9: Full suite, typecheck, commit**

Run: `npm test && npm run typecheck`

```bash
git add app/server/services/idleStop.ts app/server/services/idleStop.test.ts app/server/launcher.idle.test.ts app/server/routes/events.ts app/server/services/assistant/session.ts app/server/index.ts app/server/launcher.ts
git commit -F - <<'EOF'
launcher: --exit-when-idle stops the server after the last window closes

60 s after the last /api/events client disconnects (120 s if none ever
connected), unless a Notion job, assistant turn or update check is
running. Shuts down through the normal cleanup path, releasing the lock.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: Startup history scan off the request path, then measure

**Files:**
- Modify: `app/server/services/historyRecorder.ts` (scan → generator), `app/server/index.ts` (startup block)
- Test: `app/server/services/historyRecorder.test.ts` (one new test)

**Interfaces:**
- Produces: `scanForUnrecordedChangesAsync(vaultPath: string): Promise<{ recorded: number; deleted: number; gc: number }>`. `scanForUnrecordedChanges` keeps its signature and behavior.

- [ ] **Step 1: Write the failing test**

Append to `app/server/services/historyRecorder.test.ts`, and add `scanForUnrecordedChangesAsync` to its import from `./historyRecorder.ts`:

```ts
test("the async startup scan matches the sync one and yields between skills", async () => {
  write("a", "1");
  write("b", "1");
  write("c", "1");
  let turns = 0;
  let spinning = true;
  const spin = () => {
    if (!spinning) return;
    turns++;
    setImmediate(spin);
  };
  setImmediate(spin);
  const r = await scanForUnrecordedChangesAsync(vault);
  spinning = false;
  assert.equal(r.recorded, 3);
  assert.ok(turns >= 3, `the event loop ran ${turns} times during the scan`);
  assert.equal(scanForUnrecordedChanges(vault).recorded, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test server/services/historyRecorder.test.ts`
Expected: FAIL, `scanForUnrecordedChangesAsync` is not exported.

- [ ] **Step 3: Refactor the scan into steps shared by both variants**

In `app/server/services/historyRecorder.ts`, replace the whole `export function scanForUnrecordedChanges(...) { ... }` with:

```ts
type ScanResult = { recorded: number; deleted: number; gc: number };

/** The startup scan as steps: one per skill, then deletions and gc. */
function* scanSteps(vaultPath: string, out: ScanResult): Generator<void, void, void> {
  const skillsRoot = path.join(vaultPath, "skills");
  const present = fs.existsSync(skillsRoot)
    ? fs.readdirSync(skillsRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".temp-")).map((e) => e.name)
    : [];
  for (const name of present) {
    let hasHistory: boolean;
    try {
      hasHistory = listVersions(vaultPath, name).length > 0;
    } catch (err) {
      // Unreadable versions.json: leave it alone (recordVersion would skip it too).
      console.error(`[history] ${(err as Error).message}`);
      continue;
    }
    const v = recordVersion(vaultPath, name, {
      source: "external-edit",
      note: hasHistory ? "changed while the app was closed" : "baseline",
    });
    if (v) out.recorded++;
    yield;
  }
  const histSkills = path.join(vaultPath, ".history", "skills");
  if (fs.existsSync(histSkills)) {
    for (const name of fs.readdirSync(histSkills)) {
      if (present.includes(name)) continue;
      if (recordDeletionMarker(vaultPath, name, "deleted while the app was closed")) out.deleted++;
    }
  }
  yield;
  out.gc = gcObjects(vaultPath);
}

export function scanForUnrecordedChanges(vaultPath: string): ScanResult {
  const out: ScanResult = { recorded: 0, deleted: 0, gc: 0 };
  const steps = scanSteps(vaultPath, out);
  while (!steps.next().done) {
    /* run every step now */
  }
  return out;
}

/** Same scan, yielding to the event loop between skills so boot-time requests aren't held up. */
export async function scanForUnrecordedChangesAsync(vaultPath: string): Promise<ScanResult> {
  const out: ScanResult = { recorded: 0, deleted: 0, gc: 0 };
  const steps = scanSteps(vaultPath, out);
  while (!steps.next().done) await new Promise<void>((resolve) => setImmediate(resolve));
  return out;
}
```

- [ ] **Step 4: Run the history tests**

Run: `node --import tsx --test server/services/historyRecorder.test.ts`
Expected: PASS (all existing tests plus the new one).

- [ ] **Step 5: Use the async scan at boot**

In `app/server/index.ts`, change the import to `import { createHistoryRecorder, scanForUnrecordedChangesAsync } from "./services/historyRecorder.ts";` and replace the block from `// Startup scan: catch skill edits/deletes made while the app was` through its closing `}` with:

```ts
  // Startup scan: catch skill edits/deletes made while the app was closed
  // (e.g. an agent editing the vault directly, or git pull). Chunked: it
  // yields to the event loop between skills so it never holds up the first
  // page load.
  if (initialCfg.vault_path) {
    scanForUnrecordedChangesAsync(initialCfg.vault_path)
      .then((r) =>
        console.log(`[history] startup scan: ${r.recorded} recorded, ${r.deleted} deletions, ${r.gc} objects collected`),
      )
      .catch((err) => console.error("[history] startup scan failed:", err));
  }
```

- [ ] **Step 6: Measure the built app against the targets**

Run (bash, from `app/`, using your real vault). Stop the server within 40 s of starting it, before the background update sweep starts at 45 s.
```bash
npm run build >/dev/null
s=$(date +%s%3N); (NODE_ENV=production node dist/launcher.js --port 9974 --no-open --host 127.0.0.1 > "$TEMP/sv-measure.log" 2>&1 &)
until grep -q "Skill Vault App" "$TEMP/sv-measure.log" 2>/dev/null; do sleep 0.05; done; echo "listening after $(( $(date +%s%3N) - s )) ms"
curl -s -o /dev/null -w "index %{time_total}\n" http://127.0.0.1:9974/
for u in config assistant/suggestions assistant/status skills activity; do curl -s -o /dev/null -w "$u %{time_total}\n" http://127.0.0.1:9974/api/$u & done; wait
for pid in $(netstat -ano | grep ":9974 .*LISTEN" | awk '{print $5}' | sort -u); do taskkill //PID $pid //T //F; done
```
Expected: listening ≤ ~700 ms; `index` ≤ ~0.1 s (previously ~1 s, while the sync scan blocked it); the slowest of the five API calls ≤ ~1.0 s. Record the numbers for the PR. **Decision gate:** if the slowest API call is still > 1.0 s, stop and report the numbers to the user before continuing. The spec's conditional hash cache would then get its own small plan; do not add it here.

- [ ] **Step 7: Full suite, typecheck, commit**

Run: `npm test && npm run typecheck`

```bash
git add app/server/services/historyRecorder.ts app/server/services/historyRecorder.test.ts app/server/index.ts
git commit -F - <<'EOF'
history: run the startup scan in chunks so it can't block the first page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: App update — status and background check

**Files:**
- Create: `app/server/services/appUpdate.ts`
- Test: `app/server/services/appUpdate.test.ts`

**Interfaces:**
- Produces (Task 7 and the client rely on these exact names):
  - `interface RunResult { code: number; stdout: string; stderr: string }`
  - `type Run = (cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<RunResult>`; `defaultRun: Run`
  - `interface GitFacts { isRepo; hasOrigin; repoRoot: string | null; branch: string | null; current: string | null; latest: string | null; ahead: number; behind: number; dirty: boolean; commits: Array<{ sha: string; subject: string }>; fetchError?: string }`
  - `parseLeftRight(out: string): { ahead: number; behind: number }`, `parseCommits(out: string)`, `readGitFacts(run: Run, appDir: string, opts: { fetch: boolean }): Promise<GitFacts>`
  - `decideCanApply(f: GitFacts, ctx: { mode: "development" | "production"; busy: boolean; applying: boolean }): { can_apply: boolean; reason?: string }`
  - `interface AppUpdateStatus { supported: boolean; branch: string | null; current: string | null; latest: string | null; behind: number; ahead: number; dirty: boolean; commits: Array<{ sha: string; subject: string }>; checked_at: string | null; can_apply: boolean; reason?: string; last_error?: string; applying: boolean }`
  - `interface AppUpdaterDeps { appDir: string; mode: "development" | "production"; isBusy: () => boolean; restart: () => void; run?: Run; now?: () => string; firstRunDelayMs?: number; intervalMs?: number }`
  - `interface AppUpdater { status(): AppUpdateStatus; check(): Promise<AppUpdateStatus>; isApplying(): boolean; start(): void; stop(): void }` (Task 7 adds `apply`)
  - `createAppUpdater(deps: AppUpdaterDeps): AppUpdater`

- [ ] **Step 1: Write the failing tests**

`app/server/services/appUpdate.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAppUpdater,
  decideCanApply,
  parseCommits,
  parseLeftRight,
  type GitFacts,
  type Run,
  type RunResult,
} from "./appUpdate.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

/** git answers for a clean main checkout two commits behind origin/main. */
const BEHIND: Record<string, Partial<RunResult>> = {
  "git rev-parse --show-toplevel": { stdout: "/repo\n" },
  "git remote get-url origin": { stdout: "https://github.com/owner/skill-vault.git\n" },
  "git fetch origin --quiet": {},
  "git rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
  "git rev-parse HEAD": { stdout: `${A}\n` },
  "git rev-parse origin/main": { stdout: `${B}\n` },
  "git rev-list --left-right --count HEAD...origin/main": { stdout: "0\t2\n" },
  "git status --porcelain": { stdout: "" },
  "git log --format=%h%x09%s HEAD..origin/main": { stdout: "bbbbbbb\tSecond change\nccccccc\tFirst change\n" },
};

/** Listed commands exit 0 with the given output; anything else exits 1. */
function fakeRun(responses: Record<string, Partial<RunResult>>): { run: Run; calls: string[] } {
  const calls: string[] = [];
  const run: Run = async (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    const r = responses[key];
    return r ? { code: 0, stdout: "", stderr: "", ...r } : { code: 1, stdout: "", stderr: `unexpected: ${key}` };
  };
  return { run, calls };
}

type Ctx = Parameters<typeof decideCanApply>[1];
const CTX: Ctx = { mode: "production", busy: false, applying: false };
const facts = (over: Partial<GitFacts> = {}): GitFacts => ({
  isRepo: true,
  hasOrigin: true,
  repoRoot: "/repo",
  branch: "main",
  current: A,
  latest: B,
  ahead: 0,
  behind: 2,
  dirty: false,
  commits: [],
  ...over,
});
const updater = (run: Run, extra: Partial<Parameters<typeof createAppUpdater>[0]> = {}) =>
  createAppUpdater({ appDir: "/repo/app", mode: "production", isBusy: () => false, restart() {}, run, ...extra });

test("parseLeftRight and parseCommits read git's output", () => {
  assert.deepEqual(parseLeftRight("1\t3\n"), { ahead: 1, behind: 3 });
  assert.deepEqual(parseLeftRight(""), { ahead: 0, behind: 0 });
  assert.deepEqual(parseCommits("abc1234\tFix the thing\ndef5678\tKeep\ttabs\n"), [
    { sha: "abc1234", subject: "Fix the thing" },
    { sha: "def5678", subject: "Keep\ttabs" },
  ]);
});

test("decideCanApply allows a clean main checkout that is behind", () => {
  assert.deepEqual(decideCanApply(facts(), CTX), { can_apply: true });
});

test("decideCanApply refuses, with a reason, for each blocking state", () => {
  const cases: Array<[Partial<GitFacts>, Partial<Ctx>, RegExp]> = [
    [{ isRepo: false }, {}, /isn't a git checkout/],
    [{ hasOrigin: false }, {}, /no origin remote/],
    [{}, { mode: "development" }, /running from source/],
    [{ branch: "feature" }, {}, /on branch "feature"/],
    [{ dirty: true }, {}, /uncommitted changes/],
    [{ ahead: 1 }, {}, /1 local commit isn't on GitHub/],
    [{ ahead: 2 }, {}, /2 local commits aren't on GitHub/],
    [{ behind: 0 }, {}, /already up to date/],
    [{}, { applying: true }, /already running/],
    [{}, { busy: true }, /a job is running/],
  ];
  for (const [f, c, re] of cases) {
    const d = decideCanApply(facts(f), { ...CTX, ...c });
    assert.equal(d.can_apply, false, String(re));
    assert.match(d.reason ?? "", re);
  }
});

test("before the first check, status says so", () => {
  const s = updater(fakeRun({}).run).status();
  assert.equal(s.supported, false);
  assert.equal(s.checked_at, null);
  assert.equal(s.reason, "not checked yet");
});

test("check() fetches, then reports what's new on main", async () => {
  const { run, calls } = fakeRun(BEHIND);
  const s = await updater(run, { now: () => "2026-10-27T12:00:00.000Z" }).check();
  assert.ok(calls.includes("git fetch origin --quiet"));
  assert.equal(s.supported, true);
  assert.equal(s.behind, 2);
  assert.equal(s.current, "aaaaaaa");
  assert.equal(s.latest, "bbbbbbb");
  assert.deepEqual(s.commits.map((c) => c.subject), ["Second change", "First change"]);
  assert.equal(s.checked_at, "2026-10-27T12:00:00.000Z");
  assert.equal(s.can_apply, true);
});

test("a folder that isn't a git checkout is unsupported", async () => {
  const s = await updater(fakeRun({}).run).check();
  assert.equal(s.supported, false);
  assert.match(s.reason ?? "", /isn't a git checkout/);
});

test("a failed fetch is reported, and the last known origin/main still counts", async () => {
  const { run } = fakeRun({ ...BEHIND, "git fetch origin --quiet": { code: 128, stderr: "fatal: unable to access" } });
  const s = await updater(run).check();
  assert.equal(s.behind, 2);
  assert.match(s.last_error ?? "", /unable to access/);
});

test("the scheduled check waits while a job is running", async () => {
  let busy = true;
  const { run, calls } = fakeRun(BEHIND);
  const u = updater(run, { isBusy: () => busy, firstRunDelayMs: 5, intervalMs: 20 });
  u.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, 0);
  busy = false;
  await new Promise((r) => setTimeout(r, 50));
  u.stop();
  assert.ok(calls.includes("git fetch origin --quiet"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test server/services/appUpdate.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the check side of `appUpdate.ts`**

```ts
/**
 * In-app updates for a git-cloned install (design: docs/superpowers/specs/
 * 2026-10-27-install-and-launch-design.md §5).
 *
 * Check: `git fetch origin` 30 s after start and every 6 h, then compare
 * HEAD with origin/main. Apply (below): pull --ff-only → `npm ci` only when
 * package-lock.json changed → build into dist-next/ and swap it into dist/
 * → hand over to a fresh server (deps.restart). Any failure before the
 * hand-over resets the checkout to the old commit (safe: a clean tree is
 * required) and the running server keeps serving its build.
 *
 * Every command goes through an injectable Run, so tests never touch git or npm.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Run = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<RunResult>;

/** Real runner. `npm` is a .cmd shim on Windows, which spawn can only start through cmd.exe. */
export const defaultRun: Run = (cmd, args, opts) =>
  new Promise((resolve) => {
    const viaCmd = cmd === "npm" && process.platform === "win32";
    const file = viaCmd ? process.env.ComSpec || "cmd.exe" : cmd;
    const argv = viaCmd ? ["/d", "/s", "/c", "npm", ...args] : args;
    const child = spawn(file, argv, { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 120_000);
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

export interface GitFacts {
  isRepo: boolean;
  hasOrigin: boolean;
  repoRoot: string | null;
  branch: string | null;
  current: string | null;
  latest: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  commits: Array<{ sha: string; subject: string }>;
  fetchError?: string;
}

const NO_FACTS: GitFacts = {
  isRepo: false,
  hasOrigin: false,
  repoRoot: null,
  branch: null,
  current: null,
  latest: null,
  ahead: 0,
  behind: 0,
  dirty: false,
  commits: [],
};

export function parseLeftRight(out: string): { ahead: number; behind: number } {
  const [a, b] = out.trim().split(/\s+/).map(Number);
  return { ahead: Number.isFinite(a) ? a : 0, behind: Number.isFinite(b) ? b : 0 };
}

export function parseCommits(out: string): Array<{ sha: string; subject: string }> {
  return out
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .map((l) => {
      const tab = l.indexOf("\t");
      return tab < 0 ? { sha: l, subject: "" } : { sha: l.slice(0, tab), subject: l.slice(tab + 1) };
    });
}

export async function readGitFacts(run: Run, appDir: string, opts: { fetch: boolean }): Promise<GitFacts> {
  const git = (...args: string[]) => run("git", args, { cwd: appDir, timeoutMs: 60_000 });
  const top = await git("rev-parse", "--show-toplevel");
  if (top.code !== 0) return NO_FACTS;
  const repoRoot = top.stdout.trim();
  if ((await git("remote", "get-url", "origin")).code !== 0) return { ...NO_FACTS, isRepo: true, repoRoot };
  let fetchError: string | undefined;
  if (opts.fetch) {
    const f = await git("fetch", "origin", "--quiet");
    if (f.code !== 0) fetchError = f.stderr.trim() || "git fetch failed";
  }
  const branch = (await git("rev-parse", "--abbrev-ref", "HEAD")).stdout.trim() || null;
  const current = (await git("rev-parse", "HEAD")).stdout.trim() || null;
  const latest = await git("rev-parse", "origin/main");
  const counts = parseLeftRight((await git("rev-list", "--left-right", "--count", "HEAD...origin/main")).stdout);
  const dirty = (await git("status", "--porcelain")).stdout.trim().length > 0;
  const commits = parseCommits((await git("log", "--format=%h%x09%s", "HEAD..origin/main")).stdout);
  return {
    isRepo: true,
    hasOrigin: true,
    repoRoot,
    branch,
    current,
    latest: latest.code === 0 ? latest.stdout.trim() : null,
    ...counts,
    dirty,
    commits,
    ...(fetchError ? { fetchError } : {}),
  };
}

export function decideCanApply(
  f: GitFacts,
  ctx: { mode: "development" | "production"; busy: boolean; applying: boolean },
): { can_apply: boolean; reason?: string } {
  const no = (reason: string) => ({ can_apply: false, reason });
  if (!f.isRepo) return no("this copy isn't a git checkout");
  if (!f.hasOrigin) return no("the checkout has no origin remote");
  if (ctx.mode !== "production") return no("running from source (npm run dev); pull and restart yourself");
  if (f.branch !== "main") return no(`on branch "${f.branch}", not main`);
  if (f.dirty) return no("the checkout has uncommitted changes");
  if (f.ahead > 0) return no(`${f.ahead} local commit${f.ahead === 1 ? " isn't" : "s aren't"} on GitHub`);
  if (f.behind === 0) return no("already up to date");
  if (ctx.applying) return no("an update is already running");
  if (ctx.busy) return no("a job is running; try again when it finishes");
  return { can_apply: true };
}

export interface AppUpdateStatus {
  supported: boolean;
  branch: string | null;
  current: string | null;
  latest: string | null;
  behind: number;
  ahead: number;
  dirty: boolean;
  commits: Array<{ sha: string; subject: string }>;
  checked_at: string | null;
  can_apply: boolean;
  reason?: string;
  last_error?: string;
  applying: boolean;
}

export interface AppUpdaterDeps {
  appDir: string;
  mode: "development" | "production";
  isBusy: () => boolean;
  /** Start the new build and stop this process (launcher.ts). */
  restart: () => void;
  run?: Run;
  now?: () => string;
  firstRunDelayMs?: number;
  intervalMs?: number;
}

export interface AppUpdater {
  status(): AppUpdateStatus;
  check(): Promise<AppUpdateStatus>;
  isApplying(): boolean;
  start(): void;
  stop(): void;
}

const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const short = (sha: string | null) => (sha ? sha.slice(0, 7) : null);

export function createAppUpdater(deps: AppUpdaterDeps): AppUpdater {
  const run = deps.run ?? defaultRun;
  const now = deps.now ?? (() => new Date().toISOString());
  let facts: GitFacts | null = null;
  let checkedAt: string | null = null;
  let checkError: string | undefined;
  let applyError: string | undefined;
  let applying = false;
  let inFlight: Promise<AppUpdateStatus> | null = null;
  const timers: NodeJS.Timeout[] = [];

  function status(): AppUpdateStatus {
    if (!facts) {
      return {
        supported: false,
        branch: null,
        current: null,
        latest: null,
        behind: 0,
        ahead: 0,
        dirty: false,
        commits: [],
        checked_at: null,
        can_apply: false,
        reason: "not checked yet",
        ...(checkError ? { last_error: checkError } : {}),
        applying,
      };
    }
    const error = applyError ?? checkError ?? facts.fetchError;
    return {
      supported: facts.isRepo && facts.hasOrigin,
      branch: facts.branch,
      current: short(facts.current),
      latest: short(facts.latest),
      behind: facts.behind,
      ahead: facts.ahead,
      dirty: facts.dirty,
      commits: facts.commits,
      checked_at: checkedAt,
      ...decideCanApply(facts, { mode: deps.mode, busy: deps.isBusy(), applying }),
      ...(error ? { last_error: error } : {}),
      applying,
    };
  }

  function check(): Promise<AppUpdateStatus> {
    if (!inFlight) {
      inFlight = readGitFacts(run, deps.appDir, { fetch: true })
        .then((f) => {
          facts = f;
          checkedAt = now();
          checkError = undefined;
          return status();
        })
        .catch((err) => {
          checkError = `update check failed: ${(err as Error).message}`;
          return status();
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  const tick = () => {
    if (!applying && !deps.isBusy()) void check();
  };

  return {
    status,
    check,
    isApplying: () => applying,
    start() {
      const first = setTimeout(tick, deps.firstRunDelayMs ?? FIRST_CHECK_DELAY_MS);
      const every = setInterval(tick, deps.intervalMs ?? CHECK_INTERVAL_MS);
      first.unref?.();
      every.unref?.();
      timers.push(first, every);
    },
    stop() {
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
    },
  };
}
```

(`fs`, `path` and `applyError` are used by Task 7's additions to this file. Leave them in place.)

- [ ] **Step 4: Run to verify it passes**

Run: `node --import tsx --test server/services/appUpdate.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Full suite, typecheck, commit**

Run: `npm test && npm run typecheck`

```bash
git add app/server/services/appUpdate.ts app/server/services/appUpdate.test.ts
git commit -F - <<'EOF'
app update: git-based status and background check

Fetches origin 30 s after start and every 6 h (skipping while busy),
compares HEAD with origin/main, and explains why an update can't apply
(not main, local edits, local commits, running from source, busy).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 7: App update — apply, restart, routes, `--strict-port`

**Files:**
- Modify: `app/server/services/appUpdate.ts` (apply + `swapDist`), `app/server/routes/app.ts` (update routes), `app/server/index.ts` (updater wiring, `restart` option, `isBusy`), `app/server/launcher.ts` (`--strict-port`, restart, `main()` restructure)
- Test: `app/server/services/appUpdate.test.ts` (apply tests), `app/server/routes/app.test.ts` (replace)

**Interfaces:**
- Consumes: Task 6 names; `scripts/build.mjs --out` (Task 1); lock and flags (Tasks 2–4).
- Produces:
  - `interface ApplyEvent { step: "check" | "pull" | "install" | "build" | "restart"; state: "start" | "done" | "skip" | "error"; message?: string }`
  - `AppUpdater.apply(onEvent: (e: ApplyEvent) => void): Promise<boolean>`
  - `swapDist(appDir: string): void`
  - `appRouter(opts: { health: () => HealthInfo; updater: AppUpdater }): Router` with `GET /api/app/update`, `POST /api/app/update/check`, `POST /api/app/update` (NDJSON, one `ApplyEvent` per line)
  - `CreateAppOptions.restart?: () => void`
  - Launcher flag `--strict-port`

- [ ] **Step 1: Write the failing apply tests**

Add to the imports at the top of `app/server/services/appUpdate.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { swapDist, type ApplyEvent } from "./appUpdate.ts";
```

Append:

```ts
const LOCK_DIFF = `git diff --name-only ${A} HEAD -- app/package-lock.json`;
const BUILD = "node scripts/build.mjs --out dist-next";
const NPM_CI = "npm ci --include=dev --no-audit --no-fund";

/** A temp repo root with app/dist/old.txt; the fake build writes app/dist-next/new.txt. */
function applyHarness(over: Record<string, Partial<RunResult>> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-upd-"));
  const appDir = path.join(root, "app");
  fs.mkdirSync(path.join(appDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "dist", "old.txt"), "old");
  const responses: Record<string, Partial<RunResult>> = {
    ...BEHIND,
    "git rev-parse --show-toplevel": { stdout: `${root}\n` },
    "git pull --ff-only origin main": {},
    [LOCK_DIFF]: { stdout: "" },
    [`git reset --hard ${A}`]: {},
    [NPM_CI]: {},
    ...over,
  };
  const calls: string[] = [];
  const nodeEnvs: Array<string | undefined> = [];
  const run: Run = async (cmd, args, opts) => {
    const key = [cmd === process.execPath ? "node" : cmd, ...args].join(" ");
    calls.push(key);
    if (cmd === "npm" || cmd === process.execPath) nodeEnvs.push(opts.env?.NODE_ENV);
    if (key === BUILD && !(BUILD in over)) {
      fs.mkdirSync(path.join(opts.cwd, "dist-next"), { recursive: true });
      fs.writeFileSync(path.join(opts.cwd, "dist-next", "new.txt"), "new");
      return { code: 0, stdout: "", stderr: "" };
    }
    const r = responses[key];
    return r ? { code: 0, stdout: "", stderr: "", ...r } : { code: 1, stdout: "", stderr: `unexpected: ${key}` };
  };
  let restarts = 0;
  const u = createAppUpdater({ appDir, mode: "production", isBusy: () => false, restart: () => void restarts++, run });
  return { appDir, calls, nodeEnvs, updater: u, restarts: () => restarts };
}

const steps = (events: ApplyEvent[]) => events.map((e) => `${e.step}:${e.state}`);

test("apply: pull → skip install → staged build → swap → restart", async () => {
  const h = applyHarness();
  const events: ApplyEvent[] = [];
  assert.equal(await h.updater.apply((e) => events.push(e)), true);
  assert.deepEqual(steps(events), ["pull:start", "pull:done", "install:skip", "build:start", "build:done", "restart:start"]);
  assert.ok(!h.calls.includes(NPM_CI));
  assert.deepEqual(fs.readdirSync(path.join(h.appDir, "dist")), ["new.txt"]);
  assert.equal(fs.existsSync(path.join(h.appDir, "dist-next")), false);
  assert.equal(h.restarts(), 1);
  assert.equal(h.updater.isApplying(), true, "stays applying until the process hands over");
});

test("apply reinstalls packages only when package-lock.json changed, without NODE_ENV", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const h = applyHarness({ [LOCK_DIFF]: { stdout: "app/package-lock.json\n" } });
    assert.equal(await h.updater.apply(() => {}), true);
    assert.ok(h.calls.includes(NPM_CI));
    assert.deepEqual(h.nodeEnvs, [undefined, undefined], "npm ci and the build never see NODE_ENV");
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
});

test("a failed build resets the checkout and keeps the current build", async () => {
  const h = applyHarness({ [BUILD]: { code: 1, stderr: "vite: boom" } });
  const events: ApplyEvent[] = [];
  assert.equal(await h.updater.apply((e) => events.push(e)), false);
  assert.deepEqual(events.at(-1), { step: "build", state: "error", message: "vite: boom" });
  assert.ok(h.calls.includes(`git reset --hard ${A}`));
  assert.deepEqual(fs.readdirSync(path.join(h.appDir, "dist")), ["old.txt"]);
  assert.equal(h.restarts(), 0);
  assert.equal(h.updater.isApplying(), false);
  assert.match(h.updater.status().last_error ?? "", /^build failed: vite: boom/);
});

test("a failed pull resets without building", async () => {
  const h = applyHarness({ "git pull --ff-only origin main": { code: 1, stderr: "fatal: Not possible to fast-forward" } });
  assert.equal(await h.updater.apply(() => {}), false);
  assert.ok(!h.calls.includes(BUILD));
  assert.ok(h.calls.includes(`git reset --hard ${A}`));
});

test("a failed reinstall resets and reinstalls the old packages", async () => {
  const h = applyHarness({ [LOCK_DIFF]: { stdout: "app/package-lock.json\n" }, [NPM_CI]: { code: 1, stderr: "EPERM" } });
  assert.equal(await h.updater.apply(() => {}), false);
  assert.ok(h.calls.includes(`git reset --hard ${A}`));
  assert.equal(h.calls.filter((c) => c === NPM_CI).length, 2, "tried once, then restored the old lockfile's packages");
});

test("apply refuses, with the reason, when the checkout can't be updated", async () => {
  const h = applyHarness({ "git status --porcelain": { stdout: " M app/server/index.ts\n" } });
  const events: ApplyEvent[] = [];
  assert.equal(await h.updater.apply((e) => events.push(e)), false);
  assert.deepEqual(events, [{ step: "check", state: "error", message: "the checkout has uncommitted changes" }]);
  assert.ok(!h.calls.includes("git pull --ff-only origin main"));
});

test("swapDist replaces dist/ with dist-next/", () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-swap-"));
  fs.mkdirSync(path.join(appDir, "dist"));
  fs.writeFileSync(path.join(appDir, "dist", "old.txt"), "old");
  fs.mkdirSync(path.join(appDir, "dist-next"));
  fs.writeFileSync(path.join(appDir, "dist-next", "new.txt"), "new");
  swapDist(appDir);
  assert.deepEqual(fs.readdirSync(path.join(appDir, "dist")), ["new.txt"]);
  assert.equal(fs.existsSync(path.join(appDir, "dist-next")), false);
  assert.equal(fs.existsSync(path.join(appDir, "dist-old")), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test server/services/appUpdate.test.ts`
Expected: FAIL, `swapDist` is not exported and `apply` is not a function.

- [ ] **Step 3: Implement apply and `swapDist`**

In `appUpdate.ts`, add after the `AppUpdateStatus` interface:

```ts
export interface ApplyEvent {
  step: "check" | "pull" | "install" | "build" | "restart";
  state: "start" | "done" | "skip" | "error";
  message?: string;
}

/**
 * Replace dist/ with the staged dist-next/. Windows can refuse to rename a
 * folder holding an open file; then copy over it instead.
 */
export function swapDist(appDir: string): void {
  const dist = path.join(appDir, "dist");
  const next = path.join(appDir, "dist-next");
  const old = path.join(appDir, "dist-old");
  fs.rmSync(old, { recursive: true, force: true });
  try {
    if (fs.existsSync(dist)) fs.renameSync(dist, old);
  } catch {
    fs.cpSync(next, dist, { recursive: true, force: true });
    fs.rmSync(next, { recursive: true, force: true });
    return;
  }
  try {
    fs.renameSync(next, dist);
  } catch (err) {
    if (fs.existsSync(old) && !fs.existsSync(dist)) fs.renameSync(old, dist);
    throw err;
  }
  fs.rmSync(old, { recursive: true, force: true });
}

/** The environment for npm ci and the build: dev dependencies must be installed and usable. */
function buildEnv(): NodeJS.ProcessEnv {
  const { NODE_ENV: _drop, ...rest } = process.env;
  return rest;
}
```

Add `apply(onEvent: (e: ApplyEvent) => void): Promise<boolean>;` to the `AppUpdater` interface. Inside `createAppUpdater`, before `return {`, add:

```ts
  async function apply(onEvent: (e: ApplyEvent) => void): Promise<boolean> {
    const f = await readGitFacts(run, deps.appDir, { fetch: true });
    facts = f;
    checkedAt = now();
    const decision = decideCanApply(f, { mode: deps.mode, busy: deps.isBusy(), applying });
    if (!decision.can_apply || !f.repoRoot || !f.current) {
      onEvent({ step: "check", state: "error", message: decision.reason ?? "can't read the checkout" });
      return false;
    }
    applying = true;
    applyError = undefined;
    const repo = f.repoRoot;
    const oldSha = f.current;
    const env = buildEnv();
    const npmCi = () =>
      run("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], { cwd: deps.appDir, env, timeoutMs: 600_000 });
    const must = async (r: Promise<RunResult>): Promise<RunResult> => {
      const out = await r;
      if (out.code !== 0) {
        const tail = (out.stderr || out.stdout).trim().split("\n").slice(-3).join(" ");
        throw new Error(tail || `exited with code ${out.code}`);
      }
      return out;
    };
    let step: ApplyEvent["step"] = "pull";
    let reinstalled = false;
    try {
      onEvent({ step, state: "start" });
      await must(run("git", ["pull", "--ff-only", "origin", "main"], { cwd: repo, timeoutMs: 120_000 }));
      onEvent({ step, state: "done" });

      step = "install";
      const lockRel = path.relative(repo, path.join(deps.appDir, "package-lock.json")).split(path.sep).join("/");
      const changed = await must(run("git", ["diff", "--name-only", oldSha, "HEAD", "--", lockRel], { cwd: repo }));
      if (changed.stdout.trim()) {
        onEvent({ step, state: "start" });
        reinstalled = true;
        await must(npmCi());
        onEvent({ step, state: "done" });
      } else {
        onEvent({ step, state: "skip", message: "packages unchanged" });
      }

      step = "build";
      onEvent({ step, state: "start" });
      await must(run(process.execPath, ["scripts/build.mjs", "--out", "dist-next"], { cwd: deps.appDir, env, timeoutMs: 600_000 }));
      swapDist(deps.appDir);
      onEvent({ step, state: "done" });
    } catch (err) {
      const message = (err as Error).message;
      applyError = `${step} failed: ${message}`;
      onEvent({ step, state: "error", message });
      await run("git", ["reset", "--hard", oldSha], { cwd: repo });
      if (reinstalled) await npmCi();
      fs.rmSync(path.join(deps.appDir, "dist-next"), { recursive: true, force: true });
      applying = false;
      return false;
    }
    // Code and build now match the new commit, so a hand-over failure is
    // not rolled back: the next launch starts the new build.
    onEvent({ step: "restart", state: "start" });
    deps.restart();
    return true;
  }
```

Add `apply,` to the returned object.

- [ ] **Step 4: Run to verify it passes**

Run: `node --import tsx --test server/services/appUpdate.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 5: Replace the route tests**

Replace the whole of `app/server/routes/app.test.ts` with:

```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import { appRouter, type HealthInfo } from "./app.ts";
import type { AppUpdateStatus, AppUpdater } from "../services/appUpdate.ts";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function serve(router: express.Router): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise((r) => server.once("listening", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const HEALTH: HealthInfo = { ok: true, pid: 42, port: 9994, version: "abc1234", mode: "production" };
const STATUS: AppUpdateStatus = {
  supported: true,
  branch: "main",
  current: "aaaaaaa",
  latest: "bbbbbbb",
  behind: 1,
  ahead: 0,
  dirty: false,
  commits: [{ sha: "bbbbbbb", subject: "New thing" }],
  checked_at: "2026-10-27T12:00:00.000Z",
  can_apply: true,
  applying: false,
};
const stubUpdater = (): AppUpdater => ({
  status: () => STATUS,
  check: async () => ({ ...STATUS, checked_at: "2026-10-27T13:00:00.000Z" }),
  isApplying: () => false,
  start() {},
  stop() {},
  apply: async (onEvent) => {
    onEvent({ step: "pull", state: "start" });
    onEvent({ step: "pull", state: "done" });
    onEvent({ step: "restart", state: "start" });
    return true;
  },
});

test("GET /api/health returns the server's identity", async () => {
  const base = await serve(appRouter({ health: () => HEALTH, updater: stubUpdater() }));
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), HEALTH);
});

test("GET /api/app/update returns the status; POST /check re-checks", async () => {
  const base = await serve(appRouter({ health: () => HEALTH, updater: stubUpdater() }));
  assert.deepEqual(await (await fetch(`${base}/api/app/update`)).json(), STATUS);
  const checked = await (await fetch(`${base}/api/app/update/check`, { method: "POST" })).json();
  assert.equal(checked.checked_at, "2026-10-27T13:00:00.000Z");
});

test("POST /api/app/update streams one JSON event per line", async () => {
  const base = await serve(appRouter({ health: () => HEALTH, updater: stubUpdater() }));
  const res = await fetch(`${base}/api/app/update`, { method: "POST" });
  assert.match(res.headers.get("content-type") ?? "", /application\/x-ndjson/);
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((e) => `${e.step}:${e.state}`), ["pull:start", "pull:done", "restart:start"]);
});
```

- [ ] **Step 6: Add the update routes**

Replace `app/server/routes/app.ts` with:

```ts
/**
 * App-level endpoints (about the app itself, not the vault):
 *
 *   GET  /api/health           — who is serving: pid, port, build version, mode.
 *                                scripts/launch.ps1 uses it to reuse a running
 *                                server; the client uses it to spot the new
 *                                process after an update.
 *   GET  /api/app/update       — update status (services/appUpdate.ts)
 *   POST /api/app/update/check — fetch now and return the fresh status
 *   POST /api/app/update       — apply; streams NDJSON ApplyEvents, ending
 *                                with {step:"restart"} on success
 */
import { Router } from "express";
import type { AppUpdater } from "../services/appUpdate.ts";

export interface HealthInfo {
  ok: true;
  pid: number;
  port: number | null;
  version: string;
  mode: "development" | "production";
}

export function appRouter(opts: { health: () => HealthInfo; updater: AppUpdater }): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json(opts.health());
  });

  router.get("/app/update", (_req, res) => {
    res.json(opts.updater.status());
  });

  router.post("/app/update/check", async (_req, res) => {
    res.json(await opts.updater.check());
  });

  router.post("/app/update", async (_req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    await opts.updater.apply((e) => res.write(`${JSON.stringify(e)}\n`));
    res.end();
  });

  return router;
}
```

- [ ] **Step 7: Run the route tests**

Run: `node --import tsx --test server/routes/app.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Wire the updater into `index.ts`**

Add the import `import { createAppUpdater } from "./services/appUpdate.ts";`. In `CreateAppOptions`, add:

```ts
  /** Start the new build and stop this process; set by launcher.ts (used after an in-app update). */
  restart?: () => void;
```

Before the `app.locals.cleanupLiveUpdates = async ...` block, add:

```ts
  // In-app updates (git checkout installs): background check + one-click apply.
  const busyWithoutUpdate = (): boolean => anyNotionJobRunning() || anyTurnRunning() || foregroundCheckActive();
  const updater = createAppUpdater({
    appDir: APP_ROOT,
    mode: opts.mode,
    isBusy: busyWithoutUpdate,
    restart: opts.restart ?? (() => console.error("[update] no restart hook; restart the app to finish the update")),
  });
  updater.start();
```

In `cleanupLiveUpdates`, after `updateSweeper.stop();`, add `updater.stop();`. Replace the `app.locals.isBusy = …` line from Task 4 with:

```ts
  // Work that must not be cut off by an idle stop (launcher --exit-when-idle).
  app.locals.isBusy = (): boolean => busyWithoutUpdate() || updater.isApplying();
```

In the `appRouter({ health: … })` call from Task 2, add `updater,` after the `health` property.

- [ ] **Step 9: `--strict-port` and restart in `launcher.ts`**

Add imports:

```ts
import type { Server } from "node:http";
import { spawn } from "node:child_process";
import { getServerPort, setServerPort } from "./services/runtime.ts";
```

(`setServerPort` is already imported, so merge it into this line.)

Add `strictPort?: boolean;` to `ParsedArgs`, the branch `} else if (a === "--strict-port") { out.strictPort = true;` to `parseArgs`, and this help line:

```
        --strict-port      Use exactly --port; wait up to 10 s for it, else exit
```

Replace the `findFreePort` function with:

```ts
async function isPortFree(p: number, host: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(p, host);
  });
}

async function findFreePort(start: number, host: string): Promise<number> {
  // Try up to 10 ports starting at `start`. Returns 0 on exhaustion so
  // the caller can fall back to OS-assigned ports instead of crashing
  // on a fresh machine where 9994 happens to be taken.
  for (let p = start; p < start + 10; p++) {
    if (await isPortFree(p, host)) return p;
  }
  return 0;
}

/** --strict-port: wait for exactly this port (the previous server releasing it after an update). */
async function waitForPortFree(p: number, host: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isPortFree(p, host)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}
```

Replace the whole `async function main(): Promise<void> { … }` with this version, which keeps the Task 2–4 behavior:

```ts
async function main(): Promise<void> {
  const preferredPort = resolvePort();
  const host = resolveHost();
  const shouldOpen = resolveOpenBrowser();

  let port: number;
  if (args.strictPort) {
    // Restart after an in-app update: the open window points at this exact
    // port, so wait for the old server to let go of it instead of moving on.
    if (!(await waitForPortFree(preferredPort, host, 10_000))) {
      console.error(`[skill-vault-app] port ${preferredPort} is still in use; giving up`);
      process.exit(1);
    }
    port = preferredPort;
  } else {
    port = await findFreePort(preferredPort, host);
  }

  let server: Server | undefined;
  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    releaseLock(process.pid);
    // Run the live-updates cleanup BEFORE closing the HTTP server so
    // chokidar and the SSE client set tear down while the event loop
    // still has them. createApp() hangs the cleanup off app.locals so
    // tests can exercise it without booting a real port.
    try {
      const cleanup = (app as unknown as { locals: { cleanupLiveUpdates?: () => Promise<void> } }).locals
        .cleanupLiveUpdates;
      if (cleanup) await cleanup();
    } catch (err) {
      console.error("[shutdown] cleanupLiveUpdates threw:", err);
    }
    if (server) server.close(() => process.exit(0));
    else process.exit(0);
    // Safety net: if a stray socket keeps the server open past 3s, exit anyway.
    setTimeout(() => process.exit(0), 3000).unref();
  }

  /** After an in-app update: start the new build on this same port, then hand over. */
  function restart(): void {
    releaseLock(process.pid);
    const next = [
      path.join(APP_ROOT, "dist", "launcher.js"),
      "--no-open",
      "--port",
      String(getServerPort() ?? port),
      "--host",
      host,
      "--strict-port",
    ];
    if (args.exitWhenIdle) next.push("--exit-when-idle");
    if (args.logFile) next.push("--log-file", args.logFile);
    spawn(process.execPath, next, {
      cwd: APP_ROOT,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, NODE_ENV: "production" },
    }).unref();
    setTimeout(() => void shutdown(), 500);
  }

  const app = await createApp({ mode: MODE, restart });

  server = app.listen(port, host, () => {
    const effective = port || (server?.address() as { port: number } | null)?.port || preferredPort;
    // The assistant's MCP bridge needs the *bound* port, not the preferred one.
    setServerPort(effective);
    const owned = acquireLock({
      pid: process.pid,
      port: effective,
      started_at: new Date().toISOString(),
      version: buildVersion(APP_ROOT, MODE),
      mode: MODE,
    });
    if (!owned) {
      console.log(`  [lock] another Skill Vault server (pid ${readLock()?.pid}) owns the app lock; this one runs without it.`);
    }
    const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
    const url = `http://${displayHost}:${effective}`;
    console.log(`\n  Skill Vault App  —  ${url}`);
    if (host === "0.0.0.0") {
      console.log("  [!] Binding to 0.0.0.0 — reachable on the LAN.");
    }
    console.log("  (Ctrl+C to stop)\n");
    if (shouldOpen) {
      open(url).catch(() => {
        /* user can click the link */
      });
    }
  });

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("exit", () => releaseLock(process.pid));

  if (args.exitWhenIdle) {
    startIdleStop({
      clients: sseClientCount,
      isBusy: () => (app.locals.isBusy as () => boolean)(),
      graceMs: envMs("SKILL_VAULT_IDLE_GRACE_MS", 60_000),
      bootGraceMs: envMs("SKILL_VAULT_IDLE_BOOT_GRACE_MS", 120_000),
      tickMs: envMs("SKILL_VAULT_IDLE_TICK_MS", 5_000),
      onIdle: () => {
        console.log("[idle] no app window for a while; stopping");
        void shutdown();
      },
    });
  }
}
```

- [ ] **Step 10: Check `--strict-port` by hand**

Run (bash, from `app/`), with your dev server on 9994:
```bash
node --import tsx server/launcher.ts --port 9994 --strict-port --no-open; echo "exit: $?"
```
Expected: after ~10 s, `port 9994 is still in use; giving up` and `exit: 1`. A plain `--port 9994` without the flag still moves on to 9995 as before.

- [ ] **Step 11: Full suite (including the Task 4 integration test), typecheck, commit**

Run: `npm run build && npm test && npm run typecheck`
Expected: all pass.

```bash
git add app/server/services/appUpdate.ts app/server/services/appUpdate.test.ts app/server/routes/app.ts app/server/routes/app.test.ts app/server/index.ts app/server/launcher.ts
git commit -F - <<'EOF'
app update: one-click apply with staged build, rollback, and restart

POST /api/app/update pulls (ff-only), reinstalls packages only when the
lockfile changed, builds into dist-next/ and swaps it in, then starts the
new build on the same port (--strict-port) and exits. Any failure before
the hand-over resets the checkout to the old commit and keeps the
running build. Progress streams as NDJSON.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 8: Client — update pill and dialog

**Files:**
- Create: `app/client/src/lib/appUpdate.ts`, `app/client/src/components/AppUpdate.tsx`
- Modify: `app/client/src/components/Layout.tsx`

**Interfaces:**
- Consumes: `/api/health`, `/api/app/update`, `/api/app/update/check`, `POST /api/app/update` (Tasks 2, 7). The client types mirror the server's `AppUpdateStatus`, `ApplyEvent` and `HealthInfo` field for field.
- Produces: `appUpdateApi.{status, check, apply}`, `getHealth()`, `waitForNewServer(oldPid, timeoutMs?)`, `<UpdatePill />`.

- [ ] **Step 1: Client API**

`app/client/src/lib/appUpdate.ts`:

```ts
/**
 * In-app updates (server: services/appUpdate.ts, routes/app.ts). The apply
 * call streams NDJSON progress; after {step:"restart"} the server hands
 * over to a new process, so the client waits for /api/health to answer
 * with a new pid and then reloads.
 */
import { ApiError } from "./api";

export interface AppUpdateStatus {
  supported: boolean;
  branch: string | null;
  current: string | null;
  latest: string | null;
  behind: number;
  ahead: number;
  dirty: boolean;
  commits: Array<{ sha: string; subject: string }>;
  checked_at: string | null;
  can_apply: boolean;
  reason?: string;
  last_error?: string;
  applying: boolean;
}

export interface ApplyEvent {
  step: "check" | "pull" | "install" | "build" | "restart";
  state: "start" | "done" | "skip" | "error";
  message?: string;
}

export interface HealthInfo {
  ok: true;
  pid: number;
  port: number | null;
  version: string;
  mode: "development" | "production";
}

async function json<T>(method: "GET" | "POST", url: string): Promise<T> {
  const res = await fetch(url, { method });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(msg, res.status, data);
  }
  return data as T;
}

export const appUpdateApi = {
  status: () => json<AppUpdateStatus>("GET", "/api/app/update"),
  check: () => json<AppUpdateStatus>("POST", "/api/app/update/check"),
  /** Runs the update, calling onEvent per progress line, until the server ends the stream. */
  async apply(onEvent: (e: ApplyEvent) => void): Promise<void> {
    const res = await fetch("/api/app/update", { method: "POST" });
    if (!res.ok || !res.body) throw new Error(`Update failed to start (${res.status})`);
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
        if (line) onEvent(JSON.parse(line) as ApplyEvent);
      }
    }
  },
};

export async function getHealth(): Promise<HealthInfo | null> {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    return res.ok ? ((await res.json()) as HealthInfo) : null;
  } catch {
    return null;
  }
}

/** After "Update & restart": true once /api/health answers from a different process. */
export async function waitForNewServer(oldPid: number | null, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const h = await getHealth();
    if (h && h.pid !== oldPid) return true;
  }
  return false;
}
```

- [ ] **Step 2: Pill and dialog**

`app/client/src/components/AppUpdate.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "./ui/primitives";
import {
  appUpdateApi,
  getHealth,
  waitForNewServer,
  type AppUpdateStatus,
  type ApplyEvent,
} from "../lib/appUpdate";

/**
 * Sidebar-footer pill, shown only when this checkout is behind GitHub's
 * main. Opens AppUpdateDialog, which streams pull → install → build →
 * restart and reloads once the new server answers.
 */
export function UpdatePill() {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["app-update"],
    queryFn: appUpdateApi.status,
    refetchInterval: 10 * 60_000,
    staleTime: 60_000,
  });
  if (!data || data.behind <= 0) return null;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="A newer version of Skill Vault is available"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 8px",
          border: "0.5px solid var(--accent)",
          background: "var(--bg)",
          borderRadius: 6,
          cursor: "pointer",
          color: "var(--ink)",
          fontSize: 12,
        }}
      >
        <span className="sv-pulse" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)" }} />
        <span style={{ flex: 1, textAlign: "left" }}>Update available</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-4)" }}>{data.behind}</span>
      </button>
      {open && <AppUpdateDialog status={data} onClose={() => setOpen(false)} />}
    </>
  );
}

type Phase = "idle" | "running" | "restarting" | "failed";

const STEP_LABEL: Record<ApplyEvent["step"], string> = {
  check: "Check",
  pull: "Download the update",
  install: "Install packages",
  build: "Build",
  restart: "Restart",
};

const MARK: Record<ApplyEvent["state"], string> = { start: "…", done: "✓", skip: "–", error: "✗" };

function AppUpdateDialog({ status, onClose }: { status: AppUpdateStatus; onClose: () => void }) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>("idle");
  const [events, setEvents] = useState<ApplyEvent[]>([]);
  const busy = phase === "running" || phase === "restarting";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const run = async () => {
    setPhase("running");
    setEvents([]);
    const before = await getHealth();
    let restarting = false;
    let failed = false;
    try {
      await appUpdateApi.apply((e) => {
        setEvents((xs) => [...xs, e]);
        if (e.state === "error") failed = true;
        if (e.step === "restart" && e.state === "start") restarting = true;
      });
    } catch (err) {
      // The old server closing the stream after "restart" is expected.
      if (!restarting) {
        failed = true;
        setEvents((xs) => [...xs, { step: "check", state: "error", message: (err as Error).message }]);
      }
    }
    if (failed || !restarting) {
      setPhase("failed");
      void qc.invalidateQueries({ queryKey: ["app-update"] });
      return;
    }
    setPhase("restarting");
    if (await waitForNewServer(before?.pid ?? null)) window.location.reload();
    else setPhase("failed");
  };

  // Latest state per step, in step order.
  const latest = new Map<ApplyEvent["step"], ApplyEvent>();
  for (const e of events) latest.set(e.step, e);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Update Skill Vault"
      onClick={() => !busy && onClose()}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "grid", placeItems: "center", zIndex: 50 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(520px, 92vw)",
          maxHeight: "70vh",
          overflow: "auto",
          background: "var(--bg)",
          border: "0.5px solid var(--border-2)",
          borderRadius: 8,
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600 }}>Update Skill Vault</div>
        <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
          {status.behind} new {status.behind === 1 ? "change" : "changes"} on GitHub:
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {status.commits.map((c) => (
            <div key={c.sha} style={{ fontSize: 12.5, display: "flex", gap: 8 }}>
              <code style={{ fontFamily: "var(--mono)", color: "var(--ink-3)" }}>{c.sha}</code>
              <span>{c.subject}</span>
            </div>
          ))}
        </div>
        {!status.can_apply && status.reason && (
          <div style={{ fontSize: 12.5, color: "var(--warn)" }}>Can't update right now: {status.reason}.</div>
        )}
        {latest.size > 0 && (
          <div style={{ fontFamily: "var(--mono)", fontSize: 12, display: "flex", flexDirection: "column", gap: 2 }}>
            {[...latest.values()].map((e) => (
              <div key={e.step} style={{ color: e.state === "error" ? "var(--bad)" : "var(--ink-2)" }}>
                {MARK[e.state]} {STEP_LABEL[e.step]}
                {e.message ? `: ${e.message}` : ""}
              </div>
            ))}
          </div>
        )}
        {phase === "restarting" && (
          <div style={{ fontSize: 12.5 }}>Restarting. The window reloads when the new version is ready.</div>
        )}
        {phase === "failed" && (
          <div style={{ fontSize: 12.5, color: "var(--bad)" }}>
            The update didn't finish. Your current version is still running; details are in
            ~/.skill-vault/logs/server.log.
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
          <Button kind="ghost" size="sm" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button kind="primary" size="sm" onClick={() => void run()} disabled={!status.can_apply || busy}>
            {busy ? "Updating…" : "Update & restart"}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Mount it in the sidebar footer**

In `app/client/src/components/Layout.tsx`, add `import { UpdatePill } from "./AppUpdate";` next to the other component imports. In the footer column, insert `<UpdatePill />` as the first child, directly above `<button onClick={toggleAssistant}`.

- [ ] **Step 4: Typecheck and build the client**

Run: `npm run typecheck && npm run build`
Expected: tsc exit 0; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add app/client/src/lib/appUpdate.ts app/client/src/components/AppUpdate.tsx app/client/src/components/Layout.tsx
git commit -F - <<'EOF'
client: Update available pill and update dialog

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 6: See the pill against a checkout that is one commit behind**

Build a sandbox: a bare "origin" whose `main` is this branch's tip, a clone of it (`repo`), and a second clone (`work`) that pushes one harmless commit, so `repo` is exactly one commit behind with all the update code in it. A sandbox home with an empty vault keeps your real vault out of it. Run (bash, from `app/`):
```bash
T="$TEMP/sv-pill"; rm -rf "$T"; SRC="$(git rev-parse --show-toplevel)"
git clone -q --bare "$SRC" "$T/origin.git"
git -C "$T/origin.git" update-ref refs/heads/main refs/heads/feat/install-and-launch
git -C "$T/origin.git" symbolic-ref HEAD refs/heads/main
git clone -q "$T/origin.git" "$T/repo"
git clone -q "$T/origin.git" "$T/work"
echo "test update" > "$T/work/UPDATE-TEST.md"
git -C "$T/work" add UPDATE-TEST.md && git -C "$T/work" commit -qm "Test update" && git -C "$T/work" push -q origin main
mkdir -p "$T/home/.skill-vault" "$T/vault"
printf '{"vault_path": "%s"}\n' "$(cygpath -m "$T/vault")" > "$T/home/.skill-vault/config.json"
cd "$T/repo/app" && npm ci --include=dev --no-audit --no-fund >/dev/null && npm run build >/dev/null
USERPROFILE="$(cygpath -w "$T/home")" HOME="$(cygpath -w "$T/home")" NODE_ENV=production node dist/launcher.js --port 9975 --no-open --host 127.0.0.1 &
sleep 3; curl -s -X POST http://127.0.0.1:9975/api/app/update/check; echo
```
Expected: JSON with `"branch":"main"`, `"behind":1`, `"can_apply":true` and one commit, `"Test update"`. Open `http://localhost:9975`: the **Update available** pill shows in the sidebar footer, and its dialog lists the commit. Don't click Update yet: Task 12 runs the full apply through the launcher. Stop this server (`taskkill /PID <pid> /T /F`) and keep `$TEMP/sv-pill` for Task 12.

---

### Task 9: Hidden launcher (`app/scripts/launch.ps1`)

**Files:**
- Create: `app/scripts/launch.ps1`

**Interfaces:**
- Consumes: `~/.skill-vault/app.lock` (Task 2), `/api/health` (Task 2), `node scripts/build-state.mjs` (Task 1), launcher flags (Tasks 3, 4).
- Produces: the command the Start Menu shortcut runs (Task 10):
  `%SystemRoot%\System32\conhost.exe --headless "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "<repo>\app\scripts\launch.ps1"`

- [ ] **Step 1: Write the script**

`app/scripts/launch.ps1`:

```powershell
<#
  Skill Vault launcher: what the Start Menu shortcut runs, with no window.

  1. Reuse a running server (~/.skill-vault/app.lock + GET /api/health).
  2. Otherwise rebuild if the source is newer than dist/ (scripts/build-state.mjs
     exits 10), then start the built server hidden with --exit-when-idle.
  3. Open an Edge app window (default browser if Edge isn't installed).

  Steps go to ~/.skill-vault/logs/launch.log; any failure shows a message box
  naming the log. Windows PowerShell 5.1 compatible.
#>
$ErrorActionPreference = 'Stop'
$AppDir    = Split-Path -Parent $PSScriptRoot
$SvDir     = Join-Path $env:USERPROFILE '.skill-vault'
$LogDir    = Join-Path $SvDir 'logs'
$LockFile  = Join-Path $SvDir 'app.lock'
$LaunchLog = Join-Path $LogDir 'launch.log'
$ServerLog = Join-Path $LogDir 'server.log'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log([string]$Message) {
  Add-Content -LiteralPath $LaunchLog -Value ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $Message)
}

function Stop-WithError([string]$Message) {
  Write-Log "ERROR: $Message"
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("$Message`n`nDetails: $LaunchLog", 'Skill Vault', 'OK', 'Error') | Out-Null
  exit 1
}

function Get-LiveServer {
  if (-not (Test-Path -LiteralPath $LockFile)) { return $null }
  try { $lock = Get-Content -LiteralPath $LockFile -Raw | ConvertFrom-Json } catch { return $null }
  if (-not (Get-Process -Id $lock.pid -ErrorAction SilentlyContinue)) { return $null }
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($lock.port)/api/health" -TimeoutSec 2
    if ($health.ok -and $health.pid -eq $lock.pid) { return $lock }
  } catch { }
  return $null
}

function Find-Edge {
  foreach ($key in 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe',
                   'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe') {
    $item = Get-Item -LiteralPath $key -ErrorAction SilentlyContinue
    if ($item) {
      $exe = $item.GetValue('')
      if ($exe -and (Test-Path -LiteralPath $exe)) { return $exe }
    }
  }
  return $null
}

function Open-AppWindow([int]$Port) {
  $url = "http://localhost:$Port/"
  $edge = Find-Edge
  if ($edge) {
    Start-Process -FilePath $edge -ArgumentList "--app=$url"
    Write-Log "opened an Edge app window at $url"
  } else {
    Start-Process $url
    Write-Log "Edge not found; opened $url in the default browser"
  }
}

Write-Log '--- launch'
$live = Get-LiveServer
if ($live) {
  Write-Log "reusing the running server (pid $($live.pid), port $($live.port))"
} else {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { Stop-WithError 'Node.js was not found. Install it (winget install OpenJS.NodeJS.LTS), then run setup.cmd again.' }

  Push-Location $AppDir
  try {
    & $node.Source 'scripts/build-state.mjs'
    if ($LASTEXITCODE -eq 10) {
      Write-Log 'the source changed since the last build; rebuilding'
      Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
      # cmd /c keeps npm's stderr from becoming a terminating PowerShell error.
      cmd /c "npm run build >> `"$LaunchLog`" 2>&1"
      if ($LASTEXITCODE -ne 0) { Stop-WithError 'Rebuilding Skill Vault failed.' }
    }
  } finally {
    Pop-Location
  }

  $env:NODE_ENV = 'production'
  $serverArgs = @('dist/launcher.js', '--no-open', '--exit-when-idle', '--log-file', "`"$ServerLog`"")
  Start-Process -FilePath $node.Source -ArgumentList $serverArgs -WorkingDirectory $AppDir -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(20)
  while (-not ($live = Get-LiveServer)) {
    if ((Get-Date) -gt $deadline) { Stop-WithError "Skill Vault didn't start within 20 seconds. Server log: $ServerLog" }
    Start-Sleep -Milliseconds 250
  }
  Write-Log "started the server (pid $($live.pid), port $($live.port))"
}
Open-AppWindow ([int]$live.port)
```

- [ ] **Step 2: Run it against a sandbox home (start path)**

Run (PowerShell, from the repo root; `$RealHome` lets Step 5 restore your profile path):
```powershell
$RealHome = $env:USERPROFILE
$env:USERPROFILE = Join-Path $env:TEMP 'sv-launch-home'; New-Item -ItemType Directory -Force $env:USERPROFILE | Out-Null
& "$env:SystemRoot\System32\conhost.exe" --headless "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PWD\app\scripts\launch.ps1"
Get-Content "$env:USERPROFILE\.skill-vault\logs\launch.log"; Get-Content "$env:USERPROFILE\.skill-vault\app.lock"
```
Expected: an Edge app window (no tabs or address bar) opens on the Setup page; **no console or Terminal window appears at any point**; `launch.log` ends with `started the server …` and `opened an Edge app window …`; the lock names a running `node` pid.

- [ ] **Step 3: Second launch reuses it**

Run the same `conhost` command again.
Expected: a second window opens on the same port; `launch.log` says `reusing the running server`; `Get-Process node` shows no new server process.

- [ ] **Step 4: Idle stop**

Close both Edge app windows and wait about 70 s.
Expected: the server's node process exits; `app.lock` is gone; `server.log` ends with `[idle] no app window for a while; stopping`.

- [ ] **Step 5: Failure message, then clean up**

Run the launcher with a `PATH` that can't find Node:
```powershell
$SavedPath = $env:Path; $env:Path = "$env:SystemRoot\System32"
& "$env:SystemRoot\System32\conhost.exe" --headless "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PWD\app\scripts\launch.ps1"
$env:Path = $SavedPath
```
Expected: a **Skill Vault** message box says Node.js was not found and names `launch.log`. Click OK, then clean up:
```powershell
Remove-Item -Recurse -Force (Join-Path $env:TEMP 'sv-launch-home'); $env:USERPROFILE = $RealHome
```

- [ ] **Step 6: Decision gate — fallback if `conhost --headless` misbehaves**

Only if Step 2 showed a console or Terminal window, or the script never ran under `conhost --headless`: switch the shortcut command (used in Task 10) to target `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` with arguments `-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "<repo>\app\scripts\launch.ps1"`, set the shortcut's WindowStyle to 7 (minimized), and record the choice in the header comment of `launch.ps1`. Tell the user a minimized taskbar entry may flash briefly.

- [ ] **Step 7: Commit**

```bash
git add app/scripts/launch.ps1
git commit -F - <<'EOF'
launcher: hidden launch.ps1 reuses a running server or starts one

Rebuilds when the source is newer than dist/, starts the built server
hidden with --exit-when-idle and --log-file, waits for /api/health, and
opens an Edge app window. Failures show a message box naming the log.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 10: Setup script (`setup.ps1` / `setup.cmd`)

**Files:**
- Create: `setup.ps1`, `setup.cmd` (repo root)

**Interfaces:**
- Consumes: `npm ci`, `npm run build` (Task 1), `app/scripts/launch.ps1` and the shortcut command decided in Task 9, `app/assets/skill-vault.ico`.
- Produces: `Start Menu\Programs\Skill Vault\Skill Vault.lnk`, `Start Menu\Programs\Skill Vault\Uninstall Skill Vault shortcuts.lnk`, optionally `Desktop\Skill Vault.lnk`.

- [ ] **Step 1: Write `setup.ps1`**

```powershell
<#
.SYNOPSIS
  Install Skill Vault for the current user: check Node and git, install
  packages, build, and add a "Skill Vault" folder to the Start Menu.
  Safe to re-run (repairs shortcuts and rebuilds).
.EXAMPLE
  .\setup.cmd              # install
  .\setup.cmd -Desktop     # also add a desktop shortcut
  .\setup.cmd -WhatIf      # show what would happen, change nothing
  .\setup.cmd -Uninstall   # remove the shortcuts (never the clone, your vault or ~/.skill-vault)
#>
[CmdletBinding(SupportsShouldProcess)]
param([switch]$Desktop, [switch]$Uninstall, [switch]$NoLaunch)

$ErrorActionPreference = 'Stop'
$Repo       = $PSScriptRoot
$App        = Join-Path $Repo 'app'
$Programs   = [Environment]::GetFolderPath('Programs')
$StartMenu  = Join-Path $Programs 'Skill Vault'
$DesktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Skill Vault.lnk'
$LegacyLnk  = Join-Path $Programs 'Apps\Skill Vault App.lnk'
$Launch     = Join-Path $App 'scripts\launch.ps1'
$Icon       = Join-Path $App 'assets\skill-vault.ico'
$WinPS      = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$Conhost    = Join-Path $env:SystemRoot 'System32\conhost.exe'

function Write-Step([string]$m) { Write-Host "  > $m" -ForegroundColor Cyan }
function Write-Ok([string]$m)   { Write-Host "    $m" -ForegroundColor Green }
function Write-Warn([string]$m) { Write-Host "    ! $m" -ForegroundColor Yellow }
function Stop-Setup([string]$m) { Write-Host "    x $m" -ForegroundColor Red; exit 1 }

function New-Shortcut([string]$Path, [string]$Target, [string]$Arguments, [string]$WorkDir, [string]$Description, [int]$WindowStyle) {
  if (-not $PSCmdlet.ShouldProcess($Path, 'Create shortcut')) { return }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($Path)
  $s.TargetPath = $Target
  $s.Arguments = $Arguments
  $s.WorkingDirectory = $WorkDir
  $s.IconLocation = $Icon
  $s.Description = $Description
  $s.WindowStyle = $WindowStyle
  $s.Save()
  Write-Ok "shortcut: $Path"
}

if ($Uninstall) {
  Write-Step 'Removing Skill Vault shortcuts'
  foreach ($p in @($StartMenu, $DesktopLnk)) {
    if ((Test-Path -LiteralPath $p) -and $PSCmdlet.ShouldProcess($p, 'Remove')) {
      Remove-Item -LiteralPath $p -Recurse -Force
      Write-Ok "removed $p"
    }
  }
  Write-Ok 'Done. The clone, your vault and ~/.skill-vault were not touched.'
  exit 0
}

Write-Host ''
Write-Host '  Skill Vault setup' -ForegroundColor White
Write-Host ''

Write-Step 'Checking prerequisites'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Stop-Setup 'Node.js 20 or newer is required. Install it with:  winget install OpenJS.NodeJS.LTS   then open a new terminal and run setup again.'
}
$nodeVersion = (& node --version).Trim()
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 20) {
  Stop-Setup "Node.js 20 or newer is required (found $nodeVersion). Update with:  winget upgrade OpenJS.NodeJS.LTS"
}
Write-Ok "node $nodeVersion"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Stop-Setup 'git is required. Install it with:  winget install Git.Git   then open a new terminal and run setup again.'
}
Write-Ok ((& git --version).Trim())
if (Get-Command claude -ErrorAction SilentlyContinue) {
  Write-Ok 'claude CLI found'
} else {
  Write-Warn 'claude CLI not found. The AI assistant, AI tagging and Claude merge need it (https://claude.com/claude-code); everything else works.'
}

Write-Step 'Installing packages'
if ($PSCmdlet.ShouldProcess($App, 'npm ci --include=dev')) {
  Push-Location $App
  try {
    Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
    & npm ci --include=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Stop-Setup 'npm ci failed (see the output above).' }
  } finally { Pop-Location }
}

Write-Step 'Building the app'
if ($PSCmdlet.ShouldProcess($App, 'npm run build')) {
  Push-Location $App
  try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { Stop-Setup 'The build failed (see the output above).' }
  } finally { Pop-Location }
}

Write-Step 'Creating shortcuts'
# conhost --headless runs the launcher with no window at all, even when
# Windows Terminal is the default console (powershell -WindowStyle Hidden can't hide that).
$launchArgs = "--headless `"$WinPS`" -NoProfile -ExecutionPolicy Bypass -File `"$Launch`""
New-Shortcut (Join-Path $StartMenu 'Skill Vault.lnk') $Conhost $launchArgs $App 'Open Skill Vault' 1
New-Shortcut (Join-Path $StartMenu 'Uninstall Skill Vault shortcuts.lnk') $WinPS "-NoProfile -ExecutionPolicy Bypass -File `"$Repo\setup.ps1`" -Uninstall" $Repo 'Remove the Skill Vault shortcuts' 1
if ($Desktop) {
  New-Shortcut $DesktopLnk $Conhost $launchArgs $App 'Open Skill Vault' 1
}

if (Test-Path -LiteralPath $LegacyLnk) {
  $old = (New-Object -ComObject WScript.Shell).CreateShortcut($LegacyLnk).TargetPath
  if ($old -and ($old -eq (Join-Path $App 'run.bat')) -and $PSCmdlet.ShouldProcess($LegacyLnk, 'Remove the old shortcut')) {
    Remove-Item -LiteralPath $LegacyLnk -Force
    Write-Ok "removed the old shortcut $LegacyLnk"
  }
}

Write-Host ''
Write-Host '  Skill Vault is installed. Open it from the Start Menu: Skill Vault.' -ForegroundColor Green
Write-Host ''
if (-not $NoLaunch -and -not $WhatIfPreference) {
  $answer = Read-Host '  Open Skill Vault now? [Y/n]'
  if ($answer -eq '' -or $answer -match '^[Yy]') {
    & $Conhost --headless $WinPS -NoProfile -ExecutionPolicy Bypass -File $Launch
  }
}
```

If Task 9's decision gate chose the fallback, change the two launch shortcuts (Start Menu and desktop) to target `$WinPS` with arguments `-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "$Launch"` and WindowStyle `7`, and make the final "Open now" call `& $WinPS -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $Launch`.

- [ ] **Step 2: Write `setup.cmd`**

```bat
@echo off
REM Skill Vault setup. Options: -Desktop, -Uninstall, -NoLaunch, -WhatIf (see setup.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
if errorlevel 1 pause
```

- [ ] **Step 3: Dry run and the missing-prerequisite message**

Run (PowerShell, from the repo root):
```powershell
.\setup.cmd -WhatIf
powershell -NoProfile -Command "$env:Path = $env:SystemRoot + '\System32'; & '.\setup.ps1' -WhatIf"
```
Expected: the first prints `What if:` lines for `npm ci`, `npm run build` and each shortcut, and changes nothing (`Test-Path "$([Environment]::GetFolderPath('Programs'))\Skill Vault"` stays `False`). The second stops with the `winget install OpenJS.NodeJS.LTS` message and exit code 1.

- [ ] **Step 4: Real install from a throwaway clone, then uninstall**

Run (PowerShell):
```powershell
$T = Join-Path $env:TEMP 'sv-setup-test'; Remove-Item -Recurse -Force $T -ErrorAction SilentlyContinue
git clone -q (git rev-parse --show-toplevel) $T
& "$T\setup.cmd" -NoLaunch
Get-ChildItem "$([Environment]::GetFolderPath('Programs'))\Skill Vault"
```
Expected: packages install, the build succeeds, and the folder lists `Skill Vault.lnk` and `Uninstall Skill Vault shortcuts.lnk`. Open **Skill Vault** from the Start Menu: the app window opens with no console. Close it. Then run `& "$T\setup.cmd" -Uninstall`. Expected: the Start Menu folder is gone and `$T` is untouched. Delete `$T` afterwards.

- [ ] **Step 5: Commit**

```bash
git add setup.ps1 setup.cmd
git commit -F - <<'EOF'
setup: one-script Windows install with a Skill Vault Start Menu folder

setup.cmd checks Node 20+ and git (printing the winget fix when missing),
runs npm ci and the build, and creates per-user shortcuts that open the
app with no console window. -Desktop, -Uninstall, -NoLaunch, -WhatIf.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 11: Docs and changelog

**Files:**
- Modify: `README.md`, `docs/getting-started.md`, `docs/troubleshooting.md`, `docs/configuration.md`, `app/CHANGELOG.md`

- [ ] **Step 1: README quick start**

In `README.md`, replace the block from `Requires Node 20+.` through the closing fence of the `npm run dev` code block with:

````markdown
Requires Node 20+ and git. On Windows:

```bash
git clone https://github.com/pugliabi/skill-vault.git
cd skill-vault
.\setup.cmd
```

`setup.cmd` installs and builds the app and adds a **Skill Vault** folder to the Start Menu. The shortcut opens the app in its own window and stops the app about a minute after you close it. Re-run `setup.cmd` any time to repair the install; `.\setup.cmd -Uninstall` removes the shortcuts. The app tells you when a newer version is on GitHub and updates itself in one click.

On macOS or Linux, or to work on the app itself: `cd app && npm install && npm run dev` (opens http://localhost:9994).
````

- [ ] **Step 2: Getting started**

In `docs/getting-started.md`, replace the `## Install and launch the app` section body (the code block and the `On Windows, app\run.bat …` paragraph) with:

````markdown
On Windows:

```bash
git clone https://github.com/pugliabi/skill-vault.git
cd skill-vault
.\setup.cmd
```

Setup checks for Node 20+ and git (and prints the `winget` command if one is missing), installs packages, builds the app, and creates **Start Menu → Skill Vault**. Options: `-Desktop` (also a desktop shortcut), `-WhatIf` (show what it would do), `-Uninstall` (remove the shortcuts only: your clone, vault and `~/.skill-vault` are never touched).

The shortcut opens Skill Vault in its own window. Clicking it again reuses the running app, and the app stops about a minute after its last window closes.

**Updating.** When GitHub has newer commits on `main`, an **Update available** button appears at the bottom of the sidebar. **Update & restart** pulls, rebuilds and restarts the app. It only runs on a clean `main` checkout, and if any step fails the previous version keeps running.

**Developing / macOS / Linux.** `cd app && npm install && npm run dev` runs from source with hot reload (→ http://localhost:9994); on Windows, `app\run.bat` does the same. Port, host and browser auto-open are configurable; see [Configuration](./configuration.md).
````

- [ ] **Step 3: Troubleshooting**

In `docs/troubleshooting.md`, under `## The app`, before `### Problem: Port already in use…`, add:

```markdown
### Problem: Clicking the Skill Vault shortcut doesn't open a window

**Symptoms**: nothing happens, or a "Skill Vault" message box appears.

**Cause**: the launcher couldn't find Node, couldn't rebuild, or the server didn't answer within 20 seconds.

**Solution**: read `~/.skill-vault/logs/launch.log` (launcher steps and build output) and `~/.skill-vault/logs/server.log` (the server's own output). Re-running `setup.cmd` repairs packages, the build and the shortcuts.

### Problem: "Update & restart" is greyed out

**Symptoms**: the update dialog says "Can't update right now: …".

**Cause**: in-app updates only fast-forward a clean `main` checkout. The reason names what's in the way: another branch, uncommitted changes, local commits not on GitHub, running from source with `npm run dev`, or a job (Notion sync, assistant reply, update check) still running.

**Solution**: commit, stash or push your changes, or switch to `main`. When running from source, `git pull` and restart yourself.
```

- [ ] **Step 4: Configuration**

In `docs/configuration.md`, in the `## App runtime configuration` precedence list, change item 1 to:

```markdown
1. **CLI flags** — `--port`/`-p`, `--host`/`-h`, `--no-open`, `--help`, plus the launcher's `--exit-when-idle` (stop about 60 s after the last window closes), `--log-file <path>` (also write output to a file, rotated at 5 MB, 3 kept) and `--strict-port` (use exactly `--port`; wait up to 10 s, else exit). Pass after `--` with npm: `npm run dev -- --port 5500 --host 0.0.0.0 --no-open`
```

Before `## Assistant state files (per machine)`, add:

```markdown
## Launcher files (per machine)

The Start Menu launcher keeps a few files in `~/.skill-vault/`:

- `app.lock` — the running server's pid, port and version, so a second click reuses it. Removed when that server stops.
- `logs/server.log` (+ `.1`–`.3`) — output of the server started by the launcher.
- `logs/launch.log` — the launcher's own steps and any rebuild output.

All are safe to delete while the app is closed.
```

- [ ] **Step 5: Changelog**

In `app/CHANGELOG.md`, directly under `## [Unreleased]`, insert:

```markdown
### Added
- `setup.cmd` installs the app on Windows (checks Node 20+ and git, installs,
  builds) and adds a **Skill Vault** Start Menu folder; `-Uninstall` removes it.
- The Start Menu shortcut opens the built app in its own Edge window with no
  console, reuses a running server, and stops it about a minute after the last
  window closes.
- In-app updates: an **Update available** button when GitHub's `main` is ahead,
  with one-click pull, rebuild and restart (rolled back if any step fails).
- `GET /api/health`; launcher flags `--exit-when-idle`, `--log-file`, `--strict-port`.

### Changed
- The app starts from a production build: about 0.6 s to listening instead of
  5–12 s in development mode, and the client ships as one bundle.
- The startup history scan no longer blocks the first page load.
- `npm run build` is now `node scripts/build.mjs` (writes `dist/.build-stamp`).

```

In the existing `### Fixed` list under `[Unreleased]`, add:

```markdown
- Notion push/pull of single-file skills: Notion now returns these as inline
  text instead of an archive link, which failed with "returned no archive".
- The assistant failing with "API key is not scoped to a workspace": choose
  Claude login or an API key (with workspace ID) in Settings → AI assistant.
```

- [ ] **Step 6: Check for personal information, then commit**

Run (bash, repo root): `git diff --cached --stat; git diff | grep -n -i -E "<your name>|<your machine name>|C:\\\\Users\\\\[a-z]" || echo "clean"`
Expected: `clean` (the README's public GitHub URL was already there and is fine; any other hit must be fixed).

```bash
git add README.md docs/getting-started.md docs/troubleshooting.md docs/configuration.md app/CHANGELOG.md
git commit -F - <<'EOF'
docs: setup.cmd install, launcher files, in-app updates, changelog

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 12: End-to-end verification, timings, and the real install

**Files:** none (verification; the measurements go into the PR description)

- [ ] **Step 1: Everything green**

Run (from `app/`): `npm run build && npm test && npm run typecheck`
Expected: all tests pass (including `launcher.idle.test.ts`, not skipped), tsc exit 0.

- [ ] **Step 2: Update flow end to end (sandbox from Task 8 Step 6)**

The sandbox at `$env:TEMP\sv-pill` has `repo` (one commit behind), `work` (pushes to the bare `origin.git`) and `home` (sandbox profile with an empty vault). If any commits landed on the feature branch since Task 8, rebuild the sandbox with Task 8 Step 6's commands first. Launch `repo` through its own launcher:
```powershell
$RealHome = $env:USERPROFILE; $T = Join-Path $env:TEMP 'sv-pill'
$env:USERPROFILE = "$T\home"
& "$env:SystemRoot\System32\conhost.exe" --headless "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$T\repo\app\scripts\launch.ps1"
```
In the window, wait about 30 s for the first check (or run `Invoke-RestMethod -Method Post http://localhost:<port>/api/app/update/check`), then click **Update available** → **Update & restart**.
Expected: the steps tick through ("Install packages" shows "packages unchanged"), the window shows "Restarting…" and reloads by itself, `Invoke-RestMethod http://localhost:<port>/api/health` reports a new pid and the new short SHA, the pill is gone, and no console window appears at any point.

Now force a failed update by pushing a commit that breaks the client build:
```powershell
git -C "$T\work" pull -q
Add-Content "$T\work\app\client\src\main.tsx" 'this is not valid TypeScript ('
git -C "$T\work" commit -qam 'Break the client build'; git -C "$T\work" push -q origin main
$before = git -C "$T\repo" rev-parse HEAD
```
Trigger a check, then click **Update & restart** again.
Expected: the dialog shows `✗ Build: …` and "The update didn't finish…"; the app keeps working without a reload; `git -C "$T\repo" rev-parse HEAD` equals `$before`; `git -C "$T\repo" status --porcelain` is empty.

Close the window. Expected: the server stops about 60 s later and `$T\home\.skill-vault\app.lock` disappears. Clean up:
```powershell
$env:USERPROFILE = $RealHome; Remove-Item -Recurse -Force $T
```

- [ ] **Step 3: Timings for the PR description**

With a real vault, measure both launch paths (clicks via the shortcut, stopwatch from click to the skills list visible), cold (no server running) and warm (server running), and compare them with the baseline from the spec (dev mode: ~5 s warm / ~12 s cold to listening plus ~2.7 s to data).
Expected: cold ≤ ~3 s, warm ≤ ~1 s. Record the numbers.

- [ ] **Step 4: Install on this machine (ask the user first)**

`npm ci` replaces `app/node_modules`, which a running `npm run dev` / `run.bat` server holds open. Ask the user to close their running dev server window, then run from the main checkout: `.\setup.cmd`. Expected: the old `Programs\Apps\Skill Vault App.lnk` is removed, **Start Menu → Skill Vault** exists, and it opens the app with no console. Do not run this step without the user's go-ahead.

- [ ] **Step 5: Hand off**

Use superpowers:finishing-a-development-branch to decide how `feat/install-and-launch` lands (merge or PR), including the timings from Step 3 in the description.
