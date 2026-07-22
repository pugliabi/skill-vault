"""
Format converters for each target tool.

Source skill (in the vault) is always canonical agentskills.io format.
Each converter produces a target-ready copy with appropriate adjustments.
"""

from __future__ import annotations

import json
import re
import shutil
import zipfile
from pathlib import Path
from typing import Any

# OpenClaw-specific frontmatter fields to strip for other tools
_OPENCLAW_FIELDS = {
    "user-invocable",
    "disable-model-invocation",
    "command-dispatch",
    "command-tool",
    "command-arg-mode",
    "homepage",
}

# Junk patterns to exclude when copying
_IGNORE = shutil.ignore_patterns(
    "node_modules", "__pycache__", ".git", "*.tmp", "Thumbs.db",
    ".DS_Store", ".claude", ".temp-*",
)


# ── Frontmatter helpers ──────────────────────────────────────


def _split_frontmatter(content: str) -> tuple[str, str] | None:
    m = re.match(r"^---\s*\r?\n(.*?)\r?\n---\s*\r?\n(.*)", content, re.DOTALL)
    return (m.group(1), m.group(2)) if m else None


def _strip_openclaw_fields(fm: str) -> str:
    lines = []
    for line in fm.split("\n"):
        s = line.strip()
        if any(s.startswith(f"{f}:") for f in _OPENCLAW_FIELDS):
            continue
        if s.startswith("metadata:") and "openclaw" in s:
            continue
        lines.append(line)
    return "\n".join(lines).rstrip()


def _inject_openclaw_fields(fm: str, oc_config: dict[str, Any]) -> str:
    if not oc_config:
        return fm
    additions: list[str] = []
    for field in ("user-invocable", "disable-model-invocation"):
        if field in oc_config:
            additions.append(f"{field}: {oc_config[field]}")
    if "requires" in oc_config:
        meta = {"openclaw": {"requires": oc_config["requires"]}}
        additions.append(f"metadata: {json.dumps(meta, separators=(',', ':'))}")
    if not additions:
        return fm
    cleaned = [
        l for l in fm.split("\n")
        if not any(l.strip().startswith(f"{f}:") for f in ("user-invocable", "disable-model-invocation"))
        and not (l.strip().startswith("metadata:") and "openclaw" in l.strip())
    ]
    return "\n".join(cleaned).rstrip() + "\n" + "\n".join(additions)


def _copy_clean(src: Path, dst: Path) -> None:
    from skill_vault.linking import is_link, unlink_or_remove

    if is_link(dst) or dst.is_symlink():
        # Handles symlinks, Windows junctions, and reparse points
        unlink_or_remove(dst)
    elif dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=_IGNORE)


def _rewrite_skillmd(path: Path, transform) -> None:
    if not path.exists():
        return
    content = path.read_text(encoding="utf-8")
    parts = _split_frontmatter(content)
    if not parts:
        return
    fm, body = parts
    path.write_text(f"---\n{transform(fm)}\n---\n{body}", encoding="utf-8")


# ── Public converters ────────────────────────────────────────


def convert_for_claude(source: Path, dest: Path) -> None:
    _copy_clean(source, dest)
    _rewrite_skillmd(dest / "SKILL.md", _strip_openclaw_fields)


def convert_for_openclaw(source: Path, dest: Path, oc_config: dict[str, Any] | None = None) -> None:
    _copy_clean(source, dest)
    _rewrite_skillmd(dest / "SKILL.md", lambda fm: _inject_openclaw_fields(fm, oc_config or {}))


def convert_for_cursor(source: Path, dest: Path) -> None:
    convert_for_claude(source, dest)


def convert_for_generic(source: Path, dest: Path) -> None:
    """For any tool that uses standard agentskills.io format (codex, copilot, windsurf, etc.)."""
    convert_for_claude(source, dest)


def convert_for_perplexity(source: Path, skill_name: str, stage_dir: Path) -> Path:
    stage_dir.mkdir(parents=True, exist_ok=True)

    real_files = [
        f for f in source.rglob("*")
        if f.is_file()
        and "node_modules" not in str(f) and "__pycache__" not in str(f)
        and f.name not in ("Thumbs.db", ".DS_Store") and not f.name.startswith(".temp-")
    ]

    if len(real_files) == 1 and real_files[0].name == "SKILL.md":
        out = stage_dir / f"{skill_name}.md"
        content = real_files[0].read_text(encoding="utf-8")
        parts = _split_frontmatter(content)
        if parts:
            fm, body = parts
            content = f"---\n{_strip_openclaw_fields(fm)}\n---\n{body}"
        out.write_text(content, encoding="utf-8")
        return out
    else:
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            clean = Path(tmpdir) / skill_name
            _copy_clean(source, clean)
            _rewrite_skillmd(clean / "SKILL.md", _strip_openclaw_fields)
            zip_path = stage_dir / f"{skill_name}.zip"
            if zip_path.exists():
                zip_path.unlink()
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                for f in clean.rglob("*"):
                    if f.is_file():
                        zf.write(f, f"{skill_name}/{f.relative_to(clean)}")
            return zip_path


# ── Dispatcher ───────────────────────────────────────────────

CONVERTERS = {
    "claude": convert_for_claude,
    "openclaw": convert_for_openclaw,
    "cursor": convert_for_cursor,
    "codex": convert_for_generic,
    "copilot": convert_for_generic,
    "windsurf": convert_for_generic,
}


def get_converter(target: str):
    """Return the converter for a target, falling back to generic for custom providers."""
    return CONVERTERS.get(target, convert_for_generic)
