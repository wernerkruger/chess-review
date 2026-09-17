"""Locate and open Stockfish."""
from __future__ import annotations

import os
import shutil
import stat
from typing import Optional

import chess.engine

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CANDIDATES = [
    os.environ.get("STOCKFISH_PATH", ""),
    os.path.join(APP_DIR, "..", "Engines", "sf"),
    os.path.join(APP_DIR, "Engines", "sf"),
    os.path.join(APP_DIR, "engines", "stockfish"),
    os.path.join(APP_DIR, "stockfish"),
    "/opt/homebrew/bin/stockfish",
    "/usr/local/bin/stockfish",
    "/usr/games/stockfish",
]

_override: Optional[str] = None


def set_engine_path(path: str) -> None:
    global _override
    _override = path or None


def find_engine() -> Optional[str]:
    if _override and os.path.isfile(_override):
        return os.path.abspath(_override)
    for p in CANDIDATES:
        if p and os.path.isfile(p):
            return os.path.abspath(p)
    w = shutil.which("stockfish")
    return w


def ensure_executable(path: str) -> None:
    try:
        mode = os.stat(path).st_mode
        if not mode & stat.S_IXUSR:
            os.chmod(path, mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    except OSError:
        pass


def open_engine(path: str, threads: int = 1, hash_mb: int = 128) -> chess.engine.SimpleEngine:
    ensure_executable(path)
    eng = chess.engine.SimpleEngine.popen_uci(path)
    opts = {}
    if "Threads" in eng.options:
        opts["Threads"] = max(1, threads)
    if "Hash" in eng.options:
        opts["Hash"] = max(16, hash_mb)
    if "UCI_ShowWDL" in eng.options:
        opts["UCI_ShowWDL"] = False
    if opts:
        eng.configure(opts)
    return eng


def engine_name(path: str) -> str:
    try:
        eng = chess.engine.SimpleEngine.popen_uci(path)
        name = eng.id.get("name", "unknown")
        eng.quit()
        return name
    except Exception as exc:  # noqa: BLE001
        return f"error: {exc}"
