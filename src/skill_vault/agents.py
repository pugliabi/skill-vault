"""
Agent definition (subagent) porting between harnesses.

Each harness stores agents as a Markdown file with YAML frontmatter, but the
frontmatter differs (field names, tool names, model names, file layout).
Porting goes through a neutral, harness-independent representation:

  - ``name``, ``description`` — copied as-is
  - ``tools``     — translated via canonical tool categories
                    (read, edit, search, execute, web, agent, todo, and
                    MCP tools as ``server/tool``)
  - ``model``     — translated only when the family is unambiguous
  - body          — copied as-is

Fields with no equivalent in the target harness are dropped with a warning,
the same approach ``compat.py`` takes for tool-specific skill fields.

Supported harnesses: ``claude`` (Claude Code) and ``copilot`` (GitHub Copilot
custom agents).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

HARNESSES = ("claude", "copilot")

# Fields every supported harness understands; everything else is harness-only.
_PORTABLE_FIELDS = ("name", "description", "tools", "model")

_FILE_SUFFIX = {"claude": ".md", "copilot": ".agent.md"}

# ── Tool name translation ────────────────────────────────────

# Harness tool name (case-insensitive) → canonical category
_TO_CANONICAL: dict[str, dict[str, str]] = {
    "claude": {
        "read": "read", "notebookread": "read",
        "edit": "edit", "write": "edit", "multiedit": "edit", "notebookedit": "edit",
        "grep": "search", "glob": "search", "ls": "search",
        "bash": "execute",
        "websearch": "web", "webfetch": "web",
        "task": "agent", "agent": "agent",
        "todowrite": "todo",
    },
    "copilot": {
        "read": "read", "notebookread": "read",
        "edit": "edit", "write": "edit", "multiedit": "edit", "notebookedit": "edit",
        "search": "search", "grep": "search", "glob": "search",
        "execute": "execute", "shell": "execute", "bash": "execute", "powershell": "execute",
        "web": "web", "websearch": "web", "webfetch": "web",
        "agent": "agent", "custom-agent": "agent", "task": "agent",
        "todo": "todo", "todowrite": "todo",
    },
}

# Canonical category → harness tool names
_FROM_CANONICAL: dict[str, dict[str, list[str]]] = {
    "claude": {
        "read": ["Read"],
        "edit": ["Edit", "Write"],
        "search": ["Grep", "Glob"],
        "execute": ["Bash"],
        "web": ["WebSearch", "WebFetch"],
        "agent": ["Task"],
        "todo": ["TodoWrite"],
    },
    "copilot": {c: [c] for c in ("read", "edit", "search", "execute", "web", "agent", "todo")},
}

_MODEL_FAMILIES = ("opus", "sonnet", "haiku")


@dataclass
class AgentDef:
    """Harness-independent agent definition."""

    name: str
    description: str = ""
    tools: list[str] | None = None  # canonical names; None = all tools
    model: str | None = None  # model family ("opus", "sonnet", "haiku") or None
    body: str = ""
    extra: dict[str, Any] = field(default_factory=dict)  # harness-only fields
    warnings: list[str] = field(default_factory=list)


def _check_harness(harness: str) -> None:
    if harness not in HARNESSES:
        raise ValueError(f"Unsupported harness '{harness}' (supported: {', '.join(HARNESSES)})")


def _dedupe(items: list[str]) -> list[str]:
    return list(dict.fromkeys(items))


def _split(content: str) -> tuple[dict[str, Any], str]:
    m = re.match(r"^---\s*\r?\n(.*?)\r?\n---\s*(?:\r?\n|$)(.*)", content, re.DOTALL)
    if not m:
        return {}, content
    data = yaml.safe_load(m.group(1)) or {}
    if not isinstance(data, dict):
        raise ValueError("Agent frontmatter must be a YAML mapping")
    return data, m.group(2)


def _tool_list(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        return [t.strip() for t in raw.split(",") if t.strip()]
    return [str(t).strip() for t in raw if str(t).strip()]


def _tool_to_canonical(tool: str, harness: str) -> str | None:
    if harness == "claude" and tool.startswith("mcp__"):
        parts = tool[len("mcp__"):].split("__", 1)
        return f"{parts[0]}/{parts[1] if len(parts) > 1 else '*'}"
    if harness == "copilot" and "/" in tool:
        return tool
    return _TO_CANONICAL[harness].get(tool.lower())


def _tool_from_canonical(tool: str, harness: str) -> list[str]:
    if "/" in tool:
        server, name = tool.split("/", 1)
        if harness == "claude":
            return [f"mcp__{server}" if name == "*" else f"mcp__{server}__{name}"]
        return [tool]
    return _FROM_CANONICAL[harness].get(tool, [])


def _model_family(model: str) -> str | None:
    low = model.lower()
    for fam in _MODEL_FAMILIES:
        if fam in low:
            return fam
    return None


def agent_stem(filename: str) -> str:
    """Strip a harness agent file suffix (``.agent.md`` / ``.md``)."""
    for suffix in (".agent.md", ".md"):
        if filename.endswith(suffix):
            return filename[: -len(suffix)]
    return filename


def agent_filename(name: str, harness: str) -> str:
    _check_harness(harness)
    return f"{name}{_FILE_SUFFIX[harness]}"


# ── Parse / render ───────────────────────────────────────────


def parse_agent(content: str, harness: str, filename: str | None = None) -> AgentDef:
    """Parse a harness agent file into a neutral :class:`AgentDef`."""
    _check_harness(harness)
    fm, body = _split(content)
    name = str(fm.get("name") or (agent_stem(Path(filename).name) if filename else "")).strip()
    if not name:
        raise ValueError("Agent has no 'name' in frontmatter and no filename to derive it from")

    agent = AgentDef(name=name, description=str(fm.get("description") or "").strip(), body=body)

    raw_tools = _tool_list(fm.get("tools"))
    if raw_tools and raw_tools != ["*"]:
        canonical: list[str] = []
        for t in raw_tools:
            c = _tool_to_canonical(t, harness)
            if c is None:
                agent.warnings.append(f"tool '{t}' has no known equivalent — dropped")
            else:
                canonical.append(c)
        agent.tools = _dedupe(canonical)

    raw_model = fm.get("model")
    if raw_model and str(raw_model).strip().lower() != "inherit":
        fam = _model_family(str(raw_model))
        if fam:
            agent.model = fam
        else:
            agent.warnings.append(f"model '{raw_model}' has no portable equivalent — dropped")

    agent.extra = {k: v for k, v in fm.items() if k not in _PORTABLE_FIELDS}
    return agent


def render_agent(agent: AgentDef, harness: str) -> tuple[str, list[str]]:
    """Render a neutral agent for *harness*. Returns ``(content, warnings)``."""
    _check_harness(harness)
    warnings: list[str] = []
    fm: dict[str, Any] = {"name": agent.name, "description": agent.description}

    if agent.tools is not None:
        tools: list[str] = []
        for t in agent.tools:
            mapped = _tool_from_canonical(t, harness)
            if not mapped:
                warnings.append(f"tool '{t}' has no {harness} equivalent — dropped")
            tools.extend(mapped)
        tools = _dedupe(tools)
        fm["tools"] = ", ".join(tools) if harness == "claude" else tools

    if agent.model:
        if harness == "claude":
            fm["model"] = agent.model
        else:
            # Copilot model names are account/IDE specific; let it use its default.
            warnings.append(f"model '{agent.model}' not set — {harness} model names differ, using default")

    for key in agent.extra:
        warnings.append(f"field '{key}' has no {harness} equivalent — dropped")

    header = yaml.safe_dump(fm, sort_keys=False, allow_unicode=True, width=10_000).rstrip()
    body = agent.body if agent.body.startswith("\n") else "\n" + agent.body
    return f"---\n{header}\n---\n{body}", warnings


# ── Public API ───────────────────────────────────────────────


def port_agent(
    content: str, source: str, target: str, filename: str | None = None
) -> tuple[str, str, list[str]]:
    """
    Translate an agent definition from *source* harness to *target* harness.

    Returns ``(target_filename, target_content, warnings)``.
    """
    agent = parse_agent(content, source, filename)
    out, render_warnings = render_agent(agent, target)
    return agent_filename(agent.name, target), out, agent.warnings + render_warnings


def find_agent_files(path: Path) -> list[Path]:
    """Return agent definition files at *path* (a single file or a directory)."""
    if path.is_file():
        return [path]
    return sorted(p for p in path.glob("*.md") if p.is_file())
