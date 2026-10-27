import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLogSink, rotateLog } from "./logFile.ts";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpLog = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sv-log-")), "logs", "server.log");
const read = (f: string) => fs.readFileSync(f, "utf8");

test("the sink appends, rotating into .1 … .keep before the file would pass maxBytes", () => {
  const file = tmpLog();
  const sink = createLogSink(file, 10, 2);
  sink("aaaaaaaa");
  sink("bbbbbbbb");
  sink("cccccccc");
  sink("dddddddd");
  assert.equal(read(file), "dddddddd");
  assert.equal(read(`${file}.1`), "cccccccc");
  assert.equal(read(`${file}.2`), "bbbbbbbb");
  assert.equal(fs.existsSync(`${file}.3`), false, "only `keep` old files are kept");
});

test("an existing file's size counts toward the limit", () => {
  const file = tmpLog();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "123456789");
  const sink = createLogSink(file, 10, 3);
  sink("xx");
  assert.equal(read(`${file}.1`), "123456789");
  assert.equal(read(file), "xx");
});

test("a sink under an unusable path never throws, on creation or on write", () => {
  const blocker = tmpLog();
  fs.mkdirSync(path.dirname(blocker), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(blocker), "x"), "not a directory");
  const file = path.join(path.dirname(blocker), "x", "logs", "server.log");
  let sink: (chunk: string) => void = () => {};
  assert.doesNotThrow(() => {
    sink = createLogSink(file);
  });
  assert.doesNotThrow(() => sink("hello"));
});

/** Run a child that installs the tee on `file`, then runs `crash` (ESM, top level). */
function runWithLogFile(file: string, crash: string): { status: number | null; stderr: string } {
  const tsx = pathToFileURL(path.join(APP, "node_modules", "tsx", "dist", "loader.mjs")).href;
  const logFile = pathToFileURL(path.join(APP, "server", "services", "logFile.ts")).href;
  const script = `import { installLogFile } from ${JSON.stringify(logFile)};\ninstallLogFile(${JSON.stringify(file)});\n${crash}\n`;
  const r = spawnSync(process.execPath, ["--import", tsx, "--input-type=module", "--eval", script], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: r.status, stderr: r.stderr };
}

test("an uncaught exception's stack reaches the log file, not just the console", () => {
  const file = tmpLog();
  // From a callback: a top-level throw in an ES module surfaces as a rejection.
  const r = runWithLogFile(file, `console.log("before the crash");\nsetTimeout(() => { throw new Error("boom from the test"); }, 0);`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /boom from the test/, "still printed to the console");
  const log = read(file);
  assert.match(log, /before the crash/);
  assert.match(log, /\[uncaughtException\] Error: boom from the test\n\s+at /);
});

test("an unhandled rejection's stack reaches the log file too", () => {
  const file = tmpLog();
  const r = runWithLogFile(file, `Promise.reject(new Error("rejected in the test"));`);
  assert.notEqual(r.status, 0);
  assert.match(read(file), /\[unhandledRejection\] Error: rejected in the test/);
});

test("rotateLog shifts files and drops the oldest", () => {
  const file = tmpLog();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const [f, body] of [[file, "0"], [`${file}.1`, "1"], [`${file}.2`, "2"]] as const) fs.writeFileSync(f, body);
  rotateLog(file, 2);
  assert.equal(fs.existsSync(file), false);
  assert.equal(read(`${file}.1`), "0");
  assert.equal(read(`${file}.2`), "1");
});
