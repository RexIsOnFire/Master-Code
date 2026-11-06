#!/usr/bin/env bash
# Starts Master Code on macOS and Linux. The exe is Windows-only; this is the
# equivalent, and it is what the launcher does underneath.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Master Code needs Node 22.6 or newer: https://nodejs.org" >&2
  exit 1
fi

[ $# -gt 0 ] && cd "$1"

url="http://127.0.0.1:${MASTERCODE_PORT:-4488}/"
( sleep 2; (command -v xdg-open >/dev/null && xdg-open "$url") || (command -v open >/dev/null && open "$url") || true ) >/dev/null 2>&1 &
exec node "$root/packages/server/src/main.ts"
