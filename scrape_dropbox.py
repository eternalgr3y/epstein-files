#!/usr/bin/env python3
"""
Dropbox scraper for House Oversight Committee Epstein documents.
Uses Dropbox API to download shared folders.
"""

import os
import sys
from pathlib import Path
import dropbox
from dropbox.files import FolderMetadata, FileMetadata

# Configuration
TOKEN = os.environ.get("DROPBOX_TOKEN")
BASE_DIR = Path("/mnt/e/epstein-files/raw")

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


def download_shared_folder(dbx, url, output_dir, path="", visited=None):
    """Recursively download all files from a shared folder."""
    if visited is None:
        visited = set()

    # Prevent infinite loops
    if path in visited:
        print(f"  [cycle: {path}]")
        return
    visited.add(path)

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    shared_link_obj = dropbox.files.SharedLink(url=url)

    try:
        entries = list_shared_folder(dbx, shared_link_obj, path)
    except dropbox.exceptions.ApiError as e:
        print(f"Error listing '{path}': {e}")
        return

    folders = [e for e in entries if isinstance(e, FolderMetadata)]
    files = [e for e in entries if isinstance(e, FileMetadata)]

    print(f"[{path or '/'}] {len(files)} files, {len(folders)} folders")

    # Download files
    for entry in files:
        out_path = output_dir / entry.name

        # Skip if already downloaded and same size
        if out_path.exists() and out_path.stat().st_size == entry.size:
            print(f"  [skip] {entry.name}")
            continue

        size_mb = entry.size / (1024*1024)
        print(f"  [dl] {entry.name} ({size_mb:.1f} MB)")

        # Build full path for download
        file_path = f"{path}/{entry.name}" if path else f"/{entry.name}"

        try:
            metadata, response = dbx.sharing_get_shared_link_file(
                url=url,
                path=file_path
            )
            with open(out_path, 'wb') as f:
                f.write(response.content)
        except Exception as e:
            print(f"    ERROR: {e}")

    # Recurse into folders
    for entry in folders:
        subfolder = output_dir / entry.name
        # Build path manually from folder name
        subpath = f"{path}/{entry.name}" if path else f"/{entry.name}"
        print(f"\n>> {subpath}")
        download_shared_folder(dbx, url, subfolder, subpath, visited)


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
    print(f"\n\nDone! Files saved to {output_dir}")


if __name__ == "__main__":
    main()
