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
