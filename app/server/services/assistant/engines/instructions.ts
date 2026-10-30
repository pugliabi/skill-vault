/**
 * What an engine without Claude's --agent/--plugin-dir gets instead: the
 * lead agent's text, a note on how this engine's tools map to the names in
 * that text, and an index of the plugin's skills by absolute path (the model
 * reads a SKILL.md when it needs it — the same progressive disclosure the
 * plugin gives Claude). Sent once, at the top of the first turn's prompt; the
 * engine's own session keeps it for later turns.
 */
import fs from "node:fs";
import path from "node:path";
import { frontmatterDescription, stripFrontmatter } from "../../skillText.ts";
import { listPluginSkills } from "../installer.ts";

export interface EngineNoteOpts {
  label: string;
  /** How this engine spells a vault tool, e.g. "vault__<tool>". */
  vaultToolSpelling: string;
  subagents: boolean;
  /** "git": the shell tool runs git commands only. "none": this engine has no shell tool at all (Copilot). */
  shell: "git" | "none" | "sandboxed";
}

export function engineNote(o: EngineNoteOpts): string {
  const shell =
    o.shell === "none"
      ? 'There is no shell tool here ("Bash" doesn\'t exist), so you can\'t run git or any other command. When these instructions call for one, use a vault tool that does the job; if none does, give the user the exact command to run themselves.'
      : o.shell === "sandboxed"
        ? 'Your shell tool stands in for "Bash". It runs in a sandbox: commands can write only inside the vault and the repos folder, and the network is on. Ask the user before anything destructive.'
        : '"Bash" is your shell tool, and only git commands are allowed.';
  return [
    `You are running on ${o.label} inside Skill Vault, not on Claude Code.`,
    `- Tool names in these instructions are Claude Code's. \`mcp__vault__<tool>\` is the vault MCP server's <tool> (here: ${o.vaultToolSpelling}). "Read", "Edit", "Write", "Glob", "Grep", "WebSearch" and "WebFetch" are your equivalent tools.`,
    `- ${shell}`,
    o.subagents
      ? "- Subagents work as described."
      : "- Subagents (the Task/Agent tool) aren't available here. When these instructions say to delegate to a specialist, do that work yourself, following the specialist's skill.",
  ].join("\n");
}

export function skillsIndex(pluginDir: string): string {
  const lines = listPluginSkills(pluginDir).map((name) => {
    const file = path.join(pluginDir, "skills", name, "SKILL.md");
    let desc = "";
    try {
      desc = frontmatterDescription(fs.readFileSync(file, "utf-8"));
    } catch {
      /* listed without a description */
    }
    return `- ${name} — ${desc || "(no description)"} Read: ${file}`;
  });
  return [
    "## Skills",
    "Read a skill's SKILL.md (and the files in its references/ folder) before doing that kind of work.",
    ...lines,
  ].join("\n");
}

export function leadAgentBody(pluginDir: string, lead: string): string {
  return stripFrontmatter(fs.readFileSync(path.join(pluginDir, "agents", `${lead}.md`), "utf-8")).trim();
}

/** includeLead=false is for engines that load the plugin themselves (Copilot): just the note. */
export function composeInstructions(o: { pluginDir: string; lead: string; note: EngineNoteOpts; includeLead: boolean }): string {
  if (!o.includeLead) return engineNote(o.note);
  return [leadAgentBody(o.pluginDir, o.lead), engineNote(o.note), skillsIndex(o.pluginDir)].join("\n\n");
}

/** The prompt actually sent: instructions (first turn only), the context block (every turn), then the message. */
export function composePrompt(o: { instructions?: string; context: string; message: string }): string {
  const parts: string[] = [];
  if (o.instructions) parts.push(`<skill-vault-instructions>\n${o.instructions}\n</skill-vault-instructions>`);
  if (o.context.trim()) parts.push(`<skill-vault-context>\n${o.context}\n</skill-vault-context>`);
  parts.push(o.message);
  return parts.join("\n\n");
}
