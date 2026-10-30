import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPT = path.resolve(import.meta.dirname, "..", "..", "..", "assistant-plugin", "hooks", "git-gate.mjs");
const { gitCommandRefusal } = (await import(pathToFileURL(SCRIPT).href)) as {
  gitCommandRefusal(command: string, ctx: { cwd: string; roots: string[] }): string | null;
};

const VAULT = path.resolve("/sv/vault");
const REPOS = path.resolve("/sv/repos");
const OUTSIDE = path.resolve("/sv/outside");
const ctx = { cwd: VAULT, roots: [VAULT, REPOS] };
const q = (p: string) => `"${p}"`;

const ALLOWED = [
  "git status --short",
  "git log --oneline -n 5",
  "git log -u -n 1",
  `git log --all --oneline --follow -- "skills/x/SKILL.md"`,
  `git log --all --diff-filter=RD --name-status --oneline -- "*name*"`,
  `git log --all -S"a distinctive line" --name-only --oneline`,
  `git grep -l "foo(bar)" HEAD`,
  "git show HEAD~2:skills/x/SKILL.md",
  "git log HEAD@{1} -n 1",
  "git log --format='%h %s|%an'",
  "git --no-pager log -n 1",
  "git log -- --output=not-an-option",
  "git status 2>&1",
  "git log -n 1 2>/dev/null",
  `git -C ${q(path.join(REPOS, "clone"))} log -n 1`,
  `git -C ${q(path.join(REPOS, "clone"))} fetch --unshallow`,
  `git -C ${q(path.join(REPOS, "clone"))} pull --ff-only`,
  // Update checks keep temp clones outside the vault: reading them stays fine.
  `git -C ${q(OUTSIDE)} log -n 1`,
  `git clone --depth 1 https://github.com/o/r ${q(path.join(REPOS, "r"))}`,
  `git clone --depth 1 git@github.com:o/r.git ${q(path.join(REPOS, "r"))}`,
  `git clone -b main https://github.com/o/r ${q(path.join(REPOS, "r"))} --depth 1`,
  "git clone https://github.com/o/r",
];

for (const command of ALLOWED) {
  test(`git gate lets through: ${command}`, () => {
    assert.equal(gitCommandRefusal(command, ctx), null);
  });
}

const REFUSED: Array<[string, string[]]> = [
  ["anything but git", ["hostname", "ls", "whoami", "cat x", "echo hi", "powershell -c hostname", "", "   "]],
  ["another program named like git", ["/usr/bin/git status", "git.exe status", "./git status"]],
  ["env prefixes", ["FOO=1 git status", "GIT_SSH_COMMAND=hostname git fetch"]],
  ["chains and pipes", ["git status && hostname", "git status; hostname", "git status || hostname", "git log | head -3", "git log &", "git status\nhostname"]],
  ["redirects", ["git log > out.txt", "git log >> out.txt", "git log < in.txt", "git log 2> err.txt", "git log 2>/dev/null; hostname"]],
  ["expansions", ["git log $HOME", `git log "$HOME"`, "git log $(hostname)", `git log "$(hostname)"`, "git log `hostname`", `git log "\`hostname\`"`, "git log ~/x", "git log -- *.md", "git log -- a?.md", "git log -- {a,b}"]],
  ["broken quoting", [`git log "unterminated`, "git log 'unterminated", "git log \\"]],
  ["no subcommand", ["git", "git --no-pager", "git -C"]],
  ["global options that change what runs", ["git -c alias.x=!hostname x", "git -calias.x=!hostname x", "git -c core.sshCommand=hostname fetch", "git --config-env=a=b log", "git --exec-path=/x log", "git --git-dir=/x log", "git --work-tree=/x status", "git -p log"]],
  ["subcommands outside history and clones", ["git push", "git commit -m x", "git add .", "git reset --hard", "git checkout main", "git config alias.x !hostname", "git x", "git submodule foreach hostname", "git bisect run hostname", "git rebase --exec hostname main", "git filter-branch --tree-filter hostname", "git difftool -x hostname", "git mergetool", "git worktree add ../x", "git init ../x", "git archive -o ../x.zip HEAD", "git bundle create ../x.b HEAD", "git help -w log"]],
  ["options that run a program or write a file", ["git log --output=../x", "git diff --outp=../x", "git grep -Ohostname x", "git grep -lOhostname x", "git grep --open-files-in-pager=hostname x", "git grep --open=hostname x", "git ls-remote --upload-pack=hostname origin", "git ls-remote --exec=hostname origin", "git fetch --upload-pack=hostname", "git pull --upload-pack=hostname"]],
  ["clone options that run a program", ["git clone --upload-pack=hostname u d", "git clone --upl=hostname u d", "git clone -uhostname u d", "git clone -quhostname u d", "git clone -c core.sshCommand=hostname u d", "git clone --config core.sshCommand=hostname u d", "git clone --template=../t u d", "git clone --separate-git-dir=../d u d"]],
  ["writes outside the vault and repos folder", [
    `git clone https://github.com/o/r ${q(OUTSIDE)}`,
    `git clone https://github.com/o/r ${q(OUTSIDE)} --depth 1`,
    `git clone https://github.com/o/r ${q(`${VAULT}-evil`)}`,
    "git clone https://github.com/o/r ../outside",
    `git -C ${q(OUTSIDE)} fetch`,
    `git -C ${q(OUTSIDE)} pull`,
    `git -C ${q(OUTSIDE)} branch -D x`,
    `git -C ${q(OUTSIDE)} remote remove origin`,
    `git -C ${q(OUTSIDE)} tag x`,
    "git -C ../outside fetch",
  ]],
];

for (const [what, commands] of REFUSED) {
  test(`git gate refuses ${what}`, () => {
    for (const command of commands) {
      assert.notEqual(gitCommandRefusal(command, ctx), null, command);
    }
  });
}

test("a refusal tells the model what to do instead", () => {
  assert.match(gitCommandRefusal("git log | head -3", ctx) ?? "", /git -C/);
  assert.match(gitCommandRefusal("git push", ctx) ?? "", /log/);
});

if (process.platform === "win32") {
  test("git gate reads Git Bash drive paths, ignoring letter case", () => {
    const repos = "C:\\Github\\skills-repos";
    const roots = ["C:\\Github\\vault", repos];
    assert.equal(gitCommandRefusal("git -C /c/Github/skills-repos/r pull", { cwd: roots[0], roots }), null);
    assert.equal(gitCommandRefusal("git -C c:/github/SKILLS-REPOS/r pull", { cwd: roots[0], roots }), null);
    assert.notEqual(gitCommandRefusal("git -C /d/Github/skills-repos/r pull", { cwd: roots[0], roots }), null);
  });
}

function runHook(stdin: string) {
  return spawnSync(process.execPath, [SCRIPT, "--hook", VAULT, REPOS], { input: stdin, encoding: "utf-8" });
}

test("the hook denies through Claude Code's PreToolUse JSON", () => {
  const r = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "hostname" }, cwd: VAULT }));
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, "PreToolUse");
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /git/);
});

test("the hook stays silent on an allowed command, so Claude Code's own checks still run", () => {
  const r = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" }, cwd: VAULT }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("the hook ignores other tools", () => {
  const r = runHook(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "x" }, cwd: VAULT }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("the hook blocks when it can't read its input (exit 2, the only code that does)", () => {
  assert.equal(runHook("not json").status, 2);
});
