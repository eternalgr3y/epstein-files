# TODO

## In Progress

- [ ] **R2 Upload** - Uploading extracted/ folder (~12GB) to Cloudflare R2
- [ ] **House Oversight Download** - Downloading Estate documents from Dropbox (~20k pages)

## Next Up

- [ ] **Chapter/Source UI** - Add filtering by document source
  - DOJ Release
  - House Oversight Estate
  - House Oversight DOJ

- [ ] **Process House Oversight Docs**
  - OCR the downloaded images
  - Extract entities
  - Import to D1 database

- [ ] **Download House Oversight DOJ** - Second batch (~33k pages)

## Future

- [ ] Timeline visualization
- [ ] Document relationship mapping
- [ ] Co-occurrence analysis (who appears with whom)
- [ ] Better OCR for low-quality scans
- [ ] Mobile UI improvements

## Completed

- [x] DOJ document scraper
- [x] OCR pipeline
- [x] Entity extraction (spaCy NER)
- [x] FTS5 search
- [x] FastAPI backend
- [x] Single-page frontend
- [x] Cloudflare Workers port
- [x] D1 database migration
- [x] R2 storage setup
- [x] Pages deployment
- [x] Custom domain (epsteinproject.org)
- [x] House Oversight Dropbox scraper
