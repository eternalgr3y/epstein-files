"""
Entity Extraction Pipeline using spaCy NER

Extracts people, organizations, and locations from document text.
Includes deduplication and quality filtering.
"""

import re
import logging
from collections import defaultdict
from datetime import datetime
from typing import Optional, Dict, List, Set, Tuple

import spacy
from spacy.tokens import Doc

from models import (
    get_engine, get_session, Document, DocumentText,
    Entity, Mention, MentionRole
)

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Entity types we care about
ENTITY_TYPES = {
    'PERSON': 'person',
    'ORG': 'organization',
    'GPE': 'location',      # Geopolitical entity (countries, cities, states)
    'LOC': 'location',      # Non-GPE locations
    'FAC': 'location',      # Facilities (buildings, airports, etc.)
}

# Junk patterns to filter out
JUNK_PATTERNS = [
    r'^[A-Z]{1,3}$',                    # Single letters or short acronyms
    r'^[0-9\s\-\.]+$',                  # Numbers only
    r'^(The|A|An|This|That|It|He|She|They|We|I|You)\s*$',  # Pronouns/articles
    r'^(Mr|Mrs|Ms|Dr|Jr|Sr|Inc|LLC|Corp)\.?$',  # Titles only
    r'^(See|Dkt|Ex|Exh|Exhibit|Page|pp|Id|Ibid)\.?\s*\d*$',  # Legal references
    r'^(January|February|March|April|May|June|July|August|September|October|November|December)\s*\d*$',
    r'^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$',  # Dates
    r'^[A-Z]\.[A-Z]\.$',                # Initials only like "J.E."
    r'^\$[\d,\.]+$',                    # Money amounts
    r'^(Plaintiff|Defendant|Petitioner|Respondent|Appellant|Appellee)s?$',  # Legal parties
    r'^(Court|Judge|Attorney|Counsel|Clerk)$',  # Generic legal terms
    r'^(United States|U\.S\.|USA)$',    # Will get too many hits
]

# Compile patterns
JUNK_REGEXES = [re.compile(p, re.IGNORECASE) for p in JUNK_PATTERNS]


def is_junk_entity(text: str, label: str) -> bool:
    """Filter out junk entities."""
    text = text.strip()

    # Too short
    if len(text) < 2:
        return True

    # Too long (probably extraction error)
    if len(text) > 80:
        return True

    # All numbers or punctuation
    if not re.search(r'[a-zA-Z]', text):
        return True

    # Match junk patterns
    for regex in JUNK_REGEXES:
        if regex.match(text):
            return True

    # Single word that's all caps and > 5 chars (probably OCR error or code)
    if ' ' not in text and text.isupper() and len(text) > 5:
        return True

    # Contains junk characters (OCR artifacts)
    if re.search(r'[*•\[\]{}|\\<>]', text):
        return True

    # Contains newlines (multi-line OCR error)
    if '\n' in text:
        return True

    # Repeated characters (OCR stutter like "aaaaa")
    if re.search(r'(.)\1{3,}', text.lower()):
        return True

    # Too many numbers mixed in for a name
    letter_count = len(re.findall(r'[a-zA-Z]', text))
    digit_count = len(re.findall(r'[0-9]', text))
    if digit_count > letter_count * 0.3 and label == 'PERSON':
        return True

    # Very short words repeated (OCR noise)
    words = text.split()
    if len(words) > 1 and all(len(w) <= 2 for w in words):
        return True

    # Single lowercase word (usually not a proper noun)
    if len(words) == 1 and text.islower():
        return True

    # All words very short (likely OCR fragments)
    if len(words) >= 2 and sum(len(w) for w in words) / len(words) < 3:
        return True

    return False


def normalize_name(name: str) -> str:
    """Normalize a name for deduplication."""
    # Strip whitespace and normalize spaces
    name = ' '.join(name.split())

    # Remove common prefixes/suffixes
    prefixes = ['Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Prof.', 'Hon.', 'Rev.']
    suffixes = ['Jr.', 'Sr.', 'II', 'III', 'IV', 'Esq.', 'PhD', 'MD']

    for prefix in prefixes:
        if name.startswith(prefix + ' '):
            name = name[len(prefix):].strip()

    for suffix in suffixes:
        if name.endswith(' ' + suffix):
            name = name[:-len(suffix)].strip()

    return name


def get_canonical_name(names: List[str]) -> str:
    """Given multiple name variants, pick the canonical one."""
    if not names:
        return ""

    # Prefer the longest name (usually the most complete)
    return max(names, key=len)


def extract_context(text: str, start: int, end: int, context_chars: int = 150) -> str:
    """Extract context around an entity mention."""
    ctx_start = max(0, start - context_chars)
    ctx_end = min(len(text), end + context_chars)

    context = text[ctx_start:ctx_end]

    # Clean up
    context = ' '.join(context.split())

    # Add ellipsis if truncated
    if ctx_start > 0:
        context = '...' + context
    if ctx_end < len(text):
        context = context + '...'

    return context


class EntityExtractor:
    """Extract and deduplicate entities from documents."""

    def __init__(self, model_name: str = 'en_core_web_lg'):
        logger.info(f"Loading spaCy model: {model_name}")
        self.nlp = spacy.load(model_name)

        # Increase max length for long documents
        self.nlp.max_length = 2_000_000

        # Entity tracking for deduplication
        self.entities: Dict[str, Dict] = {}  # normalized_name -> entity info
        self.name_variants: Dict[str, Set[str]] = defaultdict(set)  # normalized -> variants

    def process_text(self, text: str, doc_id: int) -> List[Dict]:
        """Extract entities from text, return list of mentions."""
        if not text or len(text) < 10:
            return []

        # Truncate very long texts to avoid memory issues
        if len(text) > 1_000_000:
            text = text[:1_000_000]

        mentions = []

        try:
            doc = self.nlp(text)

            for ent in doc.ents:
                # Skip entity types we don't care about
                if ent.label_ not in ENTITY_TYPES:
                    continue

                entity_text = ent.text.strip()
                entity_type = ENTITY_TYPES[ent.label_]

                # Filter junk
                if is_junk_entity(entity_text, ent.label_):
                    continue

                # Normalize for deduplication
                normalized = normalize_name(entity_text).lower()

                if not normalized or len(normalized) < 2:
                    continue

                # Track this name variant
                self.name_variants[normalized].add(entity_text)

                # Create or update entity record
                if normalized not in self.entities:
                    self.entities[normalized] = {
                        'normalized': normalized,
                        'type': entity_type,
                        'variants': set(),
                        'doc_ids': set(),
                        'mention_count': 0
                    }

                self.entities[normalized]['variants'].add(entity_text)
                self.entities[normalized]['doc_ids'].add(doc_id)
                self.entities[normalized]['mention_count'] += 1

                # Extract context
                context = extract_context(text, ent.start_char, ent.end_char)

                mentions.append({
                    'normalized': normalized,
                    'name_as_appears': entity_text,
                    'entity_type': entity_type,
                    'document_id': doc_id,
                    'context': context,
                    'char_start': ent.start_char,
                    'char_end': ent.end_char,
                })

        except Exception as e:
            logger.error(f"Error processing doc {doc_id}: {e}")

        return mentions

    def get_entities(self) -> List[Dict]:
        """Get deduplicated entity list."""
        result = []

        for normalized, info in self.entities.items():
            canonical = get_canonical_name(list(info['variants']))

            result.append({
                'canonical_name': canonical,
                'normalized': normalized,
                'entity_type': info['type'],
                'mention_count': info['mention_count'],
                'document_count': len(info['doc_ids']),
                'variants': list(info['variants']),
            })

        return result


def is_quality_text(text: str, min_word_ratio: float = 0.3) -> bool:
    """Check if text is likely quality English (not OCR garbage)."""
    if not text or len(text) < 100:
        return False

    # Common English words that should appear in real text
    common_words = {'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'are', 'was',
                    'were', 'been', 'will', 'would', 'could', 'should', 'their', 'which', 'about',
                    'into', 'more', 'some', 'them', 'these', 'than', 'other', 'made', 'after'}

    # Count common word occurrences
    text_lower = text.lower()
    words = text_lower.split()
    if len(words) < 20:
        return False

    common_count = sum(1 for w in words if w in common_words)
    ratio = common_count / len(words)

    return ratio >= min_word_ratio


def run_extraction(batch_size: int = 100, limit: Optional[int] = None):
    """Run entity extraction on all documents with text."""
    engine = get_engine()
    session = get_session(engine)

    extractor = EntityExtractor()
    all_mentions = []

    # Get documents with text
    query = session.query(Document.id, DocumentText.full_text).join(
        DocumentText, Document.id == DocumentText.document_id
    ).filter(DocumentText.word_count > 50)

    if limit:
        query = query.limit(limit)

    docs = query.all()
    total = len(docs)
    skipped = 0

    logger.info(f"Processing {total} documents...")

    for i, (doc_id, text) in enumerate(docs):
        # Skip low-quality OCR text
        if not is_quality_text(text, min_word_ratio=0.05):
            skipped += 1
            continue

        mentions = extractor.process_text(text, doc_id)
        all_mentions.extend(mentions)

        if (i + 1) % 500 == 0:
            logger.info(f"  {i+1}/{total} docs, {len(extractor.entities)} entities, {len(all_mentions)} mentions, {skipped} skipped")

    logger.info(f"Extraction complete: {len(extractor.entities)} entities, {len(all_mentions)} mentions")
    logger.info(f"Skipped {skipped} low-quality documents")

    # Save to database
    logger.info("Saving entities to database...")

    # Create entity records
    entity_map = {}  # normalized -> entity_id
    entities = extractor.get_entities()

    for ent in entities:
        entity = Entity(
            canonical_name=ent['canonical_name'],
            entity_type=ent['entity_type'],
            mention_count=ent['mention_count'],
            confidence=0.8,  # spaCy NER confidence
            needs_review=False,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        session.add(entity)
        session.flush()  # Get the ID
        entity_map[ent['normalized']] = entity.id

    logger.info(f"Created {len(entity_map)} entity records")

    # Create mention records
    logger.info("Saving mentions...")

    for i, m in enumerate(all_mentions):
        entity_id = entity_map.get(m['normalized'])
        if not entity_id:
            continue

        mention = Mention(
            entity_id=entity_id,
            document_id=m['document_id'],
            name_as_appears=m['name_as_appears'],
            context_snippet=m['context'][:500] if m['context'] else None,
            role=MentionRole.UNKNOWN.value,
            created_at=datetime.utcnow(),
        )
        session.add(mention)

        if (i + 1) % 10000 == 0:
            session.commit()
            logger.info(f"  {i+1}/{len(all_mentions)} mentions saved")

    session.commit()
    logger.info("Done!")

    # Print summary
    logger.info(f"\nSummary:")
    logger.info(f"  Entities: {len(entity_map)}")
    logger.info(f"  Mentions: {len(all_mentions)}")

    # Top entities
    top = sorted(entities, key=lambda x: x['mention_count'], reverse=True)[:20]
    logger.info(f"\nTop 20 entities:")
    for e in top:
        logger.info(f"  {e['mention_count']:5} | {e['entity_type']:12} | {e['canonical_name']}")

    session.close()
    return len(entity_map), len(all_mentions)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description='Entity Extraction Pipeline')
    parser.add_argument('--limit', type=int, help='Limit number of documents to process')
    parser.add_argument('--test', action='store_true', help='Test on 10 documents')
    args = parser.parse_args()

    if args.test:
        run_extraction(limit=10)
    else:
        run_extraction(limit=args.limit)
