import { test } from "node:test";
import assert from "node:assert/strict";
import { ServerUnavailableError, createResolvingFetch, findOrStartServer, type ServerDeps } from "./server.ts";

const lock = (pid: number, port: number) => ({ pid, port, started_at: "t", version: "v", mode: "production" as const });

function deps(over: Partial<ServerDeps> & { liveAfter?: number } = {}): ServerDeps & { starts: number } {
  let t = 0;
  let polls = 0;
  const d = {
    starts: 0,
    readLock: () => lock(42, 9994),
    health: async () => {
      polls++;
      return over.liveAfter !== undefined && polls > over.liveAfter ? { ok: true, pid: 42 } : null;
    },
    startHeadless: () => {
      d.starts++;
    },
    sleep: async (ms: number) => {
      t += ms;
    },
    now: () => t,
    platform: "win32" as NodeJS.Platform,
    ...over,
  };
  return d;
}

test("a healthy server named by app.lock is used as is", async () => {
  const d = deps({ health: async () => ({ ok: true, pid: 42 }) });
  assert.equal(await findOrStartServer(d), "http://127.0.0.1:9994");
  assert.equal(d.starts, 0);
});

test("a lock whose pid doesn't answer health counts as no server", async () => {
  const d = deps({ health: async () => ({ ok: true, pid: 7 }), platform: "darwin" });
  await assert.rejects(findOrStartServer(d), (e: unknown) => e instanceof ServerUnavailableError && /Open Skill Vault/.test(e.message));
});

test("on Windows it starts the app headless once and waits for it", async () => {
  const d = deps({ liveAfter: 3 });
  assert.equal(await findOrStartServer(d), "http://127.0.0.1:9994");
  assert.equal(d.starts, 1);
});

test("it gives up after 60 seconds and points at launch.log", async () => {
  const d = deps({ readLock: () => null });
  await assert.rejects(findOrStartServer(d), (e: unknown) => e instanceof ServerUnavailableError && /launch\.log/.test(e.message));
  assert.equal(d.starts, 1);
});

const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });

test("the resolving fetch caches the server and re-resolves once after a refused connection", async () => {
  const bases = ["http://a", "http://b"];
  let resolves = 0;
  const urls: string[] = [];
  let failNext = false;
  const fetchFn = (async (url: string | URL | Request) => {
    urls.push(String(url));
    if (failNext) {
      failNext = false;
      throw refused();
    }
    return new Response("{}");
  }) as typeof fetch;
  const f = createResolvingFetch(async () => bases[resolves++], fetchFn);
  await f("/api/x");
  await f("/api/y");
  failNext = true;
  await f("/api/z");
  assert.equal(resolves, 2);
  assert.deepEqual(urls, ["http://a/api/x", "http://a/api/y", "http://a/api/z", "http://b/api/z"]);
});

test("other network errors aren't retried", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    throw new TypeError("boom");
  }) as typeof fetch;
  const f = createResolvingFetch(async () => "http://a", fetchFn);
  await assert.rejects(f("/api/x"), /boom/);
  assert.equal(calls, 1);
});

test("concurrent first calls share one resolve", async () => {
  let resolves = 0;
  const fetchFn = (async () => new Response("{}")) as typeof fetch;
  const f = createResolvingFetch(async () => {
    resolves++;
    await new Promise((r) => setTimeout(r, 5));
    return "http://a";
  }, fetchFn);
  const [a, b] = await Promise.all([f("/api/x"), f("/api/x")]);
  assert.equal(resolves, 1);
  assert.equal(a.ok && b.ok, true);
});

test("a non-refused failure keeps the cached server", async () => {
  let resolves = 0;
  let fail = false;
  const fetchFn = (async () => {
    if (fail) throw new TypeError("boom");
    return new Response("{}");
  }) as typeof fetch;
  const f = createResolvingFetch(async () => `http://a${resolves++}`, fetchFn);
  await f("/api/x");
  fail = true;
  await assert.rejects(f("/api/x"), /boom/);
  fail = false;
  await f("/api/x");
  assert.equal(resolves, 1);
});

test("a second refused connection on the retry is rethrown", async () => {
  let resolves = 0;
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    throw refused();
  }) as typeof fetch;
  const f = createResolvingFetch(async () => `http://a${resolves++}`, fetchFn);
  await assert.rejects(f("/api/x"), /fetch failed/);
  assert.equal(calls, 2);
  assert.equal(resolves, 2);
});
