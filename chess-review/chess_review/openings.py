"""ECO opening lookup (Lichess chess-openings data, keyed by FEN without counters)."""
from __future__ import annotations

import json
import os
from functools import lru_cache
from typing import Optional

import chess

DATA_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "eco.json")


@lru_cache(maxsize=1)
def _table() -> dict:
    try:
        with open(DATA_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def lookup_opening(board: chess.Board) -> Optional[tuple[str, str]]:
    key = " ".join(board.fen().split(" ")[:4])
    hit = _table().get(key)
    if hit:
        return hit[0], hit[1]
    return None
