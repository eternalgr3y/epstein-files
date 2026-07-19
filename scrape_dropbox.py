#!/usr/bin/env python3
"""
Dropbox scraper for House Oversight Committee Epstein documents.
Uses Dropbox API with parallel downloads for speed.
"""

import os
import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading
import dropbox
from dropbox.files import FolderMetadata, FileMetadata

# Configuration
TOKEN = os.environ.get("DROPBOX_TOKEN")
BASE_DIR = Path.home() / "epstein-raw"
MAX_WORKERS = 8  # Parallel downloads

SOURCES = {
    "house-oversight-estate": {
        "name": "House Oversight - Epstein Estate",
        "url": "https://www.dropbox.com/scl/fo/9bq6uj0pnycpa4gxqiuzs/ABBA-BoYUAT7627MBeLiVYg?rlkey=3s6ggcjihou9nt8srsn2qt1n7&dl=0",
    },
    "house-oversight-doj": {
        "name": "House Oversight - DOJ Records",
        "url": "https://www.dropbox.com/scl/fo/98fthv8otekjk28lcrnc5/AIn3egnE58MYe4Bn4fliVBw?rlkey=m7p8e9omml96fgxl13kr2nuyt&dl=0",
    },
}

# Thread-safe counters
stats_lock = threading.Lock()
stats = {"downloaded": 0, "skipped": 0, "errors": 0, "bytes": 0}

def list_shared_folder(dbx, shared_link_obj, path=""):
    """List all entries in a shared folder path."""
    entries = []
    result = dbx.files_list_folder(path=path, shared_link=shared_link_obj)
    while True:
        entries.extend(result.entries)
        if result.has_more:
            result = dbx.files_list_folder_continue(result.cursor)
        else:
            break
    return entries


def download_file(url, file_path, out_path, size):
    """Download a single file. Thread-safe - creates own client."""
    try:
        # Skip if already downloaded and same size
        if out_path.exists() and out_path.stat().st_size == size:
            with stats_lock:
                stats["skipped"] += 1
            return "skip", out_path.name

        # Create new client per thread (not thread-safe otherwise)
        dbx = dropbox.Dropbox(TOKEN)
        metadata, response = dbx.sharing_get_shared_link_file(url=url, path=file_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, 'wb') as f:
            f.write(response.content)

        with stats_lock:
            stats["downloaded"] += 1
            stats["bytes"] += size

        return "ok", out_path.name
    except Exception as e:
        with stats_lock:
            stats["errors"] += 1
        return "error", f"{out_path.name}: {e}"


def collect_all_files(dbx, url, output_dir, path="", visited=None):
    """Recursively collect all files to download."""
    if visited is None:
        visited = set()

    if path in visited:
        return []
    visited.add(path)

    files_to_download = []
    shared_link_obj = dropbox.files.SharedLink(url=url)

    try:
        entries = list_shared_folder(dbx, shared_link_obj, path)
    except dropbox.exceptions.ApiError as e:
        print(f"Error listing '{path}': {e}")
        return []

    folders = [e for e in entries if isinstance(e, FolderMetadata)]
    files = [e for e in entries if isinstance(e, FileMetadata)]

    print(f"[{path or '/'}] {len(files)} files, {len(folders)} folders")

    # Collect files
    for entry in files:
        file_path = f"{path}/{entry.name}" if path else f"/{entry.name}"
        out_path = Path(output_dir) / path.lstrip('/') / entry.name if path else Path(output_dir) / entry.name
        files_to_download.append((file_path, out_path, entry.size))

    # Recurse into folders
    for entry in folders:
        subpath = f"{path}/{entry.name}" if path else f"/{entry.name}"
        files_to_download.extend(collect_all_files(dbx, url, output_dir, subpath, visited))

    return files_to_download


def download_shared_folder(dbx, url, output_dir):
    """Download all files with parallel workers."""
    print("Scanning folder structure...")
    files = collect_all_files(dbx, url, output_dir)

    total_files = len(files)
    total_size_gb = sum(f[2] for f in files) / (1024**3)
    print(f"\nFound {total_files:,} files ({total_size_gb:.2f} GB)")
    print(f"Starting download with {MAX_WORKERS} parallel workers...\n")

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {}
        for file_path, out_path, size in files:
            future = executor.submit(download_file, url, file_path, out_path, size)
            futures[future] = (file_path, out_path.name)

        for i, future in enumerate(as_completed(futures), 1):
            status, msg = future.result()

            with stats_lock:
                downloaded = stats["downloaded"]
                skipped = stats["skipped"]
                errors = stats["errors"]
                mb = stats["bytes"] / (1024**2)

            # Progress every 100 files or on errors
            if i % 100 == 0 or status == "error":
                pct = (i / total_files) * 100
                print(f"[{pct:5.1f}%] {i:,}/{total_files:,} | {downloaded:,} new, {skipped:,} skip, {errors} err | {mb:.0f} MB")

            if status == "error":
                print(f"  ERROR: {msg}")

    print(f"\n{'='*60}")
    print(f"Done! {stats['downloaded']:,} downloaded, {stats['skipped']:,} skipped, {stats['errors']} errors")
    print(f"Total: {stats['bytes']/(1024**3):.2f} GB")


def main():
    if not TOKEN:
        print("Error: Set DROPBOX_TOKEN environment variable")
        sys.exit(1)

    if len(sys.argv) < 2:
        print("Usage: DROPBOX_TOKEN=xxx python scrape_dropbox.py <source|list>")
        print("\nSources:")
        for key, src in SOURCES.items():
            print(f"  {key}: {src['name']}")
        sys.exit(1)

    source_key = sys.argv[1]

    if source_key == "list":
        for key, src in SOURCES.items():
            print(f"{key}: {src['name']}")
        return

    if source_key not in SOURCES:
        print(f"Unknown source: {source_key}")
        sys.exit(1)

    source = SOURCES[source_key]
    output_dir = BASE_DIR / source_key

    print(f"\n{'='*60}")
    print(f"Downloading: {source['name']}")
    print(f"Output: {output_dir}")
    print(f"Workers: {MAX_WORKERS}")
    print(f"{'='*60}\n")

    dbx = dropbox.Dropbox(TOKEN)

    # Test connection
    try:
        account = dbx.users_get_current_account()
        print(f"Connected as: {account.name.display_name}\n")
    except Exception as e:
        print(f"Auth error: {e}")
        sys.exit(1)

    download_shared_folder(dbx, source["url"], output_dir)


if __name__ == "__main__":
    main()
