"""
Configuration for Epstein Files Project

All paths and settings should be imported from here to avoid duplication.
"""

import os
from pathlib import Path

# Base paths - use environment variable or detect automatically
BASE_DIR = Path(os.getenv("EPSTEIN_BASE_DIR", Path(__file__).parent.parent))
RAW_DIR = BASE_DIR / "raw"
PROCESSED_DIR = BASE_DIR / "processed"
METADATA_DIR = PROCESSED_DIR / "metadata"
TEXT_DIR = PROCESSED_DIR / "text"
DATABASE_DIR = BASE_DIR / "database"
EXTRACTED_DIR = BASE_DIR / "extracted"
FRONTEND_DIR = BASE_DIR / "frontend"
THUMBNAIL_DIR = BASE_DIR / "thumbnails"

# Scraper state files
STATE_FILE = BASE_DIR / "scraper_state.json"
LOG_FILE = BASE_DIR / "scraper.log"

# Database - can override with environment variable
DATABASE_PATH = Path(os.getenv("DATABASE_PATH", DATABASE_DIR / "epstein_files.db"))

# R2 CDN URL (when deployed to cloud)
R2_PUBLIC_URL = os.getenv("R2_PUBLIC_URL", "")  # e.g., "https://pub-xxx.r2.dev"

# DOJ URLs
DOJ_BASE_URL = "https://www.justice.gov/epstein"
DOJ_DISCLOSURES_URL = f"{DOJ_BASE_URL}/doj-disclosures"
DOJ_COURT_RECORDS_URL = f"{DOJ_BASE_URL}/court-records"

# Scraper settings
CONCURRENT_DOWNLOADS = 5
DOWNLOAD_DELAY = 0.5  # seconds between requests
REQUEST_TIMEOUT = 60  # seconds

# OCR settings
TESSERACT_LANG = "eng"
OCR_DPI = 300
OCR_PAGE_BATCH_SIZE = int(os.getenv("OCR_PAGE_BATCH_SIZE", "10"))

# The archive preserves and indexes the content contained in source files as
# they were released. Redaction checks therefore warn by default instead of
# suppressing extraction. Set this to "block" for deployments that require a
# fail-closed review gate, or "off" to skip the detector entirely.
REDACTION_POLICY = os.getenv("REDACTION_POLICY", "warn").strip().lower()
if REDACTION_POLICY not in {"warn", "block", "off"}:
    raise ValueError("REDACTION_POLICY must be one of: warn, block, off")

# Ensure directories exist
for d in [RAW_DIR, PROCESSED_DIR, METADATA_DIR, TEXT_DIR, DATABASE_DIR, EXTRACTED_DIR, THUMBNAIL_DIR]:
    d.mkdir(parents=True, exist_ok=True)
