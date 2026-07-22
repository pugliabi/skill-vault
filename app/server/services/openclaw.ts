/**
 * OpenClaw export — the one place the app deliberately shells out.
 *
 * OpenClaw runs inside a locked-down, app-owned WSL2 distro
 * ("OpenClawGateway") with `automount=false`, `interop=false`, and a
 * `\\wsl.localhost` share that fails auth from the Windows session — so
 * there is NO filesystem bridge. It is therefore NOT a drop-a-folder
 * provider like claude/cursor/copilot, and cannot live in the shared
 * `agent_locations` config. Instead, exporting a vault skill means:
 *
 *   1. `tar.exe -c` the skill folder on Windows and pipe the archive
 *      stream into the distro via `wsl.exe … tar -x` (no mount needed).
 *   2. Run OpenClaw's own installer inside the distro:
 *      `openclaw skills install <staged-dir> --as <slug> [--global] [--force]`.
 *
 * Both `wsl.exe` and `tar.exe` are Windows built-ins, so this adds no
 * npm/Python dependency (the "installable without Python" rule holds).
 * The feature is win32-only and self-gates via detectOpenClaw(); on any
 * other platform, or when the distro is absent, callers get a clean
 * "not available" instead of a thrown spawn error. This mirrors how
 * services/linking.ts documents its platform-specific fallbacks.
 */

import { spawn, spawnSync } from "node:child_process";
import { skillDir } from "./vault.ts";

const DISTRO = process.env.OPENCLAW_DISTRO || "OpenClawGateway";
const WSL_USER = process.env.OPENCLAW_USER || "openclaw";
/** The openclaw binary isn't on the default PATH; prepend its bundled node bin. */
const PATH_PREFIX = 'export PATH="$HOME/.openclaw/tools/node/bin:$PATH";';
const STAGE_ROOT = "$HOME/.openclaw/sv-staging";

export interface OpenClawStatus {
  available: boolean;
  distro?: string;
  /** Best-effort count of skills the gateway currently reports. */
  installed?: number;
}

export interface ExportResult {
  ok: boolean;
  skill: string;
  /** Combined stdout/stderr of the install command, trimmed. */
  output: string;
}

let statusCache: { at: number; value: OpenClawStatus } | null = null;

/**
 * Is the OpenClaw gateway distro reachable from here? Cheap and cached
 * for a few seconds — `wsl.exe -l -q` is spawned once, its UTF-16LE
 * output decoded, and the distro name matched case-insensitively.
 */
export function detectOpenClaw(): OpenClawStatus {
  if (statusCache && Date.now() - statusCache.at < 5000) return statusCache.value;

  let value: OpenClawStatus = { available: false };
  if (process.platform === "win32") {
    try {
      const out = spawnSync("wsl.exe", ["-l", "-q"], { timeout: 5000 });
      // `wsl -l -q` emits UTF-16LE; decode and drop NULs.
      const text = out.stdout
        ? Buffer.from(out.stdout).toString("utf16le").replace(/\0/g, "")
        : "";
      const distros = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (distros.some((d) => d.toLowerCase() === DISTRO.toLowerCase())) {
        value = { available: true, distro: DISTRO };
      }
    } catch {
      value = { available: false };
    }
  }
  statusCache = { at: Date.now(), value };
  return value;
}

/** Run `bash -lc <script>` inside the distro as the openclaw user. */
function wslBash(
  script: string,
  timeoutMs = 120000,
): { code: number; output: string } {
  const r = spawnSync(
    "wsl.exe",
    ["-d", DISTRO, "--user", WSL_USER, "--", "bash", "-lc", script],
    { encoding: "utf-8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
  );
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { code: r.status ?? 1, output };
}

/**
 * Best-effort readout of how many skills the gateway sees. Never throws;
 * returns undefined if the CLI isn't cooperative.
 */
export function countOpenClawSkills(): number | undefined {
  try {
    const { code, output } = wslBash(
      `${PATH_PREFIX} openclaw skills list 2>&1`,
      20000,
    );
    if (code !== 0) return undefined;
    // Header line looks like "Skills (15/58 ready)".
    const m = output.match(/Skills\s*\((\d+)\s*\/\s*(\d+)/i);
    if (m) return Number(m[2]);
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Export one vault skill into the OpenClaw distro and install it.
 * Throws Error with a readable message on any failure (caller maps to 500).
 */
export async function exportSkillToOpenClaw(
  vaultPath: string,
  skillName: string,
  opts: { global?: boolean; force?: boolean } = {},
): Promise<ExportResult> {
  const status = detectOpenClaw();
  if (!status.available) {
    throw new Error("OpenClaw gateway distro not available on this machine");
  }

  const source = skillDir(vaultPath, skillName);
  const stage = `${STAGE_ROOT}/${skillName}`;

  // 1) Stream the skill folder into the distro: tar (Windows) | tar -x (WSL).
  await new Promise<void>((resolve, reject) => {
    const tar = spawn("tar.exe", ["-c", "-C", source, "."]);
    const wsl = spawn("wsl.exe", [
      "-d", DISTRO, "--user", WSL_USER, "--",
      "bash", "-lc",
      `rm -rf '${stage}' && mkdir -p '${stage}' && tar -x -C '${stage}'`,
    ]);
    let err = "";
    tar.on("error", (e) => reject(new Error(`tar failed: ${e.message}`)));
    wsl.on("error", (e) => reject(new Error(`wsl failed: ${e.message}`)));
    wsl.stderr.on("data", (d) => (err += d.toString()));
    tar.stdout.pipe(wsl.stdin);
    wsl.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`staging failed (exit ${code})${err ? `: ${err.trim()}` : ""}`));
    });
  });

  // 2) Install from the staged dir using OpenClaw's own CLI.
  const flags = [`--as '${skillName}'`];
  if (opts.global) flags.push("--global");
  if (opts.force) flags.push("--force");
  const { code, output } = wslBash(
    `${PATH_PREFIX} openclaw skills install '${stage}' ${flags.join(" ")} 2>&1`,
    180000,
  );

  // 3) Best-effort cleanup of the staging dir (don't fail the export on this).
  wslBash(`rm -rf '${stage}'`, 15000);

  if (code !== 0) {
    throw new Error(`openclaw skills install failed (exit ${code}): ${output}`);
  }
  return { ok: true, skill: skillName, output };
}
