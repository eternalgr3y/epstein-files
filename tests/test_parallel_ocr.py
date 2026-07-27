import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

from models import Document, ProcessingStatus, create_tables, get_engine, get_session
from parallel_ocr import claim_next_document


class ParallelOcrTests(unittest.TestCase):
    def test_claims_are_distinct_across_sessions(self):
        with tempfile.TemporaryDirectory(prefix="epstein-claim-tests-") as temp_dir:
            engine = get_engine(str(Path(temp_dir) / "claims.db"))
            create_tables(engine)
            setup = get_session(engine)
            for number in (1, 2):
                setup.add(
                    Document(
                        filename=f"{number}.pdf",
                        local_path=f"/{number}.pdf",
                        content_type="application/pdf",
                        processing_status=ProcessingStatus.PENDING.value,
                        needs_ocr=True,
                    )
                )
            setup.commit()
            setup.close()

            first_session = get_session(engine)
            second_session = get_session(engine)
            first = claim_next_document(first_session)
            second = claim_next_document(second_session)

            self.assertNotEqual(first.id, second.id)
            self.assertEqual(first.processing_status, ProcessingStatus.PROCESSING.value)
            self.assertEqual(second.processing_status, ProcessingStatus.PROCESSING.value)
            self.assertIsNone(claim_next_document(first_session))

            first_session.close()
            second_session.close()
            engine.dispose()


if __name__ == "__main__":
    unittest.main()
