# Epstein Files Search

A public interest research tool providing searchable access to DOJ Epstein case documents.

## Purpose

This tool helps researchers, journalists, and the public:
- Search 14,600+ documents by keyword
- Look up entities (people, organizations) mentioned
- Verify claims with source documents
- Access primary sources instead of relying on headlines

## Important

**Being mentioned in a document does NOT imply guilt or wrongdoing.**

Many people appear as witnesses, investigators, attorneys, or incidental mentions. Always verify claims by reading the original documents.

## Survivor Resources

If you or someone you know is a survivor of sexual abuse:

**RAINN: 1-800-656-4673** (24/7, free, confidential)

https://www.rainn.org

## Features

- **Full-text search** with FTS5 indexing (~20ms queries)
- **Entity lookup** - 14,000+ named entities with document links
- **Claim verification** - Check claims against source documents
- **Inline document viewer** - Read extracted text without downloading PDFs
- **Rate-limited API** - Prevents abuse

## Tech Stack

- **Backend**: Python/FastAPI
- **Database**: SQLite with FTS5
- **Frontend**: Vanilla HTML/JS
- **Deployment**: Docker + nginx + Let's Encrypt

## Self-Hosting

See [DEPLOY.md](DEPLOY.md) for full instructions.

Quick start:
```bash
# Clone
git clone https://codeberg.org/YOUR_USERNAME/epstein-files.git
cd epstein-files

# Get database (not in git due to size)
# Contact maintainer or rebuild from PDFs

# Run locally
docker compose -f docker-compose.local.yml up --build

# Visit http://localhost:8000
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/search?q=...` | Full-text document search |
| `POST /api/entities/search` | Entity lookup |
| `GET /api/documents/{id}/text` | Get document text |
| `GET /api/documents/{id}/file` | Download original PDF |
| `GET /api/verify?claim=...` | Verify a claim |
| `GET /api/stats` | Database statistics |

## License

Public domain. This is a public interest tool using publicly released government documents.

## Contributing

Issues and PRs welcome. Please keep the survivor-centered focus.

---

*Facts only. No inference. Source everything.*
