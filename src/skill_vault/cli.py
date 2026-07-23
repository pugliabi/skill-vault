"""
Skill Vault CLI — manage and sync agent skills across tools.

Run `sv` with no arguments to show the sync dashboard.
After every command, the CLI checks if the vault repo has upstream updates.

Commands:
  (no args)     Dashboard: stale skills, device diffs, unsynced skills
  init          Interactive setup wizard
  add           Add a skill to the vault
  remove        Remove skill(s) from the vault (interactive picker if no name)
  push          Push skills vault → agents (--select for per-target picker)
  pull          Pull skill(s) from agents → vault (interactive picker if no name)
  status        Show sync status across all targets
  list          List all vault skills
  discover      Find skills across agents; shows imported (yellow) & new
  adopt         Interactively pick discovered skills to import
  adopt-remote  Clone a git repo/plugin and import skills from it
  share         Cross-publish a skill to additional providers
  fix           Audit & repair vault (broken links, orphans, provider isolation)
  snapshot      Save device vault state for cross-device sync
  devices       List available device snapshots
  sync-from     Compare & sync skills from another device's snapshot
  watch         Watch vault for changes and auto-push
  package       Package a skill for a specific target format
  provider      Manage providers: add, remove, list (sv provider add gemini)
  app           Launch the Skill Vault web dashboard (default: 127.0.0.1:5000)
"""

from __future__ import annotations

import shutil
import sys
import time
from pathlib import Path
from typing import Any

# ── Windows stdout UTF-8 guard ─────────────────────────────
# On Windows (and sometimes under MINGW bash or when a pipx wrapper is
# spawned), `sys.stdout.encoding` defaults to `cp1252`. Rich's output
# contains box-drawing characters and ✓/⚠/↗/• glyphs, which crash the
# cp1252 encoder with UnicodeEncodeError. Force UTF-8 on both streams
# before anything tries to print. `reconfigure` was added in Python 3.7,
# and `errors="replace"` means a hypothetical unencodable byte becomes
# `?` rather than crashing — belt-and-braces for non-UTF-8 terminals.
if sys.platform == "win32":
    for _stream in (sys.stdout, sys.stderr):
        if hasattr(_stream, "reconfigure"):
            try:
                _stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:  # noqa: BLE001
                pass

import click
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from skill_vault.config import (
    CONFIG_DIR,
    CONFIG_FILE,
    DEFAULT_AGENT_LOCATIONS,
    ResolvedPaths,
    default_config,
    default_manifest,
    load_config,
    load_manifest,
    load_sync_log,
    require_config,
    save_config,
    save_manifest,
    save_sync_log,
)
from skill_vault.compat import compatible_targets, detect_tool_specifics
from skill_vault.conflicts import detect_conflict, resolve_interactive
from skill_vault.converter import CONVERTERS, convert_for_perplexity, get_converter
from skill_vault.discovery import (
    DiscoveredSkill,
    PluginInfo,
    RemoteRepoInfo,
    clone_remote_repo,
    detect_agent_dirs,
    scan_all_agents,
    scan_claude_plugins,
    scan_plugin_skills,
    scan_remote_skills,
)
from skill_vault.hashing import hash_directory
from skill_vault.linking import LinkResult, is_link, link_skill_dir, unlink_or_remove
from skill_vault.updates import (
    apply_update,
    build_origin,
    check_updates,
    local_dir_root,
    rmtree_force,
)

console = Console()

# ── Visual Design System ────────────────────────────────────
# Consistent colors and badges used across all commands.

STYLE = {
    "synced": "green",
    "stale": "yellow",
    "vault_only": "cyan",
    "staging": "blue",
    "new": "white bold",
    "missing": "red",
    "header": "bold",
    "dim": "dim",
}

BADGE = {
    "synced": "[green]\\[synced][/]",
    "stale": "[yellow]\\[stale][/]",
    "vault_only": "[cyan]\\[vault-only][/]",
    "staging": "[blue]\\[staging][/]",
    "new": "[white bold]\\[new][/]",
    "missing": "[red]\\[missing][/]",
}

ICON = {
    "ok": "[green]✓[/]",
    "warn": "[yellow]⚠[/]",
    "err": "[red]✗[/]",
    "changed": "[yellow]↻[/]",
    "link": "[cyan]↗[/]",
}


def _rule(title: str) -> None:
    """Print a styled section header."""
    console.rule(f"[bold]{title}[/]", style="dim")


def _suggest(msg: str) -> None:
    """Print a post-command suggestion hint."""
    console.print(f"\n  [dim]💡 {msg}[/]")


def _styled_table(**kwargs: Any) -> Table:
    """Create a table with the standard clean style."""
    from rich.box import SIMPLE
    defaults = {"show_header": True, "header_style": "bold", "box": SIMPLE, "show_lines": False, "pad_edge": False}
    defaults.update(kwargs)
    return Table(**defaults)


def _skill_name_styled(name: str, status: str) -> str:
    """Return a skill name styled according to its status."""
    style = STYLE.get(status, "")
    return f"[{style}]{name}[/]" if style else name


def _show_command_list() -> None:
    """Print the grouped command reference below the dashboard."""
    _rule("Commands")
    groups = [
        ("Getting Started", [
            ("init", "Setup wizard"),
            ("status", "Show sync status"),
            ("config", "View/set configuration"),
        ]),
        ("Daily Use", [
            ("push [names] [-t]", "Vault → agents"),
            ("pull [name] [--from]", "Agents → vault"),
            ("list [-v]", "List vault skills"),
            ("add <path>", "Add a skill to the vault"),
            ("remove [name]", "Remove skill(s) from vault"),
            ("quick", "Guided sync workflow"),
            ("sync", "Smart two-way sync"),
        ]),
        ("Discovery", [
            ("discover [--new-only]", "Find skills in agent dirs"),
            ("adopt [--from] [--push]", "Import discovered skills"),
            ("scan [repo-path]", "Scan local repos for skills"),
            ("adopt-remote <url>", "Import from git URL"),
        ]),
        ("Staging", [
            ("promote <name> [--push]", "Move staging → vault"),
            ("demote <name>", "Move vault → staging"),
        ]),
        ("Advanced", [
            ("share <name> --with", "Cross-publish to providers"),
            ("fix [--dry-run]", "Audit & repair vault"),
            ("snapshot", "Save device state"),
            ("sync-from <device>", "Sync from another device"),
            ("watch [-i interval]", "Auto-push on changes"),
            ("package <name> -t", "Package for target format"),
        ]),
    ]
    for group_name, cmds in groups:
        console.print(f"\n  [bold]{group_name}:[/]")
        for cmd, desc in cmds:
            console.print(f"    [cyan]{cmd:<25}[/] {desc}")
    console.print(f"\n  [dim]Run [bold]sv <command> --help[/] for full options[/]")


# ── Helpers ──────────────────────────────────────────────────


def _ensure_dir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


def _copy_skill(src: Path, dst: Path) -> None:
    ignore = shutil.ignore_patterns(
        "node_modules", "__pycache__", ".git", "*.tmp",
        "Thumbs.db", ".DS_Store", ".temp-*",
    )
    # Remove any existing destination (junction, symlink, or regular dir)
    if is_link(dst) or dst.is_symlink():
        unlink_or_remove(dst)
    # Belt-and-suspenders: if it still exists after unlink, rmtree it
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=ignore)


def _vault_skill_names(paths: ResolvedPaths) -> set[str]:
    if not paths.skills.exists():
        return set()
    return {
        d.name for d in paths.skills.iterdir()
        if d.is_dir() and not d.name.startswith(".")
    }


def _sectioned_checkbox(
    prompt: str,
    sections: dict[str, list[Any]],
    *,
    title_fn: Any = str,
    value_fn: Any = None,
    checked_fn: Any = None,
) -> list[Any]:
    """Build a questionary checkbox with Separator-based section headers.

    Supports per-section toggling:
      <s>  toggle all items in the current cursor's section
      <a>  toggle all items globally
      <i>  invert selection globally

    Args:
        prompt:     The question text shown above the checkbox.
        sections:   Ordered dict of {section_label: [items]}. Empty sections skipped.
        title_fn:   Callable(item) -> display string for the choice.
        value_fn:   Callable(item) -> value stored on selection (default: item itself).
        checked_fn: Callable(item) -> bool, whether the item is pre-checked.

    Returns:
        List of selected *values*.
    """
    import questionary
    from prompt_toolkit.key_binding import KeyBindings
    from questionary.prompts.common import InquirerControl, Separator

    if value_fn is None:
        value_fn = lambda x: x  # noqa: E731
    if checked_fn is None:
        checked_fn = lambda x: False  # noqa: E731

    choices: list[Any] = []
    # Track which section each choice index belongs to
    # (index in ic.choices -> section label)
    choice_to_section: dict[int, str] = {}
    idx = 0
    for label, items in sections.items():
        if not items:
            continue
        choices.append(questionary.Separator(f"── {label} ──"))
        idx += 1  # separator occupies an index
        for item in items:
            choices.append(questionary.Choice(
                title=title_fn(item),
                value=value_fn(item),
                checked=checked_fn(item),
            ))
            choice_to_section[idx] = label
            idx += 1

    if not choices:
        return []

    # Build the checkbox question but don't ask yet — we need to inject keybindings
    question = questionary.checkbox(
        prompt,
        choices=choices,
        instruction=(
            "(↑↓ move, Space select, s section, a all, i invert, "
            "q quit, Home/End, PgUp/PgDn, type letter to jump)"
        ),
    )

    # Get the InquirerControl from the question's Application so we can
    # add custom keybindings that reference it.
    app = question.application
    ic = _find_inquirer_control(app)
    if ic is None:
        # Fallback: just use questionary normally without custom keys
        result = question.ask()
        return result if result is not None else []

    # Build a section map: label -> list of choice values in that section
    section_values: dict[str, list[Any]] = {}
    for ci, label in choice_to_section.items():
        c = ic.choices[ci]
        if not isinstance(c, Separator) and not getattr(c, "disabled", False):
            section_values.setdefault(label, []).append(c.value)

    # Build letter-jump index: first letter -> first choice index starting with it
    _inject_enhanced_keybindings(app, ic, choice_to_section, section_values)

    result = question.ask()
    return result if result is not None else []


def _find_inquirer_control(app: Any) -> Any:
    """Recursively search the layout tree for the InquirerControl."""
    from questionary.prompts.common import InquirerControl

    def _search(container: Any) -> InquirerControl | None:
        content = getattr(container, "content", None)
        if isinstance(content, InquirerControl):
            return content
        if content is not None and content is not container:
            found = _search(content)
            if found:
                return found
        get_children = getattr(container, "get_children", None)
        if get_children:
            for child in get_children():
                found = _search(child)
                if found:
                    return found
        return None

    return _search(app.layout.container)


def _inject_enhanced_keybindings(
    app: Any,
    ic: Any,
    choice_to_section: dict[int, str],
    section_values: dict[str, list[Any]],
) -> None:
    """Inject enhanced keybindings into a questionary checkbox/select app.

    Adds: s (section toggle), q (quit), Home, End, PgUp, PgDn, letter jump.
    """
    from prompt_toolkit.key_binding import KeyBindings
    from questionary.prompts.common import Separator

    kb: KeyBindings = app.key_bindings  # type: ignore
    total = len(ic.choices)

    def _next_selectable(start: int, direction: int = 1) -> int:
        """Find the next non-separator index from start in given direction."""
        pos = start
        for _ in range(total):
            c = ic.choices[pos]
            if not isinstance(c, Separator) and not getattr(c, "disabled", False):
                return pos
            pos = (pos + direction) % total
        return start

    # ── Section toggle (s) ──
    @kb.add("s", eager=True)
    def toggle_section(_event: Any) -> None:
        pointed = ic.pointed_at
        section_label = choice_to_section.get(pointed)
        if section_label is None:
            return
        values = section_values.get(section_label, [])
        if not values:
            return
        all_selected = all(v in ic.selected_options for v in values)
        if all_selected:
            for v in values:
                if v in ic.selected_options:
                    ic.selected_options.remove(v)
        else:
            for v in values:
                if v not in ic.selected_options:
                    ic.selected_options.append(v)

    # ── Quit (q) ──
    @kb.add("q", eager=True)
    def quit_picker(event: Any) -> None:
        # Clear all selections and exit
        ic.selected_options.clear()
        event.app.exit(result=None)

    # ── Home — jump to first selectable item ──
    @kb.add("home", eager=True)
    def go_home(_event: Any) -> None:
        ic.pointed_at = _next_selectable(0, 1)

    # ── End — jump to last selectable item ──
    @kb.add("end", eager=True)
    def go_end(_event: Any) -> None:
        ic.pointed_at = _next_selectable(total - 1, -1)

    # ── Page Up — move up 10 items ──
    @kb.add("pageup", eager=True)
    def page_up(_event: Any) -> None:
        target = max(0, ic.pointed_at - 10)
        ic.pointed_at = _next_selectable(target, -1)

    # ── Page Down — move down 10 items ──
    @kb.add("pagedown", eager=True)
    def page_down(_event: Any) -> None:
        target = min(total - 1, ic.pointed_at + 10)
        ic.pointed_at = _next_selectable(target, 1)

    # ── Letter jump — type a letter to jump to first skill starting with it ──
    # Build index: letter -> list of choice indices whose title starts with that letter
    letter_index: dict[str, list[int]] = {}
    for i, c in enumerate(ic.choices):
        if isinstance(c, Separator) or getattr(c, "disabled", False):
            continue
        title = str(getattr(c, "title", "") or getattr(c, "name", ""))
        # Strip leading whitespace and Rich markup for matching
        clean = title.lstrip()
        if clean:
            first_char = clean[0].lower()
            if first_char.isalpha():
                letter_index.setdefault(first_char, []).append(i)

    def _make_letter_handler(letter: str) -> Any:
        indices = letter_index[letter]

        def handler(_event: Any) -> None:
            current = ic.pointed_at
            # Find the next index after current, wrapping around
            for idx in indices:
                if idx > current:
                    ic.pointed_at = idx
                    return
            # Wrap to first
            ic.pointed_at = indices[0]

        return handler

    for letter in letter_index:
        # Don't override existing bindings (s, a, i, q)
        if letter in ("s", "a", "i", "q"):
            continue
        kb.add(letter, eager=True)(_make_letter_handler(letter))


# ── Dashboard & Repo Checks ──────────────────────────────────


def _check_repo_updates() -> None:
    """Check if the vault git repo has upstream changes after every command."""
    import subprocess as _sp

    try:
        cfg = load_config()
        if not cfg or "vault_path" not in cfg:
            return

        vault = Path(cfg["vault_path"]).expanduser().resolve()
        if not (vault / ".git").exists():
            return

        # Fetch silently (timeout fast so it doesn't block the CLI)
        result = _sp.run(
            ["git", "fetch", "--quiet"],
            cwd=str(vault),
            capture_output=True,
            text=True,
            timeout=8,
        )
        if result.returncode != 0:
            return

        # Check if we're behind
        result = _sp.run(
            ["git", "rev-list", "--count", "HEAD..@{u}"],
            cwd=str(vault),
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            return

        behind = int(result.stdout.strip() or "0")
        if behind > 0:
            Console().print(
                f"\n[yellow]\u26a0 Vault repo is {behind} commit(s) behind upstream.[/]"
                f"  Run [bold]git pull[/] in your vault to get the latest."
            )
    except (ValueError, OSError, KeyError):
        pass
    except Exception:
        pass


def _hash_linked_or_copied(skill_dir: Path) -> str | None:
    """Hash a skill directory in a provider location (follows junctions)."""
    try:
        if not skill_dir.exists():
            return None
        return hash_directory(skill_dir)
    except OSError:
        return None


def _show_dashboard(ctx: click.Context) -> None:
    """Show a rich dashboard when `sv` is invoked with no subcommand."""
    import json as _json
    from skill_vault.linking import is_link

    cfg = load_config()
    if not cfg or "vault_path" not in cfg:
        # Not initialised -- show normal help
        click.echo(ctx.get_help())
        return

    paths = ResolvedPaths.from_config(cfg)
    manifest = load_manifest(paths.manifest)
    machine_id = cfg.get("machine_id", "unknown")
    all_targets = list(cfg.get("agent_locations", {}).keys())

    vault_skills = sorted(_vault_skill_names(paths))
    if not vault_skills:
        click.echo(ctx.get_help())
        return

    # Compute vault hashes
    vault_hashes: dict[str, str | None] = {}
    for sname in vault_skills:
        vault_hashes[sname] = hash_directory(paths.skills / sname)

    # Compute provider hashes
    provider_hashes: dict[str, dict[str, str | None]] = {}
    for tname in all_targets:
        provider_hashes[tname] = {}
        tpath = paths.agent_locations.get(tname)
        if not tpath or not tpath.exists():
            continue
        for sname in vault_skills:
            skill_in_provider = tpath / sname
            try:
                exists = skill_in_provider.exists() or is_link(skill_in_provider)
            except OSError:
                exists = False
            if exists:
                provider_hashes[tname][sname] = _hash_linked_or_copied(skill_in_provider)

    # Load device snapshots
    snap_dir = paths.vault / "snapshots"
    device_snapshots: dict[str, dict[str, Any]] = {}
    if snap_dir.exists():
        for snap_file in snap_dir.glob("*.json"):
            try:
                data = _json.loads(snap_file.read_text(encoding="utf-8"))
                device_snapshots[data.get("machine_id", snap_file.stem)] = data.get("skills", {})
            except (_json.JSONDecodeError, OSError):
                pass

    other_devices = {k: v for k, v in device_snapshots.items() if k != machine_id}

    # Categorise issues
    stale_providers: list[tuple[str, str]] = []
    missing_providers: list[tuple[str, str]] = []
    unsynced_vault: list[str] = []
    device_diffs: list[tuple[str, str]] = []

    for sname in vault_skills:
        skill_cfg = manifest.get("skills", {}).get(sname, {})
        targets = skill_cfg.get("targets", [])
        v_hash = vault_hashes.get(sname)

        if not targets:
            unsynced_vault.append(sname)

        for tname in targets:
            if tname == "perplexity":
                continue
            p_hash = provider_hashes.get(tname, {}).get(sname)
            if p_hash is None:
                tpath = paths.agent_locations.get(tname)
                if tpath and tpath.exists():
                    missing_providers.append((sname, tname))
            elif p_hash != v_hash:
                stale_providers.append((sname, tname))

        for dev_name, dev_skills in other_devices.items():
            if sname in dev_skills:
                dev_hash = dev_skills[sname].get("hash")
                if dev_hash and v_hash and dev_hash != v_hash:
                    device_diffs.append((sname, dev_name))

    # Count staging skills
    staging_count = 0
    if paths.staging.exists():
        staging_count = sum(
            1 for d in paths.staging.iterdir()
            if d.is_dir() and not d.name.startswith(".")
        )

    # Render dashboard
    console.print()
    console.print(Panel.fit(
        f"[bold]Skill Vault[/]  \u00b7  {machine_id}  \u00b7  {len(vault_skills)} skills  \u00b7  {len(all_targets)} providers",
        border_style="cyan",
    ))

    has_issues = stale_providers or missing_providers or unsynced_vault or device_diffs or staging_count

    # ── Actionable quick-actions ──
    if has_issues:
        # Each action: (label, command_name, kwargs_for_invoke)
        actions: list[tuple[str, str, dict[str, Any]]] = []
        if stale_providers or missing_providers:
            push_count = len(set(s for s, _ in stale_providers)) + len(set(s for s, _ in missing_providers))
            actions.append((f"Push {push_count} skill(s) to agents", "push", {}))
        if staging_count:
            actions.append((f"Review {staging_count} staging skill(s)", "list", {}))
        if device_diffs:
            dev_names = sorted(set(d for _, d in device_diffs))
            actions.append((
                f"Sync from {dev_names[0]} ({len(set(s for s, _ in device_diffs))} diffs)",
                "sync-from",
                {"device_name": dev_names[0]},
            ))

        if actions:
            try:
                import questionary
                action_choices = [
                    questionary.Choice(title=label, value=i) for i, (label, _, _) in enumerate(actions)
                ]
                action_choices.append(questionary.Choice(title="Skip — just show status", value="skip"))

                console.print(f"\n  {ICON['warn']} [bold]{len(actions)} action(s) available:[/]\n")
                chosen = questionary.select(
                    "Quick action:",
                    choices=action_choices,
                    instruction="(↑↓ to move, Enter to select)",
                ).ask()

                if chosen is not None and chosen != "skip":
                    _, cmd_name, cmd_kwargs = actions[chosen]
                    console.print()
                    ctx.invoke(cli.commands[cmd_name], **cmd_kwargs)
                    return
            except (ImportError, KeyboardInterrupt):
                pass  # Fall through to showing details

        # Show issue details
        if stale_providers or missing_providers:
            console.print()
            t = _styled_table(title="Provider Sync Issues", title_style="yellow bold")
            t.add_column("Skill", style="bold")
            t.add_column("Provider")
            t.add_column("Issue")
            for sname, tname in stale_providers:
                t.add_row(
                    _skill_name_styled(sname, "stale"), tname,
                    f"{BADGE['stale']} content differs from vault",
                )
            for sname, tname in missing_providers:
                t.add_row(
                    _skill_name_styled(sname, "missing"), tname,
                    f"{BADGE['missing']} not pushed yet",
                )
            console.print(t)

        if device_diffs:
            console.print()
            t = _styled_table(title="Device Differences", title_style="magenta bold")
            t.add_column("Skill", style="bold")
            t.add_column("Device")
            t.add_column("Status")
            seen: set[tuple[str, str]] = set()
            for sname, dev_name in device_diffs:
                key = (sname, dev_name)
                if key not in seen:
                    seen.add(key)
                    t.add_row(sname, dev_name, "[magenta]different version[/]")
            console.print(t)

        if staging_count:
            console.print()
            console.print(f"  [blue]{staging_count} skill(s) in staging[/] — run [bold]sv promote[/] to move to vault")

        if unsynced_vault:
            console.print()
            console.print(f"  {ICON['warn']} [yellow]{len(unsynced_vault)} skill(s) vault-only (no targets):[/]")
            for sname in unsynced_vault[:10]:
                console.print(f"    [dim]·[/] {sname}")
            if len(unsynced_vault) > 10:
                console.print(f"    [dim]  ... and {len(unsynced_vault) - 10} more[/]")
            console.print("    [dim]Use [bold]sv share <name> --with <provider>[/] to assign targets.[/]")
    else:
        console.print(f"  {ICON['ok']} All skills in sync.")

    # Summary bar
    console.print()
    parts: list[str] = []
    if stale_providers:
        parts.append(f"[yellow]{len(stale_providers)} stale[/]")
    if missing_providers:
        parts.append(f"[red]{len(missing_providers)} missing[/]")
    if staging_count:
        parts.append(f"[blue]{staging_count} staging[/]")
    if device_diffs:
        unique_diffs = len(set(s for s, _ in device_diffs))
        parts.append(f"[magenta]{unique_diffs} device diff(s)[/]")
    if unsynced_vault:
        parts.append(f"[dim]{len(unsynced_vault)} vault-only[/]")
    if not parts:
        parts.append("[green]all synced[/]")
    sep = " \u00b7 "
    console.print(f"  {sep.join(parts)}")

    # ── Grouped command list ──
    console.print()
    _show_command_list()
    console.print()



# ── CLI Group ────────────────────────────────────────────────

# Command grouping for --help output
COMMAND_GROUPS: list[tuple[str, list[str]]] = [
    ("Getting Started", ["init", "status", "config"]),
    ("Daily Use", ["push", "pull", "list", "add", "remove", "quick", "sync"]),
    ("Discovery", ["discover", "adopt", "scan", "adopt-remote"]),
    ("Staging", ["promote", "demote"]),
    ("Advanced", ["share", "fix", "snapshot", "devices", "sync-from", "watch", "package", "import"]),
]


# Short aliases: sv d → sv discover, sv p → sv push, etc.
COMMAND_ALIASES: dict[str, str] = {
    "d": "discover",
    "p": "push",
    "s": "status",
    "l": "list",
    "a": "adopt",
    "q": "quick",
    "sc": "scan",
    "sf": "sync-from",
}


class GroupedGroup(click.Group):
    """A Click group that renders help with categorised command sections."""

    def get_command(self, ctx: click.Context, cmd_name: str) -> click.Command | None:
        # Check aliases first
        resolved = COMMAND_ALIASES.get(cmd_name, cmd_name)
        return super().get_command(ctx, resolved)

    def format_commands(self, ctx: click.Context, formatter: click.HelpFormatter) -> None:
        commands = {}
        for subcommand in self.list_commands(ctx):
            cmd = self.get_command(ctx, subcommand)
            if cmd is None or cmd.hidden:
                continue
            commands[subcommand] = cmd

        if not commands:
            return

        grouped_names: set[str] = set()
        for group_name, cmd_names in COMMAND_GROUPS:
            rows: list[tuple[str, str]] = []
            for name in cmd_names:
                if name in commands:
                    help_text = commands[name].get_short_help_str(limit=50)
                    rows.append((name, help_text))
                    grouped_names.add(name)
            if rows:
                with formatter.section(group_name):
                    formatter.write_dl(rows)

        # Any commands not in a group go under "Other"
        other = [(n, commands[n].get_short_help_str(limit=50))
                 for n in sorted(commands) if n not in grouped_names]
        if other:
            with formatter.section("Other"):
                formatter.write_dl(other)


@click.group(
    cls=GroupedGroup,
    invoke_without_command=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)
@click.version_option(package_name="skill-vault")
@click.pass_context
def cli(ctx):
    """Skill Vault — sync agent skills across Claude Code, OpenClaw, Perplexity, Cursor & more."""
    if ctx.invoked_subcommand is None:
        _show_dashboard(ctx)


@cli.result_callback()
@click.pass_context
def _after_command(ctx, *args, **kwargs):
    """After every command, check if the vault repo has upstream changes."""
    _check_repo_updates()


# ── HELP ────────────────────────────────────────────────────


@cli.command(name="help", hidden=True)
@click.argument("command_name", required=False, default=None)
@click.pass_context
def help_cmd(ctx, command_name: str | None):
    """Show help for sv or a specific command."""
    if command_name:
        cmd = cli.commands.get(command_name)
        if cmd is None:
            console.print(f"[red]Unknown command: {command_name}[/]")
            console.print(f"[dim]Run [bold]sv help[/] to see all commands.[/]")
            raise SystemExit(1)
        # Show help for the specific command
        sub_ctx = click.Context(cmd, info_name=f"sv {command_name}", parent=ctx.parent)
        click.echo(cmd.get_help(sub_ctx))
    else:
        # Show the main help
        parent = ctx.parent or ctx
        click.echo(cli.get_help(parent))


# ── CONFIG ───────────────────────────────────────────────────


@cli.group(name="config", invoke_without_command=True)
@click.pass_context
def config_cmd(ctx):
    """View and manage Skill Vault configuration."""
    if ctx.invoked_subcommand is None:
        # Default: show all config values
        ctx.invoke(config_show)


@config_cmd.command(name="show")
def config_show():
    """Show current configuration."""
    _rule("Configuration")

    console.print(f"  [bold]Config file:[/] {CONFIG_FILE}")
    console.print(f"  [bold]Exists:[/] {'yes' if CONFIG_FILE.exists() else '[red]no[/]'}")
    console.print()

    cfg = load_config()
    if not cfg:
        console.print("  [yellow]No configuration found. Run [bold]sv init[/] to set up.[/]")
        return

    table = _styled_table()
    table.add_column("Key", no_wrap=True, style="cyan")
    table.add_column("Value")

    for key, value in sorted(cfg.items()):
        if key.startswith("_"):
            continue
        if isinstance(value, dict):
            import json as _json
            val_str = _json.dumps(value, indent=2)
            table.add_row(key, f"[dim]{val_str}[/]")
        elif isinstance(value, list):
            table.add_row(key, ", ".join(str(v) for v in value))
        else:
            table.add_row(key, str(value))

    # Show optional keys that aren't set yet
    optional_keys = {
        "repos_dir": "Path to directory of skill/plugin/tool repos (used by sv scan)",
        "ai_scanner": "AI scanner config: {\"provider\": \"claude-cli|anthropic-sdk|none\"}",
    }
    unset = {k: desc for k, desc in optional_keys.items() if k not in cfg}
    if unset:
        table.add_row("", "")  # spacer
        for key, desc in unset.items():
            table.add_row(f"[dim]{key}[/]", f"[dim](not set) {desc}[/]")

    console.print(table)

    if unset:
        console.print(f"\n  [dim]Set optional keys with [bold]sv config set <key> <value>[/][/]")


@config_cmd.command(name="get")
@click.argument("key")
def config_get(key: str):
    """Get a specific config value."""
    cfg = load_config()
    if not cfg:
        console.print("[yellow]No configuration found. Run [bold]sv init[/] first.[/]")
        raise SystemExit(1)

    # Support dotted keys like ai_scanner.provider
    parts = key.split(".")
    value: Any = cfg
    for part in parts:
        if isinstance(value, dict) and part in value:
            value = value[part]
        else:
            console.print(f"[red]Key not found: {key}[/]")
            raise SystemExit(1)

    if isinstance(value, dict):
        import json as _json
        console.print(_json.dumps(value, indent=2))
    else:
        console.print(str(value))


@config_cmd.command(name="set")
@click.argument("key")
@click.argument("value")
def config_set(key: str, value: str):
    """Set a config value (supports dotted keys like ai_scanner.provider).

    Click always hands us `value` as a string, but the JSON config file
    carries real types (bool, int, string). We coerce to preserve them:

    - If the key already exists, match its existing type. Fails loudly if
      the new value can't be coerced (e.g. `sv config set app.port banana`).
    - If the key is new, infer from the literal: `true`/`false` → bool,
      pure digits → int, otherwise leave as string.

    This fixes `sv config set app.auto_open_browser false` previously
    storing the string "false" — which is truthy under `bool(...)` and so
    silently failed to disable the browser auto-open.
    """
    cfg = load_config()
    if not cfg:
        console.print("[yellow]No configuration found. Run [bold]sv init[/] first.[/]")
        raise SystemExit(1)

    # Support dotted keys
    parts = key.split(".")
    target = cfg
    for part in parts[:-1]:
        if part not in target or not isinstance(target[part], dict):
            target[part] = {}
        target = target[part]

    if not isinstance(target, dict):
        console.print(f"[red]Cannot set '{key}': parent is not a dict.[/]")
        raise SystemExit(1)

    existing = target.get(parts[-1])
    old_value = existing if parts[-1] in target else "(unset)"

    # ── Type coercion ──
    # NB: bool must be checked before int — `isinstance(True, int)` is True
    # in Python, and we want booleans to take the bool branch.
    coerced: Any = value
    low = value.strip().lower()
    if isinstance(existing, bool):
        if low in ("true", "yes", "on", "1"):
            coerced = True
        elif low in ("false", "no", "off", "0"):
            coerced = False
        else:
            console.print(
                f"[red]Expected boolean for {key}, got {value!r}. "
                f"Use true/false.[/]"
            )
            raise SystemExit(1)
    elif isinstance(existing, int):
        try:
            coerced = int(value)
        except ValueError:
            console.print(f"[red]Expected integer for {key}, got {value!r}.[/]")
            raise SystemExit(1)
    elif isinstance(existing, float):
        try:
            coerced = float(value)
        except ValueError:
            console.print(f"[red]Expected number for {key}, got {value!r}.[/]")
            raise SystemExit(1)
    elif existing is None:
        # Brand-new key — infer from the literal so users can set bool/int
        # values without a --type flag.
        if low == "true":
            coerced = True
        elif low == "false":
            coerced = False
        elif value.lstrip("-").isdigit():
            coerced = int(value)
        # else: keep as string

    # Mask display of sensitive values (API keys). Only applies to strings;
    # bools and ints are shown as-is.
    display_value: str
    if isinstance(coerced, str) and "key" in key.lower() and "env" not in key.lower() and len(value) > 10:
        display_value = value[:8] + "..." + value[-4:]
    else:
        display_value = str(coerced)

    target[parts[-1]] = coerced
    save_config(cfg)
    console.print(f"  {ICON['ok']} [cyan]{key}[/]: {old_value} → [bold]{display_value}[/]")


@config_cmd.command(name="path")
def config_path():
    """Show the config file path."""
    console.print(str(CONFIG_FILE))


@config_cmd.command(name="list")
def config_list():
    """List all config keys and values (alias for show)."""
    config_show.invoke(click.get_current_context())


# ── INIT (interactive wizard) ────────────────────────────────


@cli.command()
def init():
    """Interactive setup wizard — configure your vault and agent locations."""
    import questionary

    console.print(Panel.fit(
        "[bold cyan]Skill Vault Setup Wizard[/]\n"
        "This will configure where your skill vault lives and which\n"
        "agent tool directories to sync with.",
        border_style="cyan",
    ))

    existing = load_config()
    if existing:
        console.print(f"\n[yellow]Existing config found at[/] {CONFIG_FILE}")
        if not questionary.confirm("Overwrite existing configuration?", default=False).ask():
            console.print("[dim]Cancelled.[/]")
            return

    # ── Step 1: Vault location ──
    console.print("\n[bold]Step 1:[/] Where is your skill vault (the git repo)?")
    console.print("[dim]This is the folder containing your skills/ directory and skills.json manifest.[/]")

    default_vault = str(Path.home() / "repos" / "agent-skills")
    vault_path = questionary.path(
        "Vault path:",
        default=existing.get("vault_path", default_vault),
        only_directories=True,
    ).ask()

    if not vault_path:
        console.print("[red]Cancelled.[/]")
        return

    vault_path = str(Path(vault_path).expanduser().resolve())

    # ── Step 2: Git remote ──
    console.print("\n[bold]Step 2:[/] Git remote URL (optional)")
    default_url = existing.get("repo_url", "")
    repo_url = questionary.text(
        "Remote URL (leave blank to skip):",
        default=default_url,
    ).ask() or ""

    # ── Step 3: Detect agent dirs ──
    console.print("\n[bold]Step 3:[/] Detecting agent tool directories...")

    detected = detect_agent_dirs()
    if detected:
        table = Table(show_header=True, header_style="bold")
        table.add_column("Agent", style="cyan")
        table.add_column("Path")
        table.add_column("Status")
        for name, path in detected.items():
            exists = "✓ exists" if path.exists() else "parent found"
            table.add_row(name, str(path), exists)
        console.print(table)
    else:
        console.print("[yellow]No known agent directories detected.[/]")

    # Let user select which to include
    all_agents = list(DEFAULT_AGENT_LOCATIONS.keys())
    defaults = list(detected.keys()) if detected else []

    selected = questionary.checkbox(
        "Which agents do you want to sync with?",
        choices=[
            questionary.Choice(name, checked=name in defaults)
            for name in all_agents
        ],
    ).ask()

    if selected is None:
        console.print("[red]Cancelled.[/]")
        return

    # ── Step 4: Custom agent dirs ──
    if questionary.confirm("Add custom agent directories?", default=False).ask():
        while True:
            alias = questionary.text("Agent alias (e.g., 'my-agent', blank to stop):").ask()
            if not alias:
                break
            custom_path = questionary.path(
                f"  Path for '{alias}':",
                only_directories=True,
            ).ask()
            if custom_path:
                selected.append(alias)
                DEFAULT_AGENT_LOCATIONS[alias] = custom_path

    # Build agent_dirs from selection
    agent_dirs: dict[str, str] = {}
    for name in selected:
        if name in DEFAULT_AGENT_LOCATIONS:
            agent_dirs[name] = DEFAULT_AGENT_LOCATIONS[name]
        elif name in detected:
            agent_dirs[name] = str(detected[name])

    # ── Step 5: Repos directory (optional) ──
    console.print("\n[bold]Step 5:[/] Skill repos directory (optional)")
    console.print("[dim]A directory containing git repos with skills. Used by [bold]sv scan[/].[/]")
    repos_dir = questionary.path(
        "Repos directory (leave blank to skip):",
        default=existing.get("repos_dir", ""),
        only_directories=True,
    ).ask() or ""

    # ── Step 6: AI scanner config ──
    console.print("\n[bold]Step 6:[/] AI scanner for repo analysis")
    ai_provider = questionary.select(
        "AI provider for scanning repos:",
        choices=[
            questionary.Choice("Claude CLI (uses claude -p)", value="claude-cli"),
            questionary.Choice("Anthropic SDK (direct API)", value="anthropic-sdk"),
            questionary.Choice("None (heuristics only)", value="none"),
        ],
        default="claude-cli",
    ).ask() or "claude-cli"

    # ── Step 7: Save config ──
    cfg = default_config(
        vault_path=vault_path,
        repo_url=repo_url,
        agent_dirs=agent_dirs,
        repos_dir=repos_dir,
        ai_scanner_provider=ai_provider,
    )

    console.print("\n[bold]Configuration preview:[/]")
    for k, v in cfg.items():
        if k.startswith("_"):
            continue
        console.print(f"  [cyan]{k}[/]: {v}")

    if questionary.confirm("\nSave this configuration?", default=True).ask():
        save_config(cfg)
        console.print(f"\n[green]✓[/] Config saved to {CONFIG_FILE}")

        # Initialize vault dirs + manifest if they don't exist
        vault = Path(vault_path)
        skills_dir = vault / "skills"
        _ensure_dir(skills_dir)

        manifest_path = vault / "skills.json"
        if not manifest_path.exists():
            import platform
            save_manifest(
                default_manifest(platform.node(), list(agent_dirs.keys())),
                manifest_path,
            )
            console.print(f"[green]✓[/] Created manifest at {manifest_path}")

        console.print("\n[bold green]Setup complete![/] Run [bold]sv status[/] to see your sync state.")
    else:
        console.print("[dim]Cancelled.[/]")


# ── ADD ──────────────────────────────────────────────────────


@cli.command()
@click.argument("skill_path", type=click.Path(exists=True))
@click.option("--name", "-n", help="Override the skill name (defaults to directory name)")
@click.option("--targets", "-t", multiple=True, help="Targets to sync to (e.g., claude, openclaw)")
def add(skill_path: str, name: str | None, targets: tuple[str, ...]):
    """Add a skill to the vault from a local path."""
    cfg, paths = require_config()
    src = Path(skill_path).expanduser().resolve()

    if not src.is_dir():
        console.print("[red]Skill path must be a directory.[/]")
        raise SystemExit(1)

    skill_md = src / "SKILL.md"
    if not skill_md.exists() and not (src / "skill.md").exists():
        console.print("[yellow]Warning:[/] No SKILL.md found in directory.")

    skill_name = name or src.name
    dest = paths.skills / skill_name

    _ensure_dir(paths.skills)
    _copy_skill(src, dest)

    # Update manifest
    # Provider isolation: if explicit --targets given use those,
    # otherwise try to infer the source provider from the path,
    # falling back to no targets (vault-only until shared).
    manifest = load_manifest(paths.manifest)
    if targets:
        target_list = list(targets)
    else:
        # Infer source provider from path if it's inside a known agent dir
        all_agents = cfg.get("agent_locations", {})
        inferred: list[str] = []
        for agent_name, agent_path_str in all_agents.items():
            agent_path = Path(agent_path_str).expanduser().resolve()
            try:
                src.relative_to(agent_path)
                inferred.append(agent_name)
                break
            except ValueError:
                pass
        target_list = inferred  # empty list = vault-only

    manifest.setdefault("skills", {})[skill_name] = {
        "targets": target_list,
        "source": str(src),
    }
    save_manifest(manifest, paths.manifest)

    # Update hash log
    sync_log = load_sync_log(paths.sync_log)
    h = hash_directory(dest)
    if h:
        sync_log[skill_name] = h
    save_sync_log(sync_log, paths.sync_log)

    console.print(f"[green]✓[/] Added [bold]{skill_name}[/] to vault")
    if target_list:
        console.print(f"  Targets: {', '.join(target_list)}")
    else:
        console.print(f"  [dim]Vault-only (use [bold]sv share {skill_name} --with <provider>[/] to push to providers)[/]")


# ── REMOVE ───────────────────────────────────────────────────


@cli.command()
@click.argument("skill_name", required=False, default=None)
@click.option("--keep-targets", is_flag=True, help="Keep copies in agent directories")
def remove(skill_name: str | None, keep_targets: bool):
    """Remove skill(s) from the vault. If no name given, shows interactive picker."""
    import questionary

    cfg, paths = require_config()

    # Interactive mode: no skill_name → pick from vault, sectioned by provider
    if skill_name is None:
        vault_names = sorted(_vault_skill_names(paths))
        if not vault_names:
            console.print("[yellow]Vault is empty — nothing to remove.[/]")
            return

        # Group skills by their targets (providers) from the manifest
        manifest = load_manifest(paths.manifest)
        sections: dict[str, list[str]] = {}
        uncategorised: list[str] = []
        for sname in vault_names:
            targets = manifest.get("skills", {}).get(sname, {}).get("targets", [])
            if targets:
                for t in targets:
                    sections.setdefault(t, []).append(sname)
            else:
                uncategorised.append(sname)

        # Deduplicate — a skill may appear under multiple providers,
        # but we want each skill to appear only once.  Put it under
        # the first provider alphabetically for a clean UX.
        seen: set[str] = set()
        deduped: dict[str, list[str]] = {}
        for label in sorted(sections):
            for sname in sections[label]:
                if sname not in seen:
                    deduped.setdefault(label, []).append(sname)
                    seen.add(sname)
        if uncategorised:
            for sname in uncategorised:
                if sname not in seen:
                    deduped.setdefault("uncategorised", []).append(sname)
                    seen.add(sname)

        selected: list[str] = _sectioned_checkbox(
            "Select skill(s) to remove from the vault:",
            deduped,
            title_fn=lambda s: s,
        )

        if not selected:
            console.print("[dim]Nothing selected.[/]")
            return

        # Confirm
        console.print(f"\n[bold red]Will remove {len(selected)} skill(s):[/]")
        for s in selected:
            console.print(f"  • {s}")
        if not questionary.confirm("Proceed?", default=False).ask():
            console.print("[dim]Cancelled.[/]")
            return

        for s in selected:
            _remove_one_skill(s, paths, keep_targets)
    else:
        skill_dir = paths.skills / skill_name
        if not skill_dir.exists():
            console.print(f"[red]Skill '{skill_name}' not found in vault.[/]")
            raise SystemExit(1)
        _remove_one_skill(skill_name, paths, keep_targets)


def _remove_one_skill(skill_name: str, paths: ResolvedPaths, keep_targets: bool) -> None:
    """Remove a single skill from vault, manifest, sync log, and optionally targets."""
    skill_dir = paths.skills / skill_name
    if skill_dir.exists():
        shutil.rmtree(skill_dir)

    manifest = load_manifest(paths.manifest)
    manifest.get("skills", {}).pop(skill_name, None)
    save_manifest(manifest, paths.manifest)

    sync_log = load_sync_log(paths.sync_log)
    sync_log.pop(skill_name, None)
    save_sync_log(sync_log, paths.sync_log)

    console.print(f"[green]✓[/] Removed [bold]{skill_name}[/] from vault")

    if not keep_targets:
        for target_name, target_path in paths.agent_locations.items():
            tp = target_path / skill_name
            if tp.exists() or tp.is_symlink():
                unlink_or_remove(tp)
                console.print(f"  Removed from {target_name}")


# ── PUSH ─────────────────────────────────────────────────────


@cli.command()
@click.argument("skill_names", nargs=-1)
@click.option("--target", "-t", multiple=True, help="Only push to these targets")
@click.option("--force", "-f", is_flag=True, help="Push even if hashes match")
@click.option("--copy", "force_copy", is_flag=True, help="Copy files instead of creating symlinks")
@click.option("--dry-run", is_flag=True, help="Show what would be pushed")
@click.option("--select", "interactive", is_flag=True, help="Interactively pick skills per target")
def push(
    skill_names: tuple[str, ...],
    target: tuple[str, ...],
    force: bool,
    force_copy: bool,
    dry_run: bool,
    interactive: bool,
):
    """Push skills from vault to agent tool directories (symlinks by default).

    With no args and no --select, pushes all skills to their configured targets.
    With --select (or just `sv push --select`), opens an interactive picker
    for each target so you can choose exactly which skills to push where.
    """
    import questionary

    _rule("Push")
    cfg, paths = require_config()
    manifest = load_manifest(paths.manifest)
    sync_log = load_sync_log(paths.sync_log)

    # Check config-level preference for copy mode
    use_copy = force_copy or cfg.get("push_mode") == "copy"

    all_vault = sorted(_vault_skill_names(paths))
    if not all_vault and not manifest.get("skills"):
        console.print("[yellow]No skills in vault. Use [bold]sv add[/] or [bold]sv adopt[/] first.[/]")
        return

    # ── Interactive per-target selection ──
    if interactive:
        targets_to_use = list(target) if target else list(cfg.get("agent_locations", {}).keys())
        if not targets_to_use:
            console.print("[yellow]No targets configured. Run [bold]sv init[/] first.[/]")
            return

        # Build a {target: [skills]} map via interactive picker
        push_plan: dict[str, list[str]] = {}
        for tname in targets_to_use:
            # Default-check skills that are already assigned to this target
            choices = []
            for sname in all_vault:
                skill_targets = manifest.get("skills", {}).get(sname, {}).get("targets", [])
                choices.append(questionary.Choice(
                    title=sname,
                    value=sname,
                    checked=tname in skill_targets,
                ))

            selected: list[str] = questionary.checkbox(
                f"Select skills to push → {tname}:",
                choices=choices,
            ).ask()

            if selected is None:
                console.print("[dim]Cancelled.[/]")
                return
            if selected:
                push_plan[tname] = selected

        if not push_plan:
            console.print("[dim]Nothing selected to push.[/]")
            return

        # Show summary
        console.print("\n[bold]Push plan:[/]")
        for tname, snames in push_plan.items():
            console.print(f"  [cyan]{tname}[/]: {', '.join(snames)}")

        if not dry_run:
            if not questionary.confirm("Proceed?", default=True).ask():
                console.print("[dim]Cancelled.[/]")
                return

        # Execute the plan
        push_count = 0
        for tname, snames in push_plan.items():
            for sname in snames:
                src = paths.skills / sname
                if not src.exists():
                    console.print(f"  [yellow]⚠ {sname}[/] — not found in vault, skipping")
                    continue
                pushed = _push_one(src, sname, tname, paths, cfg, manifest, sync_log, use_copy, force, dry_run)
                if pushed:
                    push_count += 1

        if not dry_run:
            save_sync_log(sync_log, paths.sync_log)
            if push_count:
                _take_snapshot(cfg, paths, quiet=True)
        console.print(f"\n[bold]Done:[/] {push_count} pushed")
        return

    # ── Standard (non-interactive) push ──
    skills_to_push = list(skill_names) if skill_names else list(manifest.get("skills", {}).keys())
    if not skills_to_push:
        console.print("[yellow]No skills in vault. Use [bold]sv add[/] or [bold]sv adopt[/] first.[/]")
        return

    push_count = 0
    skip_count = 0

    for sname in skills_to_push:
        src = paths.skills / sname
        if not src.exists():
            console.print(f"  [yellow]⚠ {sname}[/] — not found in vault, skipping")
            continue

        skill_cfg = manifest.get("skills", {}).get(sname, {})
        targets_for_skill = list(target) if target else skill_cfg.get("targets", [])

        current_hash = hash_directory(src)
        old_hash = sync_log.get(sname)

        for tname in targets_for_skill:
            if not force and current_hash and current_hash == old_hash:
                skip_count += 1
                continue
            pushed = _push_one(src, sname, tname, paths, cfg, manifest, sync_log, use_copy, force, dry_run)
            if pushed:
                push_count += 1

        # Update hash after push
        if not dry_run and current_hash:
            sync_log[sname] = current_hash

    if not dry_run:
        save_sync_log(sync_log, paths.sync_log)
        if push_count:
            _take_snapshot(cfg, paths, quiet=True)

    mode_label = "copied" if use_copy else "linked"
    console.print(f"\n  {ICON['ok']} [bold]Done:[/] {push_count} {mode_label}, {skip_count} unchanged")
    if push_count:
        _suggest("Run [bold]sv status[/] to verify sync state")


def _push_one(
    src: Path,
    sname: str,
    tname: str,
    paths: ResolvedPaths,
    cfg: dict[str, Any],
    manifest: dict[str, Any],
    sync_log: dict[str, Any],
    use_copy: bool,
    force: bool,
    dry_run: bool,
) -> bool:
    """Push a single skill to a single target. Returns True if pushed."""
    specifics = detect_tool_specifics(src)

    # Warn if skill has features specific to a *different* tool
    if specifics and tname not in specifics:
        coupled = [s for s in specifics if s != tname]
        if coupled and not dry_run:
            console.print(
                f"  [yellow]⚠ {sname}[/] has features specific to "
                f"{', '.join(coupled)} — converting for {tname}"
            )

    if tname == "perplexity":
        # Perplexity always gets a packaged copy (not a symlink)
        if dry_run:
            console.print(f"  [dim]Would package {sname} → perplexity[/]")
        else:
            out = convert_for_perplexity(src, sname, paths.perplexity_stage)
            console.print(f"  [green]✓[/] {sname} → perplexity ({out.name})")
        return True

    needs_conversion = tname == "openclaw" or (
        specifics and tname not in specifics and bool(specifics)
    )

    dest = paths.target_dir(tname) / sname

    if dry_run:
        mode = "copy" if (use_copy or needs_conversion) else "link"
        console.print(f"  [dim]Would {mode} {sname} → {tname} ({dest})[/]")
        return True

    _ensure_dir(dest.parent)
    if needs_conversion:
        converter = CONVERTERS.get(tname)
        if converter:
            converter(src, dest)
        else:
            _copy_skill(src, dest)
        console.print(f"  [green]✓[/] {sname} → {tname} [dim](copy)[/]")
    elif use_copy:
        converter = CONVERTERS.get(tname)
        if converter:
            converter(src, dest)
        else:
            _copy_skill(src, dest)
        console.print(f"  [green]✓[/] {sname} → {tname} [dim](copy)[/]")
    else:
        result = link_skill_dir(src, dest)
        if result.method == "skip":
            console.print(
                f"  [yellow]⚠ Skipped {sname} → {tname}:[/] source and target overlap (would create circular link)"
            )
            return False
        method_tag = f" [{result.method}]" if result.method != "symlink" else ""
        console.print(f"  [green]✓[/] {sname} → {tname}{method_tag}")
    return True


# ── PULL ─────────────────────────────────────────────────────


@cli.command()
@click.argument("skill_name", required=False, default=None)
@click.option("--from", "from_target", default=None, help="Agent to pull from (e.g., claude)")
@click.option("--overwrite", is_flag=True, help="Overwrite existing vault copy without conflict resolution")
@click.option("--strategy", type=click.Choice(["ask", "keep-vault", "keep-incoming", "keep-both", "backup", "claude-code"]), default="ask", help="Conflict resolution strategy")
@click.option("--push", "do_push", is_flag=True, help="Also push pulled skills to all other agents")
@click.option("--select", "interactive", is_flag=True, help="Interactively pick skills to pull")
@click.pass_context
def pull(ctx, skill_name: str | None, from_target: str | None, overwrite: bool, strategy: str, do_push: bool, interactive: bool):
    """Pull skill(s) from agent directories into the vault.

    With no args, pulls all configured skills that have changed in their
    source agent directory. Use --select for an interactive picker.
    """
    import questionary

    _rule("Pull")
    cfg, paths = require_config()

    agent_locs = {
        k: Path(v).expanduser().resolve()
        for k, v in cfg.get("agent_locations", {}).items()
    }

    if from_target:
        if from_target not in agent_locs:
            console.print(f"[red]Unknown agent: {from_target}[/]")
            raise SystemExit(1)
        agent_locs = {from_target: agent_locs[from_target]}

    if not agent_locs:
        console.print("[yellow]No agent locations configured. Run [bold]sv init[/] first.[/]")
        return

    # ── Interactive mode: --select → scan agents, pick from list ──
    if interactive and skill_name is None:
        vault_skills = _vault_skill_names(paths)
        results = scan_all_agents(agent_locs, vault_skills)
        if not results:
            console.print("[yellow]No skills found in any agent directory.[/]")
            return

        selected: list[DiscoveredSkill] = _sectioned_checkbox(
            "Select skill(s) to pull into the vault:",
            results,
            title_fn=lambda s: (
                f"{s.name} ({s.file_count} files)"
                f"{' — ' + s.description if s.description else ''}"
                f"{' [already in vault]' if s.in_vault else ''}"
            ),
            checked_fn=lambda s: not s.in_vault,
        )

        if not selected:
            console.print("[dim]Nothing selected.[/]")
            return

        pulled_names: list[str] = []
        for s in selected:
            _pull_one_skill(
                s.name, s.source_tool, s.path, cfg, paths,
                overwrite=overwrite, strategy=strategy,
            )
            pulled_names.append(s.name)

        if do_push and pulled_names:
            console.print()
            ctx.invoke(push, skill_names=tuple(pulled_names))
        elif pulled_names:
            _suggest("Run [bold]sv push[/] to sync everywhere, or [bold]sv pull --push[/] next time")
        return

    # ── Default mode: no args, no --select → pull all configured skills that changed ──
    if skill_name is None:
        manifest = load_manifest(paths.manifest)
        sync_log = load_sync_log(paths.sync_log)
        skills_config = manifest.get("skills", {})

        pull_count = 0
        skip_count = 0
        pulled_names = []

        for sname, sinfo in sorted(skills_config.items()):
            if sinfo.get("stage") == "staging":
                continue
            targets = sinfo.get("targets", [])
            if not targets:
                continue

            # Find the source agent for this skill
            source_agents = [t for t in targets if t in agent_locs]
            if from_target:
                source_agents = [from_target] if from_target in source_agents else []

            for tname in source_agents:
                agent_path = agent_locs[tname]
                src = agent_path / sname
                if not src.exists():
                    continue

                # Check if agent copy differs from vault
                vault_dir = paths.skills / sname
                if vault_dir.exists():
                    vault_hash = hash_directory(vault_dir)
                    agent_hash = hash_directory(src)
                    if vault_hash == agent_hash:
                        skip_count += 1
                        continue

                _pull_one_skill(
                    sname, tname, src, cfg, paths,
                    overwrite=overwrite, strategy=strategy,
                )
                pulled_names.append(sname)
                pull_count += 1
                break  # Only pull from first matching agent

        console.print(f"\n  {ICON['ok']} [bold]Done:[/] {pull_count} pulled, {skip_count} unchanged")
        if do_push and pulled_names:
            console.print()
            ctx.invoke(push, skill_names=tuple(pulled_names))
        elif pull_count:
            _suggest("Run [bold]sv push[/] to sync everywhere, or [bold]sv pull --push[/] next time")
        return

    # ── Direct mode: skill_name + --from required ──
    if not from_target:
        console.print("[red]--from is required when specifying a skill name.[/]")
        console.print("[dim]Or run [bold]sv pull[/] with no args for interactive mode.[/]")
        raise SystemExit(1)

    agent_path = paths.agent_locations.get(from_target)
    if not agent_path:
        console.print(f"[red]Unknown agent: {from_target}[/]")
        raise SystemExit(1)

    src = agent_path / skill_name
    if not src.exists():
        console.print(f"[red]Skill '{skill_name}' not found in {from_target} at {src}[/]")
        raise SystemExit(1)

    _pull_one_skill(skill_name, from_target, src, cfg, paths, overwrite=overwrite, strategy=strategy)

    if do_push:
        console.print()
        ctx.invoke(push, skill_names=(skill_name,))
    else:
        _suggest("Run [bold]sv push[/] to sync everywhere, or [bold]sv pull --push[/] next time")


def _pull_one_skill(
    skill_name: str,
    from_target: str,
    src: Path,
    cfg: dict[str, Any],
    paths: ResolvedPaths,
    *,
    overwrite: bool = False,
    strategy: str = "ask",
) -> None:
    """Pull a single skill from an agent directory into the vault."""
    dest = paths.skills / skill_name

    # Conflict detection
    if dest.exists() and not overwrite:
        conflict = detect_conflict(skill_name, paths.skills, src, from_target)
        if conflict and conflict.is_conflict:
            # Structure differs (files added/removed) — real conflict
            if strategy == "ask":
                msg = resolve_interactive(conflict, paths.skills, machine_id=cfg.get("machine_id"))
            elif strategy == "keep-vault":
                from skill_vault.conflicts import resolve_keep_vault
                msg = resolve_keep_vault(conflict)
            elif strategy == "keep-incoming":
                from skill_vault.conflicts import resolve_keep_incoming
                msg = resolve_keep_incoming(conflict)
            elif strategy == "keep-both":
                from skill_vault.conflicts import resolve_keep_both
                msg = resolve_keep_both(conflict, paths.skills)
            elif strategy == "backup":
                from skill_vault.conflicts import resolve_backup
                msg = resolve_backup(conflict, paths.skills, machine_id=cfg.get("machine_id"))
            elif strategy == "claude-code":
                from skill_vault.conflicts import resolve_claude_code
                msg = resolve_claude_code(conflict, paths.skills, machine_id=cfg.get("machine_id"))
            else:
                msg = "Skipped"
            console.print(f"  {msg}")
            return
        elif conflict and conflict.has_changes:
            # Content changed but same file structure — just update silently
            console.print(f"[dim]Updating '{skill_name}' (content changed, same structure)[/]")
            # Fall through to the copy below
        elif conflict:
            console.print(f"[green]'{skill_name}' already in vault with identical content.[/]")
            return

    _ensure_dir(paths.skills)
    _copy_skill(src, dest)

    # Update manifest — provider isolation: if new, default to source only
    manifest = load_manifest(paths.manifest)
    existing = manifest.get("skills", {}).get(skill_name, {})
    if existing:
        # Skill already tracked: preserve existing targets, ensure source is included
        targets = existing.get("targets", [from_target])
        if from_target not in targets:
            targets.append(from_target)
    else:
        # Brand-new pull: provider isolation — only target the source provider
        targets = [from_target]
    manifest.setdefault("skills", {})[skill_name] = {
        "targets": targets,
        "source": f"pulled from {from_target}",
    }
    save_manifest(manifest, paths.manifest)

    console.print(f"[green]✓[/] Pulled [bold]{skill_name}[/] from {from_target} into vault")


# ── STATUS ───────────────────────────────────────────────────


@cli.command()
def status():
    """Show sync status of all vault skills across targets."""
    cfg, paths = require_config()
    manifest = load_manifest(paths.manifest)
    sync_log = load_sync_log(paths.sync_log)
    skills = manifest.get("skills", {})

    if not skills:
        console.print("[yellow]No skills in vault.[/] Use [bold]sv add[/] or [bold]sv adopt[/] to get started.")
        return

    _rule("Sync Status")

    table = _styled_table()
    table.add_column("Skill", no_wrap=True)
    table.add_column("Status", width=14)
    table.add_column("Targets")
    table.add_column("Link", max_width=30)

    stale_count = 0
    missing_count = 0
    synced_count = 0

    for sname, sinfo in sorted(skills.items()):
        stage = sinfo.get("stage", "production")
        if stage == "staging":
            continue  # staging skills don't appear in sync status

        src = paths.skills / sname
        current_hash = hash_directory(src) if src.exists() else None
        old_hash = sync_log.get(sname)

        if current_hash is None:
            status_badge = BADGE["missing"]
            name_col = _skill_name_styled(sname, "missing")
            missing_count += 1
        elif current_hash == old_hash:
            status_badge = BADGE["synced"]
            name_col = _skill_name_styled(sname, "synced")
            synced_count += 1
        else:
            status_badge = BADGE["stale"]
            name_col = _skill_name_styled(sname, "stale")
            stale_count += 1

        # Check link status in each target
        target_list = sinfo.get("targets", [])
        link_statuses = []
        for tname in target_list:
            tp = paths.target_dir(tname) / sname
            if tp.is_symlink() or is_link(tp):
                link_statuses.append(f"{ICON['link']} {tname}")
            elif tp.exists():
                link_statuses.append(f"[dim]cp {tname}[/]")
            else:
                link_statuses.append(f"[dim]— {tname}[/]")

        targets = ", ".join(target_list) if target_list else "[dim](no targets)[/]"
        link_display = ", ".join(link_statuses) if link_statuses else "[dim]—[/]"
        table.add_row(name_col, status_badge, targets, link_display)

    console.print(table)

    parts = []
    if synced_count:
        parts.append(f"[green]{synced_count} synced[/]")
    if stale_count:
        parts.append(f"[yellow]{stale_count} stale[/]")
    if missing_count:
        parts.append(f"[red]{missing_count} missing[/]")
    console.print(f"\n  {' · '.join(parts)}" if parts else "")

    console.print(f"\n  [dim]Config:[/] {CONFIG_FILE}")
    console.print(f"  [dim]Vault:[/]  {paths.vault}")
    if stale_count:
        _suggest("Run [bold]sv push[/] to sync stale skills to agents")


# ── LIST ─────────────────────────────────────────────────────


@cli.command(name="list")
@click.option("--verbose", "-v", is_flag=True, help="Show more details")
def list_skills(verbose: bool):
    """List all skills currently in the vault."""
    cfg, paths = require_config()

    if not paths.skills.exists():
        console.print("[yellow]No skills directory. Run [bold]sv init[/] first.[/]")
        return

    prod_skills = sorted(
        (d for d in paths.skills.iterdir() if d.is_dir() and not d.name.startswith(".")),
        key=lambda d: d.name,
    )
    staging_skills = []
    if paths.staging.exists():
        staging_skills = sorted(
            (d for d in paths.staging.iterdir() if d.is_dir() and not d.name.startswith(".")),
            key=lambda d: d.name,
        )

    if not prod_skills and not staging_skills:
        console.print("[yellow]Vault is empty.[/] Use [bold]sv add[/] or [bold]sv adopt[/].")
        return

    manifest = load_manifest(paths.manifest)
    sync_log = load_sync_log(paths.sync_log)
    total = len(prod_skills) + len(staging_skills)

    _rule(f"Vault Skills ({total})")

    table = _styled_table()
    table.add_column("Skill", no_wrap=True)
    table.add_column("Status", width=14)
    table.add_column("Targets", max_width=30)
    if verbose:
        table.add_column("Files", justify="right", width=6)
        table.add_column("SKILL.md", width=8)

    for s in prod_skills:
        info = manifest.get("skills", {}).get(s.name, {})
        targets = info.get("targets", [])
        current_hash = hash_directory(s)
        old_hash = sync_log.get(s.name)

        if not targets:
            status_key = "vault_only"
        elif current_hash and current_hash != old_hash:
            status_key = "stale"
        else:
            status_key = "synced"

        name_col = _skill_name_styled(s.name, status_key)
        badge_col = BADGE[status_key]
        targets_col = ", ".join(targets) if targets else "[dim](no targets)[/]"

        row: list[str] = [name_col, badge_col, targets_col]
        if verbose:
            file_count = sum(1 for f in s.rglob("*") if f.is_file())
            row.append(str(file_count))
            row.append(ICON["ok"] if (s / "SKILL.md").exists() else ICON["err"])
        table.add_row(*row)

    for s in staging_skills:
        name_col = _skill_name_styled(s.name, "staging")
        badge_col = BADGE["staging"]
        info = manifest.get("skills", {}).get(s.name, {})
        source = info.get("source", "")
        targets_col = f"[dim]{source}[/]" if source else "[dim]—[/]"

        row = [name_col, badge_col, targets_col]
        if verbose:
            file_count = sum(1 for f in s.rglob("*") if f.is_file())
            row.append(str(file_count))
            row.append(ICON["ok"] if (s / "SKILL.md").exists() else ICON["err"])
        table.add_row(*row)

    console.print(table)
    parts = []
    synced_count = sum(1 for s in prod_skills if manifest.get("skills", {}).get(s.name, {}).get("targets"))
    if synced_count:
        parts.append(f"[green]{synced_count} synced[/]")
    if staging_skills:
        parts.append(f"[blue]{len(staging_skills)} staging[/]")
    vault_only = len(prod_skills) - synced_count
    if vault_only > 0:
        parts.append(f"[cyan]{vault_only} vault-only[/]")
    console.print(f"\n  {' · '.join(parts)}" if parts else "")


# ── DISCOVER ─────────────────────────────────────────────────


@cli.command()
@click.option("--new-only", is_flag=True, help="Only show skills not yet in the vault")
@click.option("--plugins", is_flag=True, help="Also scan Claude Code plugins")
def discover(new_only: bool, plugins: bool):
    """Scan agent directories (and optionally plugins) for skills.

    By default shows all skills found, with vault status highlighted:
      • New skills are shown in white (ready to adopt)
      • Already-imported skills show in yellow
      • Imported but diverged skills show as ↻ changed

    Use --new-only to filter to skills not yet in the vault.
    """
    cfg, paths = require_config()
    vault_skills = _vault_skill_names(paths)

    agent_locs = {
        k: Path(v).expanduser().resolve()
        for k, v in cfg.get("agent_locations", {}).items()
    }

    if not agent_locs and not plugins:
        console.print("[yellow]No agent locations configured. Run [bold]sv init[/] first.[/]")
        return

    results = scan_all_agents(agent_locs, vault_skills) if agent_locs else {}

    # Also scan Claude plugins if requested
    if plugins:
        found_plugins = scan_claude_plugins()
        if found_plugins:
            console.print(f"\n[bold magenta]Found {len(found_plugins)} Claude plugin(s):[/]")
            for p in found_plugins:
                console.print(f"  [magenta]{p.name}[/] v{p.version} — {p.skill_count} skill(s) at {p.path}")
                plugin_skills = scan_plugin_skills(p, vault_skills)
                if plugin_skills:
                    results[f"plugin:{p.name}"] = plugin_skills
        else:
            console.print("\n[dim]No Claude plugins with skills found.[/]")

    if not results:
        console.print("[yellow]No skills found in any agent directory.[/]")
        return

    _rule("Discovered Skills")

    total_new = 0
    total_changed = 0
    total_imported = 0

    for tool_name, skills in sorted(results.items()):
        display_skills = [s for s in skills if not s.in_vault] if new_only else skills
        if not display_skills:
            continue

        # Show the path for agent dirs, or just the name for plugins
        path_hint = f" ({agent_locs[tool_name]})" if tool_name in agent_locs else ""
        console.print(f"\n[bold cyan]{tool_name}[/]{path_hint}")
        table = _styled_table()
        table.add_column("Skill", no_wrap=True)
        table.add_column("Status", width=14)
        table.add_column("Files", justify="right", width=6)
        table.add_column("Description", max_width=50)

        for s in display_skills:
            if s.in_vault:
                # Check if the agent version has diverged from vault
                conflict = detect_conflict(s.name, paths.skills, s.path, s.source_tool)
                if conflict and conflict.is_conflict:
                    badge = f"{ICON['changed']} {BADGE['stale']}"
                    name_col = _skill_name_styled(s.name, "stale")
                    total_changed += 1
                elif conflict and conflict.has_changes:
                    badge = f"{ICON['changed']} [cyan]\\[updated][/]"
                    name_col = _skill_name_styled(s.name, "stale")
                    total_changed += 1
                else:
                    badge = BADGE["synced"]
                    name_col = _skill_name_styled(s.name, "synced")
                    total_imported += 1
            else:
                badge = BADGE["new"]
                name_col = _skill_name_styled(s.name, "new")
                total_new += 1

            table.add_row(name_col, badge, str(s.file_count), s.description or "[dim]—[/]")

        console.print(table)

    # Summary line
    parts = []
    if total_new:
        parts.append(f"[white bold]{total_new} new[/]")
    if total_imported:
        parts.append(f"[green]{total_imported} synced[/]")
    if total_changed:
        parts.append(f"[yellow]{total_changed} changed[/]")

    if parts:
        console.print(f"\n  {' · '.join(parts)}")
    if total_new > 0:
        _suggest("Run [bold]sv adopt[/] to import new skills")
    if total_changed > 0:
        _suggest("Run [bold]sv pull[/] to update changed skills")
    if not total_new and not total_changed:
        console.print("\n  [green]✓ All discovered skills are in the vault and up to date.[/]")


# ── ADOPT (interactive multi-select import) ──────────────────


@cli.command()
@click.option("--from", "from_target", help="Only look in a specific agent (e.g., claude)")
@click.option("--yes", "-y", is_flag=True, help="Skip confirmation prompt")
@click.option("--push", "do_push", is_flag=True, help="Also push adopted skills to targets")
@click.pass_context
def adopt(ctx, from_target: str | None, yes: bool, do_push: bool):
    """Interactively select discovered skills to import into the vault."""
    import questionary

    _rule("Adopt")
    cfg, paths = require_config()
    vault_skills = _vault_skill_names(paths)

    agent_locs = {
        k: Path(v).expanduser().resolve()
        for k, v in cfg.get("agent_locations", {}).items()
    }

    if from_target:
        if from_target not in agent_locs:
            console.print(f"[red]Unknown agent: {from_target}[/]")
            raise SystemExit(1)
        agent_locs = {from_target: agent_locs[from_target]}

    results = scan_all_agents(agent_locs, vault_skills)
    if not results:
        console.print("[yellow]No skills found in agent directories.[/]")
        return

    # Gather all skills — flag conflicts for ones already in vault with different content
    candidates: list[DiscoveredSkill] = []
    conflict_candidates: list[DiscoveredSkill] = []
    for tool_name, skills in results.items():
        for s in skills:
            if not s.in_vault:
                candidates.append(s)
            else:
                # Check if the vault version differs
                conflict = detect_conflict(s.name, paths.skills, s.path, s.source_tool)
                if conflict and conflict.is_conflict:
                    # Structure differs — needs resolution
                    conflict_candidates.append(s)
                elif conflict and conflict.has_changes:
                    # Content-only change — include as updatable, not conflict
                    candidates.append(s)

    if not candidates and not conflict_candidates:
        console.print("[green]All discovered skills are already in the vault (and match).[/]")
        return

    if conflict_candidates:
        console.print(f"\n  {ICON['warn']} [yellow]{len(conflict_candidates)} skill(s) have structural changes vs vault:[/]")
        for s in conflict_candidates:
            console.print(f"    {ICON['changed']} {_skill_name_styled(s.name, 'stale')} [dim](from [cyan]{s.source_tool}[/] — files added/removed)[/]")
        console.print("  [dim]These will be included in selection for conflict resolution.[/]\n")
        candidates.extend(conflict_candidates)

    if not candidates:
        console.print("[green]Nothing new to adopt.[/]")
        return

    # Build sectioned choices grouped by provider/source tool
    by_source: dict[str, list[DiscoveredSkill]] = {}
    for s in candidates:
        by_source.setdefault(s.source_tool, []).append(s)

    def _adopt_title(s: DiscoveredSkill) -> str:
        parts = [f"{s.name:<30}", f"{s.file_count:>3} files"]
        if s.description:
            desc = s.description[:40] + ("..." if len(s.description) > 40 else "")
            parts.append(f"  {desc}")
        if s.in_vault:
            parts.append("  ** conflict **")
        return "  ".join(parts)

    selected: list[DiscoveredSkill] = _sectioned_checkbox(
        "Select skills to import into the vault:",
        by_source,
        title_fn=_adopt_title,
    )

    if not selected:
        console.print("[dim]Nothing selected.[/]")
        return

    # Confirm
    if not yes:
        console.print(f"\n  [bold]Will import {len(selected)} skill(s):[/]")
        for s in selected:
            status = "stale" if s.in_vault else "new"
            badge = BADGE.get(status, "")
            console.print(f"    {_skill_name_styled(s.name, status)} {badge} [dim]from [cyan]{s.source_tool}[/][/]")
        if not questionary.confirm("Proceed?", default=True).ask():
            console.print("[dim]Cancelled.[/]")
            return

    # Import them (with conflict resolution for skills already in vault)
    _ensure_dir(paths.skills)
    manifest = load_manifest(paths.manifest)
    sync_log = load_sync_log(paths.sync_log)

    for s in selected:
        dest = paths.skills / s.name

        # Check for conflict (skill exists in vault with structural changes)
        if dest.exists():
            conflict = detect_conflict(s.name, paths.skills, s.path, s.source_tool)
            if conflict and conflict.is_conflict:
                console.print(f"\n  {ICON['warn']} [yellow]Conflict for '{s.name}' (structure changed):[/]")
                msg = resolve_interactive(conflict, paths.skills, machine_id=cfg.get("machine_id"))
                console.print(f"    {msg}")
                continue
            elif conflict and conflict.has_changes:
                console.print(f"  {ICON['changed']} Updating [bold]{s.name}[/] [dim](content changed)[/]")

        _copy_skill(s.path, dest)

        # Determine targets — provider isolation: default to source provider only.
        # Users can cross-publish later via `sv share <skill> --with <provider>`.
        all_targets = list(cfg.get("agent_locations", {}).keys())
        source = s.source_tool.split(":")[0]  # strip plugin: prefix
        default_target = [source] if source in all_targets else [s.source_tool]

        safe, warn, warnings = compatible_targets(dest, all_targets, source_tool=s.source_tool)

        if warn:
            console.print(f"\n    {ICON['warn']} [yellow]'{s.name}' has tool-specific features:[/]")
            for t, reasons in warnings.items():
                for r in reasons[:2]:
                    console.print(f"      [dim]{r}[/]")

            # Let user choose targets — color-coded by compatibility
            target_choices = [
                questionary.Choice(
                    title=(
                        f"{t} (source)" if t == source
                        else (f"{t} (compatible)" if t in safe else f"{t} (may not work)")
                    ),
                    value=t,
                    checked=t == source,
                )
                for t in all_targets
            ]
            chosen = questionary.checkbox(
                f"Which targets should '{s.name}' sync to?",
                choices=target_choices,
            ).ask()
            targets = chosen if chosen else default_target
        else:
            # Provider isolation: only push to source provider by default
            targets = default_target

        # Merge into any existing entry so tags/stage/unknown keys survive a
        # re-adopt, and record a structured origin for `sv update` later.
        entry = manifest.setdefault("skills", {}).get(s.name) or {}
        entry.update({
            "targets": targets,
            "source": f"adopted from {s.source_tool}",
        })
        provider_root = agent_locs.get(source)
        if provider_root and s.path.resolve().is_relative_to(provider_root):
            o_root, o_subpath = provider_root, s.path.resolve().relative_to(provider_root).as_posix()
        else:
            o_root, o_subpath = s.path.parent, s.path.name
        entry["origin"] = build_origin(
            "provider",
            path=o_root,
            provider_id=source,
            subpath=o_subpath,
            vault_skill_dir=dest,
        )
        manifest["skills"][s.name] = entry

        h = hash_directory(dest)
        if h:
            sync_log[s.name] = h

        targets_display = ", ".join(f"[cyan]{t}[/]" for t in targets)
        console.print(
            f"  {ICON['ok']} [bold]{s.name}[/] [dim]({s.file_count} files)[/]"
            f" → {targets_display}"
        )

    save_manifest(manifest, paths.manifest)
    save_sync_log(sync_log, paths.sync_log)

    console.print(f"\n  {ICON['ok']} [bold green]Adopted {len(selected)} skill(s).[/]")

    if do_push:
        console.print()
        ctx.invoke(push, skill_names=tuple(s.name for s in selected))
    else:
        _suggest("Run [bold]sv push[/] to sync to agents, or [bold]sv adopt --push[/] next time")


# ── SCAN (local repo scanner) ────────────────────────────────


@cli.command()
@click.argument("repo_path", required=False, default=None, type=click.Path(exists=True))
@click.option("--adopt", "do_adopt", is_flag=True, help="Auto-adopt found skills to staging")
@click.option("--no-ai", is_flag=True, help="Skip AI analysis, use heuristics only")
def scan(repo_path: str | None, do_adopt: bool, no_ai: bool):
    """Scan a local repo (or repos directory) for skills, hooks, and commands.

    If repos_dir is set in config and no REPO_PATH given, shows a browser
    of all repos in that directory.
    """
    import questionary
    from skill_vault.scanner import (
        RepoScanResult,
        ScannedItem,
        SearchHit,
        ai_analyze_repo,
        heuristic_prescan,
        scan_repos_dir,
        search_across_repos,
    )

    cfg, paths = require_config()
    _rule("Scan")

    # Determine which repo to scan
    target_path: Path | None = None

    if repo_path:
        target_path = Path(repo_path).expanduser().resolve()
    else:
        # Check for repos_dir in config
        repos_dir_str = cfg.get("repos_dir", "")
        if repos_dir_str:
            repos_dir = Path(repos_dir_str).expanduser().resolve()
            if repos_dir.is_dir():
                console.print(f"  Your repos directory: [cyan]{repos_dir}[/]\n")

                repo_list = scan_repos_dir(repos_dir)
                if not repo_list:
                    console.print("  [yellow]No repos found in directory.[/]")
                    return

                # Offer search or browse
                action = questionary.select(
                    "How would you like to find skills?",
                    choices=[
                        questionary.Choice("Search across all repos", value="search"),
                        questionary.Choice("Browse repos", value="browse"),
                    ],
                    instruction="(↑↓ to move, Enter to select)",
                ).ask()

                if not action:
                    console.print("[dim]Cancelled.[/]")
                    return

                if action == "search":
                    # Cross-repo search
                    search_query = questionary.text(
                        "Search skills:",
                        instruction="(type a name, keyword, or description fragment)",
                    ).ask()

                    if not search_query:
                        console.print("[dim]Cancelled.[/]")
                        return

                    console.print(f"  Searching for [bold]{search_query}[/] across {len(repo_list)} repos...")
                    hits = search_across_repos(repos_dir, search_query)

                    if not hits:
                        console.print(f"\n  {ICON['warn']} No skills matching '{search_query}' found.")
                        # Offer to try again or browse
                        if questionary.confirm("Browse repos instead?", default=True).ask():
                            action = "browse"  # Fall through to browse
                        else:
                            return

                    if action == "search" and hits:
                        # Show results grouped by repo
                        console.print(f"\n  [bold]Found {len(hits)} skill(s):[/]\n")

                        # Group by repo
                        by_repo: dict[str, list[SearchHit]] = {}
                        for hit in hits:
                            by_repo.setdefault(hit.repo_name, []).append(hit)

                        table = _styled_table()
                        table.add_column("Skill", no_wrap=True)
                        table.add_column("Repo", max_width=25)
                        table.add_column("Description", max_width=50)

                        vault_skills = _vault_skill_names(paths)
                        importable_hits: list[SearchHit] = []
                        for repo_name, repo_hits in sorted(by_repo.items()):
                            for hit in repo_hits:
                                if hit.skill_name in vault_skills:
                                    name_col = _skill_name_styled(hit.skill_name, "synced")
                                    status = f" {BADGE['synced']}"
                                else:
                                    name_col = _skill_name_styled(hit.skill_name, "new")
                                    status = ""
                                    importable_hits.append(hit)
                                table.add_row(
                                    f"{name_col}{status}",
                                    f"[dim]{repo_name}[/]",
                                    hit.description[:50] if hit.description else "[dim]—[/]",
                                )

                        console.print(table)

                        if not importable_hits:
                            console.print(f"\n  {ICON['ok']} All matching skills already in vault.")
                            return

                        # Let user import from search results
                        if len(importable_hits) <= 5:
                            if not questionary.confirm(
                                f"\nImport {len(importable_hits)} new skill(s) to staging?", default=True
                            ).ask():
                                console.print("[dim]Skipped.[/]")
                                return
                            to_import_hits = importable_hits
                        else:
                            pick_action = questionary.select(
                                f"\n{len(importable_hits)} new skill(s). What to do?",
                                choices=[
                                    questionary.Choice(f"Import all {len(importable_hits)} to staging", value="all"),
                                    questionary.Choice("Pick which ones", value="pick"),
                                    questionary.Choice("Cancel", value="cancel"),
                                ],
                            ).ask()

                            if not pick_action or pick_action == "cancel":
                                console.print("[dim]Skipped.[/]")
                                return
                            elif pick_action == "pick":
                                by_repo_items: dict[str, list[SearchHit]] = {}
                                for h in importable_hits:
                                    by_repo_items.setdefault(h.repo_name, []).append(h)
                                selected_hits = _sectioned_checkbox(
                                    "Select skills to import:",
                                    by_repo_items,
                                    title_fn=lambda h: f"{h.skill_name:<30} {h.description[:40] if h.description else ''}",
                                    checked_fn=lambda h: True,
                                )
                                if not selected_hits:
                                    console.print("[dim]Nothing selected.[/]")
                                    return
                                to_import_hits = selected_hits
                            else:
                                to_import_hits = importable_hits

                        # Import search results to staging
                        _ensure_dir(paths.staging)
                        manifest = load_manifest(paths.manifest)
                        for hit in to_import_hits:
                            dest = paths.staging / hit.skill_name
                            if hit.skill_path.is_dir():
                                _copy_skill(hit.skill_path, dest)
                            entry = manifest.setdefault("skills", {}).get(hit.skill_name) or {}
                            entry.update({
                                "targets": entry.get("targets", []),
                                "stage": "staging",
                                "source": f"searched from {hit.repo_name}",
                            })
                            if hit.skill_path.is_dir():
                                o_root, o_subpath = local_dir_root(hit.skill_path)
                                entry["origin"] = build_origin(
                                    "dir", path=o_root, subpath=o_subpath, vault_skill_dir=dest,
                                )
                            manifest["skills"][hit.skill_name] = entry
                            console.print(f"  {ICON['ok']} {hit.skill_name} → staging [dim](from {hit.repo_name})[/]")
                        save_manifest(manifest, paths.manifest)
                        console.print(f"\n  {ICON['ok']} [bold]Imported {len(to_import_hits)} skill(s) to staging.[/]")
                        _suggest("Run [bold]sv promote <name>[/] to move to vault")
                        return

                # Browse mode — repo picker
                if action == "browse":
                    choices = []
                    for name, type_hint, count in repo_list:
                        hint_parts = [type_hint]
                        if count > 0:
                            hint_parts.append(f"{count} items")
                        label = f"{name:<35} {', '.join(hint_parts)}"
                        choices.append(questionary.Choice(title=label, value=name))

                    selected = questionary.select(
                        "Select a repo to scan:",
                        choices=choices,
                        instruction="(↑↓ to move, Enter to select)",
                    ).ask()

                    if not selected:
                        console.print("[dim]Cancelled.[/]")
                        return

                    target_path = repos_dir / selected
            else:
                console.print(f"  [yellow]repos_dir not found: {repos_dir}[/]")
                return
        else:
            console.print("  [yellow]No repo path given and repos_dir not set in config.[/]")
            console.print("  [dim]Usage: [bold]sv scan <path>[/] or set repos_dir in config[/]")
            return

    if not target_path or not target_path.is_dir():
        console.print(f"  {ICON['err']} [red]Not a directory: {target_path}[/]")
        return

    # Step 1: Heuristic pre-scan
    console.print(f"  Scanning [bold]{target_path.name}[/]...")
    result = heuristic_prescan(target_path)

    # Step 2: AI analysis (if enabled and useful)
    scanner_cfg = cfg.get("ai_scanner", {}) if isinstance(cfg.get("ai_scanner"), dict) else {}
    ai_provider = scanner_cfg.get("provider", "claude-cli")
    if no_ai:
        ai_provider = "none"

    needs_ai = result.repo_type in ("plugin", "unknown") or (
        result.readme_content and not result.items
    )
    if needs_ai and ai_provider != "none":
        console.print("  Running AI analysis...")
        import os
        api_key = ""
        if ai_provider in ("anthropic-sdk", "claude-cli"):
            # Resolve API key for SDK, or as fallback if CLI fails
            api_key = scanner_cfg.get("api_key", "")
            if not api_key:
                key_env = scanner_cfg.get("api_key_env", "ANTHROPIC_API_KEY")
                api_key = os.environ.get(key_env, "")

        result = ai_analyze_repo(target_path, result, provider=ai_provider, api_key=api_key)

        # If claude-cli returned nothing, try SDK fallback
        if (
            ai_provider == "claude-cli"
            and not result.items
            and result.ai_analysis.startswith("AI analysis failed")
            and api_key
        ):
            console.print("  [dim]Claude CLI returned no results, trying SDK fallback...[/]")
            result = ai_analyze_repo(target_path, result, provider="anthropic-sdk", api_key=api_key)

    # Step 3: Present findings
    console.print()
    _rule(target_path.name)

    if result.ai_analysis:
        if result.ai_analysis.startswith("AI analysis failed"):
            console.print(f"  {ICON['warn']} [yellow]{result.ai_analysis}[/]")
        else:
            console.print(f"  [bold]AI Analysis:[/] {result.ai_analysis}")
    console.print(f"  [bold]Type:[/] {result.repo_type}")
    if result.install_instructions:
        console.print(f"  [bold]Install:[/] {result.install_instructions}")

    if not result.items and result.repo_type == "plugin":
        # Plugin with no extracted skills — offer AI-assisted install
        console.print(f"\n  {ICON['warn']} No individual skills found, but this is a plugin repo.")
        if result.install_instructions:
            console.print(f"  [bold]Install method:[/] {result.install_instructions}")

        if ai_provider == "none":
            console.print("  [dim]Enable AI scanner to get install assistance.[/]")
            return

        if not questionary.confirm(
            "\n  Use AI to figure out how to install this into the vault?", default=True
        ).ask():
            console.print("[dim]Skipped.[/]")
            return

        # Ask AI to generate an install script
        console.print("  Running AI install analysis...")
        from skill_vault.scanner import _sanitize_for_subprocess
        safe_readme = _sanitize_for_subprocess(result.readme_content[:5000])
        install_prompt = f"""I have a plugin repository at: {target_path}

README content:
{safe_readme}

Install instructions from heuristic scan: {result.install_instructions}

This repo needs to be installed so its skills/tools can be extracted into a skill vault directory.
The vault staging directory is: {paths.staging}
The vault production directory is: {paths.skills}

Generate a shell script (bash/cmd compatible) that:
1. Installs the plugin's dependencies if needed (npm install, pip install, etc.)
2. Copies or extracts the skill content (markdown files, SKILL.md files, command definitions) into a target directory
3. Does NOT modify any global configuration — only copies skill files

The script should accept one argument: the destination directory path.

Respond in JSON format:
{{
  "description": "what this install does",
  "items_found": ["list", "of", "skill/tool names"],
  "script": "the shell script content",
  "warnings": ["any warnings about this install"]
}}"""

        from skill_vault.scanner import _call_claude_cli, _call_anthropic_sdk, _parse_json_from_response
        try:
            if ai_provider == "claude-cli":
                ai_result = _call_claude_cli(install_prompt)
            else:
                api_key = scanner_cfg.get("api_key", "")
                if not api_key:
                    import os
                    key_env = scanner_cfg.get("api_key_env", "ANTHROPIC_API_KEY")
                    api_key = os.environ.get(key_env, "")
                ai_result = _call_anthropic_sdk(install_prompt, api_key)
        except Exception as exc:
            console.print(f"  {ICON['err']} [red]AI analysis failed: {exc}[/]")
            return

        if not ai_result:
            console.print(f"  {ICON['err']} [red]AI returned empty response.[/]")
            return

        parsed = _parse_json_from_response(ai_result)
        if not parsed:
            console.print(f"  {ICON['warn']} AI response (not structured):")
            console.print(f"  [dim]{ai_result[:500]}[/]")
            return

        # Show what the AI found
        console.print(f"\n  [bold]AI Install Plan:[/]")
        console.print(f"    {parsed.get('description', 'No description')}")
        items_found = parsed.get("items_found", [])
        if items_found:
            console.print(f"\n  [bold]Items found ({len(items_found)}):[/]")
            for item_name in items_found:
                console.print(f"    {ICON['ok']} {item_name}")
        for warn in parsed.get("warnings", []):
            console.print(f"    {ICON['warn']} [yellow]{warn}[/]")

        script = parsed.get("script", "")
        if not script:
            console.print(f"  {ICON['err']} [red]No install script generated.[/]")
            return

        # Let user choose destination
        dest_choice = questionary.select(
            "Install to:",
            choices=[
                questionary.Choice("Staging (testing area)", value="staging"),
                questionary.Choice("Production (vault)", value="production"),
                questionary.Choice("Cancel", value="cancel"),
            ],
        ).ask()

        if not dest_choice or dest_choice == "cancel":
            console.print("[dim]Cancelled.[/]")
            return

        dest_dir = paths.staging if dest_choice == "staging" else paths.skills
        _ensure_dir(dest_dir)

        # Show script and confirm
        console.print(f"\n  [bold]Install script:[/]")
        for line in script.strip().split("\n"):
            console.print(f"    [dim]{line}[/]")

        if not questionary.confirm("\n  Run this install script?", default=False).ask():
            console.print("[dim]Cancelled.[/]")
            return

        # Execute the install script
        import subprocess as _sp
        import tempfile
        console.print(f"\n  Running install to {dest_dir}...")
        try:
            # Write script to temp file and execute
            with tempfile.NamedTemporaryFile(mode="w", suffix=".sh", delete=False, encoding="utf-8") as f:
                # Substitute the destination dir
                final_script = script.replace("$1", str(dest_dir)).replace("${1}", str(dest_dir))
                f.write(final_script)
                script_path = f.name

            result_proc = _sp.run(
                ["bash", script_path],
                capture_output=True,
                text=True,
                timeout=120,
                cwd=str(target_path),
            )

            if result_proc.returncode == 0:
                console.print(f"  {ICON['ok']} [bold green]Install completed.[/]")
                if result_proc.stdout.strip():
                    for line in result_proc.stdout.strip().split("\n")[:10]:
                        console.print(f"    [dim]{line}[/]")
            else:
                console.print(f"  {ICON['err']} [red]Install failed (exit code {result_proc.returncode}):[/]")
                if result_proc.stderr.strip():
                    for line in result_proc.stderr.strip().split("\n")[:10]:
                        console.print(f"    [red]{line}[/]")

            # Clean up temp script
            Path(script_path).unlink(missing_ok=True)

            # Update manifest for any items found
            manifest = load_manifest(paths.manifest)
            stage = "staging" if dest_choice == "staging" else "production"
            for item_name in items_found:
                item_dir = dest_dir / item_name
                if item_dir.exists():
                    manifest.setdefault("skills", {})[item_name] = {
                        "targets": [],
                        "stage": stage,
                        "source": f"installed from {target_path.name}",
                    }
                    console.print(f"  {ICON['ok']} {item_name} → {stage}")
            save_manifest(manifest, paths.manifest)

        except _sp.TimeoutExpired:
            console.print(f"  {ICON['err']} [red]Install timed out (120s).[/]")
        except Exception as exc:
            console.print(f"  {ICON['err']} [red]Install error: {exc}[/]")

        return

    elif not result.items:
        console.print(f"\n  {ICON['warn']} No skills, hooks, or commands found.")
        return

    vault_skills = _vault_skill_names(paths)
    staging_names: set[str] = set()
    if paths.staging.exists():
        staging_names = {
            d.name for d in paths.staging.iterdir()
            if d.is_dir() and not d.name.startswith(".")
        }

    # For large repos, offer search/filter before showing the full list
    display_items = result.items
    if len(result.items) > 20 and not do_adopt:
        console.print(f"\n  [bold]{len(result.items)} item(s) found.[/]")
        filter_action = questionary.select(
            "This is a large collection. How to proceed?",
            choices=[
                questionary.Choice("Search/filter skills", value="search"),
                questionary.Choice("Show all", value="all"),
            ],
        ).ask()

        if not filter_action:
            console.print("[dim]Cancelled.[/]")
            return

        if filter_action == "search":
            filter_query = questionary.text(
                "Filter skills:",
                instruction="(type a name, keyword, or description fragment)",
            ).ask()

            if filter_query:
                q = filter_query.lower()
                display_items = [
                    item for item in result.items
                    if q in item.name.lower() or q in item.description.lower()
                ]
                console.print(f"  [dim]Showing {len(display_items)} of {len(result.items)} matching '{filter_query}'[/]")
                if not display_items:
                    console.print(f"  {ICON['warn']} No items match '{filter_query}'.")
                    if questionary.confirm("Show all instead?", default=True).ask():
                        display_items = result.items
                    else:
                        return

    console.print(f"\n  [bold]Found {len(display_items)} item(s):[/]\n")
    table = _styled_table()
    table.add_column("Name", no_wrap=True)
    table.add_column("Type", width=10)
    table.add_column("Status", width=14)
    table.add_column("Description", max_width=50)

    importable: list[ScannedItem] = []
    for item in display_items:
        if item.name in vault_skills:
            status = BADGE["synced"]
            name_col = _skill_name_styled(item.name, "synced")
        elif item.name in staging_names:
            status = BADGE["staging"]
            name_col = _skill_name_styled(item.name, "staging")
        else:
            status = BADGE["new"]
            name_col = _skill_name_styled(item.name, "new")
            if item.item_type == "skill":
                importable.append(item)

        type_col = f"[dim]{item.item_type}[/]"
        table.add_row(name_col, type_col, status, item.description or "[dim]—[/]")

    console.print(table)

    if not importable:
        console.print(f"\n  {ICON['ok']} All skills already in vault or staging.")
        return

    # Import to staging — let user pick which skills, or import all
    if do_adopt:
        to_import = importable
    elif len(importable) <= 5:
        # Small number — simple confirm
        if not questionary.confirm(
            f"\nImport {len(importable)} new skill(s) to staging?", default=True
        ).ask():
            console.print("[dim]Skipped.[/]")
            return
        to_import = importable
    else:
        # Many skills — offer select all or pick individually
        action = questionary.select(
            f"\n{len(importable)} new skill(s) found. What to do?",
            choices=[
                questionary.Choice(f"Import all {len(importable)} to staging", value="all"),
                questionary.Choice("Pick which ones to import", value="pick"),
                questionary.Choice("Cancel", value="cancel"),
            ],
        ).ask()

        if not action or action == "cancel":
            console.print("[dim]Skipped.[/]")
            return
        elif action == "pick":
            selected = _sectioned_checkbox(
                "Select skills to import to staging:",
                {"Skills": importable},
                title_fn=lambda i: f"{i.name:<30} {i.file_count:>3} files  {i.description[:40] if i.description else ''}",
                checked_fn=lambda i: True,
            )
            if not selected:
                console.print("[dim]Nothing selected.[/]")
                return
            to_import = selected
        else:
            to_import = importable

    _ensure_dir(paths.staging)
    manifest = load_manifest(paths.manifest)

    for item in to_import:
        dest = paths.staging / item.name
        if item.path.is_dir():
            _copy_skill(item.path, dest)
        else:
            # Single file — create a directory for it
            dest.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(item.path), str(dest / item.path.name))

        entry = manifest.setdefault("skills", {}).get(item.name) or {}
        entry.update({
            "targets": entry.get("targets", []),
            "stage": "staging",
            "source": f"scanned from {target_path.name}",
        })
        if item.path.is_dir():
            o_root, o_subpath = local_dir_root(item.path, fallback_root=target_path)
            entry["origin"] = build_origin(
                "dir", path=o_root, subpath=o_subpath, vault_skill_dir=dest,
            )
        manifest["skills"][item.name] = entry
        console.print(f"  {ICON['ok']} {item.name} → staging")

    save_manifest(manifest, paths.manifest)
    console.print(f"\n  {ICON['ok']} [bold]Imported {len(to_import)} skill(s) to staging.[/]")
    _suggest("Run [bold]sv promote <name>[/] to move to vault, or [bold]sv promote <name> --push[/] to go live")


# ── ADOPT-REMOTE ─────────────────────────────────────────────


@cli.command(name="adopt-remote")
@click.argument("url")
@click.option("--branch", "-b", help="Git branch to clone")
@click.option("--yes", "-y", is_flag=True, help="Skip confirmation prompt")
def adopt_remote(url: str, branch: str | None, yes: bool):
    """Clone a git repo or plugin URL, discover skills, and interactively import them."""
    import questionary

    cfg, paths = require_config()
    vault_skills = _vault_skill_names(paths)

    console.print(f"[cyan]Cloning[/] {url} ...")
    try:
        repo_info = clone_remote_repo(url, branch=branch)
    except RuntimeError as e:
        console.print(f"[red]{e}[/]")
        raise SystemExit(1)

    try:
        if repo_info.is_plugin:
            console.print(f"[magenta]Detected Claude plugin:[/] {repo_info.plugin_name or '(unnamed)'}")

        if not repo_info.skills_dirs:
            console.print("[yellow]No skills/ directories found in the repo.[/]")
            return

        console.print(f"Found {len(repo_info.skills_dirs)} skill location(s):")
        for sd in repo_info.skills_dirs:
            rel = sd.relative_to(repo_info.clone_dir)
            console.print(f"  [dim]{rel}[/]")

        # Scan for individual skills
        results = scan_remote_skills(repo_info, vault_skills)
        if not results:
            console.print("[yellow]No valid skills found in the repo.[/]")
            return

        # Flatten into candidates
        candidates: list[DiscoveredSkill] = []
        for label, skills in results.items():
            for s in skills:
                candidates.append(s)

        already = [s for s in candidates if s.in_vault]
        new_ones = [s for s in candidates if not s.in_vault]

        if already:
            console.print(f"\n[dim]{len(already)} skill(s) already in vault:[/]")
            for s in already:
                console.print(f"  [dim]✓ {s.name}[/]")

        if not new_ones and not already:
            console.print("[yellow]No adoptable skills found.[/]")
            return

        # Let user pick from new + already-in-vault, sectioned by source label
        pick_list = new_ones + already
        by_source: dict[str, list[DiscoveredSkill]] = {}
        for s in pick_list:
            by_source.setdefault(s.source_tool, []).append(s)

        selected: list[DiscoveredSkill] = _sectioned_checkbox(
            "Select skills to import into the vault:",
            by_source,
            title_fn=lambda s: (
                f"{s.name} ({s.file_count} files)"
                f"{' — ' + s.description if s.description else ''}"
                f"{' [already in vault]' if s.in_vault else ''}"
            ),
            checked_fn=lambda s: not s.in_vault,
        )

        if not selected:
            console.print("[dim]Nothing selected.[/]")
            return

        # Confirm
        if not yes:
            console.print(f"\n[bold]Will import {len(selected)} skill(s) from {url}:[/]")
            for s in selected:
                console.print(f"  • {s.name}")
            if not questionary.confirm("Proceed?", default=True).ask():
                console.print("[dim]Cancelled.[/]")
                return

        # Import skills (same logic as adopt, with provider isolation)
        _ensure_dir(paths.skills)
        manifest = load_manifest(paths.manifest)
        sync_log = load_sync_log(paths.sync_log)

        all_targets = list(cfg.get("agent_locations", {}).keys())

        for s in selected:
            dest = paths.skills / s.name

            # Conflict resolution if skill already in vault
            if dest.exists():
                conflict = detect_conflict(s.name, paths.skills, s.path, s.source_tool)
                if conflict and conflict.is_conflict:
                    console.print(f"\n[yellow]Conflict for '{s.name}' (structure changed):[/]")
                    msg = resolve_interactive(conflict, paths.skills, machine_id=cfg.get("machine_id"))
                    console.print(f"  {msg}")
                    continue
                elif conflict and conflict.has_changes:
                    console.print(f"  [dim]Updating '{s.name}' (content changed)[/]")
                    # Fall through to the copy below
                elif conflict:
                    console.print(f"  [dim]✓ {s.name} identical to vault — skipped[/]")
                    continue

            _copy_skill(s.path, dest)

            # Provider isolation: default to source provider only.
            source = s.source_tool.split(":")[0].split("/")[0]  # strip plugin:/remote: prefix
            # Remote skills use labels like "remote:skills" — not a real target,
            # so default to NO targets (vault-only) unless the label matches.
            default_target = [source] if source in all_targets else []

            safe, warn, warnings = compatible_targets(dest, all_targets, source_tool=s.source_tool)

            if warn:
                console.print(f"\n  [yellow]⚠ '{s.name}' has tool-specific features:[/]")
                for t, reasons in warnings.items():
                    for r in reasons[:2]:
                        console.print(f"    [dim]{r}[/]")

                target_choices = [
                    questionary.Choice(
                        title=(
                            f"{t} [dim](source)[/]" if t == source
                            else (f"{t} [dim](compatible)[/]" if t in safe else f"{t} [dim](may not work)[/]")
                        ),
                        value=t,
                        checked=t == source,
                    )
                    for t in all_targets
                ]
                chosen = questionary.checkbox(
                    f"Which targets should '{s.name}' sync to?",
                    choices=target_choices,
                ).ask()
                targets = chosen if chosen else default_target
            else:
                targets = default_target

            if not targets:
                console.print(f"    [dim]vault-only (use [bold]sv share[/] to push to providers)[/]")

            entry = manifest.setdefault("skills", {}).get(s.name) or {}
            entry.update({
                "targets": targets,
                "source": f"adopted from {url}",
            })
            entry["origin"] = build_origin(
                "git",
                url=url,
                ref=branch,
                subpath=s.path.resolve().relative_to(repo_info.clone_dir.resolve()).as_posix(),
                vault_skill_dir=dest,
            )
            manifest["skills"][s.name] = entry

            h = hash_directory(dest)
            if h:
                sync_log[s.name] = h

            console.print(f"  [green]✓[/] {s.name}")

        save_manifest(manifest, paths.manifest)
        save_sync_log(sync_log, paths.sync_log)

        console.print(f"\n[bold green]Adopted {len(selected)} skill(s) from remote.[/] Run [bold]sv push[/] to sync them out.")

    finally:
        # Always clean up the temp clone (rmtree_force clears the read-only
        # bit on git object files, which plain rmtree leaves behind on Windows)
        rmtree_force(repo_info.clone_dir)


# ── UPDATE (pull upstream changes for adopted skills) ────────


@cli.command()
@click.argument("skill_names", nargs=-1)
@click.option("--all", "update_all", is_flag=True,
              help="Check every skill with a recorded origin (default when no names given)")
@click.option("--check-only", is_flag=True, help="Report statuses without changing anything")
@click.option("--yes", "-y", is_flag=True, help="Apply all safe updates without prompting (conflicts are never auto-applied)")
def update(skill_names: tuple[str, ...], update_all: bool, check_only: bool, yes: bool):
    """Check adopted skills against their sources and pull upstream changes.

    Sources are recorded automatically at adopt time (sv adopt, sv scan,
    sv adopt-remote). Local git checkouts are freshened with
    `git pull --ff-only` before comparing; remote git origins are
    shallow-cloned to a temp dir. A three-way hash comparison separates
    safe updates (vault copy untouched since adoption) from conflicts
    (both the vault copy and upstream changed).
    """
    _rule("Update from source")
    cfg, paths = require_config()
    manifest = load_manifest(paths.manifest)

    names = list(skill_names) if skill_names else None
    checks = check_updates(manifest, paths, names)
    if not checks:
        console.print("[yellow]No skills with a recorded origin to check.[/]")
        console.print("[dim]Origins are recorded when skills are adopted — re-adopt a skill to start tracking its source.[/]")
        return

    STATUS_STYLE = {
        "update_available": ("green", "update available"),
        "conflict": ("yellow", "conflict (local changes)"),
        "local_changed": ("cyan", "local changes only"),
        "up_to_date": ("dim", "up to date"),
        "no_origin": ("dim", "no origin recorded"),
        "source_missing": ("red", "source missing"),
        "upstream_missing": ("red", "gone upstream"),
        "error": ("red", "error"),
    }
    tmp_roots = {c.tmp_root for c in checks if c.tmp_root}
    try:
        for c in checks:
            color, label = STATUS_STYLE.get(c.status, ("white", c.status))
            pulled = " [dim](pulled)[/]" if c.git_pulled else ""
            extra = f" [dim]{c.message}[/]" if c.message else ""
            console.print(f"  [{color}]{label:<24}[/] [bold]{c.name}[/]{pulled}{extra}")

        updatable = [c for c in checks if c.status == "update_available"]
        conflicts = [c for c in checks if c.status == "conflict"]

        if not updatable and not conflicts:
            if not check_only:
                console.print(f"\n  {ICON['ok']} [green]Nothing to update.[/]")
            return
        if check_only:
            return

        if yes:
            selected = list(updatable)
        else:
            def _update_title(c) -> str:
                hashes = f"{(c.vault_hash or '?')[:8]} → {(c.upstream_hash or '?')[:8]}"
                return f"{c.name:<30} {hashes}" + (f"  {c.message}" if c.message else "")

            selected = _sectioned_checkbox(
                "Select skills to update from source:",
                {
                    "Updates available": updatable,
                    "Conflicts — local changes will be overwritten": conflicts,
                },
                title_fn=_update_title,
                checked_fn=lambda c: c.status == "update_available",
            )
        if not selected:
            console.print("[dim]Nothing selected.[/]")
            return

        applied = 0
        for c in selected:
            entry = manifest.setdefault("skills", {}).get(c.name)
            if entry is None or c.upstream_path is None:
                continue
            if c.status == "conflict":
                origin = c.origin or {}
                origin_label = origin.get("url") or origin.get("path") or "source"
                conflict = detect_conflict(c.name, paths.skills, c.upstream_path, str(origin_label))
                if conflict is not None:
                    console.print(f"\n  {ICON['warn']} [yellow]Conflict for '{c.name}':[/]")
                    msg = resolve_interactive(conflict, paths.skills, machine_id=cfg.get("machine_id"))
                    console.print(f"    {msg}")
                    # Rebaseline the origin only when the vault now matches
                    # upstream (the user took the incoming version). Keeping
                    # the vault version must NOT refresh content_hash — that
                    # would make a later `sv update -y` silently clobber the
                    # local edits it just chose to keep.
                    if hash_directory(paths.skills / c.name) == c.upstream_hash:
                        from skill_vault.updates import refresh_origin
                        entry["origin"] = refresh_origin(origin, paths.skills / c.name)
                        applied += 1
                    continue
                # Not in skills/ (e.g. staged) — no interactive machinery; the
                # user explicitly selected the conflict row, so overwrite.
            apply_update(c, paths, entry)
            applied += 1
            console.print(f"  {ICON['ok']} [bold]{c.name}[/] updated")

        save_manifest(manifest, paths.manifest)
        if applied:
            console.print(f"\n  {ICON['ok']} [bold green]Updated {applied} skill(s).[/]")
            _suggest("Run [bold]sv push[/] to sync the updated skills to agents")
    finally:
        for t in tmp_roots:
            rmtree_force(t)


# ── SHARE (cross-publish to other providers) ─────────────────


@cli.command()
@click.argument("skill_name", required=False, default=None)
@click.option("--with", "with_targets", multiple=True, help="Add these providers as targets")
@click.option("--remove", "remove_targets", multiple=True, help="Remove these providers from targets")
@click.option("--all", "share_all", is_flag=True, help="Share with all configured providers")
def share(skill_name: str | None, with_targets: tuple[str, ...], remove_targets: tuple[str, ...], share_all: bool):
    """Share a skill with additional providers (cross-publish).

    By default, adopted skills only sync to their source provider.
    Use this command to explicitly share them with other providers.

    Examples:
      sv share my-skill --with claude --with cursor
      sv share my-skill --all
      sv share my-skill --remove openclaw
      sv share   (interactive picker)
    """
    import questionary

    cfg, paths = require_config()
    manifest = load_manifest(paths.manifest)
    all_targets = list(cfg.get("agent_locations", {}).keys())

    if not all_targets:
        console.print("[yellow]No providers configured. Run [bold]sv init[/] first.[/]")
        return

    _rule("Share")

    # If skill_name given with flags, handle directly (non-interactive)
    if skill_name and (with_targets or remove_targets or share_all):
        if skill_name not in manifest.get("skills", {}):
            console.print(f"  {ICON['err']} [red]Skill '{skill_name}' not in manifest.[/]")
            raise SystemExit(1)

        skill_cfg = manifest["skills"][skill_name]
        current_targets = list(skill_cfg.get("targets", []))

        if share_all:
            skill_cfg["targets"] = list(all_targets)
            save_manifest(manifest, paths.manifest)
            console.print(f"  {ICON['ok']} [bold]{skill_name}[/] → {', '.join(all_targets)}")
            _suggest("Run [bold]sv push[/] to sync")
            return

        if remove_targets:
            for t in remove_targets:
                if t in current_targets:
                    current_targets.remove(t)
                    console.print(f"  [yellow]−[/] removed {t}")
            skill_cfg["targets"] = current_targets
            save_manifest(manifest, paths.manifest)
            console.print(f"  {ICON['ok']} [bold]{skill_name}[/] → {', '.join(current_targets) or '(vault-only)'}")
            return

        if with_targets:
            for t in with_targets:
                if t not in all_targets:
                    console.print(f"  {ICON['warn']} [yellow]'{t}' not a configured provider — skipped[/]")
                    continue
                if t not in current_targets:
                    current_targets.append(t)
                    console.print(f"  [green]+[/] added {t}")
            skill_cfg["targets"] = current_targets
            save_manifest(manifest, paths.manifest)
            console.print(f"  {ICON['ok']} [bold]{skill_name}[/] → {', '.join(current_targets)}")
            _suggest("Run [bold]sv push[/] to sync")
            return

    # ── Interactive mode: pick skills first, then providers ──
    vault_skills = sorted(manifest.get("skills", {}).keys())
    if not vault_skills:
        console.print("  [yellow]No skills in vault.[/]")
        return

    # If a single skill_name was given (no flags), pre-select it
    if skill_name:
        if skill_name not in manifest.get("skills", {}):
            console.print(f"  {ICON['err']} [red]Skill '{skill_name}' not in manifest.[/]")
            raise SystemExit(1)
        selected_skills = [skill_name]
    else:
        # Step 1: Pick skills — sectioned by current provider targets
        sections: dict[str, list[str]] = {}
        uncategorised: list[str] = []
        for sname in vault_skills:
            stage = manifest.get("skills", {}).get(sname, {}).get("stage", "production")
            if stage == "staging":
                continue
            targets = manifest["skills"][sname].get("targets", [])
            if targets:
                for t in targets:
                    sections.setdefault(t, []).append(sname)
            else:
                uncategorised.append(sname)

        seen: set[str] = set()
        deduped: dict[str, list[str]] = {}
        for label in sorted(sections):
            for sname in sections[label]:
                if sname not in seen:
                    deduped.setdefault(label, []).append(sname)
                    seen.add(sname)
        if uncategorised:
            for sname in uncategorised:
                if sname not in seen:
                    deduped.setdefault("vault-only", []).append(sname)
                    seen.add(sname)

        def _share_title(sname: str) -> str:
            targets = manifest.get("skills", {}).get(sname, {}).get("targets", [])
            targets_str = ", ".join(targets) if targets else "(no targets)"
            return f"{sname:<30} → {targets_str}"

        selected_skills = _sectioned_checkbox(
            "Select skill(s) to share:",
            deduped,
            title_fn=_share_title,
        )

        if not selected_skills:
            console.print("[dim]Nothing selected.[/]")
            return

    # Step 2: Pick providers to share with
    console.print(f"\n  [bold]Selected {len(selected_skills)} skill(s).[/] Now choose providers:\n")

    provider_choices = _sectioned_checkbox(
        "Select providers to share these skills with:",
        {"Providers": all_targets},
        title_fn=lambda t: t,
        checked_fn=lambda t: False,
    )

    if not provider_choices:
        console.print("[dim]No providers selected.[/]")
        return

    # Apply: add selected providers to each selected skill
    changed = 0
    for sname in selected_skills:
        skill_cfg = manifest["skills"][sname]
        current = set(skill_cfg.get("targets", []))
        new_targets = current | set(provider_choices)
        if new_targets != current:
            skill_cfg["targets"] = sorted(new_targets)
            added = new_targets - current
            console.print(
                f"  {ICON['ok']} [bold]{sname}[/] [green]+[/] {', '.join(sorted(added))}"
                f"  → {', '.join(skill_cfg['targets'])}"
            )
            changed += 1
        else:
            console.print(f"  [dim]{sname} — already shared with selected providers[/]")

    save_manifest(manifest, paths.manifest)
    if changed:
        console.print(f"\n  {ICON['ok']} [bold]Updated {changed} skill(s).[/]")
        _suggest("Run [bold]sv push[/] to sync to agents")
    else:
        console.print(f"\n  [dim]No changes needed.[/]")


# ── FIX (audit & repair vault state) ─────────────────────────


@cli.command()
@click.option("--dry-run", is_flag=True, help="Show what would be fixed without changing anything")
@click.option("--isolate", is_flag=True, help="Retroactively apply provider isolation to existing skills")
def fix(dry_run: bool, isolate: bool):
    """Audit and repair vault state.

    Detects and fixes:
      - Broken / stale symlinks and junctions
      - Doubled paths (skills/skills/...)
      - Orphan links in agent dirs (skill not in targets)
      - Missing manifest entries for skills on disk
      - Provider isolation (--isolate): narrows targets to source provider

    Run with --dry-run first to preview changes.
    """
    import questionary

    cfg, paths = require_config()
    manifest = load_manifest(paths.manifest)
    sync_log = load_sync_log(paths.sync_log)
    all_targets = list(cfg.get("agent_locations", {}).keys())

    fixed = 0
    mode_label = "[dim](dry run)[/] " if dry_run else ""

    console.print("[bold cyan]Skill Vault — Fix[/]\n")

    # ── 1. Detect doubled paths (skills/skills/) ──
    doubled = paths.skills / "skills"
    if doubled.exists() or doubled.is_symlink():
        console.print(f"{mode_label}[yellow]⚠ Doubled path detected:[/] {doubled}")
        if not dry_run:
            if is_link(doubled) or doubled.is_symlink():
                unlink_or_remove(doubled)
                console.print(f"  [green]✓[/] Removed stale link at doubled path")
            elif doubled.is_dir():
                for child in list(doubled.iterdir()):
                    target = paths.skills / child.name
                    if not target.exists():
                        child.rename(target)
                        console.print(f"  [green]✓[/] Moved {child.name} up from doubled path")
                    else:
                        console.print(f"  [dim]Skipped {child.name} (already exists at correct path)[/]")
                try:
                    doubled.rmdir()
                    console.print(f"  [green]✓[/] Removed empty doubled directory")
                except OSError:
                    console.print(f"  [yellow]⚠ Could not remove {doubled} (not empty)[/]")
        fixed += 1
    # Also check if is_link detects it even when .exists() returns False (broken junction)
    elif _check_broken_link(doubled):
        console.print(f"{mode_label}[yellow]⚠ Broken junction at doubled path:[/] {doubled}")
        if not dry_run:
            unlink_or_remove(doubled)
            console.print(f"  [green]✓[/] Removed broken junction")
        fixed += 1

    # ── 2. Scan vault skills/ for broken links ──
    if paths.skills.exists():
        for entry in sorted(paths.skills.iterdir()):
            if entry.name.startswith("."):
                continue
            if is_link(entry) or entry.is_symlink():
                try:
                    exists = entry.exists()
                except OSError:
                    exists = False
                if not exists:
                    console.print(f"{mode_label}[yellow]⚠ Broken link in vault:[/] {entry.name}")
                    if not dry_run:
                        unlink_or_remove(entry)
                        console.print(f"  [green]✓[/] Removed broken link")
                        if entry.name in manifest.get("skills", {}):
                            del manifest["skills"][entry.name]
                    fixed += 1

    # ── 3. Scan agent dirs for orphan/broken links ──
    for tname, tpath in paths.agent_locations.items():
        if not tpath.exists():
            continue
        for entry in sorted(tpath.iterdir()):
            if entry.name.startswith("."):
                continue
            if not entry.is_dir() and not is_link(entry) and not entry.is_symlink():
                continue

            # Broken links
            if is_link(entry) or entry.is_symlink():
                try:
                    exists = entry.exists()
                except OSError:
                    exists = False
                if not exists:
                    console.print(f"{mode_label}[yellow]⚠ Broken link:[/] {tname}/{entry.name}")
                    if not dry_run:
                        unlink_or_remove(entry)
                        console.print(f"  [green]✓[/] Removed")
                    fixed += 1
                    continue

            # Orphan links: skill in agent dir but target not assigned in manifest
            skill_targets = manifest.get("skills", {}).get(entry.name, {}).get("targets", [])
            if entry.name in manifest.get("skills", {}) and tname not in skill_targets:
                if is_link(entry) or entry.is_symlink():
                    console.print(f"{mode_label}[yellow]⚠ Orphan link:[/] {tname}/{entry.name} (not in targets)")
                    if not dry_run:
                        unlink_or_remove(entry)
                        console.print(f"  [green]✓[/] Removed orphan link")
                    fixed += 1

    # ── 4. Skills on disk but not in manifest ──
    if paths.skills.exists():
        for entry in sorted(paths.skills.iterdir()):
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            if entry.name == "backup":
                continue
            if entry.name not in manifest.get("skills", {}):
                console.print(f"{mode_label}[yellow]⚠ Untracked skill:[/] {entry.name} (on disk but not in manifest)")
                if not dry_run:
                    manifest.setdefault("skills", {})[entry.name] = {
                        "targets": [],
                        "source": "discovered by sv fix",
                    }
                    console.print(f"  [green]✓[/] Added to manifest (vault-only, use [bold]sv share[/] to assign)")
                fixed += 1

    # ── 5. Provider isolation (--isolate) ──
    if isolate:
        console.print(f"\n{mode_label}[bold]Provider isolation audit:[/]")
        changes: list[tuple[str, list[str], list[str]]] = []

        for sname, skill_cfg in manifest.get("skills", {}).items():
            current = skill_cfg.get("targets", [])
            source_str = skill_cfg.get("source", "")

            # Parse source provider from the "source" field
            source_provider = None
            for prefix in ("adopted from ", "pulled from "):
                if source_str.startswith(prefix):
                    raw = source_str[len(prefix):]
                    if raw.startswith("http"):
                        source_provider = None
                    else:
                        source_provider = raw.split(":")[0].split("/")[0]
                    break

            if source_provider is None:
                continue

            if len(current) > 1 or (len(current) == 1 and current[0] != source_provider):
                new_targets = [source_provider] if source_provider in all_targets else current
                if new_targets != current:
                    changes.append((sname, current, new_targets))

        if not changes:
            console.print("  [green]All skills already provider-isolated.[/]")
        else:
            for sname, old, new in changes:
                console.print(
                    f"  {sname}: {', '.join(old)} → {', '.join(new)}"
                )

            if not dry_run:
                if questionary.confirm(
                    f"Isolate {len(changes)} skill(s) to their source provider?",
                    default=True,
                ).ask():
                    for sname, old, new in changes:
                        manifest["skills"][sname]["targets"] = new
                    fixed += len(changes)
                    console.print(f"  [green]✓[/] Isolated {len(changes)} skill(s)")
                else:
                    console.print("  [dim]Skipped isolation.[/]")

    # ── Save ──
    if not dry_run and fixed:
        save_manifest(manifest, paths.manifest)
        save_sync_log(sync_log, paths.sync_log)

    if fixed:
        console.print(f"\n[bold green]{fixed} issue(s) {'would be ' if dry_run else ''}fixed.[/]")
        if not dry_run:
            console.print("[dim]Run [bold]sv push[/] to re-sync.[/]")
    else:
        console.print("\n[bold green]No issues found.[/] Vault looks healthy.")


def _check_broken_link(path: Path) -> bool:
    """Check if a path is a broken junction/symlink (target gone)."""
    try:
        if path.is_symlink():
            return not path.exists()
        if is_link(path):
            return not path.exists()
    except OSError:
        return True
    return False


# ── SNAPSHOT / DEVICES / SYNC-FROM ────────────────────────────


def _snapshots_dir(paths: ResolvedPaths) -> Path:
    return paths.vault / "snapshots"


def _take_snapshot(cfg: dict[str, Any], paths: ResolvedPaths, *, quiet: bool = False) -> Path:
    """Save current vault state to snapshots/<machine_id>.json."""
    import datetime

    machine_id = cfg.get("machine_id", "unknown")
    snap_dir = _snapshots_dir(paths)
    _ensure_dir(snap_dir)

    manifest = load_manifest(paths.manifest)
    sync_log = load_sync_log(paths.sync_log)

    # Build a snapshot of all skills with their current hashes
    skills_state: dict[str, Any] = {}
    for sname in sorted(_vault_skill_names(paths)):
        skill_path = paths.skills / sname
        h = hash_directory(skill_path)
        manifest_entry = manifest.get("skills", {}).get(sname, {})
        skills_state[sname] = {
            "hash": h,
            "targets": manifest_entry.get("targets", []),
            "source": manifest_entry.get("source", ""),
            "file_count": sum(1 for f in skill_path.rglob("*") if f.is_file()),
        }

    snapshot = {
        "machine_id": machine_id,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "skill_count": len(skills_state),
        "skills": skills_state,
    }

    import json
    snap_file = snap_dir / f"{machine_id}.json"
    snap_file.write_text(
        json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    if not quiet:
        console.print(f"[green]✓[/] Snapshot saved: {snap_file.name} ({len(skills_state)} skills)")
    return snap_file


@cli.command()
def snapshot():
    """Save current vault state as a device snapshot.

    Creates snapshots/<machine-id>.json in the vault.
    Commit & push the vault repo so other devices can see it.
    """
    cfg, paths = require_config()
    _take_snapshot(cfg, paths)
    console.print("[dim]Commit and push your vault repo so other devices can see this snapshot.[/]")


@cli.command()
def devices():
    """List available device snapshots."""
    cfg, paths = require_config()
    snap_dir = _snapshots_dir(paths)

    if not snap_dir.exists():
        console.print("[yellow]No snapshots found.[/] Run [bold]sv snapshot[/] to create one.")
        return

    import json
    current_machine = cfg.get("machine_id", "")

    table = Table(title="Device Snapshots")
    table.add_column("Device", style="bold")
    table.add_column("Skills", justify="right")
    table.add_column("Last Updated")
    table.add_column("", style="dim")

    for snap_file in sorted(snap_dir.glob("*.json")):
        try:
            data = json.loads(snap_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue

        machine = data.get("machine_id", snap_file.stem)
        ts = data.get("timestamp", "unknown")
        # Format timestamp nicely
        try:
            import datetime
            dt = datetime.datetime.fromisoformat(ts)
            ts_display = dt.strftime("%Y-%m-%d %H:%M")
        except Exception:
            ts_display = ts

        count = data.get("skill_count", 0)
        marker = "← you" if machine == current_machine else ""
        table.add_row(machine, str(count), ts_display, marker)

    console.print(table)
    console.print(f"\n[dim]Current device: {current_machine}[/]")


@cli.command(name="sync-from")
@click.argument("device_name")
@click.option("--dry-run", is_flag=True, help="Show differences without changing anything")
@click.option("--overwrite", is_flag=True, help="Overwrite local state without interactive picking")
def sync_from(device_name: str, dry_run: bool, overwrite: bool):
    """Compare another device's snapshot to local and sync selected skills.

    Pull the vault repo first so you have the latest snapshots.

    Examples:
      sv sync-from MY-DESKTOP
      sv sync-from MY-DESKTOP --dry-run
      sv sync-from MY-DESKTOP --overwrite
    """
    import json
    import questionary

    cfg, paths = require_config()
    snap_dir = _snapshots_dir(paths)
    current_machine = cfg.get("machine_id", "")

    # Find the remote snapshot
    snap_file = snap_dir / f"{device_name}.json"
    if not snap_file.exists():
        # Try case-insensitive match
        for f in snap_dir.glob("*.json"):
            if f.stem.lower() == device_name.lower():
                snap_file = f
                break
        else:
            console.print(f"[red]No snapshot found for '{device_name}'.[/]")
            console.print("[dim]Available devices:[/]")
            for f in snap_dir.glob("*.json"):
                console.print(f"  {f.stem}")
            raise SystemExit(1)

    remote = json.loads(snap_file.read_text(encoding="utf-8"))
    remote_skills = remote.get("skills", {})

    # Build local state for comparison
    manifest = load_manifest(paths.manifest)
    local_skills: dict[str, dict[str, Any]] = {}
    for sname in _vault_skill_names(paths):
        h = hash_directory(paths.skills / sname)
        entry = manifest.get("skills", {}).get(sname, {})
        local_skills[sname] = {
            "hash": h,
            "targets": entry.get("targets", []),
        }

    # Categorize differences
    only_remote: list[str] = []
    only_local: list[str] = []
    different: list[str] = []
    same: list[str] = []

    all_names = sorted(set(remote_skills.keys()) | set(local_skills.keys()))
    for name in all_names:
        in_remote = name in remote_skills
        in_local = name in local_skills
        if in_remote and not in_local:
            only_remote.append(name)
        elif in_local and not in_remote:
            only_local.append(name)
        elif in_remote and in_local:
            if remote_skills[name].get("hash") != local_skills[name].get("hash"):
                different.append(name)
            else:
                same.append(name)

    # Display comparison
    remote_id = remote.get("machine_id", device_name)
    console.print(f"\n[bold]Comparing [cyan]{current_machine}[/] (local) vs [magenta]{remote_id}[/] (remote)[/]\n")

    if same:
        console.print(f"[green]✓ {len(same)} skill(s) identical[/]")
    if only_local:
        console.print(f"[blue]+ {len(only_local)} only on {current_machine}:[/]")
        for n in only_local:
            console.print(f"    {n}")
    if only_remote:
        console.print(f"[magenta]+ {len(only_remote)} only on {remote_id}:[/]")
        for n in only_remote:
            console.print(f"    {n}")
    if different:
        console.print(f"[yellow]↻ {len(different)} differ between devices:[/]")
        for n in different:
            r_files = remote_skills[n].get("file_count", "?")
            l_path = paths.skills / n
            l_files = sum(1 for f in l_path.rglob("*") if f.is_file()) if l_path.exists() else "?"
            console.print(f"    {n}  [dim](local: {l_files} files, remote: {r_files} files)[/]")

    if not only_remote and not different:
        console.print("\n[green]Nothing to sync — local is up to date.[/]")
        return

    if dry_run:
        console.print(f"\n[dim](dry run — no changes made)[/]")
        return

    # Build actionable choices
    # Skills only on remote → can adopt (they exist in vault already if repo is pulled)
    # Skills that differ → can overwrite local with remote version
    syncable = only_remote + different
    if not syncable:
        return

    if overwrite:
        to_sync = syncable
        console.print(f"\n[bold]Overwriting {len(to_sync)} skill(s) from {remote_id}...[/]")
    else:
        # Interactive picker
        sections: dict[str, list[str]] = {}
        if only_remote:
            sections[f"Only on {remote_id} (will be added)"] = only_remote
        if different:
            sections[f"Different (will overwrite local)"] = different

        to_sync = _sectioned_checkbox(
            f"Select skills to sync from {remote_id}:",
            sections,
            title_fn=lambda n: f"{n}  ({remote_skills.get(n, {}).get('file_count', '?')} files)",
        )

        if not to_sync:
            console.print("[dim]Nothing selected.[/]")
            return

    # Apply changes
    # The actual skill files should already be in the vault repo (git pulled).
    # We just need to update the manifest to match the remote's target config.
    updated = 0
    for sname in to_sync:
        remote_entry = remote_skills.get(sname, {})
        skill_path = paths.skills / sname

        if not skill_path.exists():
            console.print(f"  [yellow]⚠ {sname}[/] — files not in vault (git pull the vault repo first)")
            continue

        # Update manifest targets to match remote
        manifest.setdefault("skills", {})[sname] = {
            "targets": remote_entry.get("targets", []),
            "source": remote_entry.get("source", f"synced from {remote_id}"),
        }
        console.print(f"  [green]✓[/] {sname} → targets: {', '.join(remote_entry.get('targets', []))}")
        updated += 1

    save_manifest(manifest, paths.manifest)
    console.print(f"\n[bold green]Synced {updated} skill(s) from {remote_id}.[/] Run [bold]sv push[/] to apply.")


# ── WATCH ────────────────────────────────────────────────────


@cli.command()
@click.option("--interval", "-i", default=2.0, help="Poll interval in seconds")
def watch(interval: float):
    """Watch vault for changes and auto-push on modification."""
    cfg, paths = require_config()

    try:
        from watchdog.events import FileSystemEvent, FileSystemEventHandler
        from watchdog.observers import Observer
    except ImportError:
        console.print("[red]watchdog not installed.[/] Run: pip install watchdog")
        raise SystemExit(1)

    console.print(f"[cyan]Watching[/] {paths.skills}")
    console.print("[dim]Press Ctrl+C to stop.[/]\n")

    class Handler(FileSystemEventHandler):
        def __init__(self) -> None:
            self._last_push = 0.0

        def on_any_event(self, event: FileSystemEvent) -> None:
            now = time.time()
            if now - self._last_push < interval:
                return
            self._last_push = now
            console.print(f"[yellow]Change detected:[/] {event.src_path}")
            try:
                ctx = click.Context(push, info_name="push")
                ctx.invoke(push, skill_names=(), target=(), force=False, force_copy=False, dry_run=False, interactive=False)
            except Exception as e:
                console.print(f"[red]Push error:[/] {e}")

    observer = Observer()
    observer.schedule(Handler(), str(paths.skills), recursive=True)
    observer.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
        console.print("\n[dim]Stopped watching.[/]")
    observer.join()


# ── PACKAGE ──────────────────────────────────────────────────


@cli.command()
@click.argument("skill_name")
@click.option("--target", "-t", required=True, help="Target format (claude, openclaw, perplexity, etc.)")
@click.option("--output", "-o", type=click.Path(), help="Output directory (default: current dir)")
def package(skill_name: str, target: str, output: str | None):
    """Package a single vault skill for a specific target format."""
    cfg, paths = require_config()
    src = paths.skills / skill_name

    if not src.exists():
        console.print(f"[red]Skill '{skill_name}' not found in vault.[/]")
        raise SystemExit(1)

    out_dir = Path(output).resolve() if output else Path.cwd()
    _ensure_dir(out_dir)

    if target == "perplexity":
        result = convert_for_perplexity(src, skill_name, out_dir)
        console.print(f"[green]✓[/] Packaged for perplexity → {result}")
    else:
        dest = out_dir / skill_name
        converter = get_converter(target)
        converter(src, dest)
        fmt = "built-in" if target in CONVERTERS else "generic"
        console.print(f"[green]✓[/] Packaged for {target} → {dest} [dim]({fmt} format)[/]")


# ── IMPORT (alias for add, from a specific agent) ───────────


@cli.command(name="import")
@click.argument("skill_name")
@click.option("--from", "from_target", required=True, help="Agent to import from")
def import_skill(skill_name: str, from_target: str):
    """Import a skill from an agent directory into the vault (alias for pull)."""
    ctx = click.get_current_context()
    ctx.invoke(pull, skill_name=skill_name, from_target=from_target, overwrite=False)


# ── APP (web dashboard) ───────────────────────────────────────


# The `sv app` command and its GUI bundling have been removed. The web
# UI is now shipped as an independent npm package, `skill-vault-app`,
# which shares only the on-disk vault format with this CLI (see
# docs/vault-format.md). Install it with `npx skill-vault-app`.


# ── PROVIDER (manage providers) ───────────────────────────────


@cli.group()
def provider():
    """Manage providers (agent tool directories) for skill syncing.

    Examples:
      sv provider list
      sv provider add gemini
      sv provider add my-tool --path ~/my-tool/skills
      sv provider remove gemini
    """
    pass


@provider.command(name="list")
def provider_list():
    """List all configured providers and their status."""
    cfg, paths = require_config()
    agent_locs = cfg.get("agent_locations", {})
    default_targets = cfg.get("default_targets", [])

    if not agent_locs:
        console.print("[yellow]No providers configured. Run [bold]sv provider add[/] or [bold]sv init[/].[/]")
        return

    table = Table(show_header=True, header_style="bold")
    table.add_column("Provider", style="cyan", no_wrap=True)
    table.add_column("Path")
    table.add_column("Status")
    table.add_column("Converter")
    table.add_column("Default", justify="center")

    for name, path_str in sorted(agent_locs.items()):
        p = Path(path_str).expanduser()
        if p.exists():
            skill_count = sum(1 for d in p.iterdir() if d.is_dir() and not d.name.startswith("."))
            status = f"[green]✓ {skill_count} skill(s)[/]"
        elif p.parent.exists():
            status = "[yellow]parent exists[/]"
        else:
            status = "[red]not found[/]"

        conv_type = "built-in" if name in CONVERTERS else "generic"
        is_default = "✓" if name in default_targets else ""

        table.add_row(name, str(p), status, conv_type, is_default)

    console.print(table)
    console.print(f"\n[dim]{len(agent_locs)} provider(s) configured[/]")


@provider.command(name="add")
@click.argument("name")
@click.option("--path", "-p", "custom_path", default=None, help="Path to the provider's skills directory")
def provider_add(name: str, custom_path: str | None):
    """Add a new provider for skill syncing.

    If no --path is given, defaults to ~/.<name>/skills and confirms interactively.

    Examples:
      sv provider add gemini
      sv provider add my-tool --path /opt/my-tool/skills
      sv provider add aider --path ~/.aider/skills
    """
    cfg, paths = require_config()
    agent_locs = cfg.get("agent_locations", {})

    if name in agent_locs:
        console.print(f"[yellow]Provider '{name}' already configured at {agent_locs[name]}[/]")
        console.print(f"[dim]Use [bold]sv provider remove {name}[/] first to reconfigure.[/]")
        return

    if custom_path:
        skills_path = str(Path(custom_path).expanduser().resolve())
    else:
        # Auto-suggest ~/.<name>/skills
        suggested = Path.home() / f".{name}" / "skills"
        import questionary

        skills_path = questionary.path(
            f"Skills directory for '{name}':",
            default=str(suggested),
            only_directories=True,
        ).ask()

        if not skills_path:
            console.print("[dim]Cancelled.[/]")
            return

        skills_path = str(Path(skills_path).expanduser().resolve())

    # Add to config
    agent_locs[name] = skills_path
    cfg["agent_locations"] = agent_locs

    # Also add to default_targets
    default_targets = cfg.get("default_targets", [])
    if name not in default_targets:
        default_targets.append(name)
        cfg["default_targets"] = default_targets

    save_config(cfg)

    p = Path(skills_path)
    if p.exists():
        console.print(f"[green]✓[/] Added provider [bold]{name}[/] → {skills_path}")
    elif p.parent.exists():
        console.print(f"[green]✓[/] Added provider [bold]{name}[/] → {skills_path} [dim](dir will be created on first push)[/]")
    else:
        console.print(f"[green]✓[/] Added provider [bold]{name}[/] → {skills_path} [yellow](path does not exist yet)[/]")

    console.print(f"[dim]Skills will use generic agentskills.io format for conversion.[/]")
    console.print(f"[dim]Run [bold]sv discover[/] to scan, or [bold]sv push[/] to sync skills out.[/]")


@provider.command(name="remove")
@click.argument("name")
def provider_remove(name: str):
    """Remove a provider from the configuration.

    This does NOT delete any skill files — it only removes the provider
    from the config so it's no longer synced to.
    """
    cfg, paths = require_config()
    agent_locs = cfg.get("agent_locations", {})

    if name not in agent_locs:
        console.print(f"[red]Provider '{name}' not found in config.[/]")
        available = ", ".join(sorted(agent_locs.keys()))
        if available:
            console.print(f"[dim]Configured: {available}[/]")
        return

    del agent_locs[name]
    cfg["agent_locations"] = agent_locs

    # Remove from default_targets too
    default_targets = cfg.get("default_targets", [])
    if name in default_targets:
        default_targets.remove(name)
        cfg["default_targets"] = default_targets

    save_config(cfg)
    console.print(f"[green]✓[/] Removed provider [bold]{name}[/]")
    console.print(f"[dim]Skill files in that directory were not deleted.[/]")


# ── PROMOTE (staging → production) ───────────────────────────


@cli.command()
@click.argument("skill_name", required=False, default=None)
@click.option("--push", "do_push", is_flag=True, help="Also push to targets after promoting")
def promote(skill_name: str | None, do_push: bool):
    """Move skill(s) from staging to the vault (production).

    If no SKILL_NAME given, shows an interactive picker of all staging skills.
    """
    import questionary

    cfg, paths = require_config()
    _rule("Promote")

    # Interactive mode: no skill_name → pick from staging
    if skill_name is None:
        if not paths.staging.exists():
            console.print(f"  {ICON['warn']} [yellow]No staging directory.[/]")
            return
        staging_names = sorted(
            d.name for d in paths.staging.iterdir()
            if d.is_dir() and not d.name.startswith(".")
        )
        if not staging_names:
            console.print(f"  {ICON['ok']} Staging is empty — nothing to promote.")
            return

        manifest = load_manifest(paths.manifest)
        sections: dict[str, list[str]] = {"Staging": staging_names}
        selected: list[str] = _sectioned_checkbox(
            "Select skill(s) to promote to production:",
            sections,
            title_fn=lambda s: f"{s:<30} {manifest.get('skills', {}).get(s, {}).get('source', '')}",
            checked_fn=lambda s: True,
        )
        if not selected:
            console.print("[dim]Nothing selected.[/]")
            return

        for sname in selected:
            _promote_one(sname, paths, do_push)
        return

    _promote_one(skill_name, paths, do_push)


def _promote_one(skill_name: str, paths: ResolvedPaths, do_push: bool) -> None:
    """Promote a single skill from staging to production."""
    import questionary

    staging_dir = paths.staging / skill_name
    if not staging_dir.exists():
        if (paths.skills / skill_name).exists():
            console.print(f"  {ICON['warn']} [yellow]'{skill_name}' is already in production.[/]")
        else:
            console.print(f"  {ICON['err']} [red]'{skill_name}' not found in staging.[/]")
        return

    dest = paths.skills / skill_name
    if dest.exists():
        if not questionary.confirm(
            f"'{skill_name}' already exists in production. Overwrite?", default=False
        ).ask():
            console.print(f"  [dim]Skipped {skill_name}.[/]")
            return
        shutil.rmtree(dest)

    _ensure_dir(paths.skills)
    shutil.move(str(staging_dir), str(dest))

    manifest = load_manifest(paths.manifest)
    skill_entry = manifest.get("skills", {}).get(skill_name, {})
    skill_entry["stage"] = "production"
    manifest.setdefault("skills", {})[skill_name] = skill_entry
    save_manifest(manifest, paths.manifest)

    sync_log = load_sync_log(paths.sync_log)
    h = hash_directory(dest)
    if h:
        sync_log[skill_name] = h
    save_sync_log(sync_log, paths.sync_log)

    console.print(f"  {ICON['ok']} Promoted [bold]{skill_name}[/] → production")

    if do_push:
        targets = skill_entry.get("targets", [])
        if targets:
            ctx = click.get_current_context()
            ctx.invoke(push, skill_names=(skill_name,))
        else:
            _suggest(f"No targets configured. Use [bold]sv share {skill_name} --with <provider>[/] first")


# ── DEMOTE (production → staging) ────────────────────────────


@cli.command()
@click.argument("skill_name", required=False, default=None)
def demote(skill_name: str | None):
    """Move skill(s) from the vault (production) back to staging.

    If no SKILL_NAME given, shows an interactive picker of production skills.
    """
    import questionary

    cfg, paths = require_config()
    _rule("Demote")

    # Interactive mode: no skill_name → pick from production skills
    if skill_name is None:
        vault_names = sorted(_vault_skill_names(paths))
        if not vault_names:
            console.print(f"  {ICON['warn']} [yellow]No production skills to demote.[/]")
            return

        manifest = load_manifest(paths.manifest)
        sections: dict[str, list[str]] = {}
        uncategorised: list[str] = []
        for sname in vault_names:
            targets = manifest.get("skills", {}).get(sname, {}).get("targets", [])
            if targets:
                for t in targets:
                    sections.setdefault(t, []).append(sname)
            else:
                uncategorised.append(sname)

        # Deduplicate across sections
        seen: set[str] = set()
        deduped: dict[str, list[str]] = {}
        for label in sorted(sections):
            for sname in sections[label]:
                if sname not in seen:
                    deduped.setdefault(label, []).append(sname)
                    seen.add(sname)
        if uncategorised:
            for sname in uncategorised:
                if sname not in seen:
                    deduped.setdefault("uncategorised", []).append(sname)
                    seen.add(sname)

        selected: list[str] = _sectioned_checkbox(
            "Select skill(s) to demote to staging:",
            deduped,
            title_fn=lambda s: s,
        )
        if not selected:
            console.print("[dim]Nothing selected.[/]")
            return

        console.print(f"\n  [bold yellow]Will demote {len(selected)} skill(s) to staging:[/]")
        for s in selected:
            console.print(f"    {s}")
        if not questionary.confirm("Proceed?", default=False).ask():
            console.print("[dim]Cancelled.[/]")
            return

        for sname in selected:
            _demote_one(sname, paths)
        return

    _demote_one(skill_name, paths)


def _demote_one(skill_name: str, paths: ResolvedPaths) -> None:
    """Demote a single skill from production to staging."""
    src = paths.skills / skill_name
    if not src.exists():
        if (paths.staging / skill_name).exists():
            console.print(f"  {ICON['warn']} [yellow]'{skill_name}' is already in staging.[/]")
        else:
            console.print(f"  {ICON['err']} [red]'{skill_name}' not found in vault.[/]")
        return

    dest = paths.staging / skill_name
    _ensure_dir(paths.staging)
    if dest.exists():
        shutil.rmtree(dest)
    shutil.move(str(src), str(dest))

    # Remove from agent targets
    manifest = load_manifest(paths.manifest)
    skill_entry = manifest.get("skills", {}).get(skill_name, {})
    old_targets = skill_entry.get("targets", [])
    for tname in old_targets:
        tp = paths.target_dir(tname) / skill_name
        if tp.exists() or tp.is_symlink():
            unlink_or_remove(tp)
            console.print(f"    Removed from {tname}")

    skill_entry["stage"] = "staging"
    skill_entry["targets"] = []
    manifest.setdefault("skills", {})[skill_name] = skill_entry
    save_manifest(manifest, paths.manifest)

    sync_log = load_sync_log(paths.sync_log)
    sync_log.pop(skill_name, None)
    save_sync_log(sync_log, paths.sync_log)

    console.print(f"  {ICON['ok']} Demoted [bold]{skill_name}[/] → staging")


# ── QUICK (guided all-in-one workflow) ───────────────────────


@cli.command()
@click.pass_context
def quick(ctx):
    """Guided sync workflow — discover, adopt, push in one step."""
    import questionary

    cfg, paths = require_config()
    _rule("Quick Sync")

    console.print("  Scanning agents and vault...")

    # Detect what needs doing
    manifest = load_manifest(paths.manifest)
    sync_log = load_sync_log(paths.sync_log)
    vault_skills = _vault_skill_names(paths)

    agent_locs = {
        k: Path(v).expanduser().resolve()
        for k, v in cfg.get("agent_locations", {}).items()
    }

    # 1. Check for new skills in agents
    new_skills: list[DiscoveredSkill] = []
    if agent_locs:
        from skill_vault.discovery import scan_all_agents
        results = scan_all_agents(agent_locs, vault_skills)
        for tool_name, skills in results.items():
            for s in skills:
                if not s.in_vault:
                    new_skills.append(s)

    # 2. Check for stale pushes
    stale_skills: list[str] = []
    for sname, sinfo in manifest.get("skills", {}).items():
        if sinfo.get("stage") == "staging":
            continue
        src = paths.skills / sname
        if src.exists():
            current_hash = hash_directory(src)
            old_hash = sync_log.get(sname)
            if current_hash and current_hash != old_hash and sinfo.get("targets"):
                stale_skills.append(sname)

    # 3. Check staging
    staging_skills: list[str] = []
    if paths.staging.exists():
        staging_skills = [
            d.name for d in paths.staging.iterdir()
            if d.is_dir() and not d.name.startswith(".")
        ]

    if not new_skills and not stale_skills and not staging_skills:
        console.print(f"\n  {ICON['ok']} Everything is up to date!")
        return

    # Build action menu
    actions: list[tuple[str, str]] = []
    if new_skills:
        actions.append((f"Adopt {len(new_skills)} new skill(s) → vault", "adopt"))
    if stale_skills:
        actions.append((f"Push {len(stale_skills)} stale skill(s) → agents", "push"))
    if staging_skills:
        actions.append((f"Promote {len(staging_skills)} staging skill(s) → vault", "promote-all"))
    actions.append(("Do everything", "all"))

    console.print(f"\n  Found:")
    if new_skills:
        console.print(f"    [white bold]{len(new_skills)}[/] new skills across agents")
    if stale_skills:
        console.print(f"    [yellow]{len(stale_skills)}[/] stale pushes")
    if staging_skills:
        console.print(f"    [blue]{len(staging_skills)}[/] staging skills ready to promote")

    chosen = questionary.select(
        "\nWhat would you like to do?",
        choices=[questionary.Choice(title=label, value=cmd) for label, cmd in actions],
    ).ask()

    if not chosen:
        console.print("[dim]Cancelled.[/]")
        return

    if chosen in ("adopt", "all"):
        console.print()
        ctx.invoke(adopt, from_target=None, yes=True)

    if chosen in ("push", "all"):
        console.print()
        ctx.invoke(push, skill_names=tuple(stale_skills) if chosen == "push" else ())

    if chosen in ("promote-all", "all") and staging_skills:
        for sname in staging_skills:
            console.print()
            ctx.invoke(promote, skill_name=sname, do_push=False)

    console.print(f"\n  {ICON['ok']} [bold]Quick sync complete.[/]")


# ── SYNC (smart two-way sync) ────────────────────────────────


@cli.command()
@click.option("--dry-run", is_flag=True, help="Show what would be synced without doing it")
@click.pass_context
def sync(ctx, dry_run: bool):
    """Smart two-way sync — detects changes everywhere and proposes a plan."""
    import questionary

    cfg, paths = require_config()
    _rule("Smart Sync")

    console.print("  Analysing vault, agents, and staging...")

    manifest = load_manifest(paths.manifest)
    sync_log = load_sync_log(paths.sync_log)
    vault_skills = _vault_skill_names(paths)

    agent_locs = {
        k: Path(v).expanduser().resolve()
        for k, v in cfg.get("agent_locations", {}).items()
    }

    plan: list[tuple[str, str, str]] = []  # (action_label, direction_icon, detail)

    # Check agents for new skills to pull
    if agent_locs:
        from skill_vault.discovery import scan_all_agents
        results = scan_all_agents(agent_locs, vault_skills)
        for tool_name, skills in results.items():
            for s in skills:
                if not s.in_vault:
                    plan.append(("adopt", "←", f"{s.name} [dim]from {tool_name}[/]"))

    # Check vault for stale pushes
    for sname, sinfo in manifest.get("skills", {}).items():
        if sinfo.get("stage") == "staging":
            continue
        src = paths.skills / sname
        if src.exists():
            current_hash = hash_directory(src)
            old_hash = sync_log.get(sname)
            if current_hash and current_hash != old_hash and sinfo.get("targets"):
                targets = ", ".join(sinfo.get("targets", []))
                plan.append(("push", "→", f"{sname} [dim]to {targets}[/]"))

    # Check staging for promotable skills
    if paths.staging.exists():
        for d in paths.staging.iterdir():
            if d.is_dir() and not d.name.startswith("."):
                plan.append(("promote", "↑", f"{d.name} [dim]from staging[/]"))

    if not plan:
        console.print(f"\n  {ICON['ok']} Everything is in sync!")
        return

    # Show plan
    console.print(f"\n  [bold]Sync plan ({len(plan)} actions):[/]\n")
    for action, icon, detail in plan:
        color = {"adopt": "white", "push": "yellow", "promote": "blue"}.get(action, "dim")
        console.print(f"    [{color}]{icon}[/] {detail}")

    if dry_run:
        console.print(f"\n  [dim]Dry run — no changes made.[/]")
        return

    if not questionary.confirm(f"\nExecute {len(plan)} action(s)?", default=True).ask():
        console.print("[dim]Cancelled.[/]")
        return

    # Execute
    adopt_needed = any(a == "adopt" for a, _, _ in plan)
    push_needed = any(a == "push" for a, _, _ in plan)
    promote_needed = [detail.split()[0] for a, _, detail in plan if a == "promote"]

    if adopt_needed:
        ctx.invoke(adopt, from_target=None, yes=True)
    if push_needed:
        ctx.invoke(push, skill_names=())
    for sname in promote_needed:
        ctx.invoke(promote, skill_name=sname, do_push=False)

    console.print(f"\n  {ICON['ok']} [bold]Sync complete.[/]")


# ── Entry point ──────────────────────────────────────────────

if __name__ == "__main__":
    cli()
