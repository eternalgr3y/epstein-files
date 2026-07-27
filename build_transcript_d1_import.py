#!/usr/bin/env python3
"""Build an idempotent D1 SQL import for local media transcripts."""

import argparse
import sqlite3
from pathlib import Path

from src.build_house_oversight_doj_d1_import import (
    MAX_TEXT_ROW_BYTES,
    SqlWriter,
    sql_literal,
    truncate_utf8,
    utf8_chunks,
)
from src.config import DATABASE_PATH, PROCESSED_DIR


DEFAULT_DOCUMENT_ID_OFFSET = 20_912


def build_import(database, output, document_id_offset=DEFAULT_DOCUMENT_ID_OFFSET):
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    rows = connection.execute(
        """
        SELECT d.id AS document_id, d.filename, d.ocr_confidence, t.full_text,
               t.word_count, t.created_at
        FROM documents d
        JOIN document_texts t ON t.document_id = d.id
        WHERE t.ocr_engine LIKE 'faster-whisper:%'
          AND t.full_text IS NOT NULL
          AND trim(t.full_text) <> ''
        ORDER BY d.id
        """
    ).fetchall()

    output.parent.mkdir(parents=True, exist_ok=True)
    writer = SqlWriter(output)
    writer.write("PRAGMA defer_foreign_keys=TRUE")
    truncated = []
    for row in rows:
        production_document_id = document_id_offset + row["document_id"]
        filename = sql_literal(row["filename"])
        target_matches = (
            f"EXISTS (SELECT 1 FROM documents WHERE id={production_document_id} "
            f"AND filename={filename})"
        )
        full_text = row["full_text"] or ""
        bounded_text = truncate_utf8(full_text, MAX_TEXT_ROW_BYTES)
        if len(bounded_text.encode("utf-8")) < len(full_text.encode("utf-8")):
            truncated.append(production_document_id)

        writer.write(
            "UPDATE documents SET "
            f"has_text=1,processing_status='completed',"
            f"ocr_confidence={sql_literal(row['ocr_confidence'])} "
            f"WHERE id={production_document_id} AND filename={filename}"
        )
        writer.write(
            "INSERT INTO document_texts "
            "(document_id,full_text,pages_text,word_count,created_at) SELECT "
            f"{production_document_id},'',NULL,{row['word_count']},"
            f"{sql_literal(row['created_at'])} WHERE {target_matches} "
            "ON CONFLICT(document_id) DO UPDATE SET "
            "full_text='',pages_text=NULL,"
            f"word_count={row['word_count']}"
        )
        for chunk in utf8_chunks(bounded_text):
            writer.write(
                "UPDATE document_texts SET full_text=full_text||"
                f"{sql_literal(chunk)} WHERE document_id={production_document_id} "
                f"AND {target_matches}"
            )
        writer.write(
            f"DELETE FROM document_fts WHERE document_id={production_document_id} "
            f"AND {target_matches}"
        )
        writer.write(
            "INSERT INTO document_fts(document_id,full_text) "
            "SELECT t.document_id,t.full_text FROM document_texts t "
            "JOIN documents d ON d.id=t.document_id "
            f"WHERE t.document_id={production_document_id} AND d.filename={filename}"
        )

    writer.close()
    connection.close()
    return {
        "transcripts": len(rows),
        "truncated_document_ids": truncated,
        "statements": writer.statements,
        "max_statement_bytes": writer.max_bytes,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=DATABASE_PATH)
    parser.add_argument(
        "--output",
        type=Path,
        default=PROCESSED_DIR / "house-doj-transcripts.sql",
    )
    parser.add_argument(
        "--document-id-offset", type=int, default=DEFAULT_DOCUMENT_ID_OFFSET
    )
    args = parser.parse_args()
    result = build_import(args.database, args.output, args.document_id_offset)
    print(f"Transcripts: {result['transcripts']:,}")
    print(f"Truncated: {result['truncated_document_ids']}")
    print(f"SQL statements: {result['statements']:,}")
    print(f"Largest statement: {result['max_statement_bytes']:,} bytes")
    print(f"Output: {args.output} ({args.output.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
