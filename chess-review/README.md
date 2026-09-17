# PGN Game Review

A local web app that reviews every game in a PGN file with Stockfish, chess.com style:
per-player accuracy %, move classifications (Brilliant / Great / Best / Excellent / Good /
Book / Forced / Inaccuracy / Mistake / Miss / Blunder), a one-paragraph summary per game,
and an *interestingness* score that ranks the games worth looking at first.

## Run it

```bash
cd ~/Documents/Chess/Olympiad/chess-review
./run.sh            # first run creates .venv and installs deps, then opens http://127.0.0.1:8000
```

The engine is auto-detected at `../Engines/sf` (i.e. `Olympiad/Engines/sf`). Override with
`STOCKFISH_PATH=/path/to/stockfish ./run.sh` or in the app's Settings tab.

If macOS refuses to start the engine ("cannot be opened because the developer cannot be verified"),
clear the quarantine flag once: `xattr -d com.apple.quarantine ../Engines/sf`.

Requirements: Python 3.10+ (the system `python3`, or Anaconda's).

## Using it

1. **Upload** – drop a `.pgn` on the Upload tab. Set depth / parallel engines / threads first
   (defaults: depth 16, one engine per core minus one, 1 thread each). Analysis starts automatically
   and runs in the background; you can browse finished games while it runs, cancel, and resume later.
2. **Games** – ranked list (most interesting first) with accuracy, tags, and the reasons behind the
   score. Search by player/team/opening, filter by tag (upsets, brilliancies, comebacks…), and export
   the table as CSV or JSON.
3. **Game view** – click a game: board with move badges, eval bar, best-move arrow on errors, the
   engine's best line, clocks from the PGN, win-probability graph (click to jump), and the full
   classification breakdown for both players. Keys: ← → step, Home/End, `f` flips the board.

Results are cached in `data/review.sqlite` keyed by game + depth, so re-uploading the same file
(or an updated file with new rounds) only analyses the new games.

## How the numbers are computed

* **Win% / expected points** from the Stockfish score:
  `Win% = 50 + 50·(2 / (1 + e^(−0.00368208·cp)) − 1)` (the Lichess curve; mates map to ±2000 cp).
* **Move classification** follows chess.com's published *ClassificationV2* expected-points table:
  Best = 0.00 lost, Excellent ≤ 0.02, Good ≤ 0.05, Inaccuracy ≤ 0.10, Mistake ≤ 0.20, Blunder > 0.20.
  * **Brilliant** – best (or within 0.01) *and* a genuine piece sacrifice (≥ 2 pawns of material that
    the opponent can legally win by force, computed with a static exchange evaluation), the position is
    not bad afterwards (≥ 42 % winning chances), and the alternative move was not already clearly winning.
  * **Great** – the best move when every alternative loses ≥ 0.15 expected points (the "only move"),
    or the move that converts an opponent's mistake into a clear advantage. Obvious recaptures, free
    captures, near-forced positions and already-decided positions are excluded.
  * **Miss** – the opponent just erred into a lost position (≥ 72 % for you) and the move played gives
    it back (≤ 58 %); also missing a forced mate.
  * **Book** – position is in the Lichess ECO opening database (3,600 named lines). **Forced** – only legal move.
* **Move accuracy** uses the Lichess formula `103.1668·e^(−0.04354·ΔWin%) − 3.1669`; Best/Great/Brilliant,
  Book and Forced moves count as 100 %.
* **Game accuracy** = mean of the volatility-weighted mean and the harmonic mean of the move accuracies
  (book/forced moves excluded), as Lichess does. Chess.com's exact game-accuracy curve is not public; the
  two produce very similar numbers.
* **Interestingness (0–100)** adds up: upsets (rating gap × decisive result; draws by a much lower-rated
  player count half), brilliant and great moves, very high accuracy by the winner or both players,
  comebacks (winner was below 25 % / 12 % at some point), escapes (drawn from a lost position), number of
  lead changes, checkmate on the board, miniatures, a decisive blunder from an equal position, missed
  wins, and elite pairings. Quiet short draws are capped low. ≥ 60 = Must-see, ≥ 40 = Interesting,
  ≥ 20 = Notable, otherwise Routine.

All thresholds live at the top of `chess_review/metrics.py` and `chess_review/interest.py`.

## Layout

```
chess-review/
  run.sh                 start script (creates .venv, installs, launches)
  requirements.txt
  chess_review/
    server.py            FastAPI app + REST API
    jobs.py              background analysis jobs (one Stockfish per worker thread)
    analysis.py          per-game analysis and classification
    metrics.py           win%, accuracy, thresholds, sacrifice detection (SEE)
    interest.py          interestingness score + text summary
    openings.py          ECO lookup
    engine.py            engine discovery / UCI setup
    db.py                SQLite cache
  data/eco.json          Lichess opening database
  static/                single-page UI (no build step)
```

## Performance

Every position is searched once with MultiPV 2 at the chosen depth. On Apple Silicon with depth 16 and
8 parallel engines, the 812-game Olympiad file takes roughly an hour; depth 12 about 20 minutes;
depth 20 several hours. Keep `engines × threads ≤ cores`.
