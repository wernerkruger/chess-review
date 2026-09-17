"""Background analysis jobs: a pool of worker threads, each owning one Stockfish."""
from __future__ import annotations

import io
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import chess.pgn

from . import db
from .analysis import analyse_game
from .engine import open_engine
from .interest import score_interest, summarize


class Job:
    def __init__(self, collection_id: int, depth: int, workers: int, threads: int, hash_mb: int, engine_path: str):
        self.id = uuid.uuid4().hex[:8]
        self.collection_id = collection_id
        self.depth = depth
        self.workers = workers
        self.threads = threads
        self.hash_mb = hash_mb
        self.engine_path = engine_path
        self.status = "queued"          # queued | running | done | cancelled | error
        self.error: Optional[str] = None
        self.total_games = 0
        self.done_games = 0
        self.cached_games = 0
        self.failed_games = 0
        self.total_positions = 0
        self.done_positions = 0
        self.started_at: Optional[float] = None
        self.finished_at: Optional[float] = None
        self.current: dict[str, str] = {}   # worker -> "White - Black"
        self._cancel = threading.Event()
        self._lock = threading.Lock()
        self._pos_progress: dict[str, int] = {}
        self.engine_name = ""

    # ------------------------------------------------------------- public
    def cancel(self):
        self._cancel.set()

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def to_dict(self) -> dict:
        now = time.time()
        elapsed = (self.finished_at or now) - (self.started_at or now)
        rate = self.done_positions / elapsed if elapsed > 0 and self.done_positions else 0.0
        remaining = self.total_positions - self.done_positions
        eta = remaining / rate if rate > 0 else None
        return {
            "id": self.id,
            "collection_id": self.collection_id,
            "depth": self.depth,
            "workers": self.workers,
            "threads": self.threads,
            "status": self.status,
            "error": self.error,
            "total_games": self.total_games,
            "done_games": self.done_games,
            "cached_games": self.cached_games,
            "failed_games": self.failed_games,
            "total_positions": self.total_positions,
            "done_positions": self.done_positions + sum(self._pos_progress.values()),
            "elapsed": round(elapsed, 1),
            "eta": round(eta, 1) if eta is not None else None,
            "positions_per_sec": round(rate, 1),
            "current": dict(self.current),
            "engine": self.engine_name,
        }

    # ------------------------------------------------------------- running
    def run(self):
        self.status = "running"
        self.started_at = time.time()
        try:
            games = db.collection_games(self.collection_id)
            self.total_games = len(games)
            cached = db.analyses_for([g["hash"] for g in games], self.depth)
            todo = [g for g in games if g["hash"] not in cached]
            self.cached_games = len(games) - len(todo)
            self.done_games = self.cached_games
            # estimate positions from movetext length
            self.total_positions = sum(_count_plies(g["pgn"]) + 1 for g in todo)

            local = threading.local()

            def get_engine():
                eng = getattr(local, "engine", None)
                if eng is None:
                    eng = open_engine(self.engine_path, self.threads, self.hash_mb)
                    local.engine = eng
                    local.name = threading.current_thread().name
                    if not self.engine_name:
                        self.engine_name = eng.id.get("name", "")
                return eng

            def close_engine():
                eng = getattr(local, "engine", None)
                if eng is not None:
                    try:
                        eng.quit()
                    except Exception:
                        pass
                    local.engine = None

            def work(g: dict):
                if self.cancelled:
                    return
                wname = threading.current_thread().name
                try:
                    eng = get_engine()
                    game = chess.pgn.read_game(io.StringIO(g["pgn"]))
                    hd = g["headers"]
                    self.current[wname] = f"{hd.get('White','?')} – {hd.get('Black','?')}"

                    def prog(done, total):
                        self._pos_progress[wname] = done
                        if self.cancelled:
                            raise _Cancelled()

                    analysis = analyse_game(game, eng, self.depth, progress=prog)
                    interest = score_interest(hd, analysis)
                    text = summarize(hd, analysis, interest)
                    summary = {
                        "n_moves": analysis["n_moves"],
                        "opening": analysis["opening"],
                        "players": analysis["players"],
                        "interest": interest,
                        "summary": text,
                        "final": analysis["final"],
                        "graph": analysis["graph"],
                    }
                    db.put_analysis(g["hash"], self.depth, self.engine_name, summary, analysis)
                    with self._lock:
                        self.done_games += 1
                        self.done_positions += analysis["n_moves"] + 1
                        self._pos_progress[wname] = 0
                except _Cancelled:
                    close_engine()
                except Exception as exc:  # noqa: BLE001
                    traceback.print_exc()
                    with self._lock:
                        self.failed_games += 1
                        self.done_positions += _count_plies(g["pgn"]) + 1
                        self._pos_progress[wname] = 0
                    # engine may be dead -> reopen next time
                    if isinstance(exc, (chess.engine.EngineTerminatedError, chess.engine.EngineError, BrokenPipeError)):
                        close_engine()
                finally:
                    self.current.pop(wname, None)

            with ThreadPoolExecutor(max_workers=self.workers, thread_name_prefix="sf") as pool:
                list(pool.map(work, todo))
                # close all engines
                for _ in range(self.workers):
                    pool.submit(close_engine)
            self.status = "cancelled" if self.cancelled else "done"
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self.status = "error"
            self.error = str(exc)
        finally:
            self.finished_at = time.time()


class _Cancelled(Exception):
    pass


def _count_plies(pgn: str) -> int:
    body = pgn.split("\n\n", 1)[1] if "\n\n" in pgn else pgn
    body = _strip_comments(body)
    return sum(1 for tok in body.split() if not tok[0].isdigit() and tok not in ("*", "1-0", "0-1", "1/2-1/2"))


def _strip_comments(s: str) -> str:
    out, depth = [], 0
    for ch in s:
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth = max(0, depth - 1)
        elif depth == 0:
            out.append(ch)
    return "".join(out)


class JobManager:
    def __init__(self):
        self.jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def start(self, **kw) -> Job:
        with self._lock:
            # only one running job at a time (engine CPU is the bottleneck)
            for j in self.jobs.values():
                if j.status in ("queued", "running"):
                    raise RuntimeError("Another analysis job is already running. Cancel it first.")
            job = Job(**kw)
            self.jobs[job.id] = job
        t = threading.Thread(target=job.run, name=f"job-{job.id}", daemon=True)
        t.start()
        return job

    def get(self, jid: str) -> Optional[Job]:
        return self.jobs.get(jid)

    def active(self) -> Optional[Job]:
        for j in self.jobs.values():
            if j.status in ("queued", "running"):
                return j
        return None

    def all(self) -> list[dict]:
        return [j.to_dict() for j in self.jobs.values()]


manager = JobManager()
