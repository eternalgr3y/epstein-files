#!/usr/bin/env python3
"""Read-only D1/R2 integrity audit for the production archive.

The audit reads document metadata through Wrangler, derives the exact R2 keys
used by the Worker, and sends HEAD requests to the public media domain. It does
not download object bodies or mutate D1, R2, Pages, or Worker configuration.
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Iterable

import aiohttp


WRANGLER_VERSION = "4.112.0"
DEFAULT_MEDIA_BASE = "https://media.epsteinproject.org"
HOUSE_FIRST_BATES = 10477
HOUSE_FOLDER_SIZE = 2000
ANSI_ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


@dataclasses.dataclass(frozen=True)
class Target:
    key: str
    kind: str
    reference: str
    expected_size: int | None = None
    expected_type: str | None = None


def document_r2_key(local_path: str | None) -> str | None:
    normalized = str(local_path or "").replace("\\", "/")
    marker = "epstein-files/"
    index = normalized.lower().rfind(marker)
    if index < 0:
        return None
    key = normalized[index + len(marker) :].lstrip("/")
    return key or None


def house_page_targets(bates: str, page_count: int | None) -> list[Target]:
    match = re.fullmatch(r"HOUSE_OVERSIGHT_(\d+)", str(bates or ""))
    if not match:
        return []
    first_page = int(match.group(1))
    targets = []
    for offset in range(max(1, int(page_count or 1))):
        page = first_page + offset
        folder_number = (page - HOUSE_FIRST_BATES) // HOUSE_FOLDER_SIZE + 1
        if folder_number < 1:
            continue
        key = (
            f"house-oversight/IMAGES/{folder_number:03d}/"
            f"HOUSE_OVERSIGHT_{page:06d}.jpg"
        )
        targets.append(Target(key, "house-page", f"{bates}:{offset}", expected_type="image/jpeg"))
    return targets


def house_native_target(document: dict) -> Target | None:
    if document.get("data_set") != "house-oversight-estate":
        return None
    if document.get("document_type") != "video":
        return None
    bates = str(document.get("filename") or "")
    if not re.fullmatch(r"HOUSE_OVERSIGHT_\d+", bates):
        return None
    match = re.search(r"\.(mp4|mov|avi|wmv)$", str(document.get("title") or ""), re.I)
    if not match:
        return None
    extension = match.group(1).lower()
    content_types = {
        "avi": "video/x-msvideo",
        "mov": "video/quicktime",
        "mp4": "video/mp4",
        "wmv": "video/x-ms-wmv",
    }
    size = document.get("file_size")
    return Target(
        f"house-oversight/NATIVES/001/{bates}.{extension}",
        "house-native",
        str(document["id"]),
        int(size) if size is not None else None,
        content_types[extension],
    )


def parse_wrangler_json(output: str) -> list[dict]:
    cleaned = ANSI_ESCAPE.sub("", output)
    start = cleaned.find("[")
    if start < 0:
        raise RuntimeError(f"Wrangler did not return JSON: {cleaned[-500:]}")
    payload = json.loads(cleaned[start:])
    if not payload or not payload[0].get("success"):
        raise RuntimeError(f"D1 query failed: {payload}")
    return payload[0].get("results", [])


def wrangler_command() -> str:
    executable = shutil.which("npx.cmd" if os.name == "nt" else "npx")
    if not executable:
        raise RuntimeError("npx is required to query the configured D1 database")
    return executable


def query_d1(sql: str, project_dir: Path) -> list[dict]:
    command = [
        wrangler_command(),
        "--yes",
        f"wrangler@{WRANGLER_VERSION}",
        "d1",
        "execute",
        "epstein-files-db",
        "--remote",
        "--command",
        sql,
        "--json",
    ]
    completed = subprocess.run(
        command,
        cwd=project_dir,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip())
    return parse_wrangler_json(completed.stdout)


def paged_d1(select: str, table: str, project_dir: Path, page_size: int = 5000) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        page = query_d1(
            f"SELECT {select} FROM {table} ORDER BY id LIMIT {page_size} OFFSET {offset}",
            project_dir,
        )
        rows.extend(page)
        if len(page) < page_size:
            return rows
        offset += len(page)


def add_target(targets: dict[str, Target], target: Target, conflicts: list[dict]) -> None:
    existing = targets.get(target.key)
    if existing and (
        existing.expected_size != target.expected_size
        or existing.expected_type != target.expected_type
    ):
        conflicts.append({"key": target.key, "first": dataclasses.asdict(existing), "second": dataclasses.asdict(target)})
        return
    targets.setdefault(target.key, target)


def load_manifest_targets(media_base: str, timeout: float) -> list[Target]:
    url = f"{media_base.rstrip('/')}/images/manifest.json"
    request = urllib.request.Request(url, headers={"User-Agent": "epstein-integrity-audit/1"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        manifest = json.load(response)
    targets = []
    for item in manifest.get("images", []):
        filename = str(item.get("filename") or "")
        if not filename or "/" in filename or "\\" in filename:
            continue
        content_type = mimetypes.guess_type(filename)[0]
        targets.append(Target(f"images/{filename}", "manifest-image", filename, expected_type=content_type))
    return targets


def build_targets(project_dir: Path, media_base: str, timeout: float) -> tuple[dict[str, Target], list[dict], list[dict]]:
    documents = paged_d1(
        "id, filename, title, local_path, file_size, content_type, document_type, data_set",
        "documents",
        project_dir,
    )
    house_documents = paged_d1("id, bates_number, page_count", "house_oversight_documents", project_dir)
    targets: dict[str, Target] = {}
    conflicts: list[dict] = []
    invalid_paths: list[dict] = []

    for doc in documents:
        doc_id = int(doc["id"])
        if doc.get("data_set") != "house-oversight-estate":
            key = document_r2_key(doc.get("local_path"))
            if not key:
                invalid_paths.append({"id": doc_id, "local_path": doc.get("local_path")})
            else:
                size = doc.get("file_size")
                add_target(
                    targets,
                    Target(
                        key,
                        "document",
                        str(doc_id),
                        int(size) if size is not None else None,
                        doc.get("content_type"),
                    ),
                    conflicts,
                )
        if doc.get("document_type") == "video":
            add_target(
                targets,
                Target(f"thumbnails/{doc_id}.jpg", "video-thumbnail", str(doc_id), expected_type="image/jpeg"),
                conflicts,
            )
        native = house_native_target(doc)
        if native:
            add_target(targets, native, conflicts)
            playback_key = f"streaming/{native.key.rsplit('.', 1)[0]}.mp4"
            add_target(
                targets,
                Target(playback_key, "house-native-playback", native.reference, expected_type="video/mp4"),
                conflicts,
            )

    for house in house_documents:
        for target in house_page_targets(house.get("bates_number"), house.get("page_count")):
            add_target(targets, target, conflicts)

    for target in load_manifest_targets(media_base, timeout):
        add_target(targets, target, conflicts)

    return targets, conflicts, invalid_paths


def normalize_media_type(value: str | None) -> str | None:
    if not value:
        return None
    media_type = str(value).split(";", 1)[0].strip().lower()
    aliases = {
        "audio/vnd.wave": "audio/wav",
        "audio/wave": "audio/wav",
        "audio/x-wav": "audio/wav",
        "image/jpg": "image/jpeg",
    }
    return aliases.get(media_type, media_type)


async def check_target(
    target: Target,
    media_base: str,
    session: aiohttp.ClientSession,
    retries: int,
) -> dict:
    url = f"{media_base.rstrip('/')}/{urllib.parse.quote(target.key, safe='/')}"
    last_error = None
    for attempt in range(retries + 1):
        try:
            async with session.head(url, allow_redirects=False) as response:
                status = response.status
                if status in {429, 500, 502, 503, 504} and attempt < retries:
                    last_error = RuntimeError(f"HTTP {status}")
                elif status >= 400:
                    return {
                        "key": target.key,
                        "kind": target.kind,
                        "reference": target.reference,
                        "status": status,
                        "problem": "missing" if status == 404 else "http-error",
                    }
                else:
                    length_header = response.headers.get("Content-Length")
                    actual_size = int(length_header) if length_header and length_header.isdigit() else None
                    actual_type = normalize_media_type(response.headers.get("Content-Type"))
                    finding = {
                        "key": target.key,
                        "kind": target.kind,
                        "reference": target.reference,
                        "status": status,
                        "expected_size": target.expected_size,
                        "actual_size": actual_size,
                        "expected_type": normalize_media_type(target.expected_type),
                        "actual_type": actual_type,
                    }
                    if actual_size == 0:
                        finding["problem"] = "zero-byte"
                    elif target.expected_size not in (None, 0) and actual_size != target.expected_size:
                        finding["problem"] = "size-mismatch"
                    elif finding["expected_type"] and actual_type and finding["expected_type"] != actual_type:
                        finding["problem"] = "type-mismatch"
                    return finding
        except (aiohttp.ClientError, asyncio.TimeoutError) as error:
            last_error = error
            if attempt == retries:
                break
        await asyncio.sleep(0.25 * (2**attempt))
    return {
        "key": target.key,
        "kind": target.kind,
        "reference": target.reference,
        "status": None,
        "problem": "request-error",
        "error": str(last_error),
    }


async def run_audit_async(
    targets: Iterable[Target],
    media_base: str,
    workers: int,
    timeout: float,
    retries: int,
) -> list[dict]:
    target_list = list(targets)
    findings: list[dict] = []
    queue: asyncio.Queue[Target] = asyncio.Queue()
    for target in target_list:
        queue.put_nowait(target)
    completed = 0
    client_timeout = aiohttp.ClientTimeout(total=timeout)
    connector = aiohttp.TCPConnector(
        limit=workers,
        limit_per_host=workers,
        ttl_dns_cache=300,
        enable_cleanup_closed=True,
    )
    async with aiohttp.ClientSession(
        timeout=client_timeout,
        connector=connector,
        headers={"User-Agent": "epstein-integrity-audit/1"},
    ) as session:
        async def worker() -> None:
            nonlocal completed
            while True:
                try:
                    target = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                result = await check_target(target, media_base, session, retries)
                completed += 1
                if result.get("problem"):
                    findings.append(result)
                if completed % 1000 == 0 or completed == len(target_list):
                    print(f"checked {completed:,}/{len(target_list):,}; findings {len(findings):,}", flush=True)

        await asyncio.gather(*(worker() for _ in range(min(workers, len(target_list)))))
    return sorted(findings, key=lambda item: (item.get("problem", ""), item["key"]))


def run_audit(targets: Iterable[Target], media_base: str, workers: int, timeout: float, retries: int) -> list[dict]:
    return asyncio.run(run_audit_async(targets, media_base, workers, timeout, retries))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--media-base", default=DEFAULT_MEDIA_BASE)
    parser.add_argument("--workers", type=int, default=128)
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--limit", type=int, default=0, help="Audit only the first N derived targets")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    project_dir = Path(__file__).resolve().parent
    targets, conflicts, invalid_paths = build_targets(project_dir, args.media_base, args.timeout)
    selected = list(targets.values())[: args.limit or None]
    print(
        f"derived {len(targets):,} unique targets "
        f"({len(conflicts):,} metadata conflicts, {len(invalid_paths):,} invalid paths)",
        flush=True,
    )
    findings = run_audit(selected, args.media_base, max(1, args.workers), args.timeout, max(0, args.retries))
    summary: dict[str, int] = {}
    for finding in findings:
        problem = finding["problem"]
        summary[problem] = summary.get(problem, 0) + 1
    report = {
        "media_base": args.media_base,
        "targets_derived": len(targets),
        "targets_checked": len(selected),
        "summary": summary,
        "metadata_conflicts": conflicts,
        "invalid_document_paths": invalid_paths,
        "findings": findings,
    }
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"report: {args.report}")
    print(json.dumps(summary, sort_keys=True))
    for finding in findings[:20]:
        print(f"{finding['problem']}: {finding['key']} ({finding['reference']})")
    return 1 if findings or conflicts or invalid_paths else 0


if __name__ == "__main__":
    sys.exit(main())
