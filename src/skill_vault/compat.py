"""
Skill–target compatibility detection.

Skills may contain tool-specific features (e.g., OpenClaw's `user-invocable`
or `command-dispatch` fields) that don't translate to other tools.  The vault
format converter strips / injects these during push, so they're *technically*
safe — but a skill built *for* OpenClaw's command routing may not make sense
inside Claude at all.

This module detects tool-specific markers and provides compatibility advice
so that adopt and push can warn the user.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

# ── Tool-specific frontmatter markers ─────────────────────────

# Fields that are *only* meaningful in OpenClaw
OPENCLAW_ONLY_FIELDS = {
    "user-invocable",
    "disable-model-invocation",
    "command-dispatch",
    "command-tool",
    "command-arg-mode",
}

# Fields in the `metadata` block that are OpenClaw-specific
OPENCLAW_METADATA_KEYS = {"openclaw"}

# `allowed-tools` patterns that are tool-specific
# e.g., "Bash(git:*)" is Claude-flavoured, but the field is in the spec so
# we only flag patterns that literally reference a tool brand
BRAND_TOOL_PATTERNS: dict[str, re.Pattern[str]] = {
    "claude": re.compile(r"allowed-tools:.*\b(Task|Bash|Read|Write|Edit|Grep|Glob)\b", re.I),
}


def _parse_frontmatter(skill_dir: Path) -> str | None:
    """Return the raw frontmatter text from SKILL.md, or None."""
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        skill_md = skill_dir / "skill.md"
    if not skill_md.exists():
        return None
    content = skill_md.read_text(encoding="utf-8", errors="replace")
    m = re.match(r"^---\s*\r?\n(.*?)\r?\n---\s*\r?\n", content, re.DOTALL)
    return m.group(1) if m else None


# ── Public API ────────────────────────────────────────────────


def detect_tool_specifics(skill_dir: Path) -> dict[str, list[str]]:
    """
    Scan a skill's SKILL.md for tool-specific markers.

    Returns a dict of {tool_name: [reasons]} for every tool that the skill
    appears to be tightly coupled to.  An empty dict means the skill looks
    generic / portable.

    Example return: {"openclaw": ["uses user-invocable field", "metadata.openclaw block"]}
    """
    fm = _parse_frontmatter(skill_dir)
    if fm is None:
        return {}

    results: dict[str, list[str]] = {}

    # Check OpenClaw-specific fields
    oc_reasons: list[str] = []
    for field in OPENCLAW_ONLY_FIELDS:
        if re.search(rf"^\s*{re.escape(field)}\s*:", fm, re.MULTILINE):
            oc_reasons.append(f"uses '{field}' field")
    for key in OPENCLAW_METADATA_KEYS:
        if re.search(rf"^\s*{re.escape(key)}\s*:", fm, re.MULTILINE):
            oc_reasons.append(f"has metadata.{key} block")
    if oc_reasons:
        results["openclaw"] = oc_reasons

    # Check allowed-tools for brand-specific patterns
    for brand, pattern in BRAND_TOOL_PATTERNS.items():
        if pattern.search(fm):
            results.setdefault(brand, []).append("allowed-tools references tool-specific names")

    return results


def compatible_targets(
    skill_dir: Path,
    all_targets: list[str],
    source_tool: str | None = None,
) -> tuple[list[str], list[str], dict[str, list[str]]]:
    """
    Given a skill directory and the full list of configured targets, return:
      (safe_targets, warn_targets, warnings)

    - safe_targets: targets the skill should work fine on
    - warn_targets: targets the skill *might* work on but has tool-specific features
    - warnings: dict of {target: [reasons]} explaining each warning

    If the skill was adopted from a known source, that source is always safe.
    """
    specifics = detect_tool_specifics(skill_dir)

    safe: list[str] = []
    warn: list[str] = []
    warnings: dict[str, list[str]] = {}

    for t in all_targets:
        if specifics and t not in specifics and any(s != t for s in specifics):
            # Skill has tool-specific features for a *different* tool
            # The converter will strip them, but the skill may not make sense
            coupled_to = [s for s in specifics if s != t]
            reasons = []
            for s in coupled_to:
                reasons.extend(
                    f"{r} (specific to {s})" for r in specifics[s]
                )
            warn.append(t)
            warnings[t] = reasons
        else:
            safe.append(t)

    # Source tool is always safe (the skill came from there)
    if source_tool and source_tool in warn:
        warn.remove(source_tool)
        safe.append(source_tool)
        warnings.pop(source_tool, None)

    return safe, warn, warnings
