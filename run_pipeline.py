#!/usr/bin/env python3
"""
Run the full processing pipeline.

Steps:
1. Import metadata from scraped documents
2. Run OCR on documents that need it
3. (Future) Run entity extraction
4. (Future) Run relationship extraction

Usage:
    python run_pipeline.py              # Run full pipeline
    python run_pipeline.py --import     # Just import metadata
    python run_pipeline.py --ocr        # Just run OCR
    python run_pipeline.py --stats      # Show statistics
"""

import argparse
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from models import get_engine, get_session, init_database
from importer import import_all_metadata, get_document_stats
from ocr_pipeline import process_pending_documents, get_processing_stats


def show_stats():
    """Show current processing statistics."""
    engine = get_engine()
    session = get_session(engine)

    doc_stats = get_document_stats(session)
    proc_stats = get_processing_stats(session)

    print("\n" + "=" * 50)
    print("DOCUMENT STATISTICS")
    print("=" * 50)
    print(f"Total documents:    {doc_stats['total']}")
    print(f"\nBy Type:")
    for dtype, count in doc_stats.get('by_type', {}).items():
        print(f"  {dtype}: {count}")
    print(f"\nBy Data Set:")
    for ds, count in doc_stats.get('by_data_set', {}).items():
        print(f"  {ds}: {count}")

    print("\n" + "=" * 50)
    print("PROCESSING STATISTICS")
    print("=" * 50)
    print(f"Pending:    {proc_stats['pending']}")
    print(f"Completed:  {proc_stats['completed']}")
    print(f"Failed:     {proc_stats['failed']}")
    print(f"With text:  {proc_stats['with_text']}")
    print(f"Progress:   {proc_stats['percent_complete']:.1f}%")

    session.close()


def main():
    parser = argparse.ArgumentParser(description='Epstein Files Processing Pipeline')
    parser.add_argument('--import', dest='do_import', action='store_true',
                       help='Import metadata from scraped documents')
    parser.add_argument('--ocr', action='store_true',
                       help='Run OCR on pending documents')
    parser.add_argument('--ocr-batch', type=int, default=10,
                       help='Number of documents to OCR per batch')
    parser.add_argument('--stats', action='store_true',
                       help='Show processing statistics')
    parser.add_argument('--init-db', action='store_true',
                       help='Initialize/reset database')
    args = parser.parse_args()

    # If no specific action, show help
    if not any([args.do_import, args.ocr, args.stats, args.init_db]):
        parser.print_help()
        print("\n\nCurrent status:")
        show_stats()
        return

    if args.init_db:
        print("Initializing database...")
        init_database()
        print("Done!")

    if args.do_import:
        print("Importing metadata...")
        imported, skipped, errors = import_all_metadata()
        print(f"Import complete: {imported} new, {skipped} skipped, {errors} errors")

    if args.ocr:
        print(f"Running OCR (batch size: {args.ocr_batch})...")
        processed = process_pending_documents(batch_size=args.ocr_batch)
        print(f"Processed {processed} documents")

    if args.stats:
        show_stats()


if __name__ == "__main__":
    main()
