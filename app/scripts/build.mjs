/**
 * Production build: the React client (Vite) and the server bundles (esbuild)
 * into one output folder, then dist/.build-stamp.
 *
 *   node scripts/build.mjs                  → dist/
 *   node scripts/build.mjs --out dist-next  → staging folder for in-app updates
 *                                             (server/services/appUpdate.ts swaps it in)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outArg = process.argv.indexOf("--out");
const out = path.resolve(APP, outArg > -1 ? process.argv[outArg + 1] : "dist");

fs.rmSync(out, { recursive: true, force: true });

await viteBuild({
  configFile: path.join(APP, "vite.config.ts"),
  logLevel: "warn",
  build: { outDir: path.join(out, "public"), emptyOutDir: true },
});

const server = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  packages: "external",
  logLevel: "warning",
};
await esbuild({
  ...server,
  entryPoints: [path.join(APP, "server", "launcher.ts"), path.join(APP, "server", "index.ts")],
  outdir: out,
});
await esbuild({
  ...server,
  entryPoints: [path.join(APP, "server", "assistant-mcp", "main.ts")],
  outfile: path.join(out, "assistant-mcp.js"),
});

let gitSha = null;
try {
  gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: APP, encoding: "utf8" }).trim();
} catch {
  /* not a git checkout */
}
fs.writeFileSync(
  path.join(out, ".build-stamp"),
  JSON.stringify({ built_at: new Date().toISOString(), git_sha: gitSha }) + "\n",
);
console.log(`built → ${path.relative(APP, out) || "."}`);
