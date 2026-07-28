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
    # Chunking by document count produced a 2.3 MB file that wrangler rejected
    # with "statement too long: SQLITE_TOOBIG". Document text varies from a few
    # hundred characters to 236k, so a fixed document count says nothing about
    # file size -- budget bytes instead.
    ap.add_argument("--chunk-bytes", type=int, default=400_000,
                    help="approximate maximum bytes of SQL per file")
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

    # D1 rejects statements over roughly 32-52 KB with "statement too long:
    # SQLITE_TOOBIG" (measured: 32,071 chars imported, 52,150 failed), and
    # documents run to 236k chars. So text goes in as one INSERT carrying the
    # first piece, then UPDATEs appending the rest, each statement small.
    #
    # Every statement is idempotent. The INSERT is NOT EXISTS-guarded, and each
    # append only fires when full_text is exactly the prefix it expects -- so a
    # re-run after a partial import cannot double-append, which a plain
    # "append if the row is ours" guard would.
    PIECE = 20_000

    def statements_for(doc_id, text):
        pieces = [text[i:i + PIECE] for i in range(0, len(text), PIECE)] or ['']
        words = len(text.split())
        out = [
            f"INSERT INTO document_texts "
            f"(document_id, full_text, pages_text, word_count, created_at) "
            f"SELECT {doc_id}, {sql_str(pieces[0])}, NULL, {words}, {sql_str(TAG)} "
            f"WHERE NOT EXISTS (SELECT 1 FROM document_texts "
            f"WHERE document_id = {doc_id});"
        ]
        prefix = len(pieces[0])
        for piece in pieces[1:]:
            out.append(
                f"UPDATE document_texts SET full_text = full_text || {sql_str(piece)} "
                f"WHERE document_id = {doc_id} AND created_at = {sql_str(TAG)} "
                f"AND length(full_text) = {prefix};"
            )
            prefix += len(piece)
        # Copy into the search index server-side rather than resending the text.
        out.append(
            f"INSERT INTO document_fts (document_id, full_text) "
            f"SELECT document_id, full_text FROM document_texts "
            f"WHERE document_id = {doc_id} "
            f"AND NOT EXISTS (SELECT 1 FROM document_fts "
            f"WHERE document_id = {doc_id});"
        )
        return out

    files, total_chars, docs_in_chunk = 0, 0, 0
    buf, buf_bytes, first_id, last_id = [], 0, None, None

    def flush():
        nonlocal files, buf, buf_bytes, docs_in_chunk, first_id
        if not buf:
            return
        files += 1
        path = out_dir / f"ocr_import_{files:03d}.sql"
        header = (
            f"-- OCR backfill chunk {files}: documents {first_id}..{last_id} "
            f"({docs_in_chunk} rows)\n"
            "-- Guarded against re-running: rows that already have text are skipped.\n\n"
        )
        path.write_text(header + "\n".join(buf) + "\n")
        print(f"{path}  ({docs_in_chunk} docs, {path.stat().st_size / 1e6:.2f} MB)")
        buf, buf_bytes, docs_in_chunk, first_id = [], 0, 0, None

    for doc_id, text in rows:
        stmts = statements_for(doc_id, text)
        size = sum(len(s) for s in stmts)
        # Keep each file under the budget, but never split one document's
        # statements across files -- a document larger than the budget simply
        # gets a file of its own.
        if buf and buf_bytes + size > args.chunk_bytes:
            flush()
        if first_id is None:
            first_id = doc_id
        last_id = doc_id
        buf.extend(stmts)
        buf_bytes += size
        docs_in_chunk += 1
        total_chars += len(text)
    flush()

    print(f"\n{len(rows)} documents, {total_chars / 1e6:.1f} M chars, {files} file(s)")
    print("import each with:")
    print("  ./import-ocr.sh")
    print(f"\nrollback:  DELETE FROM document_texts WHERE created_at = '{TAG}';")


if __name__ == "__main__":
    main()
