# TODO

## Future

- [ ] Timeline visualization
- [ ] Document relationship mapping
- [ ] Co-occurrence analysis (who appears with whom)
- [ ] Tune rotation, handwriting, and form preprocessing against measured CER/WER
- [ ] Finish the 83-file audio/video transcription batch and deploy transcripts
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
- [x] House Oversight download + OCR + import (estate & DOJ batches in D1)
- [x] Page-level hybrid extraction for mixed native/scanned PDFs
- [x] Configurable source-fidelity redaction audit policy
- [x] OCR CER/WER evaluation and review-set tooling
- [x] Reviewed 50-page stratified OCR reference set and baseline CER/WER report
- [x] Resumable audio/video transcription pipeline
- [x] Local FTS5 rebuild and per-document synchronization
- [x] Faststart streaming remuxes for all 446 videos (streaming/ R2 prefix)
- [x] Source filter UI — `source` param on /api/search + /api/browse, search
  and Documents dropdowns with friendly labels (deployed 2026-07-21)
- [x] Workers plan upgraded; D1 writes restored; "Data Set 8" labels fixed
