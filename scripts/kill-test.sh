#!/usr/bin/env sh
# The autosave kill test (package 00): type into Petrel, lose the process, see what survived.
#
#   scripts/kill-test.sh [SECONDS] [PETREL_BINARY]
#
# Starts Petrel on a fresh temporary database, gives you SECONDS (default 8) to type, then kills it with
# SIGKILL - no shutdown hook runs - and prints every draft the database holds. The last burst of typing
# (up to 300 ms, AUTOSAVE_MS in src/App.tsx) may be missing; anything older must be there.
set -eu
SECONDS_TO_TYPE="${1:-8}"
BIN="${2:-./target/release/petrel}"
if [ ! -x "$BIN" ]; then
  echo "no binary at $BIN; build with 'npm run tauri build' or pass the path" >&2
  exit 2
fi
DB="$(mktemp -d)/petrel.db"
echo "database: $DB"
PETREL_DB="$DB" "$BIN" &
PID=$!
echo "Petrel is up (pid $PID). Type into it for $SECONDS_TO_TYPE seconds..."
sleep "$SECONDS_TO_TYPE"
kill -9 "$PID"
wait "$PID" 2>/dev/null || true
echo "killed. What survived:"
sqlite3 "$DB" "SELECT id, modified_at, quote(content) FROM drafts;" 2>/dev/null || {
  echo "(sqlite3 not installed; open $DB with any SQLite tool)"
}
