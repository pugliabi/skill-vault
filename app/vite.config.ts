import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The sidebar shows the version this client was built from (app/package.json,
// the same field the in-app updater compares against GitHub's main).
const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")) as { version: string };

// Vite builds the React client. The Express server imports vite in
// middleware mode during dev (see server/index.ts) so HMR works from a
// single `npm run dev` command — no concurrently, no two ports to juggle.
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  root: path.resolve(__dirname, "client"),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client/src"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true,
  },
});
