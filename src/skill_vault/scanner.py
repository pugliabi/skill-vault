"""
Repo scanner — scan local repos for skills, hooks, commands, and tools.

Supports three repo shapes:
  1. Root-level SKILL.md — the repo IS the skill
  2. skills/ directory — scan subdirs for skill content
  3. Plugin repos (npm, pip, etc.) — AI reads README + referenced URLs

AI analysis is configurable: claude-cli, anthropic-sdk, or none (heuristic-only).
"""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class ScannedItem:
    """A single item found in a scanned repo."""

    name: str
    item_type: str  # "skill", "hook", "command", "tool"
    path: Path
    description: str = ""
    has_skill_md: bool = False
    file_count: int = 0


@dataclass
class RepoScanResult:
    """Full result of scanning a repo."""

    repo_name: str
    repo_path: Path
    repo_type: str  # "skill", "collection", "plugin", "unknown"
    items: list[ScannedItem] = field(default_factory=list)
    install_instructions: str = ""
    ai_analysis: str = ""
    readme_content: str = ""


def heuristic_prescan(repo_path: Path) -> RepoScanResult:
    """Fast heuristic scan — no AI needed.

    Detects skills by:
      1. Root-level SKILL.md -> repo IS the skill
      2. Recursive search for SKILL.md anywhere in the repo tree
      3. README.md parsing for skill listings (names + descriptions)
      4. .claude/commands/, .claude/hooks.json -> hooks/commands
      5. .cursor/rules/ -> cursor rules
      6. package.json/setup.py -> plugin type detection
    """
    name = repo_path.name
    result = RepoScanResult(repo_name=name, repo_path=repo_path, repo_type="unknown")

    # Read README for skill extraction and later AI analysis
    for readme_name in ("README.md", "readme.md", "README.rst", "README.txt", "README"):
        readme = repo_path / readme_name
        if readme.exists():
            try:
                result.readme_content = readme.read_text(encoding="utf-8", errors="replace")[:15000]
            except OSError:
                pass
            break

    # Shape 1: Root-level SKILL.md — repo IS the skill
    skill_md = repo_path / "SKILL.md"
    if not skill_md.exists():
        skill_md = repo_path / "skill.md"
    if skill_md.exists():
        result.repo_type = "skill"
        desc = _extract_frontmatter_field(skill_md, "description")
        file_count = sum(1 for f in repo_path.rglob("*") if f.is_file() and _not_ignored(f))
        result.items.append(ScannedItem(
            name=name,
            item_type="skill",
            path=repo_path,
            description=desc,
            has_skill_md=True,
            file_count=file_count,
        ))
        return result

    # Shape 2: Deep recursive search for SKILL.md files ANYWHERE in the repo
    # This catches repos like AI-Research-SKILLs where skills live in
    # category-dir/skill-name/SKILL.md (not under a top-level skills/ dir)
    found_skill_mds: list[Path] = []
    for sm in repo_path.rglob("SKILL.md"):
        if _not_ignored(sm):
            found_skill_mds.append(sm)
    for sm in repo_path.rglob("skill.md"):
        if _not_ignored(sm) and sm not in found_skill_mds:
            found_skill_mds.append(sm)

    if found_skill_mds:
        result.repo_type = "collection"
        seen_names: set[str] = set()
        for sm in sorted(found_skill_mds):
            skill_dir = sm.parent
            # Use the skill directory name, not the SKILL.md parent's parent
            skill_name = skill_dir.name
            if skill_name in seen_names or skill_name == repo_path.name:
                continue
            seen_names.add(skill_name)
            desc = _extract_frontmatter_field(sm, "description")
            file_count = sum(1 for f in skill_dir.rglob("*") if f.is_file() and _not_ignored(f))
            result.items.append(ScannedItem(
                name=skill_name,
                item_type="skill",
                path=skill_dir,
                description=desc,
                has_skill_md=True,
                file_count=file_count,
            ))

    # Shape 3: Parse README for skill listings when no SKILL.md files found
    # Many repos list skills in the README with names and descriptions
    if not result.items and result.readme_content:
        readme_skills = _extract_skills_from_readme(result.readme_content, repo_path)
        if readme_skills:
            result.repo_type = "collection"
            result.items.extend(readme_skills)

    # Also follow links from README to other .md files that might list skills
    if not result.items and result.readme_content:
        linked_mds = _find_linked_local_mds(result.readme_content, repo_path)
        for linked_md in linked_mds:
            try:
                content = linked_md.read_text(encoding="utf-8", errors="replace")[:10000]
                linked_skills = _extract_skills_from_readme(content, repo_path)
                if linked_skills:
                    result.repo_type = "collection"
                    result.items.extend(linked_skills)
                    break  # Found skills in a linked doc — stop
            except OSError:
                continue

    # Also scan for .claude/commands/
    claude_cmds = repo_path / ".claude" / "commands"
    if claude_cmds.is_dir():
        for md_file in claude_cmds.glob("*.md"):
            result.items.append(ScannedItem(
                name=md_file.stem,
                item_type="command",
                path=md_file,
                description=f"Claude command: {md_file.stem}",
            ))

    # Scan for .claude/hooks.json
    hooks_file = repo_path / ".claude" / "hooks.json"
    if hooks_file.exists():
        try:
            hooks_data = json.loads(hooks_file.read_text(encoding="utf-8"))
            hook_count = sum(len(v) if isinstance(v, list) else 1 for v in hooks_data.values())
            result.items.append(ScannedItem(
                name="hooks",
                item_type="hook",
                path=hooks_file,
                description=f"{hook_count} hook(s) defined",
            ))
        except (json.JSONDecodeError, OSError):
            pass

    # Scan for .cursor/rules/
    cursor_rules = repo_path / ".cursor" / "rules"
    if cursor_rules.is_dir():
        for rule_file in cursor_rules.iterdir():
            if rule_file.is_file():
                result.items.append(ScannedItem(
                    name=rule_file.stem,
                    item_type="command",
                    path=rule_file,
                    description=f"Cursor rule: {rule_file.name}",
                ))

    # Scan for markdown files with skill-like frontmatter in root
    if not result.items:
        for md_file in repo_path.glob("*.md"):
            if md_file.name.lower() in ("readme.md", "changelog.md", "license.md", "contributing.md"):
                continue
            name_field = _extract_frontmatter_field(md_file, "name")
            desc_field = _extract_frontmatter_field(md_file, "description")
            if name_field and desc_field:
                result.items.append(ScannedItem(
                    name=name_field,
                    item_type="skill",
                    path=md_file.parent,
                    description=desc_field,
                    has_skill_md=True,
                    file_count=1,
                ))

    # Shape 3: Plugin detection
    pkg_json = repo_path / "package.json"
    if pkg_json.exists() and not result.items:
        result.repo_type = "plugin"
        try:
            pkg = json.loads(pkg_json.read_text(encoding="utf-8"))
            result.install_instructions = f"npm install (package: {pkg.get('name', 'unknown')})"
        except (json.JSONDecodeError, OSError):
            result.install_instructions = "npm install"

    setup_py = repo_path / "setup.py"
    pyproject = repo_path / "pyproject.toml"
    if (setup_py.exists() or pyproject.exists()) and not result.items:
        result.repo_type = "plugin"
        result.install_instructions = "pip install"

    if result.items and result.repo_type == "unknown":
        result.repo_type = "collection"

    return result


def ai_analyze_repo(
    repo_path: Path,
    prescan: RepoScanResult,
    provider: str = "claude-cli",
    api_key: str = "",
) -> RepoScanResult:
    """Use AI to deeply analyse a repo's README and structure.

    Follows URLs referenced in the README (one level deep) to understand
    install instructions and available skills/tools.
    """
    if provider == "none":
        return prescan

    readme = prescan.readme_content
    if not readme:
        return prescan

    # Extract URLs from README for context
    urls = _extract_urls(readme)
    url_contents: list[str] = []
    for url in urls[:3]:  # Follow up to 3 URLs
        content = _fetch_url_content(url)
        if content:
            url_contents.append(f"--- Content from {url} ---\n{content[:3000]}")

    # Build the prompt
    items_summary = ""
    if prescan.items:
        items_summary = "Heuristic scan found:\n" + "\n".join(
            f"  - {i.name} ({i.item_type}): {i.description}" for i in prescan.items
        )

    # Sanitize text for Windows subprocess compatibility
    safe_readme = _sanitize_for_subprocess(readme[:5000])
    safe_url_contents = [_sanitize_for_subprocess(c) for c in url_contents]

    prompt = f"""Analyse this repository and tell me what it provides for AI coding agents.

Repository: {repo_path.name}
README content:
{safe_readme}

{items_summary}

{"Referenced documentation:" + chr(10) + chr(10).join(safe_url_contents) if safe_url_contents else ""}

Respond in JSON format:
{{
  "repo_type": "skill|collection|plugin|tool",
  "description": "one-line summary",
  "install_method": "copy|npm_install|pip_install|manual|none",
  "install_instructions": "step by step if needed",
  "items": [
    {{"name": "item-name", "type": "skill|hook|command|tool", "description": "what it does", "path": "relative/path"}}
  ]
}}

Only include items that are actual skills, hooks, commands, or tools for AI coding agents.
Focus on what can be imported into a skill vault."""

    try:
        if provider == "claude-cli":
            ai_result = _call_claude_cli(prompt)
        elif provider == "anthropic-sdk":
            ai_result = _call_anthropic_sdk(prompt, api_key)
        else:
            return prescan

        if not ai_result:
            return prescan

        # Parse JSON from AI response
        parsed = _parse_json_from_response(ai_result)
        if not parsed:
            prescan.ai_analysis = ai_result
            return prescan

        prescan.ai_analysis = parsed.get("description", "")
        prescan.repo_type = parsed.get("repo_type", prescan.repo_type)
        if parsed.get("install_instructions"):
            prescan.install_instructions = parsed["install_instructions"]

        # Merge AI-found items with heuristic items
        existing_names = {i.name for i in prescan.items}
        for item_data in parsed.get("items", []):
            name = item_data.get("name", "")
            if name and name not in existing_names:
                item_path = repo_path / item_data.get("path", name)
                prescan.items.append(ScannedItem(
                    name=name,
                    item_type=item_data.get("type", "skill"),
                    path=item_path if item_path.exists() else repo_path,
                    description=item_data.get("description", ""),
                ))
                existing_names.add(name)

    except Exception as exc:
        prescan.ai_analysis = f"AI analysis failed: {exc}"

    return prescan


def scan_repos_dir(repos_dir: Path) -> list[tuple[str, str, int]]:
    """Quick scan of a repos directory — returns (name, type_hint, item_count) for each."""
    results: list[tuple[str, str, int]] = []

    if not repos_dir.is_dir():
        return results

    for entry in sorted(repos_dir.iterdir()):
        if not entry.is_dir() or entry.name.startswith("."):
            continue

        # Quick heuristic without full scan
        skill_md = entry / "SKILL.md"
        if not skill_md.exists():
            skill_md = entry / "skill.md"
        skills_dir = entry / "skills"
        pkg_json = entry / "package.json"

        if skill_md.exists():
            results.append((entry.name, "skill", 1))
        elif skills_dir.is_dir():
            count = sum(1 for d in skills_dir.iterdir() if d.is_dir() and not d.name.startswith("."))
            results.append((entry.name, "collection", count))
        else:
            # Deep scan: count SKILL.md files anywhere in the repo
            deep_skills = list(entry.rglob("SKILL.md"))
            deep_skills = [s for s in deep_skills if _not_ignored(s)]
            if deep_skills:
                results.append((entry.name, "collection", len(deep_skills)))
            elif pkg_json.exists():
                # Check README for skill listings even for plugins
                readme_count = 0
                for rn in ("README.md", "readme.md"):
                    rp = entry / rn
                    if rp.exists():
                        try:
                            content = rp.read_text(encoding="utf-8", errors="replace")[:10000]
                            readme_skills = _extract_skills_from_readme(content, entry)
                            readme_count = len(readme_skills)
                        except OSError:
                            pass
                        break
                results.append((entry.name, "plugin", readme_count))
            else:
                # Check for any .md with frontmatter
                has_skills = any(
                    _extract_frontmatter_field(f, "name")
                    for f in entry.glob("*.md")
                    if f.name.lower() not in ("readme.md", "changelog.md", "license.md")
                )
                if has_skills:
                    results.append((entry.name, "skills-like", 0))
                else:
                    results.append((entry.name, "unknown", 0))

    return results


@dataclass
class SearchHit:
    """A skill found by cross-repo search."""

    skill_name: str
    repo_name: str
    repo_path: Path
    skill_path: Path
    description: str = ""
    has_skill_md: bool = False
    file_count: int = 0


def search_across_repos(repos_dir: Path, query: str) -> list[SearchHit]:
    """Search for skills matching a query across all repos in a directory.

    Matches against skill name and description (case-insensitive substring).
    """
    query_lower = query.lower()
    hits: list[SearchHit] = []

    if not repos_dir.is_dir():
        return hits

    for entry in sorted(repos_dir.iterdir()):
        if not entry.is_dir() or entry.name.startswith("."):
            continue

        # Deep scan for SKILL.md files
        for sm in entry.rglob("SKILL.md"):
            if not _not_ignored(sm):
                continue
            skill_dir = sm.parent
            skill_name = skill_dir.name
            desc = _extract_frontmatter_field(sm, "description")

            if query_lower in skill_name.lower() or query_lower in desc.lower():
                file_count = sum(1 for f in skill_dir.rglob("*") if f.is_file() and _not_ignored(f))
                hits.append(SearchHit(
                    skill_name=skill_name,
                    repo_name=entry.name,
                    repo_path=entry,
                    skill_path=skill_dir,
                    description=desc,
                    has_skill_md=True,
                    file_count=file_count,
                ))

        # Also check README-extracted skills
        for rn in ("README.md", "readme.md"):
            rp = entry / rn
            if rp.exists():
                try:
                    content = rp.read_text(encoding="utf-8", errors="replace")[:15000]
                    readme_skills = _extract_skills_from_readme(content, entry)
                    for item in readme_skills:
                        if query_lower in item.name.lower() or query_lower in item.description.lower():
                            # Avoid duplicates from SKILL.md scan
                            if not any(h.skill_name == item.name and h.repo_name == entry.name for h in hits):
                                hits.append(SearchHit(
                                    skill_name=item.name,
                                    repo_name=entry.name,
                                    repo_path=entry,
                                    skill_path=item.path,
                                    description=item.description,
                                    has_skill_md=item.has_skill_md,
                                    file_count=item.file_count,
                                ))
                except OSError:
                    pass
                break

    return hits


# ── Internal helpers ─────────────────────────────────────────


def _extract_skills_from_readme(readme_content: str, repo_path: Path) -> list[ScannedItem]:
    """Parse a README for skill listings.

    Detects patterns like:
      - **[SkillName](path/)** - Description text
      - **SkillName** - Description text
      - | SkillName | Description | ... |
      - - SkillName: Description
    """
    items: list[ScannedItem] = []
    seen: set[str] = set()

    # Pattern 1: **[Name](path/)** - Description (most common in skill repos)
    # e.g. **[Axolotl](03-fine-tuning/axolotl/)** - YAML-based fine-tuning...
    pattern1 = re.compile(
        r"\*\*\[([^\]]+)\]\(([^)]+)\)\*\*\s*[-–—]\s*(.+?)(?:\((\d+)\s*lines)?",
        re.MULTILINE,
    )
    for m in pattern1.finditer(readme_content):
        skill_name = m.group(1).strip()
        rel_path = m.group(2).strip().rstrip("/")
        desc = m.group(3).strip().rstrip("(").strip()
        # Truncate description
        if len(desc) > 120:
            desc = desc[:117] + "..."

        if skill_name.lower() in seen:
            continue
        seen.add(skill_name.lower())

        # Try to resolve the path to a real directory
        skill_path = repo_path / rel_path
        if not skill_path.exists():
            skill_path = repo_path  # fallback

        file_count = 0
        has_skill_md = False
        if skill_path.is_dir() and skill_path != repo_path:
            file_count = sum(1 for f in skill_path.rglob("*") if f.is_file() and _not_ignored(f))
            has_skill_md = (skill_path / "SKILL.md").exists() or (skill_path / "skill.md").exists()

        items.append(ScannedItem(
            name=skill_name.lower().replace(" ", "-"),
            item_type="skill",
            path=skill_path,
            description=desc,
            has_skill_md=has_skill_md,
            file_count=file_count,
        ))

    if items:
        return items

    # Pattern 2: **Name** — Description (bold name with dash separator)
    pattern2 = re.compile(
        r"^\s*[-*]\s*\*\*([^*]+)\*\*\s*[-–—:]\s*(.+)$",
        re.MULTILINE,
    )
    for m in pattern2.finditer(readme_content):
        skill_name = m.group(1).strip()
        desc = m.group(2).strip()
        if len(desc) > 120:
            desc = desc[:117] + "..."

        # Skip non-skill entries (common headings, badges, etc.)
        if skill_name.lower() in ("note", "warning", "tip", "important", "example"):
            continue
        if skill_name.lower() in seen:
            continue
        seen.add(skill_name.lower())

        items.append(ScannedItem(
            name=skill_name.lower().replace(" ", "-"),
            item_type="skill",
            path=repo_path,
            description=desc,
        ))

    return items


def _find_linked_local_mds(readme_content: str, repo_path: Path) -> list[Path]:
    """Find local .md files linked from the README."""
    linked: list[Path] = []
    # Match markdown links to local .md files: [text](path.md) or [text](dir/path.md)
    link_pattern = re.compile(r"\[([^\]]+)\]\(([^)]+\.md)\)")
    for m in link_pattern.finditer(readme_content):
        rel_path = m.group(2)
        # Skip external URLs
        if rel_path.startswith("http://") or rel_path.startswith("https://"):
            continue
        # Strip anchors
        rel_path = rel_path.split("#")[0]
        full_path = repo_path / rel_path
        if full_path.exists() and full_path.is_file():
            linked.append(full_path)
    return linked[:5]  # Limit to 5 linked docs


def _sanitize_for_subprocess(text: str) -> str:
    """Remove characters that can't be encoded in Windows default codepage.

    Replaces emoji and non-BMP chars with ASCII approximations or removes them.
    This ensures subprocess pipes on Windows (cp1252) don't choke.
    """
    # Replace common emoji with text equivalents
    replacements = {
        "\U0001f4e6": "[package]",  # 📦
        "\U0001f680": "[rocket]",   # 🚀
        "\U0001f4dd": "[memo]",     # 📝
        "\U0001f4a1": "[idea]",     # 💡
        "\U0001f527": "[wrench]",   # 🔧
        "\U0001f50d": "[search]",   # 🔍
        "\u2728": "[sparkles]",     # ✨
        "\U0001f4cb": "[clipboard]", # 📋
        "\U0001f4c1": "[folder]",   # 📁
        "\U0001f4c4": "[doc]",      # 📄
    }
    for char, replacement in replacements.items():
        text = text.replace(char, replacement)

    # Remove any remaining non-ASCII chars that could cause encoding issues
    # Keep basic Unicode (accented chars etc) but strip emoji/symbols above BMP
    return "".join(
        c if ord(c) < 0x10000 else f"[U+{ord(c):04X}]"
        for c in text
    )


def _not_ignored(f: Path) -> bool:
    """Check if a file should be counted (not in ignored dirs)."""
    parts = f.parts
    ignore = {"node_modules", "__pycache__", ".git", ".venv", "venv"}
    return not any(p in ignore for p in parts)


def _extract_frontmatter_field(md_path: Path, field_name: str) -> str:
    """Pull a field from markdown frontmatter."""
    if not md_path.exists():
        return ""
    try:
        content = md_path.read_text(encoding="utf-8", errors="replace")
        m = re.match(r"^---\s*\r?\n(.*?)\r?\n---", content, re.DOTALL)
        if not m:
            return ""
        for line in m.group(1).split("\n"):
            line = line.strip()
            if line.startswith(f"{field_name}:"):
                val = line[len(field_name) + 1:].strip().strip('"').strip("'")
                return val[:200]
    except (OSError, UnicodeDecodeError):
        pass
    return ""


def _extract_urls(text: str) -> list[str]:
    """Extract URLs from text."""
    url_pattern = re.compile(r'https?://[^\s\)\]>"\']+')
    urls = url_pattern.findall(text)
    # Deduplicate while preserving order
    seen: set[str] = set()
    unique: list[str] = []
    for url in urls:
        # Strip trailing punctuation
        url = url.rstrip(".,;:!?")
        if url not in seen:
            seen.add(url)
            unique.append(url)
    return unique


def _fetch_url_content(url: str) -> str:
    """Fetch URL content, returning text. Best-effort."""
    try:
        import urllib.request
        req = urllib.request.Request(url, headers={"User-Agent": "skill-vault-scanner/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            content = resp.read().decode("utf-8", errors="replace")
            return content[:5000]
    except Exception:
        return ""


def _call_claude_cli(prompt: str) -> str:
    """Call claude CLI with a prompt and return the response.

    Pipes the prompt via stdin to avoid Windows command-line length limits.
    Uses UTF-8 encoding to handle emoji and special characters in README content.
    """
    import os

    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"

    try:
        result = subprocess.run(
            ["claude", "-p", "--output-format", "text"],
            input=prompt,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            env=env,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
        # If stdout is empty, check stderr for clues
        if result.stderr.strip():
            raise RuntimeError(f"claude CLI error: {result.stderr.strip()[:200]}")
    except FileNotFoundError:
        raise RuntimeError("claude CLI not found. Install Claude Code or use anthropic-sdk provider.")
    except subprocess.TimeoutExpired:
        raise RuntimeError("claude CLI timed out (120s). Try anthropic-sdk provider for faster results.")
    except OSError as exc:
        raise RuntimeError(f"claude CLI error: {exc}")
    return ""


def _call_anthropic_sdk(prompt: str, api_key: str = "") -> str:
    """Call Anthropic API directly using the SDK."""
    import os

    try:
        import anthropic
    except ImportError:
        raise RuntimeError(
            "anthropic package not installed. Run:\n"
            "  pipx inject skill-vault anthropic\n"
            "Or use: sv config set ai_scanner.provider claude-cli"
        )

    key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        raise RuntimeError(
            "No API key found. Set one with:\n"
            "  sv config set ai_scanner.api_key YOUR_KEY\n"
            "Or set the ANTHROPIC_API_KEY environment variable."
        )

    try:
        client = anthropic.Anthropic(api_key=key)
        message = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=2000,
            messages=[{"role": "user", "content": prompt}],
        )
        return message.content[0].text if message.content else ""
    except Exception as exc:
        raise RuntimeError(f"Anthropic API call failed: {exc}") from exc


def _parse_json_from_response(text: str) -> dict[str, Any] | None:
    """Extract JSON from an AI response (may be wrapped in markdown code blocks)."""
    # Try direct parse first
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Try extracting from code block
    m = re.search(r"```(?:json)?\s*\n(.*?)\n```", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass

    # Try finding JSON object in text
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass

    return None
