import fs from "node:fs";

/**
 * True only for a regular file. `fs.existsSync` is also true for a directory, and on
 * case-insensitive disks a folder named `skill.md/` answers to `SKILL.md`; reading it
 * then throws EISDIR.
 */
export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
