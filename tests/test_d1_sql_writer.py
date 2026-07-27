import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.build_house_oversight_doj_d1_import import SqlWriter


class D1SqlWriterTests(unittest.TestCase):
    def test_chunked_insert_does_not_duplicate_flushed_rows(self):
        with tempfile.TemporaryDirectory(prefix="epstein-sql-writer-") as temp_dir:
            output = Path(temp_dir) / "import.sql"
            writer = SqlWriter(output)
            rows = [(1, "a" * 70), (2, "b" * 70), (3, "c" * 70)]
            with patch(
                "src.build_house_oversight_doj_d1_import.MAX_STATEMENT_BYTES",
                1_150,
            ):
                writer.insert_many("sample", ("id", "value"), rows)
            writer.close()

            sql = output.read_text()
            for row_id in (1, 2, 3):
                self.assertEqual(sql.count(f"({row_id},'"), 1)


if __name__ == "__main__":
    unittest.main()
