"""Update-from-source: re-check adopted skills against their recorded origins.

Skills adopted with a structured ``origin`` block in the manifest (see
docs/vault-format.md § SkillEntry.origin) can be compared against their
source — a provider directory, a local repo checkout, or a remote git URL —
and overwritten with the upstream content when it changed.

The check is a three-way hash comparison using the normalized content hash
from :mod:`skill_vault.hashing` (mirrored by the app's
``hashSkillDirNormalized``):

    recorded = origin.content_hash   (vault copy when last adopted/updated)
    vault    = hash of the vault copy now
    upstream = hash of the source copy now

    upstream == vault      → up_to_date
    vault == recorded      → update_available   (safe to pull)
    upstream == recorded   → local_changed      (nothing to pull)
    all three differ       → conflict           (pulling overwrites local edits)
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from skill_vault.hashing import hash_directory

# Junk dirs skipped when copying and when searching for a moved skill.
_IGNORE_COPY = shutil.ignore_patterns(
    "node_modules", "__pycache__", ".git", "*.tmp",
    "Thumbs.db", ".DS_Store", ".temp-*",
)
_IGNORE_WALK = {
    "node_modules", "__pycache__", ".git", "dist", ".next", ".turbo",
    ".venv", "venv", "build", "target", "bin", "obj", ".idea", ".vscode",
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def rmtree_force(p: Path) -> None:
    """rmtree that clears the read-only bit and retries — git object files
    are read-only on Windows and plain rmtree leaves them behind."""

    def _onexc(func: Any, path: str, _exc: Any) -> None:
        try:
            os.chmod(path, stat.S_IWRITE)
            func(path)
        except OSError:
            pass

    if p.exists():
        try:
            shutil.rmtree(p, onexc=_onexc)  # py3.12+
        except TypeError:
            shutil.rmtree(p, onerror=lambda f, pth, e: _onexc(f, pth, e))


# ── Origin construction ──────────────────────────────────────


def find_git_root(p: Path) -> Path | None:
    """Nearest ancestor (including *p*) containing a .git entry."""
    cur = p.resolve()
    for candidate in (cur, *cur.parents):
        if (candidate / ".git").exists():
            return candidate
    return None


def local_dir_root(skill_path: Path, fallback_root: Path | None = None) -> tuple[Path, str]:
    """Pick the source root + subpath to record for a local-directory origin.

    Prefer the enclosing git checkout (so update checks can ``git pull``),
    else the provided scan root, else the skill folder itself.
    """
    git_root = find_git_root(skill_path)
    root = git_root or fallback_root or skill_path
    try:
        subpath = skill_path.resolve().relative_to(Path(root).resolve()).as_posix()
    except ValueError:
        root, subpath = skill_path, ""
    if str(subpath) == ".":
        subpath = ""
    return Path(root), subpath


def build_origin(
    origin_type: str,
    *,
    vault_skill_dir: Path,
    url: str | None = None,
    path: Path | str | None = None,
    provider_id: str | None = None,
    subpath: str = "",
    ref: str | None = None,
) -> dict[str, Any]:
    """Origin block per docs/vault-format.md. ``content_hash`` is taken from
    the vault DESTINATION (junk files are stripped during copy, so hashing
    the source would differ)."""
    origin: dict[str, Any] = {"type": origin_type}
    if url:
        origin["url"] = url
    if path is not None:
        origin["path"] = str(path)
    if provider_id:
        origin["provider_id"] = provider_id
    origin["subpath"] = subpath
    if ref:
        origin["ref"] = ref
    origin["adopted_at"] = utc_now_iso()
    origin["content_hash"] = hash_directory(vault_skill_dir) or "empty"
    return origin


def refresh_origin(origin: dict[str, Any], vault_skill_dir: Path, subpath: str | None = None) -> dict[str, Any]:
    """Copy of *origin* with content_hash/adopted_at (and optionally subpath)
    refreshed. Unknown keys inside the origin round-trip untouched."""
    new = dict(origin)
    if subpath is not None:
        new["subpath"] = subpath
    new["adopted_at"] = utc_now_iso()
    new["content_hash"] = hash_directory(vault_skill_dir) or "empty"
    return new


# ── Checking ─────────────────────────────────────────────────


@dataclass
class UpdateCheck:
    name: str
    status: str  # up_to_date | update_available | local_changed | conflict |
    #              no_origin | source_missing | upstream_missing | error
    origin: dict[str, Any] | None = None
    vault_hash: str | None = None
    upstream_hash: str | None = None
    recorded_hash: str | None = None
    upstream_path: Path | None = None
    tmp_root: Path | None = None
    git_pulled: bool | None = None
    message: str = ""


def _git_pull(repo: Path) -> tuple[bool, str]:
    """Best-effort ``git pull --ff-only``. Never raises."""
    try:
        r = subprocess.run(
            ["git", "-C", str(repo), "pull", "--ff-only"],
            capture_output=True, text=True, timeout=60,
        )
        if r.returncode == 0:
            return True, ""
        detail = (r.stderr or r.stdout or "").strip().splitlines()
        return False, f"git pull failed — compared without pull ({detail[0] if detail else 'unknown'})"
    except FileNotFoundError:
        return False, "git not found — compared without pull"
    except subprocess.TimeoutExpired:
        return False, "git pull timed out — compared without pull"


def _shallow_clone(url: str, ref: str | None) -> Path:
    """Depth-1 clone into a temp dir. Raises RuntimeError with git's stderr."""
    clone_dir = Path(tempfile.mkdtemp(prefix="sv-update-"))
    cmd = ["git", "clone", "--depth", "1"]
    if ref:
        cmd.extend(["--branch", ref])
    cmd.extend([url, str(clone_dir)])
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=120)
    except FileNotFoundError:
        rmtree_force(clone_dir)
        raise RuntimeError("git not found — cannot check remote origins")
    except subprocess.CalledProcessError as e:
        rmtree_force(clone_dir)
        raise RuntimeError(f"clone failed: {(e.stderr or '').strip()}")
    except subprocess.TimeoutExpired:
        rmtree_force(clone_dir)
        raise RuntimeError(f"clone timed out for {url}")
    return clone_dir


def _recover_moved(root: Path, name: str) -> Path | None:
    """Find the single dir named *name* containing SKILL.md under *root*, or
    None when there are zero or several candidates."""
    matches: list[Path] = []

    def walk(d: Path, depth: int) -> None:
        if depth > 12 or len(matches) > 1:
            return
        try:
            entries = list(d.iterdir())
        except OSError:
            return
        for e in entries:
            if not e.is_dir() or e.name.startswith(".") or e.name in _IGNORE_WALK:
                continue
            if e.name == name and (e / "SKILL.md").exists():
                matches.append(e)
                if len(matches) > 1:
                    return
            walk(e, depth + 1)

    walk(root, 0)
    return matches[0] if len(matches) == 1 else None


def _source_key(origin: dict[str, Any]) -> str:
    if origin.get("type") == "git" and not origin.get("path"):
        return f"git\0{origin.get('url', '')}\0{origin.get('ref', '')}"
    return f"{origin.get('type')}\0{origin.get('path', '')}"


def _vault_dir_for(paths: Any, name: str) -> Path:
    """The skill's canonical dir — skills/ normally, staging/ for staged
    imports that haven't been promoted yet."""
    primary = paths.skills / name
    if primary.exists():
        return primary
    staged = paths.staging / name
    return staged if staged.exists() else primary


def check_updates(
    manifest: dict[str, Any],
    paths: Any,
    names: list[str] | None = None,
) -> list[UpdateCheck]:
    """Check the given skills (or every skill with an origin). Read-only:
    the vault and manifest are never written. Each distinct source is
    pulled/cloned at most once. Temp clones are left alive so the caller
    can apply updates from them — clean up every ``tmp_root`` afterwards
    with :func:`rmtree_force`."""
    skills_map: dict[str, Any] = manifest.get("skills", {}) or {}
    if names:
        targets = [(n, (skills_map.get(n) or {}).get("origin")) for n in names]
    else:
        targets = [(n, e.get("origin")) for n, e in skills_map.items() if isinstance(e, dict) and e.get("origin")]

    # Resolve each distinct source once.
    resolved: dict[str, dict[str, Any]] = {}
    for _, origin in targets:
        if not origin:
            continue
        key = _source_key(origin)
        if key in resolved:
            continue
        src: dict[str, Any] = {"root": None, "tmp_root": None, "git_pulled": None, "message": "", "fatal": ""}
        if origin.get("type") == "git" and not origin.get("path"):
            url = origin.get("url")
            if not url:
                src["fatal"], src["message"] = "error", "origin has no url or path"
            else:
                try:
                    tmp = _shallow_clone(url, origin.get("ref"))
                    src["root"], src["tmp_root"] = tmp, tmp
                except RuntimeError as e:
                    src["fatal"], src["message"] = "error", str(e)
        else:
            root = Path(origin["path"]).expanduser() if origin.get("path") else None
            if not root or not root.is_dir():
                src["fatal"], src["message"] = "source_missing", f"source path missing: {root}"
            else:
                src["root"] = root
                if (root / ".git").exists():
                    ok, msg = _git_pull(root)
                    src["git_pulled"], src["message"] = ok, msg
        resolved[key] = src

    results: list[UpdateCheck] = []
    for name, origin in targets:
        if not origin:
            results.append(UpdateCheck(name=name, status="no_origin"))
            continue
        src = resolved[_source_key(origin)]
        base = UpdateCheck(
            name=name,
            status="error",
            origin=origin,
            recorded_hash=origin.get("content_hash"),
            tmp_root=src["tmp_root"],
            git_pulled=src["git_pulled"],
            message=src["message"],
        )
        if src["fatal"] or src["root"] is None:
            base.status = src["fatal"] or "error"
            results.append(base)
            continue

        root: Path = src["root"]
        subpath = origin.get("subpath", "")
        upstream_dir = root / Path(subpath) if subpath else root
        if not upstream_dir.is_dir():
            recovered = _recover_moved(root, name)
            if recovered is None:
                base.status = "upstream_missing"
                results.append(base)
                continue
            upstream_dir = recovered
            moved = recovered.relative_to(root).as_posix()
            base.message = "; ".join(x for x in [base.message, f"moved to {moved}"] if x)

        upstream_hash = hash_directory(upstream_dir) or "empty"
        vault_dir = _vault_dir_for(paths, name)
        vault_hash = hash_directory(vault_dir)
        recorded = origin.get("content_hash", "")

        base.upstream_hash = upstream_hash
        base.upstream_path = upstream_dir
        base.vault_hash = vault_hash
        if vault_hash is None:
            base.status = "update_available"
            base.message = "; ".join(x for x in [base.message, "vault copy missing — update will restore it"] if x)
        elif upstream_hash == vault_hash:
            base.status = "up_to_date"
        elif vault_hash == recorded:
            base.status = "update_available"
        elif upstream_hash == recorded:
            base.status = "local_changed"
        else:
            base.status = "conflict"
        results.append(base)
    return results


def apply_update(check: UpdateCheck, paths: Any, entry: dict[str, Any]) -> None:
    """Overwrite the vault copy with the upstream copy and refresh the
    entry's origin (content_hash/adopted_at/subpath) in place."""
    if check.upstream_path is None or check.origin is None:
        raise ValueError(f"nothing to apply for {check.name}")
    dest = _vault_dir_for(paths, check.name)
    if dest.exists():
        rmtree_force(dest)
    shutil.copytree(check.upstream_path, dest, ignore=_IGNORE_COPY)

    subpath: str | None = None
    root = check.tmp_root or (Path(check.origin["path"]) if check.origin.get("path") else None)
    if root is not None:
        try:
            subpath = check.upstream_path.resolve().relative_to(Path(root).resolve()).as_posix()
        except ValueError:
            subpath = None
    entry["origin"] = refresh_origin(check.origin, dest, subpath=subpath)
