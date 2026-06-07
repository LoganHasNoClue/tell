#!/usr/bin/env bash
# TELL — one-command launcher. Frontend is the whole demo (offline-safe);
# the backend is the optional "real pipeline" path.
set -e
cd "$(dirname "$0")"

MODE="${1:-frontend}"

case "$MODE" in
  frontend|fe)
    cd frontend
    [ -d node_modules ] || pnpm install
    exec pnpm dev
    ;;
  backend|be)
    cd backend
    [ -d .venv ] || python3 -m venv .venv
    . .venv/bin/activate
    pip install -q -r requirements.txt
    exec uvicorn main:app --port 8000 --reload
    ;;
  data)
    exec python3 tools/generate_scenarios.py
    ;;
  *)
    echo "usage: ./run.sh [frontend|backend|data]"
    exit 1
    ;;
esac
