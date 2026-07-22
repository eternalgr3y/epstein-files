#!/bin/bash
# Off-database backup of the production D1 database to the private R2 bucket
# epstein-files-backups.
#
# D1 Time Travel covers 30-day point-in-time restores, but not deletion of
# the database or loss of the account — this does. Keeps the newest $KEEP
# backups per table under d1/ in the bucket, pruning older ones.
#
# Every table goes through src/dump_table.py (paginated queries) because the
# D1 export API cannot dump this database — exports die server-side with no
# error message on large tables and on any multi-table export, and running
# ones lock the database against the live site. FTS5 virtual tables are
# skipped: D1 export can't handle them and they are rebuildable from
# document_texts / house_oversight_documents.
#
# Usage: ./backup_d1.sh   (scheduled weekly via the epstein-d1-backup
# systemd user timer; safe to run by hand any time)

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
set -a; source "$PROJECT_DIR/.env"; set +a

DB_NAME="epstein-files-db"
BUCKET="epstein-files-backups"
KEEP=8
STAMP="$(date +%F)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# table:rows_per_page — small pages for tables whose rows carry full OCR text.
TABLES=(
  "documents:2000"
  "document_texts:100"
  "entities:5000"
  "mentions:5000"
  "house_oversight_documents:500"
)

RC=(rclone --s3-provider Cloudflare --s3-endpoint "$R2_ENDPOINT_URL"
    --s3-access-key-id "$R2_ACCESS_KEY_ID" --s3-secret-access-key "$R2_SECRET_ACCESS_KEY"
    --s3-no-check-bucket --retries 5 -q)

for entry in "${TABLES[@]}"; do
  table="${entry%%:*}"
  page="${entry##*:}"
  out="$TMP/$DB_NAME-$table-$STAMP.sql.gz"
  python3 "$PROJECT_DIR/src/dump_table.py" "$table" "$out" "$page"
  "${RC[@]}" copy "$out" ":s3:$BUCKET/d1/"

  # Prune to the newest $KEEP dumps of this table (names sort by date stamp).
  "${RC[@]}" lsf ":s3:$BUCKET/d1/" | { grep "^$DB_NAME-$table-" || true; } |
    sort | head -n -"$KEEP" | while read -r old; do
      "${RC[@]}" deletefile ":s3:$BUCKET/d1/$old"
    done
done

echo "backup ok: $STAMP"
"${RC[@]}" lsf --format "sp" --separator "  " ":s3:$BUCKET/d1/" | grep -- "-$STAMP.sql.gz"
