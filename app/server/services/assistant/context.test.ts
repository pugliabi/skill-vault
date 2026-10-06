import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTurnContext, pickLeadAgent, resolveReposDir, type TurnContextData } from "./context.ts";
import { DEFAULT_ADOPT_PATH } from "../adoption.ts";

function base(overrides: Partial<TurnContextData> = {}): TurnContextData {
  return {
    vaultPath: "C:\\vault",
    reposDir: "C:\\Github\\skills-repos",
    agent: "vault",
    chips: [],
    recentErrors: [],
    notion: { connected: false },
    ...overrides,
  };
}

test("pickLeadAgent routes by context kind", () => {
  assert.equal(pickLeadAgent("vault"), "vault-manager");
  assert.equal(pickLeadAgent("skill"), "skill-agent");
});

test("resolveReposDir prefers the config pass-through and falls back to the adopt default", () => {
  assert.equal(resolveReposDir({ repos_dir: "D:\\repos" }), "D:\\repos");
  assert.equal(resolveReposDir({}), DEFAULT_ADOPT_PATH);
  assert.equal(resolveReposDir({ repos_dir: "" }), DEFAULT_ADOPT_PATH);
});

test("vault-scope context names the vault, repos dir, tool rule, and notion state", () => {
  const out = buildTurnContext(base());
  assert.match(out, /Vault: C:\\vault/);
  assert.match(out, /Repos dir .*skills-repos/);
  assert.match(out, /ONLY through the mcp__vault__\* tools/);
  assert.match(out, /Scope: whole vault/);
  assert.match(out, /Notion: not connected/);
});

test("skill-scope context includes the focus skill's origin and statuses", () => {
  const out = buildTurnContext(
    base({
      agent: "skill",
      skill: "pdf-tools",
      skillDetail: {
        origin: { type: "git", url: "U", subpath: "s" },
        status: "stale",
        stage: "production",
        targets: ["claude", "cursor"],
        notion_state: "linked",
      },
      notion: { connected: true, data_source_name: "My Skills" },
    }),
  );
  assert.match(out, /Focus skill: pdf-tools/);
  assert.match(out, /origin: \{"type":"git","url":"U","subpath":"s"\}/);
  assert.match(out, /provider status: stale/);
  assert.match(out, /targets: claude, cursor/);
  assert.match(out, /notion: linked/);
  assert.match(out, /Notion: connected \(data source "My Skills"\)/);
});

test("chips serialize: multi-selection, filters, and failure payloads", () => {
  const out = buildTurnContext(
    base({
      chips: [
        { kind: "skills", id: "sel", label: "3 selected", data: { skills: ["a", "b", "c"] } },
        { kind: "filter", id: "f", label: "filters", data: { status: "stale", tag: "fabric" } },
        { kind: "failure", id: "x", label: "failure: gone upstream", data: { status: "upstream_missing" } },
        { kind: "page", id: "p", label: "Sync" },
      ],
    }),
  );
  assert.match(out, /User-selected skills \(3\): a, b, c/);
  assert.match(out, /Active Skills-page filters: \{"status":"stale","tag":"fabric"\}/);
  assert.match(out, /Failure in focus \(failure: gone upstream\): \{"status":"upstream_missing"\}/);
  assert.match(out, /User is on the Sync page\./);
});

test("recent errors are listed and the block is hard-capped", () => {
  const errors = Array.from({ length: 5 }, (_, i) => ({
    at: "t",
    kind: "update" as const,
    skill: `skill-${i}`,
    ok: false,
    message: "m".repeat(500),
  }));
  const out = buildTurnContext(base({ recentErrors: errors }));
  assert.match(out, /Recent failed operations/);
  assert.match(out, /\[update\] skill-0/);
  assert.ok(out.length <= 2_500, `context must stay capped, got ${out.length}`);
});
