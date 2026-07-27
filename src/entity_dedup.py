"""
Entity Deduplication and Cleanup

Merges duplicate entities, fixes entity types, removes junk.
"""

import re
import logging
from collections import defaultdict
from typing import Dict, List, Set, Tuple

from models import get_engine, get_session, Entity, Mention, utc_now

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


# Known people who might be misclassified as organizations
KNOWN_PEOPLE = {
    'maxwell', 'ghislaine maxwell', 'ghislaine', 'g. maxwell',
    'clinton', 'bill clinton', 'hillary clinton',
    'trump', 'donald trump',
    'prince andrew', 'andrew',
    'dershowitz', 'alan dershowitz',
    'brunel', 'jean-luc brunel', 'jean luc brunel',
    'wexner', 'les wexner', 'leslie wexner',
    'giuffre', 'virginia giuffre', 'virginia roberts',
    'farmer', 'annie farmer', 'maria farmer',
    'ransome', 'sarah ransome',
    'kellen', 'sarah kellen',
    'marcinkova', 'nadia marcinkova',
    'groff', 'lesley groff',
    'rodriguez', 'alfredo rodriguez',
}

# Junk entities to remove
JUNK_ENTITIES = {
    'government', 'office', 'court', 'foia', 'ausa', 'ausa ii',
    'defendant', 'plaintiff', 'usao', 'doj', 'fbi',
    'judge', 'counsel', 'attorney', 'clerk',
    'exhibit', 'document', 'page', 'section',
    'mr.', 'ms.', 'mrs.', 'dr.',
}


def normalize_for_dedup(name: str) -> str:
    """Normalize a name for deduplication matching."""
    # Lowercase
    name = name.lower().strip()
    # Remove titles
    for title in ['mr.', 'mrs.', 'ms.', 'dr.', 'hon.', 'prof.']:
        name = name.replace(title, '')
    # Remove suffixes
    for suffix in ['jr.', 'sr.', 'ii', 'iii', 'iv', 'esq.', 'phd', 'md']:
        if name.endswith(' ' + suffix):
            name = name[:-len(suffix)-1]
    # Normalize whitespace
    name = ' '.join(name.split())
    return name


def find_merge_candidates(session) -> Dict[str, List[int]]:
    """Find entities that should be merged based on name similarity."""
    entities = session.query(Entity).all()

    # Group by normalized name
    groups: Dict[str, List[Entity]] = defaultdict(list)

    for ent in entities:
        norm = normalize_for_dedup(ent.canonical_name)
        if len(norm) >= 2:
            groups[norm].append(ent)

    # Also group last-name matches for people
    last_name_groups: Dict[str, List[Entity]] = defaultdict(list)
    for ent in entities:
        if ent.entity_type == 'person':
            words = ent.canonical_name.split()
            if len(words) >= 1:
                last_word = normalize_for_dedup(words[-1])
                if len(last_word) >= 3:
                    last_name_groups[last_word].append(ent)

    return groups, last_name_groups


def merge_entities(session, keep_id: int, merge_ids: List[int]):
    """Merge multiple entities into one."""
    if not merge_ids:
        return

    # Update all mentions to point to keep_id
    for merge_id in merge_ids:
        if merge_id == keep_id:
            continue
        session.query(Mention).filter(Mention.entity_id == merge_id).update(
            {Mention.entity_id: keep_id}, synchronize_session=False
        )

    # Update mention count on kept entity
    keep_entity = session.get(Entity, keep_id)
    count = session.query(Mention).filter(Mention.entity_id == keep_id).count()
    keep_entity.mention_count = count
    keep_entity.updated_at = utc_now()

    # Delete merged entities
    for merge_id in merge_ids:
        if merge_id != keep_id:
            session.query(Entity).filter(Entity.id == merge_id).delete()


def fix_entity_types(session):
    """Fix misclassified entity types."""
    fixed = 0

    for name in KNOWN_PEOPLE:
        # Find entities with this name that aren't marked as person
        entities = session.query(Entity).filter(
            Entity.canonical_name.ilike(f'%{name}%'),
            Entity.entity_type != 'person'
        ).all()

        for ent in entities:
            ent.entity_type = 'person'
            ent.updated_at = utc_now()
            fixed += 1

    session.commit()
    return fixed


def remove_junk_entities(session):
    """Remove clearly junk entities."""
    removed = 0

    for junk in JUNK_ENTITIES:
        entities = session.query(Entity).filter(
            Entity.canonical_name.ilike(junk)
        ).all()

        for ent in entities:
            # Delete mentions first
            session.query(Mention).filter(Mention.entity_id == ent.id).delete()
            session.delete(ent)
            removed += 1

    # Also remove entities with very short names (likely junk)
    from sqlalchemy import func
    short_ents = session.query(Entity).filter(
        func.length(Entity.canonical_name) < 3
    ).all()

    for ent in short_ents:
        session.query(Mention).filter(Mention.entity_id == ent.id).delete()
        session.delete(ent)
        removed += 1

    session.commit()
    return removed


def run_dedup():
    """Run full deduplication pipeline."""
    engine = get_engine()
    session = get_session(engine)

    logger.info("Starting entity deduplication...")

    # Step 1: Fix entity types
    logger.info("Fixing entity types...")
    fixed = fix_entity_types(session)
    logger.info(f"  Fixed {fixed} entity types")

    # Step 2: Remove junk
    logger.info("Removing junk entities...")
    removed = remove_junk_entities(session)
    logger.info(f"  Removed {removed} junk entities")

    # Step 3: Find and merge duplicates
    logger.info("Finding merge candidates...")
    groups, last_name_groups = find_merge_candidates(session)

    # Merge exact normalized matches
    merged = 0
    for norm_name, entities in groups.items():
        if len(entities) > 1:
            # Keep the one with longest canonical name (most complete)
            entities.sort(key=lambda e: len(e.canonical_name), reverse=True)
            keep = entities[0]
            merge_ids = [e.id for e in entities[1:]]
            merge_entities(session, keep.id, merge_ids)
            merged += len(merge_ids)

            if merged % 1000 == 0:
                session.commit()
                logger.info(f"  Merged {merged} entities...")

    session.commit()
    logger.info(f"  Merged {merged} duplicate entities")

    # Step 4: Merge Epstein variants specifically
    logger.info("Merging Epstein name variants...")
    epstein_variants = session.query(Entity).filter(
        Entity.canonical_name.ilike('%epstein%'),
        Entity.entity_type == 'person'
    ).all()

    def is_clean_name(name):
        """Check if name is a clean person name, not a filename or junk."""
        junk_patterns = ['.docx', '.pdf', '.doc', '.txt', '_', '/', '\\', '@']
        name_lower = name.lower()
        return not any(p in name_lower for p in junk_patterns)

    def name_quality(e):
        """Score a name - prefer clean names with 'jeffrey' in them."""
        name = e.canonical_name
        if not is_clean_name(name):
            return (0, 0, 0)  # Filenames get lowest priority
        has_jeffrey = 1 if 'jeffrey' in name.lower() else 0
        has_space = 1 if ' ' in name else 0  # Prefer full names
        return (1, has_jeffrey, has_space)  # Clean names first

    if epstein_variants:
        # Filter to only clean names for canonical selection
        clean_variants = [e for e in epstein_variants if is_clean_name(e.canonical_name)]

        if clean_variants:
            clean_variants.sort(key=name_quality, reverse=True)
            keep = clean_variants[0]
        else:
            # Fallback: create a clean canonical name
            keep = epstein_variants[0]
            keep.canonical_name = "Jeffrey Epstein"

        merge_ids = [e.id for e in epstein_variants if e.id != keep.id]
        merge_entities(session, keep.id, merge_ids)
        session.commit()
        logger.info(f"  Merged {len(merge_ids)} Epstein variants into '{keep.canonical_name}'")

    # Step 5: Merge Maxwell variants
    logger.info("Merging Maxwell name variants...")
    maxwell_variants = session.query(Entity).filter(
        Entity.canonical_name.ilike('%maxwell%')
    ).all()

    def maxwell_name_quality(e):
        """Score a name - prefer clean names with 'ghislaine' in them."""
        name = e.canonical_name
        if not is_clean_name(name):
            return (0, 0, 0)
        has_ghislaine = 1 if 'ghislaine' in name.lower() else 0
        has_space = 1 if ' ' in name else 0
        return (1, has_ghislaine, has_space)

    if maxwell_variants:
        clean_variants = [e for e in maxwell_variants if is_clean_name(e.canonical_name)]

        if clean_variants:
            clean_variants.sort(key=maxwell_name_quality, reverse=True)
            keep = clean_variants[0]
        else:
            keep = maxwell_variants[0]
            keep.canonical_name = "Ghislaine Maxwell"

        keep.entity_type = 'person'  # Ensure correct type
        merge_ids = [e.id for e in maxwell_variants if e.id != keep.id]
        merge_entities(session, keep.id, merge_ids)
        session.commit()
        logger.info(f"  Merged {len(merge_ids)} Maxwell variants into '{keep.canonical_name}'")

    # Final stats
    final_entities = session.query(Entity).count()
    final_mentions = session.query(Mention).count()

    logger.info(f"\nFinal stats:")
    logger.info(f"  Entities: {final_entities}")
    logger.info(f"  Mentions: {final_mentions}")

    # Top entities after dedup
    top = session.query(Entity).order_by(Entity.mention_count.desc()).limit(30).all()
    logger.info(f"\nTop 30 entities after dedup:")
    for e in top:
        logger.info(f"  {e.mention_count:6} | {e.entity_type:12} | {e.canonical_name[:60]}")

    session.close()


if __name__ == "__main__":
    run_dedup()
