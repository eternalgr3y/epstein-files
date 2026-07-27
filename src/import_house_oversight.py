"""
Import House Oversight Estate files into the database.
Parses DAT/OPT load files and imports documents with their text.
"""

import os
import csv
import logging
from pathlib import Path
from datetime import datetime
from typing import Optional, Dict, List, Tuple

from models import (
    get_engine, get_session, Document, DocumentText, DocumentType,
    ProcessingStatus, init_database, utc_now
)
from config import RAW_DIR

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Paths
HOUSE_OVERSIGHT_DIR = RAW_DIR / "house-oversight-estate"
DATA_DIR = HOUSE_OVERSIGHT_DIR / "DATA"
TEXT_DIR = HOUSE_OVERSIGHT_DIR / "TEXT"
IMAGES_DIR = HOUSE_OVERSIGHT_DIR / "IMAGES"
NATIVES_DIR = HOUSE_OVERSIGHT_DIR / "NATIVES"

DAT_FILE = DATA_DIR / "HOUSE_OVERSIGHT_009.dat"
OPT_FILE = DATA_DIR / "HOUSE_OVERSIGHT_009.opt"


def parse_dat_file(dat_path: Path) -> List[Dict]:
    """
    Parse the DAT file (þ-delimited) to extract document metadata.
    The actual delimiter is þ + 0x14 + þ between fields.
    Returns list of document dictionaries.
    """
    documents = []

    with open(dat_path, 'r', encoding='utf-8-sig') as f:
        # Read all content
        content = f.read()

    # Split by newlines
    lines = content.strip().split('\n')

    # The delimiter is þ\x14þ (thorn + DC4 + thorn)
    DELIM = 'þ\x14þ'

    # First line is header - strip leading/trailing þ
    header_line = lines[0].strip('þ\x14\r')
    headers = [h.strip() for h in header_line.split(DELIM)]

    logger.info(f"DAT headers ({len(headers)}): {headers[:5]}...")

    # Parse each data line
    for line_num, line in enumerate(lines[1:], start=2):
        if not line.strip():
            continue

        # Strip leading/trailing þ and split by delimiter
        line_clean = line.strip('þ\x14\r')
        fields = [f.strip() for f in line_clean.split(DELIM)]

        # Create dict mapping headers to values
        doc = {}
        for i, header in enumerate(headers):
            if i < len(fields):
                doc[header] = fields[i] if fields[i] else None
            else:
                doc[header] = None

        # Extract key fields
        doc['_bates_begin'] = doc.get('Bates Begin')
        doc['_bates_end'] = doc.get('Bates End')
        doc['_pages'] = int(doc.get('Pages')) if doc.get('Pages') and doc.get('Pages').isdigit() else None
        doc['_custodian'] = doc.get('Custodian/Source')
        doc['_date_created'] = doc.get('Date Created')
        doc['_filename'] = doc.get('Original Filename')
        doc['_extension'] = doc.get('Document Extension')
        doc['_text_link'] = doc.get('Text Link')
        doc['_native_link'] = doc.get('Native Link')
        doc['_md5_hash'] = doc.get('MD5 Hash')
        doc['_file_size'] = int(doc.get('File Size')) if doc.get('File Size') and doc.get('File Size').isdigit() else None
        doc['_title'] = doc.get('Document Title') or doc.get('Email Subject/Title')

        documents.append(doc)

    logger.info(f"Parsed {len(documents)} documents from DAT file")
    return documents


def parse_opt_file(opt_path: Path) -> Dict[str, List[str]]:
    """
    Parse the OPT file to map document Bates numbers to image paths.
    Returns dict: bates_begin -> list of image paths
    """
    doc_images = {}
    current_doc = None
    current_images = []

    with open(opt_path, 'r') as f:
        for line in f:
            parts = line.strip().split(',')
            if len(parts) < 4:
                continue

            bates = parts[0]
            image_path = parts[2]
            is_doc_start = parts[3] == 'Y'

            if is_doc_start:
                # Save previous document
                if current_doc and current_images:
                    doc_images[current_doc] = current_images

                # Start new document
                current_doc = bates
                current_images = [image_path]
            else:
                # Continue current document
                current_images.append(image_path)

        # Save last document
        if current_doc and current_images:
            doc_images[current_doc] = current_images

    logger.info(f"Parsed {len(doc_images)} document image mappings from OPT file")
    return doc_images


def get_text_content(text_link: str) -> Optional[str]:
    """Read text content from a TEXT file."""
    if not text_link:
        return None

    # Convert Windows path to local path
    # e.g., \HOUSE_OVERSIGHT_009\TEXT\001\HOUSE_OVERSIGHT_010477.txt
    text_link = text_link.replace('\\HOUSE_OVERSIGHT_009\\', '').replace('\\', '/')
    text_path = HOUSE_OVERSIGHT_DIR / text_link

    if text_path.exists():
        try:
            with open(text_path, 'r', encoding='utf-8', errors='replace') as f:
                return f.read()
        except Exception as e:
            logger.error(f"Error reading {text_path}: {e}")

    return None


def get_document_type(extension: str, filename: str) -> str:
    """Classify document type based on extension and filename."""
    if not extension:
        extension = ''
    ext = extension.lower()
    fname = (filename or '').lower()

    if ext in ['pdf']:
        return DocumentType.PDF.value
    if ext in ['jpg', 'jpeg', 'png', 'gif', 'tiff', 'bmp']:
        return DocumentType.IMAGE.value
    if ext in ['mp4', 'mov', 'avi', 'wmv']:
        return DocumentType.VIDEO.value
    if ext in ['eml', 'msg']:
        return DocumentType.EMAIL.value
    if 'email' in fname:
        return DocumentType.EMAIL.value

    return DocumentType.OTHER.value


def import_documents(session, documents: List[Dict], doc_images: Dict[str, List[str]]):
    """Import documents into the database."""
    imported = 0
    skipped = 0

    for doc in documents:
        bates_begin = doc['_bates_begin']
        if not bates_begin:
            continue

        # Check if already exists
        existing = session.query(Document).filter_by(
            filename=bates_begin,
            data_set='house-oversight-estate'
        ).first()

        if existing:
            skipped += 1
            continue

        # Get image paths for this document
        images = doc_images.get(bates_begin, [])
        first_image = images[0] if images else None

        # Determine local path
        if first_image:
            # Convert to local path
            img_path = first_image.replace('\\HOUSE_OVERSIGHT_009\\', '').replace('\\', '/')
            local_path = str(HOUSE_OVERSIGHT_DIR / img_path)
        else:
            local_path = str(HOUSE_OVERSIGHT_DIR / 'TEXT' / '001' / f"{bates_begin}.txt")

        # Get document type
        doc_type = get_document_type(doc['_extension'], doc['_filename'])

        # Parse date
        doc_date = None
        if doc['_date_created']:
            try:
                doc_date = datetime.strptime(doc['_date_created'], '%m/%d/%Y')
            except:
                pass

        # Create document record
        db_doc = Document(
            source_url=f"https://oversight.house.gov/epstein-estate/{bates_begin}",
            source_page="https://oversight.house.gov/epstein-estate",
            data_set='house-oversight-estate',
            category='house-oversight',
            filename=bates_begin,
            local_path=local_path,
            file_hash=doc['_md5_hash'],
            file_size=doc['_file_size'],
            content_type='application/pdf' if doc_type == DocumentType.PDF.value else 'image/jpeg',
            document_type=doc_type,
            title=doc['_title'] or doc['_filename'] or bates_begin,
            document_date=doc_date,
            download_timestamp=utc_now(),
            processing_status=ProcessingStatus.COMPLETED.value,
            page_count=doc['_pages'] or len(images) or 1,
            has_text=bool(doc['_text_link']),
            needs_ocr=False  # Already have OCR text
        )

        session.add(db_doc)
        session.flush()  # Get the ID

        # Import text content
        text_content = get_text_content(doc['_text_link'])
        if text_content:
            doc_text = DocumentText(
                document_id=db_doc.id,
                full_text=text_content,
                word_count=len(text_content.split()) if text_content else 0,
                ocr_engine='house-oversight-ocr',
                average_confidence=0.95
            )
            session.add(doc_text)

        imported += 1

        if imported % 100 == 0:
            session.commit()
            logger.info(f"Imported {imported} documents...")

    session.commit()
    logger.info(f"Import complete: {imported} imported, {skipped} skipped")
    return imported, skipped


def main():
    """Main import function."""
    logger.info("=" * 60)
    logger.info("House Oversight Estate Import")
    logger.info("=" * 60)

    # Check paths
    if not HOUSE_OVERSIGHT_DIR.exists():
        logger.error(f"House Oversight directory not found: {HOUSE_OVERSIGHT_DIR}")
        return

    if not DAT_FILE.exists():
        logger.error(f"DAT file not found: {DAT_FILE}")
        return

    if not OPT_FILE.exists():
        logger.error(f"OPT file not found: {OPT_FILE}")
        return

    # Initialize database
    logger.info("Initializing database...")
    engine = init_database()
    session = get_session(engine)

    try:
        # Parse load files
        logger.info("Parsing DAT file...")
        documents = parse_dat_file(DAT_FILE)

        logger.info("Parsing OPT file...")
        doc_images = parse_opt_file(OPT_FILE)

        # Import documents
        logger.info("Importing documents...")
        imported, skipped = import_documents(session, documents, doc_images)

        # Stats
        total_docs = session.query(Document).count()
        house_docs = session.query(Document).filter_by(data_set='house-oversight-estate').count()

        logger.info("=" * 60)
        logger.info("Import Summary")
        logger.info("=" * 60)
        logger.info(f"Documents imported: {imported}")
        logger.info(f"Documents skipped: {skipped}")
        logger.info(f"Total House Oversight docs: {house_docs}")
        logger.info(f"Total docs in database: {total_docs}")

    except Exception as e:
        logger.error(f"Import failed: {e}")
        session.rollback()
        raise
    finally:
        session.close()


if __name__ == "__main__":
    main()
