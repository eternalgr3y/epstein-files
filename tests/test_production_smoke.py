import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from production_smoke import (
    HttpResult,
    NoRedirect,
    content_range,
    hashed_app_asset,
    hashed_app_stylesheet,
    is_jpeg_payload,
    request_url,
    run_smoke,
    strict_header_findings,
)
from qa_request_budget import RequestBudget, RequestBudgetExceeded


STRICT_HEADERS = {
    "content-type": "text/html; charset=UTF-8",
    "content-security-policy": (
        "default-src 'self'; base-uri 'self'; object-src 'none'; "
        "script-src 'self'; script-src-attr 'none'; "
        "style-src 'self'; style-src-attr 'none'"
    ),
    "strict-transport-security": "max-age=31536000; includeSubDomains",
}


def html_page(url, extra_head=""):
    body = (
        '<!doctype html><html><head><title>Archive</title>'
        f'<link rel="canonical" href="{url}">{extra_head}</head>'
        '<body><h1>Archive</h1></body></html>'
    ).encode()
    return HttpResult(200, dict(STRICT_HEADERS), body, url)


class ProductionSmokeTests(unittest.TestCase):
    def test_hashed_app_asset_requires_the_physical_hash_name(self):
        self.assertEqual(
            hashed_app_asset('<script defer src="/app-ef6449b306de.js"></script>'),
            ("/app-ef6449b306de.js", "ef6449b306de"),
        )
        self.assertIsNone(hashed_app_asset('<script src="/app.js"></script>'))
        self.assertEqual(
            hashed_app_stylesheet('<link rel="stylesheet" href="/static/app-0123456789ab.css">'),
            ("/static/app-0123456789ab.css", "0123456789ab"),
        )

    def test_content_range_parser_accepts_only_bounded_byte_ranges(self):
        self.assertEqual(content_range("bytes 0-0/20955328421"), (0, 0, 20955328421))
        self.assertIsNone(content_range("bytes */20955328421"))
        self.assertIsNone(content_range("garbage"))

    def test_estate_thumbnail_signature_helper_remains_compatible(self):
        self.assertTrue(is_jpeg_payload(b"\xff\xd8\xff\xe0rest-of-image"))
        self.assertFalse(is_jpeg_payload(b"<!doctype html>"))

    def test_no_redirect_handler_keeps_redirect_checks_observable(self):
        handler = NoRedirect()
        self.assertIsNone(
            handler.redirect_request(
                None, None, 301, "Moved", {}, "https://example.test/next"
            )
        )

    def test_request_budget_stops_smoke_before_network_io(self):
        with patch("production_smoke.urllib.request.build_opener") as build_opener:
            with self.assertRaises(RequestBudgetExceeded):
                request_url("https://example.test", budget=RequestBudget(0))
        build_opener.return_value.open.assert_not_called()

    def test_strict_headers_reject_inline_csp_and_weak_preloaded_hsts(self):
        findings = strict_header_findings(
            {
                "content-security-policy": "default-src *; script-src 'unsafe-inline'",
                "strict-transport-security": "max-age=60; preload",
            }
        )
        rendered = "\n".join(detail for _, detail in findings)
        self.assertIn("unsafe-inline", rendered)
        self.assertIn("wildcard", rendered)
        self.assertIn("below one year", rendered)
        self.assertIn("preload must remain off", rendered)

    @patch("production_smoke.request_url")
    def test_release_smoke_is_eight_same_origin_gets_with_hashed_asset(self, request):
        site = "https://example.test"
        script = b"console.log('release');"
        script_hash = hashlib.sha256(script).hexdigest()[:12]
        stylesheet = b"body { color: black; }\n"
        stylesheet_hash = hashlib.sha256(stylesheet).hexdigest()[:12]
        results = [
            html_page(
                f"{site}/",
                f'<script defer src="/app-{script_hash}.js"></script>'
                f'<link rel="stylesheet" href="/static/app-{stylesheet_hash}.css">',
            ),
            HttpResult(
                200,
                {
                    "content-type": "text/css",
                    "cache-control": "public, max-age=31536000, immutable",
                },
                stylesheet,
                f"{site}/static/app-{stylesheet_hash}.css",
            ),
            HttpResult(
                200,
                {
                    "content-type": "text/javascript",
                    "cache-control": "public, max-age=31536000, immutable",
                },
                script,
                f"{site}/app-{script_hash}.js",
            ),
            html_page(f"{site}/documents/14389"),
            html_page(f"{site}/videos"),
            HttpResult(
                200,
                {"content-type": "application/xml"},
                b"<?xml version='1.0'?><urlset></urlset>",
                f"{site}/sitemap.xml",
            ),
            HttpResult(
                200,
                {"content-type": "application/json"},
                b'{"total_documents":20653}',
                f"{site}/api/stats",
            ),
            HttpResult(
                206,
                {
                    "content-type": "video/mp4",
                    "content-range": "bytes 0-0/12345",
                    "content-length": "1",
                },
                b"\x00",
                f"{site}/api/documents/14685/file?stream=1",
            ),
        ]
        request.side_effect = results
        budget = RequestBudget(8)

        with tempfile.TemporaryDirectory() as directory:
            expected_app = Path(directory) / "app.js"
            expected_css = Path(directory) / "app.css"
            expected_app.write_bytes(script)
            expected_css.write_bytes(stylesheet)
            self.assertEqual(
                run_smoke(site, 1, 0, budget, expected_app, expected_css), []
            )
        self.assertEqual(request.call_count, 8)
        urls = [call.args[0] for call in request.call_args_list]
        self.assertTrue(all(url.startswith(site) for url in urls))
        self.assertEqual(
            request.call_args_list[-1].kwargs["headers"]["Range"], "bytes=0-0"
        )
        self.assertEqual(request.call_args_list[-1].kwargs["read_limit"], 2)
        self.assertTrue(
            all(call.kwargs["follow_redirects"] is False for call in request.call_args_list)
        )

    @patch("production_smoke.request_url")
    def test_release_smoke_rejects_a_live_asset_from_another_commit(self, request):
        site = "https://example.test"
        live_script = b"console.log('old release');"
        live_hash = hashlib.sha256(live_script).hexdigest()[:12]
        live_css = b"body{}\n"
        live_css_hash = hashlib.sha256(live_css).hexdigest()[:12]
        request.side_effect = [
            html_page(site + "/", f'<script defer src="/app-{live_hash}.js"></script>'
                      f'<link rel="stylesheet" href="/static/app-{live_css_hash}.css">'),
            HttpResult(200, {"content-type": "text/css", "cache-control": "immutable"}, live_css, site + f"/static/app-{live_css_hash}.css"),
            HttpResult(200, {"cache-control": "immutable"}, live_script, site + f"/app-{live_hash}.js"),
            html_page(site + "/documents/14389"),
            html_page(site + "/videos"),
            HttpResult(200, {"content-type": "application/xml"}, b"<urlset/>", site + "/sitemap.xml"),
            HttpResult(200, {"content-type": "application/json"}, b'{"total_documents":1}', site + "/api/stats"),
            HttpResult(206, {"content-range": "bytes 0-0/1", "content-length": "1"}, b"x", site + "/api/documents/14685/file?stream=1"),
        ]
        with tempfile.TemporaryDirectory() as directory:
            expected_app = Path(directory) / "app.js"
            expected_css = Path(directory) / "app.css"
            expected_app.write_bytes(b"console.log('new release');")
            expected_css.write_bytes(b"body{color:red}\n")
            findings = run_smoke(
                site, 1, 0, RequestBudget(8), expected_app, expected_css
            )
        self.assertTrue(any(item["problem"] == "deployed-ref-mismatch" for item in findings))

    @patch("production_smoke.request_url")
    def test_failure_report_never_contains_media_body(self, request):
        request.side_effect = [
            HttpResult(503, {}, b"private response bytes", "https://example.test")
            for _ in range(7)
        ]
        findings = run_smoke("https://example.test", 1, 0, RequestBudget(7))
        self.assertTrue(findings)
        self.assertNotIn("private response bytes", repr(findings))


if __name__ == "__main__":
    unittest.main()
