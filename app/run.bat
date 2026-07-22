@echo off
REM =============================================================
REM  Skill Vault App - Windows launcher
REM  Created: 2026-04-10
REM
REM  Parses .env in this directory for PORT / HOST / OPEN_BROWSER,
REM  displays the resolved values, then hands off to `npm run dev`.
REM
REM  The Node launcher (server/launcher.ts) also reads .env via
REM  dotenv. Parsing here is primarily for visibility - you see the
REM  values in the terminal before the server boots - and so any
REM  extra arguments to run.bat flow straight through to the
REM  launcher without the shell eating them.
REM
REM  Precedence inside the Node launcher (highest wins):
REM    1. CLI flags passed to this .bat  (run.bat --port 5500)
REM    2. Environment variables set here (from .env)
REM    3. .env file                      (already loaded above)
REM    4. `app` block in ~/.skill-vault/config.json (shared w/ sv)
REM    5. Built-in defaults (5174 / 127.0.0.1 / open browser on)
REM
REM  Usage:
REM    run.bat                         # defaults + .env
REM    run.bat --port 5500             # override port
REM    run.bat --host 0.0.0.0          # bind to LAN
REM    run.bat --no-open               # don't open browser
REM    run.bat --help                  # forwarded to launcher
REM =============================================================

setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

REM ── Load .env if present ─────────────────────────────────────
REM `eol=#` treats any line starting with # as a comment line, so
REM they're skipped. Blank lines are ignored by `for /f` naturally.
REM We rely on the fact that `for /f` with an explicit file arg
REM returns nothing when the file is missing, but we check anyway
REM to make the intent obvious in the script log.
if exist .env (
    for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
        if not "%%a"=="" (
            set "%%a=%%b"
        )
    )
)

REM ── Banner ───────────────────────────────────────────────────
echo.
echo   Skill Vault App
echo   ===============
if defined PORT (
    echo     PORT         : !PORT!          [from .env]
) else (
    echo     PORT         : default         [5174 or CLI config]
)
if defined HOST (
    echo     HOST         : !HOST!          [from .env]
) else (
    echo     HOST         : default         [127.0.0.1 or CLI config]
)
if defined OPEN_BROWSER (
    echo     OPEN_BROWSER : !OPEN_BROWSER!              [from .env]
) else (
    echo     OPEN_BROWSER : default         [on]
)
echo.

REM ── Verify npm on PATH ───────────────────────────────────────
where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm not found on PATH.
    echo         Install Node.js 18+ from https://nodejs.org/ and try again.
    echo.
    pause
    exit /b 1
)

REM ── First-launch dependency install ──────────────────────────
if not exist node_modules (
    echo First launch detected - installing dependencies.
    echo This runs once and may take ~30-60 seconds.
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed. See output above.
        pause
        exit /b 1
    )
    echo.
)

REM ── Run the dev server ───────────────────────────────────────
REM `%*` forwards any extra args to `npm run dev`. npm's `--`
REM separator lets them reach the underlying tsx / launcher.ts
REM (e.g. run.bat --port 5500 -> npm run dev -- --port 5500).
call npm run dev -- %*
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
    echo.
    echo [ERROR] Dev server exited with code %EXITCODE%.
    pause
)

endlocal & exit /b %EXITCODE%
