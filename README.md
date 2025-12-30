# Epstein Files

Searchable archive of DOJ Epstein case documents. All documents sourced from [justice.gov/epstein](https://www.justice.gov/epstein).

## What's Included

| Type | Count |
|------|-------|
| Documents | 14,672 PDFs |
| Videos | 419 |
| Audio | 11 |
| Extracted Entities | 31,000+ |
| Entity Mentions | 199,000+ |

## Quick Start

```bash
git clone https://codeberg.org/rillow/epstein-files.git
cd epstein-files

# Download database (36MB → 140MB)
python rebuild_database.py --download

# Run
docker compose -f docker-compose.local.yml up --build
# → http://localhost:8000
```

## Important

**Being mentioned in a document does NOT imply guilt or wrongdoing.**

Many people appear as witnesses, investigators, attorneys, or incidental mentions.

## Survivor Resources

**RAINN: 1-800-656-4673** | https://rainn.org

## Tech Stack

- Python/FastAPI backend
- SQLite + FTS5 full-text search
- Single-file HTML frontend
- Docker deployment

## Project Structure

```
src/
├── api.py              # REST API endpoints
├── models.py           # SQLAlchemy models
├── search.py           # FTS5 search logic
├── entity_extractor.py # spaCy NER pipeline
├── entity_dedup.py     # Entity deduplication
├── scraper.py          # DOJ document scraper
├── ocr_pipeline.py     # PDF text extraction
├── importer.py         # Database import
└── config.py           # Centralized paths/settings

frontend/
└── index.html          # Single-page app (CSS/JS inline)

database/
└── epstein_files.db    # SQLite database (gitignored)
```

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/search?q=...` | Full-text search |
| `GET /api/browse?filter=photos` | Browse by type |
| `POST /api/entities/search` | Entity lookup |
| `GET /api/documents/{id}` | Document metadata |
| `GET /api/documents/{id}/text` | Extracted text |
| `GET /api/documents/{id}/file` | Original file |
| `GET /api/documents/{id}/thumbnail` | Page thumbnail |
| `GET /api/stats` | Database stats |

## Contributing

PRs welcome. Run tests before submitting:

```bash
python stress_test.py      # 83 API tests
python full_system_test.py # 36 integration tests
```

### Areas that need work

- [ ] Better OCR for low-quality scans
- [ ] Timeline visualization
- [ ] Document relationship mapping
- [ ] Co-occurrence analysis (who appears with whom)

## License

MIT License. See [LICENSE](LICENSE).

---

*Facts only. No inference. Source everything.*
