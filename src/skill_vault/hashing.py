"""Content hashing for conflict detection.

Text files are normalised before hashing so that whitespace-only
differences (trailing spaces, trailing newlines, CRLF vs LF) do
not produce different hashes.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

# Directories / files to skip when hashing
_SKIP = {"node_modules", "__pycache__", ".git", ".DS_Store", "Thumbs.db"}

# Extensions we treat as binary (hash raw bytes, no normalisation)
_BINARY_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
    ".zip", ".gz", ".tar", ".7z", ".rar",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".pptx",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".pyc", ".pyo", ".so", ".dll", ".exe",
    ".bin", ".dat", ".db", ".sqlite",
}


def _normalised_content(path: Path) -> bytes:
    """Return the content of *path* with whitespace normalised for text files.

    - Text files: strip trailing whitespace from each line, strip trailing
      blank lines, normalise line endings to ``\n``.
    - Binary files: return raw bytes unchanged.
    """
    if path.suffix.lower() in _BINARY_EXTS:
        return path.read_bytes()

    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except (UnicodeDecodeError, ValueError):
        # Fall back to raw bytes for anything we can't read as text
        return path.read_bytes()

    # Strip trailing whitespace per line, normalise line endings, strip
    # trailing blank lines.
    lines = [line.rstrip() for line in text.splitlines()]
    normalised = "\n".join(lines).rstrip("\n")
    return normalised.encode("utf-8")


def hash_file(path: Path) -> str:
    """SHA-256 of a single file with whitespace normalisation."""
    return hashlib.sha256(_normalised_content(path)).hexdigest()


def hash_directory(directory: Path) -> str | None:
    """Compute a deterministic SHA-256 of all files in a skill directory.

    Text files are whitespace-normalised so trailing newlines, trailing
    spaces, and CRLF vs LF differences are ignored.
    """
    if not directory.exists():
        return None
    hashes: list[str] = []
    for f in sorted(directory.rglob("*")):
        if f.is_file() and not any(part in _SKIP for part in f.parts):
            hashes.append(hash_file(f))
    if not hashes:
        return "empty"
    return hashlib.sha256("".join(hashes).encode()).hexdigest()
