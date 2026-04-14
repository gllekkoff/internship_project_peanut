#!/bin/bash
# Starts a local Anvil fork of mainnet for simulation and testing.
#
# Requires: anvil (Foundry)
# Install:  curl -L https://foundry.paradigm.xyz | bash && foundryup
#
# Usage: ./scripts/start_fork.sh
# The fork RPC will be available at http://127.0.0.1:8545

set -euo pipefail

if [[ -z "${MAINNET_RPC_URL:-}" && -f ".env" ]]; then
  set -a
  source .env
  set +a
fi

if ! command -v anvil &> /dev/null; then
  echo "Error: anvil not found. Install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup"
  exit 1
fi

if [[ -z "${MAINNET_RPC_URL:-}" ]]; then
  echo "Error: MAINNET_RPC_URL environment variable is not set."
  exit 1
fi

anvil \
  --fork-url "$MAINNET_RPC_URL" \
  --port 8545 \
  --steps-tracing
