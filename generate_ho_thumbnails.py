#!/usr/bin/env python3
"""Generate real thumbnails for House Oversight documents.

The live thumbnail endpoint currently serves the full-resolution page-0 scan
(2550x3369px, ~3.8MB) for every grid card, which is why the House Oversight
grid renders blank/slow (36 cards x ~4MB = ~140MB per page load). This script
downloads page 0 for each document, resizes it down, and uploads the small
version to R2 so the worker can serve that instead.
"""
import io
import json
import os
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from PIL import Image

API = os.getenv("EPSTEIN_API_URL", "https://epsteinproject.org/api").rstrip("/")
BUCKET = "epstein-files"
THUMB_WIDTH = 420
JPEG_QUALITY = 72
WORKERS = 6
TMP_DIR = Path("/tmp/ho_thumbs")
TMP_DIR.mkdir(exist_ok=True)


HEADERS = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) epstein-files-thumbnail-gen/1.0"}


def fetch_json(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def list_all_bates():
    bates = []
    offset = 0
    while True:
        data = fetch_json(f"{API}/house-oversight/documents?limit=100&offset={offset}")
        docs = data["documents"]
        if not docs:
            break
        bates.extend(d["bates"] for d in docs)
        offset += len(docs)
        if offset >= data["total"]:
            break
    return bates


def make_thumbnail(bates):
    src_url = f"{API}/house-oversight/page/{bates}/0"
    try:
        req = urllib.request.Request(src_url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
    except Exception as e:
        return bates, f"download failed: {e}"

    try:
        im = Image.open(io.BytesIO(raw))
        im = im.convert("RGB")
        w, h = im.size
        new_h = int(h * (THUMB_WIDTH / w))
        im = im.resize((THUMB_WIDTH, new_h), Image.LANCZOS)
        out_path = TMP_DIR / f"{bates}.jpg"
        im.save(out_path, "JPEG", quality=JPEG_QUALITY, optimize=True)
    except Exception as e:
        return bates, f"resize failed: {e}"
    finally:
        del raw

    key = f"house-oversight/thumbnails/{bates}.jpg"
    result = subprocess.run(
        [
            "bunx", "wrangler", "r2", "object", "put",
            f"{BUCKET}/{key}",
            "--file", str(out_path),
            "--content-type", "image/jpeg",
            "--cache-control", "public, max-age=31536000, immutable",
            "--remote",
        ],
        capture_output=True, text=True, timeout=60,
    )
    out_path.unlink(missing_ok=True)
    if result.returncode != 0:
        return bates, f"upload failed: {result.stderr[-300:]}"
    return bates, "ok"


def main():
    print("Listing all House Oversight documents...")
    bates_list = list_all_bates()
    print(f"Found {len(bates_list)} documents")

    done = 0
    errors = []
    start = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = {ex.submit(make_thumbnail, b): b for b in bates_list}
        for fut in as_completed(futures):
            bates, status = fut.result()
            done += 1
            if status != "ok":
                errors.append((bates, status))
                print(f"  ERROR {bates}: {status}")
            if done % 50 == 0 or done == len(bates_list):
                elapsed = time.time() - start
                rate = done / elapsed if elapsed else 0
                print(f"[{done}/{len(bates_list)}] {rate:.1f}/s, {len(errors)} errors, {elapsed:.0f}s elapsed")

    print(f"\nDone. {done - len(errors)} succeeded, {len(errors)} failed.")
    if errors:
        print("Failures:")
        for b, s in errors[:30]:
            print(f"  {b}: {s}")


if __name__ == "__main__":
    main()
