#!/usr/bin/env bash
# 家庭虾 dev launcher — gateway (project source) + ui dev server,
# all using project-local .openclaw/ state and .env secrets.
#
# Usage:  ./scripts/family-shrimp/dev-start.sh
#
# Stop with Ctrl-C — the gateway child process will be terminated too.

set -euo pipefail

# Resolve repo root from this script's location.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." &>/dev/null && pwd)"
cd "$REPO_ROOT"

# 1. Load .env if present (do not override existing env vars).
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# 2. Pin openclaw state/config to project directory.
export OPENCLAW_HOME="$REPO_ROOT"
export OPENCLAW_STATE_DIR="$REPO_ROOT/.openclaw"
export OPENCLAW_CONFIG_PATH="$REPO_ROOT/.openclaw/openclaw.json"

# 3. Sanity check the API key is set.
if [[ -z "${MINIMAX_API_KEY:-}" ]]; then
  echo "[family-shrimp] ERROR: MINIMAX_API_KEY is not set."
  echo "Copy .env.example to .env and fill in MINIMAX_API_KEY, then retry."
  exit 1
fi

# 4. Warn if global gateway is already on the port.
if lsof -nP -iTCP:18789 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[family-shrimp] WARNING: something is already listening on :18789."
  echo "  If it's your global openclaw daemon, stop it with:"
  echo "    launchctl unload ~/Library/LaunchAgents/ai.openclaw.gateway.plist"
  echo "  Then re-run this script."
  exit 1
fi

# 5. Start the project-source gateway in background.
echo "[family-shrimp] starting gateway from project source..."
pnpm -s openclaw gateway \
  --auth none \
  --bind loopback \
  --port 18789 \
  --allow-unconfigured \
  > "$REPO_ROOT/.openclaw/gateway.dev.log" 2>&1 &
GATEWAY_PID=$!
echo "[family-shrimp] gateway pid=$GATEWAY_PID  (log: .openclaw/gateway.dev.log)"

# 5b. Start the storyboard backend (creation room).
echo "[family-shrimp] starting storyboard backend..."
node "$REPO_ROOT/services/storyboard/index.mjs" \
  > "$REPO_ROOT/.openclaw/storyboard.dev.log" 2>&1 &
STORYBOARD_PID=$!
echo "[family-shrimp] storyboard pid=$STORYBOARD_PID  (log: .openclaw/storyboard.dev.log)"

cleanup() {
  echo
  echo "[family-shrimp] stopping gateway (pid $GATEWAY_PID) + storyboard (pid $STORYBOARD_PID)..."
  kill "$GATEWAY_PID" 2>/dev/null || true
  kill "$STORYBOARD_PID" 2>/dev/null || true
  wait "$GATEWAY_PID" 2>/dev/null || true
  wait "$STORYBOARD_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 6. Wait briefly for gateway to come up.
for _ in $(seq 1 60); do
  if lsof -nP -iTCP:18789 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[family-shrimp] gateway listening on 127.0.0.1:18789"
    break
  fi
  sleep 0.5
done

# 7. Run the UI dev server in foreground (Ctrl-C terminates everything).
echo "[family-shrimp] starting ui dev server on http://localhost:5173 ..."
cd ui
exec pnpm dev
