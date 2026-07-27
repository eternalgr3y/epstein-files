import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from fts_index import rebuild_fts_index


class FtsIndexTests(unittest.TestCase):
    def test_rebuild_uses_document_ids_as_rowids(self):
        with tempfile.TemporaryDirectory(prefix="epstein-fts-tests-") as temp_dir:
            database = Path(temp_dir) / "test.db"
            connection = sqlite3.connect(database)
            connection.execute(
                "CREATE TABLE document_texts "
                "(document_id INTEGER PRIMARY KEY, full_text TEXT)"
            )
            connection.executemany(
                "INSERT INTO document_texts(document_id, full_text) VALUES (?, ?)",
                [(7, "known searchable phrase"), (11, ""), (19, "other text")],
            )
            connection.commit()
            connection.close()

            count = rebuild_fts_index(database)
            self.assertEqual(count, 2)

            connection = sqlite3.connect(database)
            row = connection.execute(
                "SELECT rowid, document_id FROM document_fts "
                "WHERE document_fts MATCH 'searchable'"
            ).fetchone()
            connection.close()
            self.assertEqual(row, (7, 7))


if __name__ == "__main__":
    unittest.main()
