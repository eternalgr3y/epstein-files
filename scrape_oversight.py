#!/usr/bin/env python3
"""
Scraper for House Oversight Committee Epstein documents.

Sources:
1. Epstein Estate Documents (20,000 pages)
2. DOJ Records via House Oversight (33,295 pages)
"""

import os
import subprocess
import sys
from pathlib import Path

BASE_DIR = Path("/mnt/e/epstein-files")
RAW_DIR = BASE_DIR / "raw"

# House Oversight document sources
SOURCES = {
    "house-oversight-estate": {
        "name": "House Oversight - Epstein Estate",
        "description": "20,000 pages from the Epstein Estate released by House Oversight Committee",
        "gdrive": "https://drive.google.com/drive/folders/1hTNH5woIRio578onLGElkTWofUSWRoH_",
        "dropbox": "https://www.dropbox.com/scl/fo/9bq6uj0pnycpa4gxqiuzs/ABBA-BoYUAT7627MBeLiVYg?rlkey=3s6ggcjihou9nt8srsn2qt1n7&dl=1",
    },
    "house-oversight-doj": {
        "name": "House Oversight - DOJ Records",
        "description": "33,295 pages of DOJ records released by House Oversight Committee",
        "gdrive": "https://drive.google.com/drive/folders/1TrGxDGQLDLZu1vvvZDBAh-e7wN3y6Hoz",
        "dropbox": "https://www.dropbox.com/scl/fo/98fthv8otekjk28lcrnc5/AIn3egnE58MYe4Bn4fliVBw?rlkey=m7p8e9omml96fgxl13kr2nuyt&dl=1",
    },
}


def install_gdown():
    """Install gdown if not available."""
    try:
        import gdown
        return True
    except ImportError:
        print("Installing gdown...")
        subprocess.run([sys.executable, "-m", "pip", "install", "gdown"], check=True)
        return True


def download_gdrive_folder(folder_url: str, output_dir: Path):
    """Download a Google Drive folder using gdown."""
    import gdown

    output_dir.mkdir(parents=True, exist_ok=True)

    # Extract folder ID
    if "folders/" in folder_url:
        folder_id = folder_url.split("folders/")[1].split("?")[0].split("/")[0]
    else:
        folder_id = folder_url

    print(f"Downloading folder {folder_id} to {output_dir}")
    gdown.download_folder(id=folder_id, output=str(output_dir), quiet=False)


def download_source(source_key: str):
    """Download documents from a specific source."""
    if source_key not in SOURCES:
        print(f"Unknown source: {source_key}")
        print(f"Available sources: {list(SOURCES.keys())}")
        return

    source = SOURCES[source_key]
    output_dir = RAW_DIR / source_key

    print(f"\n{'='*60}")
    print(f"Downloading: {source['name']}")
    print(f"Description: {source['description']}")
    print(f"Output: {output_dir}")
    print(f"{'='*60}\n")

    install_gdown()

    try:
        download_gdrive_folder(source["gdrive"], output_dir)
        print(f"\nSuccess! Downloaded to {output_dir}")
    except Exception as e:
        print(f"Google Drive failed: {e}")
        print("Try downloading manually from:")
        print(f"  GDrive: {source['gdrive']}")
        print(f"  Dropbox: {source['dropbox']}")


def list_sources():
    """List all available sources."""
    print("\nAvailable sources:")
    print("-" * 60)
    for key, source in SOURCES.items():
        print(f"\n  {key}:")
        print(f"    Name: {source['name']}")
        print(f"    Description: {source['description']}")
    print()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python scrape_oversight.py <source|all|list>")
        print("\nExamples:")
        print("  python scrape_oversight.py list")
        print("  python scrape_oversight.py house-oversight-estate")
        print("  python scrape_oversight.py all")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "list":
        list_sources()
    elif cmd == "all":
        for source_key in SOURCES:
            download_source(source_key)
    else:
        download_source(cmd)
