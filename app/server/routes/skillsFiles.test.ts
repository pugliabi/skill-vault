import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";

let vault: string;
let fakeHome: string;
let server: Server;
let url: string;

const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
const CONFIG = "[core]\n\trepositoryformatversion = 0\n";

function put(rel: string, content: string, expected: string): Promise<Response> {
  const encoded = rel.split("/").map(encodeURIComponent).join("/");
  return fetch(`${url}/demo/files/${encoded}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, expected_sha256: expected }),
  });
}

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

  const skill = path.join(vault, "skills", "demo");
  fs.mkdirSync(path.join(skill, ".git"), { recursive: true });
  fs.mkdirSync(path.join(skill, "references"));
  fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: demo\ndescription: d\n---\nbody\n");
  fs.writeFileSync(path.join(skill, "references", "notes.md"), "notes\n");
  fs.writeFileSync(path.join(skill, ".git", "config"), CONFIG);

  const app = express();
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

test("PUT edits a normal file in a skill", async () => {
  const res = await put("references/notes.md", "changed\n", sha("notes\n"));
  assert.equal(res.status, 200);
  assert.equal(fs.readFileSync(path.join(vault, "skills", "demo", "references", "notes.md"), "utf8"), "changed\n");
  fs.writeFileSync(path.join(vault, "skills", "demo", "references", "notes.md"), "notes\n");
});

for (const bad of [
  ".git/config",
  ".GIT/config",
  "GIT~1/config",
  "SKILL.md.",
  "SKILL.md ",
  "SKILL.md::$DATA",
  "references/notes.md:stream",
  "references/CON",
  "references/aux.md",
  "references/a\u0001b.md",
]) {
  test(`PUT refuses ${JSON.stringify(bad)} and changes nothing`, async () => {
    const skill = path.join(vault, "skills", "demo");
    const skillMd = fs.readFileSync(path.join(skill, "SKILL.md"), "utf8");
    // The right hash for whichever real file an alias lands on, so only the path check can stop it.
    const target = /git/i.test(bad) ? CONFIG : skillMd;
    const res = await put(bad, "pwned\n", sha(target));
    assert.equal(res.status, 400, `status for ${bad}`);
    assert.equal(fs.readFileSync(path.join(skill, ".git", "config"), "utf8"), CONFIG);
    assert.equal(fs.readFileSync(path.join(skill, "SKILL.md"), "utf8"), skillMd);
  });
}
