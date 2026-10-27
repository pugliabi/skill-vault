/**
 * Is the production build (dist/) older than the source? scripts/launch.ps1
 * asks before starting the built server:
 *
 *   node scripts/build-state.mjs   → exit 0 (fresh) or 10 (stale: run `npm run build`)
 *
 * Stale when dist/launcher.js, dist/public/index.html or dist/.build-stamp is
 * missing, or a watched source file is newer than the stamp. Test files never
 * make the build stale.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WATCHED_DIRS = ["server", "client", "assistant-plugin"];
const WATCHED_FILES = [
  "package.json",
  "package-lock.json",
  "vite.config.ts",
  "tsconfig.json",
  "tailwind.config.ts",
  "postcss.config.js",
  "scripts/build.mjs",
];
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

function newestMtime(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let newest = 0;
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) newest = Math.max(newest, newestMtime(p));
    } else if (e.isFile() && !TEST_FILE.test(e.name)) {
      newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  }
  return newest;
}

export function isBuildStale(appDir) {
  const dist = path.join(appDir, "dist");
  const stamp = path.join(dist, ".build-stamp");
  const outputs = [stamp, path.join(dist, "launcher.js"), path.join(dist, "public", "index.html")];
  if (!outputs.every((f) => fs.existsSync(f))) return true;
  const builtAt = fs.statSync(stamp).mtimeMs;
  if (WATCHED_DIRS.some((d) => newestMtime(path.join(appDir, d)) > builtAt)) return true;
  return WATCHED_FILES.some((f) => {
    try {
      return fs.statSync(path.join(appDir, f)).mtimeMs > builtAt;
    } catch {
      return false;
    }
  });
}

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(isBuildStale(APP_DIR) ? 10 : 0);
}
