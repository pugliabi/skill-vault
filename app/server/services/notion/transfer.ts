/**
 * Pack a vault skill directory into a tar.gz and push it through the Notion
 * Skills API upload flow (prepare → PUT → complete).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import * as tar from "tar";
import type { NotionApi } from "./api.ts";

const SKIP_NAMES = new Set(["node_modules", "__pycache__", ".git", ".DS_Store", "Thumbs.db"]);

function shouldSkip(name: string): boolean {
  return SKIP_NAMES.has(name) || name.startsWith(".temp-");
}

/** Big-endian 4-byte CRC32 of `bytes`, base64-encoded (Notion's `checksum_crc32`). */
export function crc32Base64(bytes: Buffer): string {
  const crc = zlib.crc32(bytes) >>> 0;
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(crc, 0);
  return buf.toString("base64");
}

/**
 * Tar+gzip `dir`'s contents under a single top-level `name/` folder, skipping
 * VCS/build noise. Throws if SKILL.md is not present at the top level of `dir`.
 */
export async function packSkill(dir: string, name: string): Promise<{ bytes: Buffer; crc32Base64: string }> {
  if (!fs.existsSync(path.join(dir, "SKILL.md"))) {
    throw new Error(`packSkill: SKILL.md not found in ${dir}`);
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "sv-pack-"));
  const root = path.join(staging, name);
  try {
    copyTree(dir, root);
    const file = path.join(staging, "archive.tar.gz");
    await tar.c({ gzip: true, cwd: staging, file, portable: true }, [name]);
    const bytes = fs.readFileSync(file);
    return { bytes, crc32Base64: crc32Base64(bytes) };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function copyTree(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (shouldSkip(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(s, d);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
    }
  }
}

/**
 * Pack `dir` as `name`, then run the full Notion Skills API upload sequence:
 * prepare → PUT the bytes with the returned headers → complete. Throws on a
 * non-2xx PUT response.
 */
export async function uploadSkill(
  api: NotionApi,
  pageId: string,
  dir: string,
  name: string,
  putFn: typeof fetch = fetch,
): Promise<void> {
  const { bytes, crc32Base64: checksum } = await packSkill(dir, name);
  const { uploadUrl, headers, token, method } = await api.prepareUpload(pageId, bytes.length, checksum);
  const hasContentLength = Object.keys(headers).some((k) => k.toLowerCase() === "content-length");
  const res = await putFn(uploadUrl, {
    method,
    headers: hasContentLength ? headers : { ...headers, "Content-Length": String(bytes.length) },
    body: new Uint8Array(bytes),
  });
  if (!res.ok) throw new Error(`upload PUT failed: HTTP ${res.status}`);
  await api.completeUpload(pageId, token);
}
