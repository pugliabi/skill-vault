/**
 * PreToolUse gate on the assistant's Bash tool, wired up per turn in
 * server/services/assistant/turn.ts (`--settings`, so plain node, no build).
 *
 * An allow rule can't make Bash git-only: Claude Code runs its own read-only
 * commands (hostname, ls, whoami…) whatever the rules say, and `Bash(git:*)`
 * also passes `git -c alias.x=!cmd x`. This hook lets through one plain git
 * command for history or clones and refuses the rest. It only ever refuses, so
 * what it lets through still goes through Claude Code's own checks.
 *
 * It isn't a sandbox: git still obeys the config and hooks of a repository it
 * trusts. turn.ts sets safe.bareRepository=explicit so that a bare repository
 * planted in a folder, or shipped inside a clone, isn't one of those.
 */
import path from "node:path";

// Safe to aim anywhere with -C: update checks keep temp clones outside the vault.
const READS = new Set([
  "blame", "cat-file", "describe", "diff", "for-each-ref", "grep", "log", "ls-files", "ls-remote", "ls-tree",
  "merge-base", "name-rev", "rev-list", "rev-parse", "shortlog", "show", "status", "version",
]);
// Change the repository they run in, so it has to be in the vault or the repos folder.
const WRITES = new Set(["branch", "clone", "fetch", "pull", "remote", "tag"]);

// Run another program or write a file elsewhere. Git takes any unique prefix of these.
const BANNED_LONG = ["config", "exec", "open-files-in-pager", "output", "separate-git-dir", "template", "upload-pack"];
// The short forms, which can be clustered (`-qu<cmd>`).
const BANNED_SHORT = { clone: /^-[^-]*[cu]/, grep: /^-[^-]*O/ };

const PLAIN = "Bash runs one plain git command here: no pipes, &&, redirects, globs or variables. Use `git -C <folder> ...` instead of cd.";

/** The words bash would pass to the command, or null for anything it would expand, chain or redirect. */
function splitWords(command) {
  const words = [];
  let word = null;
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "$" || ch === "`") return null;
      else if (ch === "\\" && '"\\'.includes(command[i + 1] ?? " ")) word += command[++i];
      else word += ch;
    } else if (ch === " " || ch === "\t") {
      if (word !== null) words.push(word);
      word = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      word ??= "";
    } else if (ch === "\\") {
      if (i + 1 >= command.length || command[i + 1] === "\n") return null;
      word = (word ?? "") + command[++i];
    } else if (";&|<>()$`*?[]#\n\r".includes(ch) || (ch === "~" && word === null) || (ch === "{" && !word?.endsWith("@"))) {
      return null;
    } else {
      word = (word ?? "") + ch;
    }
  }
  if (quote) return null;
  if (word !== null) words.push(word);
  return words;
}

function isBannedOption(subcommand, arg) {
  if (arg.startsWith("--")) {
    const name = arg.slice(2).split("=")[0];
    return name !== "" && BANNED_LONG.some((banned) => banned.startsWith(name));
  }
  return Boolean(BANNED_SHORT[subcommand]?.test(arg));
}

/** Git Bash writes C:\x as /c/x; git.exe gets the drive form. */
const nativePath = (p) => (process.platform === "win32" ? p.replace(/^\/([a-zA-Z])(?=\/|$)/, "$1:") : p);

const insideRoots = (dir, roots) =>
  roots.some((root) => {
    const rel = path.relative(root, dir);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  });

const isUrl = (arg) => /^[a-z][a-z0-9+.-]*:\/\//i.test(arg) || /^[^/\\\s]+@[^/\\\s]+:/.test(arg);

/** Why this Bash command can't run, or null if it can. `roots`: the folders git may change. */
export function gitCommandRefusal(command, { cwd, roots }) {
  // Dropping or merging stderr is the one redirect worth keeping: Claude adds it out of habit.
  const words = splitWords(command.replace(/\s+2>(&1|\/dev\/null)\s*$/, ""));
  if (!words || words[0] !== "git") return PLAIN;

  let at = 1;
  let dir = cwd;
  while (words[at] === "-C" || words[at] === "--no-pager") {
    if (words[at] === "--no-pager") {
      at += 1;
      continue;
    }
    if (words[at + 1] === undefined) return PLAIN;
    dir = path.resolve(dir, nativePath(words[at + 1]));
    at += 2;
  }

  const subcommand = words[at];
  if (!READS.has(subcommand) && !WRITES.has(subcommand)) {
    return `git ${subcommand ?? ""} isn't available here. The assistant has git for history and clones: ${[...READS, ...WRITES].sort().join(", ")}.`;
  }

  const rest = words.slice(at + 1);
  const dashes = rest.indexOf("--");
  const banned = (dashes < 0 ? rest : rest.slice(0, dashes)).find((arg) => isBannedOption(subcommand, arg));
  if (banned) return `The git option ${banned} isn't allowed here: it can run another program or write outside the vault.`;

  if (WRITES.has(subcommand)) {
    // Clone's words are a mix of the URL, the target and option values; relative ones land in `dir`.
    const paths = subcommand === "clone" ? rest.filter((arg) => !arg.startsWith("-") && !isUrl(arg)) : [];
    const targets = [dir, ...paths.map((arg) => path.resolve(dir, nativePath(arg)))];
    if (!targets.every((target) => insideRoots(target, roots))) {
      return `git ${subcommand} can only change the vault or the repos folder (${roots.join(", ")}).`;
    }
  }
  return null;
}

if (process.argv[2] === "--hook") {
  let raw = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => (raw += chunk));
  process.stdin.on("end", () => {
    try {
      const { tool_name, tool_input, cwd } = JSON.parse(raw);
      if (tool_name !== "Bash") return;
      const reason = gitCommandRefusal(String(tool_input?.command ?? ""), { cwd: cwd ?? process.cwd(), roots: process.argv.slice(3) });
      if (reason) {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
      }
    } catch (err) {
      process.stderr.write(`git gate failed: ${err.message}\n`);
      process.exitCode = 2; // the only exit code that blocks the call
    }
  });
}
