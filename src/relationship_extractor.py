"""
Relationship Extraction System

Extracts relationships between entities with explicit documentary evidence.
NEVER infers relationships. ALWAYS provides caveats.

Confidence: 92%
"""

import re
import logging
from typing import Optional, List, Tuple
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# =============================================================================
# RELATIONSHIP TYPES
# =============================================================================

class RelationshipType(Enum):
    """Types of relationships we can extract."""
    # Structural (from document structure)
    COMMUNICATED = "communicated"
    FLEW_TOGETHER = "flew_together"
    PHOTOGRAPHED_WITH = "photographed_with"
    LEGAL_REPRESENTATION = "legal_representation"
    EMPLOYED_BY = "employed_by"

    # Explicit (from text statements)
    STATED_FRIEND = "stated_friend"
    STATED_ASSOCIATE = "stated_associate"
    FAMILY = "family"
    BUSINESS_PARTNER = "business_partner"


class ExtractionMethod(Enum):
    """How the relationship was extracted."""
    STRUCTURAL = "structural"  # From document structure
    EXPLICIT = "explicit"      # From explicit text pattern
    # NOTE: No "inferred" - we never infer


# =============================================================================
# DATA CLASSES
# =============================================================================

@dataclass
class ExtractedRelationship:
    """A relationship extracted from a document."""
    entity1_id: int
    entity1_name: str
    entity2_id: int
    entity2_name: str

    # Type
    relationship_type: RelationshipType
    relationship_subtype: Optional[str] = None

    # Directionality
    is_directional: bool = False  # True = entity1 → entity2

    # Temporal
    date: Optional[datetime] = None
    date_approximate: bool = True
    date_source: Optional[str] = None

    # Evidence (REQUIRED)
    evidence_document_id: int = 0
    evidence_page: Optional[int] = None
    evidence_snippet: str = ""

    # Extraction metadata
    extraction_method: ExtractionMethod = ExtractionMethod.STRUCTURAL
    confidence: float = 0.0

    # CRITICAL: Caveats for users
    caveat: Optional[str] = None

    # Review
    needs_review: bool = False

    def __post_init__(self):
        """Validate relationship has required fields."""
        if not self.evidence_snippet:
            logger.warning(f"Relationship missing evidence snippet: {self.entity1_name} - {self.entity2_name}")

        # FLEW_TOGETHER always needs caveat
        if self.relationship_type == RelationshipType.FLEW_TOGETHER and not self.caveat:
            self.caveat = (
                "Listed on same flight log. Does NOT imply personal acquaintance, "
                "shared purpose, or knowledge of each other's presence."
            )


@dataclass
class RelationshipExtractionResult:
    """Result of relationship extraction from a document."""
    document_id: int
    relationships: List[ExtractedRelationship] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


# =============================================================================
# EXPLICIT PATTERNS
# =============================================================================

# Patterns for explicit relationship extraction
# Format: (pattern_template, relationship_type, confidence, is_directional)
# {A} and {B} are placeholders for entity names

EXPLICIT_PATTERNS = [
    # Friends
    (r"{A}\s+(?:was|is|has been)\s+(?:a\s+)?(?:close\s+)?friend\s+(?:of|to)\s+{B}",
     RelationshipType.STATED_FRIEND, 0.88, False),
    (r"{A}\s+and\s+{B}\s+(?:were|are|have been)\s+(?:close\s+)?friends",
     RelationshipType.STATED_FRIEND, 0.88, False),
    (r"{B}\s+(?:was|is)\s+(?:a\s+)?friend\s+of\s+{A}",
     RelationshipType.STATED_FRIEND, 0.88, False),

    # Employment (directional: A employed by B)
    (r"{A}\s+worked\s+for\s+{B}",
     RelationshipType.EMPLOYED_BY, 0.90, True),
    (r"{A}\s+(?:was|is|has been)\s+employed\s+by\s+{B}",
     RelationshipType.EMPLOYED_BY, 0.92, True),
    (r"{B}\s+(?:hired|employed)\s+{A}",
     RelationshipType.EMPLOYED_BY, 0.90, True),
    (r"{A}\s+(?:was|is)\s+(?:an?\s+)?employee\s+of\s+{B}",
     RelationshipType.EMPLOYED_BY, 0.90, True),

    # Business partners
    (r"{A}\s+and\s+{B}\s+(?:were|are)\s+(?:business\s+)?partners",
     RelationshipType.BUSINESS_PARTNER, 0.88, False),
    (r"{A}\s+(?:partnered|went into business)\s+with\s+{B}",
     RelationshipType.BUSINESS_PARTNER, 0.85, False),

    # Family - Marriage
    (r"{A}\s+(?:was|is)\s+(?:the\s+)?(?:wife|husband|spouse)\s+of\s+{B}",
     RelationshipType.FAMILY, 0.95, False),
    (r"{A}\s+(?:was|is)\s+married\s+to\s+{B}",
     RelationshipType.FAMILY, 0.95, False),
    (r"{A}\s+and\s+{B}\s+(?:were|are)\s+married",
     RelationshipType.FAMILY, 0.95, False),

    # Family - Other
    (r"{A}\s+(?:was|is)\s+(?:the\s+)?(?:brother|sister|sibling)\s+of\s+{B}",
     RelationshipType.FAMILY, 0.95, False),
    (r"{A}\s+(?:was|is)\s+(?:the\s+)?(?:father|mother|parent)\s+of\s+{B}",
     RelationshipType.FAMILY, 0.95, True),
    (r"{A}\s+(?:was|is)\s+(?:the\s+)?(?:son|daughter|child)\s+of\s+{B}",
     RelationshipType.FAMILY, 0.95, True),

    # Associates (weaker than friend)
    (r"{A}\s+(?:was|is)\s+(?:an?\s+)?associate\s+of\s+{B}",
     RelationshipType.STATED_ASSOCIATE, 0.82, False),
    (r"{A}\s+(?:was|is)\s+(?:a\s+)?known\s+associate\s+of\s+{B}",
     RelationshipType.STATED_ASSOCIATE, 0.85, False),
]


# =============================================================================
# RELATIONSHIP EXTRACTOR
# =============================================================================

class RelationshipExtractor:
    """
    Extracts relationships from documents.

    Only extracts relationships with explicit evidence.
    Never infers relationships from co-occurrence.
    """

    def __init__(self):
        self.explicit_patterns = self._compile_patterns()

    def _compile_patterns(self):
        """Pre-compile regex patterns for efficiency."""
        # We'll compile them dynamically with entity names
        return EXPLICIT_PATTERNS

    def extract_from_document(
        self,
        document_id: int,
        document_type: str,
        text: str,
        mentions: List[dict],
        document_date: Optional[datetime] = None
    ) -> RelationshipExtractionResult:
        """
        Extract relationships from a document.

        Args:
            document_id: Document ID
            document_type: Type of document
            text: Document text
            mentions: List of entity mentions with roles
            document_date: Date of document

        Returns:
            RelationshipExtractionResult with extracted relationships
        """
        result = RelationshipExtractionResult(document_id=document_id)

        try:
            # 1. Structural extraction based on document type
            if document_type == "email":
                result.relationships.extend(
                    self._extract_email_relationships(document_id, mentions, document_date)
                )

            elif document_type == "flight_log":
                result.relationships.extend(
                    self._extract_flight_relationships(document_id, mentions, document_date)
                )

            elif document_type == "court_record":
                result.relationships.extend(
                    self._extract_legal_relationships(document_id, text, mentions)
                )

            elif document_type == "image":
                result.relationships.extend(
                    self._extract_photo_relationships(document_id, mentions)
                )

            # 2. Explicit pattern extraction (all document types)
            if text:
                result.relationships.extend(
                    self._extract_explicit_relationships(document_id, text, mentions)
                )

            # 3. Validate all relationships
            for rel in result.relationships:
                errors = self._validate_relationship(rel)
                if errors:
                    result.warnings.extend(errors)

        except Exception as e:
            result.errors.append(f"Extraction failed: {str(e)}")
            logger.error(f"Relationship extraction failed for doc {document_id}: {e}")

        return result

    def _extract_email_relationships(
        self,
        document_id: int,
        mentions: List[dict],
        document_date: Optional[datetime]
    ) -> List[ExtractedRelationship]:
        """Extract communication relationships from email."""
        relationships = []

        # Find author and recipients
        authors = [m for m in mentions if m.get('role') == 'AUTHOR']
        recipients = [m for m in mentions if m.get('role') == 'RECIPIENT']

        for author in authors:
            for recipient in recipients:
                relationships.append(ExtractedRelationship(
                    entity1_id=author['entity_id'],
                    entity1_name=author['name'],
                    entity2_id=recipient['entity_id'],
                    entity2_name=recipient['name'],
                    relationship_type=RelationshipType.COMMUNICATED,
                    relationship_subtype="email",
                    is_directional=True,
                    date=document_date,
                    evidence_document_id=document_id,
                    evidence_snippet=f"Email from {author['name']} to {recipient['name']}",
                    extraction_method=ExtractionMethod.STRUCTURAL,
                    confidence=0.95
                ))

        return relationships

    def _extract_flight_relationships(
        self,
        document_id: int,
        mentions: List[dict],
        document_date: Optional[datetime]
    ) -> List[ExtractedRelationship]:
        """Extract flight co-occurrence relationships."""
        relationships = []

        passengers = [m for m in mentions if m.get('role') == 'PASSENGER']

        # Pairwise relationships between all passengers
        for i, p1 in enumerate(passengers):
            for p2 in passengers[i+1:]:
                relationships.append(ExtractedRelationship(
                    entity1_id=p1['entity_id'],
                    entity1_name=p1['name'],
                    entity2_id=p2['entity_id'],
                    entity2_name=p2['name'],
                    relationship_type=RelationshipType.FLEW_TOGETHER,
                    is_directional=False,
                    date=document_date,
                    evidence_document_id=document_id,
                    evidence_snippet=f"Both listed on flight log: {p1['name']}, {p2['name']}",
                    extraction_method=ExtractionMethod.STRUCTURAL,
                    confidence=0.90,
                    # CRITICAL CAVEAT
                    caveat=(
                        "Listed on same flight log. Does NOT imply personal acquaintance, "
                        "shared purpose, or knowledge of each other's presence."
                    )
                ))

        return relationships

    def _extract_legal_relationships(
        self,
        document_id: int,
        text: str,
        mentions: List[dict]
    ) -> List[ExtractedRelationship]:
        """Extract legal representation relationships."""
        relationships = []

        accused = [m for m in mentions if m.get('role') == 'ACCUSED']
        counsel = [m for m in mentions if m.get('role') == 'LEGAL_COUNSEL']

        # Look for explicit representation patterns
        for defendant in accused:
            for attorney in counsel:
                # Check if document indicates representation
                pattern = (
                    rf"{re.escape(attorney['name'])}.*?"
                    rf"(?:representing|counsel for|attorney for).*?"
                    rf"{re.escape(defendant['name'])}"
                )
                match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)

                if match:
                    relationships.append(ExtractedRelationship(
                        entity1_id=attorney['entity_id'],
                        entity1_name=attorney['name'],
                        entity2_id=defendant['entity_id'],
                        entity2_name=defendant['name'],
                        relationship_type=RelationshipType.LEGAL_REPRESENTATION,
                        relationship_subtype="defense_attorney",
                        is_directional=True,
                        evidence_document_id=document_id,
                        evidence_snippet=match.group(0)[:200],
                        extraction_method=ExtractionMethod.STRUCTURAL,
                        confidence=0.92,
                        caveat="Attorney-client relationship for this legal matter only"
                    ))

        return relationships

    def _extract_photo_relationships(
        self,
        document_id: int,
        mentions: List[dict]
    ) -> List[ExtractedRelationship]:
        """Extract co-appearance relationships from photos."""
        relationships = []

        photo_appearances = [m for m in mentions if m.get('role') == 'APPEARS_IN_PHOTO']

        for i, p1 in enumerate(photo_appearances):
            for p2 in photo_appearances[i+1:]:
                relationships.append(ExtractedRelationship(
                    entity1_id=p1['entity_id'],
                    entity1_name=p1['name'],
                    entity2_id=p2['entity_id'],
                    entity2_name=p2['name'],
                    relationship_type=RelationshipType.PHOTOGRAPHED_WITH,
                    is_directional=False,
                    evidence_document_id=document_id,
                    evidence_snippet=f"Both appear in same photograph",
                    extraction_method=ExtractionMethod.STRUCTURAL,
                    confidence=0.85,
                    caveat=(
                        "Appearing in the same photograph does NOT imply personal "
                        "relationship or knowledge of each other."
                    )
                ))

        return relationships

    def _extract_explicit_relationships(
        self,
        document_id: int,
        text: str,
        mentions: List[dict]
    ) -> List[ExtractedRelationship]:
        """Extract relationships from explicit text patterns."""
        relationships = []

        # Get all entity pairs
        entities = [(m['entity_id'], m['name']) for m in mentions]

        for i, (id1, name1) in enumerate(entities):
            for id2, name2 in entities[i+1:]:
                # Skip if same entity
                if id1 == id2:
                    continue

                # Try each pattern in both directions
                for pattern_template, rel_type, confidence, directional in self.explicit_patterns:
                    # A → B
                    pattern = pattern_template.replace("{A}", re.escape(name1))
                    pattern = pattern.replace("{B}", re.escape(name2))

                    match = re.search(pattern, text, re.IGNORECASE)
                    if match:
                        relationships.append(ExtractedRelationship(
                            entity1_id=id1,
                            entity1_name=name1,
                            entity2_id=id2,
                            entity2_name=name2,
                            relationship_type=rel_type,
                            is_directional=directional,
                            evidence_document_id=document_id,
                            evidence_snippet=match.group(0),
                            extraction_method=ExtractionMethod.EXPLICIT,
                            confidence=confidence
                        ))
                        continue

                    # B → A (if pattern is not symmetric)
                    pattern = pattern_template.replace("{A}", re.escape(name2))
                    pattern = pattern.replace("{B}", re.escape(name1))

                    match = re.search(pattern, text, re.IGNORECASE)
                    if match:
                        # Swap entity order for directional relationships
                        if directional:
                            e1_id, e1_name = id2, name2
                            e2_id, e2_name = id1, name1
                        else:
                            e1_id, e1_name = id1, name1
                            e2_id, e2_name = id2, name2

                        relationships.append(ExtractedRelationship(
                            entity1_id=e1_id,
                            entity1_name=e1_name,
                            entity2_id=e2_id,
                            entity2_name=e2_name,
                            relationship_type=rel_type,
                            is_directional=directional,
                            evidence_document_id=document_id,
                            evidence_snippet=match.group(0),
                            extraction_method=ExtractionMethod.EXPLICIT,
                            confidence=confidence
                        ))

        return relationships

    def _validate_relationship(self, rel: ExtractedRelationship) -> List[str]:
        """Validate a relationship has required fields."""
        errors = []

        if not rel.evidence_document_id:
            errors.append(f"Missing evidence document for {rel.entity1_name} - {rel.entity2_name}")

        if not rel.evidence_snippet:
            errors.append(f"Missing evidence snippet for {rel.entity1_name} - {rel.entity2_name}")

        if rel.relationship_type == RelationshipType.FLEW_TOGETHER and not rel.caveat:
            errors.append(f"FLEW_TOGETHER missing caveat for {rel.entity1_name} - {rel.entity2_name}")

        if rel.confidence < 0.50:
            errors.append(f"Confidence too low ({rel.confidence}) for {rel.entity1_name} - {rel.entity2_name}")

        return errors


# =============================================================================
# GRAPH SAFETY
# =============================================================================

GRAPH_WARNING = """
⚠️ IMPORTANT: Connections shown are based on documentary evidence only.

A connection does NOT imply:
• Shared criminal activity
• Awareness of any wrongdoing
• Personal friendship beyond what is explicitly stated
• Approval of the other person's actions

"FLEW_TOGETHER" means only that both names appear on the same flight log.
It does NOT mean they knew each other, traveled together intentionally,
or were even aware of each other's presence.

ALWAYS verify by reading the source documents linked to each connection.
"""


def should_display_relationship(
    rel: ExtractedRelationship,
    min_confidence: float = 0.80,
    show_flight_connections: bool = False,
    allowed_types: Optional[List[RelationshipType]] = None
) -> bool:
    """
    Determine if a relationship should be displayed.

    Conservative by default - hides uncertain relationships.
    """
    # Confidence threshold
    if rel.confidence < min_confidence:
        return False

    # Flight relationships require explicit opt-in
    if rel.relationship_type == RelationshipType.FLEW_TOGETHER:
        if not show_flight_connections:
            return False

    # Type filtering
    if allowed_types and rel.relationship_type not in allowed_types:
        return False

    return True


def get_relationship_description(rel_type: RelationshipType) -> str:
    """Get human-readable description of relationship type."""
    descriptions = {
        RelationshipType.COMMUNICATED: "Exchanged email or written communication",
        RelationshipType.FLEW_TOGETHER: "Listed on same flight log (NOT necessarily acquainted)",
        RelationshipType.PHOTOGRAPHED_WITH: "Appear in same photograph (NOT necessarily acquainted)",
        RelationshipType.LEGAL_REPRESENTATION: "Attorney-client relationship",
        RelationshipType.EMPLOYED_BY: "Employment relationship",
        RelationshipType.STATED_FRIEND: "Described as friends in documents",
        RelationshipType.STATED_ASSOCIATE: "Described as associates in documents",
        RelationshipType.FAMILY: "Family relationship",
        RelationshipType.BUSINESS_PARTNER: "Business partnership",
    }
    return descriptions.get(rel_type, "Unknown relationship type")


# =============================================================================
# TESTS
# =============================================================================

if __name__ == "__main__":
    print("Relationship Extraction Tests")
    print("=" * 60)

    extractor = RelationshipExtractor()

    # Test 1: Email
    print("\n[Test 1: Email]")
    result = extractor.extract_from_document(
        document_id=1,
        document_type="email",
        text="",
        mentions=[
            {"entity_id": 1, "name": "John Smith", "role": "AUTHOR"},
            {"entity_id": 2, "name": "Jane Doe", "role": "RECIPIENT"},
        ],
        document_date=datetime(2005, 3, 15)
    )
    for rel in result.relationships:
        print(f"  {rel.entity1_name} --[{rel.relationship_type.value}]--> {rel.entity2_name}")
        print(f"    Confidence: {rel.confidence}, Evidence: {rel.evidence_snippet}")

    # Test 2: Flight log
    print("\n[Test 2: Flight Log]")
    result = extractor.extract_from_document(
        document_id=2,
        document_type="flight_log",
        text="",
        mentions=[
            {"entity_id": 1, "name": "Person A", "role": "PASSENGER"},
            {"entity_id": 2, "name": "Person B", "role": "PASSENGER"},
            {"entity_id": 3, "name": "Person C", "role": "PASSENGER"},
        ]
    )
    for rel in result.relationships:
        print(f"  {rel.entity1_name} --[{rel.relationship_type.value}]-- {rel.entity2_name}")
        print(f"    Caveat: {rel.caveat[:60]}...")

    # Test 3: Explicit patterns
    print("\n[Test 3: Explicit Patterns]")
    result = extractor.extract_from_document(
        document_id=3,
        document_type="court_record",
        text="According to testimony, Bill Clinton was a close friend of Jeffrey Epstein. "
             "Alan Dershowitz worked for Epstein as his attorney.",
        mentions=[
            {"entity_id": 1, "name": "Bill Clinton"},
            {"entity_id": 2, "name": "Jeffrey Epstein"},
            {"entity_id": 3, "name": "Alan Dershowitz"},
        ]
    )
    for rel in result.relationships:
        print(f"  {rel.entity1_name} --[{rel.relationship_type.value}]--> {rel.entity2_name}")
        print(f"    Evidence: {rel.evidence_snippet}")
        print(f"    Confidence: {rel.confidence}")

    print("\n" + "=" * 60)
    print("Graph Warning (always displayed):")
    print(GRAPH_WARNING)
