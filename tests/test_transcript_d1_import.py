import sqlite3
import tempfile
import unittest
from pathlib import Path

from build_transcript_d1_import import build_import


class TranscriptD1ImportTests(unittest.TestCase):
    def test_builds_idempotent_mapped_transcript_sql(self):
        with tempfile.TemporaryDirectory(prefix="epstein-transcript-sql-") as temp_dir:
            root = Path(temp_dir)
            database = root / "source.db"
            output = root / "transcripts.sql"
            connection = sqlite3.connect(database)
            connection.execute(
                "CREATE TABLE documents (id INTEGER PRIMARY KEY, filename TEXT, "
                "ocr_confidence REAL, has_text INTEGER, processing_status TEXT)"
            )
            connection.execute(
                "CREATE TABLE document_texts "
                "(document_id INTEGER, full_text TEXT, word_count INTEGER, "
                "created_at TEXT, ocr_engine TEXT)"
            )
            connection.execute(
                "INSERT INTO documents VALUES (7, 'recording.wav', 0.8, 1, 'completed')"
            )
            connection.execute(
                "INSERT INTO document_texts VALUES (7, ?, 2, ?, ?)",
                ("searchable transcript", "2026-07-22", "faster-whisper:small.en"),
            )
            connection.commit()
            connection.close()

            result = build_import(database, output, document_id_offset=100)
            sql = output.read_text()
            self.assertEqual(result["transcripts"], 1)
            self.assertIn("WHERE id=107 AND filename='recording.wav'", sql)
            self.assertIn("ON CONFLICT(document_id) DO UPDATE", sql)
            self.assertIn("searchable transcript", sql)
            self.assertIn("DELETE FROM document_fts WHERE document_id=107", sql)

    def test_generated_sql_only_updates_a_matching_filename(self):
        with tempfile.TemporaryDirectory(prefix="epstein-transcript-guard-") as temp_dir:
            root = Path(temp_dir)
            source = root / "source.db"
            output = root / "transcripts.sql"
            connection = sqlite3.connect(source)
            connection.executescript(
                """
                CREATE TABLE documents (
                    id INTEGER PRIMARY KEY, filename TEXT, ocr_confidence REAL,
                    has_text INTEGER, processing_status TEXT
                );
                CREATE TABLE document_texts (
                    document_id INTEGER, full_text TEXT, word_count INTEGER,
                    created_at TEXT, ocr_engine TEXT
                );
                INSERT INTO documents VALUES
                    (7, 'recording.wav', 0.8, 1, 'completed');
                INSERT INTO document_texts VALUES
                    (7, 'searchable transcript', 2, '2026-07-22',
                     'faster-whisper:small.en');
                """
            )
            connection.commit()
            connection.close()

            build_import(source, output, document_id_offset=100)

            target = sqlite3.connect(root / "target.db")
            target.executescript(
                """
                CREATE TABLE documents (
                    id INTEGER PRIMARY KEY, filename TEXT, ocr_confidence REAL,
                    has_text INTEGER, processing_status TEXT
                );
                CREATE TABLE document_texts (
                    id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL UNIQUE,
                    full_text TEXT, pages_text TEXT, word_count INTEGER,
                    created_at TEXT
                );
                CREATE VIRTUAL TABLE document_fts USING
                    fts5(document_id UNINDEXED, full_text);
                INSERT INTO documents VALUES
                    (107, 'different.wav', NULL, 0, 'pending');
                """
            )
            target.executescript(output.read_text())
            self.assertEqual(
                target.execute(
                    "SELECT has_text, processing_status FROM documents WHERE id=107"
                ).fetchone(),
                (0, "pending"),
            )
            self.assertEqual(
                target.execute("SELECT COUNT(*) FROM document_texts").fetchone()[0],
                0,
            )
            self.assertEqual(
                target.execute("SELECT COUNT(*) FROM document_fts").fetchone()[0],
                0,
            )

            target.execute(
                "UPDATE documents SET filename='recording.wav' WHERE id=107"
            )
            target.executescript(output.read_text())
            target.executescript(output.read_text())
            self.assertEqual(
                target.execute(
                    "SELECT has_text, processing_status FROM documents WHERE id=107"
                ).fetchone(),
                (1, "completed"),
            )
            self.assertEqual(
                target.execute(
                    "SELECT COUNT(*), full_text FROM document_texts "
                    "WHERE document_id=107"
                ).fetchone(),
                (1, "searchable transcript"),
            )
            self.assertEqual(
                target.execute(
                    "SELECT COUNT(*) FROM document_fts WHERE document_id=107"
                ).fetchone()[0],
                1,
            )
            target.close()


if __name__ == "__main__":
    unittest.main()
