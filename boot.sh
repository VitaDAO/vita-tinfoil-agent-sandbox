#!/bin/bash
set -euo pipefail

echo "[boot] Starting vita-sandbox..."

# Start OpenClaw gateway (background)
HOME=/home/user openclaw gateway run &
echo "[boot] Gateway starting..."

# Wait for gateway — fail hard if it never comes up
GW_READY=false
for i in $(seq 1 15); do
  if HOME=/home/user openclaw gateway health 2>/dev/null; then
    GW_READY=true
    echo "[boot] Gateway ready"
    break
  fi
  sleep 1
done

if [ "$GW_READY" != "true" ]; then
  echo "[boot] ERROR: Gateway failed to start after 15s. Exiting."
  exit 1
fi

# Start cron-watcher (background)
node /app/cron-watcher.js &
echo "[boot] Cron watcher started"

# Start HTTP server (foreground — keeps container alive)
echo "[boot] Starting HTTP server on :3000"
exec node /app/server.mjs
