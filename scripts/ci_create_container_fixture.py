#!/usr/bin/env python3
"""Create the minimal SQLite fixture exercised by the container health smoke."""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path


SCHEMA = """
CREATE TABLE documents (
    id INTEGER PRIMARY KEY,
    document_type TEXT,
    processing_status TEXT,
    data_set TEXT
);

CREATE TABLE entities (
    id INTEGER PRIMARY KEY
);

CREATE TABLE document_texts (
    id INTEGER PRIMARY KEY,
    word_count INTEGER
);
"""


def create_fixture(output: Path) -> None:
    if output.exists():
        raise FileExistsError(f"refusing to overwrite existing fixture: {output}")

    output.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(output) as connection:
        connection.executescript(SCHEMA)
        connection.execute(
            """
            INSERT INTO documents
                (id, document_type, processing_status, data_set)
            VALUES
                (1, 'pdf', 'completed', 'ci-fixture')
            """
        )
        connection.execute("INSERT INTO entities (id) VALUES (1)")
        connection.execute(
            "INSERT INTO document_texts (id, word_count) VALUES (1, 3)"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    create_fixture(args.output.resolve())
    print(f"created container smoke fixture: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
