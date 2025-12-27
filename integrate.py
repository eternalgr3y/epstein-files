#!/usr/bin/env python3
"""
Integration Pipeline

Connects all components:
1. Extract ZIPs
2. Import to database
3. Run OCR with redaction checks
4. Build search index
5. Run entity extraction (future)
"""

import os
import sys
import json
import zipfile
import hashlib
import logging
import argparse
from pathlib import Path
from datetime import datetime
from typing import Optional, List

# Add src to path
sys.path.insert(0, str(Path(__file__).parent / 'src'))

from models import (
    get_engine, get_session, create_tables,
    Document, DocumentText, ProcessingStatus
)
from ocr_pipeline import process_document, save_extraction_result

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Paths
RAW_DIR = Path("/mnt/e/epstein-files/raw")
EXTRACTED_DIR = Path("/mnt/e/epstein-files/extracted")
DB_PATH = Path("/mnt/e/epstein-files/database/epstein_files.db")


def extract_zips(raw_dir: Path, output_dir: Path, skip_duplicates: bool = True) -> int:
    """Extract all ZIP files, skipping duplicates by hash."""
    output_dir.mkdir(parents=True, exist_ok=True)

    # Find all ZIPs
    zips = list(raw_dir.glob("**/*.zip"))
    logger.info(f"Found {len(zips)} ZIP files")

    # Track by hash to skip duplicates
    seen_hashes = set()
    extracted_count = 0

    for zip_path in sorted(zips):
        # Quick hash check (first 1MB)
        with open(zip_path, 'rb') as f:
            quick_hash = hashlib.md5(f.read(1024*1024)).hexdigest()

        if skip_duplicates and quick_hash in seen_hashes:
            logger.info(f"Skipping duplicate: {zip_path.name}")
            continue
        seen_hashes.add(quick_hash)

        # Determine output subdirectory
        # DataSet_1.zip -> extracted/data-set-1/
        name = zip_path.stem.lower().replace('_', '-').replace('dataset', 'data-set')
        # Remove trailing numbers from duplicates like DataSet_1_1
        if name.endswith('-1') and '-set-' in name:
            name = name[:-2]

        extract_to = output_dir / name
        extract_to.mkdir(parents=True, exist_ok=True)

        logger.info(f"Extracting {zip_path.name} ({zip_path.stat().st_size / 1e6:.1f}MB) -> {extract_to}")

        try:
            with zipfile.ZipFile(zip_path, 'r') as zf:
                # Extract all
                zf.extractall(extract_to)
                extracted_count += len(zf.namelist())
        except zipfile.BadZipFile:
            logger.error(f"Bad ZIP file: {zip_path}")
        except Exception as e:
            logger.error(f"Error extracting {zip_path}: {e}")

    logger.info(f"Extracted {extracted_count} files total")
    return extracted_count


def discover_documents(extracted_dir: Path) -> List[dict]:
    """Find all documents in extracted directory."""
    documents = []

    # Supported extensions
    doc_extensions = {'.pdf', '.jpg', '.jpeg', '.png', '.tiff', '.gif', '.txt'}

    for path in extracted_dir.rglob("*"):
        if path.is_file() and path.suffix.lower() in doc_extensions:
            # Determine category from path
            rel_path = path.relative_to(extracted_dir)
            parts = rel_path.parts

            category = parts[0] if parts else "unknown"
            data_set = None
            if 'data-set' in category:
                data_set = category

            # Content type
            ext = path.suffix.lower()
            content_types = {
                '.pdf': 'application/pdf',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.png': 'image/png',
                '.tiff': 'image/tiff',
                '.gif': 'image/gif',
                '.txt': 'text/plain',
            }

            documents.append({
                'path': str(path),
                'filename': path.name,
                'category': category,
                'data_set': data_set,
                'content_type': content_types.get(ext, 'application/octet-stream'),
                'size': path.stat().st_size,
            })

    logger.info(f"Discovered {len(documents)} documents")
    return documents


def import_to_database(documents: List[dict], session) -> int:
    """Import discovered documents into database."""
    imported = 0

    for doc_info in documents:
        # Check if already exists
        existing = session.query(Document).filter_by(
            local_path=doc_info['path']
        ).first()

        if existing:
            continue

        # Compute hash
        with open(doc_info['path'], 'rb') as f:
            file_hash = hashlib.sha256(f.read()).hexdigest()

        # Check for duplicate by hash
        hash_exists = session.query(Document).filter_by(
            file_hash=file_hash
        ).first()

        if hash_exists:
            logger.debug(f"Skipping duplicate (by hash): {doc_info['filename']}")
            continue

        doc = Document(
            filename=doc_info['filename'],
            local_path=doc_info['path'],
            file_hash=file_hash,
            file_size=doc_info['size'],
            content_type=doc_info['content_type'],
            source_url="https://www.justice.gov/epstein",
            source_page="DOJ Epstein Files",
            data_set=doc_info.get('data_set'),
            category=doc_info.get('category'),
            download_timestamp=datetime.utcnow(),
            processing_status=ProcessingStatus.PENDING.value,
            needs_ocr=True,
        )
        session.add(doc)
        imported += 1

        if imported % 100 == 0:
            session.commit()
            logger.info(f"Imported {imported} documents...")

    session.commit()
    logger.info(f"Imported {imported} new documents")
    return imported


def run_ocr_batch(session, batch_size: int = 10) -> dict:
    """Run OCR on pending documents."""
    pending = session.query(Document).filter(
        Document.processing_status == ProcessingStatus.PENDING.value,
        Document.needs_ocr == True
    ).limit(batch_size).all()

    if not pending:
        logger.info("No pending documents for OCR")
        return {'processed': 0, 'success': 0, 'failed': 0, 'blocked': 0}

    stats = {'processed': 0, 'success': 0, 'failed': 0, 'blocked': 0}

    for doc in pending:
        logger.info(f"OCR: {doc.filename}")

        result = process_document(doc)
        save_extraction_result(session, doc, result)

        stats['processed'] += 1
        if result.success:
            stats['success'] += 1
            logger.info(f"  OK: {result.word_count} words ({result.method})")
        elif 'REDACTION_ISSUE' in (result.error or ''):
            stats['blocked'] += 1
            logger.warning(f"  BLOCKED: Redaction issue detected")
        else:
            stats['failed'] += 1
            logger.warning(f"  FAILED: {result.error}")

    return stats


def build_search_index(session) -> int:
    """
    Search index is built automatically via SQLite FTS5.
    This function just reports the current state.
    """
    # Count documents with text (these are searchable)
    docs_with_text = session.query(DocumentText).filter(
        DocumentText.word_count > 0
    ).count()

    logger.info(f"{docs_with_text} documents are searchable via FTS5")
    return docs_with_text


def get_stats(session) -> dict:
    """Get overall pipeline statistics."""
    from sqlalchemy import func

    total = session.query(Document).count()
    pending = session.query(Document).filter_by(
        processing_status=ProcessingStatus.PENDING.value
    ).count()
    completed = session.query(Document).filter_by(
        processing_status=ProcessingStatus.COMPLETED.value
    ).count()
    failed = session.query(Document).filter_by(
        processing_status=ProcessingStatus.FAILED.value
    ).count()

    with_text = session.query(DocumentText).filter(
        DocumentText.word_count > 0
    ).count()

    total_words = session.query(
        func.sum(DocumentText.word_count)
    ).scalar() or 0

    return {
        'total_documents': total,
        'pending_ocr': pending,
        'ocr_completed': completed,
        'ocr_failed': failed,
        'documents_with_text': with_text,
        'total_words': total_words,
    }


def main():
    parser = argparse.ArgumentParser(description='Integration Pipeline')
    parser.add_argument('--extract', action='store_true', help='Extract ZIP files')
    parser.add_argument('--import', dest='do_import', action='store_true', help='Import to database')
    parser.add_argument('--ocr', type=int, default=0, help='Run OCR on N documents')
    parser.add_argument('--index', action='store_true', help='Build search index')
    parser.add_argument('--stats', action='store_true', help='Show statistics')
    parser.add_argument('--all', action='store_true', help='Run full pipeline')
    args = parser.parse_args()

    # Initialize database
    engine = get_engine(str(DB_PATH))
    create_tables(engine)
    session = get_session(engine)

    try:
        if args.extract or args.all:
            logger.info("=== EXTRACTING ZIPs ===")
            extract_zips(RAW_DIR, EXTRACTED_DIR)

        if args.do_import or args.all:
            logger.info("=== IMPORTING TO DATABASE ===")
            documents = discover_documents(EXTRACTED_DIR)
            import_to_database(documents, session)

        if args.ocr > 0 or args.all:
            batch = args.ocr if args.ocr > 0 else 10
            logger.info(f"=== RUNNING OCR (batch={batch}) ===")
            stats = run_ocr_batch(session, batch_size=batch)
            print(f"OCR: {stats}")

        if args.index or args.all:
            logger.info("=== BUILDING SEARCH INDEX ===")
            build_search_index(session)

        if args.stats or args.all:
            logger.info("=== STATISTICS ===")
            stats = get_stats(session)
            for k, v in stats.items():
                print(f"  {k}: {v:,}")

    finally:
        session.close()


if __name__ == "__main__":
    main()
