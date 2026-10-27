#!/bin/sh
# cloud/start.sh — runs the station sidecar (loopback only) and the login gateway (public) in one container.
# If either process dies, the container exits so Railway restarts it cleanly.
set -eu

DATA="${DATA_DIR:-/data}"
mkdir -p "$DATA/home" "$DATA/workspaces"

# Everything the station and Claude Code save lands on the persistent volume:
#  - HOME holds Claude Code's sign-in and the station's per-user files
#  - STARNET_WORKSPACES holds crews, conversations, routines and deliverables
export HOME="$DATA/home"
export STARNET_WORKSPACES="$DATA/workspaces"
export STARNET_PORT="${STARNET_PORT:-8787}"
export STARNET_CRON_ENABLED="${STARNET_CRON_ENABLED:-1}"      # scheduled routines run while you're away
export STARNET_UNCAUGHT_KEEP_SERVING="${STARNET_UNCAUGHT_KEEP_SERVING:-1}"
export STARNET_CHROME="${STARNET_CHROME:-/usr/bin/chromium}"  # the station browser agents drive
export STARNET_BROWSER_HEADLESS="${STARNET_BROWSER_HEADLESS:-1}"   # a server has no screen

cd /app
node sidecar/index.js &
SIDECAR=$!
node cloud/gateway.js &
GATEWAY=$!

# Stop both together on shutdown; exit if either one dies.
trap 'kill $SIDECAR $GATEWAY 2>/dev/null; wait' TERM INT
while kill -0 $SIDECAR 2>/dev/null && kill -0 $GATEWAY 2>/dev/null; do sleep 5; done
echo "[start] a process exited; shutting down so the platform restarts the container"
kill $SIDECAR $GATEWAY 2>/dev/null || true
wait || true
exit 1
