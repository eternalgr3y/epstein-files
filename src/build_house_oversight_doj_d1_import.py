#!/usr/bin/env python3
"""Build a bounded-statement D1 import for the isolated House DOJ batch.

The batch database intentionally contains only the newly processed dataset, so
entity IDs cannot be copied directly into production.  This builder maps local
entities to a production entity snapshot by normalized name and type, collapses
duplicates inside the new batch, and allocates all other IDs above production's
current maxima.
"""

from __future__ import annotations

import argparse
import re
import sqlite3
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Iterable, Sequence


DEFAULT_MAXIMA = {
    "documents": 20912,
    "document_texts": 17419,
    "entities": 186665,
    "mentions": 6661032,
}
MAX_STATEMENT_BYTES = 80_000
TEXT_CHUNK_BYTES = 36_000
MAX_TEXT_ROW_BYTES = 1_700_000
TRUNCATION_NOTE = (
    "\n\n[Production search text truncated at the D1 row-size limit; "
    "the complete OCR remains in the source archive.]"
)


def normalize_name(value: str | None) -> str:
    if not value:
        return ""
    value = unicodedata.normalize("NFKC", value)
    return re.sub(r"\s+", " ", value).strip().casefold()


def clean_name(value: str | None) -> str | None:
    if value is None:
        return None
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value)).strip()


def normalize_type(value: str | None) -> str:
    value = (value or "").strip().casefold()
    if value in {"person", "per"}:
        return "person"
    if value in {"organization", "org"}:
        return "organization"
    if value in {"location", "loc", "gpe"}:
        return "location"
    return value


def sql_literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    value = str(value).replace("\x00", "")
    return "'" + value.replace("'", "''") + "'"


def utf8_chunks(value: str, limit: int = TEXT_CHUNK_BYTES) -> Iterable[str]:
    chunk: list[str] = []
    size = 0
    for char in value:
        char_size = len(char.encode("utf-8")) + (1 if char == "'" else 0)
        if chunk and size + char_size > limit:
            yield "".join(chunk)
            chunk = []
            size = 0
        chunk.append(char)
        size += char_size
    if chunk:
        yield "".join(chunk)


def truncate_utf8(value: str, max_bytes: int) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value
    note = TRUNCATION_NOTE.encode("utf-8")
    prefix = encoded[: max_bytes - len(note)]
    while prefix:
        try:
            return prefix.decode("utf-8") + TRUNCATION_NOTE
        except UnicodeDecodeError as error:
            prefix = prefix[: error.start]
    return TRUNCATION_NOTE


class SqlWriter:
    def __init__(self, path: Path):
        self.handle = path.open("w", encoding="utf-8", newline="\n")
        self.statements = 0
        self.max_bytes = 0

    def write(self, statement: str):
        if not statement.endswith(";"):
            statement += ";"
        byte_count = len(statement.encode("utf-8"))
        if byte_count > MAX_STATEMENT_BYTES:
            raise ValueError(f"SQL statement is {byte_count:,} bytes")
        self.handle.write(statement + "\n")
        self.statements += 1
        self.max_bytes = max(self.max_bytes, byte_count)

    def insert_many(self, table: str, columns: Sequence[str], rows: Iterable[Sequence]):
        prefix = f"INSERT INTO {table} ({','.join(columns)}) VALUES "
        values: list[str] = []
        size = len(prefix.encode("utf-8")) + 1
        for row in rows:
            rendered = "(" + ",".join(sql_literal(value) for value in row) + ")"
            rendered_size = len(rendered.encode("utf-8")) + (1 if values else 0)
            if values and size + rendered_size > MAX_STATEMENT_BYTES - 1_000:
                self.write(prefix + ",".join(values))
                values = []
                size = len(prefix.encode("utf-8")) + 1
            values.append(rendered)
            size += rendered_size
        if values:
            self.write(prefix + ",".join(values))

    def close(self):
        self.handle.close()


def choose_entity(rows: list[sqlite3.Row]) -> sqlite3.Row:
    return max(
        rows,
        key=lambda row: (
            row["mention_count"] or 0,
            len(clean_name(row["canonical_name"]) or ""),
            -(row["id"] or 0),
        ),
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch-db", type=Path, default=Path("database/epstein_files.db"))
    parser.add_argument("--production-entities-db", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    for table, default in DEFAULT_MAXIMA.items():
        parser.add_argument(f"--max-{table.replace('_', '-')}", type=int, default=default)
    args = parser.parse_args()

    maxima = {
        "documents": args.max_documents,
        "document_texts": args.max_document_texts,
        "entities": args.max_entities,
        "mentions": args.max_mentions,
    }

    batch = sqlite3.connect(args.batch_db)
    batch.row_factory = sqlite3.Row
    prod = sqlite3.connect(args.production_entities_db)
    prod.row_factory = sqlite3.Row

    prod_by_key: dict[tuple[str, str], sqlite3.Row] = {}
    prod_by_name: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for row in prod.execute("SELECT * FROM entities ORDER BY id"):
        name_key = normalize_name(row["canonical_name"])
        type_key = normalize_type(row["entity_type"])
        if not name_key:
            continue
        prod_by_name[name_key].append(row)
        key = (name_key, type_key)
        current = prod_by_key.get(key)
        if current is None or (row["mention_count"] or 0) > (current["mention_count"] or 0):
            prod_by_key[key] = row

    local_groups: dict[tuple[str, str], list[sqlite3.Row]] = defaultdict(list)
    for row in batch.execute("SELECT * FROM entities ORDER BY id"):
        name_key = normalize_name(row["canonical_name"])
        if not name_key:
            raise ValueError(f"Local entity {row['id']} has an empty canonical name")
        local_groups[(name_key, normalize_type(row["entity_type"]))].append(row)

    local_to_target: dict[int, int] = {}
    new_entities: list[tuple[int, sqlite3.Row]] = []
    next_entity_id = maxima["entities"] + 1
    mapped_groups = 0
    for key, rows in sorted(local_groups.items(), key=lambda item: min(row["id"] for row in item[1])):
        target = prod_by_key.get(key)
        if target is None and not key[1]:
            candidates = prod_by_name.get(key[0], [])
            if len(candidates) == 1:
                target = candidates[0]
        if target is not None:
            target_id = target["id"]
            mapped_groups += 1
        else:
            target_id = next_entity_id
            next_entity_id += 1
            new_entities.append((target_id, choose_entity(rows)))
        for row in rows:
            local_to_target[row["id"]] = target_id

    document_map = {
        row["id"]: maxima["documents"] + row["id"]
        for row in batch.execute("SELECT id FROM documents ORDER BY id")
    }
    mention_counts: dict[int, int] = defaultdict(int)
    for row in batch.execute("SELECT entity_id, COUNT(*) AS count FROM mentions GROUP BY entity_id"):
        mention_counts[local_to_target[row["entity_id"]]] += row["count"]

    writer = SqlWriter(args.output)
    writer.write("PRAGMA defer_foreign_keys=TRUE")

    document_columns = (
        "id", "source_url", "source_page", "data_set", "category", "filename", "local_path",
        "file_hash", "file_size", "content_type", "document_type", "title", "description",
        "document_date", "download_timestamp", "processing_status", "ocr_confidence",
        "page_count", "has_text", "created_at", "updated_at", "needs_ocr",
    )
    writer.insert_many(
        "documents",
        document_columns,
        (
            (
                document_map[row["id"]], row["source_url"], row["source_page"], row["data_set"],
                row["category"], row["filename"], row["local_path"], row["file_hash"],
                row["file_size"], row["content_type"], row["document_type"], row["title"],
                row["description"], row["document_date"], row["download_timestamp"],
                row["processing_status"], row["ocr_confidence"], row["page_count"],
                row["has_text"], row["created_at"], row["updated_at"], row["needs_ocr"],
            )
            for row in batch.execute("SELECT * FROM documents ORDER BY id")
        ),
    )

    entity_columns = (
        "id", "canonical_name", "entity_type", "first_name", "last_name", "aliases",
        "description", "is_public_figure", "disambiguation_notes", "confidence", "needs_review",
        "mention_count", "created_at", "updated_at", "wikipedia_url", "wikidata_id",
    )
    writer.insert_many(
        "entities",
        entity_columns,
        (
            (
                target_id, clean_name(row["canonical_name"]), row["entity_type"],
                clean_name(row["first_name"]), clean_name(row["last_name"]), row["aliases"],
                row["description"], row["is_public_figure"], row["disambiguation_notes"],
                row["confidence"], row["needs_review"], 0, row["created_at"], row["updated_at"],
                row["wikipedia_url"], None,
            )
            for target_id, row in new_entities
        ),
    )

    truncated_documents: list[int] = []
    page_details_dropped: list[int] = []
    text_rows = list(batch.execute("SELECT * FROM document_texts ORDER BY id"))
    writer.insert_many(
        "document_texts",
        ("id", "document_id", "full_text", "pages_text", "word_count", "created_at"),
        (
            (
                maxima["document_texts"] + row["id"], document_map[row["document_id"]], "",
                None, row["word_count"], row["created_at"],
            )
            for row in text_rows
        ),
    )
    for row in text_rows:
        text_id = maxima["document_texts"] + row["id"]
        full_text = row["full_text"] or ""
        pages_text = row["pages_text"]
        original_full_bytes = len(full_text.encode("utf-8"))
        full_text = truncate_utf8(full_text, MAX_TEXT_ROW_BYTES)
        if len(full_text.encode("utf-8")) < original_full_bytes:
            truncated_documents.append(row["document_id"])
        if pages_text is not None:
            combined = len(full_text.encode("utf-8")) + len(pages_text.encode("utf-8"))
            if combined > MAX_TEXT_ROW_BYTES:
                pages_text = None
                page_details_dropped.append(row["document_id"])
        for chunk in utf8_chunks(full_text):
            writer.write(
                f"UPDATE document_texts SET full_text=full_text||{sql_literal(chunk)} WHERE id={text_id}"
            )
        if pages_text is not None:
            writer.write(f"UPDATE document_texts SET pages_text='' WHERE id={text_id}")
            for chunk in utf8_chunks(pages_text):
                writer.write(
                    f"UPDATE document_texts SET pages_text=pages_text||{sql_literal(chunk)} WHERE id={text_id}"
                )

    mention_columns = (
        "id", "document_id", "entity_id", "name_as_appears", "role", "role_confidence",
        "page_number", "context_snippet", "needs_review", "created_at", "role_evidence",
        "position_start", "position_end",
    )
    writer.insert_many(
        "mentions",
        mention_columns,
        (
            (
                maxima["mentions"] + row["id"], document_map[row["document_id"]],
                local_to_target[row["entity_id"]], row["name_as_appears"], row["role"],
                row["role_confidence"], row["page_number"], row["context_snippet"],
                row["needs_review"], row["created_at"], row["role_evidence"],
                row["position_start"], row["position_end"],
            )
            for row in batch.execute("SELECT * FROM mentions ORDER BY id")
        ),
    )

    count_items = sorted(mention_counts.items())
    for offset in range(0, len(count_items), 400):
        group = count_items[offset : offset + 400]
        cases = " ".join(f"WHEN {entity_id} THEN {count}" for entity_id, count in group)
        ids = ",".join(str(entity_id) for entity_id, _ in group)
        writer.write(
            "UPDATE entities SET mention_count=COALESCE(mention_count,0)+CASE id "
            f"{cases} ELSE 0 END WHERE id IN ({ids})"
        )

    for row in text_rows:
        document_id = document_map[row["document_id"]]
        writer.write(
            "INSERT INTO document_fts(document_id,full_text) "
            f"SELECT document_id,full_text FROM document_texts WHERE document_id={document_id}"
        )

    writer.close()
    batch.close()
    prod.close()

    print(f"Documents: {len(document_map):,}")
    print(f"Local entity rows: {len(local_to_target):,}")
    print(f"Normalized entity groups: {len(local_groups):,}")
    print(f"Groups mapped to production: {mapped_groups:,}")
    print(f"New production entities: {len(new_entities):,}")
    print(f"Text rows: {len(text_rows):,}")
    print(f"Full text truncated: {len(truncated_documents):,} {truncated_documents}")
    print(f"Page JSON dropped for row limit: {len(page_details_dropped):,} {page_details_dropped}")
    print(f"SQL statements: {writer.statements:,}")
    print(f"Largest statement: {writer.max_bytes:,} bytes")
    print(f"Output: {args.output} ({args.output.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
