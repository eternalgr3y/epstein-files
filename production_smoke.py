#!/usr/bin/env python3
"""Read-only production smoke checks for pages, API metadata, and media ranges."""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

from crawl_canonical_pages import parse_signals, validate_page
from qa_request_budget import RequestBudget, RequestBudgetExceeded


DEFAULT_SITE = "https://epsteinproject.org"
DEFAULT_API = "https://epstein-files-api.protonuser597.workers.dev"
DEFAULT_REQUEST_BUDGET = 25
USER_AGENT = "epstein-production-smoke/1"
VIDEO_DOCUMENT_ID = 22425
LEGACY_VIDEO_DOCUMENT_ID = 14685
ESTATE_VIDEO_DOCUMENT_ID = 15999
ESTATE_VIDEO_BATES = "HOUSE_OVERSIGHT_026678"
MISSING_ESTATE_THUMB_BATES = "HOUSE_OVERSIGHT_014359"


@dataclasses.dataclass
class HttpResult:
    status: int | None
    headers: dict[str, str]
    body: bytes
    final_url: str | None
    error: str | None = None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_url(
    url: str,
    *,
    budget: RequestBudget,
    headers: dict[str, str] | None = None,
    follow_redirects: bool = True,
    read_limit: int = 2_000_000,
    timeout: float = 20.0,
    retries: int = 2,
) -> HttpResult:
    opener = urllib.request.build_opener() if follow_redirects else urllib.request.build_opener(NoRedirect)
    request_headers = {"User-Agent": USER_AGENT, **(headers or {})}
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        budget.consume(f"GET {url}")
        try:
            request = urllib.request.Request(url, headers=request_headers)
            with opener.open(request, timeout=timeout) as response:
                body = response.read(read_limit)
                response_headers = {
                    name.lower(): value for name, value in response.headers.items()
                }
                if response.status in {429, 500, 502, 503, 504} and attempt < retries:
                    last_error = RuntimeError(f"HTTP {response.status}")
                else:
                    return HttpResult(
                        response.status,
                        response_headers,
                        body,
                        response.geturl(),
                    )
        except urllib.error.HTTPError as exc:
            if exc.code in {429, 500, 502, 503, 504} and attempt < retries:
                last_error = exc
            else:
                return HttpResult(
                    exc.code,
                    {name.lower(): value for name, value in exc.headers.items()},
                    exc.read(read_limit),
                    exc.geturl(),
                )
        except (OSError, TimeoutError) as exc:
            last_error = exc
            if attempt == retries:
                break
        time.sleep(0.25 * (2**attempt))
    return HttpResult(None, {}, b"", None, str(last_error))


def hashed_app_asset(html: str) -> tuple[str, str] | None:
    match = re.search(r'["\'](/app-([0-9a-f]{12})\.js)["\']', html)
    return (match.group(1), match.group(2)) if match else None


def content_range(value: str | None) -> tuple[int, int, int] | None:
    match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", value or "")
    return tuple(map(int, match.groups())) if match else None


def run_smoke(
    site: str,
    api: str,
    timeout: float,
    retries: int,
    budget: RequestBudget,
) -> list[dict]:
    findings: list[dict] = []

    def add(check: str, problem: str, detail: str) -> None:
        findings.append({"check": check, "problem": problem, "detail": detail})

    home_url = f"{site.rstrip('/')}/"
    home = request_url(home_url, budget=budget, timeout=timeout, retries=retries)
    if home.status != 200:
        add("home", "http-status", str(home.status))
    elif "text/html" not in home.headers.get("content-type", ""):
        add("home", "content-type", home.headers.get("content-type", "missing"))
    else:
        home_html = home.body.decode("utf-8", errors="replace")
        asset = hashed_app_asset(home_html)
        if not asset:
            add("app-asset", "missing-hashed-asset", "home does not reference /app-<hash>.js")
        else:
            path, expected_hash = asset
            script = request_url(
                urllib.parse.urljoin(home_url, path),
                budget=budget,
                timeout=timeout,
                retries=retries,
            )
            if script.status != 200:
                add("app-asset", "http-status", str(script.status))
            else:
                actual_hash = hashlib.sha256(script.body).hexdigest()[:12]
                if actual_hash != expected_hash:
                    add("app-asset", "hash-mismatch", f"name={expected_hash} body={actual_hash}")
                cache_control = script.headers.get("cache-control", "").lower()
                if "immutable" not in cache_control:
                    add("app-asset", "cache-policy", cache_control or "missing")

    document_url = f"{site.rstrip('/')}/documents/14389"
    document = request_url(document_url, budget=budget, timeout=timeout, retries=retries)
    for finding in validate_page(
        document_url,
        document.status,
        document.headers,
        document.body,
        document.final_url,
    ):
        add("canonical-document", finding["problem"], finding["detail"])

    missing_url = f"{site.rstrip('/')}/documents/999999999"
    missing = request_url(missing_url, budget=budget, timeout=timeout, retries=retries)
    if missing.status != 404:
        add("missing-document", "http-status", str(missing.status))
    else:
        if "no-store" not in missing.headers.get("cache-control", "").lower():
            add("missing-document", "cache-policy", missing.headers.get("cache-control", "missing"))
        signals = parse_signals(missing.body.decode("utf-8", errors="replace"))
        if signals.canonical != home_url:
            add("missing-document", "canonical-mismatch", str(signals.canonical))

    stats = request_url(
        f"{api.rstrip('/')}/api/stats",
        budget=budget,
        timeout=timeout,
        retries=retries,
    )
    if stats.status != 200:
        add("api-stats", "http-status", str(stats.status))
    else:
        try:
            stats_payload = json.loads(stats.body)
            if int(stats_payload.get("total_documents") or 0) <= 0:
                add("api-stats", "empty-dataset", str(stats_payload.get("total_documents")))
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            add("api-stats", "invalid-json", str(exc))

    videos = request_url(
        f"{api.rstrip('/')}/api/videos?limit=500&offset=0",
        budget=budget,
        timeout=timeout,
        retries=retries,
    )
    if videos.status != 200:
        add("video-collection", "http-status", str(videos.status))
    else:
        try:
            videos_payload = json.loads(videos.body)
            video_rows = videos_payload.get("videos") or []
            video_ids = {int(row["id"]) for row in video_rows}
            if ESTATE_VIDEO_DOCUMENT_ID not in video_ids:
                add("video-collection", "missing-estate-video", str(ESTATE_VIDEO_DOCUMENT_ID))
            if int(videos_payload.get("total") or 0) != len(video_rows):
                add(
                    "video-collection",
                    "incomplete-page",
                    f"total={videos_payload.get('total')} returned={len(video_rows)}",
                )
        except (KeyError, ValueError, TypeError, json.JSONDecodeError) as exc:
            add("video-collection", "invalid-json", str(exc))

    # Legacy data-set-8 rows have a NULL D1 file_size. Keep one of those in
    # the smoke path so NULL cannot regress into a zero-byte 416 response.
    legacy_video = request_url(
        f"{api.rstrip('/')}/api/documents/{LEGACY_VIDEO_DOCUMENT_ID}/file?stream=1",
        budget=budget,
        headers={"Range": "bytes=0-1023"},
        read_limit=2048,
        timeout=timeout,
        retries=retries,
    )
    legacy_range = content_range(legacy_video.headers.get("content-range"))
    if legacy_video.status != 206:
        add("legacy-video-range", "http-status", str(legacy_video.status))
    elif legacy_video.headers.get("content-type", "").split(";", 1)[0] != "video/mp4":
        add("legacy-video-range", "content-type", legacy_video.headers.get("content-type", "missing"))
    elif legacy_range is None or legacy_range[:2] != (0, 1023) or len(legacy_video.body) != 1024:
        add(
            "legacy-video-range",
            "range-response",
            f"content-range={legacy_video.headers.get('content-range')} bytes={len(legacy_video.body)}",
        )

    estate_document = request_url(
        f"{site.rstrip('/')}/documents/{ESTATE_VIDEO_DOCUMENT_ID}",
        budget=budget,
        follow_redirects=False,
        timeout=timeout,
        retries=retries,
    )
    expected_estate_location = f"https://epsteinproject.org/house-oversight/{ESTATE_VIDEO_BATES}"
    if estate_document.status != 301:
        add("estate-canonical", "http-status", str(estate_document.status))
    elif estate_document.headers.get("location") != expected_estate_location:
        add("estate-canonical", "location", estate_document.headers.get("location", "missing"))

    estate_stream = request_url(
        f"{api.rstrip('/')}/api/documents/{ESTATE_VIDEO_DOCUMENT_ID}/file?stream=1",
        budget=budget,
        read_limit=64,
        timeout=timeout,
        retries=retries,
    )
    estate_stream_range = content_range(estate_stream.headers.get("content-range"))
    if estate_stream.status != 206:
        add("estate-video-stream", "http-status", str(estate_stream.status))
    elif estate_stream.headers.get("content-type", "").split(";", 1)[0] != "video/mp4":
        add("estate-video-stream", "content-type", estate_stream.headers.get("content-type", "missing"))
    elif not estate_stream_range or estate_stream_range[:2] != (0, 1048575):
        add("estate-video-stream", "content-range", estate_stream.headers.get("content-range", "missing"))

    missing_estate_thumb = request_url(
        f"{api.rstrip('/')}/api/house-oversight/thumbnail/{MISSING_ESTATE_THUMB_BATES}",
        budget=budget,
        follow_redirects=False,
        timeout=timeout,
        retries=retries,
    )
    if missing_estate_thumb.status != 302:
        add("missing-estate-thumbnail", "http-status", str(missing_estate_thumb.status))
    elif missing_estate_thumb.headers.get("location") != f"{site.rstrip('/')}/og-image.png":
        add(
            "missing-estate-thumbnail",
            "location",
            missing_estate_thumb.headers.get("location", "missing"),
        )

    media_url = f"{api.rstrip('/')}/api/documents/{VIDEO_DOCUMENT_ID}/file"
    ordinary = request_url(
        media_url,
        budget=budget,
        follow_redirects=False,
        read_limit=1024,
        timeout=timeout,
        retries=retries,
    )
    if ordinary.status != 302:
        add("media-redirect", "http-status", str(ordinary.status))
    elif not ordinary.headers.get("location", "").startswith("https://media.epsteinproject.org/"):
        add("media-redirect", "location", ordinary.headers.get("location", "missing"))

    stream = request_url(
        f"{media_url}?stream=1",
        budget=budget,
        read_limit=64,
        timeout=timeout,
        retries=retries,
    )
    stream_range = content_range(stream.headers.get("content-range"))
    if stream.status != 206:
        add("media-stream-bootstrap", "http-status", str(stream.status))
    elif not stream_range or stream_range[:2] != (0, 1048575):
        add("media-stream-bootstrap", "content-range", stream.headers.get("content-range", "missing"))

    partial = request_url(
        media_url,
        budget=budget,
        headers={"Range": "bytes=0-1023"},
        read_limit=2048,
        timeout=timeout,
        retries=retries,
    )
    partial_range = content_range(partial.headers.get("content-range"))
    if partial.status != 206:
        add("media-range", "http-status", str(partial.status))
    elif partial_range is None or partial_range[:2] != (0, 1023) or len(partial.body) != 1024:
        add(
            "media-range",
            "range-response",
            f"content-range={partial.headers.get('content-range')} bytes={len(partial.body)}",
        )

    seek = request_url(
        media_url,
        budget=budget,
        headers={"Range": "bytes=10485760-10486783"},
        read_limit=2048,
        timeout=timeout,
        retries=retries,
    )
    seek_range = content_range(seek.headers.get("content-range"))
    if seek.status != 206:
        add("media-seek-range", "http-status", str(seek.status))
    elif seek_range is None or seek_range[:2] != (10485760, 10486783) or len(seek.body) != 1024:
        add(
            "media-seek-range",
            "range-response",
            f"content-range={seek.headers.get('content-range')} bytes={len(seek.body)}",
        )

    invalid = request_url(
        media_url,
        budget=budget,
        headers={"Range": "bytes=999999999999-1000000000000"},
        read_limit=1024,
        timeout=timeout,
        retries=retries,
    )
    if invalid.status != 416:
        add("media-invalid-range", "http-status", str(invalid.status))
    elif not re.fullmatch(r"bytes \*/\d+", invalid.headers.get("content-range", "")):
        add("media-invalid-range", "content-range", invalid.headers.get("content-range", "missing"))

    totals = [value[2] for value in (stream_range, partial_range, seek_range) if value]
    invalid_total = invalid.headers.get("content-range", "").partition("*/")[2]
    if invalid_total.isdigit():
        totals.append(int(invalid_total))
    if totals and len(set(totals)) != 1:
        add("media-size", "inconsistent-total", ", ".join(map(str, totals)))

    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", default=DEFAULT_SITE)
    parser.add_argument("--api", default=DEFAULT_API)
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument(
        "--max-requests",
        type=int,
        default=DEFAULT_REQUEST_BUDGET,
        help=f"Hard ceiling across retries (default: {DEFAULT_REQUEST_BUDGET})",
    )
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    budget = RequestBudget(args.max_requests)
    print(f"request budget: {budget.limit} maximum", flush=True)
    try:
        findings = run_smoke(
            args.site,
            args.api,
            args.timeout,
            max(0, args.retries),
            budget,
        )
    except RequestBudgetExceeded as exc:
        print(f"stopped: {exc}", file=sys.stderr)
        print(f"requests used: {budget.used}/{budget.limit}", file=sys.stderr)
        return 2
    summary = dict(sorted(Counter(item["problem"] for item in findings).items()))
    report = {
        "site": args.site,
        "api": args.api,
        "request_budget": budget.limit,
        "requests_used": budget.used,
        "summary": summary,
        "findings": findings,
    }
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"report: {args.report}")
    print(json.dumps(summary, sort_keys=True))
    print(f"requests used: {budget.used}/{budget.limit}")
    for finding in findings:
        print(f"{finding['check']}: {finding['problem']} ({finding['detail']})")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
