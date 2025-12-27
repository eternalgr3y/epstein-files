# Role Classification Design Document

## Initial Confidence: 70%
## Target Confidence: 90%+

---

## Problem Statement

When a person is mentioned in a document, what role do they have in that context?
This is CRITICAL for responsible reporting because:
- A victim should never be mislabeled as an associate
- An investigator should not be confused with an accused
- Being mentioned does NOT imply guilt or wrongdoing

### Error Consequences
| Error Type | Impact |
|------------|--------|
| Labeling innocent person as ACCUSED | Severe harm to reputation |
| Labeling victim as ASSOCIATE | Minimizes their experience |
| Labeling ACCUSED as MENTIONED | Understates allegations |
| Labeling anyone as VICTIM incorrectly | Harmful in both directions |

**Principle**: Default to less specific roles. Only upgrade with strong evidence.

---

## Iteration 1: Initial Analysis (70%)

### Original Role Taxonomy
- VICTIM, WITNESS, INVESTIGATOR, LEGAL_COUNSEL, ACCUSED
- ASSOCIATE, MENTIONED, AUTHOR, RECIPIENT, UNKNOWN

### Problems Identified
1. **ASSOCIATE vs MENTIONED**: Too similar, distinction unclear
2. **ACCUSED is loaded**: Need strong evidence
3. **Document type ignored**: Flight logs can't tell us victim/accused
4. **No structural extraction**: Court records have clear structure

---

## Iteration 2: Document-Type-Specific Approach (80%)

### Key Insight
The role depends heavily on DOCUMENT TYPE. A flight log can only tell us
someone was a passenger. A court indictment has structured information.

### Document Type Strategies

#### Court Records
- Defendant section → ACCUSED (0.95 confidence)
- Victim references → VICTIM (0.95 confidence)
- Witness lists → WITNESS (0.90 confidence)
- Attorney of record → LEGAL_COUNSEL (0.95 confidence)
- Judge → COURT_OFFICIAL (0.95 confidence)

#### Flight Logs
- All names → PASSENGER (0.90 confidence)
- Pilot/crew if identifiable → CREW (0.85 confidence)
- NO implications about why they traveled

#### FBI/Investigation Notes
- Agent names → INVESTIGATOR (0.90 confidence)
- Subject of investigation → SUBJECT_OF_INVESTIGATION (0.85 confidence)
- Interview subjects → WITNESS (0.85 confidence)

#### Emails
- From field → AUTHOR (0.95 confidence)
- To/CC fields → RECIPIENT (0.95 confidence)
- Names in body → MENTIONED (0.70 confidence)

#### Photos
- Anyone identifiable → APPEARS_IN_PHOTO (0.90 confidence)
- NO implication of relationship or wrongdoing

#### Depositions/Transcripts
- Person giving testimony → DEPONENT (0.95 confidence)
- Attorneys present → LEGAL_COUNSEL (0.90 confidence)

---

## Iteration 3: Refined Taxonomy (85%)

### New Role Hierarchy

```
SENSITIVE ROLES (require strong evidence + human review flag)
├── VICTIM          - Named as victim in official court records
├── ACCUSED         - Named as defendant in indictment/charges
└── PLAINTIFF       - Filed lawsuit

CLEAR ROLES (structural evidence sufficient)
├── WITNESS         - Provided testimony, listed as witness
├── INVESTIGATOR    - Law enforcement, prosecutors, FBI agents
├── LEGAL_COUNSEL   - Attorneys (defense, prosecution, civil)
├── COURT_OFFICIAL  - Judges, court staff
├── DEPONENT        - Gave deposition testimony
├── SUBJECT_OF_INVESTIGATION - Named in investigation (not charged)

DOCUMENT-SPECIFIC ROLES (context-limited)
├── PASSENGER       - Listed on flight log
├── CREW            - Flight crew/staff
├── AUTHOR          - Wrote document/email
├── RECIPIENT       - Received document/email
├── APPEARS_IN_PHOTO - Visible in photograph
├── EMPLOYEE        - Staff (from employment records)

DEFAULT ROLES
├── MENTIONED       - Name appears, role unclear
└── UNKNOWN         - Cannot determine
```

### Role Assignment Rules

```
IF document_type == COURT_RECORD:
    IF name in defendant_section: return ACCUSED, 0.95
    IF name in plaintiff_section: return PLAINTIFF, 0.95
    IF name in victim_references: return VICTIM, 0.95
    IF name in witness_list: return WITNESS, 0.90

IF document_type == FLIGHT_LOG:
    return PASSENGER, 0.90  # NEVER infer more

IF document_type == EMAIL:
    IF name == from_field: return AUTHOR, 0.95
    IF name in to_cc_fields: return RECIPIENT, 0.95
    return MENTIONED, 0.60

IF document_type == FBI_NOTES:
    IF pattern matches "Agent [Name]": return INVESTIGATOR, 0.90
    IF pattern matches "interviewed [Name]": return WITNESS, 0.85

DEFAULT: return MENTIONED, 0.50
```

---

## Iteration 4: Evidence Requirements (88%)

### Evidence Tiers

| Tier | Evidence Type | Confidence | Example |
|------|--------------|------------|---------|
| 1 | Explicit text | 0.95 | "Defendant John Doe" |
| 2 | Structural position | 0.85-0.90 | Name in defendant section header |
| 3 | Pattern match | 0.75-0.85 | "Agent Smith investigated" |
| 4 | Contextual | 0.60-0.75 | Inferred from surrounding text |
| 5 | Uncertain | <0.60 | Assign MENTIONED |

### Sensitive Role Requirements

For VICTIM and ACCUSED, we require:
1. Evidence Tier 1 or 2 ONLY (explicit or structural)
2. Source must be official court document
3. Automatic flag for human review
4. Store exact evidence snippet
5. NEVER assign from inference

---

## Iteration 5: Keyword Patterns (90%)

### High-Confidence Patterns

```python
VICTIM_PATTERNS = [
    r"(?:victim|complainant|minor victim)\s+(?:identified as\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)",
    r"([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:was|is)\s+(?:a\s+)?victim",
    r"crimes?\s+against\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)",
]

ACCUSED_PATTERNS = [
    r"(?:defendant|accused)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)",
    r"([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s*,?\s+(?:defendant|accused)",
    r"United States\s+v\.\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)",
    r"People\s+v\.\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)",
]

WITNESS_PATTERNS = [
    r"(?:witness|testified|deposed)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)",
    r"([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:testified|stated under oath)",
    r"testimony\s+of\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)",
]

INVESTIGATOR_PATTERNS = [
    r"(?:Agent|Detective|Officer|Inspector)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)",
    r"(?:FBI|DOJ|SDNY)\s+(?:Agent\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)",
    r"([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s*,?\s+(?:FBI|Special Agent)",
]

ATTORNEY_PATTERNS = [
    r"(?:Attorney|Counsel|Esq\.?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)",
    r"([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s*,?\s+(?:Esq\.?|Attorney)",
    r"(?:represented by|counsel for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)",
]
```

---

## Iteration 6: Validation & Calibration (92%)

### Validation Strategy

1. **Golden Set**: Manually label 200 mentions across document types
2. **Precision by Role**: Track accuracy for each role type
3. **Sensitive Role Audit**: 100% human review of VICTIM/ACCUSED
4. **Confidence Calibration**: Verify 90% predictions are 90% accurate

### Calibration Process

```python
def calibrate_confidence(predictions, ground_truth):
    """Ensure predicted confidence matches actual accuracy."""
    buckets = defaultdict(list)

    for pred, actual in zip(predictions, ground_truth):
        bucket = round(pred.confidence, 1)  # 0.0, 0.1, ..., 1.0
        buckets[bucket].append(pred.role == actual.role)

    calibration = {}
    for bucket, results in buckets.items():
        actual_accuracy = sum(results) / len(results)
        calibration[bucket] = {
            'predicted': bucket,
            'actual': actual_accuracy,
            'gap': bucket - actual_accuracy
        }

    return calibration
```

### Error Handling

| Situation | Action |
|-----------|--------|
| Confidence < 0.60 | Assign MENTIONED |
| Sensitive role + Confidence < 0.90 | Flag for review |
| Pattern match but wrong doc type | Reduce confidence by 0.20 |
| Multiple conflicting patterns | Assign MENTIONED, flag for review |

---

## Final Design: 92% Confidence

### Why 92%?
- Document-type-specific approach handles most cases predictably
- Default to MENTIONED prevents harmful mislabeling
- Human review for sensitive roles catches errors
- Clear evidence requirements for each role
- Pattern matching is explicit and auditable
- Validation strategy ensures ongoing accuracy

### Remaining 8% Risk
- OCR errors corrupting pattern matches
- Edge cases in document structure
- New document types not covered
- Unusual legal language patterns

### Mitigations
- OCR confidence threshold (reject low-quality extractions)
- Human review queue for edge cases
- Extensible document type handlers
- Regular pattern library updates

---

## Implementation Ready

See: `/mnt/e/epstein-files/src/role_classifier.py`
