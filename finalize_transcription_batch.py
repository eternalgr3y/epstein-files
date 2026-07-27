#!/usr/bin/env python3
"""Wait for media transcription, then build and verify the final D1 export."""

import argparse
import json
import sqlite3
import sys
import time
from datetime import UTC, datetime
from pathlib import Path


ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT / "src"))

from build_transcript_d1_import import build_import
from config import DATABASE_PATH, PROCESSED_DIR
from transcription_pipeline import get_transcription_stats


def verify_local_indexes(database):
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    try:
        integrity = connection.execute("PRAGMA quick_check").fetchone()[0]
        text_rows = connection.execute(
            "SELECT COUNT(*) FROM document_texts "
            "WHERE trim(coalesce(full_text,'')) <> ''"
        ).fetchone()[0]
        fts_rows = connection.execute("SELECT COUNT(*) FROM document_fts").fetchone()[0]
        missing = connection.execute(
            "SELECT COUNT(*) FROM document_texts t "
            "LEFT JOIN document_fts f ON f.rowid=t.document_id "
            "WHERE trim(coalesce(t.full_text,'')) <> '' AND f.rowid IS NULL"
        ).fetchone()[0]
        orphans = connection.execute(
            "SELECT COUNT(*) FROM document_fts f "
            "LEFT JOIN document_texts t ON t.document_id=f.rowid "
            "WHERE t.id IS NULL"
        ).fetchone()[0]
        if integrity != "ok" or text_rows != fts_rows or missing or orphans:
            raise RuntimeError(
                "Local index verification failed: "
                f"integrity={integrity}, text_rows={text_rows}, "
                f"fts_rows={fts_rows}, missing={missing}, orphans={orphans}"
            )
        return {
            "quick_check": integrity,
            "text_rows": text_rows,
            "fts_rows": fts_rows,
            "fts_missing": missing,
            "fts_orphans": orphans,
        }
    finally:
        connection.close()


def finalize(database=DATABASE_PATH):
    stats = get_transcription_stats()
    if stats["remaining"] or stats["failed"]:
        raise RuntimeError(f"Transcription batch is not complete: {stats}")
    output = PROCESSED_DIR / "house-doj-transcripts.sql"
    export = build_import(database, output)
    indexes = verify_local_indexes(database)
    report = {
        "completed_at": datetime.now(UTC).isoformat(),
        "transcription": stats,
        "export": {
            **export,
            "output": str(output),
            "bytes": output.stat().st_size,
        },
        "local_indexes": indexes,
    }
    report_path = PROCESSED_DIR / "transcription-final.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report_path, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wait", action="store_true")
    parser.add_argument("--poll-seconds", type=int, default=30)
    args = parser.parse_args()
    while True:
        stats = get_transcription_stats()
        print(json.dumps(stats), flush=True)
        if stats["failed"]:
            raise SystemExit("A transcription failed; inspect and retry before finalizing")
        if stats["remaining"] == 0:
            break
        if not args.wait:
            raise SystemExit("Transcription is still running; pass --wait to monitor")
        time.sleep(max(args.poll_seconds, 5))
    report_path, report = finalize()
    print(json.dumps(report, indent=2), flush=True)
    print(f"Report: {report_path}", flush=True)


if __name__ == "__main__":
    main()
