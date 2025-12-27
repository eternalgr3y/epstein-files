"""
OCR Pipeline for Epstein Files

Extracts text from PDFs and images using:
- PyMuPDF (fitz) for native PDF text extraction
- Tesseract for OCR on scanned documents and images
"""

import logging
import time
from pathlib import Path
from typing import Optional, Tuple, List
from datetime import datetime
from dataclasses import dataclass

try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None

try:
    from PIL import Image
    import pytesseract
except ImportError:
    pytesseract = None

try:
    from pdf2image import convert_from_path
except ImportError:
    convert_from_path = None

from models import (
    get_engine, get_session, Document, DocumentText,
    ProcessingStatus, ProcessingLog
)
from redaction_detector import RedactionDetector, RedactionStatus

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Redaction detection
redaction_detector = RedactionDetector()

# Configuration
OCR_DPI = 300
TESSERACT_LANG = "eng"
MIN_TEXT_LENGTH = 50  # Minimum chars to consider a page has text


@dataclass
class ExtractionResult:
    """Result of text extraction from a document."""
    success: bool
    full_text: str
    pages_text: List[str]
    word_count: int
    average_confidence: float
    method: str  # "native" or "ocr"
    error: Optional[str] = None
    duration_ms: int = 0
    # Redaction integrity
    redaction_status: str = "unchecked"
    redaction_safe_to_index: bool = True
    redaction_issues: int = 0


def extract_text_from_pdf_native(pdf_path: Path) -> Tuple[List[str], bool]:
    """
    Extract text from PDF using PyMuPDF (native extraction).
    Returns (pages_text, has_text).
    """
    if fitz is None:
        return [], False

    try:
        doc = fitz.open(str(pdf_path))
        pages_text = []
        has_meaningful_text = False

        for page in doc:
            text = page.get_text()
            pages_text.append(text)
            if len(text.strip()) >= MIN_TEXT_LENGTH:
                has_meaningful_text = True

        doc.close()
        return pages_text, has_meaningful_text

    except Exception as e:
        logger.error(f"Native PDF extraction failed for {pdf_path}: {e}")
        return [], False


def extract_text_from_pdf_ocr(pdf_path: Path) -> Tuple[List[str], float]:
    """
    Extract text from PDF using OCR.
    Returns (pages_text, average_confidence).
    """
    if convert_from_path is None or pytesseract is None:
        return [], 0.0

    try:
        # Convert PDF to images
        images = convert_from_path(str(pdf_path), dpi=OCR_DPI)
        pages_text = []
        confidences = []

        for i, image in enumerate(images):
            # Run OCR with confidence data
            data = pytesseract.image_to_data(
                image,
                lang=TESSERACT_LANG,
                output_type=pytesseract.Output.DICT
            )

            # Extract text and confidence
            text_parts = []
            page_confidences = []

            for j, conf in enumerate(data['conf']):
                if conf != -1:  # -1 means no confidence (not a word)
                    text_parts.append(data['text'][j])
                    page_confidences.append(conf)

            page_text = ' '.join(text_parts)
            pages_text.append(page_text)

            if page_confidences:
                confidences.append(sum(page_confidences) / len(page_confidences))

        avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0
        return pages_text, avg_confidence / 100.0  # Normalize to 0-1

    except Exception as e:
        logger.error(f"OCR extraction failed for {pdf_path}: {e}")
        return [], 0.0


def extract_text_from_image(image_path: Path) -> Tuple[str, float]:
    """
    Extract text from an image using OCR.
    Returns (text, confidence).
    """
    if pytesseract is None:
        return "", 0.0

    try:
        image = Image.open(str(image_path))

        # Get OCR data with confidence
        data = pytesseract.image_to_data(
            image,
            lang=TESSERACT_LANG,
            output_type=pytesseract.Output.DICT
        )

        text_parts = []
        confidences = []

        for i, conf in enumerate(data['conf']):
            if conf != -1:
                text_parts.append(data['text'][i])
                confidences.append(conf)

        text = ' '.join(text_parts)
        avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0

        return text, avg_confidence / 100.0

    except Exception as e:
        logger.error(f"Image OCR failed for {image_path}: {e}")
        return "", 0.0


def process_document(doc: Document) -> ExtractionResult:
    """
    Process a single document and extract text.
    Tries native extraction first, falls back to OCR.
    """
    start_time = time.time()
    file_path = Path(doc.local_path)

    if not file_path.exists():
        return ExtractionResult(
            success=False,
            full_text="",
            pages_text=[],
            word_count=0,
            average_confidence=0.0,
            method="none",
            error=f"File not found: {file_path}"
        )

    content_type = doc.content_type or ""
    filename_lower = doc.filename.lower()

    # Handle PDFs
    if 'pdf' in content_type or filename_lower.endswith('.pdf'):
        # CRITICAL: Check for improper redactions FIRST
        # This protects against accidentally exposing hidden victim names
        redaction_report = redaction_detector.detect_improper_redactions(str(file_path))

        if not redaction_report.is_safe_to_index:
            logger.warning(
                f"REDACTION ISSUE in {doc.filename}: {redaction_report.status.value}. "
                f"Document flagged for manual review. Text will NOT be indexed."
            )
            duration_ms = int((time.time() - start_time) * 1000)
            return ExtractionResult(
                success=False,  # Treat as failure - needs human review
                full_text="",   # DO NOT extract text
                pages_text=[],
                word_count=0,
                average_confidence=0.0,
                method="blocked",
                error=f"REDACTION_ISSUE: {redaction_report.recommendation}",
                duration_ms=duration_ms,
                redaction_status=redaction_report.status.value,
                redaction_safe_to_index=False,
                redaction_issues=len(redaction_report.issues)
            )

        # Try native extraction first
        pages_text, has_text = extract_text_from_pdf_native(file_path)

        if has_text:
            full_text = '\n\n'.join(pages_text)
            duration_ms = int((time.time() - start_time) * 1000)
            return ExtractionResult(
                success=True,
                full_text=full_text,
                pages_text=pages_text,
                word_count=len(full_text.split()),
                average_confidence=1.0,  # Native extraction is high confidence
                method="native",
                duration_ms=duration_ms,
                redaction_status=redaction_report.status.value,
                redaction_safe_to_index=True,
                redaction_issues=len(redaction_report.issues)
            )

        # Fall back to OCR
        logger.info(f"Native extraction insufficient for {doc.filename}, using OCR...")
        pages_text, confidence = extract_text_from_pdf_ocr(file_path)

        if pages_text:
            full_text = '\n\n'.join(pages_text)
            duration_ms = int((time.time() - start_time) * 1000)
            return ExtractionResult(
                success=True,
                full_text=full_text,
                pages_text=pages_text,
                word_count=len(full_text.split()),
                average_confidence=confidence,
                method="ocr",
                duration_ms=duration_ms,
                redaction_status=redaction_report.status.value,
                redaction_safe_to_index=True,
                redaction_issues=len(redaction_report.issues)
            )

        return ExtractionResult(
            success=False,
            full_text="",
            pages_text=[],
            word_count=0,
            average_confidence=0.0,
            method="ocr",
            error="OCR extraction failed or returned no text"
        )

    # Handle images
    if 'image' in content_type or any(filename_lower.endswith(ext) for ext in ['.jpg', '.jpeg', '.png', '.tiff', '.gif']):
        text, confidence = extract_text_from_image(file_path)

        duration_ms = int((time.time() - start_time) * 1000)

        if text.strip():
            return ExtractionResult(
                success=True,
                full_text=text,
                pages_text=[text],
                word_count=len(text.split()),
                average_confidence=confidence,
                method="ocr",
                duration_ms=duration_ms
            )

        # Images without text are still "successful" - they just have no text
        return ExtractionResult(
            success=True,
            full_text="",
            pages_text=[],
            word_count=0,
            average_confidence=0.0,
            method="ocr",
            duration_ms=duration_ms
        )

    # Unsupported file type
    return ExtractionResult(
        success=False,
        full_text="",
        pages_text=[],
        word_count=0,
        average_confidence=0.0,
        method="none",
        error=f"Unsupported file type: {content_type}"
    )


def save_extraction_result(session, doc: Document, result: ExtractionResult):
    """Save extraction result to database."""
    try:
        # Update document
        doc.processing_status = ProcessingStatus.COMPLETED.value if result.success else ProcessingStatus.FAILED.value
        doc.ocr_confidence = result.average_confidence
        doc.ocr_completed_at = datetime.utcnow()
        doc.has_text = result.word_count > 0
        doc.needs_ocr = False

        # Create or update text content
        if result.success and result.word_count > 0:
            text_record = session.query(DocumentText).filter_by(document_id=doc.id).first()
            if text_record:
                text_record.full_text = result.full_text
                text_record.pages_text = result.pages_text
                text_record.word_count = result.word_count
                text_record.average_confidence = result.average_confidence
                text_record.ocr_engine = result.method
            else:
                text_record = DocumentText(
                    document_id=doc.id,
                    full_text=result.full_text,
                    pages_text=result.pages_text,
                    word_count=result.word_count,
                    average_confidence=result.average_confidence,
                    ocr_engine=result.method,
                    ocr_language=TESSERACT_LANG
                )
                session.add(text_record)

        # Log the processing
        log = ProcessingLog(
            document_id=doc.id,
            action="text_extraction",
            status="success" if result.success else "failed",
            message=f"Method: {result.method}, Words: {result.word_count}, Confidence: {result.average_confidence:.2f}",
            error_details=result.error,
            duration_ms=result.duration_ms
        )
        session.add(log)

        session.commit()

    except Exception as e:
        logger.error(f"Failed to save extraction result for doc {doc.id}: {e}")
        session.rollback()


def process_pending_documents(batch_size: int = 10):
    """Process documents that need text extraction."""
    engine = get_engine()
    session = get_session(engine)

    # Get pending documents
    pending = session.query(Document).filter(
        Document.needs_ocr == True,
        Document.processing_status == ProcessingStatus.PENDING.value
    ).limit(batch_size).all()

    if not pending:
        logger.info("No pending documents to process")
        return 0

    logger.info(f"Processing {len(pending)} documents...")

    processed = 0
    for doc in pending:
        logger.info(f"Processing: {doc.filename}")

        result = process_document(doc)
        save_extraction_result(session, doc, result)

        if result.success:
            logger.info(f"  Success: {result.word_count} words ({result.method})")
        else:
            logger.warning(f"  Failed: {result.error}")

        processed += 1

    session.close()
    return processed


def get_processing_stats(session) -> dict:
    """Get OCR processing statistics."""
    total = session.query(Document).count()
    pending = session.query(Document).filter_by(processing_status=ProcessingStatus.PENDING.value).count()
    completed = session.query(Document).filter_by(processing_status=ProcessingStatus.COMPLETED.value).count()
    failed = session.query(Document).filter_by(processing_status=ProcessingStatus.FAILED.value).count()

    with_text = session.query(Document).filter_by(has_text=True).count()

    return {
        'total': total,
        'pending': pending,
        'completed': completed,
        'failed': failed,
        'with_text': with_text,
        'percent_complete': (completed / total * 100) if total > 0 else 0
    }


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description='OCR Pipeline')
    parser.add_argument('--batch-size', type=int, default=10, help='Number of documents to process')
    parser.add_argument('--stats', action='store_true', help='Show processing statistics')
    args = parser.parse_args()

    if args.stats:
        engine = get_engine()
        session = get_session(engine)
        stats = get_processing_stats(session)
        print("OCR Processing Statistics:")
        print(f"  Total documents: {stats['total']}")
        print(f"  Pending: {stats['pending']}")
        print(f"  Completed: {stats['completed']}")
        print(f"  Failed: {stats['failed']}")
        print(f"  With text: {stats['with_text']}")
        print(f"  Progress: {stats['percent_complete']:.1f}%")
        session.close()
    else:
        processed = process_pending_documents(batch_size=args.batch_size)
        print(f"Processed {processed} documents")
