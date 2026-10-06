import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import {
  ClaudeError,
  buildWindowsShellInvocation,
  claudeAvailable,
  createKillTree,
  createRunner,
  createStreamRunner,
  parseClaudeCmdShim,
  resetClaudeAvailableCache,
  runClaudeJson,
  type ChildProcessLike,
  type ClaudeRunner,
  type KillTreeFn,
  type SpawnFn,
} from "./cli.ts";

function fakeRunner(
  fn: (args: string[], stdin: string) => { stdout: string; stderr: string; code: number | null },
): ClaudeRunner & { calls: Array<{ args: string[]; stdin: string; cwd: string; timeoutMs: number }> } {
  const calls: Array<{ args: string[]; stdin: string; cwd: string; timeoutMs: number }> = [];
  const runner = (async (args: string[], stdin: string, opts: { cwd: string; timeoutMs: number }) => {
    calls.push({ args, stdin, cwd: opts.cwd, timeoutMs: opts.timeoutMs });
    return fn(args, stdin);
  }) as ClaudeRunner & { calls: typeof calls };
  runner.calls = calls;
  return runner;
}

test("runClaudeJson sends exactly the specified args, with the prompt on stdin", async () => {
  const runner = fakeRunner(() => ({
    stdout: JSON.stringify({ is_error: false, subtype: "success", structured_output: { ok: true }, total_cost_usd: 0.015 }),
    stderr: "",
    code: 0,
  }));

  const schema = { type: "object", properties: { ok: { type: "boolean" } } };
  const result = await runClaudeJson<{ ok: boolean }>("do the thing", "you are a helper", schema, runner);

  assert.equal(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0].args, [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--system-prompt",
    "you are a helper",
    "--json-schema",
    JSON.stringify(schema),
  ]);
  assert.equal(runner.calls[0].stdin, "do the thing");
  assert.equal(runner.calls[0].timeoutMs, 180_000);
  assert.deepEqual(result.output, { ok: true });
  assert.equal(result.costUsd, 0.015);
});

test("runClaudeJson runs in a fresh temp cwd and cleans it up", async () => {
  const seenCwds: string[] = [];
  const runner = fakeRunner((_args, _stdin) => {
    return { stdout: JSON.stringify({ is_error: false, structured_output: {} }), stderr: "", code: 0 };
  });
  await runClaudeJson("p", "s", {}, runner);
  const cwd = runner.calls[0].cwd;
  assert.ok(cwd.length > 0);
  const fs = await import("node:fs/promises");
  await assert.rejects(fs.stat(cwd));
});

test("is_error:true throws ClaudeError with the result text", async () => {
  const runner = fakeRunner(() => ({
    stdout: JSON.stringify({ is_error: true, result: "boom: bad prompt" }),
    stderr: "",
    code: 1,
  }));
  await assert.rejects(runClaudeJson("p", "s", {}, runner), (err) => {
    assert.ok(err instanceof ClaudeError);
    assert.match(err.message, /boom: bad prompt/);
    return true;
  });
});

test("missing structured_output throws ClaudeError", async () => {
  const runner = fakeRunner(() => ({
    stdout: JSON.stringify({ is_error: false, result: "done" }),
    stderr: "",
    code: 0,
  }));
  await assert.rejects(runClaudeJson("p", "s", {}, runner), ClaudeError);
});

test("non-JSON stdout throws ClaudeError", async () => {
  const runner = fakeRunner(() => ({ stdout: "not json at all", stderr: "some stderr", code: 1 }));
  await assert.rejects(runClaudeJson("p", "s", {}, runner), (err) => {
    assert.ok(err instanceof ClaudeError);
    assert.match(err.message, /some stderr/);
    return true;
  });
});

test("claudeAvailable reports the version on success and caches for 60s", async () => {
  resetClaudeAvailableCache();
  const runner = fakeRunner(() => ({ stdout: "2.1.3\n", stderr: "", code: 0 }));
  const first = await claudeAvailable(runner);
  assert.deepEqual(first, { available: true, version: "2.1.3" });

  const second = await claudeAvailable(runner);
  assert.deepEqual(second, { available: true, version: "2.1.3" });
  assert.equal(runner.calls.length, 1, "second call within the cache window should not re-invoke the runner");
});

test("claudeAvailable reports unavailable with a reason when the runner throws", async () => {
  resetClaudeAvailableCache();
  const runner: ClaudeRunner = async () => {
    throw new Error("ENOENT: claude not found");
  };
  const result = await claudeAvailable(runner);
  assert.equal(result.available, false);
  assert.match(result.reason ?? "", /ENOENT/);
});

test("claudeAvailable reports unavailable with a reason on a non-zero exit", async () => {
  resetClaudeAvailableCache();
  const runner = fakeRunner(() => ({ stdout: "", stderr: "not logged in", code: 1 }));
  const result = await claudeAvailable(runner);
  assert.equal(result.available, false);
  assert.ok(result.reason);
});

test("claudeAvailable reports unavailable with a reason when claude.exe can't be resolved on Windows, without trying --version", async () => {
  resetClaudeAvailableCache();
  let called = false;
  const runner: ClaudeRunner = async () => {
    called = true;
    return { stdout: "2.1.3\n", stderr: "", code: 0 };
  };
  const result = await claudeAvailable(runner, { resolveExe: () => null, platform: "win32" });
  assert.equal(result.available, false);
  assert.match(result.reason ?? "", /claude\.exe/);
  assert.equal(called, false, "must not call --version when the real exe can't be resolved on Windows");
});

test("claudeAvailable does not require exe resolution on non-Windows platforms", async () => {
  resetClaudeAvailableCache();
  const runner = fakeRunner(() => ({ stdout: "2.1.3\n", stderr: "", code: 0 }));
  const result = await claudeAvailable(runner, { resolveExe: () => null, platform: "linux" });
  assert.deepEqual(result, { available: true, version: "2.1.3" });
});

// ── Windows cmd.exe quoting (fallback path used when the real claude.exe
// can't be resolved) — see the long comment above buildWindowsShellInvocation
// in cli.ts for why this exists at all. These are pure string assertions;
// no process is ever spawned here, real CLI or otherwise.
test("buildWindowsShellInvocation wraps in cmd.exe /d /s /c and shells out via ComSpec", () => {
  const inv = buildWindowsShellInvocation("claude", ["-p"]);
  assert.equal(inv.args[0], "/d");
  assert.equal(inv.args[1], "/s");
  assert.equal(inv.args[2], "/c");
  assert.equal(inv.args.length, 4);
  assert.match(inv.args[3], /^".*"$/, "the whole shell command is wrapped in one outer pair of quotes");
});

test("buildWindowsShellInvocation quotes an empty-string argument so it isn't silently dropped", () => {
  const inv = buildWindowsShellInvocation("claude", ["--tools", "", "--strict-mcp-config"]);
  const cmd = inv.args[3];
  // A naked `.join(' ')` (Node's own shell:true behaviour) would collapse
  // "--tools" "" "--strict-mcp-config" down to two adjacent flags with no
  // empty argument between them; ours must keep a distinct, escaped empty
  // quoted token in between so it survives as its own argument.
  assert.ok(cmd.includes('^"^"'), `expected an escaped empty-quote token in: ${cmd}`);
});

test("buildWindowsShellInvocation escapes an argument containing a double quote", () => {
  const inv = buildWindowsShellInvocation("claude", ['say "hi"']);
  // The literal quote must be backslash-escaped for the target program's
  // own argv parser, and the resulting `\"` must itself be caret-escaped
  // for cmd.exe's parse of the surrounding shell command.
  assert.ok(inv.args[3].includes('\\^"'), `expected an escaped quote in: ${inv.args[3]}`);
});

test("buildWindowsShellInvocation keeps a space-containing argument as one token via quoting", () => {
  const inv = buildWindowsShellInvocation("claude", ["hello world"]);
  assert.match(inv.args[3], /\^"hello\^ world\^"/);
});

test("buildWindowsShellInvocation escapes cmd.exe metacharacters like & and %", () => {
  const inv = buildWindowsShellInvocation("claude", ["a&b%c"]);
  assert.ok(inv.args[3].includes("^&"), `expected ^& in: ${inv.args[3]}`);
  assert.ok(inv.args[3].includes("^%"), `expected ^%% in: ${inv.args[3]}`);
});

// ── parseClaudeCmdShim: pure text-in/path-out, no filesystem involved ────

test("parseClaudeCmdShim resolves the standard npm-on-Windows shim template", () => {
  const shim = [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
  ].join("\r\n");
  const resolved = parseClaudeCmdShim(shim, "C:\\nvm4w\\nodejs");
  assert.equal(
    resolved,
    path.resolve("C:\\nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"),
  );
});

test("parseClaudeCmdShim returns null for a shim that doesn't quote a .exe path", () => {
  assert.equal(parseClaudeCmdShim("@ECHO off\r\nnode index.js %*\r\n", "C:\\somewhere"), null);
  assert.equal(parseClaudeCmdShim("", "C:\\somewhere"), null);
});

// ── createKillTree: the low-level kill primitives are injectable so these
// assert exactly how a kill was attempted, without touching a real process.

function makeFakeChild(pid: number | undefined = 111): ChildProcessLike &
  Pick<EventEmitter, "emit"> & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    writtenStdin: string;
    killedWith: unknown[];
  } {
  const emitter = new EventEmitter() as unknown as ChildProcessLike &
    Pick<EventEmitter, "emit"> & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      writtenStdin: string;
      killedWith: unknown[];
      pid?: number;
    };
  (emitter as { pid?: number }).pid = pid;
  emitter.stdout = new EventEmitter();
  emitter.stderr = new EventEmitter();
  emitter.writtenStdin = "";
  emitter.killedWith = [];
  (emitter as unknown as { stdin: ChildProcessLike["stdin"] }).stdin = {
    write: (chunk: string) => {
      emitter.writtenStdin += chunk;
    },
    end: () => {},
  };
  emitter.kill = ((signal?: NodeJS.Signals | number) => {
    emitter.killedWith.push(signal);
    return true;
  }) as ChildProcessLike["kill"];
  return emitter;
}

test("createKillTree on Windows calls the injected taskkill with the child's pid", () => {
  const calls: number[] = [];
  const killTree = createKillTree({ platform: "win32", taskkill: (pid) => calls.push(pid) });
  killTree(makeFakeChild(4242));
  assert.deepEqual(calls, [4242]);
});

test("createKillTree on Windows falls back to child.kill() when there's no pid", () => {
  const killTree = createKillTree({
    platform: "win32",
    taskkill: () => {
      throw new Error("must not be called without a pid");
    },
  });
  const child = makeFakeChild();
  delete (child as { pid?: number }).pid;
  killTree(child);
  assert.deepEqual(child.killedWith, [undefined]);
});

test("createKillTree elsewhere kills the whole process group via the injected killGroup", () => {
  const calls: number[] = [];
  const killTree = createKillTree({ platform: "linux", killGroup: (pid) => calls.push(pid) });
  killTree(makeFakeChild(555));
  assert.deepEqual(calls, [555]);
});

test("createKillTree elsewhere falls back to child.kill('SIGKILL') when killGroup throws", () => {
  const killTree = createKillTree({
    platform: "linux",
    killGroup: () => {
      throw new Error("ESRCH: no such process");
    },
  });
  const child = makeFakeChild(555);
  killTree(child);
  assert.deepEqual(child.killedWith, ["SIGKILL"]);
});

// ── createRunner: fake spawn + fake kill, proving the wiring end to end ──

test("createRunner resolves with stdout/stderr/code on a normal close, and writes the prompt to stdin", async () => {
  const child = makeFakeChild(101);
  const spawnCalls: Array<{ command: string; args: string[] }> = [];
  const spawnFn: SpawnFn = (command, args) => {
    spawnCalls.push({ command, args });
    return child;
  };
  const killCalls: ChildProcessLike[] = [];
  const killTreeFn: KillTreeFn = (c) => killCalls.push(c);

  const runner = createRunner(spawnFn, killTreeFn, { resolveExe: () => "C:\\fake\\claude.exe", platform: "win32" });
  const promise = runner(["--version"], "hello prompt", { cwd: "C:\\tmp\\x", timeoutMs: 5000 });

  child.stdout.emit("data", "out1");
  child.stderr.emit("data", "err1");
  child.emit("close", 0);

  const result = await promise;
  assert.equal(result.stdout, "out1");
  assert.equal(result.stderr, "err1");
  assert.equal(result.code, 0);
  assert.equal(killCalls.length, 0, "no timeout, so the kill tree must never be invoked");
  assert.equal(child.writtenStdin, "hello prompt");
  assert.deepEqual(spawnCalls, [{ command: "C:\\fake\\claude.exe", args: ["--version"] }]);
});

test("createRunner kills the whole tree and rejects when the timeout fires — the promise always settles", async () => {
  const child = makeFakeChild(222);
  const spawnFn: SpawnFn = () => child;
  const killCalls: ChildProcessLike[] = [];
  const killTreeFn: KillTreeFn = (c) => killCalls.push(c);

  const runner = createRunner(spawnFn, killTreeFn, { resolveExe: () => "C:\\fake\\claude.exe", platform: "win32" });
  const promise = runner(["-p"], "hi", { cwd: "C:\\tmp", timeoutMs: 10 });

  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ClaudeError);
    assert.match(err.message, /timed out after/);
    return true;
  });
  assert.equal(killCalls.length, 1);
  assert.equal(killCalls[0], child);

  // A late `close` (e.g. the kill eventually succeeding) must not reject/resolve again.
  assert.doesNotThrow(() => child.emit("close", null));
});

test("createRunner refuses (never spawns) a newline-containing arg on Windows when claude.exe can't be resolved", async () => {
  let spawned = false;
  const spawnFn: SpawnFn = () => {
    spawned = true;
    return makeFakeChild();
  };
  const runner = createRunner(spawnFn, () => {}, { resolveExe: () => null, platform: "win32" });

  await assert.rejects(
    runner(["--system-prompt", "line one\nline two"], "hi", { cwd: "C:\\tmp", timeoutMs: 1000 }),
    (err) => {
      assert.ok(err instanceof ClaudeError);
      assert.match(err.message, /could not be launched safely/);
      return true;
    },
  );
  assert.equal(spawned, false);
});

test("createRunner falls back to the escaped cmd.exe invocation for newline-free args when claude.exe can't be resolved", async () => {
  const child = makeFakeChild();
  let capturedCommand = "";
  let capturedOptions: Record<string, unknown> = {};
  const spawnFn: SpawnFn = (command, _args, options) => {
    capturedCommand = command;
    capturedOptions = options as Record<string, unknown>;
    return child;
  };

  const runner = createRunner(spawnFn, () => {}, { resolveExe: () => null, platform: "win32" });
  const promise = runner(["--version"], "", { cwd: "C:\\tmp", timeoutMs: 1000 });
  child.emit("close", 0);
  await promise;

  assert.match(capturedCommand.toLowerCase(), /cmd\.exe$/);
  assert.equal(capturedOptions.windowsVerbatimArguments, true);
});

test("createRunner survives a stdin EPIPE (child exits before reading) and still settles via close", async () => {
  const child = makeFakeChild(303);
  const stdin = new EventEmitter() as EventEmitter & { write(c: string): void; end(): void };
  stdin.write = () => {};
  stdin.end = () => {};
  (child as unknown as { stdin: unknown }).stdin = stdin;
  const runner = createRunner(() => child, () => {}, { resolveExe: () => "C:\fake\claude.exe", platform: "win32" });
  const promise = runner(["-p"], "prompt", { cwd: "C:\tmp", timeoutMs: 5000 });

  const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  // With no "error" listener on stdin, EventEmitter#emit("error") throws — the runner must attach one.
  assert.doesNotThrow(() => stdin.emit("error", epipe));
  child.emit("close", 1);

  const result = await promise;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /EPIPE/);
});

test("createRunner kills the whole tree and rejects when the caller aborts", async () => {
  const child = makeFakeChild(404);
  const killCalls: ChildProcessLike[] = [];
  const runner = createRunner(() => child, (c) => killCalls.push(c), {
    resolveExe: () => "C:\fake\claude.exe",
    platform: "win32",
  });
  const ac = new AbortController();
  const promise = runner(["-p"], "hi", { cwd: "C:\tmp", timeoutMs: 60_000, signal: ac.signal });
  ac.abort();
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ClaudeError);
    assert.match(err.message, /aborted/);
    return true;
  });
  assert.deepEqual(killCalls, [child]);
  assert.doesNotThrow(() => child.emit("close", null));
});

test("createRunner never spawns when the signal is already aborted", async () => {
  let spawned = 0;
  const runner = createRunner(
    () => {
      spawned++;
      return makeFakeChild();
    },
    () => {},
    { resolveExe: () => "C:\fake\claude.exe", platform: "win32" },
  );
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(runner(["-p"], "", { cwd: "C:\tmp", timeoutMs: 1000, signal: ac.signal }), /aborted/);
  assert.equal(spawned, 0);
});

test("runClaudeJson appends --model only when asked and forwards the abort signal", async () => {
  let seenSignal: AbortSignal | undefined;
  const calls: string[][] = [];
  const runner: ClaudeRunner = async (args, _stdin, opts) => {
    calls.push(args);
    seenSignal = opts.signal;
    return { stdout: JSON.stringify({ structured_output: {} }), stderr: "", code: 0 };
  };
  const ac = new AbortController();
  await runClaudeJson("p", "s", {}, runner, { model: "sonnet", signal: ac.signal });
  assert.deepEqual(calls[0].slice(-2), ["--model", "sonnet"]);
  assert.equal(seenSignal, ac.signal);
  await runClaudeJson("p", "s", {}, runner);
  assert.ok(!calls[1].includes("--model"));
});

// ── createStreamRunner ───────────────────────────────────────────────────

test("createStreamRunner reassembles lines across chunk boundaries, strips CR, and flushes the tail on close", async () => {
  const child = makeFakeChild(501);
  const lines: string[] = [];
  const runner = createStreamRunner(() => child, () => {}, { resolveExe: () => "C:\fake\claude.exe", platform: "win32" });
  const promise = runner(["-p"], "hi", {
    cwd: "C:\tmp",
    idleTimeoutMs: 5000,
    hardTimeoutMs: 10_000,
    onLine: (l) => lines.push(l),
  });

  child.stdout.emit("data", '{"a":');
  child.stdout.emit("data", '1}\r\n{"b":2}\n{"c"');
  child.stdout.emit("data", ":3}"); // no trailing newline — must still be delivered on close
  child.emit("close", 0);

  const result = await promise;
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
  assert.equal(result.code, 0);
  assert.equal(child.writtenStdin, "hi");
});

test("createStreamRunner skips blank lines and never calls onLine after settle", async () => {
  const child = makeFakeChild(502);
  const lines: string[] = [];
  const killCalls: ChildProcessLike[] = [];
  const runner = createStreamRunner(() => child, (c) => killCalls.push(c), {
    resolveExe: () => "C:\fake\claude.exe",
    platform: "win32",
  });
  const ac = new AbortController();
  const promise = runner(["-p"], "", {
    cwd: "C:\tmp",
    idleTimeoutMs: 5000,
    hardTimeoutMs: 10_000,
    signal: ac.signal,
    onLine: (l) => lines.push(l),
  });

  child.stdout.emit("data", "one\n\n\r\n");
  ac.abort();
  child.stdout.emit("data", "late\n");
  await assert.rejects(promise, /aborted/);
  assert.deepEqual(lines, ["one"]);
  assert.deepEqual(killCalls, [child]);
  assert.doesNotThrow(() => child.emit("close", null));
});

test("createStreamRunner rejects via the idle timeout when the CLI goes quiet", async () => {
  const child = makeFakeChild(503);
  const killCalls: ChildProcessLike[] = [];
  const runner = createStreamRunner(() => child, (c) => killCalls.push(c), {
    resolveExe: () => "C:\fake\claude.exe",
    platform: "win32",
  });
  const promise = runner(["-p"], "", {
    cwd: "C:\tmp",
    idleTimeoutMs: 20,
    hardTimeoutMs: 60_000,
    onLine: () => {},
  });
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ClaudeError);
    assert.match(err.message, /no output for/);
    return true;
  });
  assert.deepEqual(killCalls, [child]);
});

test("createStreamRunner enforces the hard cap even while lines keep flowing", async () => {
  const child = makeFakeChild(504);
  const killCalls: ChildProcessLike[] = [];
  const runner = createStreamRunner(() => child, (c) => killCalls.push(c), {
    resolveExe: () => "C:\fake\claude.exe",
    platform: "win32",
  });
  const promise = runner(["-p"], "", {
    cwd: "C:\tmp",
    idleTimeoutMs: 60_000,
    hardTimeoutMs: 30,
    onLine: () => {},
  });
  const feeder = setInterval(() => child.stdout.emit("data", "tick\n"), 5);
  try {
    await assert.rejects(promise, (err) => {
      assert.ok(err instanceof ClaudeError);
      assert.match(err.message, /turn cap/);
      return true;
    });
  } finally {
    clearInterval(feeder);
  }
  assert.deepEqual(killCalls, [child]);
});
