import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import fitz
from PIL import Image, ImageDraw, ImageFont

import ocr_pipeline
from fts_index import rebuild_fts_index
from models import Document, DocumentText, create_tables, get_engine, get_session
from redaction_detector import RedactionDetector, RedactionStatus


class OcrPipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix="epstein-ocr-tests-")
        self.root = Path(self.temp_dir.name)
        self.font = ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 42
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def _save_pdf(self, name, builder):
        path = self.root / name
        document = fitz.open()
        builder(document)
        document.save(path)
        document.close()
        return path

    @staticmethod
    def _doc(path):
        return SimpleNamespace(
            local_path=str(path),
            filename=path.name,
            content_type="application/pdf",
        )

    def _text_image(self, text):
        image = Image.new("RGB", (1500, 500), "white")
        ImageDraw.Draw(image).text((50, 180), text, fill="black", font=self.font)
        stream = io.BytesIO()
        image.save(stream, "PNG")
        return stream.getvalue()

    def _hidden_text_pdf(self, name, overlay):
        hidden = "Source release includes selectable text beneath this overlay."
        rect = fitz.Rect(65, 75, 560, 120)

        def builder(document):
            page = document.new_page()
            page.insert_text((72, 106), hidden, fontsize=16)
            overlay(page, rect)

        return self._save_pdf(name, builder)

    def test_tesseract_string_confidences_are_supported(self):
        text, confidence = ocr_pipeline._text_and_confidence(
            {"text": ["", "known", "text"], "conf": ["-1", "95.5", "84"]}
        )
        self.assertEqual(text, "known text")
        self.assertAlmostEqual(confidence, 0.8975)

    def test_selected_pages_are_split_into_bounded_contiguous_batches(self):
        with patch.object(ocr_pipeline, "OCR_PAGE_BATCH_SIZE", 3):
            batches = list(ocr_pipeline._contiguous_batches([1, 2, 3, 4, 8, 9]))
        self.assertEqual(batches, [[1, 2, 3], [4], [8, 9]])

    def test_sparse_layout_fallback_recovers_text(self):
        empty = {"text": [""], "conf": ["-1"]}
        sparse = {
            "text": ["GOVERNMENT", "EXHIBIT", "328"],
            "conf": ["94", "91", "88"],
        }
        with patch.object(
            ocr_pipeline.pytesseract,
            "image_to_data",
            side_effect=[empty, sparse],
        ) as image_to_data:
            text, confidence = ocr_pipeline._ocr_image(object())

        self.assertEqual(text, "GOVERNMENT EXHIBIT 328")
        self.assertAlmostEqual(confidence, 0.91)
        self.assertEqual(image_to_data.call_count, 2)
        self.assertEqual(image_to_data.call_args_list[1].kwargs["config"], "--psm 11")

    def test_sparse_layout_prefers_reliable_border_text_over_scene_noise(self):
        scene_noise = {
            "text": [f"noise-{number}" for number in range(20)],
            "conf": ["25"] * 20,
        }
        bottom_label = {
            "text": ["GOVERNMENT", "EXHIBIT", "328", "DOJ-OGR-00015650"],
            "conf": ["94", "91", "88", "85"],
        }
        right_label = {
            "text": ["EXHIBIT", "328"],
            "conf": ["93", "90"],
        }
        with patch.object(
            ocr_pipeline.pytesseract,
            "image_to_data",
            side_effect=[scene_noise, scene_noise, bottom_label, right_label],
        ):
            text, confidence = ocr_pipeline._ocr_image(Image.new("RGB", (100, 100)))

        self.assertIn("DOJ-OGR-00015650", text)
        self.assertGreater(confidence, 0.8)

    def test_low_confidence_dense_body_text_is_not_replaced_by_a_margin(self):
        body = {
            "text": ["This", "is", "a", "dense", "body", "line"],
            "conf": ["40"] * 6,
            "block_num": [1] * 6,
            "par_num": [1] * 6,
            "line_num": [1] * 6,
        }
        with patch.object(
            ocr_pipeline.pytesseract,
            "image_to_data",
            return_value=body,
        ) as image_to_data:
            text, confidence = ocr_pipeline._ocr_image(Image.new("RGB", (100, 100)))

        self.assertEqual(text, "This is a dense body line")
        self.assertAlmostEqual(confidence, 0.4)
        image_to_data.assert_called_once()

    def test_mixed_pdf_uses_native_text_and_ocrs_scanned_pages(self):
        scanned_phrase = "UNIQUE SCANNED PAGE PHRASE 90210"
        image_bytes = self._text_image(scanned_phrase)

        def builder(document):
            page = document.new_page()
            page.insert_textbox(
                fitz.Rect(72, 72, 540, 180),
                "This native page contains enough searchable text to use native extraction.",
                fontsize=16,
            )
            page = document.new_page()
            page.insert_image(page.rect, stream=image_bytes)

        path = self._save_pdf("mixed.pdf", builder)
        result = ocr_pipeline.process_document(self._doc(path))

        self.assertTrue(result.success)
        self.assertEqual(result.method, "hybrid")
        self.assertEqual(len(result.pages_text), 2)
        self.assertIn("native page", result.pages_text[0])
        self.assertIn("UNIQUE SCANNED PAGE PHRASE", result.pages_text[1])

    def test_sparse_native_text_is_not_replaced_without_material_ocr_gain(self):
        def builder(document):
            page = document.new_page()
            page.insert_text((72, 106), "Case 123", fontsize=16)

        path = self._save_pdf("sparse-native.pdf", builder)
        with patch.object(
            ocr_pipeline,
            "extract_text_from_pdf_pages_ocr",
            return_value={0: ("Case 128", 0.90)},
        ):
            pages, confidence, method = ocr_pipeline.extract_text_from_pdf_hybrid(path)

        self.assertEqual(method, "native")
        self.assertIn("Case 123", pages[0])
        self.assertNotIn("Case 128", pages[0])
        self.assertEqual(confidence, 1.0)

    def test_redaction_annotation_and_dark_image_overlays_are_detected(self):
        annotation = self._hidden_text_pdf(
            "annotation.pdf",
            lambda page, rect: page.add_redact_annot(rect, fill=(0, 0, 0)),
        )
        black_image = Image.new("RGB", (600, 80), "black")
        black_stream = io.BytesIO()
        black_image.save(black_stream, "PNG")
        raster = self._hidden_text_pdf(
            "raster.pdf",
            lambda page, rect: page.insert_image(
                rect, stream=black_stream.getvalue(), overlay=True
            ),
        )

        detector = RedactionDetector()
        for path in (annotation, raster):
            with self.subTest(path=path.name):
                report = detector.detect_improper_redactions(str(path))
                self.assertEqual(report.status, RedactionStatus.IMPROPER_REDACTION)
                self.assertFalse(report.is_safe_to_index)
                self.assertEqual(len(report.issues), 1)

    def test_warn_policy_indexes_source_content_and_retains_warning(self):
        path = self._hidden_text_pdf(
            "vector.pdf",
            lambda page, rect: page.draw_rect(
                rect, color=(0, 0, 0), fill=(0, 0, 0), overlay=True
            ),
        )
        with patch.dict(os.environ, {"REDACTION_POLICY": "warn"}):
            result = ocr_pipeline.process_document(self._doc(path))

        self.assertTrue(result.success)
        self.assertIn("selectable text", result.full_text)
        self.assertEqual(result.redaction_status, "improper")
        self.assertFalse(result.redaction_safe_to_index)

    def test_block_policy_remains_available(self):
        path = self._hidden_text_pdf(
            "blocked.pdf",
            lambda page, rect: page.draw_rect(
                rect, color=(0, 0, 0), fill=(0, 0, 0), overlay=True
            ),
        )
        with patch.dict(os.environ, {"REDACTION_POLICY": "block"}):
            result = ocr_pipeline.process_document(self._doc(path))

        self.assertFalse(result.success)
        self.assertEqual(result.method, "blocked")
        self.assertEqual(result.full_text, "")

    def test_successful_empty_rerun_removes_stale_text_and_fts(self):
        database = self.root / "save-result.db"
        engine = get_engine(str(database))
        create_tables(engine)
        session = get_session(engine)
        document = Document(
            filename="stale.pdf",
            local_path=str(self.root / "stale.pdf"),
            content_type="application/pdf",
        )
        session.add(document)
        session.flush()
        session.add(
            DocumentText(
                document_id=document.id,
                full_text="stale searchable text",
                pages_text=["stale searchable text"],
                word_count=3,
            )
        )
        session.commit()
        rebuild_fts_index(database)

        ocr_pipeline.save_extraction_result(
            session,
            document,
            ocr_pipeline.ExtractionResult(
                success=True,
                full_text="",
                pages_text=[""],
                word_count=0,
                average_confidence=0.0,
                method="ocr",
            ),
        )

        self.assertIsNone(
            session.query(DocumentText).filter_by(document_id=document.id).first()
        )
        with engine.connect() as connection:
            count = connection.exec_driver_sql(
                "SELECT COUNT(*) FROM document_fts WHERE rowid = ?", (document.id,)
            ).scalar_one()
        self.assertEqual(count, 0)
        self.assertFalse(document.has_text)
        session.close()
        engine.dispose()


if __name__ == "__main__":
    unittest.main()
