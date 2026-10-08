import { test } from "node:test";
import assert from "node:assert/strict";
import { BridgeToolError, TOOLS, createHttp, type BridgeHttp } from "./bridge.ts";

const noSleep = async (): Promise<void> => {};

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** Scripted fake: responses consumed in order; records every call. */
function fakeHttp(responses: Array<{ status: number; json: unknown }>): BridgeHttp & { calls: Call[] } {
  const calls: Call[] = [];
  const queue = responses.slice();
  const http = (async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
    const next = queue.shift();
    if (!next) throw new Error(`fakeHttp exhausted at call ${calls.length}: ${method} ${path}`);
    return next;
  }) as BridgeHttp & { calls: Call[] };
  http.calls = calls;
  return http;
}

test("createHttp joins base + path, sends JSON bodies, and tolerates empty bodies", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return { status: 204, json: async () => { throw new Error("no body"); } };
  }) as unknown as typeof fetch;

  const http = createHttp("http://127.0.0.1:5174/", fetchFn);
  const r = await http("POST", "/api/push", { skill: "x" });
  assert.equal(r.status, 204);
  assert.equal(r.json, null);
  assert.equal(seen[0].url, "http://127.0.0.1:5174/api/push");
  assert.equal(seen[0].init?.method, "POST");
  assert.equal(seen[0].init?.body, JSON.stringify({ skill: "x" }));

  await http("GET", "/api/skills");
  assert.equal(seen[1].init?.body, undefined);
  assert.equal(seen[1].init?.headers, undefined);
});

test("every tool hits its documented endpoint with the right method and body", async () => {
  const table: Array<{
    tool: string;
    args: Record<string, unknown>;
    responses?: Array<{ status: number; json: unknown }>;
    expect: Call[];
  }> = [
    {
      tool: "get_skill",
      args: { name: "pdf tools" },
      expect: [{ method: "GET", path: "/api/skills/pdf%20tools" }],
    },
    {
      tool: "search_skills",
      args: { query: "origin repair" },
      expect: [{ method: "GET", path: "/api/skills/search?q=origin%20repair" }],
    },
    {
      tool: "check_updates",
      args: { skills: ["a", "b"] },
      expect: [{ method: "POST", path: "/api/adopt/check-updates", body: { skills: ["a", "b"] } }],
    },
    {
      tool: "apply_update",
      args: { items: [{ name: "a", tmp_path: "T" }] },
      expect: [{ method: "POST", path: "/api/adopt/update", body: { items: [{ name: "a", tmp_path: "T" }] } }],
    },
    {
      tool: "set_origin",
      args: { name: "a", origin: { type: "git", url: "U", subpath: "s" } },
      expect: [
        { method: "PATCH", path: "/api/skills/a/origin", body: { origin: { type: "git", url: "U", subpath: "s" }, verify: true } },
      ],
    },
    {
      tool: "adopt_skills",
      args: { source_path: "R", items: [{ name: "a", path: "R/a" }] },
      expect: [
        {
          method: "POST",
          path: "/api/adopt/import",
          body: { source_path: "R", items: [{ name: "a", path: "R/a" }], overwrite: undefined, origin_context: undefined },
        },
      ],
    },
    {
      tool: "push_to_provider",
      args: { skill: "a", provider_id: "claude" },
      expect: [{ method: "POST", path: "/api/push", body: { skill: "a", provider_id: "claude", method: "auto" } }],
    },
    {
      tool: "pull_from_provider",
      args: { skill: "a", provider_id: "claude" },
      expect: [{ method: "POST", path: "/api/pull", body: { skill: "a", provider_id: "claude" } }],
    },
    {
      tool: "scan_dir_for_skills",
      args: { path: "C:\\repos\\x" },
      expect: [{ method: "POST", path: "/api/adopt/scan", body: { path: "C:\\repos\\x", recursive: true } }],
    },
    {
      tool: "audit_vault",
      args: {},
      expect: [{ method: "POST", path: "/api/fix/audit" }],
    },
    {
      tool: "fix_repair",
      args: { kind: "orphan_folder", target: "T", action: "add_to_manifest" },
      expect: [{ method: "POST", path: "/api/fix/repair", body: { kind: "orphan_folder", target: "T", action: "add_to_manifest" } }],
    },
    {
      tool: "notion_plan",
      args: { direction: "push" },
      expect: [{ method: "GET", path: "/api/notion/plan?direction=push" }],
    },
    {
      tool: "get_config",
      args: {},
      expect: [{ method: "GET", path: "/api/config" }],
    },
    {
      tool: "get_suggestions",
      args: {},
      expect: [{ method: "GET", path: "/api/assistant/suggestions" }],
    },
  ];

  for (const row of table) {
    const http = fakeHttp(row.responses ?? [{ status: 200, json: {} }]);
    await TOOLS[row.tool].handler(row.args, http, noSleep);
    assert.deepEqual(http.calls, row.expect, `tool ${row.tool}`);
  }
});

test("list_skills trims heavy fields and filters by status client-side", async () => {
  const http = fakeHttp([
    {
      status: 200,
      json: {
        skills: [
          { name: "a", status: "stale", targets: ["claude"], tags: [], description: "x".repeat(200), files: ["huge"], origin: { type: "git" } },
          { name: "b", status: "synced", targets: [], description: "" },
        ],
        total: 2,
      },
    },
  ]);
  const out = (await TOOLS.list_skills.handler({ status: "stale" }, http, noSleep)) as {
    total: number;
    skills: Array<Record<string, unknown>>;
  };
  assert.equal(out.total, 1);
  assert.equal(out.skills[0].name, "a");
  assert.equal((out.skills[0].description as string).length, 140);
  assert.equal(out.skills[0].files, undefined, "raw fields must not leak through");
  assert.deepEqual(out.skills[0].origin, { type: "git" });
});

test("recent_activity filters errors and applies the limit from the tail", async () => {
  const entries = [
    { at: "1", kind: "push", skill: "a", ok: true },
    { at: "2", kind: "push", skill: "b", ok: false, message: "boom" },
    { at: "3", kind: "update", skill: "c", ok: false, message: "bad" },
  ];
  const http = fakeHttp([{ status: 200, json: { entries } }]);
  const out = (await TOOLS.recent_activity.handler({ only_errors: true, limit: 1 }, http, noSleep)) as {
    entries: Array<{ skill: string }>;
  };
  assert.deepEqual(out.entries.map((e) => e.skill), ["c"]);
});

test("notion_push starts the job then polls until running:false and returns results", async () => {
  const http = fakeHttp([
    { status: 200, json: { job_id: "J1" } },
    { status: 200, json: { running: true, done: 0, total: 2 } },
    { status: 200, json: { running: true, done: 1, total: 2 } },
    { status: 200, json: { running: false, results: [{ id: "push-selected:a", ok: true }], done: 2, total: 2 } },
  ]);
  const slept: number[] = [];
  const out = await TOOLS.notion_push.handler({ skills: ["a", "b"] }, http, async (ms) => {
    slept.push(ms);
  });
  assert.deepEqual(out, { results: [{ id: "push-selected:a", ok: true }] });
  assert.equal(http.calls[0].method, "POST");
  assert.equal(http.calls[0].path, "/api/notion/push-selected");
  assert.deepEqual(http.calls.slice(1).map((c) => c.path), ["/api/notion/run/J1", "/api/notion/run/J1", "/api/notion/run/J1"]);
  assert.deepEqual(slept, [1000, 1000]);
});

test("notion_run passes rows through and surfaces a job-level error field", async () => {
  const http = fakeHttp([
    { status: 200, json: { job_id: "J2" } },
    { status: 200, json: { running: false, results: [], error: "guard blocked" } },
  ]);
  const out = await TOOLS.notion_run.handler({ direction: "pull", rows: [{ id: "r1" }] }, http, noSleep);
  assert.deepEqual(out, { results: [], error: "guard blocked" });
  assert.deepEqual(http.calls[0].body, { direction: "pull", rows: [{ id: "r1" }] });
});

test("409 busy and 401 not-connected map to readable BridgeToolErrors, passing the server text through", async () => {
  await assert.rejects(
    TOOLS.notion_push.handler({ skills: ["a"] }, fakeHttp([{ status: 409, json: { error: "a Notion job is already running" } }]), noSleep),
    (err) => {
      assert.ok(err instanceof BridgeToolError);
      assert.match(err.message, /a Notion job is already running/);
      return true;
    },
  );
  await assert.rejects(
    TOOLS.notion_plan.handler({ direction: "push" }, fakeHttp([{ status: 401, json: { error: "not connected" } }]), noSleep),
    (err) => {
      assert.ok(err instanceof BridgeToolError);
      assert.match(err.message, /connect Notion/i);
      return true;
    },
  );
});

test("notion_status degrades gracefully when the summary needs a connection", async () => {
  const http = fakeHttp([
    { status: 200, json: { connected: false } },
    { status: 401, json: { error: "not connected" } },
  ]);
  const out = await TOOLS.notion_status.handler({}, http, noSleep);
  assert.deepEqual(out, { status: { connected: false }, summary: null });
});

test("set_origin clear:true PATCHes origin:null; origin-less call without clear errors", async () => {
  const http = fakeHttp([{ status: 200, json: { entry: {}, cleared: true } }]);
  const out = await TOOLS.set_origin.handler({ name: "dead skill", clear: true }, http, noSleep);
  assert.deepEqual(http.calls, [{ method: "PATCH", path: "/api/skills/dead%20skill/origin", body: { origin: null } }]);
  assert.deepEqual(out, { entry: {}, cleared: true });
  await assert.rejects(TOOLS.set_origin.handler({ name: "x" }, fakeHttp([]), noSleep), /provide origin, or clear:true/);
});
