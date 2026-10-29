"""
Agent definition (subagent) porting between harnesses.

Skills share one portable format (agentskills.io), but agent definitions do
not: each harness has its own frontmatter fields, tool names, model names and
file layout.  This module translates single-file agent definitions between:

- ``claude``  — Claude Code subagents, ``~/.claude/agents/<name>.md``
- ``copilot`` — GitHub Copilot CLI custom agents, ``~/.copilot/agents/<name>.agent.md``

Translation goes through a neutral tool vocabulary (Copilot's primary tool
aliases: execute, read, edit, search, agent, web, todo).  Fields with no
equivalent in the target are dropped and reported as warnings, mirroring how
``compat.py`` reports tool-specific skill fields.  A translation that would
*widen* an agent's tool access (e.g. every listed tool is unmappable) is
refused rather than silently granting all tools.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


class AgentPortError(ValueError):
    """Raised when an agent definition cannot be parsed or safely translated."""


@dataclass(frozen=True)
class Harness:
    name: str
    directory: Path
    extension: str


HARNESSES: dict[str, Harness] = {
    "claude": Harness("claude", Path.home() / ".claude" / "agents", ".md"),
    "copilot": Harness("copilot", Path.home() / ".copilot" / "agents", ".agent.md"),
}

# Fields every supported harness understands; everything else is harness-specific.
_CORE_FIELDS = ("name", "description", "tools", "model")

COPILOT_PROMPT_LIMIT = 30_000

# ── Tool vocabularies ────────────────────────────────────────

_CLAUDE_TO_NEUTRAL: dict[str, str] = {
    "bash": "execute",
    "read": "read",
    "notebookread": "read",
    "edit": "edit",
    "multiedit": "edit",
    "write": "edit",
    "notebookedit": "edit",
    "grep": "search",
    "glob": "search",
    "ls": "search",
    "task": "agent",
    "webfetch": "web",
    "websearch": "web",
    "todowrite": "todo",
}

_NEUTRAL_TO_CLAUDE: dict[str, list[str]] = {
    "execute": ["Bash"],
    "read": ["Read"],
    "edit": ["Edit", "Write"],
    "search": ["Grep", "Glob"],
    "agent": ["Task"],
    "web": ["WebFetch", "WebSearch"],
    "todo": ["TodoWrite"],
}

# Copilot accepts these (case-insensitive) as aliases of its primary names.
_COPILOT_TO_NEUTRAL: dict[str, str] = {
    "execute": "execute", "shell": "execute", "bash": "execute", "powershell": "execute",
    "read": "read", "notebookread": "read",
    "edit": "edit", "multiedit": "edit", "write": "edit", "notebookedit": "edit",
    "search": "search", "grep": "search", "glob": "search",
    "agent": "agent", "custom-agent": "agent", "task": "agent",
    "web": "web", "websearch": "web", "webfetch": "web",
    "todo": "todo", "todowrite": "todo",
}

_CLAUDE_MODEL_ALIASES = {"sonnet", "opus", "haiku", "opusplan"}
_CLAUDE_FULL_MODEL = re.compile(
    r"^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$", re.I
)
_COPILOT_CLAUDE_MODEL = re.compile(r"^claude-(opus|sonnet|haiku)-(\d+)(?:\.(\d+))?$", re.I)


# ── Data types ───────────────────────────────────────────────


@dataclass
class AgentDefinition:
    stem: str
    frontmatter: dict[str, Any]
    body: str


@dataclass
class PortResult:
    filename: str
    text: str
    warnings: list[str] = field(default_factory=list)
    path: Path | None = None


# ── Parsing ──────────────────────────────────────────────────


def agent_stem(path: Path) -> str:
    name = path.name
    for ext in (".agent.md", ".md"):
        if name.lower().endswith(ext):
            return name[: -len(ext)]
    return path.stem


def parse_agent_text(text: str, stem: str) -> AgentDefinition:
    m = re.match(r"^\ufeff?---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)(.*)", text, re.DOTALL)
    if not m:
        raise AgentPortError(f"'{stem}': no YAML frontmatter found")
    try:
        fm = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError as e:
        raise AgentPortError(f"'{stem}': invalid YAML frontmatter ({e})") from e
    if not isinstance(fm, dict):
        raise AgentPortError(f"'{stem}': frontmatter must be a mapping")
    return AgentDefinition(stem=stem, frontmatter=fm, body=m.group(2))


def parse_agent_file(path: Path) -> AgentDefinition:
    return parse_agent_text(path.read_text(encoding="utf-8"), agent_stem(path))


def list_agent_files(harness: str, directory: Path | None = None) -> list[Path]:
    h = _harness(harness)
    d = directory or h.directory
    if not d.is_dir():
        return []
    return sorted(
        p for p in d.iterdir()
        if p.is_file() and p.name.lower().endswith(".md") and not p.name.startswith(".")
    )


def find_agent_file(harness: str, name: str, directory: Path | None = None) -> Path | None:
    for p in list_agent_files(harness, directory):
        if agent_stem(p) == name:
            return p
    return None


# ── Translation ──────────────────────────────────────────────


def _harness(name: str) -> Harness:
    if name not in HARNESSES:
        raise AgentPortError(
            f"unsupported harness '{name}' (supported: {', '.join(HARNESSES)})"
        )
    return HARNESSES[name]


def _tool_list(raw: Any) -> list[str] | None:
    """Normalise a tools value to a list. None means 'all tools'."""
    if raw is None:
        return None
    if isinstance(raw, str):
        return [t.strip() for t in raw.split(",") if t.strip()]
    if isinstance(raw, list):
        return [str(t).strip() for t in raw if str(t).strip()]
    raise AgentPortError(f"unsupported 'tools' value: {raw!r}")


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    return [x for x in items if not (x.lower() in seen or seen.add(x.lower()))]


def _claude_tools_to_copilot(tools: list[str], warnings: list[str]) -> list[str]:
    out: list[str] = []
    for tool in tools:
        if tool.startswith("mcp__"):
            parts = tool[len("mcp__"):].split("__", 1)
            out.append(f"{parts[0]}/{parts[1]}" if len(parts) == 2 else f"{parts[0]}/*")
            continue
        base, _, scope = tool.partition("(")
        neutral = _CLAUDE_TO_NEUTRAL.get(base.strip().lower())
        if neutral is None:
            warnings.append(f"dropped tool '{tool}' (no Copilot equivalent)")
            continue
        if scope:
            warnings.append(
                f"tool '{tool}' ported as '{neutral}'; the '({scope}' restriction is lost"
            )
        out.append(neutral)
    return _dedupe(out)


def _copilot_tools_to_claude(tools: list[str], warnings: list[str]) -> list[str]:
    out: list[str] = []
    for tool in tools:
        if "/" in tool:
            server, _, name = tool.partition("/")
            out.append(f"mcp__{server}" if name == "*" else f"mcp__{server}__{name}")
            continue
        neutral = _COPILOT_TO_NEUTRAL.get(tool.lower())
        if neutral is None:
            warnings.append(f"dropped tool '{tool}' (no Claude Code equivalent)")
            continue
        out.extend(_NEUTRAL_TO_CLAUDE[neutral])
    return _dedupe(out)


def _model_to_copilot(model: str, warnings: list[str]) -> str | None:
    if model.lower() == "inherit":
        return None
    m = _CLAUDE_FULL_MODEL.match(model)
    if m:
        family, major, minor = m.group(1).lower(), m.group(2), m.group(3)
        return f"claude-{family}-{major}.{minor}" if minor else f"claude-{family}-{major}"
    if model.lower() in _CLAUDE_MODEL_ALIASES:
        warnings.append(
            f"dropped model '{model}' (Claude alias has no versioned Copilot equivalent; "
            "the agent will use the default model)"
        )
        return None
    warnings.append(f"dropped model '{model}' (unrecognised; the agent will use the default model)")
    return None


def _model_to_claude(model: str, warnings: list[str]) -> str | None:
    m = _COPILOT_CLAUDE_MODEL.match(model)
    if m:
        family, major, minor = m.group(1).lower(), m.group(2), m.group(3)
        return f"claude-{family}-{major}-{minor}" if minor else f"claude-{family}-{major}"
    warnings.append(
        f"dropped model '{model}' (not available in Claude Code; the agent will inherit the main model)"
    )
    return None


def convert_agent(agent: AgentDefinition, source: str, target: str) -> PortResult:
    """Translate a parsed agent definition from ``source`` to ``target`` harness."""
    _harness(source)
    tgt = _harness(target)
    if source == target:
        raise AgentPortError("source and target harness are the same")

    fm = agent.frontmatter
    warnings: list[str] = []

    description = fm.get("description")
    if not description or not str(description).strip():
        raise AgentPortError(f"'{agent.stem}': missing required 'description'")

    out: dict[str, Any] = {}
    if target == "claude":
        # Claude Code identifies agents by `name` (lowercase, hyphenated); Copilot's
        # `name` is only a display name, so use the file name as the identifier.
        out["name"] = agent.stem
    else:
        out["name"] = str(fm.get("name") or agent.stem)
    out["description"] = str(description)

    tools = _tool_list(fm.get("tools"))
    if tools is not None and tools != ["*"]:
        if not tools:
            raise AgentPortError(
                f"'{agent.stem}': an empty tool list (no tools) cannot be expressed "
                f"for {target}; refusing to grant all tools"
            )
        mapped = (
            _claude_tools_to_copilot(tools, warnings)
            if target == "copilot"
            else _copilot_tools_to_claude(tools, warnings)
        )
        if not mapped:
            raise AgentPortError(
                f"'{agent.stem}': none of its tools ({', '.join(tools)}) map to {target}; "
                "refusing to grant all tools"
            )
        out["tools"] = mapped if target == "copilot" else ", ".join(mapped)

    model = fm.get("model")
    if model:
        mapped_model = (
            _model_to_copilot(str(model), warnings)
            if target == "copilot"
            else _model_to_claude(str(model), warnings)
        )
        if mapped_model:
            out["model"] = mapped_model

    for key in fm:
        if key not in _CORE_FIELDS:
            warnings.append(f"dropped field '{key}' (no {target} equivalent)")

    if target == "copilot" and len(agent.body) > COPILOT_PROMPT_LIMIT:
        warnings.append(
            f"prompt is {len(agent.body):,} characters; Copilot allows at most "
            f"{COPILOT_PROMPT_LIMIT:,}"
        )

    fm_text = yaml.safe_dump(
        out, sort_keys=False, allow_unicode=True, default_flow_style=False, width=10**6
    ).rstrip()
    return PortResult(
        filename=f"{agent.stem}{tgt.extension}",
        text=f"---\n{fm_text}\n---\n{agent.body}",
        warnings=warnings,
    )


def port_agent_file(
    src: Path,
    source: str,
    target: str,
    dest_dir: Path | None = None,
    *,
    overwrite: bool = False,
    dry_run: bool = False,
) -> PortResult:
    """Read ``src``, translate it, and write it into ``dest_dir`` (default: target's agent dir)."""
    result = convert_agent(parse_agent_file(src), source, target)
    out_dir = dest_dir or _harness(target).directory
    dest = out_dir / result.filename
    result.path = dest
    if dest.exists() and not overwrite:
        raise AgentPortError(f"{dest} already exists (use --force to overwrite)")
    if not dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)
        dest.write_text(result.text, encoding="utf-8")
    return result
