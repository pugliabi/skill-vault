# Install & Launch — Design

**Date:** 2026-10-27 · **Status:** approved design, awaiting spec review · **Project 2 of 5** in the
app improvement roadmap (1 bug fixes ✓, 2 install & launch, 3 first-run setup guide, 4 GitHub skills
flow, 5 Notion sync redesign).

## Problem

- The app always runs in development mode: `run.bat` → `npm run dev` → `tsx watch` + Vite middleware.
  Measured on a ~275-skill vault: the server needs **~5 s warm / ~12 s cold** before it listens, then
  the browser loads **85 unbundled modules**, and API data lands **~2.7 s** after the page opens.
- A console window stays open for as long as the app runs.
- There is no install step. Anyone else installing the app has to clone, `npm install`, `npm run dev`,
  and make their own shortcut; a Start Menu entry exists only when someone creates it by hand.
- Clicking a launcher twice starts a second server on the next free port.
- Nothing tells an installed copy that a newer version exists.

## Goals

1. One script installs the app for a new user (Windows) and creates a **Skill Vault** Start Menu folder.
2. The shortcut opens the app in its **own window** (Edge app mode) with **no console window**, fast.
3. Exactly **one server per user**: a second click reuses the running one.
4. The server **stops itself** when no app window is open and nothing is running.
5. The app shows **Update available** and updates itself in one click, safely.
6. Startup targets: **≤ ~3 s** from click to a window showing skills when no server is running (no
   rebuild needed); **≤ ~1 s** when one is already running.

## Non-goals

- macOS / Linux launchers (they keep the `npm` commands), a packaged `.exe`/MSI installer, bundling
  Node, code signing, installing the Python `sv` CLI, auto-start at login, a tray icon.
- Changing the development workflow: `npm run dev` and `run.bat` stay as they are.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| How others install | Clone the repo + run one setup script (needs Node ≥ 20 and git). |
| What the shortcut opens | A chromeless Edge app window; default browser if Edge is missing. |
| Updates | In-app notice + one click (git-based). |
| Implementation split | Small PowerShell scripts (setup, launch); all logic that can be tested lives in the Node server or small Node helper scripts. |

## Architecture

```
setup.cmd ─► setup.ps1 ──(npm ci, build, shortcuts)──► Start Menu\Programs\Skill Vault\
                                                         ├─ Skill Vault.lnk ─────────────┐
                                                         └─ Uninstall Skill Vault shortcuts.lnk
                                                                                          ▼
                     powershell -WindowStyle Hidden -File app\scripts\launch.ps1
                       1. live server?  ~/.skill-vault/app.lock + GET /api/health ──yes──┐
                       2. stale build?  node app/scripts/build-state.mjs → npm run build │
                       3. start hidden: node dist/launcher.js --exit-when-idle           │
                            --log-file ~/.skill-vault/logs/server.log                    │
                       4. wait for /api/health ◄──────────────────────────────────────────┘
                       5. msedge --app=http://localhost:<port>/   (fallback: default browser)

Node server (production bundle)
  instanceLock   writes/clears ~/.skill-vault/app.lock
  idleStop       exits when 0 SSE clients for 60 s and nothing busy (only with --exit-when-idle)
  appUpdate      git fetch every 6 h → status; apply = pull → (npm ci) → staged build → restart
  routes/app.ts  GET /api/health · GET /api/app/update · POST /api/app/update/check · POST /api/app/update
  logFile        tees console output to a size-capped rotating log (only with --log-file)
Client
  UpdatePill (top bar) + AppUpdateDialog; reconnect-and-reload after a restart
```

## Components

### 1. `setup.cmd` / `setup.ps1` (repo root)

`setup.cmd` is a double-clickable wrapper:
`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*`.

`setup.ps1` parameters: `-Desktop` (also make a desktop shortcut), `-Uninstall`, `-NoLaunch`, and
`-WhatIf` (via `SupportsShouldProcess`: print every action, change nothing).

Install steps, in order — each prints one status line:

1. **Prerequisites.** `node --version` ≥ 20 and `git --version` must succeed; otherwise print the exact
   fix (`winget install OpenJS.NodeJS.LTS`, `winget install Git.Git`) and exit 1. If `claude` is not on
   `PATH`, print a warning (assistant / AI tagging / Claude merge need it) and continue.
2. **Packages.** In `app/`: `npm ci --include=dev` (dev dependencies are needed to build, and must be
   included even if `NODE_ENV=production` is set in the user's environment).
3. **Build.** `npm run build` (writes `dist/` and `dist/.build-stamp`, see §4).
4. **Shortcuts** (per-user, no admin), via `WScript.Shell`:
   - `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Skill Vault\Skill Vault.lnk` → target
     `powershell.exe`, arguments `-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File
     "<repo>\app\scripts\launch.ps1"`, window style Minimized (7), icon `app\assets\skill-vault.ico`,
     working directory `<repo>\app`.
   - `...\Skill Vault\Uninstall Skill Vault shortcuts.lnk` → `setup.ps1 -Uninstall`.
   - With `-Desktop`: the same launch shortcut on the desktop.
5. **Legacy cleanup.** Delete `...\Programs\Apps\Skill Vault App.lnk` only if its target is this
   checkout's `app\run.bat`.
6. **Launch?** Unless `-NoLaunch`, ask "Open Skill Vault now? [Y/n]" and run `launch.ps1`.

Re-running setup is safe: packages are re-synced, the app is rebuilt, shortcuts are overwritten.
`-Uninstall` removes the Start Menu folder and the desktop shortcut; it never touches the clone, the
vault, or `~/.skill-vault`.

### 2. `app/scripts/launch.ps1` (runs hidden)

1. **Reuse.** Read `~/.skill-vault/app.lock`. If the recorded PID is alive and
   `GET http://127.0.0.1:<port>/api/health` answers within 2 s with that PID → go to step 5.
2. **Rebuild if stale.** `node app/scripts/build-state.mjs`; exit code 10 means stale → `npm run build`
   (output captured to the log). A failed build → error dialog (step 6).
3. **Start.** `Start-Process node -ArgumentList 'dist/launcher.js','--no-open','--exit-when-idle',
   '--log-file',<log path> -WindowStyle Hidden -WorkingDirectory <app>` with `NODE_ENV=production`.
4. **Wait** up to 20 s for the lock file to appear and `/api/health` to answer.
5. **Open.** Resolve Edge from `App Paths\msedge.exe` (HKCU, then HKLM) and run
   `msedge.exe --app=http://localhost:<port>/`. If Edge is not found, `Start-Process <url>`.
6. **Errors.** Any failure shows a `System.Windows.MessageBox` with a one-line reason and the log
   path, then exits non-zero. Nothing fails silently.

The launcher never kills or replaces a running server. If the user's `npm run dev` server holds the
lock, the shortcut simply opens a window onto it.

### 3. Server changes

**Launcher flags** (`server/launcher.ts`):
- `--exit-when-idle` — enables idle stop (§ idleStop). Off by default, so `npm run dev`, `npm start` and
  terminal use behave exactly as today.
- `--log-file <path>` — tee stdout/stderr to `<path>`, rotating at 5 MB and keeping 3 old files.
- `--strict-port` — use exactly `--port`; if it is busy, retry for up to 10 s, then exit 1 (used by the
  update restart so the window's URL stays valid). Without it, the existing next-free-port behavior stays.

**`services/instanceLock.ts`** — `app.lock` JSON: `{ pid, port, started_at, version, mode }`
(`version` = git short SHA from the build stamp, or `"dev"`). Written after `listen` succeeds, **only if**
there is no lock whose PID is alive (a second server — e.g. `npm run dev` while the built app runs —
still runs, it just doesn't take the lock). Removed on shutdown only if the lock's PID is our own.

**`GET /api/health`** → `{ ok: true, pid, port, version, mode }`. Cheap: no vault or Notion work.

**`services/idleStop.ts`** — pure decision function plus a 5 s interval:
`shouldStop({ clients, busy, idleSinceMs, nowMs, graceMs })`. `clients` = open `/api/events` SSE
connections (export a count from `routes/events.ts`); `busy` = any Notion job, any in-flight assistant
turn, an app update apply (§5), or a user-started skill update check (`foregroundCheckActive()`). Grace: 120 s right after boot (window still
opening), then 60 s after the last client disconnects. Stopping goes through the existing
`cleanupLiveUpdates` path, which also removes in-progress temp clones.

**History scan off the request path.** `scanForUnrecordedChanges` gains an async, chunked variant
that yields to the event loop between skills (`setImmediate`), started after `listen`. Today the
synchronous scan blocks the first page for ~1 s.

**Conditional: hash caching.** If, after the above, `/api/skills` + suggestions still delay first data by
> ~1 s in the built app, cache each skill's normalized content hash keyed by the skill folder's newest
mtime. Implemented only if the measurement calls for it.

### 4. Build state (`app/scripts/build-state.mjs`, `dist/.build-stamp`)

- `npm run build` ends with `node scripts/write-build-stamp.mjs`, writing `dist/.build-stamp`:
  `{ built_at, git_sha }`.
- `build-state.mjs` exits **0** when the build is fresh and **10** when stale: `dist/launcher.js`,
  `dist/public/index.html` or the stamp is missing, or any file under `server/`, `client/`,
  `assistant-plugin/`, or `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`,
  `tailwind.config.ts`, `postcss.config.js` is newer than the stamp. Exported `isBuildStale(appDir)`
  is unit-tested.

### 5. In-app updates (`services/appUpdate.ts`, `routes/app.ts`)

**Check.** 30 s after start and every 6 h — only when the app's repo root is a git checkout with an
`origin` remote — run `git fetch origin --quiet`, then read:
`git rev-parse --abbrev-ref HEAD`, `git rev-list --left-right --count HEAD...origin/main`,
`git status --porcelain`, and for the dialog `git log --format=%h%x09%s HEAD..origin/main`.
Yields to running jobs like the existing update sweep. Network failures are recorded, not thrown.

**Status** (`GET /api/app/update`):
`{ supported, branch, current, latest, behind, ahead, dirty, commits: [{sha, subject}], checked_at,
can_apply, reason?, last_error? }`. `POST /api/app/update/check` forces a fetch.

**`can_apply` is false, with `reason`, when:** not a git checkout · branch ≠ `main` · uncommitted
changes · local commits not on GitHub (`ahead > 0`) · `behind = 0` · a job is running · an apply is
already in progress. Status parsing and these rules are a pure function over git outputs.

**UI.** When `behind > 0`, an **Update available** pill in the top bar opens `AppUpdateDialog`: the
incoming commit subjects, the `reason` if it can't apply, and **Update & restart**.

**Apply** (`POST /api/app/update`, NDJSON progress `{ step, state, message? }`):
1. `git pull --ff-only` (record `old_sha`).
2. If `package-lock.json` changed between `old_sha` and `HEAD`: `npm ci --include=dev`.
3. **Staged build** into `dist-next/` (Vite `--outDir dist-next/public`, esbuild `--outdir dist-next`),
   write its stamp, then swap: `dist` → `dist-old`, `dist-next` → `dist`, delete `dist-old` (copy
   fallback if a rename is refused). The running server never serves a half-written bundle.
4. **Restart.** Spawn a detached, hidden `node dist/launcher.js --port <current> --strict-port
   --exit-when-idle --log-file <same>` (the lock is released first so the new process can take it), send
   `{ step: "restart" }`, then shut down. The client shows "Restarting…", polls `/api/health` every
   500 ms, and reloads when the new PID answers.

**On failure at any step:** `git reset --hard <old_sha>` (safe: a clean tree was required), run
`npm ci --include=dev` again if step 2 ran, keep running the current build, and report the failed step
in the dialog and as `last_error`.

### 6. Logging and errors

- Hidden server output → `~/.skill-vault/logs/server.log` (+ `.1`–`.3`), via `--log-file`.
- `launch.ps1` writes its own steps and any `npm run build` output to `~/.skill-vault/logs/launch.log`.
- Every launcher failure surfaces as a message box naming the log file.

### 7. Docs

README quick start and `docs/getting-started.md` lead with `setup.cmd`; `docs/troubleshooting.md` gains
"the window doesn't open" (logs, message box) and "update refused" (each `reason`);
`docs/configuration.md` documents the new launcher flags; `app/CHANGELOG.md` entry.

## Testing

**Unit (node:test, same style as the existing suite):** instance lock (write only when no live lock;
remove only own), `shouldStop` (grace periods, busy, clients), update status parsing + every `can_apply`
rule (fed recorded git outputs), `isBuildStale` (missing dist, newer source, fresh), log rotation, the
apply pipeline with an injected command runner (happy path; failure at pull / install / build → rollback
calls; lockfile-unchanged skips `npm ci`).

**Integration:** start the built server with `--exit-when-idle` under a temp `HOME` with a test grace
period (env override), assert the lock file and `/api/health`, open and close an SSE connection, assert
the process exits and the lock is removed.

**Manual, on a real Windows machine:** clone into a temp folder → `setup.cmd -WhatIf` → `setup.cmd`; the
Start Menu folder appears; the shortcut opens the Edge window with no console; a second click reuses the
server (one `node` process); closing the window stops the server ~60 s later; with a newer commit on
`origin/main`, the pill appears and Update & restart works; uninstall removes only shortcuts. Before/after
timings (click → skills visible, cold and warm) go in the PR description.

## Acceptance criteria

- [ ] `setup.cmd` on a machine with Node ≥ 20 and git installs, builds, and creates the Start Menu folder;
      missing prerequisites print the exact `winget` fix.
- [ ] The shortcut opens an Edge app window with no lingering console window.
- [ ] Second click → same server, no second `node` process.
- [ ] Server exits ~60 s after the last window closes, unless a job is running; lock file removed.
- [ ] Click → skills visible in ≤ ~3 s with no server running (no rebuild), ≤ ~1 s with one running.
- [ ] Update pill appears when behind `origin/main`; apply succeeds end to end; a forced build failure
      rolls back and the app keeps working.
- [ ] `npm run dev` / `run.bat` behave exactly as before.
- [ ] All existing tests pass; new unit and integration tests pass.
