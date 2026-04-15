#!/bin/bash
# Backup the SQLite database before any migration.
# Usage: ./scripts/backup-db.sh [label]
# Creates: prisma/backups/dev-YYYY-MM-DD-HHMMSS-label.db

set -euo pipefail

DB_PATH="prisma/dev.db"
BACKUP_DIR="prisma/backups"
LABEL="${1:-manual}"
TIMESTAMP=$(date +%Y-%m-%d-%H%M%S)
BACKUP_PATH="${BACKUP_DIR}/dev-${TIMESTAMP}-${LABEL}.db"

if [ ! -f "$DB_PATH" ]; then
  echo "No database found at $DB_PATH"
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# Use sqlite3 .backup for a consistent copy (handles WAL mode)
sqlite3 "$DB_PATH" ".backup '${BACKUP_PATH}'"

SIZE=$(du -h "$BACKUP_PATH" | cut -f1)
TABLES=$(sqlite3 "$BACKUP_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='table';")
echo "Backup created: ${BACKUP_PATH} (${SIZE}, ${TABLES} tables)"
