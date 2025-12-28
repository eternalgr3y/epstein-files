"""
REST API for Epstein Files

FastAPI-based API providing:
- Document search and retrieval
- Entity lookup
- Claim verification
- Statistics
"""

from typing import Optional, List, Dict, Any
import os
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pathlib import Path
import logging
import time
from functools import lru_cache
from collections import OrderedDict
import threading
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from models import (
    get_engine, get_session, Document, DocumentText, Entity,
    Mention, ProcessingStatus
)
from search import (
    search_documents, search_entities, get_entity_mentions,
    get_document_types, get_data_sets
)
from importer import get_document_stats

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# =============================================================================
# SIMPLE LRU CACHE FOR SEARCH RESULTS
# =============================================================================

class SearchCache:
    """Thread-safe LRU cache for search results."""

    def __init__(self, max_size: int = 100, ttl_seconds: int = 300):
        self.max_size = max_size
        self.ttl = ttl_seconds
        self.cache: OrderedDict = OrderedDict()
        self.timestamps: Dict[str, float] = {}
        self.lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    def get(self, key: str) -> Optional[Any]:
        with self.lock:
            if key in self.cache:
                # Check TTL
                if time.time() - self.timestamps[key] < self.ttl:
                    # Move to end (most recently used)
                    self.cache.move_to_end(key)
                    self.hits += 1
                    return self.cache[key]
                else:
                    # Expired
                    del self.cache[key]
                    del self.timestamps[key]
            self.misses += 1
            return None

    def set(self, key: str, value: Any):
        with self.lock:
            if key in self.cache:
                self.cache.move_to_end(key)
            else:
                if len(self.cache) >= self.max_size:
                    # Remove oldest
                    oldest = next(iter(self.cache))
                    del self.cache[oldest]
                    del self.timestamps[oldest]
            self.cache[key] = value
            self.timestamps[key] = time.time()

    def stats(self) -> Dict[str, Any]:
        with self.lock:
            total = self.hits + self.misses
            hit_rate = self.hits / total if total > 0 else 0
            return {
                "size": len(self.cache),
                "max_size": self.max_size,
                "hits": self.hits,
                "misses": self.misses,
                "hit_rate": f"{hit_rate:.1%}"
            }

    def clear(self):
        with self.lock:
            self.cache.clear()
            self.timestamps.clear()
            self.hits = 0
            self.misses = 0


# Global cache instance
search_cache = SearchCache(max_size=200, ttl_seconds=300)

# Rate limiter
limiter = Limiter(key_func=get_remote_address)

# FastAPI app
app = FastAPI(
    title="Epstein Files API",
    description="""
    API for searching and accessing the DOJ Epstein Files.

    ## Purpose
    This API provides access to publicly released DOJ documents for research and verification purposes.

    ## Important Notes
    - Being mentioned in a document does NOT imply guilt or wrongdoing
    - Always verify claims by reading the source documents
    - Roles are assigned based on document context and may be uncertain

    ## Survivor Resources
    If you or someone you know is a survivor: RAINN 1-800-656-4673
    """,
    version="1.0.0"
)

# Rate limiting
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS - configure for production
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Frontend - serve static files
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

@app.get("/", response_class=HTMLResponse)
@app.get("/app", response_class=HTMLResponse)
async def serve_frontend():
    """Serve the frontend."""
    path = FRONTEND_DIR / "index.html"
    if path.exists():
        return HTMLResponse(content=path.read_text(), status_code=200)
    raise HTTPException(status_code=404, detail="Frontend not found")


# ============================================================================
# MODELS
# ============================================================================

class SearchRequest(BaseModel):
    query: str
    document_type: Optional[str] = None
    data_set: Optional[str] = None
    limit: int = 50
    offset: int = 0


class EntitySearchRequest(BaseModel):
    query: str
    role: Optional[str] = None
    entity_type: Optional[str] = None
    limit: int = 50


class DocumentResponse(BaseModel):
    id: int
    filename: str
    title: Optional[str]
    document_type: str
    data_set: Optional[str]
    source_url: str
    file_size: Optional[int]
    page_count: Optional[int]
    has_text: bool
    processing_status: str


# ============================================================================
# ROUTES
# ============================================================================

@app.get("/api")
async def api_info():
    """API info - returns basic info and important disclaimers."""
    return {
        "name": "Epstein Files API",
        "version": "1.0.0",
        "disclaimer": "Being mentioned in a document does NOT imply guilt. Verify claims by reading source documents.",
        "survivor_resources": {
            "RAINN": "1-800-656-4673",
            "website": "https://www.rainn.org"
        },
        "endpoints": {
            "search": "/api/search",
            "documents": "/api/documents",
            "entities": "/api/entities",
            "stats": "/api/stats"
        }
    }


@app.get("/api/browse")
async def browse_documents(
    limit: int = Query(24, le=100, ge=1),
    offset: int = Query(0, ge=0),
    filter: Optional[str] = Query(None, description="Filter: 'photos', 'videos', 'audio', 'docs'")
):
    """Browse all documents with pagination and optional filter."""
    engine = get_engine()
    session = get_session(engine)
    try:
        q = session.query(Document)

        if filter == "photos":
            q = q.filter(Document.category == "photo")
        elif filter == "videos":
            q = q.filter(Document.category == "video")
        elif filter == "audio":
            q = q.filter(Document.category == "audio")
        elif filter == "docs":
            q = q.filter(Document.category == "document")

        total = q.count()
        docs = q.order_by(Document.id.desc()).offset(offset).limit(limit).all()
        return {
            "total": total,
            "offset": offset,
            "filter": filter,
            "results": [
                {"document_id": d.id, "filename": d.filename, "title": d.title, "data_set": d.data_set}
                for d in docs
            ]
        }
    finally:
        session.close()


@app.get("/api/stats")
async def get_stats():
    """Get overall statistics about the document collection."""
    engine = get_engine()
    session = get_session(engine)

    try:
        stats = get_document_stats(session)
        stats['document_types'] = get_document_types()
        stats['data_sets'] = get_data_sets()
        return stats
    finally:
        session.close()


@app.post("/api/search")
async def search(request: SearchRequest):
    """
    Search documents by text content.

    Returns documents matching the query with relevance snippets.
    """
    results = search_documents(
        query=request.query,
        document_type=request.document_type,
        data_set=request.data_set,
        limit=request.limit,
        offset=request.offset
    )

    return {
        "query": request.query,
        "total_results": len(results),
        "results": [
            {
                "document_id": r.document_id,
                "filename": r.filename,
                "title": r.title,
                "data_set": r.data_set,
                "document_type": r.document_type,
                "source_url": r.source_url,
                "relevance_score": r.relevance_score,
                "snippet": r.snippet
            }
            for r in results
        ]
    }


@app.get("/api/search")
@limiter.limit("30/minute")
async def search_get(
    request: Request,
    q: str = Query(..., description="Search query", min_length=1, max_length=200),
    document_type: Optional[str] = Query(None, description="Filter by document type"),
    data_set: Optional[str] = Query(None, description="Filter by data set"),
    limit: int = Query(50, le=100, ge=1),
    offset: int = Query(0, ge=0)
):
    """Search documents (GET endpoint for simple queries)."""
    # Sanitize input
    q = q.strip()
    if not q:
        raise HTTPException(status_code=400, detail="Query cannot be empty")

    # Check cache
    cache_key = f"search:{q}:{document_type}:{data_set}:{limit}:{offset}"
    cached = search_cache.get(cache_key)
    if cached:
        cached['cached'] = True
        return cached

    try:
        results = search_documents(
            query=q,
            document_type=document_type,
            data_set=data_set,
            limit=limit,
            offset=offset
        )
    except Exception as e:
        logger.error(f"Search error: {e}")
        raise HTTPException(status_code=500, detail="Search failed. Please try again.")

    response = {
        "query": q,
        "total_results": len(results),
        "cached": False,
        "results": [
            {
                "document_id": r.document_id,
                "filename": r.filename,
                "title": r.title,
                "data_set": r.data_set,
                "document_type": r.document_type,
                "source_url": r.source_url,
                "relevance_score": r.relevance_score,
                "snippet": r.snippet
            }
            for r in results
        ]
    }

    # Cache the response
    search_cache.set(cache_key, response.copy())

    return response


@app.get("/api/cache/stats")
async def cache_stats():
    """Get cache statistics."""
    return search_cache.stats()


@app.post("/api/cache/clear")
async def cache_clear():
    """Clear the search cache."""
    search_cache.clear()
    return {"status": "cleared"}


@app.get("/api/documents/{document_id}")
async def get_document(document_id: int):
    """Get a specific document by ID."""
    engine = get_engine()
    session = get_session(engine)

    try:
        doc = session.query(Document).get(document_id)
        if not doc:
            raise HTTPException(status_code=404, detail="Document not found")

        # Get text if available
        text = session.query(DocumentText).filter_by(document_id=document_id).first()

        return {
            "id": doc.id,
            "filename": doc.filename,
            "title": doc.title,
            "document_type": doc.document_type,
            "data_set": doc.data_set,
            "category": doc.category,
            "source_url": doc.source_url,
            "source_page": doc.source_page,
            "file_size": doc.file_size,
            "file_hash": doc.file_hash,
            "page_count": doc.page_count,
            "has_text": doc.has_text,
            "processing_status": doc.processing_status,
            "ocr_confidence": doc.ocr_confidence,
            "download_timestamp": doc.download_timestamp.isoformat() if doc.download_timestamp else None,
            "text_preview": text.full_text[:2000] if text and text.full_text else None,
            "word_count": text.word_count if text else 0
        }
    finally:
        session.close()


@app.get("/api/documents/{document_id}/text")
async def get_document_text(document_id: int, page: Optional[int] = None):
    """Get full text content of a document."""
    engine = get_engine()
    session = get_session(engine)

    try:
        doc = session.query(Document).get(document_id)
        if not doc:
            raise HTTPException(status_code=404, detail="Document not found")

        text = session.query(DocumentText).filter_by(document_id=document_id).first()
        if not text:
            raise HTTPException(status_code=404, detail="No text content available")

        if page is not None and text.pages_text:
            if 0 <= page < len(text.pages_text):
                return {
                    "document_id": document_id,
                    "page": page,
                    "total_pages": len(text.pages_text),
                    "text": text.pages_text[page]
                }
            else:
                raise HTTPException(status_code=404, detail="Page not found")

        return {
            "document_id": document_id,
            "total_pages": len(text.pages_text) if text.pages_text else 1,
            "word_count": text.word_count,
            "full_text": text.full_text
        }
    finally:
        session.close()


@app.get("/api/documents/{document_id}/file")
async def get_document_file(document_id: int):
    """Download the original document file."""
    engine = get_engine()
    session = get_session(engine)

    try:
        doc = session.query(Document).get(document_id)
        if not doc:
            raise HTTPException(status_code=404, detail="Document not found")

        file_path = Path(doc.local_path)
        if not file_path.exists():
            raise HTTPException(status_code=404, detail="File not found on disk")

        return FileResponse(
            path=str(file_path),
            filename=doc.filename,
            media_type=doc.content_type or 'application/octet-stream'
        )
    finally:
        session.close()


# =============================================================================
# IMAGE API
# =============================================================================

THUMBNAIL_DIR = Path(__file__).parent.parent / "thumbnails"
THUMBNAIL_DIR.mkdir(exist_ok=True)

def generate_page_image(pdf_path: Path, page: int, width: int = 800) -> Path:
    """Generate image from PDF page using PyMuPDF."""
    import fitz

    cache_name = f"{pdf_path.stem}_p{page}_w{width}.png"
    cache_path = THUMBNAIL_DIR / cache_name

    if cache_path.exists():
        return cache_path

    doc = fitz.open(str(pdf_path))
    if page < 0 or page >= len(doc):
        doc.close()
        raise ValueError(f"Page {page} out of range")

    pg = doc[page]
    # Scale to target width
    scale = width / pg.rect.width
    mat = fitz.Matrix(scale, scale)
    pix = pg.get_pixmap(matrix=mat)
    pix.save(str(cache_path))
    doc.close()

    return cache_path


@app.get("/api/documents/{document_id}/thumbnail")
async def get_document_thumbnail(
    document_id: int,
    width: int = Query(400, ge=100, le=1200)
):
    """Get thumbnail of document's first page."""
    engine = get_engine()
    session = get_session(engine)

    try:
        doc = session.query(Document).get(document_id)
        if not doc:
            raise HTTPException(status_code=404, detail="Document not found")

        file_path = Path(doc.local_path)
        if not file_path.exists():
            raise HTTPException(status_code=404, detail="File not found")

        if not file_path.suffix.lower() == '.pdf':
            raise HTTPException(status_code=400, detail="Thumbnails only for PDFs")

        try:
            img_path = generate_page_image(file_path, 0, width)
            return FileResponse(str(img_path), media_type="image/png")
        except Exception as e:
            logger.error(f"Thumbnail generation failed: {e}")
            raise HTTPException(status_code=500, detail="Failed to generate thumbnail")
    finally:
        session.close()


@app.get("/api/documents/{document_id}/pages/{page}/image")
async def get_page_image(
    document_id: int,
    page: int,
    width: int = Query(800, ge=100, le=2000)
):
    """Get image of a specific page."""
    engine = get_engine()
    session = get_session(engine)

    try:
        doc = session.query(Document).get(document_id)
        if not doc:
            raise HTTPException(status_code=404, detail="Document not found")

        file_path = Path(doc.local_path)
        if not file_path.exists():
            raise HTTPException(status_code=404, detail="File not found")

        if not file_path.suffix.lower() == '.pdf':
            raise HTTPException(status_code=400, detail="Page images only for PDFs")

        try:
            img_path = generate_page_image(file_path, page, width)
            return FileResponse(str(img_path), media_type="image/png")
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except Exception as e:
            logger.error(f"Page image generation failed: {e}")
            raise HTTPException(status_code=500, detail="Failed to generate image")
    finally:
        session.close()


@app.post("/api/entities/search")
@limiter.limit("30/minute")
async def search_entities_post(request: Request, body: EntitySearchRequest):
    """Search for entities by name."""
    results = search_entities(
        query=body.query,
        role=body.role,
        entity_type=body.entity_type,
        limit=body.limit
    )

    return {
        "query": body.query,
        "total_results": len(results),
        "results": [
            {
                "entity_id": r.entity_id,
                "canonical_name": r.canonical_name,
                "entity_type": r.entity_type,
                "mention_count": r.mention_count,
                "mentions": r.mentions
            }
            for r in results
        ]
    }


@app.get("/api/entities/{entity_id}")
async def get_entity(entity_id: int):
    """Get a specific entity by ID."""
    engine = get_engine()
    session = get_session(engine)

    try:
        entity = session.query(Entity).get(entity_id)
        if not entity:
            raise HTTPException(status_code=404, detail="Entity not found")

        return {
            "id": entity.id,
            "canonical_name": entity.canonical_name,
            "entity_type": entity.entity_type,
            "first_name": entity.first_name,
            "last_name": entity.last_name,
            "aliases": entity.aliases,
            "description": entity.description,
            "is_public_figure": entity.is_public_figure,
            "disambiguation_notes": entity.disambiguation_notes,
            "confidence": entity.confidence,
            "mention_count": entity.mention_count,
            "needs_review": entity.needs_review
        }
    finally:
        session.close()


@app.get("/api/entities/{entity_id}/mentions")
async def get_mentions(
    entity_id: int,
    role: Optional[str] = None,
    limit: int = Query(100, le=500),
    offset: int = Query(0, ge=0)
):
    """
    Get all mentions of an entity with document context.

    IMPORTANT: Mentions include roles (victim, witness, accused, etc.)
    Role indicates how the person appears in that specific document,
    NOT an overall characterization.
    """
    engine = get_engine()
    session = get_session(engine)

    try:
        entity = session.query(Entity).get(entity_id)
        if not entity:
            raise HTTPException(status_code=404, detail="Entity not found")

        mentions = get_entity_mentions(entity_id, role=role, limit=limit, offset=offset)

        return {
            "entity_id": entity_id,
            "entity_name": entity.canonical_name,
            "role_filter": role,
            "total_mentions": len(mentions),
            "disclaimer": "Role indicates appearance in specific document, not overall characterization",
            "mentions": mentions
        }
    finally:
        session.close()


@app.get("/api/roles")
async def get_roles():
    """Get all possible mention roles with descriptions."""
    return {
        "roles": [
            {"role": "victim", "description": "Named as victim in official records"},
            {"role": "witness", "description": "Provided testimony or information"},
            {"role": "investigator", "description": "Law enforcement or prosecutor"},
            {"role": "legal_counsel", "description": "Attorney"},
            {"role": "accused", "description": "Named in indictment or allegations"},
            {"role": "associate", "description": "Business or social connection documented"},
            {"role": "mentioned", "description": "Name appears, role unclear"},
            {"role": "author", "description": "Wrote the document"},
            {"role": "recipient", "description": "Received the document"},
            {"role": "unknown", "description": "Cannot determine from context"}
        ],
        "disclaimer": "Role indicates appearance in a specific document. A person may have different roles in different documents."
    }


@app.get("/api/document-types")
async def document_types():
    """Get all document types with counts."""
    return {"document_types": get_document_types()}


@app.get("/api/data-sets")
async def data_sets():
    """Get all data sets with counts."""
    return {"data_sets": get_data_sets()}


# ============================================================================
# UTILITY ENDPOINTS
# ============================================================================

@app.get("/health")
async def health_check():
    """Health check for monitoring."""
    return {"status": "healthy"}


@app.get("/robots.txt")
async def robots_txt():
    """Robots.txt - rate limit crawlers."""
    return HTMLResponse(
        content="""User-agent: *
Allow: /
Disallow: /api/
Crawl-delay: 10
""",
        media_type="text/plain"
    )


# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
