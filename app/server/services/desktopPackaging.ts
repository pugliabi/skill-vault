/**
 * Claude Desktop packaging — the "claude-desktop" target.
 *
 * Claude Desktop loads skills from the user's claude.ai account; there is
 * no local skills directory and no upload API. So unlike link providers
 * (claude, cursor, ...), "pushing" to Claude Desktop means producing an
 * upload-ready zip in a staging folder. The user finishes with one click:
 * Claude Desktop → Settings → Capabilities → Skills → upload.
 *
 * Zip contract (claude.ai upload format):
 *   <skill-name>.zip
 *     └─ <skill-name>/SKILL.md  (+ assets/, scripts/, references/, ...)
 *
 * The wrapper folder matters — archive.directory(dir, name), NOT
 * (dir, false) like the generic /api/skills/zip route uses; claude.ai
 * expects the skill folder at the zip root.
 *
 * Stage dir resolution mirrors the CLI's perplexity_stage pattern:
 * config key `claude_desktop_stage`, defaulting to a sibling of the
 * vault: <vault>/../.claude-desktop-packages (same convention as the
 * /api/skills/zip route's "<vault>/../zips").
 */
import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";

export function defaultStageDir(vaultPath: string): string {
  return path.resolve(vaultPath, "..", ".claude-desktop-packages");
}

export async function packageForClaudeDesktop(
  vaultPath: string,
  stageDir: string,
  skillName: string,
): Promise<string> {
  const skillFolder = path.join(vaultPath, "skills", skillName);
  if (!fs.existsSync(skillFolder) || !fs.statSync(skillFolder).isDirectory()) {
    throw new Error(`skill folder not found: ${skillFolder}`);
  }
  fs.mkdirSync(stageDir, { recursive: true });
  const outputPath = path.join(stageDir, `${skillName}.zip`);
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    // Wrapper folder = the claude.ai upload contract.
    archive.directory(skillFolder, skillName);
    archive.finalize();
  });
  return outputPath;
}
