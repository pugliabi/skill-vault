"""
Global configuration for Skill Vault.

Config lives at ~/.skill-vault/config.json (global, per-machine).
The vault itself (skills.json, skills/) can live anywhere — the config points to it.
"""

from __future__ import annotations

import json
import platform
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ── Defaults ─────────────────────────────────────────────────

CONFIG_DIR = Path.home() / ".skill-vault"
CONFIG_FILE = CONFIG_DIR / "config.json"

# Well-known agent skill directories (where tools store their skills)
DEFAULT_AGENT_LOCATIONS: dict[str, str] = {
    "claude": str(Path.home() / ".claude" / "skills"),
    "openclaw": str(Path.home() / ".openclaw" / "skills"),
    "cursor": str(Path.home() / ".cursor" / "skills"),
    "codex": str(Path.home() / ".codex" / "skills"),
    "copilot": str(Path.home() / ".copilot" / "skills"),
    "windsurf": str(Path.home() / ".windsurf" / "skills"),
}


# ── Config I/O ───────────────────────────────────────────────


def _ensure_defaults(cfg: dict[str, Any]) -> bool:
    """Fill in defaults for newly-added config sections. Returns True if mutated."""
    mutated = False
    # The `app` block used to live here when `sv app` was part of this
    # CLI. The web dashboard now lives in the standalone `skill-vault-app`
    # package and keeps its own config at ~/.skill-vault-app/config.json.
    # Leave any existing `app` key on legacy configs alone — it's harmless
    # and removing it would silently mutate the user's file on first load.
    return mutated


def load_config() -> dict[str, Any]:
    """Load the global config. Returns empty dict if not initialized."""
    if not CONFIG_FILE.exists():
        return {}
    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    if _ensure_defaults(cfg):
        save_config(cfg)
    return cfg


def save_config(data: dict[str, Any]) -> None:
    """Save the global config."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def default_config(
    vault_path: str,
    repo_url: str = "",
    agent_dirs: dict[str, str] | None = None,
    repos_dir: str = "",
    ai_scanner_provider: str = "claude-cli",
) -> dict[str, Any]:
    """Create a default config structure."""
    cfg: dict[str, Any] = {
        "_comment": "Skill Vault global config — points to your vault and agent tool locations",
        "vault_path": vault_path,
        "repo_url": repo_url,
        "machine_id": platform.node(),
        "default_targets": list((agent_dirs or {}).keys()),
        "agent_locations": agent_dirs or {},
        "perplexity_stage": str(Path(vault_path) / ".perplexity-packages"),
    }
    if repos_dir:
        cfg["repos_dir"] = repos_dir
    cfg["ai_scanner"] = {
        "provider": ai_scanner_provider,
    }
    cfg["app"] = {
        "port": 5000,
        "host": "127.0.0.1",
        "auto_open_browser": True,
    }
    return cfg


# ── Resolved paths helper ───────────────────────────────────


@dataclass
class ResolvedPaths:
    """All resolved paths from config, ready to use."""

    vault: Path
    skills: Path = field(init=False)
    staging: Path = field(init=False)
    manifest: Path = field(init=False)
    sync_log: Path = field(init=False)
    perplexity_stage: Path = field(init=False)
    agent_locations: dict[str, Path] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.skills = self.vault / "skills"
        self.staging = self.vault / "staging"
        self.manifest = self.vault / "skills.json"
        self.sync_log = self.vault / ".sync-log.json"
        self.perplexity_stage = self.vault / ".perplexity-packages"

    def target_dir(self, target: str) -> Path:
        if target == "perplexity":
            return self.perplexity_stage
        return self.agent_locations.get(target, self.vault / ".unknown" / target)

    @classmethod
    def from_config(cls, cfg: dict[str, Any]) -> "ResolvedPaths":
        vault = Path(cfg["vault_path"]).expanduser().resolve()
        agents = {
            k: Path(v).expanduser().resolve()
            for k, v in cfg.get("agent_locations", {}).items()
        }
        obj = cls(vault=vault, agent_locations=agents)
        if "perplexity_stage" in cfg:
            obj.perplexity_stage = Path(cfg["perplexity_stage"]).expanduser().resolve()
        return obj


# ── Manifest I/O ─────────────────────────────────────────────


def load_manifest(p: Path) -> dict[str, Any]:
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


def save_manifest(data: dict[str, Any], p: Path) -> None:
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def default_manifest(machine_id: str, default_targets: list[str]) -> dict[str, Any]:
    return {
        "_comment": "Skill Vault manifest — which skills sync where",
        "version": "1.0",
        "machine_id": machine_id,
        "default_targets": default_targets,
        "skills": {},
    }


# ── Sync log I/O ─────────────────────────────────────────────


def load_sync_log(p: Path) -> dict[str, str]:
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


def save_sync_log(data: dict[str, str], p: Path) -> None:
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


# ── Config guard ─────────────────────────────────────────────


def require_config() -> tuple[dict[str, Any], ResolvedPaths]:
    """Load config and paths, or exit with a helpful message."""
    cfg = load_config()
    if not cfg or "vault_path" not in cfg:
        from rich.console import Console
        Console().print("[red]Not initialized.[/] Run [bold]sv init[/] first.")
        raise SystemExit(1)
    return cfg, ResolvedPaths.from_config(cfg)
