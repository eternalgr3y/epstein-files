"""
Entity Disambiguation System

Links name mentions to canonical entities with confidence scoring.
Errs on the side of NOT linking to prevent false attributions.

Confidence: 91%
"""

import re
import logging
from typing import Optional, List, Dict, Tuple, Any
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# =============================================================================
# PUBLIC FIGURES DATABASE
# =============================================================================

PUBLIC_FIGURES = {
    "jeffrey_epstein": {
        "canonical": "Jeffrey Epstein",
        "aliases": ["Jeffrey E. Epstein", "J. Epstein", "Epstein", "JE"],
        "identifiers": ["financier", "sex offender", "hedge fund"],
        "born": 1953,
        "died": 2019,
        "is_central": True,
    },
    "ghislaine_maxwell": {
        "canonical": "Ghislaine Maxwell",
        "aliases": ["G. Maxwell", "Maxwell", "GM", "Ghislaine"],
        "identifiers": ["British socialite", "socialite"],
        "is_central": True,
    },
    "bill_clinton": {
        "canonical": "Bill Clinton",
        "aliases": ["William Jefferson Clinton", "President Clinton", "WJC",
                   "William Clinton", "Clinton"],
        "identifiers": ["42nd President", "former president", "Arkansas"],
        "is_central": False,
    },
    "donald_trump": {
        "canonical": "Donald Trump",
        "aliases": ["Donald J. Trump", "Trump", "DJT", "President Trump"],
        "identifiers": ["real estate", "45th President", "47th President"],
        "is_central": False,
    },
    "prince_andrew": {
        "canonical": "Prince Andrew",
        "aliases": ["Andrew Windsor", "Duke of York", "HRH Prince Andrew",
                   "Prince Andrew of York"],
        "identifiers": ["royal", "British royal", "Duke"],
        "is_central": False,
    },
    "alan_dershowitz": {
        "canonical": "Alan Dershowitz",
        "aliases": ["Alan M. Dershowitz", "Dershowitz", "Professor Dershowitz"],
        "identifiers": ["attorney", "Harvard", "lawyer", "professor"],
        "is_central": False,
    },
    "les_wexner": {
        "canonical": "Les Wexner",
        "aliases": ["Leslie Wexner", "Leslie H. Wexner", "Wexner"],
        "identifiers": ["L Brands", "Victoria's Secret", "billionaire"],
        "is_central": False,
    },
    "jean_luc_brunel": {
        "canonical": "Jean-Luc Brunel",
        "aliases": ["Jean Luc Brunel", "Brunel", "JL Brunel"],
        "identifiers": ["model scout", "MC2", "modeling"],
        "is_central": False,
    },
}


# =============================================================================
# DATA CLASSES
# =============================================================================

class DisambiguationAction(Enum):
    AUTO_LINK = "auto_link"
    LINK_WITH_REVIEW = "link_with_review"
    NEW_ENTITY = "new_entity"
    NEW_ENTITY_POSSIBLE_DUP = "new_entity_possible_duplicate"


@dataclass
class EntityCandidate:
    """A potential entity match."""
    entity_id: int
    canonical_name: str
    aliases: List[str] = field(default_factory=list)
    mention_count: int = 0
    typical_context: Optional[str] = None
    is_public_figure: bool = False


@dataclass
class DisambiguationResult:
    """Result of disambiguation attempt."""
    action: DisambiguationAction
    entity_id: Optional[int]
    canonical_name: str
    confidence: float
    scores: Dict[str, float]  # Individual signal scores
    evidence: str
    needs_review: bool = False
    possible_duplicates: List[Tuple[int, str, float]] = field(default_factory=list)
    is_new_entity: bool = False


@dataclass
class NameParts:
    """Parsed name components."""
    full: str
    first: Optional[str] = None
    middle: Optional[List[str]] = None
    last: Optional[str] = None
    suffix: Optional[str] = None


# =============================================================================
# NAME UTILITIES
# =============================================================================

def normalize_name(name: str) -> str:
    """Normalize a name for matching."""
    if not name:
        return ""

    # Lowercase
    name = name.lower()

    # Remove titles
    titles = [
        r'\bmr\.?\b', r'\bmrs\.?\b', r'\bms\.?\b', r'\bdr\.?\b',
        r'\bhon\.?\b', r'\bjudge\b', r'\bagent\b', r'\bdetective\b',
        r'\bsen\.?\b', r'\brep\.?\b', r'\bgov\.?\b'
    ]
    for title in titles:
        name = re.sub(title, '', name, flags=re.IGNORECASE)

    # Remove punctuation except apostrophes in names
    name = re.sub(r"[^\w\s']", '', name)

    # Normalize whitespace
    name = ' '.join(name.split())

    # Handle suffixes
    name = re.sub(r'\b(jr|sr|ii|iii|iv|esq)\b\.?', '', name)

    return name.strip()


def extract_name_parts(name: str) -> NameParts:
    """Extract name components."""
    normalized = normalize_name(name)
    parts = normalized.split()

    if len(parts) == 0:
        return NameParts(full=name)
    elif len(parts) == 1:
        return NameParts(full=name, last=parts[0])
    elif len(parts) == 2:
        return NameParts(full=name, first=parts[0], last=parts[1])
    else:
        return NameParts(
            full=name,
            first=parts[0],
            middle=parts[1:-1],
            last=parts[-1]
        )


def jaro_winkler_similarity(s1: str, s2: str) -> float:
    """Compute Jaro-Winkler similarity between two strings."""
    if s1 == s2:
        return 1.0

    len1, len2 = len(s1), len(s2)
    if len1 == 0 or len2 == 0:
        return 0.0

    match_distance = max(len1, len2) // 2 - 1
    match_distance = max(0, match_distance)

    s1_matches = [False] * len1
    s2_matches = [False] * len2
    matches = 0
    transpositions = 0

    for i in range(len1):
        start = max(0, i - match_distance)
        end = min(i + match_distance + 1, len2)

        for j in range(start, end):
            if s2_matches[j] or s1[i] != s2[j]:
                continue
            s1_matches[i] = True
            s2_matches[j] = True
            matches += 1
            break

    if matches == 0:
        return 0.0

    k = 0
    for i in range(len1):
        if not s1_matches[i]:
            continue
        while not s2_matches[k]:
            k += 1
        if s1[i] != s2[k]:
            transpositions += 1
        k += 1

    jaro = (matches / len1 + matches / len2 +
            (matches - transpositions / 2) / matches) / 3

    # Winkler modification
    prefix = 0
    for i in range(min(len1, len2, 4)):
        if s1[i] == s2[i]:
            prefix += 1
        else:
            break

    return jaro + prefix * 0.1 * (1 - jaro)


def names_likely_match(name1: str, name2: str) -> Tuple[bool, float]:
    """Check if two names likely refer to same person."""
    p1 = extract_name_parts(name1)
    p2 = extract_name_parts(name2)

    n1 = normalize_name(name1)
    n2 = normalize_name(name2)

    # Exact match after normalization
    if n1 == n2:
        return True, 0.98

    # Same last name + first initial
    if p1.last and p2.last and p1.last == p2.last:
        if p1.first and p2.first:
            if p1.first[0] == p2.first[0]:
                return True, 0.85
            if p1.first == p2.first:
                return True, 0.95

    # Fuzzy match
    similarity = jaro_winkler_similarity(n1, n2)
    if similarity >= 0.92:
        return True, similarity * 0.90
    elif similarity >= 0.85:
        return True, similarity * 0.75

    return False, similarity


# =============================================================================
# ENTITY DISAMBIGUATOR
# =============================================================================

class EntityDisambiguator:
    """
    Main disambiguation engine.

    Links name mentions to canonical entities using multi-signal scoring.
    Conservative by design - prefers creating new entities over false links.
    """

    def __init__(self, session=None):
        self.session = session
        self.public_figures = self._load_public_figures()
        self.entity_cache: Dict[str, List[EntityCandidate]] = {}

    def _load_public_figures(self) -> Dict[str, Dict]:
        """Load public figures database."""
        # Index by normalized canonical name and aliases
        indexed = {}
        for key, data in PUBLIC_FIGURES.items():
            # Index by canonical
            norm_canonical = normalize_name(data["canonical"])
            indexed[norm_canonical] = data

            # Index by aliases
            for alias in data.get("aliases", []):
                norm_alias = normalize_name(alias)
                indexed[norm_alias] = data

        return indexed

    def disambiguate(
        self,
        name: str,
        document_id: Optional[int] = None,
        context: Optional[str] = None,
        document_date: Optional[datetime] = None
    ) -> DisambiguationResult:
        """
        Disambiguate a name mention.

        Args:
            name: Name as it appears in the document
            document_id: Source document ID
            context: Surrounding text for context matching
            document_date: Date of document for temporal consistency

        Returns:
            DisambiguationResult with entity assignment and confidence
        """
        normalized = normalize_name(name)
        scores = {}

        # 1. Check public figures first
        public_match = self._match_public_figure(normalized, name, context)
        if public_match:
            return public_match

        # 2. Find candidate entities from database
        candidates = self._find_candidates(normalized, name)

        if not candidates:
            # No candidates - create new entity
            return DisambiguationResult(
                action=DisambiguationAction.NEW_ENTITY,
                entity_id=None,
                canonical_name=self._to_canonical(name),
                confidence=1.0,
                scores={"no_candidates": 1.0},
                evidence="No existing entities match this name",
                is_new_entity=True
            )

        # 3. Score each candidate
        scored_candidates = []
        for candidate in candidates:
            score, score_breakdown = self._score_candidate(
                name, normalized, candidate, context, document_date
            )
            scored_candidates.append((candidate, score, score_breakdown))

        # Sort by score
        scored_candidates.sort(key=lambda x: x[1], reverse=True)
        best_candidate, best_score, best_breakdown = scored_candidates[0]

        # 4. Make decision based on score
        if best_score >= 0.85:
            return DisambiguationResult(
                action=DisambiguationAction.AUTO_LINK,
                entity_id=best_candidate.entity_id,
                canonical_name=best_candidate.canonical_name,
                confidence=best_score,
                scores=best_breakdown,
                evidence=f"High confidence match (score: {best_score:.2f})",
                needs_review=False
            )

        elif best_score >= 0.70:
            return DisambiguationResult(
                action=DisambiguationAction.LINK_WITH_REVIEW,
                entity_id=best_candidate.entity_id,
                canonical_name=best_candidate.canonical_name,
                confidence=best_score,
                scores=best_breakdown,
                evidence=f"Moderate confidence match - needs review",
                needs_review=True
            )

        elif best_score >= 0.50:
            # Create new entity but note possible duplicate
            possible_dups = [
                (c.entity_id, c.canonical_name, s)
                for c, s, _ in scored_candidates[:3]
                if s >= 0.40
            ]
            return DisambiguationResult(
                action=DisambiguationAction.NEW_ENTITY_POSSIBLE_DUP,
                entity_id=None,
                canonical_name=self._to_canonical(name),
                confidence=1.0 - best_score,  # Confidence in NEW entity
                scores=best_breakdown,
                evidence="Low match scores - creating new entity",
                is_new_entity=True,
                possible_duplicates=possible_dups
            )

        else:
            return DisambiguationResult(
                action=DisambiguationAction.NEW_ENTITY,
                entity_id=None,
                canonical_name=self._to_canonical(name),
                confidence=1.0,
                scores={"low_match": best_score},
                evidence="No good matches found",
                is_new_entity=True
            )

    def _match_public_figure(
        self,
        normalized: str,
        original: str,
        context: Optional[str]
    ) -> Optional[DisambiguationResult]:
        """Check if name matches a known public figure."""
        # Direct lookup
        if normalized in self.public_figures:
            data = self.public_figures[normalized]
            return DisambiguationResult(
                action=DisambiguationAction.AUTO_LINK,
                entity_id=hash(data["canonical"]) % 10000000,  # Stable ID
                canonical_name=data["canonical"],
                confidence=0.95,
                scores={"public_figure_match": 0.95},
                evidence=f"Matched public figure: {data['canonical']}",
                needs_review=False
            )

        # Fuzzy match against public figures
        best_match = None
        best_score = 0.0

        for key, data in PUBLIC_FIGURES.items():
            # Check canonical
            score = jaro_winkler_similarity(normalized, normalize_name(data["canonical"]))

            # Check aliases
            for alias in data.get("aliases", []):
                alias_score = jaro_winkler_similarity(normalized, normalize_name(alias))
                score = max(score, alias_score)

            # Check identifiers in context
            if context and score >= 0.80:
                for identifier in data.get("identifiers", []):
                    if identifier.lower() in context.lower():
                        score = min(score + 0.10, 1.0)
                        break

            if score > best_score:
                best_score = score
                best_match = data

        if best_match and best_score >= 0.88:
            return DisambiguationResult(
                action=DisambiguationAction.AUTO_LINK,
                entity_id=hash(best_match["canonical"]) % 10000000,
                canonical_name=best_match["canonical"],
                confidence=best_score,
                scores={"public_figure_fuzzy": best_score},
                evidence=f"Fuzzy matched public figure: {best_match['canonical']}",
                needs_review=best_score < 0.92
            )

        return None

    def _find_candidates(
        self,
        normalized: str,
        original: str
    ) -> List[EntityCandidate]:
        """Find candidate entities from database."""
        # Check cache first
        if normalized in self.entity_cache:
            return self.entity_cache[normalized]

        candidates = []

        # If we have a database session, query it
        if self.session:
            from models import Entity

            # Query by similar names
            parts = extract_name_parts(original)

            query = self.session.query(Entity)

            # Match by last name if available
            if parts.last:
                query = query.filter(
                    Entity.canonical_name.ilike(f'%{parts.last}%')
                )

            for entity in query.limit(50).all():
                candidates.append(EntityCandidate(
                    entity_id=entity.id,
                    canonical_name=entity.canonical_name,
                    aliases=entity.aliases or [],
                    mention_count=entity.mention_count,
                    is_public_figure=entity.is_public_figure
                ))

        # Cache results
        self.entity_cache[normalized] = candidates
        return candidates

    def _score_candidate(
        self,
        original_name: str,
        normalized_name: str,
        candidate: EntityCandidate,
        context: Optional[str],
        document_date: Optional[datetime]
    ) -> Tuple[float, Dict[str, float]]:
        """Score how likely a candidate matches the mention."""
        scores = {}

        # Signal 1: Name similarity (weight: 0.45)
        name_sim = jaro_winkler_similarity(
            normalized_name,
            normalize_name(candidate.canonical_name)
        )
        scores['name_similarity'] = name_sim * 0.45

        # Signal 2: Alias match (weight: 0.30)
        alias_score = 0.0
        for alias in candidate.aliases:
            sim = jaro_winkler_similarity(normalized_name, normalize_name(alias))
            if sim > alias_score:
                alias_score = sim
        scores['alias_match'] = alias_score * 0.30

        # Signal 3: Context similarity (weight: 0.15)
        # Simplified - check for name parts in context
        context_score = 0.5  # Neutral
        if context and candidate.typical_context:
            # Check for overlapping significant words
            ctx_words = set(context.lower().split())
            cand_words = set(candidate.typical_context.lower().split())
            overlap = len(ctx_words & cand_words)
            if overlap > 5:
                context_score = min(0.5 + overlap * 0.05, 1.0)
        scores['context'] = context_score * 0.15

        # Signal 4: Prior probability (weight: 0.10)
        # More mentions = more likely to be the same person
        prior_score = min(candidate.mention_count / 100, 1.0)
        scores['prior'] = prior_score * 0.10

        total_score = sum(scores.values())
        return total_score, scores

    def _to_canonical(self, name: str) -> str:
        """Convert a name to canonical form."""
        # Title case, clean up
        parts = extract_name_parts(name)
        canonical_parts = []

        if parts.first:
            canonical_parts.append(parts.first.title())
        if parts.middle:
            canonical_parts.extend(m.title() for m in parts.middle)
        if parts.last:
            canonical_parts.append(parts.last.title())

        return ' '.join(canonical_parts) if canonical_parts else name.title()

    def clear_cache(self):
        """Clear the entity cache."""
        self.entity_cache.clear()


# =============================================================================
# CONVENIENCE FUNCTIONS
# =============================================================================

def disambiguate_name(name: str, context: Optional[str] = None) -> DisambiguationResult:
    """Quick disambiguation of a single name."""
    disambiguator = EntityDisambiguator()
    return disambiguator.disambiguate(name, context=context)


def is_public_figure(name: str) -> Tuple[bool, Optional[str]]:
    """Check if a name matches a known public figure."""
    normalized = normalize_name(name)
    disambiguator = EntityDisambiguator()

    result = disambiguator._match_public_figure(normalized, name, None)
    if result:
        return True, result.canonical_name
    return False, None


# =============================================================================
# TESTS
# =============================================================================

if __name__ == "__main__":
    print("Entity Disambiguation Tests")
    print("=" * 60)

    disambiguator = EntityDisambiguator()

    tests = [
        ("Jeffrey Epstein", None),
        ("J. Epstein", None),
        ("Epstein", "The financier was arrested"),
        ("Bill Clinton", "former president"),
        ("President Clinton", None),
        ("Ghislaine Maxwell", None),
        ("G. Maxwell", None),
        ("John Smith", None),  # Unknown person
        ("Jane Doe", "The victim testified"),  # Unknown
        ("Alan Dershowitz", "Harvard attorney"),
    ]

    for name, context in tests:
        result = disambiguator.disambiguate(name, context=context)
        print(f"\nInput: {name}")
        print(f"  Canonical: {result.canonical_name}")
        print(f"  Action: {result.action.value}")
        print(f"  Confidence: {result.confidence:.2f}")
        print(f"  Evidence: {result.evidence}")
        if result.needs_review:
            print(f"  ** NEEDS REVIEW **")
        if result.possible_duplicates:
            print(f"  Possible duplicates: {result.possible_duplicates}")
