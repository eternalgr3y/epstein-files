r"""
Parse OPT file to extract document-to-page mappings for House Oversight.

The OPT format:
HOUSE_OVERSIGHT_010477,HOUSE_OVERSIGHT_009,\PATH\TO\IMAGE.jpg,Y,,,9
  - Column 0: Page Bates number
  - Column 2: Image path
  - Column 3: 'Y' if this is the first page of a document
  - Column 6: Page count (only on first page)

This script parses the mappings and stores them in the database.
"""

import json
import logging
from pathlib import Path
from typing import Dict, List

from models import get_engine, get_session, Document
from config import RAW_DIR

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

OPT_FILE = RAW_DIR / "house-oversight-estate" / "DATA" / "HOUSE_OVERSIGHT_009.opt"


def parse_opt_file() -> Dict[str, List[str]]:
    """
    Parse OPT file and return mapping of document Bates -> list of page image paths.
    """
    doc_pages: Dict[str, List[str]] = {}
    current_doc = None
    current_pages = []

    with open(OPT_FILE, 'r') as f:
        for line in f:
            parts = line.strip().split(',')
            if len(parts) < 4:
                continue

            page_bates = parts[0]  # e.g., HOUSE_OVERSIGHT_010477
            image_path = parts[2]  # e.g., \HOUSE_OVERSIGHT_009\IMAGES\001\HOUSE_OVERSIGHT_010477.jpg
            is_doc_start = parts[3] == 'Y'

            # Normalize image path - convert Windows path to relative
            # \HOUSE_OVERSIGHT_009\IMAGES\001\file.jpg -> IMAGES/001/file.jpg
            image_path = image_path.replace('\\HOUSE_OVERSIGHT_009\\', '').replace('\\', '/')

            if is_doc_start:
                # Save previous document
                if current_doc and current_pages:
                    doc_pages[current_doc] = current_pages

                # Start new document
                current_doc = page_bates
                current_pages = [image_path]
            else:
                # Add page to current document
                current_pages.append(image_path)

        # Save last document
        if current_doc and current_pages:
            doc_pages[current_doc] = current_pages

    return doc_pages


def update_documents_with_pages(doc_pages: Dict[str, List[str]]):
    """
    Update House Oversight documents in database with their page mappings.
    Stores as JSON in a metadata field or updates page_count.
    """
    engine = get_engine()
    session = get_session(engine)

    # Get all House Oversight documents
    docs = session.query(Document).filter(
        Document.data_set == 'house-oversight-estate'
    ).all()

    logger.info(f"Found {len(docs)} House Oversight documents")

    updated = 0
    not_found = 0

    for doc in docs:
        # The document filename is the Bates number
        bates = doc.filename

        if bates in doc_pages:
            pages = doc_pages[bates]

            # Update page count
            doc.page_count = len(pages)

            # Store page paths as JSON in metadata (we'll add this field if needed)
            # For now, let's create a simple JSON structure
            page_data = {
                'pages': pages,
                'page_count': len(pages)
            }

            # We could store in a dedicated field, but for now let's update local_path
            # to include all pages as a JSON array
            # Actually, let's create a separate output file with the mappings

            updated += 1
        else:
            not_found += 1

    session.commit()
    logger.info(f"Updated {updated} documents, {not_found} not found in OPT")

    session.close()
    return doc_pages


def save_page_mappings(doc_pages: Dict[str, List[str]], output_path: Path):
    """Save page mappings to a JSON file for use by the API."""
    # Convert to a more useful format
    mappings = {}
    for bates, pages in doc_pages.items():
        mappings[bates] = {
            'pages': pages,
            'page_count': len(pages),
            'first_page': pages[0] if pages else None,
            'thumbnail': pages[0] if pages else None  # First page as thumbnail
        }

    with open(output_path, 'w') as f:
        json.dump(mappings, f, indent=2)

    logger.info(f"Saved page mappings to {output_path}")


def main():
    logger.info("Parsing OPT file...")
    doc_pages = parse_opt_file()

    logger.info(f"Found {len(doc_pages)} documents with {sum(len(p) for p in doc_pages.values())} total pages")

    # Show some examples
    examples = list(doc_pages.items())[:5]
    for bates, pages in examples:
        logger.info(f"  {bates}: {len(pages)} pages")
        if pages:
            logger.info(f"    First: {pages[0]}")
            if len(pages) > 1:
                logger.info(f"    Last: {pages[-1]}")

    # Update database
    logger.info("Updating documents in database...")
    update_documents_with_pages(doc_pages)

    # Save mappings to JSON for API use
    output_path = RAW_DIR.parent / "house_oversight_pages.json"
    save_page_mappings(doc_pages, output_path)

    # Summary stats
    page_counts = [len(p) for p in doc_pages.values()]
    logger.info(f"\nSummary:")
    logger.info(f"  Total documents: {len(doc_pages)}")
    logger.info(f"  Total pages: {sum(page_counts)}")
    logger.info(f"  Avg pages/doc: {sum(page_counts)/len(page_counts):.1f}")
    logger.info(f"  Max pages: {max(page_counts)}")
    logger.info(f"  Single-page docs: {sum(1 for p in page_counts if p == 1)}")


if __name__ == "__main__":
    main()
