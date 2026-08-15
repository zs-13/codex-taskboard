#!/usr/bin/env bash
# start-taskboard.sh - macOS launcher for Codex Taskboard.
#
# Starts the local Taskboard service, launches the Codex (ChatGPT.app) with a
# dedicated CDP port, injects the Taskboard sidebar entry, and keeps the agent
# runner alive. Safe to run repeatedly.
#
# Usage:
#   ./scripts/start-taskboard.sh
#   CODEX_TASKBOARD_PORT=9231 ./scripts/start-taskboard.sh
#   CODEX_TASKBOARD_CODEX_APP_PATH=/Applications/Codex.app ./scripts/start-taskboard.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DATA_DIR="${CODEX_TASKBOARD_DATA_DIR:-$REPO_ROOT/.data}"
LOG_DIR="$DATA_DIR/logs"
RUNTIME_FILE="$DATA_DIR/launcher-runtime.json"
PORT="${CODEX_TASKBOARD_PORT:-9231}"
APP_PATH="${CODEX_TASKBOARD_CODEX_APP_PATH:-/Applications/ChatGPT.app}"
SERVICE_URL="${CODEX_TASKBOARD_URL:-http://127.0.0.1:47823}"

mkdir -p "$DATA_DIR" "$LOG_DIR"

echo "=== Codex Taskboard (macOS launcher) ==="
echo "Repo: $REPO_ROOT"

# 1. Node.js required
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.5+ is required but was not found on PATH." >&2
  exit 1
fi

# 2. Install dependencies when missing
if [ ! -d "$REPO_ROOT/node_modules" ]; then
  echo "Installing dependencies (npm install)..."
  npm install --no-audit --no-fund
fi

# 3. Launch Codex with CDP unless a launcher is already running
cdp_ready() {
  curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/json/version" 2>/dev/null
}

if cdp_ready; then
  echo "Codex CDP already reachable on port $PORT."
else
  echo "Launching Codex app with CDP port $PORT ..."
  if [ -d "$APP_PATH" ]; then
    open -n -a "$APP_PATH" --args \
      --user-data-dir="$DATA_DIR/codex-profile" \
      --remote-debugging-address=127.0.0.1 \
      --remote-debugging-port="$PORT" \
      --new-window
  else
    echo "Codex app not found at $APP_PATH. Set CODEX_TASKBOARD_CODEX_APP_PATH to the app bundle." >&2
    echo "Continuing without launching Codex." >&2
  fi
fi

# 4. Start the injector (watch + open). Its supervisor starts the Taskboard
#    service and writes the runtime file.
if pgrep -f "scripts/codex-injector.mjs" >/dev/null 2>&1; then
  echo "Taskboard injector already running."
else
  echo "Starting Taskboard injector on port $PORT ..."
  nohup node scripts/codex-injector.mjs --watch --open --port "$PORT" \
    >"$LOG_DIR/injector.log" 2>"$LOG_DIR/injector.err.log" &
fi

# 5. Wait for the runtime file so the agent runner can attach.
for _ in $(seq 1 60); do
  [ -f "$RUNTIME_FILE" ] && break
  sleep 0.5
done

# 6. Start the agent runner.
if pgrep -f "scripts/taskboard-agent-runner.mjs" >/dev/null 2>&1; then
  echo "Taskboard agent runner already running."
else
  echo "Starting Taskboard agent runner ..."
  nohup node scripts/taskboard-agent-runner.mjs --watch \
    >"$LOG_DIR/agent-runner.log" 2>"$LOG_DIR/agent-runner.err.log" &
fi

echo ""
echo "Taskboard service: $SERVICE_URL  (data: $DATA_DIR/taskboard.sqlite)"
echo "Codex CDP:         http://127.0.0.1:$PORT/json/version"
echo "Runtime file:      $RUNTIME_FILE"
echo ""
echo "Logs: $LOG_DIR"
echo "Done. The Taskboard panel should appear in the Codex sidebar."
