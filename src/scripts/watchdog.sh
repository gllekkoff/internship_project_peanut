#!/usr/bin/env bash
# watchdog.sh — Dead man's switch for arb_bot
#
# Kills the bot if the heartbeat file is stale (bot frozen/hung).
# Add to cron to run every minute:
#   * * * * * /path/to/src/scripts/watchdog.sh >> /tmp/arb_bot_watchdog.log 2>&1

HEARTBEAT_FILE="/tmp/arb_bot_heartbeat"
KILL_SWITCH_FILE="/tmp/arb_bot_kill"
MAX_AGE_S=120  # 2 minutes — bot writes every 30s, so 4 missed beats = stale

if [ ! -f "$HEARTBEAT_FILE" ]; then
  echo "[watchdog] $(date -u +%FT%TZ) No heartbeat file — bot not running or never started"
  exit 0
fi

LAST_BEAT_MS=$(cat "$HEARTBEAT_FILE")
NOW_MS=$(date +%s%3N)
AGE_S=$(( (NOW_MS - LAST_BEAT_MS) / 1000 ))

if [ "$AGE_S" -gt "$MAX_AGE_S" ]; then
  echo "[watchdog] $(date -u +%FT%TZ) Bot unresponsive for ${AGE_S}s (max ${MAX_AGE_S}s) — activating kill switch"
  touch "$KILL_SWITCH_FILE"
else
  echo "[watchdog] $(date -u +%FT%TZ) Heartbeat OK — last beat ${AGE_S}s ago"
fi
