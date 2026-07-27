#!/usr/bin/env python3
"""Turn ocr_backfill_state.db into SQL files ready for D1 import.

Writes both tables the site reads from:
  * document_texts -- what /api/documents/<id> and /<id>/text serve
  * document_fts   -- what /api/search matches against

Only rows with status='done' are exported. 'empty' means the scan genuinely
produced no text (image-only page), and 'failed' means the document could not
be processed -- neither should create a document_texts row, because the worker
now derives has_text from that table and would start advertising text that
does not exist. That is precisely the bug this whole effort removed.

Unlike the earlier FTS backfill, word_count is computed properly here: the
text is in hand in Python, so it is a real token count rather than a SQLite
space-counting approximation.

Output is chunked so no single file is unwieldy:
    ocr_import/ocr_import_001.sql, _002.sql, ...

Usage:
    python3 export_ocr_sql.py
    python3 export_ocr_sql.py --chunk-size 300 --out-dir ocr_import
"""

import argparse
import sqlite3
from pathlib import Path

STATE_DB = Path(__file__).parent / "ocr_backfill_state.db"
TAG = "2026-07-27 ocr-backfill"


def sql_str(value):
    """SQLite string literal. NULs are illegal in TEXT, so drop them."""
    return "'" + str(value).replace("\x00", "").replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--state-db", default=str(STATE_DB))
    ap.add_argument("--out-dir", default="ocr_import")
    ap.add_argument("--chunk-size", type=int, default=300,
                    help="documents per .sql file")
    args = ap.parse_args()

    conn = sqlite3.connect(args.state_db)
    rows = conn.execute(
        """
        SELECT document_id, full_text
        FROM ocr_result
        WHERE status = 'done' AND full_text IS NOT NULL AND full_text != ''
        ORDER BY document_id
        """
    ).fetchall()

    if not rows:
        print("nothing to export (no rows with status='done')")
        return

    out_dir = Path(args.out_dir)
    out_dir.mkdir(exist_ok=True)
    for stale in out_dir.glob("ocr_import_*.sql"):
        stale.unlink()

    files, total_chars = 0, 0
    for start in range(0, len(rows), args.chunk_size):
        chunk = rows[start:start + args.chunk_size]
        files += 1
        path = out_dir / f"ocr_import_{files:03d}.sql"

        lines = [
            f"-- OCR backfill chunk {files}: documents "
            f"{chunk[0][0]}..{chunk[-1][0]} ({len(chunk)} rows)",
            "-- Guarded against re-running: rows that already have text are skipped.",
            "",
        ]
        for doc_id, text in chunk:
            total_chars += len(text)
            lit = sql_str(text)
            words = len(text.split())
            lines.append(
                f"INSERT INTO document_texts "
                f"(document_id, full_text, pages_text, word_count, created_at) "
                f"SELECT {doc_id}, {lit}, NULL, {words}, {sql_str(TAG)} "
                f"WHERE NOT EXISTS (SELECT 1 FROM document_texts "
                f"WHERE document_id = {doc_id});"
            )
            lines.append(
                f"INSERT INTO document_fts (document_id, full_text) "
                f"SELECT {doc_id}, {lit} "
                f"WHERE NOT EXISTS (SELECT 1 FROM document_fts "
                f"WHERE document_id = {doc_id});"
            )
        path.write_text("\n".join(lines) + "\n")
        print(f"{path}  ({len(chunk)} docs, {path.stat().st_size / 1e6:.1f} MB)")

    print(f"\n{len(rows)} documents, {total_chars / 1e6:.1f} M chars, {files} file(s)")
    print("import each with:")
    print("  ./import-ocr.sh")
    print(f"\nrollback:  DELETE FROM document_texts WHERE created_at = '{TAG}';")


if __name__ == "__main__":
    main()
