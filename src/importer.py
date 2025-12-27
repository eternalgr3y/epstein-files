"""
Import scraped documents into the database.
Reads metadata JSON files and populates the documents table.
"""

import json
import logging
from pathlib import Path
from datetime import datetime
from typing import Optional

from models import (
    get_engine, get_session, Document, DocumentType,
    ProcessingStatus, ProcessingLog
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

METADATA_DIR = Path("/mnt/e/epstein-files/processed/metadata")
RAW_DIR = Path("/mnt/e/epstein-files/raw")


def classify_document_type(filename: str, content_type: str, source_page: str) -> str:
    """Classify document type based on filename, content type, and source."""
    filename_lower = filename.lower()
    source_lower = source_page.lower() if source_page else ""

    # Check content type first
    if 'image' in content_type:
        return DocumentType.IMAGE.value

    # Check filename patterns
    if 'flight' in filename_lower or 'log' in filename_lower:
        return DocumentType.FLIGHT_LOG.value
    if 'court' in source_lower or 'indictment' in filename_lower:
        return DocumentType.COURT_RECORD.value
    if 'fbi' in filename_lower or 'memorandum' in filename_lower:
        return DocumentType.FBI_NOTES.value
    if 'email' in filename_lower or '.eml' in filename_lower:
        return DocumentType.EMAIL.value
    if '.mp4' in filename_lower or '.mov' in filename_lower or 'video' in filename_lower:
        return DocumentType.VIDEO.value
    if '.pdf' in filename_lower:
        return DocumentType.PDF.value

    return DocumentType.OTHER.value


def import_metadata_file(session, meta_path: Path) -> Optional[Document]:
    """Import a single metadata JSON file into the database."""
    try:
        with open(meta_path, 'r') as f:
            meta = json.load(f)

        # Check if already imported
        existing = session.query(Document).filter_by(source_url=meta['url']).first()
        if existing:
            return None

        # Classify document type
        doc_type = classify_document_type(
            meta.get('filename', ''),
            meta.get('content_type', ''),
            meta.get('source_page', '')
        )

        # Parse download timestamp
        download_time = None
        if meta.get('download_timestamp'):
            try:
                download_time = datetime.fromisoformat(meta['download_timestamp'])
            except:
                pass

        # Create document record
        doc = Document(
            source_url=meta['url'],
            source_page=meta.get('source_page'),
            data_set=meta.get('data_set'),
            category=meta.get('category'),
            filename=meta['filename'],
            local_path=meta['local_path'],
            file_hash=meta.get('file_hash'),
            file_size=meta.get('file_size'),
            content_type=meta.get('content_type'),
            document_type=doc_type,
            title=meta.get('title'),
            download_timestamp=download_time,
            last_modified=meta.get('last_modified'),
            processing_status=ProcessingStatus.PENDING.value,
            needs_ocr=doc_type in [DocumentType.PDF.value, DocumentType.IMAGE.value]
        )

        session.add(doc)
        return doc

    except Exception as e:
        logger.error(f"Error importing {meta_path}: {e}")
        return None


def import_all_metadata():
    """Import all metadata files into the database."""
    engine = get_engine()
    session = get_session(engine)

    meta_files = list(METADATA_DIR.glob("*.json"))
    logger.info(f"Found {len(meta_files)} metadata files")

    imported = 0
    skipped = 0
    errors = 0

    for meta_path in meta_files:
        result = import_metadata_file(session, meta_path)
        if result:
            imported += 1
            if imported % 100 == 0:
                session.commit()
                logger.info(f"Imported {imported} documents...")
        elif result is None:
            skipped += 1
        else:
            errors += 1

    session.commit()
    session.close()

    logger.info(f"Import complete: {imported} imported, {skipped} skipped, {errors} errors")
    return imported, skipped, errors


def get_documents_needing_ocr(session, limit: int = 100):
    """Get documents that need OCR processing."""
    return session.query(Document).filter(
        Document.needs_ocr == True,
        Document.processing_status == ProcessingStatus.PENDING.value
    ).limit(limit).all()


def get_document_stats(session) -> dict:
    """Get statistics about documents in the database."""
    total = session.query(Document).count()
    by_type = {}
    for doc_type in DocumentType:
        count = session.query(Document).filter_by(document_type=doc_type.value).count()
        if count > 0:
            by_type[doc_type.value] = count

    by_status = {}
    for status in ProcessingStatus:
        count = session.query(Document).filter_by(processing_status=status.value).count()
        if count > 0:
            by_status[status.value] = count

    by_data_set = {}
    data_sets = session.query(Document.data_set).distinct().all()
    for (ds,) in data_sets:
        if ds:
            count = session.query(Document).filter_by(data_set=ds).count()
            by_data_set[ds] = count

    return {
        'total': total,
        'by_type': by_type,
        'by_status': by_status,
        'by_data_set': by_data_set
    }


if __name__ == "__main__":
    import_all_metadata()

    # Print stats
    engine = get_engine()
    session = get_session(engine)
    stats = get_document_stats(session)
    print("\nDocument Statistics:")
    print(f"  Total: {stats['total']}")
    print(f"  By Type: {stats['by_type']}")
    print(f"  By Status: {stats['by_status']}")
    print(f"  By Data Set: {stats['by_data_set']}")
    session.close()
