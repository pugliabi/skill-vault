import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";

// Same sandbox pattern as history.test.ts: USERPROFILE/HOME must point at a
// temp home BEFORE appConfig.ts (and the notion store) is first imported.
// No test here reaches the real Notion API: every Notion-backed route is
// exercised only in the not-connected state.

let vault: string;
let fakeHome: string;
let server: Server;
let base: string;

before(async () => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "sv-nhome-"));
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "sv-nvault-"));
  fs.mkdirSync(path.join(fakeHome, ".skill-vault"), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, ".skill-vault", "config.json"),
    JSON.stringify({ vault_path: vault }, null, 2) + "\n",
  );
  fs.writeFileSync(path.join(vault, "skills.json"), JSON.stringify({ skills: { mine: { targets: [] } } }));
  fs.mkdirSync(path.join(vault, "skills", "mine"), { recursive: true });
  fs.writeFileSync(path.join(vault, "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: d\n---\nx\n");

  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;

  const express = (await import("express")).default;
  const { notionRouter } = await import("./notion.ts");
  const { skillsRouter } = await import("./skills.ts");

  const app = express();
  app.use(express.json());
  app.use("/api/notion", notionRouter());
  app.use("/api/skills", skillsRouter());

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}/api`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(vault, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

const manifest = () => JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf8")).skills;

test("GET /status reports not connected without an auth file", async () => {
  const res = await fetch(`${base}/notion/status`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { connected: false });
});

test("Notion-backed routes return 401 notion_not_connected", async () => {
  for (const [method, url] of [
    ["POST", "/notion/check"],
    ["GET", "/notion/data-sources"],
    ["POST", "/notion/link"],
  ] as const) {
    const res = await fetch(`${base}${url}`, { method });
    assert.equal(res.status, 401, url);
    assert.deepEqual(await res.json(), { error: "notion_not_connected" });
  }
});

test("GET /callback with a bad state redirects back to settings with an error", async () => {
  const res = await fetch(`${base}/notion/callback?code=c&state=nope`, { redirect: "manual" });
  assert.equal(res.status, 302);
  const loc = res.headers.get("location") ?? "";
  assert.ok(loc.startsWith("/settings?notion=error&message="), loc);
});

test("POST /skills/:name/vault-only and /unlink write the link state", async () => {
  let res = await fetch(`${base}/notion/skills/mine/vault-only`, { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal(manifest().mine.notion.state, "vault-only");
  assert.equal(manifest().mine.notion.page_id, "");
  res = await fetch(`${base}/notion/skills/mine/unlink`, { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal(manifest().mine.notion.state, "unlinked");
  res = await fetch(`${base}/notion/skills/nope/unlink`, { method: "POST" });
  assert.equal(res.status, 404);
});

test("GET /summary splits Notion-only rows from the cache", async () => {
  fs.writeFileSync(
    path.join(fakeHome, ".skill-vault", "notion-cache.json"),
    JSON.stringify({
      rows: [
        { page_id: "p1", title: "fabric-deploy", description: "", tags: [], has_files: false },
        { page_id: "p2", title: "Reformat with headers", description: "", tags: [], has_files: false },
      ],
    }),
  );
  const res = await fetch(`${base}/notion/summary`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    notion_only_compatible: [{ page_id: "p1", title: "fabric-deploy" }],
    notion_only_native: [{ page_id: "p2", title: "Reformat with headers" }],
  });
});

test("GET /api/skills has no notion_status when not connected", async () => {
  const res = await fetch(`${base}/skills`);
  assert.equal(res.status, 200);
  const { skills } = (await res.json()) as { skills: Array<Record<string, unknown>> };
  const mine = skills.find((s) => s.name === "mine")!;
  assert.equal("notion_status" in mine, false);
});

// Runs last: writes a (fake) auth file, which flips "connected".
test("with tokens and a data source, status is connected and skills carry notion_status", async () => {
  fs.writeFileSync(path.join(fakeHome, ".skill-vault", "notion-auth.json"), JSON.stringify({ tokens: { access_token: "x" } }));
  fs.writeFileSync(path.join(vault, "notion.json"), JSON.stringify({ data_source_id: "ds", data_source_name: "Skills", last_edited_property: null }));
  const st = (await (await fetch(`${base}/notion/status`)).json()) as Record<string, unknown>;
  assert.equal(st.connected, true);
  assert.deepEqual(st.data_source, { id: "ds", name: "Skills" });
  assert.equal(st.last_edited_property, null);
  const { skills } = (await (await fetch(`${base}/skills`)).json()) as { skills: Array<Record<string, unknown>> };
  assert.equal(skills.find((s) => s.name === "mine")!.notion_status, "unlinked");
});

test("a linked+synced skill is only 'synced' against a checked cache for the chosen data source", async () => {
  const m = JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf8"));
  m.skills.mine.notion = { page_id: "p1", state: "linked", linked_at: "t", synced_at: "t", notion_version_id: "v1" };
  fs.writeFileSync(path.join(vault, "skills.json"), JSON.stringify(m));
  const cacheFile = path.join(fakeHome, ".skill-vault", "notion-cache.json");
  const status = async () => {
    const { skills } = (await (await fetch(`${base}/skills`)).json()) as { skills: Array<Record<string, unknown>> };
    return skills.find((s) => s.name === "mine")!.notion_status;
  };
  const row = { page_id: "p1", title: "mine", description: "", tags: [], has_files: false, version_id: "v1" };

  // Never checked (no checked_at) → unchecked.
  fs.writeFileSync(cacheFile, JSON.stringify({ rows: [row] }));
  assert.equal(await status(), "unchecked");
  // Checked, but against another data source → unchecked.
  fs.writeFileSync(cacheFile, JSON.stringify({ checked_at: "t", data_source_id: "other", rows: [row] }));
  assert.equal(await status(), "unchecked");
  // Checked for this data source, page gone → missing-in-notion.
  fs.writeFileSync(cacheFile, JSON.stringify({ checked_at: "t", data_source_id: "ds", rows: [] }));
  assert.equal(await status(), "missing-in-notion");
  // Row without a version → unchecked.
  fs.writeFileSync(cacheFile, JSON.stringify({ checked_at: "t", data_source_id: "ds", rows: [{ ...row, version_id: undefined }] }));
  assert.equal(await status(), "unchecked");
  // Row with the linked version → synced.
  fs.writeFileSync(cacheFile, JSON.stringify({ checked_at: "t", data_source_id: "ds", rows: [row] }));
  assert.equal(await status(), "synced");
});

test("POST /data-source rejects a malformed id before contacting Notion", async () => {
  for (const id of ["ds", "not-a-uuid", "12345678-1234-1234-1234-12345678901z"]) {
    const res = await fetch(`${base}/notion/data-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, name: "x" }),
    });
    assert.equal(res.status, 400, id);
  }
});

test("OAuth redirect URL uses the local port, never the Host header", async () => {
  const { redirectUrlFor } = await import("./notion.ts");
  const req = { socket: { localPort: 5174 }, get: () => "evil.example:80", protocol: "https" } as any;
  assert.equal(redirectUrlFor(req), "http://localhost:5174/api/notion/callback");
});
