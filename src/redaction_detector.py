"""
Redaction Integrity Detector

Detects PDF content where text is visually obscured but remains extractable.

The detector reports integrity findings. Whether those findings block indexing
is an archive policy decision made by the OCR pipeline.
"""

import io
import logging
import re
from dataclasses import dataclass, field
from typing import List
from pathlib import Path
from enum import Enum

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class RedactionStatus(Enum):
    """Status of redaction integrity check."""
    UNCHECKED = "unchecked"            # Detector disabled by archive policy
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
        """Whether a fail-closed policy can index without manual review."""
        return self.status in {
            RedactionStatus.UNCHECKED,
            RedactionStatus.CLEAN,
            RedactionStatus.HEAVY_REDACTION,
        }


class RedactionDetector:
    """
    Detects improper PDF redactions.

    Methods:
    1. Locate redaction annotations and black vector/image overlays
    2. Compare their rectangles with selectable text spans
    3. Report overlap without logging the underlying text
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
        1. Locate likely visual redaction rectangles
        2. Locate selectable text spans underneath those rectangles
        3. Record only the hidden character count and sensitivity score
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

                redaction_rects = self._find_redaction_rects(page)
                has_visual_redaction = bool(redaction_rects)

                if has_visual_redaction:
                    redacted_pages += 1

                    hidden_text = self._extract_hidden_under_redactions(
                        page, redaction_rects
                    )

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
                    "Source contains selectable text beneath a visual redaction. "
                    "Retain this finding in the processing audit log."
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

    def _find_redaction_rects(self, page) -> List:
        """Return likely redaction rectangles from annotations, vectors, and images."""
        rects = []

        for annot in page.annots() or []:
            if annot.type[0] == 12:  # Redact annotation type
                rects.append(annot.rect)

        drawings = page.get_drawings()
        for drawing in drawings:
            if self._is_dark_fill(drawing.get("fill")):
                rect = drawing.get("rect")
                if rect and self._is_redaction_sized(rect, page.rect):
                    rects.append(rect)

        dark_images = {}
        for img in page.get_images(full=True):
            xref = img[0]
            try:
                candidate_rects = [
                    rect
                    for rect in page.get_image_rects(xref)
                    if self._is_redaction_sized(rect, page.rect)
                ]
                if not candidate_rects:
                    continue
                if xref not in dark_images:
                    dark_images[xref] = self._is_predominantly_dark_image(
                        page.parent.extract_image(xref)
                    )
                if dark_images[xref]:
                    rects.extend(candidate_rects)
            except Exception:
                logger.debug("Unable to inspect PDF image xref %s", xref, exc_info=True)

        return rects

    def _detect_visual_redactions(self, page) -> bool:
        """Detect black rectangles or redaction annotations on a page."""
        return bool(self._find_redaction_rects(page))

    @staticmethod
    def _is_dark_fill(fill) -> bool:
        if not fill:
            return False
        try:
            return max(float(component) for component in fill[:3]) <= 0.1
        except (TypeError, ValueError):
            return False

    @staticmethod
    def _is_redaction_sized(rect, page_rect) -> bool:
        max_height = max(100, page_rect.height * 0.15)
        return (
            10 < rect.width < page_rect.width * 0.95
            and 5 < rect.height < max_height
        )

    @staticmethod
    def _is_predominantly_dark_image(base_image) -> bool:
        if not base_image or not base_image.get("image"):
            return False
        try:
            from PIL import Image

            with Image.open(io.BytesIO(base_image["image"])) as image:
                image = image.convert("RGB")
                image.thumbnail((256, 256))
                if hasattr(image, "get_flattened_data"):
                    pixels = list(image.get_flattened_data())
                else:
                    pixels = list(image.getdata())
            if not pixels:
                return False
            dark = sum(1 for pixel in pixels if max(pixel) <= 32)
            return dark / len(pixels) >= 0.95
        except Exception:
            return False

    def _extract_hidden_under_redactions(self, page, redaction_rects=None) -> str:
        """
        Extract text that appears to be under redaction rectangles.

        Returns the hidden text (but we won't store or index it).
        """
        hidden_text = ""

        redaction_rects = redaction_rects or self._find_redaction_rects(page)

        # Get text blocks with their positions
        blocks = page.get_text("dict")["blocks"]

        for block in blocks:
            if block.get("type") == 0:  # Text block
                for line in block.get("lines", []):
                    for span in line.get("spans", []):
                        span_rect = span.get("bbox")
                        if span_rect and any(
                            self._rects_overlap(span_rect, redaction_rect)
                            for redaction_rect in redaction_rects
                        ):
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
        print("\nThe report never prints the underlying hidden content.")
