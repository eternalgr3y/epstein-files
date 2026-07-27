#!/usr/bin/env python3
"""Rebuild the local SQLite full-text index from document_texts."""

import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent / "src"))

from config import DATABASE_PATH
from fts_index import rebuild_fts_index


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=DATABASE_PATH)
    args = parser.parse_args()
    count = rebuild_fts_index(args.database)
    print(f"Indexed {count:,} documents in {args.database}")


if __name__ == "__main__":
    main()
