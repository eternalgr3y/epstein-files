import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from ocr_pipeline import process_document


SPARSE_EXHIBIT = (
    ROOT / "raw" / "house-oversight-doj" / "DOJ-OGR-00015650.pdf"
)
TEXTURED_EXHIBIT = (
    ROOT / "raw" / "house-oversight-doj" / "DOJ-OGR-00015588.pdf"
)
RUN_REAL_DATA_TESTS = os.getenv("RUN_REAL_DATA_TESTS") == "1"


class OcrRealDataTests(unittest.TestCase):
    @unittest.skipUnless(
        RUN_REAL_DATA_TESTS and SPARSE_EXHIBIT.exists(),
        "set RUN_REAL_DATA_TESTS=1 with the local House DOJ batch available",
    )
    def test_sparse_photo_recovers_exhibit_and_bates_labels(self):
        result = process_document(
            SimpleNamespace(
                local_path=str(SPARSE_EXHIBIT),
                filename=SPARSE_EXHIBIT.name,
                content_type="application/pdf",
            )
        )
        self.assertTrue(result.success)
        self.assertIn("EXHIBIT", result.full_text.upper())
        self.assertIn("15650", result.full_text)
        self.assertGreater(result.average_confidence, 0.5)

    @unittest.skipUnless(
        RUN_REAL_DATA_TESTS and TEXTURED_EXHIBIT.exists(),
        "set RUN_REAL_DATA_TESTS=1 with the local House DOJ batch available",
    )
    def test_photo_texture_is_not_promoted_to_hundreds_of_words(self):
        result = process_document(
            SimpleNamespace(
                local_path=str(TEXTURED_EXHIBIT),
                filename=TEXTURED_EXHIBIT.name,
                content_type="application/pdf",
            )
        )
        self.assertTrue(result.success)
        self.assertIn("EXHIBIT", result.full_text.upper())
        self.assertIn("15588", result.full_text)
        self.assertGreater(result.average_confidence, 0.5)
        self.assertLess(result.word_count, 50)


if __name__ == "__main__":
    unittest.main()
