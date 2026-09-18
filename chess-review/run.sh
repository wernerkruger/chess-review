#!/bin/bash
# Start the PGN Game Review web app.
#   ./run.sh              -> http://127.0.0.1:8000
#   PORT=9000 ./run.sh    -> custom port
#   STOCKFISH_PATH=/x/sf ./run.sh  -> custom engine (default: ../Engines/sf next to this folder)
set -e
cd "$(dirname "$0")"

PY=${PYTHON:-python3}
if [ ! -d .venv ]; then
  echo "Creating virtual environment…"
  "$PY" -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
if ! python -c "import chess, fastapi, uvicorn, multipart" 2>/dev/null; then
  echo "Installing dependencies…"
  pip install -q --upgrade pip
  pip install -q -r requirements.txt
fi

# make sure the bundled engine is executable (macOS may also quarantine it: see README)
if [ -f ../Engines/sf ]; then chmod +x ../Engines/sf 2>/dev/null || true; fi

PORT=${PORT:-8000}
echo "PGN Game Review → http://127.0.0.1:$PORT"
( sleep 1.5; open "http://127.0.0.1:$PORT" 2>/dev/null || true ) &
exec python -m uvicorn chess_review.server:app --host 127.0.0.1 --port "$PORT"
