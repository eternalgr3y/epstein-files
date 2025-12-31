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
├── R2 Storage (media files)
└── Pages (frontend/index.html)

Local Development:
├── FastAPI (src/api.py)
├── SQLite (epstein_files.db)
└── Local files (raw/, extracted/)
```

## Key Files

| File | Purpose |
|------|---------|
| `src/worker.js` | Production API (Cloudflare Worker) |
| `src/api.py` | Local dev API (FastAPI) |
| `frontend/index.html` | Single-page frontend |
| `wrangler.toml` | Cloudflare config |
| `scrape_dropbox.py` | House Oversight scraper |

## Database Schema

```sql
documents (id, filename, file_type, data_set, file_size, page_count, ...)
entities (id, name, entity_type, mention_count, ...)
mentions (id, document_id, entity_id, context, ...)
document_texts (document_id, text_content)
```

## Current Status

- DOJ documents: Indexed and live
- House Oversight Estate: Downloading (~20k pages)
- House Oversight DOJ: Pending (~33k pages)
- R2 uploads: In progress

## Pending Tasks

1. **Chapter/Source UI** - Filter documents by source (DOJ, House Oversight, etc.)
2. **Process new documents** - OCR and index House Oversight files
3. **Timeline view** - Visualize documents chronologically
4. **Relationship mapping** - Show connections between entities

## Important Notes

- **No inference** - Only state facts from documents
- **Source everything** - Link claims to specific documents
- **Privacy** - Being mentioned doesn't imply wrongdoing
- Many mentions are witnesses, attorneys, investigators

## Deployment

```bash
# Deploy Worker
wrangler deploy

# Deploy Frontend
wrangler pages deploy frontend/ --project-name=epstein

# Upload to R2
rclone sync ./extracted/ r2:epstein-files/extracted/
```

## Environment

- Dropbox token for scrapers: Set DROPBOX_TOKEN env var
- Cloudflare: Use `wrangler login`
- R2: Configure rclone with Cloudflare credentials
