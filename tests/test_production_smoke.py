import unittest
from unittest.mock import patch

from production_smoke import (
    NoRedirect,
    content_range,
    hashed_app_asset,
    is_jpeg_payload,
    request_url,
)
from qa_request_budget import RequestBudget, RequestBudgetExceeded


class ProductionSmokeTests(unittest.TestCase):
    def test_hashed_app_asset_requires_the_physical_hash_name(self):
        self.assertEqual(
            hashed_app_asset('<script defer src="/app-ef6449b306de.js"></script>'),
            ("/app-ef6449b306de.js", "ef6449b306de"),
        )
        self.assertIsNone(hashed_app_asset('<script src="/app.js"></script>'))

    def test_content_range_parser_accepts_only_bounded_byte_ranges(self):
        self.assertEqual(content_range("bytes 0-1023/20955328421"), (0, 1023, 20955328421))
        self.assertIsNone(content_range("bytes */20955328421"))
        self.assertIsNone(content_range("garbage"))

    def test_estate_thumbnail_requires_a_jpeg_signature(self):
        self.assertTrue(is_jpeg_payload(b"\xff\xd8\xff\xe0rest-of-image"))
        self.assertFalse(is_jpeg_payload(b"<!doctype html>"))
        self.assertFalse(is_jpeg_payload(b""))

    def test_no_redirect_handler_keeps_canonical_checks_observable(self):
        handler = NoRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 301, "Moved", {}, "https://example.test/next"))

    def test_request_budget_stops_smoke_before_network_io(self):
        with patch("production_smoke.urllib.request.build_opener") as build_opener:
            with self.assertRaises(RequestBudgetExceeded):
                request_url("https://example.test", budget=RequestBudget(0))

        build_opener.return_value.open.assert_not_called()


if __name__ == "__main__":
    unittest.main()
