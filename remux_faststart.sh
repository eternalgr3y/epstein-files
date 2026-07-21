#!/bin/bash
# Create faststart (moov-first) streaming copies of all video MP4s in R2.
#
# Originals are never modified: each remux is uploaded to streaming/<key>,
# which the worker prefers for document_type='video' and falls back from.
# Safe to re-run: keys that already have a streaming copy are skipped.
#
# Usage: ./remux_faststart.sh [--dry-run]

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
set -a; source "$PROJECT_DIR/.env"; set +a

BUCKET="epstein-files"
TMP_DIR="$HOME/remux-tmp"
LOG="$TMP_DIR/remux.log"
DRY_RUN="${1:-}"

RC=(rclone --s3-provider Cloudflare --s3-endpoint "$R2_ENDPOINT_URL"
    --s3-access-key-id "$R2_ACCESS_KEY_ID" --s3-secret-access-key "$R2_SECRET_ACCESS_KEY"
    --s3-no-check-bucket --retries 5 --low-level-retries 20 -q)

mkdir -p "$TMP_DIR"
log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

first_atom() {
  # Prints "moov" or "mdat", whichever appears first in the opening bytes.
  head -c 1024 "$1" | grep -a -o -m1 -E 'moov|mdat'
}

duration_of() {
  ffprobe -v error -show_entries format=duration -of csv=p=0 "$1" 2>/dev/null | cut -d. -f1
}

log "=== remux run started (dry_run='${DRY_RUN}') ==="

# Work list: every .mp4 in the bucket outside streaming/, smallest first.
WORKLIST="$TMP_DIR/worklist.txt"
"${RC[@]}" lsf -R --files-only --format "sp" --separator ';' --include "*.mp4" ":s3:$BUCKET" \
  | grep -v ';streaming/' | sort -t';' -k1,1n > "$WORKLIST"
TOTAL=$(wc -l < "$WORKLIST")
log "found $TOTAL mp4 objects to consider"

DONE=0 SKIPPED=0 FAILED=0 ALREADY_FAST=0
while IFS=';' read -r SIZE KEY; do
  [ -z "$KEY" ] && continue

  if [ -n "$("${RC[@]}" lsf ":s3:$BUCKET/streaming/$KEY" 2>/dev/null)" ]; then
    SKIPPED=$((SKIPPED+1)); continue
  fi

  FREE=$(df --output=avail -B1 "$TMP_DIR" | tail -1)
  if [ "$FREE" -lt $((SIZE * 5 / 2)) ]; then
    log "SKIP (disk) $KEY: need $((SIZE*5/2)) free, have $FREE"
    FAILED=$((FAILED+1)); continue
  fi

  if [ "$DRY_RUN" = "--dry-run" ]; then
    log "DRY $KEY ($SIZE bytes)"; continue
  fi

  IN="$TMP_DIR/in.mp4"; OUT="$TMP_DIR/out.mp4"
  rm -f "$IN" "$OUT"

  if ! "${RC[@]}" copyto ":s3:$BUCKET/$KEY" "$IN" < /dev/null; then
    log "FAIL (download) $KEY"; FAILED=$((FAILED+1)); continue
  fi

  if [ "$(first_atom "$IN")" = "moov" ]; then
    log "ALREADY-FASTSTART $KEY (original is fine, no copy needed)"
    ALREADY_FAST=$((ALREADY_FAST+1)); rm -f "$IN"; continue
  fi

  if ! ffmpeg -nostdin -v error -i "$IN" -map 0 -c copy -movflags +faststart "$OUT"; then
    log "FAIL (ffmpeg) $KEY"; FAILED=$((FAILED+1)); rm -f "$IN" "$OUT"; continue
  fi

  IN_DUR=$(duration_of "$IN"); OUT_DUR=$(duration_of "$OUT")
  IN_SZ=$(stat -c%s "$IN"); OUT_SZ=$(stat -c%s "$OUT")
  if [ "$(first_atom "$OUT")" != "moov" ] \
     || [ -z "$OUT_DUR" ] || [ "${IN_DUR:-0}" -ne "$OUT_DUR" ] \
     || [ "$OUT_SZ" -lt $((IN_SZ * 9 / 10)) ]; then
    log "FAIL (verify) $KEY: dur $IN_DUR->$OUT_DUR size $IN_SZ->$OUT_SZ atom $(first_atom "$OUT")"
    FAILED=$((FAILED+1)); rm -f "$IN" "$OUT"; continue
  fi

  if ! "${RC[@]}" copyto "$OUT" ":s3:$BUCKET/streaming/$KEY" < /dev/null; then
    log "FAIL (upload) $KEY"; FAILED=$((FAILED+1)); rm -f "$IN" "$OUT"; continue
  fi
  REMOTE_SZ=$("${RC[@]}" lsf --format "s" ":s3:$BUCKET/streaming/$KEY")
  if [ "$REMOTE_SZ" != "$OUT_SZ" ]; then
    log "FAIL (upload size) $KEY: local $OUT_SZ remote $REMOTE_SZ"
    "${RC[@]}" deletefile ":s3:$BUCKET/streaming/$KEY" 2>/dev/null
    FAILED=$((FAILED+1)); rm -f "$IN" "$OUT"; continue
  fi

  rm -f "$IN" "$OUT"
  DONE=$((DONE+1))
  log "OK $KEY ($IN_SZ -> $OUT_SZ bytes) [$DONE done, $SKIPPED skipped, $FAILED failed]"
done < "$WORKLIST"

log "=== finished: $DONE remuxed, $ALREADY_FAST already-faststart, $SKIPPED previously done, $FAILED failed, of $TOTAL total ==="
