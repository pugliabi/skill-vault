"""
Multi-machine conflict detection and resolution.

When the same skill is adopted from multiple agents or pulled on different
machines, versions can diverge. This module detects conflicts and offers
resolution strategies.

Conflict model:
  - Each skill in the vault has a file-structure fingerprint (set of relative paths).
  - The manifest tracks: vault_hash, origin (which agent/machine it came from),
    and a timestamp.
  - A conflict is only triggered when the file structure differs (files
    added or removed), NOT when file contents change within the same set
    of files.  Content-only changes are treated as normal updates.

Resolution strategies:
  1. keep-vault     — keep the vault version, ignore the incoming one
  2. keep-incoming  — overwrite the vault with the incoming version
  3. keep-both      — import the incoming version under a suffixed name (e.g., my-skill--claude)
  4. backup         — back up the vault version to skills/backup/{DEVICE}-v{N}/, then replace
  5. diff           — show a diff and let the user decide
  6. claude-code    — launch Claude Code to intelligently merge both versions
"""

from __future__ import annotations

import difflib
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from skill_vault.hashing import hash_directory


def _file_structure(base: Path) -> set[str]:
    """Return the set of relative file paths under *base* (ignoring junk)."""
    skip = {"node_modules", "__pycache__", ".git"}
    result: set[str] = set()
    for f in base.rglob("*"):
        if f.is_file() and not any(part in skip for part in f.parts):
            result.add(str(f.relative_to(base)))
    return result


@dataclass
class ConflictInfo:
    """Describes a conflict between vault and incoming skill."""

    skill_name: str
    vault_path: Path
    incoming_path: Path
    incoming_source: str     # e.g., "claude", "LAPTOP-WORK"
    vault_hash: str
    incoming_hash: str
    vault_file_count: int
    incoming_file_count: int
    vault_files_set: set[str]      # relative paths in vault
    incoming_files_set: set[str]   # relative paths in incoming

    @property
    def is_conflict(self) -> bool:
        """A conflict only when the file *structure* differs (added/removed files).

        Content-only changes (same filenames, different hashes) are NOT conflicts
        — those are normal updates that should overwrite silently.
        """
        return self.vault_files_set != self.incoming_files_set

    @property
    def has_changes(self) -> bool:
        """True if anything differs at all (structure or content)."""
        return self.vault_hash != self.incoming_hash

    @property
    def files_added(self) -> set[str]:
        return self.incoming_files_set - self.vault_files_set

    @property
    def files_removed(self) -> set[str]:
        return self.vault_files_set - self.incoming_files_set


def detect_conflict(
    skill_name: str,
    vault_skills_dir: Path,
    incoming_path: Path,
    incoming_source: str,
) -> ConflictInfo | None:
    """
    Check if importing a skill would conflict with the vault version.
    Returns None if the skill doesn't exist in the vault (no conflict).
    Returns ConflictInfo if it does exist.
    """
    vault_path = vault_skills_dir / skill_name
    if not vault_path.exists():
        return None

    vault_hash = hash_directory(vault_path) or "empty"
    incoming_hash = hash_directory(incoming_path) or "empty"

    vault_fs = _file_structure(vault_path)
    incoming_fs = _file_structure(incoming_path)

    return ConflictInfo(
        skill_name=skill_name,
        vault_path=vault_path,
        incoming_path=incoming_path,
        incoming_source=incoming_source,
        vault_hash=vault_hash,
        incoming_hash=incoming_hash,
        vault_file_count=len(vault_fs),
        incoming_file_count=len(incoming_fs),
        vault_files_set=vault_fs,
        incoming_files_set=incoming_fs,
    )


def diff_skill_md(vault_path: Path, incoming_path: Path) -> str:
    """
    Generate a unified diff of SKILL.md between vault and incoming.
    Returns an empty string if either file doesn't exist or they match.
    """
    vault_md = vault_path / "SKILL.md"
    incoming_md = incoming_path / "SKILL.md"

    if not vault_md.exists() or not incoming_md.exists():
        return ""

    vault_lines = vault_md.read_text(encoding="utf-8", errors="replace").splitlines(keepends=True)
    incoming_lines = incoming_md.read_text(encoding="utf-8", errors="replace").splitlines(keepends=True)

    diff = difflib.unified_diff(
        vault_lines,
        incoming_lines,
        fromfile=f"vault/{vault_path.name}/SKILL.md",
        tofile=f"{incoming_path.parent.name}/{incoming_path.name}/SKILL.md",
    )
    return "".join(diff)


def diff_file_list(vault_path: Path, incoming_path: Path) -> dict[str, str]:
    """
    Compare file lists between vault and incoming skill.
    Returns a dict of {relative_path: status} where status is:
      "same"     — file exists in both, same hash
      "modified" — file exists in both, different hash
      "added"    — file only in incoming
      "removed"  — file only in vault

    Uses whitespace-normalised hashing so trailing newlines / spaces
    / CRLF vs LF differences are ignored.
    """
    from skill_vault.hashing import hash_file

    def _file_set(base: Path) -> dict[str, str]:
        result = {}
        for f in base.rglob("*"):
            if f.is_file() and "node_modules" not in str(f) and "__pycache__" not in str(f):
                rel = str(f.relative_to(base))
                result[rel] = hash_file(f)
        return result

    vault_files = _file_set(vault_path)
    incoming_files = _file_set(incoming_path)

    all_keys = sorted(set(vault_files) | set(incoming_files))
    comparison: dict[str, str] = {}

    for key in all_keys:
        if key in vault_files and key in incoming_files:
            comparison[key] = "same" if vault_files[key] == incoming_files[key] else "modified"
        elif key in incoming_files:
            comparison[key] = "added"
        else:
            comparison[key] = "removed"

    return comparison


# ── Resolution actions ────────────────────────────────────────


# Junk patterns for copying
_IGNORE = shutil.ignore_patterns(
    "node_modules", "__pycache__", ".git", "*.tmp",
    "Thumbs.db", ".DS_Store", ".temp-*",
)


def resolve_keep_vault(conflict: ConflictInfo) -> str:
    """Keep the vault version. No action needed."""
    return f"Kept vault version of '{conflict.skill_name}'"


def resolve_keep_incoming(conflict: ConflictInfo) -> str:
    """Overwrite vault with the incoming version."""
    if conflict.vault_path.exists():
        shutil.rmtree(conflict.vault_path)
    shutil.copytree(conflict.incoming_path, conflict.vault_path, ignore=_IGNORE)
    return f"Replaced vault version of '{conflict.skill_name}' with version from {conflict.incoming_source}"


def resolve_keep_both(conflict: ConflictInfo, vault_skills_dir: Path) -> str:
    """
    Import incoming under a suffixed name so both versions coexist.
    e.g., my-skill becomes my-skill--claude
    """
    suffix = conflict.incoming_source.lower().replace(" ", "-")
    new_name = f"{conflict.skill_name}--{suffix}"
    new_path = vault_skills_dir / new_name

    if new_path.exists():
        # Add timestamp to make unique
        ts = datetime.now(timezone.utc).strftime("%Y%m%d")
        new_name = f"{conflict.skill_name}--{suffix}-{ts}"
        new_path = vault_skills_dir / new_name

    shutil.copytree(conflict.incoming_path, new_path, ignore=_IGNORE)
    return f"Imported as '{new_name}' (vault copy unchanged)"


def resolve_backup(
    conflict: ConflictInfo,
    vault_skills_dir: Path,
    machine_id: str | None = None,
    then_replace: bool = True,
) -> str:
    """
    Back up the vault version to skills/backup/{DEVICE}-v{N}/{skill-name}/,
    then optionally replace with the incoming version.

    The version number auto-increments by scanning existing backups.
    """
    import platform

    device = machine_id or platform.node()
    # Sanitise device name for use in paths (replace spaces/special chars)
    device_safe = re.sub(r"[^\w.-]", "-", device).strip("-") or "unknown"

    backup_root = vault_skills_dir / "backup"
    backup_root.mkdir(parents=True, exist_ok=True)

    # Auto-increment version by scanning existing {DEVICE}-v* dirs
    existing_versions: list[int] = []
    for d in backup_root.iterdir():
        if d.is_dir() and d.name.startswith(f"{device_safe}-v"):
            suffix = d.name[len(f"{device_safe}-v"):]
            if suffix.isdigit():
                existing_versions.append(int(suffix))

    next_version = max(existing_versions, default=0) + 1
    backup_dir = backup_root / f"{device_safe}-v{next_version}" / conflict.skill_name

    # Copy the vault version into the backup
    shutil.copytree(conflict.vault_path, backup_dir, ignore=_IGNORE)

    result_msg = (
        f"Backed up vault version of '{conflict.skill_name}' "
        f"to backup/{device_safe}-v{next_version}/{conflict.skill_name}/"
    )

    if then_replace:
        # Now overwrite vault with the incoming version
        resolve_keep_incoming(conflict)
        result_msg += f" — replaced with version from {conflict.incoming_source}"

    return result_msg


# ── Claude Code resolution ────────────────────────────────────


def _check_claude_code() -> bool:
    """Return True if the `claude` CLI is available on PATH."""
    return shutil.which("claude") is not None


def resolve_claude_code(
    conflict: ConflictInfo,
    vault_skills_dir: Path,
    machine_id: str | None = None,
) -> str:
    """
    Use Claude Code CLI to intelligently merge both versions of a skill.

    Workflow:
      1. Create a temp workspace with vault/ and incoming/ copies side-by-side
      2. Write a MERGE_CONTEXT.md describing the conflict
      3. Launch `claude` in interactive mode so the user can guide the merge
      4. The merged result is written to merged/ in the temp dir
      5. On success, back up the vault version then replace with the merge result
    """
    from rich.console import Console

    console = Console()

    if not _check_claude_code():
        console.print(
            "[red]Claude Code CLI not found.[/]\n"
            "  Install: [cyan]npm install -g @anthropic-ai/claude-code[/]\n"
            "  Then authenticate: [cyan]claude auth login[/]"
        )
        return f"Skipped '{conflict.skill_name}' — Claude Code CLI not available"

    # Create a temp workspace with both versions laid out clearly
    tmpdir = tempfile.mkdtemp(prefix=f"skill-merge-{conflict.skill_name}-")
    tmp = Path(tmpdir)

    vault_copy = tmp / "vault" / conflict.skill_name
    incoming_copy = tmp / "incoming" / conflict.skill_name
    merged_dir = tmp / "merged" / conflict.skill_name

    shutil.copytree(conflict.vault_path, vault_copy, ignore=_IGNORE)
    shutil.copytree(conflict.incoming_path, incoming_copy, ignore=_IGNORE)
    merged_dir.mkdir(parents=True)

    # Build a diff summary to include in context
    diff_text = diff_skill_md(conflict.vault_path, conflict.incoming_path)
    file_diff = diff_file_list(conflict.vault_path, conflict.incoming_path)
    changes = {k: v for k, v in file_diff.items() if v != "same"}

    changes_summary = ""
    if changes:
        lines = []
        for fname, status in changes.items():
            icon = {"modified": "~", "added": "+", "removed": "-"}[status]
            lines.append(f"  {icon} {fname} ({status})")
        changes_summary = "\n".join(lines)

    # Write merge context file for Claude to read
    context_md = tmp / "MERGE_CONTEXT.md"
    context_md.write_text(
        f"# Skill Merge: {conflict.skill_name}\n\n"
        f"Two versions of the **{conflict.skill_name}** skill have diverged and need merging.\n\n"
        f"## Versions\n\n"
        f"- **Vault** (current): `vault/{conflict.skill_name}/` — "
        f"{conflict.vault_file_count} files, hash `{conflict.vault_hash[:12]}`\n"
        f"- **Incoming** (from {conflict.incoming_source}): `incoming/{conflict.skill_name}/` — "
        f"{conflict.incoming_file_count} files, hash `{conflict.incoming_hash[:12]}`\n\n"
        f"## File Differences\n\n"
        f"```\n{changes_summary or 'No file-level differences (content changed)'}\n```\n\n"
        + (f"## SKILL.md Diff\n\n```diff\n{diff_text}```\n\n" if diff_text else "")
        + f"## Your Task\n\n"
        f"Merge the best of both versions into `merged/{conflict.skill_name}/`.\n"
        f"- Read both versions carefully\n"
        f"- Combine improvements from both — don't just pick one\n"
        f"- Preserve the SKILL.md frontmatter format (YAML between --- delimiters)\n"
        f"- The merged result must be a valid skill directory with SKILL.md\n"
        f"- Copy any supporting files (scripts/, references/, assets/) that should be kept\n",
        encoding="utf-8",
    )

    console.print(f"\n[bold cyan]Launching Claude Code[/] to merge '{conflict.skill_name}'...")
    console.print(f"  [dim]Workspace: {tmpdir}[/]")
    console.print(
        f"  [dim]vault/{conflict.skill_name}/[/]   ← current vault version\n"
        f"  [dim]incoming/{conflict.skill_name}/[/] ← incoming from {conflict.incoming_source}\n"
        f"  [dim]merged/{conflict.skill_name}/[/]   ← write your merged result here\n"
    )

    # Launch Claude Code interactively so the user can collaborate on the merge
    prompt = (
        f"Read MERGE_CONTEXT.md for full details. You are merging two versions of the "
        f"'{conflict.skill_name}' skill. The vault version is in vault/{conflict.skill_name}/ "
        f"and the incoming version is in incoming/{conflict.skill_name}/. "
        f"Merge the best of both into merged/{conflict.skill_name}/. "
        f"Start by reading both versions, then produce a merged result."
    )

    try:
        result = subprocess.run(
            ["claude", "--dangerously-skip-permissions", prompt],
            cwd=tmpdir,
            # Interactive — inherit the terminal so the user can guide the merge
            stdin=None,
            stdout=None,
            stderr=None,
        )
    except FileNotFoundError:
        console.print("[red]Failed to launch Claude Code CLI.[/]")
        return f"Skipped '{conflict.skill_name}' — could not launch Claude Code"

    # Check if Claude produced a merged result
    merged_skill_md = merged_dir / "SKILL.md"
    if not merged_skill_md.exists():
        # Maybe Claude wrote files directly in merged/ without the skill subfolder
        alt_skill_md = tmp / "merged" / "SKILL.md"
        if alt_skill_md.exists():
            # Move everything from merged/ into the expected subfolder structure
            alt_merged = tmp / "merged_flat"
            shutil.move(str(tmp / "merged"), str(alt_merged))
            merged_dir.mkdir(parents=True)
            for item in alt_merged.iterdir():
                shutil.move(str(item), str(merged_dir / item.name))
            shutil.rmtree(alt_merged, ignore_errors=True)

    if not merged_dir.exists() or not any(merged_dir.iterdir()):
        console.print("[yellow]No merged output found — keeping vault version.[/]")
        shutil.rmtree(tmpdir, ignore_errors=True)
        return f"Claude Code session ended without merged output for '{conflict.skill_name}'"

    # Backup the vault version before replacing
    backup_msg = resolve_backup(
        conflict, vault_skills_dir, machine_id=machine_id, then_replace=False,
    )

    # Replace vault with the merged result
    if conflict.vault_path.exists():
        shutil.rmtree(conflict.vault_path)
    shutil.copytree(merged_dir, conflict.vault_path, ignore=_IGNORE)

    # Clean up temp dir
    shutil.rmtree(tmpdir, ignore_errors=True)

    merged_file_count = sum(1 for f in conflict.vault_path.rglob("*") if f.is_file())
    console.print(
        f"  [green]\u2713[/] Merged result: {merged_file_count} files written to vault\n"
        f"  [dim]{backup_msg}[/]"
    )
    return (
        f"Merged '{conflict.skill_name}' via Claude Code "
        f"({merged_file_count} files) — {backup_msg}"
    )


# ── Interactive resolution ────────────────────────────────────


def resolve_interactive(
    conflict: ConflictInfo,
    vault_skills_dir: Path,
    machine_id: str | None = None,
) -> str:
    """
    Interactively resolve a conflict using questionary.
    Returns a message describing what was done.
    """
    import questionary
    from rich.console import Console
    from rich.panel import Panel

    console = Console()

    # Show conflict details
    console.print(Panel(
        f"[bold yellow]Conflict:[/] [cyan]{conflict.skill_name}[/]\n\n"
        f"  Vault:    {conflict.vault_file_count} files, hash {conflict.vault_hash[:10]}\u2026\n"
        f"  Incoming: {conflict.incoming_file_count} files, hash {conflict.incoming_hash[:10]}\u2026\n"
        f"  Source:   {conflict.incoming_source}",
        title="Version Conflict",
        border_style="yellow",
    ))

    # Show SKILL.md diff if available
    diff_text = diff_skill_md(conflict.vault_path, conflict.incoming_path)
    if diff_text:
        console.print("\n[bold]SKILL.md diff:[/]")
        for line in diff_text.splitlines():
            if line.startswith("+") and not line.startswith("+++"):
                console.print(f"  [green]{line}[/]")
            elif line.startswith("-") and not line.startswith("---"):
                console.print(f"  [red]{line}[/]")
            else:
                console.print(f"  [dim]{line}[/]")

    # Show file-level comparison
    file_diff = diff_file_list(conflict.vault_path, conflict.incoming_path)
    changes = {k: v for k, v in file_diff.items() if v != "same"}
    if changes:
        console.print("\n[bold]File differences:[/]")
        for fname, status in changes.items():
            icon = {"modified": "[yellow]~[/]", "added": "[green]+[/]", "removed": "[red]-[/]"}[status]
            console.print(f"  {icon} {fname}")

    # Build choices — include Claude Code option if available
    choices = [
        questionary.Choice("Keep vault version (skip incoming)", value="keep-vault"),
        questionary.Choice("Replace with incoming version", value="keep-incoming"),
        questionary.Choice("Backup vault version, then replace with incoming", value="backup"),
        questionary.Choice(
            f"Keep both (import as {conflict.skill_name}--{conflict.incoming_source})",
            value="keep-both",
        ),
    ]

    has_claude = _check_claude_code()
    if has_claude:
        choices.append(questionary.Choice(
            "\U0001f9e0 Resolve with Claude Code (AI-assisted merge)",
            value="claude-code",
        ))
    else:
        choices.append(questionary.Choice(
            "\U0001f9e0 Resolve with Claude Code (not installed)",
            value="claude-code",
            disabled="install: npm i -g @anthropic-ai/claude-code",
        ))

    choice = questionary.select(
        "How do you want to resolve this?",
        choices=choices,
    ).ask()

    if choice == "keep-vault":
        return resolve_keep_vault(conflict)
    elif choice == "keep-incoming":
        return resolve_keep_incoming(conflict)
    elif choice == "backup":
        return resolve_backup(conflict, vault_skills_dir, machine_id=machine_id)
    elif choice == "keep-both":
        return resolve_keep_both(conflict, vault_skills_dir)
    elif choice == "claude-code":
        return resolve_claude_code(conflict, vault_skills_dir, machine_id=machine_id)
    else:
        return f"Skipped '{conflict.skill_name}'"
