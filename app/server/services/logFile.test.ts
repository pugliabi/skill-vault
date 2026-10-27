import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogSink, rotateLog } from "./logFile.ts";

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

test("rotateLog shifts files and drops the oldest", () => {
  const file = tmpLog();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const [f, body] of [[file, "0"], [`${file}.1`, "1"], [`${file}.2`, "2"]] as const) fs.writeFileSync(f, body);
  rotateLog(file, 2);
  assert.equal(fs.existsSync(file), false);
  assert.equal(read(`${file}.1`), "0");
  assert.equal(read(`${file}.2`), "1");
});
