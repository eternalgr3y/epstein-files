"""
Database models for Epstein Files Project

SQLAlchemy ORM models with full provenance tracking.
Designed for SQLite initially, can migrate to PostgreSQL for production.
"""

from datetime import datetime
from typing import Optional, List
from sqlalchemy import (
    create_engine, Column, Integer, String, Text, DateTime,
    Float, Boolean, ForeignKey, Enum, Table, Index, JSON
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker
from enum import Enum as PyEnum

Base = declarative_base()


# ============================================================================
# ENUMS
# ============================================================================

class DocumentType(PyEnum):
    """Type of document."""
    PDF = "pdf"
    IMAGE = "image"
    EMAIL = "email"
    COURT_RECORD = "court_record"
    FLIGHT_LOG = "flight_log"
    FBI_NOTES = "fbi_notes"
    NEWS_CLIP = "news_clip"
    VIDEO = "video"
    OTHER = "other"


class MentionRole(PyEnum):
    """Role of an entity in a document. Critical for responsible reporting."""
    VICTIM = "victim"                  # Named as victim in official records
    WITNESS = "witness"                # Provided testimony/information
    INVESTIGATOR = "investigator"      # Law enforcement, prosecutors
    LEGAL_COUNSEL = "legal_counsel"    # Attorneys
    ACCUSED = "accused"                # Named in indictment/allegations
    ASSOCIATE = "associate"            # Business/social connection documented
    MENTIONED = "mentioned"            # Name appears, role unclear
    AUTHOR = "author"                  # Wrote the document
    RECIPIENT = "recipient"            # Received the document
    UNKNOWN = "unknown"                # Cannot determine from context


class RelationshipType(PyEnum):
    """Type of relationship between entities."""
    MET = "met"                        # Evidence they met
    WORKED_WITH = "worked_with"        # Professional relationship
    EMPLOYED_BY = "employed_by"        # Employment relationship
    FLEW_WITH = "flew_with"            # On same flight
    TRAVELED_WITH = "traveled_with"    # Traveled together
    FAMILY = "family"                  # Family relationship
    FRIEND = "friend"                  # Social relationship
    LEGAL_REPRESENTED = "legal_represented"  # Attorney-client
    INVESTIGATED = "investigated"      # Investigator-subject
    COMMUNICATED = "communicated"      # Email/letter correspondence
    UNKNOWN = "unknown"                # Relationship exists but type unclear


class EntityType(PyEnum):
    """Type of entity."""
    PERSON = "person"
    ORGANIZATION = "organization"
    LOCATION = "location"
    AIRCRAFT = "aircraft"
    PROPERTY = "property"


class ProcessingStatus(PyEnum):
    """Processing pipeline status."""
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    NEEDS_REVIEW = "needs_review"


# ============================================================================
# CORE MODELS
# ============================================================================

class Document(Base):
    """
    A document from the DOJ release.
    Full provenance tracking for accountability.
    """
    __tablename__ = 'documents'

    id = Column(Integer, primary_key=True)

    # Provenance (where did this come from?)
    source_url = Column(String(2048), nullable=True)  # May be same for many docs from same ZIP
    source_page = Column(String(2048))  # Page we found the link on
    data_set = Column(String(100))  # e.g., "data-set-1"
    category = Column(String(100))  # e.g., "doj-disclosures", "court-records"

    # File info
    filename = Column(String(512), nullable=False)
    local_path = Column(String(2048), nullable=False)
    file_hash = Column(String(64))  # SHA-256 for deduplication/verification
    file_size = Column(Integer)
    content_type = Column(String(100))

    # Classification
    document_type = Column(String(50), default=DocumentType.OTHER.value)
    title = Column(String(1024))
    description = Column(Text)

    # Dates
    document_date = Column(DateTime)  # Date of the document itself
    download_timestamp = Column(DateTime, default=datetime.utcnow)
    last_modified = Column(String(100))  # From HTTP headers

    # Processing status
    processing_status = Column(String(50), default=ProcessingStatus.PENDING.value)
    ocr_confidence = Column(Float)  # 0.0 - 1.0, how confident is OCR?
    ocr_completed_at = Column(DateTime)

    # Content
    page_count = Column(Integer)
    has_text = Column(Boolean, default=False)  # Does it have extractable text?
    needs_ocr = Column(Boolean, default=True)

    # Content warnings
    contains_graphic_content = Column(Boolean, default=False)
    content_warning = Column(String(500))

    # Metadata
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    text_content = relationship("DocumentText", back_populates="document", uselist=False)
    mentions = relationship("Mention", back_populates="document")

    __table_args__ = (
        Index('idx_documents_data_set', 'data_set'),
        Index('idx_documents_type', 'document_type'),
        Index('idx_documents_status', 'processing_status'),
        Index('idx_documents_hash', 'file_hash'),
    )


class DocumentText(Base):
    """
    Extracted text content from a document.
    Separated from Document to keep main table lean.
    """
    __tablename__ = 'document_texts'

    id = Column(Integer, primary_key=True)
    document_id = Column(Integer, ForeignKey('documents.id'), nullable=False, unique=True)

    # Full text content
    full_text = Column(Text)

    # Per-page text (JSON array of strings)
    pages_text = Column(JSON)  # ["page 1 text", "page 2 text", ...]

    # OCR metadata
    ocr_engine = Column(String(50))  # e.g., "tesseract", "pymupdf"
    ocr_language = Column(String(10), default="eng")
    average_confidence = Column(Float)

    # Word count for quick stats
    word_count = Column(Integer)

    created_at = Column(DateTime, default=datetime.utcnow)

    document = relationship("Document", back_populates="text_content")

    __table_args__ = (
        Index('idx_text_document', 'document_id'),
    )


class Entity(Base):
    """
    A person, organization, or other entity mentioned in documents.
    Canonical representation - multiple mentions link here.
    """
    __tablename__ = 'entities'

    id = Column(Integer, primary_key=True)

    # Identity
    canonical_name = Column(String(500), nullable=False)
    entity_type = Column(String(50), default=EntityType.PERSON.value)

    # For people
    first_name = Column(String(200))
    last_name = Column(String(200))
    aliases = Column(JSON)  # ["Bill", "William", "Will"]

    # Known information (from public sources only)
    description = Column(Text)
    is_public_figure = Column(Boolean, default=False)
    wikipedia_url = Column(String(500))

    # Disambiguation
    disambiguation_notes = Column(Text)  # Why we think this is the right person
    confidence = Column(Float, default=0.5)  # How confident are we in the ID?
    needs_review = Column(Boolean, default=True)

    # Stats
    mention_count = Column(Integer, default=0)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    mentions = relationship("Mention", back_populates="entity")

    __table_args__ = (
        Index('idx_entities_name', 'canonical_name'),
        Index('idx_entities_type', 'entity_type'),
        Index('idx_entities_review', 'needs_review'),
    )


class Mention(Base):
    """
    A specific mention of an entity in a document.
    This is the core link between documents and entities.
    INCLUDES ROLE - critical for responsible reporting.
    """
    __tablename__ = 'mentions'

    id = Column(Integer, primary_key=True)

    document_id = Column(Integer, ForeignKey('documents.id'), nullable=False)
    entity_id = Column(Integer, ForeignKey('entities.id'), nullable=False)

    # What name appeared in the document?
    name_as_appears = Column(String(500), nullable=False)

    # CRITICAL: What role does this person have in this document?
    role = Column(String(50), default=MentionRole.UNKNOWN.value)
    role_confidence = Column(Float, default=0.5)
    role_evidence = Column(Text)  # Why we assigned this role

    # Where in the document?
    page_number = Column(Integer)
    position_start = Column(Integer)  # Character offset
    position_end = Column(Integer)

    # Context (surrounding text for verification)
    context_snippet = Column(Text)  # ~200 chars around the mention

    # Confidence
    extraction_confidence = Column(Float, default=0.5)
    disambiguation_confidence = Column(Float, default=0.5)
    needs_review = Column(Boolean, default=True)

    created_at = Column(DateTime, default=datetime.utcnow)

    # Relationships
    document = relationship("Document", back_populates="mentions")
    entity = relationship("Entity", back_populates="mentions")

    __table_args__ = (
        Index('idx_mentions_document', 'document_id'),
        Index('idx_mentions_entity', 'entity_id'),
        Index('idx_mentions_role', 'role'),
        Index('idx_mentions_review', 'needs_review'),
    )


class Relationship(Base):
    """
    A relationship between two entities.
    Must be backed by documentary evidence.
    """
    __tablename__ = 'relationships'

    id = Column(Integer, primary_key=True)

    entity1_id = Column(Integer, ForeignKey('entities.id'), nullable=False)
    entity2_id = Column(Integer, ForeignKey('entities.id'), nullable=False)

    # Relationship details
    relationship_type = Column(String(50), default=RelationshipType.UNKNOWN.value)
    description = Column(Text)

    # When did this relationship exist?
    start_date = Column(DateTime)
    end_date = Column(DateTime)
    date_approximate = Column(Boolean, default=True)

    # Evidence
    evidence_document_ids = Column(JSON)  # [doc_id, doc_id, ...]
    evidence_description = Column(Text)

    # Confidence
    confidence = Column(Float, default=0.5)
    needs_review = Column(Boolean, default=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    entity1 = relationship("Entity", foreign_keys=[entity1_id])
    entity2 = relationship("Entity", foreign_keys=[entity2_id])

    __table_args__ = (
        Index('idx_relationships_entity1', 'entity1_id'),
        Index('idx_relationships_entity2', 'entity2_id'),
        Index('idx_relationships_type', 'relationship_type'),
    )


class VerifiedClaim(Base):
    """
    A verified (or disputed) claim with sources.
    For the verification feature.
    """
    __tablename__ = 'verified_claims'

    id = Column(Integer, primary_key=True)

    # The claim
    claim_text = Column(Text, nullable=False)
    claim_summary = Column(String(500))  # Short version

    # Verification status
    status = Column(String(50), default="unverified")  # verified, unverified, disputed, false

    # Evidence
    supporting_document_ids = Column(JSON)  # [doc_id, ...]
    contradicting_document_ids = Column(JSON)  # [doc_id, ...]
    evidence_summary = Column(Text)

    # Who made this claim?
    source = Column(String(500))  # e.g., "Social media", "News article"
    source_url = Column(String(2048))

    # Review
    reviewed_by = Column(String(200))
    reviewed_at = Column(DateTime)
    review_notes = Column(Text)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index('idx_claims_status', 'status'),
    )


class ProcessingLog(Base):
    """
    Log of processing activities for debugging and audit.
    """
    __tablename__ = 'processing_logs'

    id = Column(Integer, primary_key=True)

    document_id = Column(Integer, ForeignKey('documents.id'))

    action = Column(String(100), nullable=False)  # e.g., "ocr", "ner", "embedding"
    status = Column(String(50), nullable=False)  # success, failed, skipped

    message = Column(Text)
    error_details = Column(Text)

    duration_ms = Column(Integer)

    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index('idx_logs_document', 'document_id'),
        Index('idx_logs_action', 'action'),
    )


# ============================================================================
# DATABASE SETUP
# ============================================================================

from config import DATABASE_PATH

# Convert Path to string for SQLAlchemy
DEFAULT_DB_PATH = str(DATABASE_PATH)


_engine_cache = {}

def get_engine(db_path: str = None):
    """Create database engine with connection pooling."""
    if db_path is None:
        db_path = DEFAULT_DB_PATH

    if db_path not in _engine_cache:
        _engine_cache[db_path] = create_engine(
            f"sqlite:///{db_path}",
            echo=False,
            pool_size=5,
            max_overflow=10,
            pool_pre_ping=True,
            connect_args={"check_same_thread": False}
        )
    return _engine_cache[db_path]


def create_tables(engine):
    """Create all tables."""
    Base.metadata.create_all(engine)


def get_session(engine):
    """Get a new database session."""
    Session = sessionmaker(bind=engine)
    return Session()


def init_database(db_path: str = None):
    """Initialize the database with all tables."""
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    engine = get_engine(db_path)
    create_tables(engine)
    return engine


if __name__ == "__main__":
    # Initialize database when run directly
    print("Initializing database...")
    engine = init_database()
    print(f"Database created at: {DEFAULT_DB_PATH}")
    print("Tables created:")
    for table in Base.metadata.sorted_tables:
        print(f"  - {table.name}")
