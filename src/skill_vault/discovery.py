"""
Skill discovery — scan agent tool directories for skills not in the vault.

Also handles:
  - Claude Code plugins (.claude-plugin/skills/)
  - Remote git repos (cloned to a temp dir, skills extracted)
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class DiscoveredSkill:
    """A skill found in an agent tool directory."""

    name: str
    source_tool: str
    path: Path
    has_skill_md: bool
    description: str
    file_count: int
    in_vault: bool


def _extract_description(skill_md: Path) -> str:
    """Pull the description from SKILL.md frontmatter."""
    if not skill_md.exists():
        return ""
    try:
        content = skill_md.read_text(encoding="utf-8", errors="replace")
        m = re.match(r"^---\s*\r?\n(.*?)\r?\n---", content, re.DOTALL)
        if not m:
            return ""
        for line in m.group(1).split("\n"):
            line = line.strip()
            if line.startswith("description:"):
                desc = line[len("description:"):].strip().strip('"').strip("'")
                return desc[:120] + "…" if len(desc) > 120 else desc
    except Exception:
        pass
    return ""


def scan_agent_dir(tool_name: str, agent_dir: Path, vault_skills: set[str]) -> list[DiscoveredSkill]:
    """Scan a single agent directory and return discovered skills."""
    results: list[DiscoveredSkill] = []
    if not agent_dir.exists():
        return results

    for entry in sorted(agent_dir.iterdir()):
        if not entry.is_dir():
            continue
        if entry.name.startswith(".") or entry.name in ("node_modules", "__pycache__"):
            continue

        skill_md = entry / "SKILL.md"
        has_md = skill_md.exists()

        # Also check for legacy command format (just a .md file)
        if not has_md:
            skill_md_alt = entry / "skill.md"
            has_md = skill_md_alt.exists()
            if has_md:
                skill_md = skill_md_alt

        file_count = sum(
            1 for f in entry.rglob("*")
            if f.is_file() and "node_modules" not in str(f)
        )

        results.append(DiscoveredSkill(
            name=entry.name,
            source_tool=tool_name,
            path=entry,
            has_skill_md=has_md,
            description=_extract_description(skill_md) if has_md else "",
            file_count=file_count,
            in_vault=entry.name in vault_skills,
        ))

    return results


def scan_all_agents(
    agent_locations: dict[str, Path],
    vault_skills: set[str],
) -> dict[str, list[DiscoveredSkill]]:
    """Scan all configured agent directories. Returns {tool_name: [skills]}."""
    results: dict[str, list[DiscoveredSkill]] = {}
    for tool, path in agent_locations.items():
        found = scan_agent_dir(tool, path, vault_skills)
        if found:
            results[tool] = found
    return results


def detect_agent_dirs() -> dict[str, Path]:
    """Auto-detect which agent skill directories exist on this machine.

    Checks both the hardcoded defaults and any custom providers already
    saved in the user's config, so custom providers persist across sessions.
    """
    from skill_vault.config import DEFAULT_AGENT_LOCATIONS, load_config

    # Start with hardcoded defaults
    candidates: dict[str, str] = dict(DEFAULT_AGENT_LOCATIONS)

    # Merge in any custom providers from saved config
    cfg = load_config()
    for name, path_str in cfg.get("agent_locations", {}).items():
        if name not in candidates:
            candidates[name] = path_str

    found: dict[str, Path] = {}
    for name, path_str in candidates.items():
        p = Path(path_str).expanduser()
        # Check if the parent tool dir exists (e.g., ~/.claude exists even if ~/.claude/skills doesn't yet)
        tool_dir = p.parent
        if tool_dir.exists():
            found[name] = p
    return found


# ── Claude Plugin Discovery ────────────────────────────────────


@dataclass
class PluginInfo:
    """Metadata about a discovered Claude Code plugin."""
    name: str
    description: str
    version: str
    path: Path
    skills_dir: Path
    skill_count: int


def scan_claude_plugins(search_dirs: list[Path] | None = None) -> list[PluginInfo]:
    """
    Scan for Claude Code plugins that contain skills.

    Plugins are directories with a `.claude-plugin/plugin.json` manifest
    and a `skills/` subdirectory.

    Default search locations:
      - ~/.claude/plugins/
      - Any project dirs with .claude-plugin/ at root
    """
    if search_dirs is None:
        search_dirs = []
        # Standard plugin locations
        claude_plugins = Path.home() / ".claude" / "plugins"
        if claude_plugins.exists():
            search_dirs.append(claude_plugins)

    plugins: list[PluginInfo] = []

    for search_dir in search_dirs:
        if not search_dir.exists():
            continue

        # Check if search_dir itself is a plugin
        candidates = [search_dir]
        # Also check immediate subdirectories
        if search_dir.is_dir():
            candidates.extend(
                d for d in search_dir.iterdir()
                if d.is_dir() and not d.name.startswith(".")
            )

        for candidate in candidates:
            manifest_file = candidate / ".claude-plugin" / "plugin.json"
            if not manifest_file.exists():
                continue

            try:
                manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue

            skills_dir = candidate / "skills"
            if not skills_dir.exists() or not skills_dir.is_dir():
                continue

            skill_dirs = [
                d for d in skills_dir.iterdir()
                if d.is_dir() and not d.name.startswith(".")
            ]
            if not skill_dirs:
                continue

            plugins.append(PluginInfo(
                name=manifest.get("name", candidate.name),
                description=manifest.get("description", ""),
                version=manifest.get("version", "unknown"),
                path=candidate,
                skills_dir=skills_dir,
                skill_count=len(skill_dirs),
            ))

    return plugins


def scan_plugin_skills(
    plugin: PluginInfo,
    vault_skills: set[str],
) -> list[DiscoveredSkill]:
    """Scan a plugin's skills/ directory for adoptable skills."""
    source_name = f"plugin:{plugin.name}"
    return scan_agent_dir(source_name, plugin.skills_dir, vault_skills)


# ── Remote Git Repo Discovery ───────────────────────────────


@dataclass
class RemoteRepoInfo:
    """Info about a cloned remote repo containing skills."""
    url: str
    clone_dir: Path
    skills_dirs: list[Path] = field(default_factory=list)
    is_plugin: bool = False
    plugin_name: str = ""


def clone_remote_repo(url: str, branch: str | None = None) -> RemoteRepoInfo:
    """
    Clone a git repo to a temp directory and locate skills within it.

    Supports:
      - Regular repos with skills/ at any level
      - Claude plugins (has .claude-plugin/plugin.json + skills/)
      - Repos with .claude/skills/ or .agents/skills/

    Returns a RemoteRepoInfo with the clone dir and discovered skill locations.
    The caller is responsible for cleanup (shutil.rmtree on clone_dir).
    """
    clone_dir = Path(tempfile.mkdtemp(prefix="sv-clone-"))

    cmd = ["git", "clone", "--depth", "1"]
    if branch:
        cmd.extend(["--branch", branch])
    cmd.extend([url, str(clone_dir)])

    try:
        subprocess.run(
            cmd,
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.CalledProcessError as e:
        shutil.rmtree(clone_dir, ignore_errors=True)
        raise RuntimeError(f"Failed to clone {url}: {e.stderr.strip()}") from e
    except subprocess.TimeoutExpired:
        shutil.rmtree(clone_dir, ignore_errors=True)
        raise RuntimeError(f"Clone timed out for {url}")

    info = RemoteRepoInfo(url=url, clone_dir=clone_dir)

    # Check if it's a Claude plugin
    plugin_json = clone_dir / ".claude-plugin" / "plugin.json"
    if plugin_json.exists():
        try:
            manifest = json.loads(plugin_json.read_text(encoding="utf-8"))
            info.is_plugin = True
            info.plugin_name = manifest.get("name", "")
        except (json.JSONDecodeError, OSError):
            pass

    # Find all directories named "skills" that contain skill subdirectories
    for skills_dir in clone_dir.rglob("skills"):
        if not skills_dir.is_dir():
            continue
        # Skip if inside node_modules, __pycache__, .git, or backup
        parts = skills_dir.parts
        if any(p in ("node_modules", "__pycache__", ".git", "backup") for p in parts):
            continue
        # Check if it contains at least one subdirectory with SKILL.md
        has_skills = any(
            (d / "SKILL.md").exists() or (d / "skill.md").exists()
            for d in skills_dir.iterdir()
            if d.is_dir() and not d.name.startswith(".")
        )
        if has_skills:
            info.skills_dirs.append(skills_dir)

    # Also check .claude/skills/ and .agents/skills/ at root
    for prefix in (".claude", ".agents"):
        alt = clone_dir / prefix / "skills"
        if alt.exists() and alt.is_dir() and alt not in info.skills_dirs:
            has_skills = any(
                (d / "SKILL.md").exists() or (d / "skill.md").exists()
                for d in alt.iterdir()
                if d.is_dir() and not d.name.startswith(".")
            )
            if has_skills:
                info.skills_dirs.append(alt)

    return info


def scan_remote_skills(
    repo_info: RemoteRepoInfo,
    vault_skills: set[str],
) -> dict[str, list[DiscoveredSkill]]:
    """
    Scan all skills directories found in a cloned remote repo.
    Returns {source_label: [skills]} where source_label indicates the path context.
    """
    results: dict[str, list[DiscoveredSkill]] = {}

    for skills_dir in repo_info.skills_dirs:
        # Create a readable label from the path relative to clone root
        rel = skills_dir.relative_to(repo_info.clone_dir)
        if repo_info.is_plugin and repo_info.plugin_name:
            label = f"plugin:{repo_info.plugin_name}/{rel}"
        else:
            label = f"remote:{rel}"

        found = scan_agent_dir(label, skills_dir, vault_skills)
        if found:
            results[label] = found

    return results
