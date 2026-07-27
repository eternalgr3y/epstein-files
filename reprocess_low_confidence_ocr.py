#!/usr/bin/env python3
"""Safely retry small, low-confidence PDFs with the current OCR pipeline."""

import argparse
import sys
from pathlib import Path


ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT / "src"))

from models import Document, get_engine, get_session
from ocr_pipeline import process_document, save_extraction_result


def crosses_confidence_threshold(old_confidence, new_confidence, minimum_confidence):
    return new_confidence >= minimum_confidence and new_confidence > old_confidence


def candidate_ids(threshold, max_pages, limit):
    session = get_session(get_engine())
    try:
        query = session.query(Document.id).filter(
            Document.document_type == "pdf",
            Document.ocr_confidence < threshold,
            Document.page_count <= max_pages,
        ).order_by(Document.ocr_confidence.asc(), Document.id.asc())
        if limit:
            query = query.limit(limit)
        return [document_id for (document_id,) in query.all()]
    finally:
        session.close()


def process_candidates(document_ids, minimum_confidence=0.50):
    improved = 0
    skipped = 0
    failed = 0
    for document_id in document_ids:
        read_session = get_session(get_engine())
        try:
            document = read_session.get(Document, document_id)
            old_confidence = document.ocr_confidence or 0.0
            old_words = (
                document.text_content.word_count if document.text_content else 0
            )
            read_session.expunge(document)
        finally:
            read_session.close()

        result = process_document(document)
        if not result.success or result.word_count == 0:
            failed += 1
            print(
                f"failed id={document_id} file={document.filename} "
                f"error={result.error or 'no text'}",
                flush=True,
            )
            continue
        if not crosses_confidence_threshold(
            old_confidence,
            result.average_confidence,
            minimum_confidence,
        ):
            skipped += 1
            print(
                f"unchanged id={document_id} file={document.filename} "
                f"words={old_words}->{result.word_count} "
                f"confidence={old_confidence:.3f}->{result.average_confidence:.3f} "
                f"required={minimum_confidence:.3f}",
                flush=True,
            )
            continue

        write_session = get_session(get_engine())
        try:
            current = write_session.get(Document, document_id)
            save_extraction_result(write_session, current, result)
        finally:
            write_session.close()
        improved += 1
        print(
            f"improved id={document_id} file={document.filename} "
            f"words={old_words}->{result.word_count} "
            f"confidence={old_confidence:.3f}->{result.average_confidence:.3f}",
            flush=True,
        )
    return {"improved": improved, "unchanged": skipped, "failed": failed}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--threshold", type=float, default=0.50)
    parser.add_argument("--max-pages", type=int, default=1)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    ids = candidate_ids(args.threshold, args.max_pages, args.limit)
    if args.dry_run:
        print(
            f"Candidates: {len(ids)} (confidence < {args.threshold}, "
            f"pages <= {args.max_pages})"
        )
        return
    print(process_candidates(ids, minimum_confidence=args.threshold))


if __name__ == "__main__":
    main()
