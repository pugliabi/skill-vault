"""
Cross-platform symlink / junction support.

Push strategy: instead of copying skills to agent directories, create
symlinks (or directory junctions on Windows) so edits in the agent tool
are immediately reflected in the vault and vice versa.

Symlink precedence on Windows:
  1. os.symlink()         — works if Developer Mode is on (Win 10+)
  2. mklink /j (junction) — works without any elevation for directories
  3. Fall back to copy     — always works, but loses live-link behavior

On macOS/Linux, os.symlink() just works.
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
from pathlib import Path

# Junk patterns to exclude when falling back to copy
_IGNORE = shutil.ignore_patterns(
    "node_modules", "__pycache__", ".git", "*.tmp",
    "Thumbs.db", ".DS_Store", ".temp-*",
)


class LinkResult:
    """Result of a link_skill_dir call."""

    def __init__(self, method: str, target: Path, source: Path) -> None:
        self.method = method   # "symlink" | "junction" | "copy" | "skip"
        self.target = target   # the path in the agent directory
        self.source = source   # the path in the vault

    def __repr__(self) -> str:
        return f"LinkResult({self.method}, {self.target} → {self.source})"


def _is_windows() -> bool:
    return platform.system() == "Windows"


def _try_symlink(source: Path, target: Path) -> bool:
    """Try os.symlink (target_is_directory=True). Returns True on success."""
    try:
        os.symlink(source, target, target_is_directory=True)
        return True
    except OSError:
        return False


def _try_junction(source: Path, target: Path) -> bool:
    """Try mklink /j on Windows. Junctions don't need admin or dev mode."""
    if not _is_windows():
        return False
    try:
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/j", str(target), str(source)],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.returncode == 0
    except Exception:
        return False


def _copy_fallback(source: Path, target: Path) -> None:
    """Copy the directory as a last resort."""
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target, ignore=_IGNORE)


def is_link(path: Path) -> bool:
    """Check if a path is a symlink or junction."""
    if path.is_symlink():
        return True
    # On Windows, junctions appear as directories but are reparse points
    if _is_windows():
        try:
            import ctypes
            attrs = ctypes.windll.kernel32.GetFileAttributesW(str(path))  # type: ignore[attr-defined]
            FILE_ATTRIBUTE_REPARSE_POINT = 0x400
            return bool(attrs & FILE_ATTRIBUTE_REPARSE_POINT)
        except Exception:
            pass
    return False


def resolve_link(path: Path) -> Path | None:
    """Resolve a symlink/junction to its actual target."""
    if path.is_symlink():
        return path.resolve()
    return None


def unlink_or_remove(path: Path) -> None:
    """Remove a symlink/junction/directory cleanly.

    Handles broken junctions (target deleted) which cause os.rmdir and
    shutil.rmtree to fail with FileNotFoundError.  On Windows we fall
    back to ``cmd /c rmdir`` which can remove a junction even when its
    target no longer exists.
    """
    if path.is_symlink():
        path.unlink()
        return

    if _is_windows() and is_link(path):
        # Junctions: rmdir removes the junction without deleting the target
        try:
            os.rmdir(path)
            return
        except FileNotFoundError:
            # Broken junction — target path no longer exists.
            # "cmd /c rmdir" can still remove the reparse point.
            try:
                subprocess.run(
                    ["cmd", "/c", "rmdir", str(path)],
                    capture_output=True, text=True, timeout=10,
                )
                if not path.exists():
                    return
            except Exception:
                pass
        except OSError:
            pass
        # Last resort: try shutil.rmtree (works if the junction target exists)
        try:
            shutil.rmtree(path)
        except FileNotFoundError:
            # Junction is already gone or truly broken; nothing left to do
            pass
        return

    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def link_skill_dir(source: Path, target: Path, force_copy: bool = False) -> LinkResult:
    """
    Create a link from target → source (vault → agent dir).

    The 'source' is the canonical vault copy.
    The 'target' is where the agent tool looks for the skill.

    Strategy:
      1. If target already exists and is a link pointing to source, skip
      2. Remove any existing target (old copy or stale link)
      3. Try symlink, then junction (Windows), then copy

    Args:
        source: Path to the skill in the vault (e.g., ~/repos/agent-skills/skills/my-skill)
        target: Path where the agent expects it (e.g., ~/.claude/skills/my-skill)
        force_copy: If True, skip symlink/junction and always copy
    """
    source = source.resolve()
    target_resolved = target.resolve() if target.exists() else target.parent.resolve() / target.name

    # Guard against self-referential or circular links (e.g., vault
    # skills dir configured as its own agent_location → skills/skills/skills).
    if source == target_resolved:
        return LinkResult("skip", target, source)
    # Also block if target is an ancestor of source (would create a loop).
    try:
        source.relative_to(target_resolved)
        return LinkResult("skip", target, source)
    except ValueError:
        pass
    try:
        target_resolved.relative_to(source)
        return LinkResult("skip", target, source)
    except ValueError:
        pass

    target_parent = target.parent
    target_parent.mkdir(parents=True, exist_ok=True)

    # Already linked correctly?
    if target.exists() and is_link(target):
        resolved = resolve_link(target)
        if resolved and resolved == source:
            return LinkResult("symlink", target, source)

    # Remove stale target
    if target.exists() or target.is_symlink():
        unlink_or_remove(target)

    if force_copy:
        _copy_fallback(source, target)
        return LinkResult("copy", target, source)

    # Try symlink first
    if _try_symlink(source, target):
        return LinkResult("symlink", target, source)

    # Try junction on Windows
    if _try_junction(source, target):
        return LinkResult("junction", target, source)

    # Fall back to copy
    _copy_fallback(source, target)
    return LinkResult("copy", target, source)
