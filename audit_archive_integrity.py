#!/usr/bin/env python3
"""Compare production D1 references with one paged R2 inventory.

The audit never probes public media URLs. It reads document metadata through
Wrangler and lists R2 object metadata through Cloudflare's authenticated
management API. No object bodies are downloaded except the small image
manifest, and the command does not mutate D1, R2, Pages, or Worker settings.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from qa_request_budget import RequestBudget, RequestBudgetExceeded


WRANGLER_VERSION = "4.112.0"
DEFAULT_REQUEST_BUDGET = 120
CLOUDFLARE_API = "https://api.cloudflare.com/client/v4"
USER_AGENT = "epstein-integrity-audit/2"
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


@dataclasses.dataclass(frozen=True)
class InventoryObject:
    key: str
    size: int | None
    content_type: str | None


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
        targets.append(
            Target(
                key,
                "house-page",
                f"{bates}:{offset}",
                expected_type="image/jpeg",
            )
        )
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
        raise RuntimeError("npx is required to use the configured Cloudflare account")
    return executable


def wrangler_args(*args: str) -> list[str]:
    return [
        wrangler_command(),
        "--yes",
        f"wrangler@{WRANGLER_VERSION}",
        *args,
    ]


def configured_cloudflare_target(project_dir: Path) -> tuple[str, str]:
    with (project_dir / "wrangler.toml").open("rb") as handle:
        config = tomllib.load(handle)
    account_id = str(config.get("account_id") or "")
    buckets = config.get("r2_buckets") or []
    bucket = next(
        (item for item in buckets if item.get("binding") == "R2"),
        buckets[0] if buckets else {},
    )
    bucket_name = str(bucket.get("bucket_name") or "")
    if not account_id or not bucket_name:
        raise RuntimeError("wrangler.toml must define account_id and an R2 bucket")
    return account_id, bucket_name


def configured_cloudflare_token(project_dir: Path, budget: RequestBudget) -> str:
    environment_token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if environment_token:
        return environment_token
    budget.consume("Wrangler authentication")
    completed = subprocess.run(
        wrangler_args("auth", "token", "--json"),
        cwd=project_dir,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode:
        raise RuntimeError("Wrangler could not retrieve its configured authentication token")
    cleaned = ANSI_ESCAPE.sub("", completed.stdout)
    start = cleaned.find("{")
    if start < 0:
        raise RuntimeError("Wrangler authentication returned an invalid response")
    try:
        token = str(json.loads(cleaned[start:]).get("token") or "")
    except json.JSONDecodeError as exc:
        raise RuntimeError("Wrangler authentication returned invalid JSON") from exc
    if not token:
        raise RuntimeError("Wrangler authentication did not return a token")
    return token


def query_d1(
    sql: str,
    project_dir: Path,
    budget: RequestBudget,
) -> list[dict]:
    budget.consume("D1 metadata query")
    command = wrangler_args(
        "d1",
        "execute",
        "epstein-files-db",
        "--remote",
        "--command",
        sql,
        "--json",
    )
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


def paged_d1(
    select: str,
    table: str,
    project_dir: Path,
    budget: RequestBudget,
    page_size: int = 5000,
) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        page = query_d1(
            f"SELECT {select} FROM {table} ORDER BY id LIMIT {page_size} OFFSET {offset}",
            project_dir,
            budget,
        )
        rows.extend(page)
        if len(page) < page_size:
            return rows
        offset += len(page)


def cloudflare_get(
    url: str,
    token: str,
    budget: RequestBudget,
    timeout: float,
    retries: int,
    label: str,
) -> bytes:
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        budget.consume(label)
        request = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "User-Agent": USER_AGENT,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            if exc.code not in {429, 500, 502, 503, 504} or attempt == retries:
                raise RuntimeError(f"{label} returned HTTP {exc.code}") from exc
            last_error = exc
        except (OSError, TimeoutError) as exc:
            last_error = exc
            if attempt == retries:
                break
        time.sleep(0.25 * (2**attempt))
    raise RuntimeError(f"{label} failed: {last_error}")


def parse_r2_list_page(payload: dict) -> tuple[list[InventoryObject], str | None]:
    if payload.get("success") is not True or not isinstance(payload.get("result"), list):
        raise RuntimeError("Cloudflare returned an invalid R2 inventory page")
    objects: list[InventoryObject] = []
    for item in payload["result"]:
        key = str(item.get("key") or "")
        if not key:
            raise RuntimeError("R2 inventory contains an object without a key")
        size = item.get("size")
        metadata = item.get("http_metadata") or {}
        objects.append(
            InventoryObject(
                key,
                int(size) if size is not None else None,
                metadata.get("contentType"),
            )
        )
    result_info = payload.get("result_info") or {}
    if result_info.get("is_truncated"):
        cursor = str(result_info.get("cursor") or "")
        if not cursor:
            raise RuntimeError("truncated R2 inventory page did not include a cursor")
        return objects, cursor
    return objects, None


def list_r2_inventory(
    account_id: str,
    bucket_name: str,
    token: str,
    budget: RequestBudget,
    timeout: float,
    retries: int,
) -> dict[str, InventoryObject]:
    encoded_bucket = urllib.parse.quote(bucket_name, safe="")
    endpoint = (
        f"{CLOUDFLARE_API}/accounts/{account_id}/r2/buckets/"
        f"{encoded_bucket}/objects"
    )
    inventory: dict[str, InventoryObject] = {}
    cursor: str | None = None
    seen_cursors: set[str] = set()
    pages = 0
    while True:
        query = {"per_page": "1000"}
        if cursor:
            query["cursor"] = cursor
        body = cloudflare_get(
            f"{endpoint}?{urllib.parse.urlencode(query)}",
            token,
            budget,
            timeout,
            retries,
            "R2 inventory page",
        )
        try:
            page_objects, next_cursor = parse_r2_list_page(json.loads(body))
        except json.JSONDecodeError as exc:
            raise RuntimeError("Cloudflare returned invalid JSON for the R2 inventory") from exc
        for item in page_objects:
            if item.key in inventory:
                raise RuntimeError(f"R2 inventory repeated object key: {item.key}")
            inventory[item.key] = item
        pages += 1
        if pages % 10 == 0 or not next_cursor:
            print(
                f"inventory pages {pages:,}; objects {len(inventory):,}; "
                f"requests {budget.used}/{budget.limit}",
                flush=True,
            )
        if not next_cursor:
            return inventory
        if next_cursor in seen_cursors:
            raise RuntimeError("R2 inventory repeated a pagination cursor")
        seen_cursors.add(next_cursor)
        cursor = next_cursor


def fetch_r2_manifest(
    account_id: str,
    bucket_name: str,
    token: str,
    budget: RequestBudget,
    timeout: float,
    retries: int,
) -> dict:
    encoded_bucket = urllib.parse.quote(bucket_name, safe="")
    object_key = urllib.parse.quote("images/manifest.json", safe="/")
    url = (
        f"{CLOUDFLARE_API}/accounts/{account_id}/r2/buckets/"
        f"{encoded_bucket}/objects/{object_key}"
    )
    body = cloudflare_get(
        url,
        token,
        budget,
        timeout,
        retries,
        "R2 image manifest",
    )
    try:
        manifest = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError("R2 image manifest is not valid JSON") from exc
    if not isinstance(manifest, dict):
        raise RuntimeError("R2 image manifest must be a JSON object")
    return manifest


def add_target(targets: dict[str, Target], target: Target, conflicts: list[dict]) -> None:
    existing = targets.get(target.key)
    if existing and (
        existing.expected_size != target.expected_size
        or existing.expected_type != target.expected_type
    ):
        conflicts.append(
            {
                "key": target.key,
                "first": dataclasses.asdict(existing),
                "second": dataclasses.asdict(target),
            }
        )
        return
    targets.setdefault(target.key, target)


def load_manifest_targets(manifest: dict) -> list[Target]:
    targets = [
        Target(
            "images/manifest.json",
            "image-manifest",
            "images/manifest.json",
            expected_type="application/json",
        )
    ]
    for item in manifest.get("images", []):
        filename = str(item.get("filename") or "")
        if not filename or "/" in filename or "\\" in filename:
            continue
        content_type = mimetypes.guess_type(filename)[0]
        targets.append(
            Target(
                f"images/{filename}",
                "manifest-image",
                filename,
                expected_type=content_type,
            )
        )
    return targets


def build_targets(
    project_dir: Path,
    manifest: dict,
    budget: RequestBudget,
) -> tuple[dict[str, Target], list[dict], list[dict]]:
    documents = paged_d1(
        "id, filename, title, local_path, file_size, content_type, document_type, data_set",
        "documents",
        project_dir,
        budget,
    )
    house_documents = paged_d1(
        "id, bates_number, page_count",
        "house_oversight_documents",
        project_dir,
        budget,
    )
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
                Target(
                    f"thumbnails/{doc_id}.jpg",
                    "video-thumbnail",
                    str(doc_id),
                    expected_type="image/jpeg",
                ),
                conflicts,
            )
        native = house_native_target(doc)
        if native:
            add_target(targets, native, conflicts)
            playback_key = f"streaming/{native.key.rsplit('.', 1)[0]}.mp4"
            add_target(
                targets,
                Target(
                    playback_key,
                    "house-native-playback",
                    native.reference,
                    expected_type="video/mp4",
                ),
                conflicts,
            )

    for house in house_documents:
        for target in house_page_targets(
            house.get("bates_number"),
            house.get("page_count"),
        ):
            add_target(targets, target, conflicts)

    for target in load_manifest_targets(manifest):
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


def compare_targets(
    targets: dict[str, Target],
    inventory: dict[str, InventoryObject],
) -> list[dict]:
    findings: list[dict] = []
    for target in targets.values():
        actual = inventory.get(target.key)
        if not actual:
            findings.append(
                {
                    "key": target.key,
                    "kind": target.kind,
                    "reference": target.reference,
                    "problem": "missing",
                }
            )
            continue
        expected_type = normalize_media_type(target.expected_type)
        actual_type = normalize_media_type(actual.content_type)
        finding = {
            "key": target.key,
            "kind": target.kind,
            "reference": target.reference,
            "expected_size": target.expected_size,
            "actual_size": actual.size,
            "expected_type": expected_type,
            "actual_type": actual_type,
        }
        if actual.size == 0:
            finding["problem"] = "zero-byte"
        elif (
            target.expected_size not in (None, 0)
            and actual.size != target.expected_size
        ):
            finding["problem"] = "size-mismatch"
        elif expected_type and actual_type and expected_type != actual_type:
            finding["problem"] = "type-mismatch"
        else:
            continue
        findings.append(finding)
    return sorted(findings, key=lambda item: (item["problem"], item["key"]))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account-id", help="Override wrangler.toml account_id")
    parser.add_argument("--bucket", help="Override the wrangler.toml R2 bucket")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument(
        "--max-requests",
        type=int,
        default=DEFAULT_REQUEST_BUDGET,
        help=(
            "Hard ceiling across authentication, D1 queries, R2 inventory pages, "
            f"and retries (default: {DEFAULT_REQUEST_BUDGET})"
        ),
    )
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    project_dir = Path(__file__).resolve().parent
    budget = RequestBudget(args.max_requests)
    print(
        f"request budget: {budget.limit} maximum; public media requests: 0",
        flush=True,
    )
    try:
        configured_account, configured_bucket = configured_cloudflare_target(project_dir)
        account_id = args.account_id or configured_account
        bucket_name = args.bucket or configured_bucket
        token = configured_cloudflare_token(project_dir, budget)
        inventory = list_r2_inventory(
            account_id,
            bucket_name,
            token,
            budget,
            args.timeout,
            max(0, args.retries),
        )
        manifest = fetch_r2_manifest(
            account_id,
            bucket_name,
            token,
            budget,
            args.timeout,
            max(0, args.retries),
        )
        targets, conflicts, invalid_paths = build_targets(
            project_dir,
            manifest,
            budget,
        )
    except (RequestBudgetExceeded, RuntimeError, ValueError) as exc:
        print(f"stopped: {exc}", file=sys.stderr)
        print(f"requests used: {budget.used}/{budget.limit}", file=sys.stderr)
        return 2

    print(
        f"derived {len(targets):,} unique targets from D1 and the image manifest "
        f"({len(conflicts):,} metadata conflicts, {len(invalid_paths):,} invalid paths)",
        flush=True,
    )
    findings = compare_targets(targets, inventory)
    summary: dict[str, int] = {}
    for finding in findings:
        problem = finding["problem"]
        summary[problem] = summary.get(problem, 0) + 1
    referenced_keys = set(targets)
    unreferenced_count = sum(key not in referenced_keys for key in inventory)
    report = {
        "source": "cloudflare-r2-inventory",
        "account_id": account_id,
        "bucket": bucket_name,
        "public_media_requests": 0,
        "request_budget": budget.limit,
        "requests_used": budget.used,
        "inventory_objects": len(inventory),
        "targets_derived": len(targets),
        "unreferenced_inventory_objects": unreferenced_count,
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
    print(f"requests used: {budget.used}/{budget.limit}; public media requests: 0")
    for finding in findings[:20]:
        print(f"{finding['problem']}: {finding['key']} ({finding['reference']})")
    return 1 if findings or conflicts or invalid_paths else 0


if __name__ == "__main__":
    sys.exit(main())
