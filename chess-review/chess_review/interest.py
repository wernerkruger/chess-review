"""Interestingness scoring and natural-language game summaries."""
from __future__ import annotations

from . import metrics as M


def _int(v, default=None):
    try:
        return int(str(v).strip())
    except Exception:
        return default


def _name(full: str) -> str:
    """'Abdusattorov, Nodirbek' -> 'Abdusattorov'."""
    if not full:
        return "?"
    return full.split(",")[0].strip()


def score_interest(headers: dict, analysis: dict) -> dict:
    """Return {"score": 0..100, "label": str, "reasons": [str], "tags": [str]}."""
    result = headers.get("Result", "*")
    w_elo = _int(headers.get("WhiteElo"))
    b_elo = _int(headers.get("BlackElo"))
    moves = analysis["moves"]
    n = analysis["n_moves"]
    white = analysis["players"]["white"]
    black = analysis["players"]["black"]
    graph = analysis["graph"]  # white win% per ply

    score = 0.0
    reasons: list[str] = []
    tags: list[str] = []

    winner = None
    if result == "1-0":
        winner = "white"
    elif result == "0-1":
        winner = "black"
    decisive = winner is not None

    # ---------------------------------------------------------------- upset
    if w_elo and b_elo:
        diff = (b_elo - w_elo) if winner == "white" else (w_elo - b_elo) if winner == "black" else 0
        if decisive and diff >= 100:
            pts = 15 + min(45, diff / 10)
            score += pts
            loser = "black" if winner == "white" else "white"
            reasons.append(
                f"Upset: {_name(headers.get('White' if winner == 'white' else 'Black'))} "
                f"({w_elo if winner == 'white' else b_elo}) beat "
                f"{_name(headers.get('White' if loser == 'white' else 'Black'))} "
                f"({w_elo if loser == 'white' else b_elo}), a {diff}-point rating gap")
            tags.append("upset")
        elif not decisive and result == "1/2-1/2" and abs(w_elo - b_elo) >= 300:
            diff2 = abs(w_elo - b_elo)
            pts = 8 + min(17, diff2 / 25)
            score += pts
            lower = "White" if w_elo < b_elo else "Black"
            reasons.append(f"Giant-killing draw: {_name(headers.get(lower))} held a {diff2}-point higher-rated opponent")
            tags.append("upset-draw")

    # ------------------------------------------------------ special moves
    brilliant = [m for m in moves if m["classification"] == M.BRILLIANT]
    great = [m for m in moves if m["classification"] == M.GREAT]
    if brilliant:
        score += min(30, 15 * len(brilliant))
        desc = ", ".join(f"{_move_no(m)} {m['san']}!!" for m in brilliant[:3])
        reasons.append(f"{len(brilliant)} brilliant sacrifice{'s' if len(brilliant) > 1 else ''}: {desc}")
        tags.append("brilliant")
    if great:
        score += min(18, 6 * len(great))
        desc = ", ".join(f"{_move_no(m)} {m['san']}!" for m in great[:3])
        reasons.append(f"{len(great)} great move{'s' if len(great) > 1 else ''}: {desc}")
        tags.append("great-moves")

    # ---------------------------------------------------------- accuracy
    w_acc, b_acc = white["accuracy"], black["accuracy"]
    if decisive:
        win_acc = w_acc if winner == "white" else b_acc
        if win_acc >= 97 and n >= 25:
            score += 15
            reasons.append(f"Near-perfect game by the winner ({win_acc}% accuracy)")
            tags.append("high-accuracy")
        elif win_acc >= 94 and n >= 25:
            score += 9
            reasons.append(f"Very high winner accuracy ({win_acc}%)")
            tags.append("high-accuracy")
    if w_acc >= 93 and b_acc >= 93 and n >= 30:
        score += 10
        reasons.append(f"Both sides played at engine-like precision ({w_acc}% / {b_acc}%)")
        tags.append("precise")

    # ---------------------------------------------------------- comeback
    if decisive and n >= 12:
        # winner's win% over the game (white POV graph -> winner POV)
        win_pov = graph if winner == "white" else [100 - g for g in graph]
        lowest = min(win_pov[10:]) if len(win_pov) > 10 else min(win_pov)
        if lowest <= 12:
            score += 22
            reasons.append(f"Huge comeback: the winner's chances dropped to {lowest:.0f}% before turning the game")
            tags.append("comeback")
        elif lowest <= 25:
            score += 14
            reasons.append(f"Comeback: the winner was losing ({lowest:.0f}% winning chances) at one point")
            tags.append("comeback")
    if not decisive and result == "1/2-1/2" and n >= 12:
        extremes = [g for g in graph[10:]]
        if extremes and (max(extremes) >= 90 or min(extremes) <= 10):
            score += 12
            side = "White" if max(extremes) >= 90 else "Black"
            reasons.append(f"Escape: {side} had a winning position but the game was drawn")
            tags.append("escape")

    # ------------------------------------------------------- sharpness / swings
    swings = _lead_changes(graph)
    if swings >= 2:
        pts = min(12, 4 * swings)
        score += pts
        reasons.append(f"Wild game: the advantage changed hands {swings} times")
        tags.append("swings")

    # ---------------------------------------------------------- mates / finishes
    if analysis.get("final") == "checkmate":
        score += 8
        reasons.append("Ended in checkmate on the board")
        tags.append("checkmate")
    if decisive and n <= 25:
        loser_p = black if winner == "white" else white
        score += 6
        reasons.append(f"Quick knockout in {n // 2 + n % 2} moves")
        tags.append("miniature")

    # ----------------------------------------------------- big blunders (drama)
    blunders = [m for m in moves if m["classification"] == M.BLUNDER]
    misses = [m for m in moves if m["classification"] == M.MISS]
    if decisive and blunders:
        # the decisive blunder: the largest EP loss by the loser
        loser = "black" if winner == "white" else "white"
        lb = [m for m in blunders if m["color"] == loser]
        if lb:
            worst = max(lb, key=lambda m: m["ep_loss"])
            if worst["ep_before"] >= 0.45:
                score += 5
                reasons.append(f"Decisive blunder: {_move_no(worst)} {worst['san']}?? "
                               f"({worst['ep_before']*100:.0f}% → {worst['ep_after']*100:.0f}%)")
                tags.append("decisive-blunder")
    if misses:
        score += min(8, 4 * len(misses))
        m0 = misses[0]
        reasons.append(f"Missed win: {_move_no(m0)} {m0['san']} let a winning position slip")
        tags.append("missed-win")

    # ------------------------------------------------------------ marquee
    if w_elo and b_elo and (w_elo + b_elo) / 2 >= 2650:
        score += 6
        reasons.append("Elite pairing (average rating {:.0f})".format((w_elo + b_elo) / 2))
        tags.append("elite")

    # ------------------------------------------------------------ dullness
    if result == "1/2-1/2":
        quiet = all(35 <= g <= 65 for g in graph)
        if quiet and n <= 40:
            score = min(score, 6)
            reasons.append("Quiet, short draw with the evaluation never leaving the equal zone")
            tags.append("quiet-draw")
        elif quiet:
            score = min(score, 18)
            reasons.append("Balanced draw with no real swings")
            tags.append("quiet-draw")
    if decisive and not reasons:
        reasons.append("Routine win for the favourite")

    score = max(0.0, min(100.0, score))
    if score >= 60:
        label = "Must-see"
    elif score >= 40:
        label = "Interesting"
    elif score >= 20:
        label = "Notable"
    else:
        label = "Routine"
    return {"score": round(score), "label": label, "reasons": reasons, "tags": tags}


def _move_no(m: dict) -> str:
    ply = m["ply"]
    no = (ply + 1) // 2
    return f"{no}." if m["color"] == "white" else f"{no}..."


def _lead_changes(graph: list[float]) -> int:
    """Count how many times the advantage swung from clearly one side to clearly the other."""
    state = 0  # +1 white better, -1 black better
    changes = 0
    for g in graph:
        if g >= 68:
            if state == -1:
                changes += 1
            state = 1
        elif g <= 32:
            if state == 1:
                changes += 1
            state = -1
    return changes


def summarize(headers: dict, analysis: dict, interest: dict) -> str:
    """One-paragraph human summary of the game."""
    w = _name(headers.get("White"))
    b = _name(headers.get("Black"))
    w_elo = headers.get("WhiteElo", "?")
    b_elo = headers.get("BlackElo", "?")
    w_team = headers.get("WhiteTeam")
    b_team = headers.get("BlackTeam")
    result = headers.get("Result", "*")
    n = analysis["n_moves"]
    full_moves = (n + 1) // 2
    opening = analysis.get("opening")
    P = analysis["players"]

    who = f"{w} ({w_elo}{', ' + w_team if w_team else ''}) vs {b} ({b_elo}{', ' + b_team if b_team else ''})"
    if result == "1-0":
        outcome = f"{w} won with White in {full_moves} moves"
    elif result == "0-1":
        outcome = f"{b} won with Black in {full_moves} moves"
    elif result == "1/2-1/2":
        outcome = f"drawn after {full_moves} moves"
    else:
        outcome = "unfinished"
    if analysis.get("final") == "checkmate":
        outcome += " by checkmate"

    parts = [f"{who}: {outcome}."]
    if opening:
        parts.append(f"Opening: {opening['name']} ({opening['eco']}).")
    parts.append(f"Accuracy: {w} {P['white']['accuracy']}%, {b} {P['black']['accuracy']}%.")

    # key moments
    moves = analysis["moves"]
    key = [m for m in moves if m["classification"] in (M.BRILLIANT, M.GREAT, M.BLUNDER, M.MISS)]
    if key:
        key_sorted = sorted(key, key=lambda m: -abs(m["ep_loss"]) if m["classification"] in (M.BLUNDER, M.MISS) else -1)
        bits = []
        for m in key_sorted[:4]:
            name = w if m["color"] == "white" else b
            tag = {"brilliant": "!! (brilliant)", "great": "! (great)", "blunder": "?? (blunder)", "miss": "? (missed win)"}[m["classification"]]
            bits.append(f"{_move_no(m)} {m['san']}{tag} by {name}")
        parts.append("Key moments: " + "; ".join(bits) + ".")
    if interest["reasons"]:
        parts.append("Why it matters: " + " ".join(r if r.endswith(".") else r + "." for r in interest["reasons"][:3]))
    return " ".join(parts)
