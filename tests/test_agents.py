from pathlib import Path

import pytest
import yaml
from click.testing import CliRunner

from skill_vault.agents import parse_agent, port_agent
from skill_vault.cli import cli

CLAUDE_AGENT = """---
name: repo-hunter
description: Finds where a skill's upstream source lives.
tools: Read, Glob, Grep, Bash, WebSearch, WebFetch, mcp__vault__get_skill, NotebookRead, Foo
model: sonnet
color: blue
---

You are a provenance detective.
"""

COPILOT_AGENT = """---
name: reviewer
description: Reviews pull requests.
tools: ["read", "search", "shell", "github/*", "custom-agent"]
model: Claude Opus 4.5
target: github-copilot
---
Review carefully.
"""


def _fm(content: str) -> dict:
    return yaml.safe_load(content.split("---")[1])


def test_claude_to_copilot_translates_and_warns():
    name, out, warnings = port_agent(CLAUDE_AGENT, "claude", "copilot")
    fm = _fm(out)
    assert name == "repo-hunter.agent.md"
    assert fm["name"] == "repo-hunter"
    assert fm["description"] == "Finds where a skill's upstream source lives."
    assert fm["tools"] == ["read", "search", "execute", "web", "vault/get_skill"]
    assert "model" not in fm and "color" not in fm
    assert out.rstrip().endswith("You are a provenance detective.")
    assert any("'Foo'" in w for w in warnings)
    assert any("'color'" in w for w in warnings)
    assert any("model" in w for w in warnings)


def test_copilot_to_claude_translates_and_warns():
    name, out, warnings = port_agent(COPILOT_AGENT, "copilot", "claude")
    fm = _fm(out)
    assert name == "reviewer.md"
    assert fm["tools"] == "Read, Grep, Glob, Bash, mcp__github, Task"
    assert fm["model"] == "opus"
    assert "target" not in fm
    assert warnings == ["field 'target' has no claude equivalent — dropped"]


def test_omitted_tools_and_inherit_model_stay_omitted():
    src = "---\nname: x\ndescription: d\nmodel: inherit\n---\nbody\n"
    _, out, warnings = port_agent(src, "claude", "copilot")
    assert "tools" not in _fm(out) and "model" not in _fm(out)
    assert warnings == []


def test_name_derived_from_filename():
    agent = parse_agent("---\ndescription: d\n---\nbody", "copilot", filename="planner.agent.md")
    assert agent.name == "planner"


def test_round_trip_preserves_portable_fields():
    _, copilot, _ = port_agent(CLAUDE_AGENT, "claude", "copilot")
    _, claude, _ = port_agent(copilot, "copilot", "claude")
    fm = _fm(claude)
    assert fm["tools"] == "Read, Grep, Glob, Bash, WebSearch, WebFetch, mcp__vault__get_skill"
    assert fm["name"] == "repo-hunter"


def test_unsupported_harness_rejected():
    with pytest.raises(ValueError):
        port_agent(CLAUDE_AGENT, "claude", "cursor")


def test_port_agent_cli(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("skill_vault.cli._check_repo_updates", lambda: None)
    src = tmp_path / "agents"
    src.mkdir()
    (src / "repo-hunter.md").write_text(CLAUDE_AGENT, encoding="utf-8")
    out = tmp_path / "out"

    runner = CliRunner()
    args = ["port-agent", str(src), "--from", "claude", "--to", "copilot", "--out", str(out)]
    result = runner.invoke(cli, args)
    assert result.exit_code == 0, result.output
    assert (out / "repo-hunter.agent.md").exists()

    result = runner.invoke(cli, args)
    assert result.exit_code == 0
    assert "skipped" in result.output

    result = runner.invoke(cli, ["port-agent", str(src), "--from", "claude", "--to", "claude"])
    assert result.exit_code != 0
