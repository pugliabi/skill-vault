/**
 * Single source of truth for skill-name validation.
 *
 * Used by:
 *   - POST /api/skills              (create — NEW-02)
 *   - POST /api/skills/:name/rename (rename — RENAME-01)
 *
 * Both routes surface ValidateResult.reason verbatim as the 409
 * `{ error: ... }` message. Keep reasons short and human-readable —
 * they appear inline below the input field on the client.
 */

import fs from "node:fs";
import { IGNORE_NAMES } from "./skillHash.ts";
import { readManifest, skillDir } from "./vault.ts";

/**
 * Slug regex — lowercase, digits, hyphens. 2–64 chars total. Cannot
 * start or end with a hyphen. Mirrored on the client (Skills.tsx /
 * NewSkillDrawer.tsx) for instant inline feedback; server is
 * authoritative.
 */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

export type ValidateResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate a skill name against:
 *   1. SLUG_RE (format)
 *   2. IGNORE_NAMES (reserved — node_modules, .git, etc.)
 *   3. Manifest uniqueness (already a key in skills.json)
 *   4. On-disk uniqueness (already a folder under <vault>/skills/)
 *
 * Returns on the FIRST failure — order is deliberate so the most
 * obvious error (bad format) is reported before the more expensive
 * filesystem check.
 */
export function validateSkillName(
  vaultPath: string,
  name: string,
): ValidateResult {
  if (typeof name !== "string" || !SLUG_RE.test(name)) {
    return {
      ok: false,
      reason: "name must be a slug: lowercase letters, digits, hyphens; 2–64 chars; cannot start or end with -",
    };
  }
  if (IGNORE_NAMES.has(name)) {
    return { ok: false, reason: `"${name}" is a reserved name` };
  }
  const manifest = readManifest(vaultPath);
  if (manifest.skills[name]) {
    return { ok: false, reason: `a skill named "${name}" already exists in the manifest` };
  }
  const dir = skillDir(vaultPath, name);
  if (fs.existsSync(dir)) {
    return { ok: false, reason: `a folder named "${name}" already exists in <vault>/skills/` };
  }
  return { ok: true };
}
