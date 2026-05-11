#!/usr/bin/env bash
set -euo pipefail

# Load .env from project root (two levels up from src/scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [ -f "$ROOT_DIR/.env" ]; then
  set -o allexport
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +o allexport
fi

FORK_PORT="${FORK_PORT:-8545}"
ANVIL_PID=""

cleanup() {
  if [ -n "$ANVIL_PID" ] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    echo "Stopping Anvil (pid $ANVIL_PID)..."
    kill "$ANVIL_PID"
  fi
}
trap cleanup EXIT INT TERM

echo "Starting Anvil fork of Arbitrum (port $FORK_PORT)..."
anvil \
  --fork-url "$MAINNET_RPC_URL" \
  --port "$FORK_PORT" \
  --no-mining \
  --silent &
ANVIL_PID=$!

# Wait up to 10s for Anvil to accept connections
echo -n "Waiting for Anvil..."
for i in $(seq 1 20); do
  if curl -sf -X POST \
      -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
      "http://127.0.0.1:$FORK_PORT" > /dev/null 2>&1; then
    echo " ready."
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo " timed out — Anvil did not start."
    exit 1
  fi
  sleep 0.5
done

echo "Starting bot..."
npm run start:bot -- "$@"
