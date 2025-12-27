#!/usr/bin/env python3
"""
Entity Extraction - Simple parallel version
"""

import sys
import re
import time
import logging
from pathlib import Path
from multiprocessing import Process, Value, Lock, Manager

sys.path.insert(0, str(Path(__file__).parent / 'src'))

from models import get_engine, get_session, Document, DocumentText, Entity, Mention, ProcessingStatus

DB_PATH = "/mnt/e/epstein-files/database/epstein_files.db"

# Name patterns - multiple for different formats
# Two-word names: "Donald Trump"
NAME_2WORD = re.compile(r'\b([A-Z][a-z]+\s+[A-Z][a-z]+)\b')
# With middle initial: "Donald J. Trump" or "Donald J Trump"
NAME_MIDDLE = re.compile(r'\b([A-Z][a-z]+\s+[A-Z]\.?\s+[A-Z][a-z]+)\b')
# Three-word names: "Mary Jo White"
NAME_3WORD = re.compile(r'\b([A-Z][a-z]+\s+[A-Z][a-z]+\s+[A-Z][a-z]+)\b')

# Known public figures
PUBLIC_FIGURES = {
    "Jeffrey Epstein", "Ghislaine Maxwell", "Bill Clinton", "Donald Trump",
    "Prince Andrew", "Alan Dershowitz", "Les Wexner", "Jean-Luc Brunel",
    "Virginia Giuffre", "Sarah Kellen", "Nadia Marcinkova"
}

# False positives to skip
FALSE_POSITIVES = {
    # Locations
    'United States', 'New York', 'Los Angeles', 'San Francisco',
    'Virgin Islands', 'Palm Beach', 'Little Saint', 'Saint James',
    'Puerto Rico', 'North Carolina', 'South Carolina', 'West Virginia',
    'New Jersey', 'New Mexico', 'New Hampshire', 'Rhode Island',
    # Legal/Government
    'Federal Bureau', 'Department Justice', 'Southern District',
    'Eastern District', 'Northern District', 'Western District',
    'Supreme Court', 'District Court', 'Circuit Court',
    # Greetings/Closings
    'Dear Sir', 'Best Regards', 'Thank You', 'Good Morning',
    'Dear Madam', 'Yours Truly', 'Kind Regards',
    # Title + First name combos (false positives from 3-word pattern)
    'President Donald', 'Secretary Clinton', 'Senator John', 'Judge Robert',
    'Attorney General', 'Special Counsel', 'Chief Executive',
}

def extract_names(text: str) -> list:
    if not text:
        return []

    # Collect from all patterns
    matches = set()
    matches.update(NAME_2WORD.findall(text))
    matches.update(NAME_MIDDLE.findall(text))
    matches.update(NAME_3WORD.findall(text))

    # Filter out false positives
    return [n for n in matches if n not in FALSE_POSITIVES and len(n) > 4]

def worker(worker_id: int, doc_ids: list, stats: dict, lock: Lock):
    """Process assigned documents."""
    logging.basicConfig(
        level=logging.INFO,
        format=f'[W{worker_id}] %(asctime)s - %(message)s',
        datefmt='%H:%M:%S'
    )
    logger = logging.getLogger()

    engine = get_engine(DB_PATH)
    session = get_session(engine)

    local_mentions = 0
    local_entities = 0
    processed = 0

    for doc_id in doc_ids:
        try:
            doc = session.query(Document).get(doc_id)
            text = session.query(DocumentText).filter(DocumentText.document_id == doc_id).first()

            if not doc or not text or not text.full_text:
                continue

            names = extract_names(text.full_text)

            for name in names[:30]:  # Cap per doc
                # Get or create entity
                entity = session.query(Entity).filter(Entity.canonical_name == name).first()

                if not entity:
                    entity = Entity(
                        canonical_name=name,
                        entity_type='person',
                        is_public_figure=(name in PUBLIC_FIGURES),
                        mention_count=0
                    )
                    session.add(entity)
                    session.flush()
                    local_entities += 1

                # Check for existing mention
                existing = session.query(Mention).filter(
                    Mention.entity_id == entity.id,
                    Mention.document_id == doc.id
                ).first()

                if not existing:
                    mention = Mention(
                        entity_id=entity.id,
                        document_id=doc.id,
                        name_as_appears=name,
                        role='UNKNOWN',
                        role_confidence=0.5,
                        needs_review=True
                    )
                    session.add(mention)
                    entity.mention_count += 1
                    local_mentions += 1

            session.commit()
            processed += 1

            if processed % 100 == 0:
                with lock:
                    stats['processed'] += 100
                    stats['mentions'] += local_mentions
                    stats['entities'] += local_entities
                    total = stats['processed']
                    logger.info(f"Done {processed}/{len(doc_ids)} | Total: {total} | Mentions: {stats['mentions']}")
                local_mentions = 0
                local_entities = 0

        except Exception as e:
            logger.error(f"Error doc {doc_id}: {e}")
            session.rollback()

    # Final update
    with lock:
        stats['processed'] += (processed % 100)
        stats['mentions'] += local_mentions
        stats['entities'] += local_entities

    session.close()
    logger.info(f"Worker done. Processed {processed} docs.")

def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--workers', '-w', type=int, default=8)
    args = parser.parse_args()

    engine = get_engine(DB_PATH)
    session = get_session(engine)

    # Get all doc IDs with text
    doc_ids = [r[0] for r in session.query(Document.id).join(DocumentText).filter(
        Document.processing_status == ProcessingStatus.COMPLETED.value,
        DocumentText.full_text != ''
    ).all()]

    session.close()

    print(f"=== Entity Extraction ===")
    print(f"Documents to process: {len(doc_ids)}")
    print(f"Workers: {args.workers}")
    print()

    # Split docs among workers
    chunk_size = len(doc_ids) // args.workers + 1
    chunks = [doc_ids[i:i+chunk_size] for i in range(0, len(doc_ids), chunk_size)]

    manager = Manager()
    stats = manager.dict({'processed': 0, 'mentions': 0, 'entities': 0})
    lock = Lock()

    processes = []
    start = time.time()

    for i, chunk in enumerate(chunks):
        if chunk:
            p = Process(target=worker, args=(i, chunk, stats, lock))
            p.start()
            processes.append(p)

    for p in processes:
        p.join()

    elapsed = time.time() - start

    print(f"\n=== Complete ===")
    print(f"Documents: {stats['processed']}")
    print(f"Entities: {stats['entities']}")
    print(f"Mentions: {stats['mentions']}")
    print(f"Time: {elapsed:.1f}s ({stats['processed']/elapsed:.1f} docs/sec)")

if __name__ == "__main__":
    main()
