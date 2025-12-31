# Epstein Files

Searchable archive of Epstein case documents. Live at **[epsteinproject.org](https://epsteinproject.org)**

## Data Sources

| Source | Documents | Status |
|--------|-----------|--------|
| [DOJ Release](https://www.justice.gov/epstein) | 14,672 PDFs, 419 videos, 11 audio | Live |
| [House Oversight - Estate](https://oversight.house.gov) | ~20,000 pages | Downloading |
| [House Oversight - DOJ](https://oversight.house.gov) | ~33,000 pages | Pending |

## What's Indexed

| Type | Count |
|------|-------|
| Documents | 14,672 |
| Extracted Entities | 31,000+ |
| Entity Mentions | 199,000+ |
| Videos | 419 |
| Audio Files | 11 |

## Quick Start (Local)

```bash
git clone https://codeberg.org/rillow/epstein-files.git
cd epstein-files

# Download database
python rebuild_database.py --download

# Run locally
docker compose -f docker-compose.local.yml up --build
# → http://localhost:8000
```

## Deployment

Currently deployed on **100% Cloudflare stack** for $0/month hosting:

| Component | Service |
|-----------|---------|
| API | Cloudflare Workers |
| Database | Cloudflare D1 (SQLite at edge) |
| Files/Media | Cloudflare R2 |
| Frontend | Cloudflare Pages |
| Domain | epsteinproject.org |

See [DEPLOY.md](DEPLOY.md) for setup instructions.

## Important

**Being mentioned in a document does NOT imply guilt or wrongdoing.**

Many people appear as witnesses, investigators, attorneys, or incidental mentions.

## Survivor Resources

**RAINN: 1-800-656-4673** | https://rainn.org

## Project Structure

```
src/
├── api.py              # Python/FastAPI backend (local dev)
├── worker.js           # Cloudflare Worker (production)
├── models.py           # SQLAlchemy models
├── search.py           # FTS5 search logic
├── entity_extractor.py # spaCy NER pipeline
├── scraper.py          # DOJ document scraper
├── ocr_pipeline.py     # PDF text extraction
└── config.py           # Paths/settings

frontend/
└── index.html          # Single-page app

scrapers/
├── scrape_oversight.py # House Oversight (Google Drive)
└── scrape_dropbox.py   # House Oversight (Dropbox API)
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/search?q=...` | Full-text search |
| `GET /api/browse?filter=photos` | Browse by type |
| `POST /api/entities/search` | Entity lookup |
| `GET /api/documents/{id}` | Document metadata |
| `GET /api/documents/{id}/text` | Extracted text |
| `GET /api/stats` | Database stats |

## Scrapers

```bash
# DOJ documents
python src/scraper.py

# House Oversight (needs Dropbox token)
DROPBOX_TOKEN=xxx python scrape_dropbox.py house-oversight-estate
```

## Contributing

PRs welcome. Run tests:

```bash
python stress_test.py      # API tests
python full_system_test.py # Integration tests
```

### Roadmap

- [ ] Chapter/source filtering UI
- [ ] Timeline visualization
- [ ] Document relationship mapping
- [ ] Better OCR for low-quality scans

## License

MIT License. See [LICENSE](LICENSE).

---

*Facts only. No inference. Source everything.*
