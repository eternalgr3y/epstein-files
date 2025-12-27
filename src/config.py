"""
Configuration for Epstein Files Project
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

# Database - can override with environment variable
DATABASE_PATH = Path(os.getenv("DATABASE_PATH", DATABASE_DIR / "epstein_files.db"))

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

# Ensure directories exist
for d in [RAW_DIR, PROCESSED_DIR, METADATA_DIR, TEXT_DIR, DATABASE_DIR]:
    d.mkdir(parents=True, exist_ok=True)
