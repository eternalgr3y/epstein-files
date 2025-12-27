"""
Search functionality for Epstein Files

Provides:
- Full-text search across documents (FTS5)
- Entity search with role filtering
- Verification queries (does document X say Y?)
"""

import logging
import re
import sqlite3
from typing import List, Optional, Dict, Any
from dataclasses import dataclass
from sqlalchemy import or_, and_, func, text
from sqlalchemy.orm import joinedload
from pathlib import Path

from models import (
    get_engine, get_session, Document, DocumentText, Entity,
    Mention, MentionRole, DocumentType
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

DB_PATH = Path(__file__).parent.parent / "database" / "epstein_files.db"


@dataclass
class SearchResult:
    """A single search result."""
    document_id: int
    filename: str
    title: Optional[str]
    data_set: Optional[str]
    document_type: str
    source_url: str
    relevance_score: float
    snippet: str  # Context around the match
    page_number: Optional[int] = None


@dataclass
class EntitySearchResult:
    """Entity search result with mentions."""
    entity_id: int
    canonical_name: str
    entity_type: str
    mention_count: int
    mentions: List[Dict[str, Any]]


def escape_fts5_query(query: str) -> str:
    """Escape special FTS5 characters to prevent syntax errors."""
    # FTS5 special chars: " * - + ( ) : ^
    # We quote the whole query to treat it as a phrase
    # Remove any existing quotes and problematic chars
    cleaned = query.replace('"', '').replace("'", "")
    # Escape for phrase search
    return f'"{cleaned}"'


def highlight_match(text: str, query: str, context_chars: int = 150) -> str:
    """Extract a snippet around the match and highlight it."""
    if not text:
        return ""

    # Case-insensitive search for the query
    pattern = re.compile(re.escape(query), re.IGNORECASE)
    match = pattern.search(text)

    if not match:
        # Return first N chars if no match found
        return text[:context_chars * 2] + "..." if len(text) > context_chars * 2 else text

    start = max(0, match.start() - context_chars)
    end = min(len(text), match.end() + context_chars)

    snippet = text[start:end]

    # Add ellipsis if truncated
    if start > 0:
        snippet = "..." + snippet
    if end < len(text):
        snippet = snippet + "..."

    return snippet


def search_documents_fts(
    query: str,
    document_type: Optional[str] = None,
    data_set: Optional[str] = None,
    limit: int = 50,
    offset: int = 0
) -> List[SearchResult]:
    """
    Fast full-text search using FTS5.
    """
    if not query or not query.strip():
        return []

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    try:
        # Escape query for FTS5
        fts_query = escape_fts5_query(query.strip())

        # Build query with optional filters
        # Note: contentless FTS5 uses rowid, not column values
        sql = """
            SELECT
                d.id as document_id,
                d.filename,
                d.title,
                d.data_set,
                d.document_type,
                d.source_url,
                snippet(document_fts, 2, '>>>', '<<<', '...', 50) as snippet,
                bm25(document_fts) as rank
            FROM document_fts fts
            JOIN documents d ON d.id = fts.rowid
            WHERE document_fts MATCH ?
        """
        params = [fts_query]

        if document_type:
            sql += " AND d.document_type = ?"
            params.append(document_type)

        if data_set:
            sql += " AND d.data_set = ?"
            params.append(data_set)

        sql += " ORDER BY rank LIMIT ? OFFSET ?"
        params.extend([limit, offset])

        cur.execute(sql, params)
        rows = cur.fetchall()

        results = []
        for row in rows:
            # Clean up snippet markers
            snippet = row['snippet'] or ""
            snippet = snippet.replace('>>>', '**').replace('<<<', '**')

            results.append(SearchResult(
                document_id=row['document_id'],
                filename=row['filename'],
                title=row['title'],
                data_set=row['data_set'],
                document_type=row['document_type'],
                source_url=row['source_url'],
                relevance_score=abs(row['rank']) if row['rank'] else 0.0,
                snippet=snippet
            ))

        return results

    except sqlite3.OperationalError as e:
        logger.warning(f"FTS5 query failed: {e}, falling back to LIKE")
        conn.close()
        return search_documents_like(query, document_type, data_set, limit, offset)
    finally:
        conn.close()


def search_documents_like(
    query: str,
    document_type: Optional[str] = None,
    data_set: Optional[str] = None,
    limit: int = 50,
    offset: int = 0
) -> List[SearchResult]:
    """
    Fallback LIKE-based search (slower but handles edge cases).
    """
    engine = get_engine()
    session = get_session(engine)

    try:
        # Build base query with text join
        q = session.query(Document, DocumentText).outerjoin(
            DocumentText, Document.id == DocumentText.document_id
        )

        # Apply filters
        if document_type:
            q = q.filter(Document.document_type == document_type)
        if data_set:
            q = q.filter(Document.data_set == data_set)

        # Text search - escape LIKE special chars
        if query:
            escaped = query.replace('%', r'\%').replace('_', r'\_')
            q = q.filter(or_(
                Document.title.ilike(f'%{escaped}%', escape='\\'),
                Document.filename.ilike(f'%{escaped}%', escape='\\'),
                DocumentText.full_text.ilike(f'%{escaped}%', escape='\\')
            ))

        q = q.order_by(Document.id.desc())
        q = q.offset(offset).limit(limit)

        results = []
        for doc, text_obj in q.all():
            snippet = ""
            if text_obj and text_obj.full_text:
                snippet = highlight_match(text_obj.full_text, query)
            elif doc.title:
                snippet = doc.title

            results.append(SearchResult(
                document_id=doc.id,
                filename=doc.filename,
                title=doc.title,
                data_set=doc.data_set,
                document_type=doc.document_type,
                source_url=doc.source_url,
                relevance_score=1.0,
                snippet=snippet
            ))

        return results

    finally:
        session.close()


def search_documents(
    query: str,
    document_type: Optional[str] = None,
    data_set: Optional[str] = None,
    limit: int = 50,
    offset: int = 0
) -> List[SearchResult]:
    """
    Full-text search across documents.

    Uses FTS5 for fast search, falls back to LIKE if needed.
    """
    # Try FTS5 first (fast path)
    return search_documents_fts(query, document_type, data_set, limit, offset)


def search_entities(
    query: str,
    role: Optional[str] = None,
    entity_type: Optional[str] = None,
    limit: int = 50
) -> List[EntitySearchResult]:
    """
    Search for entities by name.
    """
    engine = get_engine()
    session = get_session(engine)

    try:
        q = session.query(Entity)

        # Name search
        if query:
            escaped = query.replace('%', r'\%').replace('_', r'\_')
            q = q.filter(or_(
                Entity.canonical_name.ilike(f'%{escaped}%', escape='\\'),
                Entity.first_name.ilike(f'%{escaped}%', escape='\\'),
                Entity.last_name.ilike(f'%{escaped}%', escape='\\')
            ))

        # Type filter
        if entity_type:
            q = q.filter(Entity.entity_type == entity_type)

        q = q.order_by(Entity.mention_count.desc()).limit(limit)

        results = []
        for entity in q.all():
            # Get mentions
            mentions_q = session.query(Mention).filter(Mention.entity_id == entity.id)

            if role:
                mentions_q = mentions_q.filter(Mention.role == role)

            mentions = []
            for mention in mentions_q.limit(20).all():
                doc = session.query(Document).get(mention.document_id)
                mentions.append({
                    'document_id': mention.document_id,
                    'document_filename': doc.filename if doc else None,
                    'name_as_appears': mention.name_as_appears,
                    'role': mention.role,
                    'role_confidence': mention.role_confidence,
                    'context_snippet': mention.context_snippet,
                    'page_number': mention.page_number
                })

            results.append(EntitySearchResult(
                entity_id=entity.id,
                canonical_name=entity.canonical_name,
                entity_type=entity.entity_type,
                mention_count=entity.mention_count,
                mentions=mentions
            ))

        return results

    finally:
        session.close()


def get_entity_mentions(
    entity_id: int,
    role: Optional[str] = None,
    limit: int = 100,
    offset: int = 0
) -> List[Dict[str, Any]]:
    """Get all mentions of a specific entity."""
    engine = get_engine()
    session = get_session(engine)

    try:
        q = session.query(Mention, Document).join(
            Document, Mention.document_id == Document.id
        ).filter(Mention.entity_id == entity_id)

        if role:
            q = q.filter(Mention.role == role)

        q = q.order_by(Mention.role_confidence.desc()).offset(offset).limit(limit)

        results = []
        for mention, doc in q.all():
            results.append({
                'mention_id': mention.id,
                'document_id': doc.id,
                'document_filename': doc.filename,
                'document_title': doc.title,
                'document_type': doc.document_type,
                'data_set': doc.data_set,
                'source_url': doc.source_url,
                'name_as_appears': mention.name_as_appears,
                'role': mention.role,
                'role_confidence': mention.role_confidence,
                'role_evidence': mention.role_evidence,
                'context_snippet': mention.context_snippet,
                'page_number': mention.page_number,
                'extraction_confidence': mention.extraction_confidence
            })

        return results

    finally:
        session.close()


def verify_claim(claim_query: str, entity_name: Optional[str] = None) -> Dict[str, Any]:
    """
    Verify a claim by searching for evidence in documents.
    """
    # Search documents for the claim
    supporting_docs = search_documents(claim_query, limit=20)

    # If entity specified, filter for mentions of that entity
    if entity_name:
        entity_results = search_entities(entity_name, limit=5)

    result = {
        'claim': claim_query,
        'entity': entity_name,
        'supporting_documents': [],
        'total_matches': len(supporting_docs),
        'verification_status': 'unverified',
        'note': 'This is an automated search. Verify by reading the source documents.'
    }

    for doc in supporting_docs[:10]:
        result['supporting_documents'].append({
            'document_id': doc.document_id,
            'filename': doc.filename,
            'title': doc.title,
            'source_url': doc.source_url,
            'snippet': doc.snippet,
            'relevance_score': doc.relevance_score
        })

    if len(supporting_docs) > 0:
        result['verification_status'] = 'evidence_found'

    return result


def get_document_types() -> List[Dict[str, Any]]:
    """Get all document types with counts."""
    engine = get_engine()
    session = get_session(engine)

    try:
        results = session.query(
            Document.document_type,
            func.count(Document.id)
        ).group_by(Document.document_type).all()

        return [{'type': t, 'count': c} for t, c in results]

    finally:
        session.close()


def get_data_sets() -> List[Dict[str, Any]]:
    """Get all data sets with counts."""
    engine = get_engine()
    session = get_session(engine)

    try:
        results = session.query(
            Document.data_set,
            func.count(Document.id)
        ).filter(Document.data_set.isnot(None)).group_by(Document.data_set).all()

        return [{'data_set': ds, 'count': c} for ds, c in results]

    finally:
        session.close()


if __name__ == "__main__":
    import time

    print("=== Search Performance Test ===\n")

    queries = ["Maxwell", "flight", "island", "victim", "FBI"]
    for q in queries:
        start = time.time()
        results = search_documents(q, limit=50)
        elapsed = (time.time() - start) * 1000
        print(f"{q}: {len(results)} results in {elapsed:.1f}ms")
        if results:
            print(f"  Top: {results[0].filename}")
