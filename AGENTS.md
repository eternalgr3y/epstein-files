# Agent Instructions

Context for AI agents working on this codebase.

## Project Overview

Searchable archive of Jeffrey Epstein case documents. Largest public index with 20,000+ documents and 6M+ entity mentions.

**Live site:** https://epsteinproject.org
**API:** https://epsteinproject.org/api
**Source:** https://github.com/eternalgr3y/epstein-files

## Architecture

```
Cloudflare Stack:
├── Workers API (src/worker.js) - REST API with rate limiting
├── D1 Database (SQLite at edge) - 20k docs, 178k entities, 6M mentions
├── R2 Storage (PDFs, images) - ~40GB
└── Pages (frontend/index.html) - Single-page app
```

## Key Files

| File | Purpose |
|------|---------|
| `src/worker.js` | Production API (Cloudflare Worker) |
| `frontend/index.html` | Single-page frontend |
| `wrangler.toml` | Cloudflare config |
| `scrape_dropbox.py` | House Oversight Dropbox scraper |
| `src/import_house_oversight.py` | Import script for House Oversight data |

## Database Schema

```sql
-- All documents (20,653 total)
documents (
    id, filename, title, document_type, data_set,
    source_url, file_size, page_count, has_text, ...
)

-- Entity recognition (178,011 entities)
entities (id, canonical_name, entity_type, mention_count, ...)

-- Entity mentions (5.8M+ mentions)
mentions (id, document_id, entity_id, name_as_appears, role, ...)

-- Full-text search (FTS5)
document_fts (document_id, content)
```

## Data Sets

| Dataset | Documents | Description |
|---------|-----------|-------------|
| data-set-8 | 10,593 | DOJ primary release |
| house-oversight-estate | 2,897 | House Oversight Committee (JPG scans) |
| court-records | 2,638 | Court filings from CourtListener |
| data-set | 3,136 | DOJ batch |
| Data Set 8 | 419 | DOJ batch |
| data-set-2 | 574 | DOJ batch |
| doj-disclosures | 16 | DOJ disclosure docs |
| maxwell-interview | 11 | 2025 Maxwell proffer transcripts |

## API Endpoints

**Search & Browse:**
- `GET /api/search?q=...` - Full-text search (AND logic)
- `GET /api/browse?data_set=...` - Browse with filters
- `GET /api/stats` - Database statistics

**Documents:**
- `GET /api/documents/{id}` - Document metadata
- `GET /api/documents/{id}/file` - PDF/media file
- `GET /api/documents/{id}/text` - Extracted text
- `GET /api/documents/{id}/thumbnail` - Thumbnail image

**House Oversight (JPG scans):**
- `GET /api/house-oversight/documents` - List all
- `GET /api/house-oversight/documents/{bates}` - Document detail
- `GET /api/house-oversight/page/{bates}/{page}` - Page image

**Entities:**
- `POST /api/entities/search` - Search entities by name
- `GET /api/entities/{id}/mentions` - Entity mentions
- `GET /api/document/{id}/entities` - Entities in a document

## Security

- **Rate limiting:** 100 requests/minute per IP
- **CSP:** Strict Content-Security-Policy headers
- **X-Frame-Options:** SAMEORIGIN (prevents clickjacking)
- **X-Content-Type-Options:** nosniff

## Deployment

```bash
# Deploy Worker API with the repository-pinned Wrangler
CLOUDFLARE_API_TOKEN="..." npm run deploy:worker

# Deploy Frontend
CLOUDFLARE_API_TOKEN="..." npm run deploy:pages

# Upload to R2
~/.local/bin/rclone sync ./path r2:epstein-files/path
```

## R2 Storage Structure

```
epstein-files/
├── extracted/           # DOJ PDFs by data-set
├── court-records/       # CourtListener PDFs
├── house-oversight/
│   └── IMAGES/         # JPG page scans (2000 per folder)
├── thumbnails/         # Document thumbnails
└── doj-disclosures/    # DOJ disclosure PDFs
```

## Important Notes

- **DOJ/Court = PDFs**, House Oversight = **JPG page scans**
- **Blob URLs for PDFs** - Frontend fetches as blobs to bypass Chrome cross-origin issues
- **AND search** - Multi-word searches require ALL terms ("Clinton Wexner" = both)
- **No inference** - Only state facts from documents
- **Source everything** - Link claims to specific documents
- **Entity deduplication needed** - "Bill Clinton" and "BILL CLINTON" are separate entities

## Performance

- Lighthouse score: 100/100
- LCP: 1.7s (async font loading)
- FTS queries: <100ms
- Entity search: <1s even with 6M mentions
