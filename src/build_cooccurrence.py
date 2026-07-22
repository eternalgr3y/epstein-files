#!/usr/bin/env python3
"""Build the entity_cooccurrence table from backup dumps.

Reads the entities and mentions .sql.gz dumps produced by backup_d1.sh /
src/dump_table.py, computes which entities appear in documents together,
and writes an import file for D1.

Co-occurrence only counts documents with <= MAX_DOC_ENTITIES distinct
entities: the archive contains OCR mega-documents naming thousands of
entities, which would contribute billions of meaningless pairs (and
appearing together in a 5,000-name index is not a signal). Each entity
keeps its TOP_N strongest partners with at least MIN_SHARED shared docs.

Usage: build_cooccurrence.py <entities.sql.gz> <mentions.sql.gz> <out.sql>
Import the result with: bunx wrangler d1 execute epstein-files-db --remote --file <out.sql>
"""

import gzip
import sqlite3
import sys
import tempfile
import time

MAX_DOC_ENTITIES = 200
TOP_N = 40
MIN_SHARED = 2
BATCH = 1000


def main():
    entities_gz, mentions_gz, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    t0 = time.time()

    with tempfile.NamedTemporaryFile(suffix='.db') as tmp:
        db = sqlite3.connect(tmp.name)
        db.executescript('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;')
        for path in (entities_gz, mentions_gz):
            print(f'loading {path}', file=sys.stderr)
            with gzip.open(path, 'rt', encoding='utf-8') as fh:
                db.executescript(fh.read())

        db.executescript(f'''
            CREATE TABLE doc_entities AS SELECT DISTINCT document_id, entity_id FROM mentions;
            CREATE TABLE small_doc_entities AS
              SELECT document_id, entity_id FROM doc_entities
              WHERE document_id IN (
                SELECT document_id FROM doc_entities
                GROUP BY document_id HAVING COUNT(*) <= {MAX_DOC_ENTITIES});
            CREATE INDEX sde_doc ON small_doc_entities(document_id);
            CREATE TABLE pair_counts AS
              SELECT a.entity_id e1, b.entity_id e2, COUNT(*) shared_docs
              FROM small_doc_entities a JOIN small_doc_entities b
                ON a.document_id = b.document_id AND a.entity_id < b.entity_id
              GROUP BY a.entity_id, b.entity_id;
            CREATE TABLE cooc_top AS
              SELECT entity_id, other_entity_id, shared_docs FROM (
                SELECT entity_id, other_entity_id, shared_docs,
                       ROW_NUMBER() OVER (PARTITION BY entity_id
                                          ORDER BY shared_docs DESC, other_entity_id) rn
                FROM (
                  SELECT e1 entity_id, e2 other_entity_id, shared_docs
                  FROM pair_counts WHERE shared_docs >= {MIN_SHARED}
                  UNION ALL
                  SELECT e2, e1, shared_docs
                  FROM pair_counts WHERE shared_docs >= {MIN_SHARED})
              ) WHERE rn <= {TOP_N};
        ''')

        rows = db.execute(
            'SELECT entity_id, other_entity_id, shared_docs FROM cooc_top ORDER BY entity_id, shared_docs DESC'
        ).fetchall()

    with open(out_path, 'w', encoding='utf-8') as out:
        out.write('DROP TABLE IF EXISTS entity_cooccurrence;\n')
        out.write('CREATE TABLE entity_cooccurrence (\n'
                  '    entity_id INTEGER NOT NULL,\n'
                  '    other_entity_id INTEGER NOT NULL,\n'
                  '    shared_docs INTEGER NOT NULL,\n'
                  '    PRIMARY KEY (entity_id, other_entity_id)\n'
                  ') WITHOUT ROWID;\n')
        for start in range(0, len(rows), BATCH):
            chunk = rows[start:start + BATCH]
            values = ',\n'.join(f'({a},{b},{s})' for a, b, s in chunk)
            out.write(f'INSERT INTO entity_cooccurrence VALUES\n{values};\n')

    print(f'{len(rows):,} rows -> {out_path} in {time.time()-t0:.0f}s', file=sys.stderr)


if __name__ == '__main__':
    main()
