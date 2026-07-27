"""Local SQLite FTS5 index maintenance for extracted and transcribed text."""

import sqlite3
from pathlib import Path
from typing import Optional

from sqlalchemy import text

from config import DATABASE_PATH


CREATE_FTS_SQL = """
CREATE VIRTUAL TABLE IF NOT EXISTS document_fts
USING fts5(document_id UNINDEXED, content)
"""


def fts_table_exists(connection: sqlite3.Connection) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_fts'"
    ).fetchone()
    return row is not None


def rebuild_fts_index(database_path: Path = DATABASE_PATH) -> int:
    """Rebuild the local FTS index and return the number of indexed documents."""
    connection = sqlite3.connect(str(database_path))
    try:
        connection.execute(CREATE_FTS_SQL)
        connection.execute("DELETE FROM document_fts")
        connection.execute(
            """
            INSERT INTO document_fts(rowid, document_id, content)
            SELECT document_id, document_id, full_text
            FROM document_texts
            WHERE full_text IS NOT NULL AND trim(full_text) <> ''
            """
        )
        connection.execute("INSERT INTO document_fts(document_fts) VALUES('optimize')")
        count = connection.execute("SELECT COUNT(*) FROM document_fts").fetchone()[0]
        connection.commit()
        return count
    finally:
        connection.close()


def sync_fts_document(session, document_id: int, full_text: Optional[str]) -> bool:
    """Update one FTS row inside an existing SQLAlchemy transaction if present."""
    exists = session.execute(
        text(
            "SELECT 1 FROM sqlite_master "
            "WHERE type='table' AND name='document_fts'"
        )
    ).first()
    if not exists:
        return False

    session.execute(
        text("DELETE FROM document_fts WHERE rowid = :document_id"),
        {"document_id": document_id},
    )
    if full_text and full_text.strip():
        session.execute(
            text(
                "INSERT INTO document_fts(rowid, document_id, content) "
                "VALUES (:document_id, :document_id, :content)"
            ),
            {"document_id": document_id, "content": full_text},
        )
    return True

