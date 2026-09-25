import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadAndExtract } from "./archive.ts";
import { NotionApi } from "./api.ts";
import { packSkill, uploadSkill, crc32Base64 } from "./transfer.ts";

function makeSkillDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-pack-src-"));
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: demo\n---\nbody");
  fs.mkdirSync(path.join(dir, "references"));
  fs.writeFileSync(path.join(dir, "references", "a.md"), "a");
  fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "x", "y.js"), "y");
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "config"), "z");
  fs.writeFileSync(path.join(dir, ".DS_Store"), "ds");
  fs.writeFileSync(path.join(dir, "Thumbs.db"), "tb");
  fs.mkdirSync(path.join(dir, "__pycache__"));
  fs.writeFileSync(path.join(dir, "__pycache__", "c.pyc"), "c");
  fs.mkdirSync(path.join(dir, ".temp-abc"));
  fs.writeFileSync(path.join(dir, ".temp-abc", "d"), "d");
  return dir;
}

test("packSkill produces a tar.gz rooted at name/ that round-trips through extraction", async () => {
  const dir = makeSkillDir();
  const { bytes } = await packSkill(dir, "demo");
  const fakeFetch = (async () => new Response(new Uint8Array(bytes))) as unknown as typeof fetch;
  const out = await downloadAndExtract("https://x.test/demo.tar.gz", fakeFetch);
  try {
    assert.equal(path.basename(out.skillRoot), "demo");
    assert.equal(fs.readFileSync(path.join(out.skillRoot, "SKILL.md"), "utf8"), "---\nname: demo\n---\nbody");
    assert.equal(fs.readFileSync(path.join(out.skillRoot, "references", "a.md"), "utf8"), "a");
    assert.equal(fs.existsSync(path.join(out.skillRoot, "node_modules")), false);
    assert.equal(fs.existsSync(path.join(out.skillRoot, ".git")), false);
    assert.equal(fs.existsSync(path.join(out.skillRoot, ".DS_Store")), false);
    assert.equal(fs.existsSync(path.join(out.skillRoot, "Thumbs.db")), false);
    assert.equal(fs.existsSync(path.join(out.skillRoot, "__pycache__")), false);
    assert.equal(fs.existsSync(path.join(out.skillRoot, ".temp-abc")), false);
  } finally {
    out.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("crc32Base64 matches the known CRC32 of Buffer.from('hello')", () => {
  assert.equal(crc32Base64(Buffer.from("hello")), "NhCmhg==");
});

test("packSkill returns a non-empty crc32Base64 alongside the archive bytes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-pack-crc-"));
  try {
    fs.writeFileSync(path.join(dir, "SKILL.md"), "hello");
    const { bytes, crc32Base64: checksum } = await packSkill(dir, "demo");
    assert.equal(checksum, crc32Base64(bytes));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("packSkill throws when SKILL.md is missing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-pack-nofile-"));
  try {
    fs.writeFileSync(path.join(dir, "notes.md"), "x");
    await assert.rejects(packSkill(dir, "demo"), /SKILL\.md/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NotionApi.prepareUpload and completeUpload call the right tools (real array-form headers)", async () => {
  const seen: any[] = [];
  const api = new NotionApi(async (name, args) => {
    seen.push({ name, args });
    if (name === "notion-upload-skill" && (args as any).action === "prepare") {
      return {
        upload_url: "https://up.test/put",
        upload_headers: [
          { name: "Content-Type", value: "application/gzip" },
          { name: "x-amz-checksum-crc32", value: "NhCmhg==" },
          { name: "Content-Length", value: "82193" },
          { name: "x-amz-tagging", value: "source=vault" },
        ],
        upload_token: "tok",
        upload_method: "PUT",
        status: "pending",
      };
    }
    return {};
  });
  const prepared = await api.prepareUpload("page1", 10, "NhCmhg==");
  assert.deepEqual(prepared, {
    uploadUrl: "https://up.test/put",
    headers: {
      "Content-Type": "application/gzip",
      "x-amz-checksum-crc32": "NhCmhg==",
      "Content-Length": "82193",
      "x-amz-tagging": "source=vault",
    },
    token: "tok",
    method: "PUT",
  });
  assert.deepEqual(seen[0], {
    name: "notion-upload-skill",
    args: { action: "prepare", page_id: "page1", content_length: 10, checksum_crc32: "NhCmhg==" },
  });
  await api.completeUpload("page1", "tok");
  assert.deepEqual(seen[1], {
    name: "notion-upload-skill",
    args: { action: "complete", page_id: "page1", upload_token: "tok" },
  });
});

test("NotionApi.prepareUpload accepts camelCase result fields and object-shape headers", async () => {
  const api = new NotionApi(async () => ({ uploadUrl: "https://up.test/put", uploadHeaders: { a: "b" }, uploadToken: "tok2" }));
  const prepared = await api.prepareUpload("page1", 10, "NhCmhg==");
  assert.deepEqual(prepared, { uploadUrl: "https://up.test/put", headers: { a: "b" }, token: "tok2", method: "PUT" });
});

test("NotionApi.createSkillPage returns the parsed page id from the created page url", async () => {
  const seen: any[] = [];
  const api = new NotionApi(async (name, args) => {
    seen.push({ name, args });
    return { text: "created page at https://app.notion.com/p/aaaaaaaabbbbccccddddeeeeeeeeeeee" };
  });
  const id = await api.createSkillPage("ds1", "demo", "a description");
  assert.equal(id, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(seen[0].name, "notion-create-pages");
  assert.deepEqual(seen[0].args, {
    parent: { data_source_id: "ds1" },
    pages: [{ properties: { "Skill name": "demo", Description: "a description" }, is_skill: true }],
  });
});

test("NotionApi.createSkillPage finds a bare 32-hex id when there is no url", async () => {
  const api = new NotionApi(async () => ({ results: [{ id: "aaaaaaaabbbbccccddddeeeeeeeeeeee" }] }));
  const id = await api.createSkillPage("ds1", "demo", "d");
  assert.equal(id, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
});

test("NotionApi.createSkillPage throws when no id can be found", async () => {
  const api = new NotionApi(async () => ({ text: "no id here" }));
  await assert.rejects(api.createSkillPage("ds1", "demo", "d"), /no page id/);
});

test("NotionApi.setTitle calls notion-update-page with update_properties", async () => {
  const seen: any[] = [];
  const api = new NotionApi(async (name, args) => {
    seen.push({ name, args });
    return {};
  });
  await api.setTitle("page1", "restored title");
  assert.deepEqual(seen[0], {
    name: "notion-update-page",
    args: { page_id: "page1", command: "update_properties", properties: { "Skill name": "restored title" } },
  });
});

test("uploadSkill calls prepare, PUT (with array-form headers, no duplicate Content-Length), then complete in order with a matching token", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-upload-"));
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: demo\n---\n");
  try {
    const calls: string[] = [];
    const api = new NotionApi(async (name, args) => {
      calls.push(name);
      if (name === "notion-upload-skill" && (args as any).action === "prepare") {
        assert.equal((args as any).page_id, "page1");
        return {
          upload_url: "https://up.test/put",
          upload_headers: [
            { name: "Content-Type", value: "application/gzip" },
            { name: "x-amz-checksum-crc32", value: "NhCmhg==" },
            { name: "Content-Length", value: "999999" },
            { name: "x-amz-tagging", value: "source=vault" },
          ],
          upload_token: "tok-123",
          upload_method: "PUT",
        };
      }
      if (name === "notion-upload-skill" && (args as any).action === "complete") {
        assert.equal((args as any).upload_token, "tok-123");
      }
      return {};
    });
    let putMethod: string | undefined;
    let putHeaders: Record<string, string> | undefined;
    let putBody: unknown;
    const putFn = (async (url: unknown, init?: RequestInit) => {
      calls.push("PUT " + String(url));
      putMethod = init?.method;
      putHeaders = init?.headers as Record<string, string>;
      putBody = init?.body;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    await uploadSkill(api, "page1", dir, "demo", putFn);

    assert.deepEqual(calls, ["notion-upload-skill", "PUT https://up.test/put", "notion-upload-skill"]);
    assert.equal(putMethod, "PUT");
    assert.equal(putHeaders?.["Content-Type"], "application/gzip");
    assert.equal(putHeaders?.["x-amz-checksum-crc32"], "NhCmhg==");
    assert.equal(putHeaders?.["x-amz-tagging"], "source=vault");
    // The value Notion supplied is kept as-is, not overwritten by our own byte count.
    assert.equal(putHeaders?.["Content-Length"], "999999");
    assert.equal(Object.keys(putHeaders ?? {}).length, 4);
    assert.ok(Buffer.isBuffer(putBody) || putBody instanceof Uint8Array);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("uploadSkill adds Content-Length only when the prepare response omits it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-upload-nocl-"));
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: demo\n---\n");
  try {
    const api = new NotionApi(async (name, args) => {
      if (name === "notion-upload-skill" && (args as any).action === "prepare") {
        return { upload_url: "https://up.test/put", upload_headers: { "x-h": "1" }, upload_token: "tok" };
      }
      return {};
    });
    let putHeaders: Record<string, string> | undefined;
    const putFn = (async (_url: unknown, init?: RequestInit) => {
      putHeaders = init?.headers as Record<string, string>;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    await uploadSkill(api, "page1", dir, "demo", putFn);

    assert.equal(putHeaders?.["x-h"], "1");
    assert.ok(Number(putHeaders?.["Content-Length"]) > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("uploadSkill throws with the status when PUT is not 2xx", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-upload-403-"));
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: demo\n---\n");
  try {
    const api = new NotionApi(async (name, args) => {
      if ((args as any).action === "prepare") {
        return { upload_url: "https://up.test/put", upload_headers: {}, upload_token: "tok" };
      }
      return {};
    });
    const putFn = (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    await assert.rejects(uploadSkill(api, "page1", dir, "demo", putFn), /403/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
