#!/usr/bin/env python3
"""Crawl every published sitemap URL and validate its canonical HTML signals."""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path

import httpx

from qa_request_budget import RequestBudget, RequestBudgetExceeded


DEFAULT_BASE = "https://epsteinproject.org"
DEFAULT_REQUEST_BUDGET = 25
MAX_HTML_BYTES = 1_000_000
MAX_SITEMAP_BYTES = 10_000_000
USER_AGENT = "epstein-canonical-audit/1"


@dataclasses.dataclass
class PageSignals:
    title: str = ""
    h1_count: int = 0
    canonical: str | None = None
    og_url: str | None = None
    robots: str | None = None
    json_ld: list[str] = dataclasses.field(default_factory=list)


class SignalParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.signals = PageSignals()
        self._in_title = False
        self._title_parts: list[str] = []
        self._in_json_ld = False
        self._json_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {name.lower(): value or "" for name, value in attrs}
        tag = tag.lower()
        if tag == "title":
            self._in_title = True
        elif tag == "h1":
            self.signals.h1_count += 1
        elif tag == "link" and "canonical" in values.get("rel", "").lower().split():
            self.signals.canonical = values.get("href")
        elif tag == "meta":
            name = values.get("name", "").lower()
            property_name = values.get("property", "").lower()
            if name == "robots":
                self.signals.robots = values.get("content")
            elif property_name == "og:url":
                self.signals.og_url = values.get("content")
        elif tag == "script" and values.get("type", "").lower() == "application/ld+json":
            self._in_json_ld = True
            self._json_parts = []

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "title":
            self._in_title = False
            self.signals.title = " ".join("".join(self._title_parts).split())
        elif tag == "script" and self._in_json_ld:
            self._in_json_ld = False
            self.signals.json_ld.append("".join(self._json_parts).strip())

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self._title_parts.append(data)
        if self._in_json_ld:
            self._json_parts.append(data)


def parse_signals(html: str) -> PageSignals:
    parser = SignalParser()
    parser.feed(html)
    parser.close()
    return parser.signals


def canonical_url(value: str) -> str:
    parts = urllib.parse.urlsplit(value)
    path = parts.path or "/"
    return urllib.parse.urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, parts.query, ""))


def validate_page(
    requested_url: str,
    status: int | None,
    headers: dict[str, str],
    body: bytes,
    final_url: str | None = None,
) -> list[dict]:
    findings: list[dict] = []

    def add(problem: str, detail: str) -> None:
        findings.append({"url": requested_url, "problem": problem, "detail": detail})

    if status != 200:
        add("http-status", str(status))
        return findings
    if final_url and canonical_url(final_url) != canonical_url(requested_url):
        add("redirect", final_url)
    content_type = headers.get("content-type", "").lower()
    if not content_type.startswith("text/html"):
        add("content-type", content_type or "missing")
        return findings
    if len(body) >= MAX_HTML_BYTES:
        add("oversized-html", f"at least {len(body)} bytes")

    html = body.decode("utf-8", errors="replace")
    signals = parse_signals(html)
    expected = canonical_url(requested_url)
    if not signals.title:
        add("missing-title", "empty or absent title")
    if signals.h1_count != 1:
        add("h1-count", str(signals.h1_count))
    if not signals.canonical:
        add("missing-canonical", "canonical link is absent")
    elif canonical_url(urllib.parse.urljoin(requested_url, signals.canonical)) != expected:
        add("canonical-mismatch", signals.canonical)
    if signals.og_url and canonical_url(urllib.parse.urljoin(requested_url, signals.og_url)) != expected:
        add("og-url-mismatch", signals.og_url)
    if "noindex" in (signals.robots or "").lower():
        add("unexpected-noindex", signals.robots or "")
    for index, payload in enumerate(signals.json_ld, 1):
        try:
            json.loads(payload)
        except json.JSONDecodeError as exc:
            add("invalid-json-ld", f"block {index}: {exc}")
    return findings


def fetch_page(
    url: str,
    timeout: float,
    retries: int,
    budget: RequestBudget,
    max_bytes: int = MAX_HTML_BYTES,
) -> tuple[int | None, dict[str, str], bytes, str | None, str | None]:
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        budget.consume(f"GET {url}")
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read(max_bytes)
                headers = {name.lower(): value for name, value in response.headers.items()}
                return response.status, headers, body, response.geturl(), None
        except urllib.error.HTTPError as exc:
            if exc.code not in {429, 500, 502, 503, 504} or attempt == retries:
                return exc.code, {name.lower(): value for name, value in exc.headers.items()}, b"", exc.geturl(), None
            last_error = exc
        except (OSError, TimeoutError) as exc:
            last_error = exc
            if attempt == retries:
                break
        time.sleep(0.25 * (2**attempt))
    return None, {}, b"", None, str(last_error)


async def check_url_async(
    url: str,
    client: httpx.AsyncClient,
    retries: int,
    budget: RequestBudget,
) -> list[dict]:
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        budget.consume(f"GET {url}")
        try:
            response = await client.get(url)
            if response.status_code in {429, 500, 502, 503, 504} and attempt < retries:
                last_error = RuntimeError(f"HTTP {response.status_code}")
            else:
                headers = {name.lower(): value for name, value in response.headers.items()}
                return validate_page(
                    url,
                    response.status_code,
                    headers,
                    response.content[:MAX_HTML_BYTES],
                    str(response.url),
                )
        except (httpx.HTTPError, asyncio.TimeoutError) as exc:
            last_error = exc
            if attempt == retries:
                break
        await asyncio.sleep(0.25 * (2**attempt))
    return [{"url": url, "problem": "request-error", "detail": str(last_error)}]


async def crawl_urls_async(
    urls: list[str],
    workers: int,
    timeout: float,
    retries: int,
    budget: RequestBudget,
) -> list[dict]:
    findings: list[dict] = []
    queue: asyncio.Queue[str] = asyncio.Queue()
    for url in urls:
        queue.put_nowait(url)
    completed = 0
    limits = httpx.Limits(
        max_connections=workers,
        max_keepalive_connections=min(workers, 20),
    )
    async with httpx.AsyncClient(
        http2=True,
        timeout=timeout,
        limits=limits,
        follow_redirects=True,
        headers={"User-Agent": USER_AGENT},
    ) as client:
        async def worker() -> None:
            nonlocal completed
            while True:
                try:
                    url = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                findings.extend(await check_url_async(url, client, retries, budget))
                completed += 1
                if completed % 250 == 0 or completed == len(urls):
                    print(
                        f"checked {completed:,}/{len(urls):,}; findings {len(findings):,}",
                        flush=True,
                    )

        await asyncio.gather(*(worker() for _ in range(min(workers, len(urls)))))
    return findings


def crawl_urls(
    urls: list[str],
    workers: int,
    timeout: float,
    retries: int,
    budget: RequestBudget,
) -> list[dict]:
    return asyncio.run(crawl_urls_async(urls, workers, timeout, retries, budget))


def parse_sitemap(xml: bytes, base_url: str) -> list[str]:
    root = ET.fromstring(xml)
    expected_host = urllib.parse.urlsplit(base_url).netloc.lower()
    urls: list[str] = []
    seen: set[str] = set()
    for node in root.findall("{http://www.sitemaps.org/schemas/sitemap/0.9}url"):
        location = node.findtext("{http://www.sitemaps.org/schemas/sitemap/0.9}loc", "").strip()
        if not location:
            raise ValueError("sitemap contains a URL without a location")
        parts = urllib.parse.urlsplit(location)
        if parts.scheme != "https" or parts.netloc.lower() != expected_host or parts.fragment:
            raise ValueError(f"sitemap contains an invalid archive URL: {location}")
        normalized = canonical_url(location)
        if normalized in seen:
            raise ValueError(f"sitemap contains a duplicate URL: {location}")
        seen.add(normalized)
        urls.append(location)
    if not urls:
        raise ValueError("sitemap contains no URLs")
    return urls


def load_sitemap(
    base_url: str,
    timeout: float,
    retries: int,
    budget: RequestBudget,
) -> list[str]:
    sitemap_url = f"{base_url.rstrip('/')}/sitemap.xml"
    status, headers, body, _, error = fetch_page(
        sitemap_url, timeout, retries, budget, MAX_SITEMAP_BYTES
    )
    if error:
        raise RuntimeError(error)
    if status != 200:
        raise RuntimeError(f"sitemap returned HTTP {status}")
    if "xml" not in headers.get("content-type", "").lower():
        raise RuntimeError(f"sitemap returned {headers.get('content-type', 'no content type')}")
    return parse_sitemap(body, base_url)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=DEFAULT_BASE)
    parser.add_argument("--workers", type=int, default=50)
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--limit", type=int, default=0, help="Crawl only the first N sitemap URLs")
    parser.add_argument(
        "--max-requests",
        type=int,
        default=DEFAULT_REQUEST_BUDGET,
        help=f"Hard ceiling including sitemap and retries (default: {DEFAULT_REQUEST_BUDGET})",
    )
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    budget = RequestBudget(args.max_requests)
    print(f"request budget: {budget.limit} maximum", flush=True)
    try:
        urls = load_sitemap(
            args.base_url,
            args.timeout,
            max(0, args.retries),
            budget,
        )
        selected = urls[: args.limit or None]
        budget.ensure_available(len(selected), "canonical page crawl")
        findings = crawl_urls(
            selected,
            max(1, args.workers),
            args.timeout,
            max(0, args.retries),
            budget,
        )
    except RequestBudgetExceeded as exc:
        print(f"stopped: {exc}", file=sys.stderr)
        print(f"requests used: {budget.used}/{budget.limit}", file=sys.stderr)
        return 2

    findings.sort(key=lambda item: (item["problem"], item["url"]))
    summary = dict(sorted(Counter(item["problem"] for item in findings).items()))
    report = {
        "base_url": args.base_url,
        "sitemap_urls": len(urls),
        "urls_checked": len(selected),
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
    for finding in findings[:20]:
        print(f"{finding['problem']}: {finding['url']} ({finding['detail']})")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
