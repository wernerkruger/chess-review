"""
Win% / expected-points, per-move accuracy and move classification.

Sources:
  * Win% curve and Accuracy% curve: Lichess (https://lichess.org/page/accuracy)
        Win%      = 50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)
        Accuracy% = 103.1668 * exp(-0.04354 * (winBefore - winAfter)) - 3.1669
  * Classification thresholds: Chess.com "ClassificationV2" expected-points model
    (support.chess.com, "How are moves classified?"):
        Best        0.00
        Excellent   0.00 - 0.02
        Good        0.02 - 0.05
        Inaccuracy  0.05 - 0.10
        Mistake     0.10 - 0.20
        Blunder     0.20 - 1.00
    plus the special labels Brilliant (a sound piece sacrifice), Great (a critical /
    only move), Missed Win (failing to punish an opponent's mistake), Book and Forced.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

import chess

# ----------------------------------------------------------------------------- win %

MATE_CP = 2000  # centipawn equivalent used for mate scores (win% ~ 99.9)


def win_percent(cp: float) -> float:
    """Win probability (0..100) for the side the cp is measured for."""
    cp = max(-MATE_CP, min(MATE_CP, cp))
    return 50.0 + 50.0 * (2.0 / (1.0 + math.exp(-0.00368208 * cp)) - 1.0)


def score_to_cp(score: chess.engine.PovScore | chess.engine.Score, pov: chess.Color) -> float:
    """Convert a python-chess score (from `pov`'s perspective) into centipawns.

    Mates are mapped onto +/-MATE_CP (minus the distance so that shorter mates
    are 'better'); this keeps the win% curve monotone.
    """
    if isinstance(score, chess.engine.PovScore):
        score = score.pov(pov)
    if score.is_mate():
        n = score.mate()
        if n is None:
            return 0.0
        if n > 0:
            return float(MATE_CP - min(n, 100))
        return float(-MATE_CP + min(-n, 100))
    cp = score.score()
    return float(cp if cp is not None else 0.0)


def move_accuracy(win_before: float, win_after: float) -> float:
    """Lichess Accuracy% of a single move (both win% for the mover, 0..100)."""
    if win_after >= win_before:
        return 100.0
    acc = 103.1668 * math.exp(-0.04354 * (win_before - win_after)) - 3.1669
    return max(0.0, min(100.0, acc + 1.0))  # +1 uncertainty bonus like lichess


# ----------------------------------------------------------------------------- classes

BRILLIANT = "brilliant"
GREAT = "great"
BEST = "best"
EXCELLENT = "excellent"
GOOD = "good"
BOOK = "book"
FORCED = "forced"
INACCURACY = "inaccuracy"
MISTAKE = "mistake"
MISS = "miss"
BLUNDER = "blunder"

ALL_CLASSES = [BRILLIANT, GREAT, BEST, EXCELLENT, GOOD, BOOK, FORCED,
               INACCURACY, MISTAKE, MISS, BLUNDER]

# expected-points loss boundaries (chess.com ClassificationV2)
T_BEST = 0.005       # tolerance: an alternative move with (almost) identical EP is still "best"
T_EXCELLENT = 0.02
T_GOOD = 0.05
T_INACCURACY = 0.10
T_MISTAKE = 0.20


def classify_by_loss(ep_loss: float) -> str:
    if ep_loss <= T_BEST:
        return BEST
    if ep_loss <= T_EXCELLENT:
        return EXCELLENT
    if ep_loss <= T_GOOD:
        return GOOD
    if ep_loss <= T_INACCURACY:
        return INACCURACY
    if ep_loss <= T_MISTAKE:
        return MISTAKE
    return BLUNDER


# --------------------------------------------------------------------- sacrifice check

PIECE_VALUES = {
    chess.PAWN: 1.0,
    chess.KNIGHT: 3.0,
    chess.BISHOP: 3.0,
    chess.ROOK: 5.0,
    chess.QUEEN: 9.0,
    chess.KING: 100.0,
}


def _least_valuable_attacker(board: chess.Board, square: chess.Square, color: chess.Color) -> Optional[chess.Square]:
    attackers = board.attackers(color, square)
    best_sq, best_val = None, 1e9
    for sq in attackers:
        p = board.piece_at(sq)
        if p is None:
            continue
        v = PIECE_VALUES[p.piece_type]
        if v < best_val:
            best_sq, best_val = sq, v
    return best_sq


def static_exchange(board: chess.Board, square: chess.Square, side: chess.Color) -> float:
    """Static exchange evaluation: material `side` wins by starting captures on
    `square` (positive = good for `side`). Simple swap-list algorithm that
    physically removes pieces on a board copy so x-rays are handled reasonably.
    Pins are ignored (this is only used as a heuristic for 'is this a sacrifice')."""
    target = board.piece_at(square)
    if target is None:
        return 0.0
    b = board.copy(stack=False)
    gains = []
    captured_value = PIECE_VALUES[target.piece_type]
    color = side
    while True:
        att = _least_valuable_attacker(b, square, color)
        if att is None:
            break
        attacker = b.piece_at(att)
        gains.append(captured_value)
        if attacker.piece_type == chess.KING:
            # a king can only capture if the square is not defended afterwards
            if b.attackers(not color, square):
                gains.pop()
                break
        captured_value = PIECE_VALUES[attacker.piece_type]
        b.remove_piece_at(att)
        b.set_piece_at(square, attacker)
        color = not color
    if not gains:
        return 0.0
    # Swap-list negamax: each side may decline to continue the exchange, so
    # value[i] = gains[i] - max(0, value[i+1]).  The first capture is the one we
    # are asking about, so it is not optional.
    n = len(gains)
    vals = [0.0] * (n + 1)
    for i in range(n - 1, -1, -1):
        vals[i] = gains[i] - max(0.0, vals[i + 1])
    return vals[0]


def hanging_material(board: chess.Board, owner: chess.Color) -> dict[chess.Square, float]:
    """Squares of `owner`'s non-pawn pieces that the opponent can win material on,
    mapped to how much the opponent nets (in pawns)."""
    out = {}
    opp = not owner
    b = board.copy(stack=False)
    b.turn = opp
    # squares the opponent can *legally* capture on (handles pins and checks)
    try:
        legal_targets = {mv.to_square for mv in b.legal_moves if b.is_capture(mv)}
    except Exception:  # noqa: BLE001 - e.g. side not to move is in check
        legal_targets = {mv.to_square for mv in b.pseudo_legal_moves if b.is_capture(mv)}
    for sq, piece in board.piece_map().items():
        if piece.color != owner or piece.piece_type in (chess.PAWN, chess.KING):
            continue
        if sq not in legal_targets:
            continue
        gain = static_exchange(b, sq, opp)
        if gain > 0:
            out[sq] = gain
    return out


def sacrifice_amount(board_before: chess.Board, move: chess.Move) -> float:
    """How much material (in pawns) the mover deliberately puts en prise with `move`.

    Compares what the opponent can win by force *after* the move against what was
    already hanging *before* the move, and credits the mover for anything
    captured by the move itself. Returns 0 if the move is not a sacrifice."""
    mover = board_before.turn
    captured = board_before.piece_at(move.to_square)
    captured_val = PIECE_VALUES[captured.piece_type] if captured else 0.0
    if board_before.is_en_passant(move):
        captured_val = 1.0
    moving = board_before.piece_at(move.from_square)
    if moving is None:
        return 0.0
    if move.promotion:
        return 0.0

    before = hanging_material(board_before, mover)
    after_board = board_before.copy(stack=False)
    after_board.push(move)
    after = hanging_material(after_board, mover)

    worst = 0.0
    for sq, gain in after.items():
        if sq == move.to_square:
            # the moved piece itself is en prise: net cost = what they win - what we took
            worst = max(worst, gain - captured_val)
        else:
            prev = before.get(sq, 0.0)
            worst = max(worst, gain - prev)
    return worst


# --------------------------------------------------------------------------- summary

@dataclass
class MoveEval:
    ply: int
    san: str
    uci: str
    color: str                 # "white" / "black"
    fen_before: str
    fen_after: str
    cp_before: float           # mover POV, best line before the move
    cp_after: float            # mover POV, after the move
    ep_before: float           # expected points (0..1) for the mover before
    ep_after: float
    ep_loss: float
    best_uci: Optional[str]
    best_san: Optional[str]
    second_ep: Optional[float]
    accuracy: float
    classification: str
    eval_white: float          # cp after the move, white POV (for graph)
    mate_after: Optional[int]  # mate distance after the move, white POV
    pv: list[str]              # best line (SAN) from the position before the move
    clock: Optional[str]
    sacrifice: float
