#!/usr/bin/env python3
"""Low-volume, read-only release smoke for the same-origin production site."""

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

from crawl_canonical_pages import validate_page
from qa_request_budget import RequestBudget, RequestBudgetExceeded


DEFAULT_SITE = "https://epsteinproject.org"
DEFAULT_REQUEST_BUDGET = 8
USER_AGENT = "epstein-production-smoke/2"
DOCUMENT_ID = 14389
MEDIA_DOCUMENT_ID = 14685
MAX_TEXT_BYTES = 2_000_000


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
    read_limit: int = MAX_TEXT_BYTES,
    timeout: float = 10.0,
    retries: int = 0,
) -> HttpResult:
    opener = (
        urllib.request.build_opener()
        if follow_redirects
        else urllib.request.build_opener(NoRedirect)
    )
    request_headers = {"User-Agent": USER_AGENT, **(headers or {})}
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        budget.consume(f"GET {url}")
        try:
            request = urllib.request.Request(url, headers=request_headers, method="GET")
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
        if attempt < retries:
            time.sleep(0.25 * (2**attempt))
    return HttpResult(None, {}, b"", None, str(last_error))


# Retained for compatibility with the broader upstream QA helpers and tests.
def hashed_app_asset(html: str) -> tuple[str, str] | None:
    match = re.search(r'["\'](/app-([0-9a-f]{12})\.js)["\']', html)
    return (match.group(1), match.group(2)) if match else None


def hashed_app_stylesheet(html: str) -> tuple[str, str] | None:
    match = re.search(r'["\'](/static/app-([0-9a-f]{12})\.css)["\']', html)
    return (match.group(1), match.group(2)) if match else None


def content_range(value: str | None) -> tuple[int, int, int] | None:
    match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", value or "")
    return tuple(map(int, match.groups())) if match else None


def is_jpeg_payload(body: bytes) -> bool:
    return body.startswith(b"\xff\xd8\xff")


def _csp_directives(value: str) -> dict[str, set[str]]:
    directives: dict[str, set[str]] = {}
    for raw_directive in value.split(";"):
        parts = raw_directive.strip().split()
        if parts:
            directives[parts[0].lower()] = set(parts[1:])
    return directives


def strict_header_findings(headers: dict[str, str]) -> list[tuple[str, str]]:
    findings: list[tuple[str, str]] = []
    csp = headers.get("content-security-policy", "")
    policy = _csp_directives(csp)
    required = {
        "default-src": {"'self'"},
        "base-uri": {"'self'"},
        "object-src": {"'none'"},
        "script-src-attr": {"'none'"},
        "style-src-attr": {"'none'"},
    }
    if not csp:
        findings.append(("missing-csp", "Content-Security-Policy is absent"))
    for directive, values in required.items():
        if not values.issubset(policy.get(directive, set())):
            findings.append(("weak-csp", f"{directive} lacks the required restriction"))
    all_sources = set().union(*policy.values()) if policy else set()
    if "'unsafe-inline'" in all_sources:
        findings.append(("weak-csp", "unsafe-inline is permitted"))
    if "*" in all_sources:
        findings.append(("weak-csp", "a wildcard source is permitted"))

    hsts = headers.get("strict-transport-security", "")
    max_age = re.search(r"(?:^|;)\s*max-age=(\d+)", hsts, re.IGNORECASE)
    if not max_age or int(max_age.group(1)) < 31_536_000:
        findings.append(("weak-hsts", "max-age is below one year"))
    if not re.search(r"(?:^|;)\s*includeSubDomains(?:;|$)", hsts, re.IGNORECASE):
        findings.append(("weak-hsts", "includeSubDomains is absent"))
    if re.search(r"(?:^|;)\s*preload(?:;|$)", hsts, re.IGNORECASE):
        findings.append(("unexpected-hsts-preload", "preload must remain off"))
    return findings


def run_smoke(
    site: str,
    timeout: float,
    retries: int,
    budget: RequestBudget,
    expected_app: Path | None = None,
    expected_css: Path | None = None,
) -> list[dict]:
    findings: list[dict] = []
    origin = site.rstrip("/")

    def add(check: str, problem: str, detail: str) -> None:
        findings.append({"check": check, "problem": problem, "detail": detail})

    def get(path: str, **kwargs) -> HttpResult:
        result = request_url(
            f"{origin}{path}",
            budget=budget,
            timeout=timeout,
            retries=retries,
            follow_redirects=False,
            **kwargs,
        )
        if result.error:
            add(path, "request-error", result.error)
        return result

    page_checks = [
        ("homepage", "/"),
        ("canonical-document", f"/documents/{DOCUMENT_ID}"),
        ("videos", "/videos"),
    ]
    for check, path in page_checks:
        result = get(path)
        requested_url = f"{origin}{path}"
        for finding in validate_page(
            requested_url,
            result.status,
            result.headers,
            result.body,
            result.final_url,
        ):
            add(check, finding["problem"], finding["detail"])
        if check == "homepage":
            for problem, detail in strict_header_findings(result.headers):
                add(check, problem, detail)
            asset = hashed_app_asset(result.body.decode("utf-8", errors="replace"))
            stylesheet = hashed_app_stylesheet(
                result.body.decode("utf-8", errors="replace")
            )
            if not asset:
                add("app-asset", "missing-hashed-asset", "home does not reference /app-<hash>.js")
            else:
                asset_path, expected_hash = asset
                if expected_app is not None:
                    repository_hash = hashlib.sha256(expected_app.read_bytes()).hexdigest()[:12]
                    if expected_hash != repository_hash:
                        add(
                            "app-asset",
                            "deployed-ref-mismatch",
                            f"live={expected_hash} repository={repository_hash}",
                        )
                if expected_css is not None:
                    repository_css_hash = hashlib.sha256(expected_css.read_bytes()).hexdigest()[:12]
                    if not stylesheet or stylesheet[1] != repository_css_hash:
                        add(
                            "app-stylesheet",
                            "deployed-ref-mismatch",
                            f"live={stylesheet[1] if stylesheet else 'missing'} repository={repository_css_hash}",
                        )
                if stylesheet:
                    stylesheet_path, stylesheet_hash = stylesheet
                    live_css = get(stylesheet_path)
                    if live_css.status != 200:
                        add("app-stylesheet", "http-status", str(live_css.status))
                    else:
                        actual_css_hash = hashlib.sha256(live_css.body).hexdigest()[:12]
                        if actual_css_hash != stylesheet_hash:
                            add(
                                "app-stylesheet",
                                "hash-mismatch",
                                f"name={stylesheet_hash} body={actual_css_hash}",
                            )
                        css_type = live_css.headers.get("content-type", "").lower()
                        if "text/css" not in css_type:
                            add("app-stylesheet", "content-type", css_type or "missing")
                        css_cache = live_css.headers.get("cache-control", "").lower()
                        if "immutable" not in css_cache:
                            add("app-stylesheet", "cache-policy", css_cache or "missing")
                script = get(asset_path)
                if script.status != 200:
                    add("app-asset", "http-status", str(script.status))
                else:
                    actual_hash = hashlib.sha256(script.body).hexdigest()[:12]
                    if actual_hash != expected_hash:
                        add(
                            "app-asset",
                            "hash-mismatch",
                            f"name={expected_hash} body={actual_hash}",
                        )
                    cache_control = script.headers.get("cache-control", "").lower()
                    if "immutable" not in cache_control:
                        add("app-asset", "cache-policy", cache_control or "missing")

    sitemap = get("/sitemap.xml")
    if sitemap.status != 200:
        add("sitemap", "http-status", str(sitemap.status))
    else:
        content_type = sitemap.headers.get("content-type", "").lower()
        if "xml" not in content_type:
            add("sitemap", "content-type", content_type or "missing")
        if b"<urlset" not in sitemap.body.lower():
            add("sitemap", "invalid-xml", "urlset marker is absent")

    stats = get("/api/stats", read_limit=64 * 1024)
    if stats.status != 200:
        add("api-stats", "http-status", str(stats.status))
    else:
        try:
            payload = json.loads(stats.body)
            if int(payload.get("total_documents") or 0) <= 0:
                add("api-stats", "empty-dataset", str(payload.get("total_documents")))
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            add("api-stats", "invalid-json", type(exc).__name__)

    media = get(
        f"/api/documents/{MEDIA_DOCUMENT_ID}/file?stream=1",
        headers={"Range": "bytes=0-0"},
        read_limit=2,
    )
    parsed_range = content_range(media.headers.get("content-range"))
    if media.status != 206:
        add("media-range", "http-status", str(media.status))
    elif parsed_range is None or parsed_range[:2] != (0, 0):
        add("media-range", "content-range", media.headers.get("content-range", "missing"))
    elif media.headers.get("content-length") != "1" or len(media.body) != 1:
        add(
            "media-range",
            "range-response",
            f"declared={media.headers.get('content-length', 'missing')} bytes={len(media.body)}",
        )

    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", default=DEFAULT_SITE)
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--retries", type=int, default=0)
    parser.add_argument(
        "--max-requests",
        type=int,
        default=DEFAULT_REQUEST_BUDGET,
        help=f"Hard ceiling across retries (default: {DEFAULT_REQUEST_BUDGET})",
    )
    parser.add_argument("--report", type=Path)
    parser.add_argument(
        "--expected-app",
        type=Path,
        help="Repository app.js whose hash must match the live physical asset name",
    )
    parser.add_argument(
        "--expected-css",
        type=Path,
        help="Repository app.css whose hash must match the live physical stylesheet name",
    )
    args = parser.parse_args()
    parsed_site = urllib.parse.urlparse(args.site)
    if parsed_site.scheme != "https" or not parsed_site.netloc:
        parser.error("--site must be an absolute HTTPS origin")
    if args.timeout <= 0 or args.timeout > 30:
        parser.error("--timeout must be greater than 0 and at most 30 seconds")
    if args.retries < 0:
        parser.error("--retries cannot be negative")
    if args.max_requests != DEFAULT_REQUEST_BUDGET:
        parser.error(f"--max-requests must be exactly {DEFAULT_REQUEST_BUDGET}")
    if args.expected_app is not None and not args.expected_app.is_file():
        parser.error("--expected-app must name a readable file")
    if args.expected_css is not None and not args.expected_css.is_file():
        parser.error("--expected-css must name a readable file")

    budget = RequestBudget(args.max_requests)
    print(f"request budget: {budget.limit} maximum", flush=True)
    try:
        findings = run_smoke(
            args.site,
            args.timeout,
            args.retries,
            budget,
            args.expected_app,
            args.expected_css,
        )
    except RequestBudgetExceeded as exc:
        print(f"stopped: {exc}", file=sys.stderr)
        print(f"requests used: {budget.used}/{budget.limit}", file=sys.stderr)
        return 2
    summary = dict(sorted(Counter(item["problem"] for item in findings).items()))
    report = {
        "site": args.site,
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
