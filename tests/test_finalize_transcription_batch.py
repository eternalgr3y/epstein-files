import sqlite3
import tempfile
import unittest
from pathlib import Path

from finalize_transcription_batch import verify_local_indexes


class TranscriptionFinalizerTests(unittest.TestCase):
    def test_verifies_matching_text_and_fts_rows(self):
        with tempfile.TemporaryDirectory(prefix="epstein-finalizer-") as temp_dir:
            database = Path(temp_dir) / "test.db"
            connection = sqlite3.connect(database)
            connection.executescript(
                """
                CREATE TABLE document_texts (
                    id INTEGER PRIMARY KEY, document_id INTEGER UNIQUE,
                    full_text TEXT
                );
                CREATE VIRTUAL TABLE document_fts USING
                    fts5(document_id UNINDEXED, content);
                INSERT INTO document_texts VALUES (1, 7, 'searchable text');
                INSERT INTO document_fts(rowid,document_id,content)
                    VALUES (7,7,'searchable text');
                """
            )
            connection.close()

            result = verify_local_indexes(database)
            self.assertEqual(result["quick_check"], "ok")
            self.assertEqual(result["text_rows"], 1)
            self.assertEqual(result["fts_rows"], 1)
            self.assertEqual(result["fts_missing"], 0)
            self.assertEqual(result["fts_orphans"], 0)

    def test_rejects_an_orphaned_fts_row(self):
        with tempfile.TemporaryDirectory(prefix="epstein-finalizer-") as temp_dir:
            database = Path(temp_dir) / "test.db"
            connection = sqlite3.connect(database)
            connection.executescript(
                """
                CREATE TABLE document_texts (
                    id INTEGER PRIMARY KEY, document_id INTEGER UNIQUE,
                    full_text TEXT
                );
                CREATE VIRTUAL TABLE document_fts USING
                    fts5(document_id UNINDEXED, content);
                INSERT INTO document_fts(rowid,document_id,content)
                    VALUES (7,7,'orphaned text');
                """
            )
            connection.close()

            with self.assertRaises(RuntimeError):
                verify_local_indexes(database)


if __name__ == "__main__":
    unittest.main()
