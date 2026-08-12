import unittest

from crawl_canonical_pages import parse_signals, parse_sitemap, validate_page


class CanonicalCrawlerTests(unittest.TestCase):
    def test_valid_page_has_no_findings(self):
        url = "https://epsteinproject.org/documents/14389"
        html = f"""<!doctype html><html><head>
        <title>Archive record</title>
        <link rel="canonical" href="{url}">
        <meta name="robots" content="index, follow">
        <meta property="og:url" content="{url}">
        <script type="application/ld+json">{{"@type":"DigitalDocument"}}</script>
        </head><body><h1>Record 14389</h1></body></html>"""
        findings = validate_page(
            url,
            200,
            {"content-type": "text/html; charset=UTF-8"},
            html.encode(),
            url,
        )
        self.assertEqual(findings, [])

    def test_mismatched_canonical_noindex_and_missing_h1_are_reported(self):
        html = """<html><head><title>Wrong</title>
        <link rel="canonical" href="https://epsteinproject.org/">
        <meta name="robots" content="noindex"></head><body></body></html>"""
        problems = {
            finding["problem"]
            for finding in validate_page(
                "https://epsteinproject.org/documents/1",
                200,
                {"content-type": "text/html"},
                html.encode(),
            )
        }
        self.assertEqual(
            problems,
            {"canonical-mismatch", "unexpected-noindex", "h1-count"},
        )

    def test_parser_reads_json_ld_and_title(self):
        signals = parse_signals(
            '<title>  A record </title><h1>A</h1><script type="application/ld+json">{"a":1}</script>'
        )
        self.assertEqual(signals.title, "A record")
        self.assertEqual(signals.h1_count, 1)
        self.assertEqual(signals.json_ld, ['{"a":1}'])

    def test_sitemap_rejects_duplicates_and_foreign_hosts(self):
        prefix = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        suffix = "</urlset>"
        with self.assertRaisesRegex(ValueError, "duplicate"):
            parse_sitemap(
                f"{prefix}<url><loc>https://epsteinproject.org/</loc></url>"
                f"<url><loc>https://epsteinproject.org/</loc></url>{suffix}".encode(),
                "https://epsteinproject.org",
            )
        with self.assertRaisesRegex(ValueError, "invalid archive URL"):
            parse_sitemap(
                f"{prefix}<url><loc>https://example.com/</loc></url>{suffix}".encode(),
                "https://epsteinproject.org",
            )


if __name__ == "__main__":
    unittest.main()
