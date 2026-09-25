import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ClaudeRunner } from "../services/aiTagging.ts";

// appConfig resolves ~/.skill-vault at import time, so point HOME at a temp
// dir BEFORE importing the router. Never touches the real config or vault.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sv-tags-home-"));
const vault = fs.mkdtempSync(path.join(os.tmpdir(), "sv-tags-vault-"));
process.env.USERPROFILE = home;
process.env.HOME = home;
fs.mkdirSync(path.join(home, ".skill-vault"), { recursive: true });
fs.writeFileSync(
  path.join(home, ".skill-vault", "config.json"),
  JSON.stringify({ vault_path: vault }),
);
function addSkill(name: string, md: string, tags: string[] = []) {
  fs.mkdirSync(path.join(vault, "skills", name), { recursive: true });
  fs.writeFileSync(path.join(vault, "skills", name, "SKILL.md"), md);
  return [name, { targets: [], tags }] as const;
}
fs.writeFileSync(
  path.join(vault, "skills.json"),
  JSON.stringify({
    skills: Object.fromEntries([
      addSkill("dataflows-authoring-cli", "---\ndescription: >\n  Author Fabric dataflows.\n---\nbody", ["cli"]),
      addSkill("te2-cli", "---\ndescription: Tabular Editor 2 CLI\n---\n", ["powerbi", "cli"]),
    ]),
  }),
);

let prompts: string[] = [];
let available = true;
let fail = false;
/** Fake low-level CLI runner: never spawns the real `claude`. */
const runner: ClaudeRunner = async (_args, prompt) => {
  prompts.push(prompt);
  if (fail) throw new Error("Claude CLI exited 1: boom");
  const names = [...prompt.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
  const structured_output = {
    skills: names.map((name) => ({ name, tags: ["fabric", "data"], reason: `about ${name}` })),
  };
  return { stdout: JSON.stringify({ is_error: false, structured_output }), stderr: "", code: 0 };
};

let server: Server;
let base: string;
before(async () => {
  const express = (await import("express")).default;
  const { tagsRouter } = await import("./tags.ts");
  const { readAppConfig } = await import("../services/appConfig.ts");
  assert.equal(readAppConfig().vault_path, vault, "test must run against the sandbox vault");
  const app = express();
  app.use(express.json());
  app.use(
    "/api/tags",
    tagsRouter({
      runner,
      detect: async () => (available ? { available: true, version: "9.9.9" } : { available: false, reason: "not on PATH" }),
    }),
  );
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tags`;
});
after(() => server.close());

const post = (p: string, body: unknown) =>
  fetch(`${base}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("ai-status reports availability", async () => {
  available = true;
  const r = await (await fetch(`${base}/ai-status`)).json();
  assert.equal(r.available, true);
  assert.equal(typeof r.model, "string");
});

test("suggest returns full tag sets with reasons and sends SKILL.md text", async () => {
  prompts = [];
  available = true;
  fail = false;
  const res = await post("/suggest", { skills: ["dataflows-authoring-cli", "te2-cli"] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.results["dataflows-authoring-cli"].tags, ["fabric", "data"]);
  assert.equal(body.results["te2-cli"].reason, "about te2-cli");
  assert.deepEqual(body.failed, []);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /description: Author Fabric dataflows\./);
  assert.match(prompts[0], /^current tags: cli$/m);
  assert.deepEqual(body.results["dataflows-authoring-cli"].remove, [], "omitted tags are not removed implicitly");
});

test("suggest is 503 when the Claude CLI is unavailable (client falls back)", async () => {
  available = false;
  prompts = [];
  const res = await post("/suggest", { skills: ["te2-cli"] });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /not on PATH/);
  assert.equal(prompts.length, 0);
  available = true;
});

test("runner failures come back as failed skills, not a 500", async () => {
  fail = true;
  const body = await (await post("/suggest", { skills: ["te2-cli"] })).json();
  assert.deepEqual(body.results, {});
  assert.deepEqual(body.failed, [{ names: ["te2-cli"], error: "Claude CLI exited 1: boom" }]);
  fail = false;
});

test("suggest rejects empty, oversized and unknown/traversal names", async () => {
  assert.equal((await post("/suggest", { skills: [] })).status, 400);
  assert.equal(
    (await post("/suggest", { skills: Array.from({ length: 51 }, (_, i) => `s${i}`) })).status,
    400,
  );
  assert.equal((await post("/suggest", { skills: ["nope"] })).status, 404);
  assert.equal((await post("/suggest", { skills: ["../../etc"] })).status, 404);
});

test("bulk remove with prune_known:false keeps known_tags", async () => {
  const manifestPath = path.join(vault, "skills.json");
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  m.known_tags = ["cli", "powerbi"];
  fs.writeFileSync(manifestPath, JSON.stringify(m));

  await post("/bulk", { skills: ["dataflows-authoring-cli"], remove: ["cli"], prune_known: false });
  let after = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  assert.deepEqual(after.skills["dataflows-authoring-cli"].tags, []);
  assert.deepEqual(after.known_tags, ["cli", "powerbi"]);

  // Default behaviour unchanged: removing also prunes known_tags.
  await post("/bulk", { skills: ["te2-cli"], remove: ["cli"] });
  after = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  assert.deepEqual(after.known_tags, ["powerbi"]);
});
