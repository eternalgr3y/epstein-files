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
for f in "${chunks[@]}"; do
    echo "--- $f"
    node_modules/.bin/wrangler d1 execute epstein-files-db \
        --remote --yes --file="$f"
done
echo "done -- ${#chunks[@]} chunk(s) imported"
