# Agent Instructions

Context for AI agents working on this codebase.

## Project Overview

Searchable archive of Epstein case documents from DOJ and House Oversight releases.

**Live site:** https://epsteinproject.org

## Architecture

```
Production (Cloudflare):
├── Workers API (src/worker.js)
├── D1 Database (SQLite at edge)
├── R2 Storage (PDFs, images)
└── Pages (frontend/index.html)
```

## Key Files

| File | Purpose |
|------|---------|
| `src/worker.js` | Production API (Cloudflare Worker) |
| `frontend/index.html` | Single-page frontend |
| `wrangler.toml` | Cloudflare config |

## Database Schema

**Two separate document tables:**

```sql
-- DOJ Documents (15,102 docs)
documents (
    id, filename, title, document_type, data_set,
    local_path, file_size, page_count, has_text, ...
)

-- House Oversight Documents (2,897 docs, 23,124 pages)
house_oversight_documents (
    id, bates_number, title, page_count, file_size,
    file_hash, has_text, legacy_document_id, ...
)

-- Shared tables
entities (id, canonical_name, entity_type, ...)
mentions (id, document_id, entity_id, name_as_appears, role, ...)
document_fts (document_id, content) -- FTS5 for DOJ search
```

## API Endpoints

**DOJ documents:**
- `GET /api/search?q=...` - Full-text search
- `GET /api/browse` - Browse all
- `GET /api/documents/{id}` - Document metadata
- `GET /api/documents/{id}/file` - PDF file
- `GET /api/documents/{id}/text` - Extracted text

**House Oversight (separate):**
- `GET /api/house-oversight/documents` - List all
- `GET /api/house-oversight/documents?search=...` - Search
- `GET /api/house-oversight/documents/{bates}` - Document detail
- `GET /api/house-oversight/page/{bates}/{page}` - Page image (JPG)
- `GET /api/house-oversight/stats` - Statistics

**Entities:**
- `GET /api/entities/{id}` - Entity detail
- `GET /api/entities/{id}/mentions` - Entity mentions
- `POST /api/entities/search` - Search entities

## Current Status

- DOJ documents: Complete (15,102 PDFs indexed, FTS enabled)
- House Oversight Estate: Complete (2,897 docs, 23,124 page images in R2)
- Entity extraction: Complete (315k mentions, 60k entities)
- R2 storage: Complete (36.5 GB)

## Important Notes

- **DOJ = PDFs**, House Oversight = **JPG page scans**
- **Separate tables** - DOJ uses `documents`, House Oversight uses `house_oversight_documents`
- **Blob URLs for PDFs** - Frontend fetches PDFs as blobs to bypass Chrome cross-origin blocking
- `legacy_document_id` in house_oversight_documents links to mentions table
- **No inference** - Only state facts from documents
- **Source everything** - Link claims to specific documents

## Deployment

```bash
# Deploy Worker API
CLOUDFLARE_API_TOKEN="..." npx wrangler deploy

# Deploy Frontend
CLOUDFLARE_API_TOKEN="..." npx wrangler pages deploy frontend/ --project-name=epstein

# Upload to R2
~/.local/bin/rclone sync ./path r2:epstein-files/path
```

## R2 Storage Structure

```
epstein-files/
├── extracted/           # DOJ PDFs
├── house-oversight/
│   └── IMAGES/
│       ├── 001/        # Pages 010477-012476
│       ├── 002/        # Pages 012477-014476
│       └── ...         # 2000 images per folder
└── frontend/
    └── index.html
```
