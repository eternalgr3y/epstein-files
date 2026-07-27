import unittest

from reprocess_low_confidence_ocr import crosses_confidence_threshold


class LowConfidenceReprocessingTests(unittest.TestCase):
    def test_small_improvement_below_threshold_is_rejected(self):
        self.assertFalse(crosses_confidence_threshold(0.30, 0.36, 0.50))

    def test_result_must_also_improve_on_the_stored_confidence(self):
        self.assertFalse(crosses_confidence_threshold(0.70, 0.65, 0.50))
        self.assertTrue(crosses_confidence_threshold(0.30, 0.65, 0.50))


if __name__ == "__main__":
    unittest.main()
