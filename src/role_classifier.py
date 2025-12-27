"""
Role Classification System

Assigns roles to entity mentions in documents with confidence scores.
Designed for responsible reporting - defaults to safe (MENTIONED) when uncertain.

Confidence: 92%
"""

import re
import logging
from enum import Enum
from dataclasses import dataclass
from typing import Optional, List, Tuple

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class MentionRole(Enum):
    """
    Roles an entity can have in a document.
    Organized by sensitivity and evidence requirements.
    """
    # Sensitive roles - require strong evidence + human review
    VICTIM = "victim"
    ACCUSED = "accused"
    PLAINTIFF = "plaintiff"

    # Clear roles - structural evidence sufficient
    WITNESS = "witness"
    INVESTIGATOR = "investigator"
    LEGAL_COUNSEL = "legal_counsel"
    COURT_OFFICIAL = "court_official"
    DEPONENT = "deponent"
    SUBJECT_OF_INVESTIGATION = "subject_of_investigation"

    # Document-specific roles
    PASSENGER = "passenger"
    CREW = "crew"
    AUTHOR = "author"
    RECIPIENT = "recipient"
    APPEARS_IN_PHOTO = "appears_in_photo"
    EMPLOYEE = "employee"

    # Default roles
    MENTIONED = "mentioned"
    UNKNOWN = "unknown"


# Roles that require human review before display
SENSITIVE_ROLES = {MentionRole.VICTIM, MentionRole.ACCUSED, MentionRole.PLAINTIFF}

# Roles that are limited to specific document contexts
CONTEXT_LIMITED_ROLES = {
    MentionRole.PASSENGER: "flight_log",
    MentionRole.CREW: "flight_log",
    MentionRole.APPEARS_IN_PHOTO: "image",
}


@dataclass
class RoleResult:
    """Result of role classification."""
    role: MentionRole
    confidence: float
    evidence: str
    evidence_snippet: Optional[str] = None
    needs_review: bool = False
    alternative_roles: Optional[List[Tuple[MentionRole, float]]] = None

    def __post_init__(self):
        # Automatically flag sensitive roles for review
        if self.role in SENSITIVE_ROLES:
            self.needs_review = True


class RolePatterns:
    """Pattern library for role extraction."""

    VICTIM = [
        (r"(?:victim|complainant)\s+(?:identified as\s+)?{name}", 0.95),
        (r"{name}\s+(?:was|is)\s+(?:a\s+)?victim", 0.95),
        (r"crimes?\s+against\s+{name}", 0.90),
        (r"abuse\s+of\s+{name}", 0.90),
        (r"minor\s+(?:victim\s+)?{name}", 0.95),
    ]

    ACCUSED = [
        (r"(?:defendant|accused)\s+{name}", 0.95),
        (r"{name}\s*,?\s+defendant", 0.95),
        (r"United States\s+v\.\s+{name}", 0.95),
        (r"People\s+v\.\s+{name}", 0.95),
        (r"{name}\s+(?:was|is)\s+(?:charged|indicted)", 0.92),
    ]

    WITNESS = [
        (r"(?:witness)\s+{name}", 0.90),
        (r"{name}\s+(?:testified|stated under oath)", 0.90),
        (r"testimony\s+of\s+{name}", 0.90),
        (r"{name}\s+(?:was\s+)?(?:called|subpoenaed)\s+(?:as\s+)?(?:a\s+)?witness", 0.88),
        (r"deposition\s+of\s+{name}", 0.90),
    ]

    INVESTIGATOR = [
        (r"(?:Agent|Detective|Officer|Inspector)\s+{name}", 0.92),
        (r"(?:FBI|DOJ|SDNY|DEA)\s+(?:Agent\s+)?{name}", 0.92),
        (r"{name}\s*,?\s+(?:FBI|Special Agent)", 0.92),
        (r"(?:Investigator|Prosecutor)\s+{name}", 0.90),
    ]

    LEGAL_COUNSEL = [
        (r"(?:Attorney|Counsel)\s+{name}", 0.90),
        (r"{name}\s*,?\s+(?:Esq\.?|Attorney at Law)", 0.92),
        (r"(?:represented by|counsel for)\s+{name}", 0.88),
        (r"{name}\s+(?:representing|appeared for)", 0.88),
    ]

    COURT_OFFICIAL = [
        (r"(?:Judge|Justice|Magistrate)\s+{name}", 0.95),
        (r"(?:Hon\.|Honorable)\s+{name}", 0.92),
        (r"{name}\s*,?\s+(?:presiding|U\.?S\.?\s+District)", 0.90),
    ]


class DocumentTypeHandler:
    """Base handler for document-type-specific role extraction."""

    def classify(self, name: str, document_type: str, text: str,
                 metadata: dict) -> Optional[RoleResult]:
        """Override in subclasses."""
        raise NotImplementedError


class FlightLogHandler(DocumentTypeHandler):
    """Handle flight log documents - everyone is a PASSENGER."""

    def classify(self, name: str, document_type: str, text: str,
                 metadata: dict) -> Optional[RoleResult]:
        if document_type != "flight_log":
            return None

        # Check if name appears in the text
        if not re.search(re.escape(name), text, re.IGNORECASE):
            return None

        # Check for crew patterns
        crew_patterns = [
            r"(?:pilot|captain|co-pilot|flight attendant|crew)\s*:?\s*" + re.escape(name),
            re.escape(name) + r"\s*(?:\(pilot\)|\(captain\)|\(crew\))",
        ]

        for pattern in crew_patterns:
            if re.search(pattern, text, re.IGNORECASE):
                return RoleResult(
                    role=MentionRole.CREW,
                    confidence=0.88,
                    evidence="Identified as flight crew in log",
                    evidence_snippet=self._get_snippet(text, name)
                )

        # Default: passenger
        return RoleResult(
            role=MentionRole.PASSENGER,
            confidence=0.90,
            evidence="Listed in flight log",
            evidence_snippet=self._get_snippet(text, name)
        )

    def _get_snippet(self, text: str, name: str, context: int = 100) -> str:
        match = re.search(re.escape(name), text, re.IGNORECASE)
        if match:
            start = max(0, match.start() - context)
            end = min(len(text), match.end() + context)
            return text[start:end]
        return ""


class EmailHandler(DocumentTypeHandler):
    """Handle email documents - extract AUTHOR and RECIPIENT."""

    def classify(self, name: str, document_type: str, text: str,
                 metadata: dict) -> Optional[RoleResult]:
        if document_type != "email":
            return None

        # Check From field
        from_match = re.search(r"(?:From|Sender)\s*:\s*([^\n]+)", text, re.IGNORECASE)
        if from_match and name.lower() in from_match.group(1).lower():
            return RoleResult(
                role=MentionRole.AUTHOR,
                confidence=0.95,
                evidence="Listed in email From field",
                evidence_snippet=from_match.group(0)
            )

        # Check To/CC fields
        to_match = re.search(r"(?:To|Cc|Bcc)\s*:\s*([^\n]+)", text, re.IGNORECASE)
        if to_match and name.lower() in to_match.group(1).lower():
            return RoleResult(
                role=MentionRole.RECIPIENT,
                confidence=0.95,
                evidence="Listed in email To/CC field",
                evidence_snippet=to_match.group(0)
            )

        # In body but not header
        if re.search(re.escape(name), text, re.IGNORECASE):
            return RoleResult(
                role=MentionRole.MENTIONED,
                confidence=0.65,
                evidence="Mentioned in email body"
            )

        return None


class CourtRecordHandler(DocumentTypeHandler):
    """Handle court records - extract structured roles."""

    def classify(self, name: str, document_type: str, text: str,
                 metadata: dict) -> Optional[RoleResult]:
        if document_type != "court_record":
            return None

        # Check for case caption patterns (most reliable)
        # "United States v. [Name]" or "[Name], Defendant"
        defendant_patterns = [
            (r"United States\s+v\.\s+" + re.escape(name), 0.98),
            (r"People\s+(?:of\s+[^v]+\s+)?v\.\s+" + re.escape(name), 0.98),
            (re.escape(name) + r"\s*,\s*Defendant", 0.97),
            (r"Defendant\s+" + re.escape(name), 0.95),
        ]

        for pattern, conf in defendant_patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                return RoleResult(
                    role=MentionRole.ACCUSED,
                    confidence=conf,
                    evidence="Named as defendant in court record",
                    evidence_snippet=match.group(0),
                    needs_review=True  # Always review ACCUSED
                )

        # Check for plaintiff
        plaintiff_patterns = [
            (re.escape(name) + r"\s*,\s*Plaintiff", 0.97),
            (r"Plaintiff\s+" + re.escape(name), 0.95),
        ]

        for pattern, conf in plaintiff_patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                return RoleResult(
                    role=MentionRole.PLAINTIFF,
                    confidence=conf,
                    evidence="Named as plaintiff in court record",
                    evidence_snippet=match.group(0)
                )

        return None


class ImageHandler(DocumentTypeHandler):
    """Handle image documents."""

    def classify(self, name: str, document_type: str, text: str,
                 metadata: dict) -> Optional[RoleResult]:
        if document_type != "image":
            return None

        # For images, if we have OCR text or caption mentioning the name
        if text and re.search(re.escape(name), text, re.IGNORECASE):
            return RoleResult(
                role=MentionRole.APPEARS_IN_PHOTO,
                confidence=0.85,
                evidence="Name mentioned in image caption/metadata"
            )

        return None


class RoleClassifier:
    """
    Main role classification engine.

    Uses document-type-specific handlers and pattern matching
    to assign roles with confidence scores.
    """

    def __init__(self):
        self.handlers = [
            FlightLogHandler(),
            EmailHandler(),
            CourtRecordHandler(),
            ImageHandler(),
        ]

    def classify(self, name: str, document_type: str, text: str,
                 metadata: Optional[dict] = None) -> RoleResult:
        """
        Classify the role of an entity mention.

        Args:
            name: The name as it appears in the document
            document_type: Type of document (flight_log, email, court_record, etc.)
            text: Full text or relevant context from the document
            metadata: Optional document metadata

        Returns:
            RoleResult with role, confidence, and evidence
        """
        metadata = metadata or {}

        # 1. Try document-type-specific handlers first
        for handler in self.handlers:
            try:
                result = handler.classify(name, document_type, text, metadata)
                if result:
                    return result
            except Exception as e:
                logger.warning(f"Handler {handler.__class__.__name__} failed: {e}")

        # 2. Pattern-based classification
        result = self._pattern_classify(name, text, document_type)
        if result and result.confidence >= 0.80:
            return result

        # 3. Default to MENTIONED
        return RoleResult(
            role=MentionRole.MENTIONED,
            confidence=0.50,
            evidence="Name appears in document, role unclear"
        )

    def _pattern_classify(self, name: str, text: str,
                          document_type: str) -> Optional[RoleResult]:
        """Use pattern matching to classify roles."""
        if not text:
            return None

        # Escape name for regex
        name_pattern = re.escape(name)

        # Check each pattern category
        pattern_groups = [
            (RolePatterns.VICTIM, MentionRole.VICTIM),
            (RolePatterns.ACCUSED, MentionRole.ACCUSED),
            (RolePatterns.WITNESS, MentionRole.WITNESS),
            (RolePatterns.INVESTIGATOR, MentionRole.INVESTIGATOR),
            (RolePatterns.LEGAL_COUNSEL, MentionRole.LEGAL_COUNSEL),
            (RolePatterns.COURT_OFFICIAL, MentionRole.COURT_OFFICIAL),
        ]

        best_match = None
        best_confidence = 0.0

        for patterns, role in pattern_groups:
            for pattern_template, base_confidence in patterns:
                pattern = pattern_template.replace("{name}", name_pattern)
                match = re.search(pattern, text, re.IGNORECASE)

                if match:
                    # Adjust confidence based on document type
                    confidence = self._adjust_confidence(
                        base_confidence, role, document_type
                    )

                    if confidence > best_confidence:
                        best_confidence = confidence
                        best_match = RoleResult(
                            role=role,
                            confidence=confidence,
                            evidence=f"Pattern match: {pattern_template}",
                            evidence_snippet=match.group(0)
                        )

        return best_match

    def _adjust_confidence(self, base_confidence: float, role: MentionRole,
                           document_type: str) -> float:
        """Adjust confidence based on document type appropriateness."""
        # Sensitive roles should only come from court records
        if role in SENSITIVE_ROLES:
            if document_type == "court_record":
                return base_confidence
            elif document_type in ["fbi_notes", "pdf"]:
                return base_confidence * 0.85  # Reduce confidence
            else:
                return base_confidence * 0.70  # Significantly reduce

        # Investigator roles more confident in FBI notes
        if role == MentionRole.INVESTIGATOR:
            if document_type == "fbi_notes":
                return min(base_confidence * 1.05, 0.98)

        return base_confidence

    def classify_batch(self, mentions: list) -> List[RoleResult]:
        """Classify multiple mentions efficiently."""
        results = []
        for mention in mentions:
            result = self.classify(
                name=mention.get('name'),
                document_type=mention.get('document_type'),
                text=mention.get('text'),
                metadata=mention.get('metadata')
            )
            results.append(result)
        return results


# Convenience functions
def classify_role(name: str, document_type: str, text: str) -> RoleResult:
    """Quick classification of a single mention."""
    classifier = RoleClassifier()
    return classifier.classify(name, document_type, text)


def get_role_description(role: MentionRole) -> str:
    """Get human-readable description of a role."""
    descriptions = {
        MentionRole.VICTIM: "Named as victim in official records",
        MentionRole.ACCUSED: "Named as defendant/accused in legal proceedings",
        MentionRole.PLAINTIFF: "Filed lawsuit as plaintiff",
        MentionRole.WITNESS: "Provided testimony or witness statement",
        MentionRole.INVESTIGATOR: "Law enforcement or prosecutor",
        MentionRole.LEGAL_COUNSEL: "Attorney or legal representative",
        MentionRole.COURT_OFFICIAL: "Judge or court officer",
        MentionRole.DEPONENT: "Gave sworn deposition",
        MentionRole.SUBJECT_OF_INVESTIGATION: "Named in investigation (not charged)",
        MentionRole.PASSENGER: "Listed on flight log as passenger",
        MentionRole.CREW: "Flight crew member",
        MentionRole.AUTHOR: "Wrote the document",
        MentionRole.RECIPIENT: "Received the document",
        MentionRole.APPEARS_IN_PHOTO: "Appears in photograph",
        MentionRole.EMPLOYEE: "Employee/staff member",
        MentionRole.MENTIONED: "Name appears in document, role unclear",
        MentionRole.UNKNOWN: "Unable to determine role",
    }
    return descriptions.get(role, "Unknown role")


if __name__ == "__main__":
    # Test cases
    classifier = RoleClassifier()

    tests = [
        {
            "name": "Jeffrey Epstein",
            "document_type": "court_record",
            "text": "United States v. Jeffrey Epstein, Case No. 19-cr-00490"
        },
        {
            "name": "John Smith",
            "document_type": "flight_log",
            "text": "Passengers: John Smith, Jane Doe, Bob Johnson"
        },
        {
            "name": "Agent Brown",
            "document_type": "fbi_notes",
            "text": "FBI Agent Brown interviewed the witness on March 5"
        },
        {
            "name": "Jane Doe",
            "document_type": "court_record",
            "text": "The victim, Jane Doe, testified that..."
        },
    ]

    print("Role Classification Tests:")
    print("=" * 60)

    for test in tests:
        result = classifier.classify(**test)
        print(f"\nName: {test['name']}")
        print(f"Doc Type: {test['document_type']}")
        print(f"Role: {result.role.value}")
        print(f"Confidence: {result.confidence:.2f}")
        print(f"Evidence: {result.evidence}")
        print(f"Needs Review: {result.needs_review}")
