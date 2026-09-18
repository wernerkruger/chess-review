"""Interactive ("play it out on the board") analysis.

This is deliberately separate from the review pipeline in analysis.py/jobs.py:
that pipeline analyses a whole game, move by move, as a background job. This
module answers two much smaller, synchronous questions for the game-viewer's
"analysis board" — what moves are legal from a position, and what does the
engine think of a position right now — so the UI can let you play your own
moves on top of a reviewed game and see the eval update live.

A single Stockfish process is kept warm and reused across requests (opening
one per click would add real latency); a lock serialises access to it since
python-chess's SimpleEngine is not safe to use concurrently.
"""
from __future__ import annotations

import threading
from typing import Optional

import chess
import chess.engine

from . import metrics as M
from .engine import find_engine, open_engine

_lock = threading.Lock()
_engine: Optional[chess.engine.SimpleEngine] = None
_engine_path: Optional[str] = None


def close_engine() -> None:
    """Called on app shutdown so we don't leave an orphaned engine process."""
    global _engine, _engine_path
    with _lock:
        if _engine is not None:
            try:
                _engine.quit()
            except Exception:  # noqa: BLE001
                pass
        _engine = None
        _engine_path = None


def _get_engine() -> Optional[chess.engine.SimpleEngine]:
    global _engine, _engine_path
    path = find_engine()
    if not path:
        return None
    if _engine is None or _engine_path != path:
        if _engine is not None:
            try:
                _engine.quit()
            except Exception:  # noqa: BLE001
                pass
        _engine = open_engine(path, threads=1, hash_mb=64)
        _engine_path = path
    return _engine


def _parse_fen(fen: str) -> chess.Board:
    try:
        return chess.Board(fen)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"bad FEN: {exc}") from None


def _result_reason(board: chess.Board) -> Optional[str]:
    if board.is_checkmate():
        return "checkmate"
    if board.is_stalemate():
        return "stalemate"
    if board.is_insufficient_material():
        return "insufficient_material"
    if board.can_claim_fifty_moves():
        return "fifty_moves"
    if board.can_claim_threefold_repetition():
        return "threefold_repetition"
    return None


def board_status(board: chess.Board) -> dict:
    legal = []
    for mv in board.legal_moves:
        legal.append({
            "uci": mv.uci(),
            "from": chess.square_name(mv.from_square),
            "to": chess.square_name(mv.to_square),
            "promotion": chess.piece_symbol(mv.promotion).upper() if mv.promotion else None,
            "san": board.san(mv),
        })
    return {
        "fen": board.fen(),
        "turn": "white" if board.turn == chess.WHITE else "black",
        "in_check": board.is_check(),
        "game_over": board.is_game_over(claim_draw=True),
        "result": _result_reason(board),
        "legal_moves": legal,
    }


def get_state(fen: str) -> dict:
    return board_status(_parse_fen(fen))


def evaluate(board: chess.Board, depth: int = 14) -> dict:
    """White-POV eval of `board`, in the same shape as a reviewed move's
    eval_white/mate_after/best_uci/best_san/pv fields so the front end can
    reuse its existing render functions."""
    global _engine
    if board.is_checkmate():
        # side to move has no moves and is in check -> the other side won
        eval_white = -M.MATE_CP if board.turn == chess.WHITE else M.MATE_CP
        return {"eval_white": eval_white, "mate_after": 0, "best_uci": None, "best_san": None, "pv": []}
    if board.is_game_over(claim_draw=True):
        return {"eval_white": 0.0, "mate_after": None, "best_uci": None, "best_san": None, "pv": []}

    eng = _get_engine()
    if eng is None:
        return {"eval_white": 0.0, "mate_after": None, "best_uci": None, "best_san": None,
                "pv": [], "error": "no engine configured"}

    depth = max(4, min(int(depth or 14), 22))
    with _lock:
        try:
            info = eng.analyse(board, chess.engine.Limit(depth=depth))
        except chess.engine.EngineTerminatedError:
            # engine process died — drop it so the next call reopens a fresh one
            _engine = None
            return {"eval_white": 0.0, "mate_after": None, "best_uci": None, "best_san": None,
                    "pv": [], "error": "engine restarted, try again"}

    sc = info["score"].pov(chess.WHITE)
    eval_white = M.score_to_cp(sc, chess.WHITE)
    mate_after = sc.mate() if sc.is_mate() else None
    pv = list(info.get("pv", []))
    best = pv[0] if pv else None

    best_san = None
    pv_san = []
    bb = board.copy(stack=False)
    for i, mv in enumerate(pv[:6]):
        try:
            san = bb.san(mv)
        except Exception:  # noqa: BLE001
            break
        if i == 0:
            best_san = san
        pv_san.append(san)
        bb.push(mv)

    return {
        "eval_white": eval_white,
        "mate_after": mate_after,
        "best_uci": best.uci() if best else None,
        "best_san": best_san,
        "pv": pv_san,
    }


def make_move(fen: str, uci: str, depth: int = 14) -> dict:
    board = _parse_fen(fen)
    try:
        move = chess.Move.from_uci(uci)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"bad move: {exc}") from None
    if move not in board.legal_moves:
        raise ValueError("illegal move for this position")
    san = board.san(move)
    board.push(move)
    status = board_status(board)
    status["san"] = san
    status["uci"] = uci
    status["eval"] = evaluate(board, depth)
    return status