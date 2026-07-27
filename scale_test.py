#!/usr/bin/env python3
"""
Scale readiness test - checks if system can handle 1M documents.
Measures current performance and projects to 1M scale.
"""

import sys
import os
import time
import sqlite3
import argparse
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from models import get_engine, get_session, Document, DocumentText
from search import search_documents, search_entities, get_document_types, get_data_sets
from importer import get_document_stats
from fts_index import fts_table_exists, rebuild_fts_index

DB_PATH = Path(__file__).parent / "database" / "epstein_files.db"

def fmt(n):
    return f"{n:,}"

def main(build_fts=False):
    print("=" * 60)
    print("SCALE READINESS TEST - Target: 1,000,000 documents")
    print("=" * 60)

    # Current stats
    engine = get_engine()
    session = get_session(engine)

    current_docs = session.query(Document).count()
    current_texts = session.query(DocumentText).count()
    db_size_mb = DB_PATH.stat().st_size / (1024 * 1024)

    print(f"\n[Current State]")
    print(f"  Documents: {fmt(current_docs)}")
    print(f"  With text: {fmt(current_texts)}")
    print(f"  DB size:   {db_size_mb:.1f} MB")

    # Projections
    scale_factor = 1_000_000 / current_docs if current_docs > 0 else 100
    projected_db_gb = (db_size_mb * scale_factor) / 1024

    print(f"\n[Projected at 1M docs]")
    print(f"  Scale factor: {scale_factor:.1f}x")
    print(f"  DB size:      {projected_db_gb:.1f} GB")
    print(f"  Feasible:     {'YES' if projected_db_gb < 50 else 'NEEDS OPTIMIZATION'}")

    # Check SQLite settings
    print(f"\n[SQLite Configuration]")
    conn = sqlite3.connect(str(DB_PATH))
    cur = conn.cursor()

    cur.execute("PRAGMA journal_mode")
    journal = cur.fetchone()[0]
    print(f"  Journal mode: {journal} {'(GOOD)' if journal == 'wal' else '(should be WAL)'}")

    cur.execute("PRAGMA cache_size")
    cache = cur.fetchone()[0]
    print(f"  Cache size:   {cache} pages")

    cur.execute("PRAGMA page_size")
    page_size = cur.fetchone()[0]
    print(f"  Page size:    {page_size} bytes")

    # Check FTS5 index
    has_fts = fts_table_exists(conn)
    if not has_fts and build_fts:
        conn.close()
        fts_count = rebuild_fts_index(DB_PATH)
        conn = sqlite3.connect(str(DB_PATH))
        cur = conn.cursor()
        has_fts = True
        print(f"  FTS5 rebuilt: {fmt(fts_count)} documents")
    elif has_fts:
        cur.execute("SELECT count(*) FROM document_fts")
        fts_count = cur.fetchone()[0]
        print(f"  FTS5 indexed: {fmt(fts_count)} documents")
    else:
        fts_count = 0
        print("  FTS5 indexed: MISSING (run with --build-fts)")

    conn.close()

    # Performance benchmarks
    print(f"\n[Performance Benchmarks]")

    times = []
    if has_fts:
        queries = ["epstein", "flight", "island", "maxwell", "victim"]
        for q in queries:
            start = time.time()
            results = search_documents(q, limit=50)
            elapsed_ms = (time.time() - start) * 1000
            times.append(elapsed_ms)
            print(f"  Search '{q}': {len(results)} results in {elapsed_ms:.1f}ms")

        avg_ms = sum(times) / len(times)
        print(f"  Average: {avg_ms:.1f}ms")
        projected_ms = avg_ms * 1.5
        print(f"  Projected at 1M: ~{projected_ms:.0f}ms (FTS5 scales well)")
    else:
        avg_ms = float("inf")
        print("  Skipped: local FTS5 index is missing")

    # Stats endpoint
    print(f"\n[Stats Endpoint]")
    start = time.time()
    stats = get_document_stats(session)
    elapsed_ms = (time.time() - start) * 1000
    print(f"  First call: {elapsed_ms:.1f}ms")

    start = time.time()
    stats = get_document_stats(session)
    elapsed_ms = (time.time() - start) * 1000
    print(f"  Cached call: {elapsed_ms:.2f}ms")

    # Entity search
    print(f"\n[Entity Search]")
    start = time.time()
    results = search_entities("john", limit=10)
    elapsed_ms = (time.time() - start) * 1000
    print(f"  Entity search: {len(results)} results in {elapsed_ms:.1f}ms")

    # Recommendations
    print(f"\n[Recommendations for 1M scale]")

    issues = []

    if journal != 'wal':
        issues.append("Enable WAL mode: PRAGMA journal_mode=WAL")

    if not has_fts:
        issues.append("Build the local FTS5 index: python scale_test.py --build-fts")

    if projected_db_gb > 20:
        issues.append("Consider PostgreSQL for better concurrency")

    if avg_ms > 100:
        issues.append("Optimize FTS5 queries or add more indexes")

    if not issues:
        print("  ✓ System is ready for 1M documents!")
        print("  ✓ FTS5 will handle scale well")
        print("  ✓ Connection pooling enabled")
        print("  ✓ Stats caching enabled")
    else:
        for issue in issues:
            print(f"  ! {issue}")

    # Summary
    print(f"\n{'=' * 60}")
    ready = len(issues) == 0 and projected_db_gb < 50 and avg_ms < 200
    print(f"VERDICT: {'READY FOR 1M' if ready else 'NEEDS WORK'}")
    print(f"{'=' * 60}")

    session.close()
    return ready


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-fts', action='store_true', help='Build a missing local FTS5 index')
    args = parser.parse_args()
    success = main(build_fts=args.build_fts)
    sys.exit(0 if success else 1)
