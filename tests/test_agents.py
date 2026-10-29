from pathlib import Path

import pytest
import yaml
from click.testing import CliRunner

from skill_vault import agents
from skill_vault.agents import (
    AgentPortError,
    Harness,
    convert_agent,
    parse_agent_text,
    port_agent_file,
)
from skill_vault.cli import cli


def _fm(text: str) -> dict:
    return yaml.safe_load(text.split("---\n")[1])


CLAUDE_AGENT = """---
name: code-reviewer
description: "Reviews code. Use after edits: proactively."
tools: Read, Grep, Glob, Bash, mcp__github__get_issue, NotebookEdit
model: claude-sonnet-4-5-20250929
color: blue
permissionMode: acceptEdits
---

You are a code reviewer.
"""

COPILOT_AGENT = """---
name: Docs Writer
description: Writes docs
tools: ["read", "edit", "playwright/*", "github/get_issue"]
model: claude-opus-4.1
target: vscode
mcp-servers:
  foo: {}
---
Write great docs.
"""


def test_claude_to_copilot_maps_tools_model_and_drops_fields():
    result = convert_agent(parse_agent_text(CLAUDE_AGENT, "code-reviewer"), "claude", "copilot")
    fm = _fm(result.text)

    assert result.filename == "code-reviewer.agent.md"
    assert fm == {
        "name": "code-reviewer",
        "description": "Reviews code. Use after edits: proactively.",
        "tools": ["read", "search", "execute", "github/get_issue", "edit"],
        "model": "claude-sonnet-4.5",
    }
    assert result.text.endswith("---\n\nYou are a code reviewer.\n")
    assert any("'color'" in w for w in result.warnings)
    assert any("'permissionMode'" in w for w in result.warnings)


def test_copilot_to_claude_uses_file_stem_and_comma_tools():
    result = convert_agent(parse_agent_text(COPILOT_AGENT, "docs-writer"), "copilot", "claude")
    fm = _fm(result.text)

    assert result.filename == "docs-writer.md"
    assert fm["name"] == "docs-writer"
    assert fm["tools"] == "Read, Edit, Write, mcp__playwright, mcp__github__get_issue"
    assert fm["model"] == "claude-opus-4-1"
    assert {w.split("'")[1] for w in result.warnings if w.startswith("dropped field")} == {
        "target", "mcp-servers",
    }


def test_round_trip_preserves_core_semantics():
    first = convert_agent(parse_agent_text(CLAUDE_AGENT, "code-reviewer"), "claude", "copilot")
    back = convert_agent(parse_agent_text(first.text, "code-reviewer"), "copilot", "claude")
    fm = _fm(back.text)
    assert fm["name"] == "code-reviewer"
    assert set(fm["tools"].split(", ")) >= {"Read", "Grep", "Glob", "Bash", "mcp__github__get_issue"}
    assert fm["model"] == "claude-sonnet-4-5"


@pytest.mark.parametrize(
    "model,expected",
    [("inherit", None), ("sonnet", None), ("claude-opus-4-20250514", "claude-opus-4"), ("gpt-5", None)],
)
def test_claude_model_mapping(model, expected):
    text = f"---\nname: a\ndescription: d\nmodel: {model}\n---\nbody\n"
    fm = _fm(convert_agent(parse_agent_text(text, "a"), "claude", "copilot").text)
    assert fm.get("model") == expected


def test_non_claude_model_dropped_for_claude_with_warning():
    text = "---\ndescription: d\nmodel: gpt-5\n---\nbody\n"
    result = convert_agent(parse_agent_text(text, "a"), "copilot", "claude")
    assert "model" not in _fm(result.text)
    assert any("gpt-5" in w for w in result.warnings)


def test_omitted_or_star_tools_stay_unrestricted():
    for tools in ("", "tools: ['*']\n"):
        text = f"---\ndescription: d\n{tools}---\nbody\n"
        assert "tools" not in _fm(convert_agent(parse_agent_text(text, "a"), "copilot", "claude").text)


def test_refuses_to_widen_tool_access():
    empty = "---\ndescription: d\ntools: []\n---\nbody\n"
    with pytest.raises(AgentPortError, match="empty tool list"):
        convert_agent(parse_agent_text(empty, "a"), "copilot", "claude")

    unmappable = "---\nname: a\ndescription: d\ntools: SomeCustomTool\n---\nbody\n"
    with pytest.raises(AgentPortError, match="refusing to grant all tools"):
        convert_agent(parse_agent_text(unmappable, "a"), "claude", "copilot")


def test_scoped_claude_tool_warns_about_lost_restriction():
    text = "---\nname: a\ndescription: d\ntools: Bash(git:*)\n---\nbody\n"
    result = convert_agent(parse_agent_text(text, "a"), "claude", "copilot")
    assert _fm(result.text)["tools"] == ["execute"]
    assert any("restriction is lost" in w for w in result.warnings)


@pytest.mark.parametrize(
    "text,match",
    [
        ("no frontmatter", "no YAML frontmatter"),
        ("---\nname: a\n---\nbody", "description"),
        ("---\nname: [a\n---\nbody", "invalid YAML"),
    ],
)
def test_invalid_definitions(text, match):
    with pytest.raises(AgentPortError, match=match):
        convert_agent(parse_agent_text(text, "a"), "claude", "copilot")


def test_same_or_unknown_harness_rejected():
    agent = parse_agent_text(CLAUDE_AGENT, "a")
    with pytest.raises(AgentPortError):
        convert_agent(agent, "claude", "claude")
    with pytest.raises(AgentPortError, match="unsupported harness"):
        convert_agent(agent, "claude", "cursor")


def test_port_agent_file_writes_and_respects_overwrite(tmp_path: Path):
    src = tmp_path / "code-reviewer.md"
    src.write_text(CLAUDE_AGENT, encoding="utf-8")
    out = tmp_path / "out"

    dry = port_agent_file(src, "claude", "copilot", out, dry_run=True)
    assert not dry.path.exists()

    result = port_agent_file(src, "claude", "copilot", out)
    assert result.path == out / "code-reviewer.agent.md"
    assert result.path.read_text(encoding="utf-8") == result.text

    with pytest.raises(AgentPortError, match="already exists"):
        port_agent_file(src, "claude", "copilot", out)
    port_agent_file(src, "claude", "copilot", out, overwrite=True)


def test_cli_port_all_by_harness_dirs(tmp_path: Path, monkeypatch):
    claude_dir = tmp_path / "claude"
    copilot_dir = tmp_path / "copilot"
    claude_dir.mkdir()
    (claude_dir / "code-reviewer.md").write_text(CLAUDE_AGENT, encoding="utf-8")
    (claude_dir / "broken.md").write_text("no frontmatter", encoding="utf-8")
    monkeypatch.setitem(agents.HARNESSES, "claude", Harness("claude", claude_dir, ".md"))
    monkeypatch.setitem(agents.HARNESSES, "copilot", Harness("copilot", copilot_dir, ".agent.md"))

    runner = CliRunner()
    listed = runner.invoke(cli, ["agents", "list", "--harness", "claude"])
    assert listed.exit_code == 0 and "code-reviewer" in listed.output

    result = runner.invoke(cli, ["agents", "port", "--all", "--from", "claude", "--to", "copilot"])
    assert result.exit_code == 1  # broken.md fails, others still ported
    assert (copilot_dir / "code-reviewer.agent.md").exists()
    assert "dropped field 'color'" in result.output

    single = runner.invoke(
        cli, ["agents", "port", "code-reviewer", "--from", "copilot", "--to", "claude",
              "--out", str(tmp_path / "back")]
    )
    assert single.exit_code == 0, single.output
    assert (tmp_path / "back" / "code-reviewer.md").exists()
