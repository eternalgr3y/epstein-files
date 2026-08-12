import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from import_house_oversight import get_content_type, get_document_type


class HouseOversightImportTests(unittest.TestCase):
    def test_native_video_keeps_its_document_and_content_types(self):
        document_type = get_document_type("mov", "IMG_0642.MP4.mov")
        self.assertEqual(document_type, "video")
        self.assertEqual(get_content_type("mov", document_type), "video/quicktime")

    def test_unknown_binary_is_not_mislabeled_as_jpeg(self):
        document_type = get_document_type("docx", "article.docx")
        self.assertEqual(get_content_type("docx", document_type), "application/octet-stream")


if __name__ == "__main__":
    unittest.main()
