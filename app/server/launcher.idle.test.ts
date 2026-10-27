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
