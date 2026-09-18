"""FastAPI application: upload PGN, run Stockfish review jobs, browse results."""
from __future__ import annotations

import csv
import io
import os
import time
import uuid
from typing import Optional

import chess.pgn
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import db, live
from .engine import engine_name, find_engine, set_engine_path
from .jobs import manager

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(APP_DIR, "static")

app = FastAPI(title="PGN Game Review", version="1.0")

DEFAULT_DEPTH = int(os.environ.get("REVIEW_DEPTH", "16"))


# ------------------------------------------------------------------ config

class ConfigIn(BaseModel):
    engine_path: Optional[str] = None


@app.get("/api/config")
def get_config():
    path = find_engine()
    cpu = os.cpu_count() or 4
    return {
        "engine_path": path,
        "engine_name": engine_name(path) if path else None,
        "cpu_count": cpu,
        "defaults": {
            "depth": DEFAULT_DEPTH,
            "workers": max(1, min(cpu - 1, 8)),
            "threads": 1,
            "hash_mb": 128,
        },
    }


@app.post("/api/config")
def set_config(cfg: ConfigIn):
    if cfg.engine_path is not None:
        if cfg.engine_path and not os.path.isfile(cfg.engine_path):
            raise HTTPException(400, f"No file at {cfg.engine_path}")
        set_engine_path(cfg.engine_path)
    return get_config()


# ------------------------------------------------------------------ upload

def _split_pgn(text: str) -> list[tuple[str, dict, str]]:
    out = []
    stream = io.StringIO(text)
    while True:
        game = chess.pgn.read_game(stream)
        if game is None:
            break
        if game.errors:
            # keep going but note it; python-chess recovers what it can
            pass
        headers = dict(game.headers)
        exporter = chess.pgn.StringExporter(headers=True, variations=False, comments=True)
        pgn_text = game.accept(exporter)
        movetext = pgn_text.split("\n\n", 1)[1] if "\n\n" in pgn_text else ""
        if not list(game.mainline_moves()):
            continue
        out.append((db.game_hash(headers, movetext), headers, pgn_text))
    return out


@app.post("/api/upload")
async def upload(file: UploadFile = File(...), depth: int = DEFAULT_DEPTH):
    raw = await file.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    games = _split_pgn(text)
    if not games:
        raise HTTPException(400, "No games found in that PGN file.")
    cid = db.create_collection(file.filename or "upload.pgn", games)
    cached = db.cached_count([g[0] for g in games], depth)
    return {"collection_id": cid, "n_games": len(games), "cached": cached}


# Uploads are treated as growing PGN databases: a new file is parsed and held
# here for a short while (keyed by a random token) so the frontend can ask
# "add to an existing database, or start a new one?" before anything is
# actually written to the games table.
_PENDING_UPLOADS: dict[str, dict] = {}
_PENDING_TTL_SEC = 30 * 60


def _sweep_pending_uploads() -> None:
    now = time.time()
    for token in [t for t, p in _PENDING_UPLOADS.items() if p["expires"] < now]:
        _PENDING_UPLOADS.pop(token, None)


@app.post("/api/upload/stage")
async def upload_stage(file: UploadFile = File(...)):
    raw = await file.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    games = _split_pgn(text)
    if not games:
        raise HTTPException(400, "No games found in that PGN file.")
    _sweep_pending_uploads()
    token = uuid.uuid4().hex
    filename = file.filename or "upload.pgn"
    _PENDING_UPLOADS[token] = {"games": games, "filename": filename, "expires": time.time() + _PENDING_TTL_SEC}
    return {"token": token, "filename": filename, "n_games": len(games)}


@app.delete("/api/upload/stage/{token}")
def upload_discard(token: str):
    _PENDING_UPLOADS.pop(token, None)
    return {"ok": True}


class UploadCommitIn(BaseModel):
    token: str
    mode: str  # "new" | "append"
    name: Optional[str] = None
    collection_id: Optional[int] = None
    depth: int = DEFAULT_DEPTH


@app.post("/api/upload/commit")
def upload_commit(body: UploadCommitIn):
    _sweep_pending_uploads()
    pending = _PENDING_UPLOADS.pop(body.token, None)
    if not pending:
        raise HTTPException(400, "This upload has expired (or was already used) — please upload the file again.")
    games = pending["games"]
    if body.mode == "new":
        name = (body.name or pending["filename"]).strip() or pending["filename"]
        cid = db.create_collection(name, games)
        added, skipped = len(games), 0
    elif body.mode == "append":
        if not body.collection_id or not db.get_collection(body.collection_id):
            raise HTTPException(400, "That database no longer exists.")
        cid = body.collection_id
        added, skipped = db.add_games_to_collection(cid, games)
    else:
        raise HTTPException(400, "mode must be 'new' or 'append'")
    all_hashes = [g["hash"] for g in db.collection_games(cid)]
    cached = db.cached_count(all_hashes, body.depth)
    return {
        "collection_id": cid,
        "added": added,
        "skipped": skipped,
        "n_games": len(all_hashes),
        "cached": cached,
    }


@app.get("/api/collections")
def collections():
    return db.list_collections()


@app.delete("/api/collections/{cid}")
def delete_collection(cid: int):
    if not db.get_collection(cid):
        raise HTTPException(404)
    db.delete_collection(cid)
    return {"ok": True}


class RenameIn(BaseModel):
    name: str


@app.patch("/api/collections/{cid}")
def rename_collection(cid: int, body: RenameIn):
    if not db.get_collection(cid):
        raise HTTPException(404)
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Name can't be empty.")
    db.rename_collection(cid, name)
    return db.get_collection(cid)


# ------------------------------------------------------------------ live analysis board
#
# Lets the game viewer's "analysis board" branch off the reviewed game: you play
# your own moves and the engine evaluates the resulting position live. Distinct
# from the /jobs review pipeline — this is synchronous, per-request, and never
# touches the database.

class BoardStateIn(BaseModel):
    fen: str


class BoardMoveIn(BaseModel):
    fen: str
    uci: str
    depth: Optional[int] = None


@app.post("/api/board/state")
def board_state(body: BoardStateIn):
    try:
        return live.get_state(body.fen)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.post("/api/board/move")
def board_move(body: BoardMoveIn):
    try:
        return live.make_move(body.fen, body.uci, body.depth or DEFAULT_DEPTH)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.on_event("shutdown")
def _shutdown_live_engine():
    live.close_engine()


# ------------------------------------------------------------------ jobs

class AnalyzeIn(BaseModel):
    depth: int = DEFAULT_DEPTH
    workers: int = 4
    threads: int = 1
    hash_mb: int = 128


@app.post("/api/collections/{cid}/analyze")
def analyze(cid: int, body: AnalyzeIn):
    if not db.get_collection(cid):
        raise HTTPException(404, "collection not found")
    path = find_engine()
    if not path:
        raise HTTPException(400, "Stockfish not found. Set the engine path in Settings.")
    try:
        job = manager.start(
            collection_id=cid,
            depth=max(6, min(40, body.depth)),
            workers=max(1, min(64, body.workers)),
            threads=max(1, min(64, body.threads)),
            hash_mb=max(16, min(8192, body.hash_mb)),
            engine_path=path,
        )
    except RuntimeError as exc:
        raise HTTPException(409, str(exc))
    return job.to_dict()


@app.get("/api/jobs")
def jobs():
    return manager.all()


@app.get("/api/jobs/{jid}")
def job(jid: str):
    j = manager.get(jid)
    if not j:
        raise HTTPException(404)
    return j.to_dict()


@app.post("/api/jobs/{jid}/cancel")
def cancel(jid: str):
    j = manager.get(jid)
    if not j:
        raise HTTPException(404)
    j.cancel()
    return j.to_dict()


# ------------------------------------------------------------------ results

def _game_row(g: dict, a: Optional[dict]) -> dict:
    hd = g["headers"]
    row = {
        "id": g["id"],
        "idx": g["idx"],
        "white": hd.get("White"),
        "black": hd.get("Black"),
        "white_elo": hd.get("WhiteElo"),
        "black_elo": hd.get("BlackElo"),
        "white_title": hd.get("WhiteTitle"),
        "black_title": hd.get("BlackTitle"),
        "white_team": hd.get("WhiteTeam"),
        "black_team": hd.get("BlackTeam"),
        "result": hd.get("Result"),
        "round": hd.get("Round"),
        "board": hd.get("Board"),
        "date": hd.get("Date"),
        "site": hd.get("Site"),
        "event": hd.get("Event"),
        "analyzed": a is not None,
    }
    if a:
        row.update({
            "n_moves": a["n_moves"],
            "opening": a["opening"],
            "white_accuracy": a["players"]["white"]["accuracy"],
            "black_accuracy": a["players"]["black"]["accuracy"],
            "white_counts": a["players"]["white"]["counts"],
            "black_counts": a["players"]["black"]["counts"],
            "interest": a["interest"],
            "summary": a["summary"],
            "final": a["final"],
        })
    return row


@app.get("/api/collections/{cid}/games")
def games(cid: int, depth: int = DEFAULT_DEPTH):
    col = db.get_collection(cid)
    if not col:
        raise HTTPException(404)
    gs = db.collection_games(cid)
    analyses = db.analyses_for([g["hash"] for g in gs], depth)
    rows = [_game_row(g, analyses.get(g["hash"])) for g in gs]
    return {"collection": col, "depth": depth, "games": rows,
            "analyzed": sum(1 for r in rows if r["analyzed"])}


@app.get("/api/games/{gid}")
def game_detail(gid: int, depth: int = DEFAULT_DEPTH):
    g = db.get_game(gid)
    if not g:
        raise HTTPException(404)
    a = db.get_analysis(g["hash"], depth, detail=True)
    return {"game": _game_row(g, a), "pgn": g["pgn"], "headers": g["headers"],
            "analysis": a["detail"] if a else None, "engine": a.get("engine") if a else None}


# ------------------------------------------------------------------ export

CSV_COLS = ["round", "board", "white", "white_elo", "white_team", "black", "black_elo", "black_team",
            "result", "n_moves", "opening", "white_accuracy", "black_accuracy",
            "interest_score", "interest_label", "interest_tags", "reasons", "summary"]


@app.get("/api/collections/{cid}/export.csv")
def export_csv(cid: int, depth: int = DEFAULT_DEPTH):
    data = games(cid, depth)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(CSV_COLS + [f"white_{c}" for c in _CLASS_ORDER] + [f"black_{c}" for c in _CLASS_ORDER])
    rows = sorted(data["games"], key=lambda r: -(r.get("interest") or {}).get("score", -1))
    for r in rows:
        it = r.get("interest") or {}
        w.writerow([
            r.get("round"), r.get("board"), r.get("white"), r.get("white_elo"), r.get("white_team"),
            r.get("black"), r.get("black_elo"), r.get("black_team"), r.get("result"), r.get("n_moves"),
            (r.get("opening") or {}).get("name") if r.get("opening") else "",
            r.get("white_accuracy"), r.get("black_accuracy"),
            it.get("score"), it.get("label"), " ".join(it.get("tags", [])),
            " | ".join(it.get("reasons", [])), r.get("summary"),
        ] + [(r.get("white_counts") or {}).get(c, "") for c in _CLASS_ORDER]
          + [(r.get("black_counts") or {}).get(c, "") for c in _CLASS_ORDER])
    buf.seek(0)
    name = f"review_{cid}_d{depth}.csv"
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f"attachment; filename={name}"})


_CLASS_ORDER = ["brilliant", "great", "best", "excellent", "good", "book", "forced",
                "inaccuracy", "mistake", "miss", "blunder"]


@app.get("/api/collections/{cid}/export.json")
def export_json(cid: int, depth: int = DEFAULT_DEPTH):
    data = games(cid, depth)
    data["games"].sort(key=lambda r: -(r.get("interest") or {}).get("score", -1))
    name = f"review_{cid}_d{depth}.json"
    return JSONResponse(data, headers={"Content-Disposition": f"attachment; filename={name}"})


# ------------------------------------------------------------------ static

@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")