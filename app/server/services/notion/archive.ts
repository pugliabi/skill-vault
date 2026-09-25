import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";

/** Largest archive we download (compressed bytes). */
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
/** Largest total of extracted file bytes. */
export const MAX_EXTRACTED_BYTES = 200 * 1024 * 1024;

async function readCapped(res: Response, cap: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    throw new Error(`archive too large: ${declared} bytes (limit ${cap})`);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new Error(`archive too large: more than ${cap} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Download a Notion skill archive (signed https URL) and extract it to a temp
 * dir. Only regular files and directories are extracted (no links or device
 * entries), paths may not escape the target, and both the download and the
 * extracted total are size-capped.
 */
export async function downloadAndExtract(
  url: string,
  fetchFn: typeof fetch = fetch,
  limits: { maxArchiveBytes?: number; maxExtractedBytes?: number } = {},
): Promise<{ dir: string; skillRoot: string; cleanup(): void }> {
  let protocol = "";
  try {
    protocol = new URL(url).protocol;
  } catch {
    /* handled below */
  }
  if (protocol !== "https:") throw new Error("archive URL must be https");
  const maxArchive = limits.maxArchiveBytes ?? MAX_ARCHIVE_BYTES;
  const maxExtracted = limits.maxExtractedBytes ?? MAX_EXTRACTED_BYTES;

  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`archive download failed: HTTP ${res.status}`);
  const buf = await readCapped(res, maxArchive);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-notion-"));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    let extracted = 0;
    let tooBig = false;
    await pipeline(
      Readable.from(buf),
      tar.x({
        cwd: dir,
        strict: true,
        filter: (p, entry) => {
          if (tooBig) return false;
          const type = (entry as { type?: string }).type;
          if (type !== "File" && type !== "Directory") return false;
          if (path.isAbsolute(p) || p.split(/[\\/]/).includes("..")) return false;
          if (type === "File") {
            extracted += (entry as { size?: number }).size ?? 0;
            if (extracted > maxExtracted) {
              tooBig = true;
              return false;
            }
          }
          return true;
        },
      }),
    );
    if (tooBig) throw new Error(`archive expands beyond ${maxExtracted} bytes`);
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const hasRootSkill = entries.some((e) => e.isFile() && e.name === "SKILL.md");
    const dirs = entries.filter((e) => e.isDirectory());
    const skillRoot = !hasRootSkill && dirs.length === 1 && entries.length === 1 ? path.join(dir, dirs[0].name) : dir;
    return { dir, skillRoot, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
