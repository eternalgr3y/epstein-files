#!/bin/bash
# Import the generated OCR SQL chunks into the remote D1 database.
#
# Node must be on PATH: node_modules/.bin/wrangler has a `#!/usr/bin/env node`
# shebang, and under bun `wrangler` prints its banner, exits 0, and does
# nothing at all.
#
# Each chunk is atomic -- if one fails, D1 rolls that chunk back and the
# remaining chunks are skipped. Every statement is guarded by NOT EXISTS, so
# re-running after a partial import is safe.
set -euo pipefail

cd ~/projects/epstein-files

set -a
. ./.env
set +a

export PATH="$HOME/.local/node/bin:$PATH"

shopt -s nullglob
chunks=(ocr_import/ocr_import_*.sql)
if [ ${#chunks[@]} -eq 0 ]; then
    echo "no chunks in ocr_import/ -- run: python3 export_ocr_sql.py"
    exit 1
fi

echo "importing ${#chunks[@]} chunk(s) into epstein-files-db"
failed=0
for f in "${chunks[@]}"; do
    # Back-to-back imports race each other -- D1 answers "Not currently
    # importing anything" if the previous session has not settled. Retry with a
    # pause rather than aborting the run; every statement is NOT EXISTS-guarded
    # so a repeat is harmless.
    for attempt in 1 2 3; do
        if node_modules/.bin/wrangler d1 execute epstein-files-db \
               --remote --yes --file="$f" >/tmp/ocr-import-out.txt 2>&1; then
            rows=$(grep -oE '"rows_written": [0-9]+' /tmp/ocr-import-out.txt | tail -1)
            echo "  ok   $(basename "$f")  ${rows:-}"
            break
        fi
        if [ "$attempt" = 3 ]; then
            echo "  FAIL $(basename "$f") after 3 attempts:"
            tail -3 /tmp/ocr-import-out.txt | sed 's/^/       /'
            failed=$((failed + 1))
        else
            sleep 5
        fi
    done
    sleep 2
done
echo "done -- ${#chunks[@]} chunk(s), ${failed} failed"
[ "$failed" -eq 0 ]
