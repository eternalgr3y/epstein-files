#!/usr/bin/env python3
"""
Parallel OCR Processing
Runs multiple workers to speed up document processing.
"""

import sys
import os
import time
import logging
from multiprocessing import Process, Value, Lock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / 'src'))

from models import (
    get_engine, get_session, Document,
    ProcessingLog, ProcessingStatus,
)
from ocr_pipeline import process_document, save_extraction_result

# Enable SQLite WAL mode for better concurrency
import sqlite3

# Use environment variable or relative path
DB_PATH = os.environ.get("DATABASE_PATH", str(Path(__file__).parent / "database" / "epstein_files.db"))

def enable_wal_mode():
    """Enable WAL mode for better concurrent access."""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.close()


def claim_next_document(session):
    """Atomically claim one pending OCR document across worker processes."""
    while True:
        candidate = session.query(Document.id).filter(
            Document.processing_status == ProcessingStatus.PENDING.value,
            Document.needs_ocr == True,
        ).order_by(Document.id).first()
        if candidate is None:
            return None

        claimed = session.query(Document).filter(
            Document.id == candidate.id,
            Document.processing_status == ProcessingStatus.PENDING.value,
            Document.needs_ocr == True,
        ).update(
            {Document.processing_status: ProcessingStatus.PROCESSING.value},
            synchronize_session=False,
        )
        session.commit()
        if claimed:
            return session.get(Document, candidate.id)
        session.expire_all()

def worker(worker_id: int, counter: Value, lock: Lock, total_docs: int):
    """Worker process that claims and processes documents."""
    logging.basicConfig(
        level=logging.INFO,
        format=f'[W{worker_id}] %(asctime)s - %(message)s',
        datefmt='%H:%M:%S'
    )
    logger = logging.getLogger()

    engine = get_engine(DB_PATH)
    session = get_session(engine)

    processed = 0

    while True:
        doc_id = None
        try:
            doc = claim_next_document(session)

            if not doc:
                logger.info(f"No more documents. Processed {processed} total.")
                break
            doc_id = doc.id

            # Process it
            result = process_document(doc)
            save_extraction_result(session, doc, result)

            processed += 1

            # Update shared counter
            with lock:
                counter.value += 1
                current = counter.value

            if processed % 10 == 0:
                pct = (current / total_docs) * 100
                logger.info(f"Done {processed} | Total: {current}/{total_docs} ({pct:.1f}%)")

        except Exception as e:
            logger.error(f"Error: {e}")
            session.rollback()
            if doc_id is not None:
                try:
                    failed_doc = session.get(Document, doc_id)
                    if failed_doc:
                        failed_doc.processing_status = ProcessingStatus.FAILED.value
                        failed_doc.needs_ocr = False
                    session.add(ProcessingLog(
                        document_id=doc_id,
                        action="text_extraction",
                        status="failed",
                        error_details=str(e),
                    ))
                    session.commit()
                except Exception:
                    session.rollback()
                    logger.exception("Could not persist failure for document %s", doc_id)
            time.sleep(1)

    session.close()

def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--workers', '-w', type=int, default=4, help='Number of parallel workers')
    args = parser.parse_args()

    num_workers = args.workers

    # Enable WAL mode
    enable_wal_mode()

    # Get total pending
    engine = get_engine(DB_PATH)
    session = get_session(engine)
    total_pending = session.query(Document).filter(
        Document.processing_status == ProcessingStatus.PENDING.value,
        Document.needs_ocr == True
    ).count()
    already_done = session.query(Document).filter(
        Document.processing_status == ProcessingStatus.COMPLETED.value
    ).count()
    session.close()

    print(f"=== Parallel OCR Processing ===")
    print(f"Already done: {already_done}")
    print(f"Pending: {total_pending}")
    print(f"Workers: {num_workers}")
    print(f"Starting...\n")

    # Shared counter
    counter = Value('i', 0)
    lock = Lock()

    # Start workers
    processes = []
    start_time = time.time()

    for i in range(num_workers):
        p = Process(target=worker, args=(i, counter, lock, total_pending))
        p.start()
        processes.append(p)
        time.sleep(0.5)  # Stagger starts

    # Wait for completion
    for p in processes:
        p.join()

    elapsed = time.time() - start_time
    docs_per_sec = counter.value / elapsed if elapsed > 0 else 0

    print(f"\n=== Complete ===")
    print(f"Processed: {counter.value}")
    print(f"Time: {elapsed/60:.1f} minutes")
    print(f"Rate: {docs_per_sec:.2f} docs/sec")

if __name__ == "__main__":
    main()
