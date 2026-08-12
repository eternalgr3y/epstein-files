import unittest

from production_smoke import NoRedirect, content_range, hashed_app_asset


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

    def test_no_redirect_handler_keeps_canonical_checks_observable(self):
        handler = NoRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 301, "Moved", {}, "https://example.test/next"))


if __name__ == "__main__":
    unittest.main()
