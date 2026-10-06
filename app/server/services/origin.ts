/**
 * Origin repair: rewrite a skill's structured `origin` block so update
 * checks can find its source again.
 *
 * This is the server half of the assistant's "gone upstream" fix flow
 * (repo-hunter finds where a skill moved → `set_origin` → `apply_update`),
 * but it is an ordinary API capability — nothing about it is AI-specific.
 *
 * Semantics follow docs/vault-format.md § SkillEntry.origin:
 *   - the caller provides the *location* fields (type/url/path/provider_id/
 *     subpath/ref); this service stamps `adopted_at` (now) and
 *     `content_hash` (normalized hash of the vault copy, "empty" fallback —
 *     matching the Python CLI's build_origin),
 *   - unknown keys inside an existing origin round-trip untouched,
 *   - known location fields are replaced wholesale (switching a dir origin
 *     to git must not leave a stale `path` behind).
 *
 * With `verify: true` the rewritten origin is immediately re-checked via
 * checkUpdates so the caller learns in one round-trip whether the repair
 * worked (e.g. status flipped from `upstream_missing` to `update_available`).
 */

import { Buffer } from "node:buffer";
import type { ManifestSkill, SkillOrigin, UpdateCheckResult } from "../types/vault.ts";
import { recordActivity } from "./activity.ts";
import { checkUpdates } from "./updates.ts";
import { hashSkillDirNormalized } from "./skillHash.ts";
import { patchManifestSkill, readManifest, skillDir } from "./vault.ts";

/** Thrown for caller mistakes — routes map it to a 4xx. */
export class OriginError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The location fields a caller may set; stamps are never caller-supplied. */
export interface OriginInput {
  type: "git" | "dir" | "provider";
  url?: string;
  path?: string;
  provider_id?: string;
  subpath?: string;
  ref?: string;
}

/** Location keys owned by this service — replaced wholesale on every set. */
const LOCATION_KEYS = ["type", "url", "path", "provider_id", "subpath", "ref"] as const;
const STAMP_KEYS = ["adopted_at", "content_hash"] as const;

function validate(input: OriginInput): void {
  if (input.type !== "git" && input.type !== "dir" && input.type !== "provider") {
    throw new OriginError(400, `origin.type must be "git", "dir", or "provider"`);
  }
  if (input.type === "git" && !input.url && !input.path) {
    throw new OriginError(400, "git origin requires a url (or a local clone path)");
  }
  if (input.type === "dir" && !input.path) {
    throw new OriginError(400, "dir origin requires a path");
  }
  if (input.type === "provider" && !input.provider_id) {
    throw new OriginError(400, "provider origin requires a provider_id");
  }
  if (input.url !== undefined && typeof input.url !== "string") {
    throw new OriginError(400, "origin.url must be a string");
  }
  const subpath = input.subpath ?? "";
  if (typeof subpath !== "string" || subpath.includes("\\") || subpath.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(subpath)) {
    throw new OriginError(400, `origin.subpath must be a relative "/"-separated path without ".."`);
  }
}

export interface SetOriginResult {
  entry: ManifestSkill;
  /** Present when the caller asked to verify — the fresh update check. */
  check?: UpdateCheckResult;
}

export async function setSkillOrigin(
  vaultPath: string,
  name: string,
  input: OriginInput,
  opts: {
    verify?: boolean;
    /** Injectable for tests. */
    check?: typeof checkUpdates;
  } = {},
): Promise<SetOriginResult> {
  validate(input);

  const manifest = readManifest(vaultPath);
  const existing = manifest.skills[name];
  if (!existing) {
    throw new OriginError(404, `skill not found: ${name}`);
  }

  // Unknown keys round-trip; location fields are replaced wholesale.
  const carried: Record<string, unknown> = {};
  const prior = (existing.origin ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(prior)) {
    if (!(LOCATION_KEYS as readonly string[]).includes(k) && !(STAMP_KEYS as readonly string[]).includes(k)) {
      carried[k] = v;
    }
  }

  const origin: SkillOrigin = {
    ...carried,
    type: input.type,
    ...(input.url ? { url: input.url } : {}),
    ...(input.path ? { path: input.path } : {}),
    ...(input.provider_id ? { provider_id: input.provider_id } : {}),
    subpath: input.subpath ?? "",
    ...(input.ref ? { ref: input.ref } : {}),
    adopted_at: new Date().toISOString(),
    content_hash: hashSkillDirNormalized(skillDir(vaultPath, name)) ?? "empty",
  };

  const entry = patchManifestSkill(vaultPath, name, { origin });
  if (!entry) {
    throw new OriginError(404, `skill not found: ${name}`);
  }

  let check: UpdateCheckResult | undefined;
  let ok = true;
  let message = describeOrigin(origin);
  try {
    if (opts.verify) {
      const results = await (opts.check ?? checkUpdates)(vaultPath, [name]);
      check = results[0];
      if (check) {
        message += ` — recheck: ${check.status}${check.message ? ` (${check.message})` : ""}`;
        ok = check.status !== "error" && check.status !== "source_missing" && check.status !== "upstream_missing";
      }
    }
  } finally {
    recordActivity({ kind: "update", skill: name, ok, message: `origin set: ${message}` });
  }

  return { entry, check };
}

function describeOrigin(origin: SkillOrigin): string {
  const where = origin.type === "git" && origin.url ? origin.url : (origin.path ?? origin.provider_id ?? "?");
  const sub = origin.subpath ? ` @ ${origin.subpath}` : "";
  const ref = origin.ref ? ` (${origin.ref})` : "";
  return `${origin.type} ${where}${sub}${ref}`;
}

/** Rough request-size guard for the PATCH route (origins are tiny). */
export function originBodyTooLarge(body: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(body), "utf-8") > 8 * 1024;
  } catch {
    return true;
  }
}
