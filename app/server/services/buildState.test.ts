import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isBuildStale } from "../../scripts/build-state.mjs";

const OLDER = new Date(Date.now() - 120_000);
const PAST = new Date(Date.now() - 60_000);
const SOURCES = ["server/index.ts", "client/src/main.tsx", "package.json"];

/** A fake app dir whose sources are all older than a build made at PAST. */
function builtApp(): string {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "sv-build-"));
  for (const rel of SOURCES) {
    fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
    fs.writeFileSync(path.join(app, rel), "x");
    fs.utimesSync(path.join(app, rel), OLDER, OLDER);
  }
  fs.mkdirSync(path.join(app, "dist", "public"), { recursive: true });
  for (const rel of ["dist/launcher.js", "dist/public/index.html", "dist/.build-stamp"]) {
    fs.writeFileSync(path.join(app, rel), "x");
    fs.utimesSync(path.join(app, rel), PAST, PAST);
  }
  return app;
}

test("fresh when every watched file is older than the build stamp", () => {
  assert.equal(isBuildStale(builtApp()), false);
});

test("stale when any build output is missing", () => {
  for (const rel of ["dist/launcher.js", "dist/public/index.html", "dist/.build-stamp"]) {
    const app = builtApp();
    fs.rmSync(path.join(app, rel));
    assert.equal(isBuildStale(app), true, rel);
  }
});

test("stale when a source file or a package file is newer than the stamp", () => {
  const app = builtApp();
  fs.utimesSync(path.join(app, "client/src/main.tsx"), new Date(), new Date());
  assert.equal(isBuildStale(app), true);
  const app2 = builtApp();
  fs.utimesSync(path.join(app2, "package.json"), new Date(), new Date());
  assert.equal(isBuildStale(app2), true);
});

test("a new or edited test file doesn't make the build stale", () => {
  const app = builtApp();
  fs.writeFileSync(path.join(app, "server", "thing.test.ts"), "x");
  assert.equal(isBuildStale(app), false);
});
