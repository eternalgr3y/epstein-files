import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from ocr_evaluation import edit_distance, evaluate_manifest, score_pair


class OcrEvaluationTests(unittest.TestCase):
    def test_edit_distance_handles_characters_and_words(self):
        self.assertEqual(edit_distance("kitten", "sitting"), 3)
        self.assertEqual(edit_distance(["one", "two"], ["one", "too"]), 1)
        self.assertEqual(edit_distance("", "three"), 5)
        self.assertEqual(edit_distance("identical", "identical"), 0)

    def test_score_pair_reports_cer_and_wer(self):
        score = score_pair("known text", "known test")
        self.assertEqual(score["character_errors"], 1)
        self.assertEqual(score["word_errors"], 1)
        self.assertAlmostEqual(score["cer"], 0.1)
        self.assertAlmostEqual(score["wer"], 0.5)

    def test_evaluate_manifest_reports_pages_bands_and_skips(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            database = root / "test.db"
            connection = sqlite3.connect(database)
            connection.execute(
                "CREATE TABLE document_texts (document_id INTEGER, pages_text TEXT)"
            )
            connection.execute(
                "INSERT INTO document_texts VALUES (?, ?)",
                (7, json.dumps(["known test"])),
            )
            connection.commit()
            connection.close()

            truth = root / "truth.txt"
            truth.write_text("known text", encoding="utf-8")
            manifest = root / "manifest.jsonl"
            entries = [
                {
                    "document_id": 7,
                    "page_number": 1,
                    "confidence": 0.95,
                    "confidence_band": "0.90-plus",
                    "ground_truth_path": str(truth),
                },
                {
                    "document_id": 8,
                    "page_number": 1,
                    "confidence": 0.45,
                    "confidence_band": "under-0.50",
                    "ground_truth_path": str(root / "missing.txt"),
                },
            ]
            manifest.write_text(
                "".join(json.dumps(entry) + "\n" for entry in entries),
                encoding="utf-8",
            )

            report = evaluate_manifest(database, manifest)

        self.assertEqual(report["pages"], 1)
        self.assertEqual(report["manifest_pages"], 2)
        self.assertEqual(report["skipped_pages"], 1)
        self.assertEqual(report["by_confidence_band"]["0.90-plus"]["pages"], 1)
        self.assertEqual(report["by_confidence_band"]["under-0.50"]["pages"], 0)
        self.assertEqual(report["page_results"][0]["document_id"], 7)


if __name__ == "__main__":
    unittest.main()
