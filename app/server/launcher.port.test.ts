/**
 * Real server process: with another program listening on 0.0.0.0:<p>, a
 * launcher asked for 127.0.0.1:<p> moves to a later port instead of binding
 * beside it (Windows allows that bind) and shadowing it for localhost.
 * Like launcher.idle.test.ts it runs from source in production mode, so it
 * needs dist/public from `npm run build`, and it uses a sandbox home.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = fs.existsSync(path.join(APP, "dist", "public", "index.html"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test(
  "a port another program holds on 0.0.0.0 is skipped for a 127.0.0.1 launch",
  { skip: built ? false : "run `npm run build` first", timeout: 30_000 },
  async () => {
    const other = net.createServer();
    await new Promise<void>((r) => other.listen(0, "0.0.0.0", () => r()));
    const taken = (other.address() as net.AddressInfo).port;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sv-port-"));
    const lockFile = path.join(home, ".skill-vault", "app.lock");
    const tsx = pathToFileURL(path.join(APP, "node_modules", "tsx", "dist", "loader.mjs")).href;
    const child = spawn(
      process.execPath,
      ["--import", tsx, path.join(APP, "server", "launcher.ts"), "--no-open", "--port", String(taken), "--host", "127.0.0.1"],
      {
        cwd: home, // keeps app/.env (a developer's PORT/HOST) out of the test
        env: { ...process.env, USERPROFILE: home, HOME: home, NODE_ENV: "production" },
        stdio: "ignore",
      },
    );
    try {
      for (let i = 0; i < 100 && !fs.existsSync(lockFile); i++) await sleep(100);
      const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      assert.equal(lock.pid, child.pid);
      assert.ok(lock.port > taken && lock.port < taken + 10, `moved off ${taken} to ${lock.port}`);
      const health = await (await fetch(`http://127.0.0.1:${lock.port}/api/health`)).json();
      assert.equal(health.pid, child.pid);
    } finally {
      if (child.exitCode === null) child.kill();
      await new Promise<void>((r) => other.close(() => r()));
      await sleep(200);
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  },
);
