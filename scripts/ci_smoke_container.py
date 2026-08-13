#!/usr/bin/env python3
"""Verify the API fixture and content-addressed frontend assets in a container."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from typing import Any


APP_ASSET_RE = re.compile(r"/app-([0-9a-f]{12})\.js")
CSS_ASSET_RE = re.compile(r"/static/app-([0-9a-f]{12})\.css")
IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"


class SmokeFailure(RuntimeError):
    """Raised when a container response violates the release contract."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Keep redirects visible to the smoke test as non-200 responses."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class FrontendAssetParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.scripts: list[str] = []
        self.stylesheets: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {name.lower(): value for name, value in attrs}
        if tag.lower() == "script" and attributes.get("src"):
            self.scripts.append(attributes["src"] or "")
        if tag.lower() != "link" or not attributes.get("href"):
            return
        rel_tokens = (attributes.get("rel") or "").lower().split()
        if "stylesheet" in rel_tokens:
            self.stylesheets.append(attributes["href"] or "")


def _origin(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise SmokeFailure("origin must be an absolute http(s) URL")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise SmokeFailure("origin must not contain a path, query, or fragment")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


def _request(opener: Any, url: str) -> tuple[int, Any, bytes]:
    request = urllib.request.Request(url, headers={"User-Agent": "container-release-smoke/1"})
    try:
        with opener.open(request, timeout=10) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()


def _require_status(status: int, path: str) -> None:
    if status != 200:
        raise SmokeFailure(f"{path} returned HTTP {status}, expected 200")


def _content_type(headers: Any) -> str:
    return headers.get("Content-Type", "").split(";", 1)[0].strip().lower()


def _extract_one(paths: list[str], pattern: re.Pattern[str], kind: str) -> tuple[str, str]:
    matches = [(path, match.group(1)) for path in paths if (match := pattern.fullmatch(path))]
    if len(matches) != 1:
        raise SmokeFailure(
            f"homepage must contain exactly one physical hashed {kind} path; found {len(matches)}"
        )
    return matches[0]


def _verify_asset(
    opener: Any,
    origin: str,
    path: str,
    expected_hash: str,
    allowed_content_types: set[str],
) -> None:
    status, headers, body = _request(opener, origin + path)
    _require_status(status, path)

    actual_hash = hashlib.sha256(body).hexdigest()[:12]
    if actual_hash != expected_hash:
        raise SmokeFailure(
            f"{path} content hash is {actual_hash}, expected filename hash {expected_hash}"
        )

    content_type = _content_type(headers)
    if content_type not in allowed_content_types:
        allowed = ", ".join(sorted(allowed_content_types))
        raise SmokeFailure(f"{path} has Content-Type {content_type!r}, expected {allowed}")

    cache_control = headers.get("Cache-Control", "")
    if cache_control.lower() != IMMUTABLE_CACHE_CONTROL:
        raise SmokeFailure(
            f"{path} has Cache-Control {cache_control!r}, expected {IMMUTABLE_CACHE_CONTROL!r}"
        )


def run_smoke(origin: str, opener: Any | None = None) -> None:
    origin = _origin(origin)
    opener = opener or urllib.request.build_opener(NoRedirect())

    stats_status, stats_headers, stats_body = _request(opener, origin + "/api/stats")
    _require_status(stats_status, "/api/stats")
    if _content_type(stats_headers) != "application/json":
        raise SmokeFailure("/api/stats did not return application/json")
    try:
        stats = json.loads(stats_body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SmokeFailure("/api/stats returned invalid JSON") from error
    expected_stats = {"total": 1, "entity_count": 1, "total_words": 3}
    for name, expected in expected_stats.items():
        if stats.get(name) != expected:
            raise SmokeFailure(
                f"/api/stats field {name!r} is {stats.get(name)!r}, expected {expected!r}"
            )

    homepage_status, homepage_headers, homepage_body = _request(opener, origin + "/")
    _require_status(homepage_status, "/")
    if _content_type(homepage_headers) != "text/html":
        raise SmokeFailure("homepage did not return text/html")
    try:
        homepage = homepage_body.decode("utf-8")
    except UnicodeDecodeError as error:
        raise SmokeFailure("homepage is not valid UTF-8") from error

    parser = FrontendAssetParser()
    parser.feed(homepage)
    app_path, app_hash = _extract_one(parser.scripts, APP_ASSET_RE, "JavaScript")
    css_path, css_hash = _extract_one(parser.stylesheets, CSS_ASSET_RE, "stylesheet")

    _verify_asset(
        opener,
        origin,
        app_path,
        app_hash,
        {"application/javascript", "text/javascript"},
    )
    _verify_asset(opener, origin, css_path, css_hash, {"text/css"})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origin", help="container origin, for example http://127.0.0.1:18000")
    args = parser.parse_args()
    try:
        run_smoke(args.origin)
    except SmokeFailure as error:
        parser.exit(1, f"container smoke failed: {error}\n")
    print("container smoke passed: API fixture and hashed frontend assets are valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
