"""
Entity Extraction for House Oversight Documents Only

Targets documents with data_set='house-oversight-estate' that don't have mentions yet.
"""

import re
import logging
from collections import defaultdict
from typing import Optional, Dict, List, Set

import spacy

from models import (
    get_engine, get_session, Document, DocumentText,
    Entity, Mention, MentionRole, utc_now
)

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Entity types we care about
ENTITY_TYPES = {
    'PERSON': 'person',
    'ORG': 'organization',
    'GPE': 'location',
    'LOC': 'location',
    'FAC': 'location',
}

# Junk patterns to filter out
JUNK_PATTERNS = [
    r'^[A-Z]{1,3}$',
    r'^[0-9\s\-\.]+$',
    r'^(The|A|An|This|That|It|He|She|They|We|I|You)\s*$',
    r'^(Mr|Mrs|Ms|Dr|Jr|Sr|Inc|LLC|Corp)\.?$',
    r'^(See|Dkt|Ex|Exh|Exhibit|Page|pp|Id|Ibid)\.?\s*\d*$',
    r'^(January|February|March|April|May|June|July|August|September|October|November|December)\s*\d*$',
    r'^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$',
    r'^[A-Z]\.[A-Z]\.$',
    r'^\$[\d,\.]+$',
    r'^(Plaintiff|Defendant|Petitioner|Respondent|Appellant|Appellee)s?$',
    r'^(Court|Judge|Attorney|Counsel|Clerk)$',
    r'^(United States|U\.S\.|USA)$',
]

JUNK_REGEXES = [re.compile(p, re.IGNORECASE) for p in JUNK_PATTERNS]


def is_junk_entity(text: str, label: str) -> bool:
    """Filter out junk entities."""
    text = text.strip()

    if len(text) < 2 or len(text) > 80:
        return True

    if not re.search(r'[a-zA-Z]', text):
        return True

    for regex in JUNK_REGEXES:
        if regex.match(text):
            return True

    if ' ' not in text and text.isupper() and len(text) > 5:
        return True

    if re.search(r'[*•\[\]{}|\\<>]', text):
        return True

    if '\n' in text:
        return True

    if re.search(r'(.)\1{3,}', text.lower()):
        return True

    letter_count = len(re.findall(r'[a-zA-Z]', text))
    digit_count = len(re.findall(r'[0-9]', text))
    if digit_count > letter_count * 0.3 and label == 'PERSON':
        return True

    words = text.split()
    if len(words) > 1 and all(len(w) <= 2 for w in words):
        return True

    if len(words) == 1 and text.islower():
        return True

    if len(words) >= 2 and sum(len(w) for w in words) / len(words) < 3:
        return True

    return False


def normalize_name(name: str) -> str:
    """Normalize a name for deduplication."""
    name = ' '.join(name.split())

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
    return max(names, key=len)


def extract_context(text: str, start: int, end: int, context_chars: int = 150) -> str:
    """Extract context around an entity mention."""
    ctx_start = max(0, start - context_chars)
    ctx_end = min(len(text), end + context_chars)

    context = text[ctx_start:ctx_end]
    context = ' '.join(context.split())

    if ctx_start > 0:
        context = '...' + context
    if ctx_end < len(text):
        context = context + '...'

    return context


def is_quality_text(text: str, min_word_ratio: float = 0.05) -> bool:
    """Check if text is likely quality English (not OCR garbage)."""
    if not text or len(text) < 100:
        return False

    common_words = {'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'are', 'was',
                    'were', 'been', 'will', 'would', 'could', 'should', 'their', 'which', 'about',
                    'into', 'more', 'some', 'them', 'these', 'than', 'other', 'made', 'after'}

    text_lower = text.lower()
    words = text_lower.split()
    if len(words) < 20:
        return False

    common_count = sum(1 for w in words if w in common_words)
    ratio = common_count / len(words)

    return ratio >= min_word_ratio


def run_house_oversight_extraction():
    """Run entity extraction on House Oversight documents only."""
    engine = get_engine()
    session = get_session(engine)

    logger.info("Loading spaCy model: en_core_web_lg")
    nlp = spacy.load('en_core_web_lg')
    nlp.max_length = 2_000_000

    # Entity tracking
    entities: Dict[str, Dict] = {}
    name_variants: Dict[str, Set[str]] = defaultdict(set)
    all_mentions = []

    # Get House Oversight documents with text
    logger.info("Querying House Oversight documents...")

    docs = session.query(Document.id, DocumentText.full_text).join(
        DocumentText, Document.id == DocumentText.document_id
    ).filter(
        Document.data_set == 'house-oversight-estate',
        DocumentText.word_count > 50
    ).all()

    total = len(docs)
    skipped = 0

    logger.info(f"Processing {total} House Oversight documents...")

    for i, (doc_id, text) in enumerate(docs):
        # Skip low-quality OCR text
        if not is_quality_text(text, min_word_ratio=0.05):
            skipped += 1
            continue

        # Truncate very long texts
        if len(text) > 1_000_000:
            text = text[:1_000_000]

        try:
            doc = nlp(text)

            for ent in doc.ents:
                if ent.label_ not in ENTITY_TYPES:
                    continue

                entity_text = ent.text.strip()
                entity_type = ENTITY_TYPES[ent.label_]

                if is_junk_entity(entity_text, ent.label_):
                    continue

                normalized = normalize_name(entity_text).lower()

                if not normalized or len(normalized) < 2:
                    continue

                name_variants[normalized].add(entity_text)

                if normalized not in entities:
                    entities[normalized] = {
                        'normalized': normalized,
                        'type': entity_type,
                        'variants': set(),
                        'doc_ids': set(),
                        'mention_count': 0
                    }

                entities[normalized]['variants'].add(entity_text)
                entities[normalized]['doc_ids'].add(doc_id)
                entities[normalized]['mention_count'] += 1

                context = extract_context(text, ent.start_char, ent.end_char)

                all_mentions.append({
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

        if (i + 1) % 500 == 0:
            logger.info(f"  {i+1}/{total} docs, {len(entities)} entities, {len(all_mentions)} mentions, {skipped} skipped")

    logger.info(f"Extraction complete: {len(entities)} entities, {len(all_mentions)} mentions")
    logger.info(f"Skipped {skipped} low-quality documents")

    # Check for existing entities and merge
    logger.info("Checking for existing entities to merge with...")

    existing_entities = {}
    for ent in session.query(Entity).all():
        key = ent.canonical_name.lower()
        existing_entities[key] = ent.id

    logger.info(f"Found {len(existing_entities)} existing entities")

    # Save to database
    logger.info("Saving entities to database...")

    entity_map = {}  # normalized -> entity_id
    new_entities = 0
    merged_entities = 0

    for normalized, info in entities.items():
        canonical = get_canonical_name(list(info['variants']))
        canonical_lower = canonical.lower()

        # Check if entity already exists
        if canonical_lower in existing_entities:
            entity_id = existing_entities[canonical_lower]
            # Update mention count on existing entity
            existing = session.query(Entity).get(entity_id)
            if existing:
                existing.mention_count += info['mention_count']
                existing.updated_at = utc_now()
            entity_map[normalized] = entity_id
            merged_entities += 1
        else:
            # Create new entity
            entity = Entity(
                canonical_name=canonical,
                entity_type=info['type'],
                mention_count=info['mention_count'],
                confidence=0.8,
                needs_review=False,
                created_at=utc_now(),
                updated_at=utc_now(),
            )
            session.add(entity)
            session.flush()
            entity_map[normalized] = entity.id
            existing_entities[canonical_lower] = entity.id
            new_entities += 1

    logger.info(f"Created {new_entities} new entities, merged with {merged_entities} existing")

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
            created_at=utc_now(),
        )
        session.add(mention)

        if (i + 1) % 10000 == 0:
            session.commit()
            logger.info(f"  {i+1}/{len(all_mentions)} mentions saved")

    session.commit()
    logger.info("Done!")

    # Print summary
    logger.info(f"\nSummary:")
    logger.info(f"  New entities: {new_entities}")
    logger.info(f"  Merged entities: {merged_entities}")
    logger.info(f"  Total mentions: {len(all_mentions)}")

    # Top entities from this extraction
    entity_list = []
    for normalized, info in entities.items():
        canonical = get_canonical_name(list(info['variants']))
        entity_list.append({
            'canonical_name': canonical,
            'entity_type': info['type'],
            'mention_count': info['mention_count'],
        })

    top = sorted(entity_list, key=lambda x: x['mention_count'], reverse=True)[:20]
    logger.info(f"\nTop 20 entities from House Oversight docs:")
    for e in top:
        logger.info(f"  {e['mention_count']:5} | {e['entity_type']:12} | {e['canonical_name']}")

    session.close()
    return new_entities + merged_entities, len(all_mentions)


if __name__ == "__main__":
    run_house_oversight_extraction()
