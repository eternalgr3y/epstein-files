# Relationship Extraction Design Document

## Initial Confidence: 65%
## Target Confidence: 90%+

---

## Problem Statement

What relationships exist between Entity A and Entity B?
- Did they meet?
- Did they work together?
- Did they fly together?
- What's the evidence?

### Core Danger
**INFERENCE IMPLIES GUILT BY ASSOCIATION**

If we show "A is connected to B" and B is a perpetrator, users may assume
A is also guilty. This is fundamentally dangerous.

### Error Consequences
| Error Type | Impact |
|------------|--------|
| False relationship | Creates false implications - SEVERE |
| Over-inference | Implies guilt by association - SEVERE |
| Missed relationship | Incomplete picture - MODERATE |

**Principle**: ONLY extract relationships with explicit documentary evidence.
NEVER infer. ALWAYS caveat.

---

## Iteration 1: Initial Analysis (65%)

### Why 65%?
- Relationship extraction typically involves inference
- "A and B mentioned in same doc" ≠ relationship
- Graph visualization is inherently dangerous
- Easy to mislead users

### The Problem with Co-occurrence
Document mentions: "Bill Clinton and Donald Trump attended the party"

Naive approach: A --attended_with--> B

Reality: They may have been at same event but:
- Never spoke
- Didn't know each other was there
- Were there at different times

**Co-occurrence is NOT a relationship.**

---

## Iteration 2: Evidence-Only Approach (75%)

### Key Insight
Only extract relationships that are:
1. **EXPLICITLY stated** in text
2. **STRUCTURAL** (email sender → recipient)

Never extract relationships from:
- Co-occurrence
- Inference
- "Common sense"

### Relationship Tiers

**Tier 1: Structural (High Confidence)**
- Email: AUTHOR → RECIPIENT
- Flight log: FLEW_TOGETHER (all passengers)
- Legal: ATTORNEY → CLIENT

**Tier 2: Explicit (High Confidence)**
- Text states: "A worked for B" → EMPLOYED
- Text states: "A is friend of B" → STATED_FRIEND
- Text states: "A is married to B" → FAMILY

**Tier 3: Inferred (NOT ALLOWED)**
- "A and B at same party" → NO RELATIONSHIP
- "A knows people who know B" → NO RELATIONSHIP

---

## Iteration 3: Relationship Type Taxonomy (82%)

### Relationship Types

```
STRUCTURAL (from document structure)
├── COMMUNICATED        - Email/letter exchange (directional)
├── FLEW_TOGETHER       - Same flight log entry (undirected)
├── PHOTOGRAPHED_WITH   - Same photograph (undirected)
├── LEGAL_REPRESENTATION - Attorney-client (directional)
├── EMPLOYED_BY         - Employment (directional)

EXPLICIT (from text statements)
├── STATED_FRIEND       - Document explicitly says "friend"
├── STATED_ASSOCIATE    - Document explicitly says "associate"
├── FAMILY             - Document states family relationship
├── BUSINESS_PARTNER   - Document states business relationship

META-RELATIONSHIPS (not person-person)
├── MENTIONED_IN_SAME_DOCUMENT - Both appear in same doc
```

### Relationship Properties

```python
@dataclass
class Relationship:
    entity1_id: int
    entity2_id: int

    # Type
    relationship_type: str
    relationship_subtype: Optional[str]  # e.g., "defense_attorney"

    # Directionality
    is_directional: bool  # email: True, flight: False

    # Temporal
    date: Optional[datetime]
    date_approximate: bool
    start_date: Optional[datetime]
    end_date: Optional[datetime]

    # EVIDENCE (REQUIRED)
    evidence_document_id: int
    evidence_page: Optional[int]
    evidence_snippet: str  # Exact text that supports this

    # Confidence
    extraction_method: str  # "structural" or "explicit"
    confidence: float

    # CRITICAL: Caveat for users
    caveat: Optional[str]  # e.g., "Same flight, not necessarily acquainted"
```

---

## Iteration 4: Extraction Rules (86%)

### Rule 1: Email Communication

```python
def extract_email_relationships(document, mentions):
    if document.type != "email":
        return []

    relationships = []
    author = get_author_mention(mentions)
    recipients = get_recipient_mentions(mentions)

    for recipient in recipients:
        relationships.append(Relationship(
            entity1_id=author.entity_id,
            entity2_id=recipient.entity_id,
            relationship_type="COMMUNICATED",
            relationship_subtype="email",
            is_directional=True,
            date=document.date,
            evidence_document_id=document.id,
            evidence_snippet=f"Email from {author.name} to {recipient.name}",
            extraction_method="structural",
            confidence=0.95,
            caveat=None  # Email communication is clear
        ))

    return relationships
```

### Rule 2: Flight Logs

```python
def extract_flight_relationships(document, mentions):
    if document.type != "flight_log":
        return []

    relationships = []
    passengers = [m for m in mentions if m.role == "PASSENGER"]
    date = extract_flight_date(document)

    for i, p1 in enumerate(passengers):
        for p2 in passengers[i+1:]:
            relationships.append(Relationship(
                entity1_id=p1.entity_id,
                entity2_id=p2.entity_id,
                relationship_type="FLEW_TOGETHER",
                is_directional=False,
                date=date,
                evidence_document_id=document.id,
                evidence_snippet=f"Both listed on flight log",
                extraction_method="structural",
                confidence=0.90,
                # CRITICAL CAVEAT
                caveat="Listed on same flight log. Does NOT imply personal acquaintance, shared purpose, or knowledge of each other's presence."
            ))

    return relationships
```

### Rule 3: Legal Representation

```python
def extract_legal_relationships(document, mentions):
    if document.type != "court_record":
        return []

    relationships = []

    defendants = [m for m in mentions if m.role == "ACCUSED"]
    defense_attorneys = [m for m in mentions if m.role == "LEGAL_COUNSEL"]

    # Match attorneys to defendants (requires parsing)
    for defendant in defendants:
        for attorney in defense_attorneys:
            # Only if document indicates representation
            if indicates_representation(document.text, defendant, attorney):
                relationships.append(Relationship(
                    entity1_id=attorney.entity_id,
                    entity2_id=defendant.entity_id,
                    relationship_type="LEGAL_REPRESENTATION",
                    relationship_subtype="defense_attorney",
                    is_directional=True,
                    evidence_document_id=document.id,
                    evidence_snippet=get_representation_evidence(document.text),
                    extraction_method="structural",
                    confidence=0.92,
                    caveat="Attorney-client relationship for this legal matter only"
                ))

    return relationships
```

### Rule 4: Explicit Text Patterns

```python
EXPLICIT_PATTERNS = [
    # Friends
    (r"{A}\s+(?:was|is)\s+(?:a\s+)?(?:close\s+)?friend\s+of\s+{B}",
     "STATED_FRIEND", 0.88),
    (r"{A}\s+and\s+{B}\s+(?:were|are)\s+friends",
     "STATED_FRIEND", 0.88),

    # Employment
    (r"{A}\s+worked\s+for\s+{B}",
     "EMPLOYED_BY", 0.90),
    (r"{A}\s+(?:was|is)\s+employed\s+by\s+{B}",
     "EMPLOYED_BY", 0.92),
    (r"{B}\s+(?:hired|employed)\s+{A}",
     "EMPLOYED_BY", 0.90),

    # Business
    (r"{A}\s+and\s+{B}\s+(?:were|are)\s+(?:business\s+)?partners",
     "BUSINESS_PARTNER", 0.88),

    # Family
    (r"{A}\s+(?:was|is)\s+(?:the\s+)?(?:wife|husband|spouse)\s+of\s+{B}",
     "FAMILY", 0.95),
    (r"{A}\s+(?:was|is)\s+married\s+to\s+{B}",
     "FAMILY", 0.95),
]
```

---

## Iteration 5: Graph Visualization Safety (90%)

### The Danger of Graphs

A relationship graph showing connections can:
1. Imply guilt by association
2. Suggest conspiracy without evidence
3. Be misinterpreted by users
4. Go viral with wrong conclusions

### Safety Measures

**1. No Default Graph View**
- Graphs are opt-in, not default
- Users must acknowledge warning first

**2. Relationship Type Filtering**
- Default: Only show EXPLICIT relationships
- Flight connections hidden by default
- "Co-occurrence" never shown as edges

**3. Prominent Caveats**
Every graph displays:
```
⚠️ IMPORTANT: Connections shown are based on documentary evidence.
A connection does NOT imply:
- Shared criminal activity
- Awareness of wrongdoing
- Personal friendship
- Approval of actions

FLEW_TOGETHER means listed on same flight log only.
Always verify by reading source documents.
```

**4. Confidence Thresholds**
- Only display relationships with confidence >= 0.85
- Lower confidence relationships in separate "uncertain" view

**5. Edge Labels are Mandatory**
Every edge MUST show:
- Relationship type
- Date (if known)
- "View evidence" link

### Graph Display Rules

```python
def should_display_relationship(rel, display_settings):
    # Never display inferred relationships
    if rel.extraction_method == "inferred":
        return False

    # Confidence threshold
    if rel.confidence < display_settings.min_confidence:
        return False

    # Type filtering
    if rel.relationship_type not in display_settings.allowed_types:
        return False

    # Flight relationships require explicit opt-in
    if rel.relationship_type == "FLEW_TOGETHER":
        if not display_settings.show_flight_connections:
            return False

    return True
```

---

## Iteration 6: Validation & Quality (92%)

### Extraction Quality Metrics

| Metric | Target |
|--------|--------|
| Precision (structural) | >= 98% |
| Precision (explicit) | >= 92% |
| Evidence link validity | 100% |
| Caveat presence | 100% for FLEW_TOGETHER |

### Validation Process

1. **Random audit**: Sample 100 relationships, verify against source
2. **Evidence check**: Every relationship has valid document link
3. **Pattern review**: Check explicit patterns for false positives
4. **User feedback**: Flag system for incorrect relationships

### Quality Enforcement

```python
def validate_relationship(rel):
    errors = []

    # Must have evidence
    if not rel.evidence_document_id:
        errors.append("Missing evidence document")
    if not rel.evidence_snippet:
        errors.append("Missing evidence snippet")

    # Flight relationships must have caveat
    if rel.relationship_type == "FLEW_TOGETHER" and not rel.caveat:
        errors.append("FLEW_TOGETHER requires caveat")

    # Confidence must be reasonable
    if rel.confidence > 0.98:
        errors.append("Suspiciously high confidence")
    if rel.confidence < 0.50:
        errors.append("Confidence too low to store")

    return errors
```

---

## Final Design: 92% Confidence

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  RELATIONSHIP EXTRACTION                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Document Type Check                                         │
│     └─> Route to appropriate extractor                          │
│                                                                 │
│  2. Structural Extraction                                       │
│     ├─> Email: AUTHOR → RECIPIENT                               │
│     ├─> Flight: PASSENGER ↔ PASSENGER (with caveat)             │
│     └─> Court: ATTORNEY → CLIENT                                │
│                                                                 │
│  3. Explicit Pattern Extraction                                 │
│     └─> Match text patterns for explicit relationships          │
│     └─> Require document evidence                               │
│                                                                 │
│  4. Validation                                                  │
│     └─> Evidence links valid                                    │
│     └─> Caveats present where required                          │
│     └─> Confidence thresholds met                               │
│                                                                 │
│  5. Storage                                                     │
│     └─> Store with full provenance                              │
│     └─> Flag uncertain for review                               │
│                                                                 │
│  6. Display (with safety measures)                              │
│     └─> Graph opt-in only                                       │
│     └─> Warnings displayed                                      │
│     └─> Type filtering                                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Why 92%?

**Strengths (+27% from 65%)**:
- Evidence-only extraction prevents false inferences (+12%)
- Structural extraction is high precision (+8%)
- Mandatory caveats prevent misinterpretation (+4%)
- Graph safety measures protect users (+3%)

**Remaining Risks (8%)**:
- Complex explicit patterns may miss variations (3%)
- Edge cases in document parsing (2%)
- User misinterpretation despite warnings (2%)
- Flight log passenger list parsing errors (1%)

### Mitigations
- Pattern library is extensible
- Human review for uncertain extractions
- Prominent, unavoidable warnings
- Flight log parsing validated against known formats

---

## Implementation Ready

See: `/mnt/e/epstein-files/src/relationship_extractor.py`
