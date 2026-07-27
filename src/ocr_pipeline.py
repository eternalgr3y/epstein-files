"""
OCR Pipeline for Epstein Files

Extracts text from PDFs and images using:
- PyMuPDF (fitz) for native PDF text extraction
- Tesseract for OCR on scanned documents and images
"""

import logging
import os
import time
from collections import Counter
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple
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
    ProcessingStatus, ProcessingLog, utc_now
)
from config import OCR_DPI, OCR_PAGE_BATCH_SIZE, REDACTION_POLICY, TESSERACT_LANG
from redaction_detector import RedactionDetector, RedactionReport, RedactionStatus
from fts_index import sync_fts_document

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Redaction detection
redaction_detector = RedactionDetector()

MIN_TEXT_LENGTH = 50  # Minimum chars to consider a page has text
SPARSE_OCR_WORD_THRESHOLD = 5
SPARSE_OCR_MIN_CONFIDENCE = 0.50
DENSE_TEXT_WORD_RATIO = 0.80


@dataclass
class ExtractionResult:
    """Result of text extraction from a document."""
    success: bool
    full_text: str
    pages_text: List[str]
    word_count: int
    average_confidence: float
    method: str  # "native", "ocr", "hybrid", "blocked", or "none"
    error: Optional[str] = None
    duration_ms: int = 0
    # Redaction integrity
    redaction_status: str = "unchecked"
    redaction_safe_to_index: bool = True
    redaction_issues: int = 0


def get_redaction_policy() -> str:
    """Read the policy at processing time so jobs can override it per run."""
    policy = os.getenv("REDACTION_POLICY", REDACTION_POLICY).strip().lower()
    if policy not in {"warn", "block", "off"}:
        raise ValueError("REDACTION_POLICY must be one of: warn, block, off")
    return policy


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


def _normalize_confidence(value) -> Optional[float]:
    """Normalize pytesseract confidence values across wrapper versions."""
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        return None
    return confidence if confidence >= 0 else None


def _text_and_confidence(data: dict) -> Tuple[str, float]:
    """Build clean OCR text and a mean confidence from image_to_data output."""
    words = []
    confidences = []

    for text, raw_confidence in zip(data.get("text", []), data.get("conf", [])):
        word = str(text).strip()
        confidence = _normalize_confidence(raw_confidence)
        if word and confidence is not None:
            words.append(word)
            confidences.append(confidence)

    average = sum(confidences) / len(confidences) if confidences else 0.0
    return " ".join(words), average / 100.0


def _dense_text_word_ratio(data: dict) -> float:
    """Return the share of OCR words that occur in lines of three or more."""
    line_counts = Counter()
    texts = data.get("text", [])
    confidences = data.get("conf", [])
    blocks = data.get("block_num", [])
    paragraphs = data.get("par_num", [])
    lines = data.get("line_num", [])
    for index, (text, raw_confidence) in enumerate(zip(texts, confidences)):
        if not str(text).strip() or _normalize_confidence(raw_confidence) is None:
            continue
        try:
            line_key = (blocks[index], paragraphs[index], lines[index])
        except IndexError:
            continue
        line_counts[line_key] += 1
    total_words = sum(line_counts.values())
    dense_words = sum(count for count in line_counts.values() if count >= 3)
    return dense_words / total_words if total_words else 0.0


def _ocr_image(image) -> Tuple[str, float]:
    """OCR an image, retrying sparse layouts when automatic layout finds little."""
    default_data = pytesseract.image_to_data(
        image,
        lang=TESSERACT_LANG,
        output_type=pytesseract.Output.DICT,
    )
    default = _text_and_confidence(default_data)
    if (
        len(default[0].split()) > SPARSE_OCR_WORD_THRESHOLD
        and (
            default[1] >= SPARSE_OCR_MIN_CONFIDENCE
            or _dense_text_word_ratio(default_data) >= DENSE_TEXT_WORD_RATIO
        )
    ):
        return default

    sparse = _text_and_confidence(
        pytesseract.image_to_data(
            image,
            lang=TESSERACT_LANG,
            config="--psm 11",
            output_type=pytesseract.Output.DICT,
        )
    )
    candidates = [default, sparse]

    # Sparse-text mode can mistake photographic texture for dozens of
    # low-confidence words. If that happens, retry the bottom/right regions
    # where Bates stamps and exhibit labels commonly appear, then prefer a
    # high-confidence candidate before considering raw word count.
    if sparse[1] < SPARSE_OCR_MIN_CONFIDENCE and hasattr(image, "crop"):
        width, height = image.size
        crops = [
            image.crop((0, int(height * 0.80), width, height)),
            image.crop((int(width * 0.60), 0, width, height)),
        ]
        try:
            for crop in crops:
                candidates.append(
                    _text_and_confidence(
                        pytesseract.image_to_data(
                            crop,
                            lang=TESSERACT_LANG,
                            config="--psm 11",
                            output_type=pytesseract.Output.DICT,
                        )
                    )
                )
        finally:
            for crop in crops:
                crop.close()

    def quality(result):
        words = len(result[0].split())
        confidence = result[1]
        reliable = confidence >= SPARSE_OCR_MIN_CONFIDENCE
        return (
            reliable,
            words if reliable else confidence,
            confidence if reliable else words,
        )

    return max(candidates, key=quality)


def _contiguous_batches(page_numbers: Iterable[int]) -> Iterable[List[int]]:
    """Yield consecutive, 1-based PDF page numbers in bounded batches."""
    batch = []
    for page_number in sorted(set(page_numbers)):
        if batch and (
            page_number != batch[-1] + 1
            or len(batch) >= OCR_PAGE_BATCH_SIZE
        ):
            yield batch
            batch = []
        batch.append(page_number)
    if batch:
        yield batch


def extract_text_from_pdf_pages_ocr(
    pdf_path: Path,
    page_numbers: Iterable[int],
) -> Dict[int, Tuple[str, float]]:
    """OCR selected zero-based PDF pages and return text/confidence by page."""
    if convert_from_path is None or pytesseract is None:
        return {}

    requested = sorted(set(page_numbers))
    if not requested:
        return {}

    try:
        with fitz.open(str(pdf_path)) as fitz_doc:
            page_count = fitz_doc.page_count

        valid_pages = [page for page in requested if 0 <= page < page_count]
        results = {}
        for batch in _contiguous_batches(page + 1 for page in valid_pages):
            images = convert_from_path(
                str(pdf_path),
                dpi=OCR_DPI,
                first_page=batch[0],
                last_page=batch[-1],
            )
            try:
                for page_number, image in zip(batch, images):
                    results[page_number - 1] = _ocr_image(image)
            finally:
                for image in images:
                    image.close()

        return results
    except Exception as e:
        logger.error(f"OCR extraction failed for {pdf_path}: {e}")
        return {}


def extract_text_from_pdf_ocr(pdf_path: Path) -> Tuple[List[str], float]:
    """
    Extract text from PDF using OCR.
    Returns (pages_text, average_confidence).
    """
    if fitz is None or convert_from_path is None or pytesseract is None:
        return [], 0.0

    try:
        with fitz.open(str(pdf_path)) as fitz_doc:
            page_count = fitz_doc.page_count
        results = extract_text_from_pdf_pages_ocr(pdf_path, range(page_count))
        pages_text = [results.get(page, ("", 0.0))[0] for page in range(page_count)]
        confidences = [
            confidence
            for text, confidence in (results.get(page, ("", 0.0)) for page in range(page_count))
            if text.strip()
        ]
        average = sum(confidences) / len(confidences) if confidences else 0.0
        return pages_text, average

    except Exception as e:
        logger.error(f"OCR extraction failed for {pdf_path}: {e}")
        return [], 0.0


def extract_text_from_pdf_hybrid(pdf_path: Path) -> Tuple[List[str], float, str]:
    """Use native text per page and OCR only pages without meaningful text."""
    native_pages, _ = extract_text_from_pdf_native(pdf_path)
    if not native_pages:
        pages, confidence = extract_text_from_pdf_ocr(pdf_path)
        return pages, confidence, "ocr"

    ocr_page_numbers = [
        page_number
        for page_number, text in enumerate(native_pages)
        if len(text.strip()) < MIN_TEXT_LENGTH
    ]
    if not ocr_page_numbers:
        return native_pages, 1.0, "native"

    ocr_results = extract_text_from_pdf_pages_ocr(pdf_path, ocr_page_numbers)
    pages_text = list(native_pages)
    page_confidences = [1.0 if text.strip() else 0.0 for text in native_pages]
    used_ocr = False

    for page_number in ocr_page_numbers:
        ocr_text, ocr_confidence = ocr_results.get(page_number, ("", 0.0))
        native_text = native_pages[page_number]
        # Preserve exact embedded text unless OCR materially adds content. This
        # keeps sparse native labels intact while still recovering a scanned
        # body from pages that only embed a page number or similar artifact.
        materially_adds_text = (
            not native_text.strip()
            or len(ocr_text.strip()) > len(native_text.strip()) * 1.25
        )
        if ocr_text.strip() and materially_adds_text:
            pages_text[page_number] = ocr_text
            page_confidences[page_number] = ocr_confidence
            used_ocr = True

    nonempty_confidences = [
        page_confidences[page_number]
        for page_number, text in enumerate(pages_text)
        if text.strip()
    ]
    average = (
        sum(nonempty_confidences) / len(nonempty_confidences)
        if nonempty_confidences
        else 0.0
    )
    if used_ocr and any(len(text.strip()) >= MIN_TEXT_LENGTH for text in native_pages):
        method = "hybrid"
    elif used_ocr:
        method = "ocr"
    else:
        method = "native"
    return pages_text, average, method


def extract_text_from_image(image_path: Path) -> Tuple[str, float]:
    """
    Extract text from an image using OCR.
    Returns (text, confidence).
    """
    if pytesseract is None:
        return "", 0.0

    try:
        with Image.open(str(image_path)) as image:
            return _ocr_image(image)

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
        redaction_policy = get_redaction_policy()
        if redaction_policy == "off":
            redaction_report = RedactionReport(
                document_path=str(file_path),
                status=RedactionStatus.UNCHECKED,
                recommendation="Redaction detector disabled by archive policy.",
            )
        else:
            redaction_report = redaction_detector.detect_improper_redactions(
                str(file_path)
            )

        if not redaction_report.is_safe_to_index:
            logger.warning(
                f"REDACTION ISSUE in {doc.filename}: {redaction_report.status.value}. "
                f"policy={redaction_policy}. {redaction_report.recommendation}"
            )
            if redaction_policy == "block":
                duration_ms = int((time.time() - start_time) * 1000)
                return ExtractionResult(
                    success=False,
                    full_text="",
                    pages_text=[],
                    word_count=0,
                    average_confidence=0.0,
                    method="blocked",
                    error=f"REDACTION_ISSUE: {redaction_report.recommendation}",
                    duration_ms=duration_ms,
                    redaction_status=redaction_report.status.value,
                    redaction_safe_to_index=False,
                    redaction_issues=len(redaction_report.issues),
                )

        pages_text, confidence, method = extract_text_from_pdf_hybrid(file_path)

        if pages_text:
            full_text = '\n\n'.join(pages_text)
            duration_ms = int((time.time() - start_time) * 1000)
            return ExtractionResult(
                success=True,
                full_text=full_text,
                pages_text=pages_text,
                word_count=len(full_text.split()),
                average_confidence=confidence,
                method=method,
                duration_ms=duration_ms,
                redaction_status=redaction_report.status.value,
                redaction_safe_to_index=redaction_report.is_safe_to_index,
                redaction_issues=len(redaction_report.issues)
            )

        return ExtractionResult(
            success=False,
            full_text="",
            pages_text=[],
            word_count=0,
            average_confidence=0.0,
            method=method,
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
            pages_text=[""],
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
        doc.ocr_completed_at = utc_now()
        doc.has_text = result.word_count > 0
        doc.needs_ocr = False

        # Create or update text content
        text_record = session.query(DocumentText).filter_by(document_id=doc.id).first()
        if result.success and result.word_count > 0:
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
        elif result.success and text_record:
            # A successful re-run that finds no text must not leave stale text
            # behind while marking the document as textless.
            session.delete(text_record)

        if result.success:
            sync_fts_document(session, doc.id, result.full_text)

        # Log the processing
        log = ProcessingLog(
            document_id=doc.id,
            action="text_extraction",
            status="success" if result.success else "failed",
            message=(
                f"Method: {result.method}, Words: {result.word_count}, "
                f"Confidence: {result.average_confidence:.2f}, "
                f"Redaction: {result.redaction_status}"
            ),
            error_details=result.error,
            duration_ms=result.duration_ms
        )
        session.add(log)

        session.commit()

    except Exception as e:
        logger.error(f"Failed to save extraction result for doc {doc.id}: {e}")
        session.rollback()
        raise


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
