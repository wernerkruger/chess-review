"""Analyse a single game with Stockfish and produce chess.com-style review data."""
from __future__ import annotations

import io
import math
import re
import statistics
from dataclasses import asdict
from typing import Callable, Optional

import chess
import chess.engine
import chess.pgn

from . import metrics as M
from .openings import lookup_opening

CLOCK_RE = re.compile(r"\[%clk\s+([0-9:.]+)\]")


class PositionInfo:
    __slots__ = ("cp", "mate", "best", "second_cp", "second_mate", "pv", "terminal")

    def __init__(self):
        self.cp = 0.0            # side-to-move POV cp (mates mapped)
        self.mate = None         # side-to-move mate distance (signed) or None
        self.best = None         # chess.Move
        self.second_cp = None    # side-to-move POV cp of 2nd best line
        self.second_mate = None
        self.pv = []             # list[chess.Move]
        self.terminal = None     # "checkmate" | "stalemate" | "draw" | None


def analyse_position(engine: chess.engine.SimpleEngine, board: chess.Board, depth: int,
                     game_key: object = None) -> PositionInfo:
    info = PositionInfo()
    if board.is_checkmate():
        info.terminal = "checkmate"
        info.cp = -M.MATE_CP
        info.mate = 0
        return info
    if board.is_stalemate() or board.is_insufficient_material():
        info.terminal = "stalemate" if board.is_stalemate() else "draw"
        info.cp = 0.0
        return info
    legal = list(board.legal_moves)
    multipv = 2 if len(legal) > 1 else 1
    results = engine.analyse(board, chess.engine.Limit(depth=depth), multipv=multipv, game=game_key)
    if isinstance(results, dict):
        results = [results]
    top = results[0]
    sc = top["score"].pov(board.turn)
    info.cp = M.score_to_cp(sc, board.turn)
    info.mate = sc.mate() if sc.is_mate() else None
    info.pv = list(top.get("pv", []))
    info.best = info.pv[0] if info.pv else (legal[0] if legal else None)
    if len(results) > 1:
        sc2 = results[1]["score"].pov(board.turn)
        info.second_cp = M.score_to_cp(sc2, board.turn)
        info.second_mate = sc2.mate() if sc2.is_mate() else None
    return info


def _ep(cp: float) -> float:
    return M.win_percent(cp) / 100.0


def _pv_san(board: chess.Board, pv: list[chess.Move], n: int = 6) -> list[str]:
    b = board.copy(stack=False)
    out = []
    for mv in pv[:n]:
        try:
            out.append(b.san(mv))
            b.push(mv)
        except Exception:
            break
    return out


def analyse_game(
    game: chess.pgn.Game,
    engine: chess.engine.SimpleEngine,
    depth: int,
    progress: Optional[Callable[[int, int], None]] = None,
) -> dict:
    """Return a JSON-serialisable analysis for one game."""
    board = game.board()
    nodes = list(game.mainline())
    moves = [n.move for n in nodes]
    n_moves = len(moves)

    # ---- 1. evaluate every position (n_moves + 1 of them)
    positions: list[PositionInfo] = []
    boards: list[chess.Board] = []
    b = board.copy()
    game_key = object()  # new key per game -> python-chess sends `ucinewgame` (fresh hash)
    for i in range(n_moves + 1):
        boards.append(b.copy(stack=False))
        positions.append(analyse_position(engine, b, depth, game_key))
        if progress:
            progress(i + 1, n_moves + 1)
        if i < n_moves:
            b.push(moves[i])

    # ---- 2. classify each move
    evals: list[M.MoveEval] = []
    in_book = True
    opening = None
    for i, mv in enumerate(moves):
        bb = boards[i]
        mover = bb.turn
        before = positions[i]
        after = positions[i + 1]

        ep_before = _ep(before.cp)
        # position i+1 is from the opponent's POV -> flip
        if after.terminal == "checkmate":
            cp_after = M.MATE_CP
        else:
            cp_after = -after.cp
        ep_after = _ep(cp_after)
        ep_loss = max(0.0, ep_before - ep_after)
        second_ep = _ep(before.second_cp) if before.second_cp is not None else None

        is_best_move = before.best is not None and mv == before.best
        legal_count = bb.legal_moves.count()

        # book?
        opening_hit = lookup_opening(boards[i + 1]) if in_book else None
        if opening_hit:
            opening = opening_hit
        else:
            in_book = False

        sac = 0.0
        if legal_count == 1:
            cls = M.FORCED
        elif opening_hit is not None:
            cls = M.BOOK
        else:
            cls = M.BEST if is_best_move else M.classify_by_loss(ep_loss)

            # -- Missed win: opponent just erred, mover was winning, and squandered it
            if cls in (M.MISTAKE, M.BLUNDER, M.INACCURACY) and i > 0:
                prev = evals[-1]
                opp_erred = prev.ep_loss >= M.T_INACCURACY
                was_winning = ep_before >= 0.72 or (before.mate is not None and before.mate > 0)
                now_not_winning = ep_after <= 0.58
                if opp_erred and was_winning and now_not_winning and ep_loss >= M.T_GOOD:
                    cls = M.MISS
                elif before.mate is not None and before.mate > 0 and after.mate is None and ep_loss >= M.T_GOOD:
                    cls = M.MISS  # missed a forced mate

            prev_move = moves[i - 1] if i > 0 else None
            is_recapture = (
                prev_move is not None
                and boards[i - 1].is_capture(prev_move)
                and bb.is_capture(mv)
                and mv.to_square == prev_move.to_square
            )
            is_free_capture = bb.is_capture(mv) and M.static_exchange(bb, mv.to_square, mover) > 0

            if cls in (M.BEST, M.EXCELLENT):
                # -- Brilliant: a sound piece sacrifice, position not bad afterwards,
                #    and not already completely winning without it.
                sac = M.sacrifice_amount(bb, mv)
                not_bad_after = ep_after >= 0.42
                not_trivially_winning = (second_ep is None or second_ep < 0.70) and not (
                    before.mate is not None and 0 < before.mate <= 3)
                near_best = cls == M.BEST or ep_loss <= 0.01
                if sac >= 2.0 and not_bad_after and not_trivially_winning and near_best and not is_recapture:
                    cls = M.BRILLIANT

            if cls == M.BEST and second_ep is not None and not is_recapture and not is_free_capture \
                    and legal_count > 3:
                # -- Great: the only good move / the move that decides the game.
                #    Obvious moves (recaptures, free captures, near-forced positions)
                #    and positions that are already decided don't qualify.
                gap = ep_before - second_ep
                only_move = gap >= 0.15 and 0.30 <= ep_before <= 0.90
                punish = False
                if prev_move is not None and evals[-1].ep_loss >= M.T_INACCURACY and gap >= 0.10:
                    # opponent erred; this is the move that makes it count
                    punish = ep_after >= 0.55 and evals[-1].ep_before >= 0.40 and ep_before <= 0.92
                if only_move or punish:
                    cls = M.GREAT

        win_before = ep_before * 100.0
        win_after = ep_after * 100.0
        acc = M.move_accuracy(win_before, win_after)
        if cls in (M.BOOK, M.FORCED, M.BEST, M.GREAT, M.BRILLIANT):
            acc = 100.0

        clock = None
        cm = CLOCK_RE.search(nodes[i].comment or "")
        if cm:
            clock = cm.group(1)

        # white POV eval after the move for the graph
        if after.terminal == "checkmate":
            eval_white = M.MATE_CP if mover == chess.WHITE else -M.MATE_CP
            mate_after = 0
        else:
            eval_white = after.cp if boards[i + 1].turn == chess.WHITE else -after.cp
            mate_after = None
            if after.mate is not None:
                mate_after = after.mate if boards[i + 1].turn == chess.WHITE else -after.mate

        evals.append(M.MoveEval(
            ply=i + 1,
            san=bb.san(mv),
            uci=mv.uci(),
            color="white" if mover == chess.WHITE else "black",
            fen_before=bb.fen(),
            fen_after=boards[i + 1].fen(),
            cp_before=before.cp,
            cp_after=cp_after,
            ep_before=round(ep_before, 4),
            ep_after=round(ep_after, 4),
            ep_loss=round(ep_loss, 4),
            best_uci=before.best.uci() if before.best else None,
            best_san=bb.san(before.best) if before.best else None,
            second_ep=round(second_ep, 4) if second_ep is not None else None,
            accuracy=round(acc, 1),
            classification=cls,
            eval_white=eval_white,
            mate_after=mate_after,
            pv=_pv_san(bb, before.pv),
            clock=clock,
            sacrifice=round(sac, 1),
        ))

    # ---- 3. per-player accuracy & counts
    summary = {
        "white": _player_summary(evals, "white"),
        "black": _player_summary(evals, "black"),
    }

    # white-POV win% per ply for graphs (ply 0 = start)
    graph = [50.0] + [round(M.win_percent(e.eval_white), 1) for e in evals]

    return {
        "n_moves": n_moves,
        "opening": {"eco": opening[0], "name": opening[1]} if opening else None,
        "moves": [asdict(e) for e in evals],
        "players": summary,
        "graph": graph,
        "final": positions[-1].terminal,
    }


def _player_summary(evals: list[M.MoveEval], color: str) -> dict:
    mine = [e for e in evals if e.color == color]
    counts = {c: 0 for c in M.ALL_CLASSES}
    for e in mine:
        counts[e.classification] += 1
    acc = game_accuracy(evals, color)
    scored = [e for e in mine if e.classification not in (M.BOOK, M.FORCED)]
    acpl = statistics.mean(
        [max(0.0, min(1000.0, e.cp_before - e.cp_after)) for e in scored]) if scored else 0.0
    return {
        "accuracy": round(acc, 1),
        "acpl": round(acpl, 1),
        "counts": counts,
        "moves": len(mine),
    }


def game_accuracy(evals: list[M.MoveEval], color: str) -> float:
    """Lichess-style game accuracy: mean of the volatility-weighted mean and the
    harmonic mean of the per-move accuracies (book/forced moves excluded)."""
    if not evals:
        return 100.0
    # white-POV win% for every position including the start
    wins = [50.0] + [M.win_percent(e.eval_white) for e in evals]
    n = len(wins)
    window = max(2, min(8, n // 10))
    # volatility (stdev of win%) of the window ending at each position
    vol = []
    for i in range(1, n):
        lo = max(0, i - window + 1)
        seg = wins[lo:i + 1]
        vol.append(statistics.pstdev(seg) if len(seg) > 1 else 0.0)
    accs, weights = [], []
    for e in evals:
        if e.color != color or e.classification in (M.BOOK, M.FORCED):
            continue
        accs.append(e.accuracy)
        weights.append(max(vol[e.ply - 1], 0.5))
    if not accs:
        return 100.0
    weighted = sum(a * w for a, w in zip(accs, weights)) / sum(weights)
    harmonic = len(accs) / sum(1.0 / max(a, 1.0) for a in accs)
    return max(0.0, min(100.0, (weighted + harmonic) / 2.0))
