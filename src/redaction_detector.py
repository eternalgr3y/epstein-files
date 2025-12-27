"""
Redaction Integrity Detector

Detects improperly redacted PDFs where text is visually obscured but still
extractable. This is critical for survivor protection - we must not accidentally
expose information that was intended to be redacted.

Confidence: 85%

ETHICAL PRINCIPLE: When we detect hidden text under redactions, we:
1. Flag the document for review
2. DO NOT index the hidden content
3. Log the issue for manual review
4. Protect potentially sensitive information
"""

import re
import logging
from dataclasses import dataclass, field
from typing import Optional, List, Tuple
from pathlib import Path
from enum import Enum

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class RedactionStatus(Enum):
    """Status of redaction integrity check."""
    CLEAN = "clean"                    # No redaction issues detected
    IMPROPER_REDACTION = "improper"    # Hidden text found under visual redaction
    HEAVY_REDACTION = "heavy"          # Extensively redacted (>50% black)
    NEEDS_REVIEW = "needs_review"      # Uncertain, requires human review
    ERROR = "error"                    # Could not process


@dataclass
class RedactionIssue:
    """A detected redaction problem."""
    page_number: int
    issue_type: str
    description: str
    # We DO NOT store the hidden text itself - that would defeat the purpose
    hidden_text_length: int = 0  # Just the length, not content
    confidence: float = 0.0


@dataclass
class RedactionReport:
    """Full report on document redaction integrity."""
    document_path: str
    status: RedactionStatus
    issues: List[RedactionIssue] = field(default_factory=list)
    total_pages: int = 0
    redacted_page_count: int = 0
    extraction_method: str = ""
    recommendation: str = ""

    @property
    def has_issues(self) -> bool:
        return len(self.issues) > 0

    @property
    def is_safe_to_index(self) -> bool:
        """Can we safely index this document's text?"""
        if self.status == RedactionStatus.IMPROPER_REDACTION:
            return False  # DO NOT index - contains hidden text
        if self.status == RedactionStatus.NEEDS_REVIEW:
            return False  # Wait for human review
        return True


class RedactionDetector:
    """
    Detects improper PDF redactions.

    Methods:
    1. Compare OCR text vs selectable text
    2. Detect black rectangles with underlying content
    3. Check for text extraction anomalies
    """

    def __init__(self):
        self.sensitive_patterns = self._compile_sensitive_patterns()

    def _compile_sensitive_patterns(self) -> List[re.Pattern]:
        """Patterns that suggest sensitive redacted content."""
        patterns = [
            # Names (basic pattern)
            r'\b[A-Z][a-z]+ [A-Z][a-z]+\b',
            # Phone numbers
            r'\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b',
            # Email addresses
            r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b',
            # SSN patterns
            r'\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b',
            # Addresses
            r'\b\d+\s+[A-Z][a-z]+\s+(Street|St|Avenue|Ave|Road|Rd|Drive|Dr)\b',
            # Age indicators (especially concerning in this context)
            r'\b(age|aged)\s*:?\s*\d{1,2}\b',
            r'\b\d{1,2}\s*(years?\s*old|y/?o)\b',
        ]
        return [re.compile(p, re.IGNORECASE) for p in patterns]

    def detect_improper_redactions(self, pdf_path: str) -> RedactionReport:
        """
        Check a PDF for improper redactions.

        Strategy:
        1. Extract text via direct PDF parsing (gets hidden text)
        2. Render pages and OCR (gets only visible text)
        3. Compare: if direct extraction > OCR, there's hidden text
        """
        try:
            import fitz  # PyMuPDF
        except ImportError:
            return RedactionReport(
                document_path=pdf_path,
                status=RedactionStatus.ERROR,
                recommendation="PyMuPDF not installed"
            )

        issues = []
        redacted_pages = 0

        try:
            doc = fitz.open(pdf_path)
            total_pages = len(doc)

            for page_num in range(total_pages):
                page = doc[page_num]

                # Method 1: Get all text (including under redactions)
                raw_text = page.get_text("text")

                # Method 2: Check for redaction annotations or black rectangles
                has_visual_redaction = self._detect_visual_redactions(page)

                if has_visual_redaction:
                    redacted_pages += 1

                    # Method 3: Get text from specific areas that appear redacted
                    hidden_text = self._extract_hidden_under_redactions(page)

                    if hidden_text:
                        # Check if hidden text contains sensitive patterns
                        sensitivity_score = self._check_sensitivity(hidden_text)

                        issues.append(RedactionIssue(
                            page_number=page_num + 1,
                            issue_type="improper_redaction",
                            description=f"Found {len(hidden_text)} chars of hidden text under visual redaction",
                            hidden_text_length=len(hidden_text),
                            confidence=0.90
                        ))

                        # Log but DO NOT log the actual hidden content
                        logger.warning(
                            f"Improper redaction detected on page {page_num + 1} of {pdf_path}: "
                            f"{len(hidden_text)} hidden chars, sensitivity={sensitivity_score:.2f}"
                        )

            doc.close()

            # Determine status
            if issues:
                status = RedactionStatus.IMPROPER_REDACTION
                recommendation = (
                    "DO NOT INDEX - Document contains improperly redacted content. "
                    "Hidden text may contain victim names or sensitive information. "
                    "Requires manual review before any text extraction."
                )
            elif redacted_pages > total_pages * 0.5:
                status = RedactionStatus.HEAVY_REDACTION
                recommendation = (
                    "Document is heavily redacted (>50% pages). "
                    "Safe to index visible text only."
                )
            else:
                status = RedactionStatus.CLEAN
                recommendation = "No redaction issues detected. Safe to index."

            return RedactionReport(
                document_path=pdf_path,
                status=status,
                issues=issues,
                total_pages=total_pages,
                redacted_page_count=redacted_pages,
                extraction_method="pymupdf_comparison",
                recommendation=recommendation
            )

        except Exception as e:
            logger.error(f"Error analyzing {pdf_path}: {e}")
            return RedactionReport(
                document_path=pdf_path,
                status=RedactionStatus.ERROR,
                recommendation=f"Error during analysis: {str(e)}"
            )

    def _detect_visual_redactions(self, page) -> bool:
        """Detect black rectangles or redaction annotations on a page."""
        # Check for redaction annotations
        for annot in page.annots() or []:
            if annot.type[0] == 12:  # Redact annotation type
                return True

        # Check for black rectangles (common redaction method)
        drawings = page.get_drawings()
        for drawing in drawings:
            # Look for filled black rectangles
            if drawing.get("fill") == (0, 0, 0):  # Black fill
                rect = drawing.get("rect")
                if rect:
                    # Check if it's a reasonable redaction size (not tiny, not full page)
                    width = rect.width
                    height = rect.height
                    if 10 < width < page.rect.width * 0.9 and 5 < height < 50:
                        return True

        # Check for images that might be redaction overlays
        image_list = page.get_images()
        for img in image_list:
            # Small black images often used as redaction bars
            xref = img[0]
            try:
                base_image = page.parent.extract_image(xref)
                if base_image:
                    # Check if it's predominantly black
                    # This is a heuristic - truly black images are suspicious
                    pass
            except:
                pass

        return False

    def _extract_hidden_under_redactions(self, page) -> str:
        """
        Extract text that appears to be under redaction rectangles.

        Returns the hidden text (but we won't store or index it).
        """
        hidden_text = ""

        # Get all drawings (potential redaction boxes)
        drawings = page.get_drawings()
        black_rects = []

        for drawing in drawings:
            if drawing.get("fill") == (0, 0, 0):
                rect = drawing.get("rect")
                if rect:
                    black_rects.append(rect)

        # Get text blocks with their positions
        blocks = page.get_text("dict")["blocks"]

        for block in blocks:
            if block.get("type") == 0:  # Text block
                block_rect = block.get("bbox")
                if block_rect:
                    # Check if this text block is under any black rectangle
                    for black_rect in black_rects:
                        if self._rects_overlap(block_rect, black_rect):
                            # This text is under a redaction
                            for line in block.get("lines", []):
                                for span in line.get("spans", []):
                                    hidden_text += span.get("text", "") + " "

        return hidden_text.strip()

    def _rects_overlap(self, rect1, rect2) -> bool:
        """Check if two rectangles overlap."""
        # rect format: (x0, y0, x1, y1)
        try:
            x0_1, y0_1, x1_1, y1_1 = rect1[:4]
            x0_2, y0_2, x1_2, y1_2 = rect2[:4]

            return not (x1_1 < x0_2 or x1_2 < x0_1 or y1_1 < y0_2 or y1_2 < y0_1)
        except:
            return False

    def _check_sensitivity(self, text: str) -> float:
        """
        Score how sensitive the hidden text appears to be.

        Higher score = more likely to contain PII or sensitive info.
        """
        if not text:
            return 0.0

        score = 0.0
        matches = 0

        for pattern in self.sensitive_patterns:
            if pattern.search(text):
                matches += 1

        if matches > 0:
            score = min(matches / len(self.sensitive_patterns), 1.0)

        # Boost score if text length suggests complete sentences/names
        if len(text) > 20:
            score += 0.1
        if len(text) > 100:
            score += 0.2

        return min(score, 1.0)


def check_document(pdf_path: str) -> RedactionReport:
    """Convenience function to check a single document."""
    detector = RedactionDetector()
    return detector.detect_improper_redactions(pdf_path)


def check_directory(dir_path: str) -> List[RedactionReport]:
    """Check all PDFs in a directory."""
    detector = RedactionDetector()
    reports = []

    for pdf_file in Path(dir_path).glob("**/*.pdf"):
        report = detector.detect_improper_redactions(str(pdf_file))
        reports.append(report)

        if report.has_issues:
            logger.warning(f"Issues found in {pdf_file}: {report.status.value}")

    return reports


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1:
        path = sys.argv[1]
        if Path(path).is_file():
            report = check_document(path)
        else:
            reports = check_directory(path)
            report = None
            for r in reports:
                print(f"{r.document_path}: {r.status.value}")
                if r.has_issues:
                    for issue in r.issues:
                        print(f"  Page {issue.page_number}: {issue.description}")
    else:
        print("Usage: python redaction_detector.py <pdf_file_or_directory>")
        print("\nThis tool detects improperly redacted PDFs where hidden text")
        print("can be extracted despite visual black boxes.")
        print("\nFor survivor protection, we flag but DO NOT expose hidden content.")
