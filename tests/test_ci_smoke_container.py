import hashlib
import unittest
from email.message import Message

from scripts.ci_smoke_container import SmokeFailure, run_smoke


class FakeResponse:
    def __init__(self, status, content_type, body, cache_control=None):
        self.status = status
        self.headers = Message()
        self.headers["Content-Type"] = content_type
        if cache_control is not None:
            self.headers["Cache-Control"] = cache_control
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def read(self):
        return self.body


class FakeOpener:
    def __init__(self, responses):
        self.responses = responses
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request.full_url, timeout))
        return self.responses[request.full_url]


def valid_fixture():
    origin = "http://127.0.0.1:18000"
    app = b"console.log('container');\n"
    css = b"body { color: #111; }\n"
    og_image = b"\xff\xd8\xff\xe0container social card\xff\xd9"
    app_hash = hashlib.sha256(app).hexdigest()[:12]
    css_hash = hashlib.sha256(css).hexdigest()[:12]
    og_image_hash = hashlib.sha256(og_image).hexdigest()[:12]
    app_path = f"/app-{app_hash}.js"
    css_path = f"/static/app-{css_hash}.css"
    og_image_path = f"/static/og-image-{og_image_hash}.jpg"
    homepage = (
        "<!doctype html><html><head>"
        f'<link rel="stylesheet" href="{css_path}">'
        f'<script defer src="{app_path}"></script>'
        f'<meta property="og:image" content="https://epsteinproject.org{og_image_path}">'
        "</head><body></body></html>"
    ).encode()
    immutable = "public, max-age=31536000, immutable"
    responses = {
        origin + "/api/stats": FakeResponse(
            200,
            "application/json",
            b'{"total":1,"entity_count":1,"total_words":3}',
        ),
        origin + "/": FakeResponse(200, "text/html; charset=utf-8", homepage),
        origin + app_path: FakeResponse(200, "application/javascript", app, immutable),
        origin + css_path: FakeResponse(200, "text/css; charset=utf-8", css, immutable),
        origin + og_image_path: FakeResponse(200, "image/jpeg", og_image, immutable),
    }
    return origin, responses, origin + app_path


class ContainerSmokeTests(unittest.TestCase):
    def test_accepts_fixture_and_content_addressed_assets(self):
        origin, responses, _ = valid_fixture()
        opener = FakeOpener(responses)

        run_smoke(origin, opener)

        self.assertEqual(len(opener.requests), 5)
        self.assertTrue(all(timeout == 10 for _, timeout in opener.requests))

    def test_rejects_asset_bytes_that_do_not_match_filename_hash(self):
        origin, responses, app_url = valid_fixture()
        responses[app_url].body = b"tampered JavaScript\n"

        with self.assertRaisesRegex(SmokeFailure, "content hash"):
            run_smoke(origin, FakeOpener(responses))

    def test_rejects_non_immutable_asset_cache_policy(self):
        origin, responses, app_url = valid_fixture()
        responses[app_url].headers.replace_header("Cache-Control", "public, max-age=60")

        with self.assertRaisesRegex(SmokeFailure, "Cache-Control"):
            run_smoke(origin, FakeOpener(responses))

    def test_rejects_logical_unhashed_asset_paths(self):
        origin, responses, _ = valid_fixture()
        responses[origin + "/"].body = (
            b'<html><head><link rel="stylesheet" href="/static/app.css">'
            b'<script src="/app.js"></script></head></html>'
        )

        with self.assertRaisesRegex(SmokeFailure, "physical hashed JavaScript"):
            run_smoke(origin, FakeOpener(responses))


if __name__ == "__main__":
    unittest.main()
