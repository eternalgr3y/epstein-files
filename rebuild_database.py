#!/usr/bin/env python3
"""
Rebuild the Epstein Files database from SQL dump.

Usage:
    python rebuild_database.py                    # Use local sql.gz file
    python rebuild_database.py --download         # Download from archive.org first
"""

import sqlite3
import gzip
import os
import sys
import argparse
from pathlib import Path

ARCHIVE_URL = "https://archive.org/download/epstein-files-db/epstein_files.sql.gz"
SQL_GZ_PATH = Path(__file__).parent / "epstein_files.sql.gz"
DB_DIR = Path(__file__).parent / "database"
DB_PATH = DB_DIR / "epstein_files.db"


def download_dump():
    """Download the SQL dump from archive.org."""
    import urllib.request

    print(f"Downloading from {ARCHIVE_URL}...")
    urllib.request.urlretrieve(ARCHIVE_URL, SQL_GZ_PATH)
    size_mb = os.path.getsize(SQL_GZ_PATH) / 1024 / 1024
    print(f"Downloaded: {size_mb:.1f} MB")


def rebuild_database():
    """Rebuild SQLite database from compressed SQL dump."""
    if not SQL_GZ_PATH.exists():
        print(f"Error: {SQL_GZ_PATH} not found")
        print("Run with --download to fetch from archive.org")
        sys.exit(1)

    # Create database directory
    DB_DIR.mkdir(exist_ok=True)

    # Remove existing database
    if DB_PATH.exists():
        print(f"Removing existing database...")
        os.remove(DB_PATH)

    print(f"Rebuilding database from {SQL_GZ_PATH}...")

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    with gzip.open(SQL_GZ_PATH, 'rt') as f:
        sql = f.read()

    # Execute the SQL dump
    cursor.executescript(sql)
    conn.commit()

    # Verify
    cursor.execute("SELECT COUNT(*) FROM documents")
    doc_count = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM entities")
    entity_count = cursor.fetchone()[0]

    conn.close()

    size_mb = os.path.getsize(DB_PATH) / 1024 / 1024
    print(f"\nDatabase rebuilt successfully!")
    print(f"  Size: {size_mb:.1f} MB")
    print(f"  Documents: {doc_count:,}")
    print(f"  Entities: {entity_count:,}")


def main():
    parser = argparse.ArgumentParser(description='Rebuild Epstein Files database')
    parser.add_argument('--download', action='store_true',
                       help='Download SQL dump from archive.org first')
    args = parser.parse_args()

    if args.download:
        download_dump()

    rebuild_database()


if __name__ == "__main__":
    main()
