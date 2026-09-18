"""SQLite persistence: uploaded games + cached analyses (keyed by game hash + depth)."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
import time
from typing import Iterable, Optional

DB_PATH = os.environ.get(
    "CHESS_REVIEW_DB",
    os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "review.sqlite"),
)

_lock = threading.RLock()


def connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    con = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    return con


_con: Optional[sqlite3.Connection] = None


def con() -> sqlite3.Connection:
    global _con
    if _con is None:
        _con = connect()
        init(_con)
    return _con


def init(c: sqlite3.Connection) -> None:
    c.executescript(
        """
        CREATE TABLE IF NOT EXISTS collections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            uploaded_at REAL NOT NULL,
            n_games INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
            idx INTEGER NOT NULL,
            hash TEXT NOT NULL,
            headers TEXT NOT NULL,
            pgn TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS games_collection ON games(collection_id);
        CREATE INDEX IF NOT EXISTS games_hash ON games(hash);
        CREATE TABLE IF NOT EXISTS analyses (
            hash TEXT NOT NULL,
            depth INTEGER NOT NULL,
            engine TEXT,
            created_at REAL NOT NULL,
            summary TEXT NOT NULL,
            detail TEXT NOT NULL,
            PRIMARY KEY (hash, depth)
        );
        """
    )
    c.commit()


def game_hash(headers: dict, movetext: str) -> str:
    key = "|".join([
        headers.get("White", ""), headers.get("Black", ""), headers.get("Date", ""),
        headers.get("Round", ""), " ".join(movetext.split()),
    ])
    return hashlib.sha1(key.encode("utf-8")).hexdigest()


# ------------------------------------------------------------------ collections

def create_collection(name: str, games: list[tuple[str, dict, str]]) -> int:
    """games: list of (hash, headers, pgn_text)."""
    with _lock:
        c = con()
        cur = c.execute(
            "INSERT INTO collections(name, uploaded_at, n_games) VALUES (?,?,?)",
            (name, time.time(), len(games)),
        )
        cid = cur.lastrowid
        c.executemany(
            "INSERT INTO games(collection_id, idx, hash, headers, pgn) VALUES (?,?,?,?,?)",
            [(cid, i, h, json.dumps(hd), pgn) for i, (h, hd, pgn) in enumerate(games)],
        )
        c.commit()
        return cid


def list_collections() -> list[dict]:
    with _lock:
        rows = con().execute("SELECT * FROM collections ORDER BY id DESC").fetchall()
        return [dict(r) for r in rows]


def get_collection(cid: int) -> Optional[dict]:
    with _lock:
        r = con().execute("SELECT * FROM collections WHERE id=?", (cid,)).fetchone()
        return dict(r) if r else None


def delete_collection(cid: int) -> None:
    with _lock:
        c = con()
        c.execute("DELETE FROM games WHERE collection_id=?", (cid,))
        c.execute("DELETE FROM collections WHERE id=?", (cid,))
        c.commit()


def rename_collection(cid: int, name: str) -> None:
    with _lock:
        c = con()
        c.execute("UPDATE collections SET name=? WHERE id=?", (name, cid))
        c.commit()


def collection_games(cid: int) -> list[dict]:
    with _lock:
        rows = con().execute(
            "SELECT id, idx, hash, headers, pgn FROM games WHERE collection_id=? ORDER BY idx", (cid,)
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["headers"] = json.loads(d["headers"])
            out.append(d)
        return out


def get_game(gid: int) -> Optional[dict]:
    with _lock:
        r = con().execute("SELECT * FROM games WHERE id=?", (gid,)).fetchone()
        if not r:
            return None
        d = dict(r)
        d["headers"] = json.loads(d["headers"])
        return d


# --------------------------------------------------------------------- analyses

def get_analysis(h: str, depth: int, detail: bool = False) -> Optional[dict]:
    with _lock:
        r = con().execute("SELECT * FROM analyses WHERE hash=? AND depth=?", (h, depth)).fetchone()
        if not r:
            return None
        out = json.loads(r["summary"])
        if detail:
            out["detail"] = json.loads(r["detail"])
        out["engine"] = r["engine"]
        return out


def analyses_for(hashes: Iterable[str], depth: int) -> dict[str, dict]:
    hashes = list(hashes)
    out: dict[str, dict] = {}
    with _lock:
        c = con()
        for i in range(0, len(hashes), 500):
            chunk = hashes[i:i + 500]
            q = "SELECT hash, summary FROM analyses WHERE depth=? AND hash IN (%s)" % ",".join("?" * len(chunk))
            for r in c.execute(q, [depth, *chunk]).fetchall():
                out[r["hash"]] = json.loads(r["summary"])
    return out


def put_analysis(h: str, depth: int, engine: str, summary: dict, detail: dict) -> None:
    with _lock:
        c = con()
        c.execute(
            "INSERT OR REPLACE INTO analyses(hash, depth, engine, created_at, summary, detail) VALUES (?,?,?,?,?,?)",
            (h, depth, engine, time.time(), json.dumps(summary), json.dumps(detail)),
        )
        c.commit()


def cached_count(hashes: Iterable[str], depth: int) -> int:
    return len(analyses_for(hashes, depth))