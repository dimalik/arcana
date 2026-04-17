#!/bin/bash
set -euo pipefail

# Poll all active batches and process results.
# Usage:
#   ARCANA_SESSION=... ./scripts/poll-batches.sh
#   ARCANA_SESSION=... BATCH_BASE_URL=http://localhost:3000/api/papers/maintenance/batch ./scripts/poll-batches.sh

SESSION="${ARCANA_SESSION:?ARCANA_SESSION must be set}"
BASE="${BATCH_BASE_URL:-http://localhost:3000/api/papers/maintenance/batch}"

echo "$(date): Polling active batches..."
RESULT=$(curl -sS -b "arcana_session=$SESSION" "$BASE" -X POST -H "Content-Type: application/json" -d '{"action":"poll"}')
echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"
