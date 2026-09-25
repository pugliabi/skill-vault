import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isFile } from "./fsUtil.ts";

test("isFile is true for a file and false for a directory or a missing path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-fsutil-"));
  try {
    fs.writeFileSync(path.join(dir, "a.md"), "x");
    fs.mkdirSync(path.join(dir, "skill.md"));
    assert.equal(isFile(path.join(dir, "a.md")), true);
    assert.equal(isFile(path.join(dir, "skill.md")), false, "a folder named like a file is not a file");
    assert.equal(isFile(path.join(dir, "missing.md")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
