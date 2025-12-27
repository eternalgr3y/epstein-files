# Entity Disambiguation Design Document

## Initial Confidence: 60%
## Target Confidence: 90%+

---

## Problem Statement

When we extract the name "Bill" from a document, which person does it refer to?
This is challenging because:
- Multiple people share names
- Names have variations (Bill/William/Billy)
- OCR introduces errors
- Context may be limited

### Error Consequences
| Error Type | Impact |
|------------|--------|
| False positive (wrong link) | Attributes actions to wrong person - SEVERE |
| False negative (missed link) | Fragments mentions, incomplete picture - MODERATE |

**Principle**: Err on the side of NOT linking. Better to have duplicate entities
than wrongly attribute something to the wrong person.

---

## Iteration 1: Initial Analysis (60%)

### Why 60%?
- No ground truth database of people involved
- Limited context in many documents
- Partial names common ("Bill", "Mr. Smith")
- OCR errors corrupt names

### Baseline Approach (Flawed)
Simple fuzzy matching: if names are similar, link them.

**Problems**:
- "Bill Smith" and "Bill Smythe" could be different people
- "J. Epstein" could be Jeffrey or someone else
- High false positive rate

---

## Iteration 2: Two-Class Strategy (70%)

### Key Insight
Distinguish between:
1. **Public Figures**: Well-known people with established identities
2. **Private Individuals**: People not publicly known

For public figures, we have external knowledge (Wikipedia, news).
For private individuals, we must be conservative.

### Public Figures Database
Pre-populate with known figures:

```python
PUBLIC_FIGURES = {
    "jeffrey_epstein": {
        "canonical": "Jeffrey Epstein",
        "aliases": ["Jeffrey E. Epstein", "J. Epstein", "Epstein"],
        "born": 1953, "died": 2019,
        "identifiers": ["financier", "convicted sex offender"],
    },
    "ghislaine_maxwell": {
        "canonical": "Ghislaine Maxwell",
        "aliases": ["G. Maxwell", "Maxwell", "GM"],
        "identifiers": ["British socialite"],
    },
    "bill_clinton": {
        "canonical": "Bill Clinton",
        "aliases": ["William Jefferson Clinton", "President Clinton", "WJC"],
        "identifiers": ["42nd President", "former president"],
    },
    # ... 50-100 known figures
}
```

### Two-Track Processing
1. **Public figures**: Match against database with high confidence
2. **Private individuals**: Conservative matching, prefer creating new entities

---

## Iteration 3: Multi-Signal Scoring (78%)

### Disambiguation Signals

| Signal | Weight | Description |
|--------|--------|-------------|
| Exact name match | 0.40 | Same canonical name |
| Known alias match | 0.30 | Matches known alias of entity |
| Name similarity | 0.15 | Jaro-Winkler/Levenshtein score |
| Context overlap | 0.10 | Similar surrounding text |
| Temporal consistency | 0.05 | Compatible timeframes |

### Scoring Algorithm

```python
def score_candidate(mention, candidate_entity):
    score = 0.0

    # Signal 1: Name match (40%)
    name_sim = jaro_winkler(normalize(mention.name), candidate.canonical)
    score += name_sim * 0.40

    # Signal 2: Alias match (30%)
    for alias in candidate.aliases:
        if normalize(mention.name) == normalize(alias):
            score += 0.30
            break

    # Signal 3: Additional name similarity (15%)
    if not alias_matched:
        best_alias_sim = max(jaro_winkler(mention.name, a) for a in candidate.aliases)
        score += best_alias_sim * 0.15

    # Signal 4: Context similarity (10%)
    if mention.context and candidate.typical_context:
        context_sim = cosine_similarity(embed(mention.context), candidate.context_embedding)
        score += context_sim * 0.10

    # Signal 5: Temporal consistency (5%)
    if dates_compatible(mention.document_date, candidate.active_dates):
        score += 0.05

    return min(score, 1.0)
```

### Decision Thresholds

| Score Range | Action |
|-------------|--------|
| >= 0.85 | Auto-link with high confidence |
| 0.70 - 0.85 | Link but flag for review |
| 0.50 - 0.70 | Create new entity, note possible duplicate |
| < 0.50 | Create new entity |

---

## Iteration 4: Name Normalization (82%)

### Normalization Rules

```python
def normalize_name(name: str) -> str:
    # 1. Lowercase
    name = name.lower()

    # 2. Remove titles
    titles = ['mr.', 'mrs.', 'ms.', 'dr.', 'hon.', 'judge', 'agent', 'detective']
    for title in titles:
        name = name.replace(title, '')

    # 3. Remove punctuation
    name = re.sub(r'[^\w\s]', '', name)

    # 4. Normalize whitespace
    name = ' '.join(name.split())

    # 5. Handle Jr/Sr/III
    name = re.sub(r'\b(jr|sr|ii|iii|iv)\b', '', name)

    return name.strip()


def extract_name_parts(name: str) -> dict:
    """Extract first, middle, last names."""
    parts = normalize_name(name).split()

    if len(parts) == 1:
        return {"last": parts[0]}
    elif len(parts) == 2:
        return {"first": parts[0], "last": parts[1]}
    else:
        return {"first": parts[0], "middle": parts[1:-1], "last": parts[-1]}
```

### Name Matching Strategies

```python
def names_match(name1: str, name2: str) -> Tuple[bool, float]:
    """Check if two names likely refer to same person."""
    p1 = extract_name_parts(name1)
    p2 = extract_name_parts(name2)

    # Strategy 1: Exact last name + first initial
    if p1.get('last') == p2.get('last'):
        if p1.get('first', [''])[0] == p2.get('first', [''])[0]:
            return True, 0.85

    # Strategy 2: Full name match (with normalization)
    if normalize_name(name1) == normalize_name(name2):
        return True, 0.95

    # Strategy 3: First + last match (ignore middle)
    if (p1.get('first') == p2.get('first') and
        p1.get('last') == p2.get('last')):
        return True, 0.90

    # Strategy 4: Fuzzy match on full name
    similarity = jaro_winkler(normalize_name(name1), normalize_name(name2))
    if similarity >= 0.90:
        return True, similarity * 0.85

    return False, similarity
```

---

## Iteration 5: Contextual Embedding Enhancement (86%)

### Context Embedding Strategy

For ambiguous cases (score 0.60-0.80), use semantic similarity:

1. Generate embedding of mention context (50 words around name)
2. Compare to embeddings of candidate entity's typical contexts
3. High similarity → likely same person

```python
class ContextEmbedder:
    def __init__(self, model="all-MiniLM-L6-v2"):
        from sentence_transformers import SentenceTransformer
        self.model = SentenceTransformer(model)
        self.entity_embeddings = {}  # Cache

    def embed_mention_context(self, text: str, name: str, window: int = 50) -> np.ndarray:
        """Extract and embed context around name mention."""
        # Find name in text
        match = re.search(re.escape(name), text, re.IGNORECASE)
        if not match:
            return None

        # Extract window
        words = text.split()
        name_pos = len(text[:match.start()].split())
        start = max(0, name_pos - window)
        end = min(len(words), name_pos + window)
        context = ' '.join(words[start:end])

        return self.model.encode(context)

    def get_entity_embedding(self, entity_id: int) -> np.ndarray:
        """Get or compute entity's typical context embedding."""
        if entity_id in self.entity_embeddings:
            return self.entity_embeddings[entity_id]

        # Aggregate embeddings from all mentions
        mention_contexts = get_mention_contexts(entity_id)
        if not mention_contexts:
            return None

        embeddings = [self.model.encode(ctx) for ctx in mention_contexts]
        avg_embedding = np.mean(embeddings, axis=0)
        self.entity_embeddings[entity_id] = avg_embedding

        return avg_embedding

    def context_similarity(self, mention_embedding, entity_id) -> float:
        """Compute similarity between mention context and entity's typical context."""
        entity_emb = self.get_entity_embedding(entity_id)
        if entity_emb is None or mention_embedding is None:
            return 0.5  # Neutral

        return float(cosine_similarity([mention_embedding], [entity_emb])[0][0])
```

---

## Iteration 6: Human-in-the-Loop Design (90%)

### Review Queue System

For uncertain cases, create a review queue:

```python
@dataclass
class DisambiguationReview:
    mention_id: int
    mention_name: str
    mention_context: str
    document_id: int

    candidate_entity_id: int
    candidate_name: str
    candidate_context_sample: str

    auto_score: float
    auto_decision: str  # "link", "new_entity", "review"

    # Human review fields
    reviewer: Optional[str] = None
    reviewed_at: Optional[datetime] = None
    decision: Optional[str] = None  # "confirm_link", "reject_link", "merge", "split"
    notes: Optional[str] = None
```

### Review Prioritization

1. **High priority**: Sensitive roles (VICTIM, ACCUSED) with uncertain disambiguation
2. **Medium priority**: Public figures with unusual name variants
3. **Low priority**: General mentions with moderate scores

### Merge/Split Tools

After initial pass, provide tools:

```python
def merge_entities(entity_ids: List[int], primary_id: int, reason: str):
    """Merge multiple entities into one (they're the same person)."""
    # Update all mentions to point to primary
    # Keep audit log
    # Recalculate entity statistics

def split_entity(entity_id: int, mention_ids: List[int], reason: str):
    """Split one entity into two (actually different people)."""
    # Create new entity from subset of mentions
    # Keep audit log
    # Recalculate statistics
```

---

## Final Design: 91% Confidence

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    ENTITY DISAMBIGUATION                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Name Extraction → Normalize name                            │
│                                                                 │
│  2. Public Figure Check                                         │
│     └─> Match against known figures database                    │
│     └─> If match score >= 0.90, auto-link                       │
│                                                                 │
│  3. Candidate Search                                            │
│     └─> Find existing entities with similar names               │
│     └─> Compute multi-signal scores                             │
│                                                                 │
│  4. Decision                                                    │
│     ├─> Score >= 0.85: Auto-link                                │
│     ├─> Score 0.70-0.85: Link + flag for review                 │
│     ├─> Score 0.50-0.70: New entity + note possible duplicate   │
│     └─> Score < 0.50: New entity                                │
│                                                                 │
│  5. Context Enhancement (for uncertain cases)                   │
│     └─> Embedding similarity comparison                         │
│     └─> Can promote score by up to 0.15                         │
│                                                                 │
│  6. Human Review Queue                                          │
│     └─> Flagged cases reviewed by human                         │
│     └─> Merge/split tools for corrections                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Why 91%?

**Strengths (+31% from 60%)**:
- Public figures handled reliably (+10%)
- Multi-signal scoring is robust (+8%)
- Context embeddings catch semantic patterns (+5%)
- Conservative thresholds prevent false positives (+4%)
- Human review catches edge cases (+4%)

**Remaining Risks (9%)**:
- OCR corruption of names (3%)
- Truly ambiguous partial names like "Bill" with no context (3%)
- New document types with different patterns (2%)
- Edge cases in name normalization (1%)

### Mitigations
- OCR confidence filtering (reject low-quality)
- Context requirement for partial names
- Extensible document handlers
- Regular review of edge cases

---

## Implementation Ready

See: `/mnt/e/epstein-files/src/entity_disambiguator.py`
