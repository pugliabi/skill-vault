import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";

// appConfig.ts computes CLI_CONFIG_DIR = path.join(os.homedir(), ".skill-vault")
// at module load time. To point it at a sandbox instead of the real
// ~/.skill-vault, USERPROFILE/HOME must be overridden BEFORE the first
// import of appConfig.ts (transitively via historyRouter/express). So
// everything below is dynamic-imported inside `before()`, after the env
// vars are set.

let vault: string;
let fakeHome: string;
let server: Server;
let baseUrl: string;
let skillsUrl: string;

before(async () => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "sv-home-"));
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "sv-vault-"));
  fs.mkdirSync(path.join(fakeHome, ".skill-vault"), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, ".skill-vault", "config.json"),
    JSON.stringify({ vault_path: vault }, null, 2) + "\n",
  );

  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;

  const express = (await import("express")).default;
  const { historyRouter } = await import("./history.ts");
  const { skillsRouter } = await import("./skills.ts");
  const { recordVersion } = await import("../services/history.ts");

  // Seed a skill with two versions so GET /:name and diff/restore have
  // something to work with.
  const skillDir = path.join(vault, "skills", "demo");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "v1");
  recordVersion(vault, "demo", { source: "vault-edit", always: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "v2");
  recordVersion(vault, "demo", { source: "vault-edit", always: true });

  const app = express();
  app.use(express.json());
  app.use("/api/history", historyRouter());
  app.use("/api/skills", skillsRouter());

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}/api/history`;
  skillsUrl = `http://127.0.0.1:${port}/api/skills`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(vault, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test("GET /:name lists versions without files but with file_count", async () => {
  const res = await fetch(`${baseUrl}/demo`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { versions: Array<Record<string, unknown>> };
  assert.equal(body.versions.length, 2);
  for (const v of body.versions) {
    assert.equal("files" in v, false);
    assert.equal(typeof v.file_count, "number");
    assert.ok((v.file_count as number) >= 1);
  }
  // newest first
  assert.equal((body.versions[0].at as string) >= (body.versions[1].at as string), true);
});

test("GET /:name/:id/diff diffs a version against current", async () => {
  const list = await (await fetch(`${baseUrl}/demo`)).json() as { versions: Array<{ id: string }> };
  const oldest = list.versions[list.versions.length - 1].id;
  const res = await fetch(`${baseUrl}/demo/${oldest}/diff`);
  assert.equal(res.status, 200);
  const diff = await res.json();
  assert.ok(diff && typeof diff === "object");
});

test("POST restore restores content", async () => {
  const list = await (await fetch(`${baseUrl}/demo`)).json() as { versions: Array<{ id: string }> };
  const oldest = list.versions[list.versions.length - 1].id; // v1
  const res = await fetch(`${baseUrl}/demo/${oldest}/restore`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { version: Record<string, unknown> };
  assert.equal("files" in body.version, false);
  const content = fs.readFileSync(path.join(vault, "skills", "demo", "SKILL.md"), "utf8");
  assert.equal(content, "v1");
});

test("GET /_deleted returns skills array", async () => {
  const res = await fetch(`${baseUrl}/_deleted`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { skills: unknown[] };
  assert.ok(Array.isArray(body.skills));
});

test("PUT /_config returns 400 on 0", async () => {
  const res = await fetch(`${baseUrl}/_config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ max_versions: 0 }),
  });
  assert.equal(res.status, 400);
});

test("GET /../x path traversal in name -> 400", async () => {
  const res = await fetch(`${baseUrl}/..%2Fetc`);
  assert.equal(res.status, 400);
});

test("bad version id format -> 400", async () => {
  const res = await fetch(`${baseUrl}/demo/not-a-valid-id/diff`);
  assert.equal(res.status, 400);
});

test("GET /_config returns the history config", async () => {
  const res = await fetch(`${baseUrl}/_config`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { max_versions: number };
  assert.equal(typeof body.max_versions, "number");
});

test("skills named config and deleted are not shadowed by meta routes", async () => {
  const { recordVersion } = await import("../services/history.ts");
  for (const name of ["config", "deleted"]) {
    const dir = path.join(vault, "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), name);
    recordVersion(vault, name, { source: "vault-edit" });
    const res = await fetch(`${baseUrl}/${name}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { versions: unknown[] };
    assert.equal(body.versions.length, 1);
  }
});

test("GET /:name with an unreadable versions.json -> 500 with error", async () => {
  const file = path.join(vault, ".history", "skills", "broken", "versions.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "<<<<<<< HEAD\n");
  const res = await fetch(`${baseUrl}/broken`);
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /not valid JSON/);
  assert.equal(fs.readFileSync(file, "utf8"), "<<<<<<< HEAD\n");
});

/** Raw HTTP request: fetch() would normalize a "%2E%2E" segment away client-side. */
async function rawStatus(method: string, pathAndQuery: string): Promise<number> {
  const http = await import("node:http");
  const url = new URL(skillsUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port, method, path: pathAndQuery },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("DELETE /api/skills/:name rejects traversal names before touching disk", async () => {
  for (const bad of ["%2E%2E", "..%2Fskills", "a%5Cb"]) {
    assert.equal(await rawStatus("DELETE", `/api/skills/${bad}`), 400, bad);
  }
  assert.ok(fs.existsSync(path.join(vault, "skills", "demo", "SKILL.md")));
});

test("POST /api/skills/:name/rename rejects traversal names", async () => {
  assert.equal(await rawStatus("POST", "/api/skills/%2E%2E/rename"), 400);
  assert.ok(fs.existsSync(path.join(vault, "skills")));
});

test("POST /api/skills records a 'created' version", async () => {
  const res = await fetch(skillsUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "fresh-skill", description: "new" }),
  });
  assert.equal(res.status, 201);
  const list = (await (await fetch(`${baseUrl}/fresh-skill`)).json()) as {
    versions: Array<{ source: string; note?: string }>;
  };
  assert.equal(list.versions.length, 1);
  assert.equal(list.versions[0].source, "vault-edit");
  assert.equal(list.versions[0].note, "created");
});
