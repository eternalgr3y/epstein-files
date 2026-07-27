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
├── ocr_pipeline.py     # Page-level native/PDF OCR extraction
├── transcription_pipeline.py # Audio/video speech-to-text
├── fts_index.py        # Local FTS5 index maintenance
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

## OCR and transcription

PDF extraction is page-aware: pages with meaningful embedded text use native
extraction, while image-only pages in the same PDF use Tesseract. Redaction
integrity findings are logged but source content is indexed by default. Set
`REDACTION_POLICY=block` to require review or `REDACTION_POLICY=off` to skip
inspection.

```bash
# Rebuild local full-text search after importing an existing database
python rebuild_fts.py

# Create a stratified 50-page reviewed reference set for CER/WER measurement
python ocr_evaluation.py sample --per-band 10
python ocr_evaluation.py evaluate processed/ocr-gold/manifest.jsonl \
  --output processed/ocr-gold/report.json

# Retry one-page low-confidence exhibits; only results crossing 0.50 are saved
python reprocess_low_confidence_ocr.py --dry-run
python reprocess_low_confidence_ocr.py

# Install the optional speech engine without modifying system Python
python -m pip install --target .transcription-deps \
  -r requirements-transcription.txt

# Inspect and process media in resumable batches
python transcribe_media.py --dry-run --limit 100
python transcribe_media.py --status
python transcribe_media.py --limit 10 --model small.en \
  --device cpu --compute-type int8

# Optional: run disjoint shards on machines with spare CPU/RAM
python transcribe_media.py --limit 100 --shard-count 2 --shard-index 0 --cpu-threads 3
python transcribe_media.py --limit 100 --shard-count 2 --shard-index 1 --cpu-threads 3

# Build a bounded, idempotent D1 import after the batch completes
python build_transcript_d1_import.py

# Or wait for the batch and create the export plus an integrity report
python finalize_transcription_batch.py --wait
```

The OCR evaluator fails when any reference file is empty and reports
micro-averaged CER/WER for the whole sample, each confidence band, and every
page. Reference transcriptions should contain only readable, visible text in
reading order; preserve spelling, capitalization, punctuation, exhibit labels,
and Bates stamps, while omitting content hidden by redaction boxes.

## Contributing

PRs welcome. Run tests:

```bash
bun test                              # Worker/frontend tests
python -m unittest discover -s tests  # OCR/FTS/transcription unit tests
RUN_REAL_DATA_TESTS=1 python -m unittest tests.test_ocr_real_data -v
python stress_test.py                 # In-process API tests
python full_system_test.py            # Local-server integration tests
```

### Roadmap

- [ ] Chapter/source filtering UI
- [ ] Timeline visualization
- [ ] Document relationship mapping
- [ ] Tune rotation, handwriting, and form preprocessing against OCR CER/WER
- [ ] Finish media transcription and import transcripts into production D1

## License

MIT License. See [LICENSE](LICENSE).

---

*Facts only. No inference. Source everything.*
