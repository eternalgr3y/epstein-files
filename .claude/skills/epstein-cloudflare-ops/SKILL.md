---
name: epstein-cloudflare-ops
description: Operational knowledge for epsteinproject.org's Cloudflare stack (Worker epstein-files-api, D1 epstein-files-db, R2 epstein-files, Pages). Load before doing ANY D1 bulk read/write, backup, media/video serving change, or deploy on this project — several platform behaviors here are broken or surprising and were learned the hard way.
---

# epsteinproject.org Cloudflare operations

Stack: Worker `epstein-files-api` (src/worker.js, route `epsteinproject.org/api/*`),
D1 `epstein-files-db` (~900 MB, id ae344bab-8a31-422d-bb07-fc07d5d69189),
R2 `epstein-files` (public media) + `epstein-files-backups` (private),
Pages project `epstein` (frontend/). Secrets in gitignored `.env` at repo root —
`set -a; source .env; set +a` before wrangler/rclone/curl-API commands.

## D1: export is broken, import is fine

- **NEVER rely on the D1 export API for this database.** Exports die
  server-side with NO error message on large tables (`mentions`, 3.7M rows:
  always) and on any multi-table export. `wrangler d1 export` exits silently
  mid-"Creating export". Worse, completed exports are cached per bookmark —
  a fast "complete" may hand you a stale earlier export (same filename), so a
  "successful" export is not proof the requested tables were dumped.
- Exports also **lock the database** — live-site queries 500 while one runs,
  and a stuck export blocks new ones ("long-running export" error) until it
  times out server-side (minutes).
- **Bulk reads: use `src/dump_table.py <table> <out.sql.gz> [page_size]`** —
  keyset pagination via the `/raw` REST endpoint. No lock, verified
  row-exact. Small page size (100) for tables with big rows
  (document_texts); 5000 otherwise. All base tables have `id INTEGER
  PRIMARY KEY`.
- **Bulk writes: `bunx wrangler d1 execute epstein-files-db --remote --yes
  --file=<path>`** works excellently (839k rows in ~1.5 s). Multi-row
  INSERTs, ~1000 rows per statement. Atomic: on failure the DB rolls back.
- The MCP `d1_database_query` tool is fine for small queries/updates.
- FTS5 virtual tables (`document_fts`, `house_oversight_fts`) can't be
  exported and don't need backup — rebuildable from document_texts /
  house_oversight_documents.

## Backups

- `./backup_d1.sh` dumps the 5 base tables to
  `epstein-files-backups/d1/` (private bucket), keeps newest 8 per table.
  Weekly systemd user timer `epstein-d1-backup.timer` (units in `systemd/`).
- Verify a backup by row counts against production before trusting it.
- The dumps double as analytics inputs: `src/build_cooccurrence.py`
  consumes them (load .sql.gz into local sqlite via python, not sqlite3 CLI
  — not installed).

## R2: never expose r2.dev URLs

- The public dev URL `pub-440e605d59b24afeb9a9d3291bf7a927.r2.dev` is
  **rate-limited by Cloudflare**. After a gallery page bursts ~48 requests,
  the next one can hang tens of seconds. This blocked video poster loads,
  which in turn kept Chrome from even *starting* the video request —
  "video looks dead" reports.
- Serve media by **streaming from the R2 binding in the worker**
  (`r2.get(key)` → `new Response(object.body, …)` with immutable
  Cache-Control), never `Response.redirect` to r2.dev.

## Video serving

- Originals must stay byte-identical (hash provenance). Streaming copies
  live under `streaming/<key>` in R2 (faststart/moov-first remuxes made by
  `remux_faststart.sh`); the worker prefers them for document_type='video'
  and falls back to the original.
- Frontend media branching must trust `document_type` from the API —
  House Oversight DOJ videos have extensionless filenames (DOJ-OGR-…) and
  a missing/omitted content_type once routed them into the PDF viewer,
  which inlined 20 GB files (blank-panel "broken" pages).
- Huge DOJ-OGR videos have ~6 MB moov atoms: metadata load is seconds on
  fast connections, longer on slow ones — that part is physics, not a bug.

## R2 custom domain (media.epsteinproject.org)

- Fronts the `epstein-files` bucket; video /file requests 302 here
  (streaming/ copy preferred; `?download=1` bypasses the redirect to keep
  same-origin streaming so `<a download>` works). CSP media-src must list it.
- API gotcha: the legacy `POST /r2/buckets/<b>/custom_domains` route
  **silently ignores `enabled:true`** — the domain 401s even after SSL goes
  active. Use `PUT /r2/buckets/<b>/domains/custom/<domain>` with
  `{"enabled":true}`. SSL provisioning takes ~20+ min; poll for HTTP 200
  before deploying anything that depends on the domain.
- Ordering matters: never deploy the worker redirect before the domain
  serves 200, or every video breaks.

## Deploys

- Worker: `bunx wrangler deploy`. **Wrangler is flaky here — it has died
  after printing just the version banner multiple times.** Always confirm
  the `Deployed epstein-files-api triggers` line, then curl the new
  behavior on epsteinproject.org; retry the deploy if the line is absent.
- Pages: `PATH=~/.local/node/bin:$PATH bun run deploy:pages` (needs Node,
  bun alone won't do it).
- Tests: `bun test` (worker + frontend suites). `bun test | tail` swallows
  the exit code — check the pass/fail line, not the pipeline status.

## Data conventions

- `documents.data_set` values are kebab-case; the worker aliases the
  legacy label "Data Set 8" → "data-set-8" (DATA_SET_ALIASES) at read time.
  Source groups (SOURCE_GROUPS in worker.js, mirrored in frontend app.js)
  drive the `source` filter param on /api/search and /api/browse.
- `entity_cooccurrence` is precomputed (top 40 partners per entity,
  ≥2 shared docs, docs with ≤200 distinct entities only — mega-documents
  otherwise contribute billions of junk pairs). Regenerate after big
  imports: dump entities+mentions, run `src/build_cooccurrence.py`, import
  the SQL with wrangler.
- Estate docs (house-oversight-estate) ARE searchable (indexed into
  document_fts 2026-07-21; their OCR text always lived in document_texts
  via house_oversight_documents.legacy_document_id). They stay excluded
  from /api/browse only — the Documents page is the DOJ list and estate
  docs have their own gallery. Estate search results must route to the
  house-oversight scan viewer (by bates = filename), not the generic doc
  view. Before assuming a collection "needs OCR", check document_texts
  via legacy id mappings first.

## Browser verification traps

- Chrome will not play video in a hidden tab: `play()` resolves, then the
  element immediately re-pauses with no error. Check
  `document.visibilityState` before concluding playback is broken.
- Chrome may delay issuing a media request until the poster image request
  settles — a stalled poster looks like a dead video.
- The extension's network log only records requests after tracking starts,
  and old entries (including from mid-deploy states) linger — `clear: true`
  and hard-reload before trusting it.

## Permission notes (Claude Code sessions)

- The permission classifier tends to block: bulk D1 imports, systemctl
  enable/start, ssh-keygen/remote changes, and occasionally benign
  compound commands (false positives — retry simpler forms). For blocked
  one-shot commands, hand the user a single line to run with the `!`
  prefix; keep it short enough not to wrap, or stage files at short paths
  (e.g. $HOME) first.
