import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { downloadAndExtract } from "./archive.ts";

test("extracts a single-folder archive and finds the skill root", async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "sv-arc-src-"));
  fs.mkdirSync(path.join(src, "demo", "references"), { recursive: true });
  fs.writeFileSync(path.join(src, "demo", "SKILL.md"), "---\nname: demo\n---\n");
  fs.writeFileSync(path.join(src, "demo", "references", "a.md"), "a");
  const file = path.join(src, "demo.tar.gz");
  await tar.c({ gzip: true, cwd: src, file }, ["demo"]);
  const bytes = fs.readFileSync(file);
  const fakeFetch = (async () => new Response(bytes)) as unknown as typeof fetch;
  const out = await downloadAndExtract("https://x.test/demo.tar.gz", fakeFetch);
  try {
    assert.equal(path.basename(out.skillRoot), "demo");
    assert.equal(fs.readFileSync(path.join(out.skillRoot, "references", "a.md"), "utf8"), "a");
  } finally {
    out.cleanup();
  }
  assert.equal(fs.existsSync(out.dir), false);
});

/** Build an uncompressed tar from raw entries (lets tests include link entries). */
function rawTar(entries: Array<{ path: string; type: string; body?: string; linkpath?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? "");
    const h = new tar.Header({
      path: e.path,
      type: e.type as any,
      size: e.type === "File" ? body.length : 0,
      mode: e.type === "Directory" ? 0o755 : 0o644,
      mtime: new Date(0),
      ...(e.linkpath ? { linkpath: e.linkpath } : {}),
    });
    const block = Buffer.alloc(512);
    h.encode(block, 0);
    blocks.push(block);
    if (e.type === "File" && body.length) {
      const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
      body.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const serve = (bytes: Buffer) => (async () => new Response(new Uint8Array(bytes))) as unknown as typeof fetch;

test("only regular files and directories are extracted", async () => {
  const bytes = rawTar([
    { path: "demo/", type: "Directory" },
    { path: "demo/SKILL.md", type: "File", body: "---\nname: demo\n---\n" },
    { path: "demo/link", type: "SymbolicLink", linkpath: "../../outside" },
    { path: "demo/hard", type: "Link", linkpath: "demo/SKILL.md" },
  ]);
  const out = await downloadAndExtract("https://x.test/a.tar", serve(bytes));
  try {
    assert.deepEqual(fs.readdirSync(out.skillRoot).sort(), ["SKILL.md"]);
  } finally {
    out.cleanup();
  }
});

test("rejects non-https archive URLs without fetching", async () => {
  let called = false;
  const f = (async () => {
    called = true;
    return new Response("");
  }) as unknown as typeof fetch;
  await assert.rejects(downloadAndExtract("http://x.test/a.tar", f), /https/);
  await assert.rejects(downloadAndExtract("file:///etc/passwd", f), /https/);
  await assert.rejects(downloadAndExtract("not a url", f), /https/);
  assert.equal(called, false);
});

test("caps the download size", async () => {
  const bytes = rawTar([{ path: "SKILL.md", type: "File", body: "x".repeat(4000) }]);
  await assert.rejects(
    downloadAndExtract("https://x.test/a.tar", serve(bytes), { maxArchiveBytes: 1000 }),
    /too large/,
  );
});

test("caps the total extracted size", async (t) => {
  const bytes = rawTar([
    { path: "SKILL.md", type: "File", body: "x".repeat(600) },
    { path: "b.md", type: "File", body: "y".repeat(600) },
  ]);
  // Track the exact temp dir this call creates: counting sv-notion-* entries in the
  // shared tmpdir races with other test files running in parallel.
  const created: string[] = [];
  const realMkdtemp = fs.mkdtempSync;
  t.mock.method(fs, "mkdtempSync", (...args: Parameters<typeof fs.mkdtempSync>) => {
    const dir = realMkdtemp(...args) as string;
    created.push(dir);
    return dir;
  });
  await assert.rejects(
    downloadAndExtract("https://x.test/a.tar", serve(bytes), { maxExtractedBytes: 1000 }),
    /expands beyond/,
  );
  assert.equal(created.length, 1, "one temp dir was created");
  assert.equal(fs.existsSync(created[0]), false, "temp dir cleaned up");
});
