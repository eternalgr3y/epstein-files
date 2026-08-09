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
- **D1 rejects statements over ~32-52 KB** with `statement too long:
  SQLITE_TOOBIG`. Measured on 2026-07-27: a 32,071-char statement imports, a
  52,150-char one fails. Since OCR text runs to 236k chars per document, no
  single INSERT can carry one. `export_ocr_sql.py` writes an INSERT with the
  first 20k characters then UPDATEs appending the rest, and populates
  `document_fts` by copying from `document_texts` server-side rather than
  resending the text. Chunking files by row count or by total bytes does NOT
  help -- the limit is per statement.
- Make every generated statement idempotent, because chunks get retried. Guard
  appends on `length(full_text) = <expected prefix>`, not on "the row is ours":
  the latter double-appends when a partial import is re-run.
- **Imports take the live site down briefly.** `wrangler d1 execute` warns that
  the database is unavailable during an import, and it means it -- concurrent
  `/api/documents/<id>/file` requests returned HTTP 500 mid-import, which
  surfaced as failures in an unrelated OCR job that was downloading at the
  time. Do not run bulk imports alongside anything that reads D1 and matters.
- Back-to-back `d1 execute` calls race: the second gets "Not currently
  importing anything" if the previous session has not settled. Sleep a couple
  of seconds between chunks and retry.
- **Expression indexes work and are worth it.** `LOWER(canonical_name)` could
  not use `idx_entities_name`, making entity sibling lookup a 216k-row scan at
  66ms. `CREATE INDEX idx_entities_name_lower ON entities(LOWER(canonical_name))`
  took it to 922 rows at 3ms.
- FTS5 virtual tables (`document_fts`, `house_oversight_fts`) can't be
  exported and don't need backup — rebuildable from document_texts /
  house_oversight_documents.
- **`document_fts.rowid` is NOT `document_id`.** The table is
  `fts5(document_id UNINDEXED, full_text)` and its rowid is an unrelated
  counter — rowid 4080 holds document 4622's text. Joining or filtering on
  rowid silently returns real-looking rows for the wrong documents, which is
  exactly how a "these 2,500 docs are indexed" conclusion got produced from
  data that showed the opposite. **Always join on `document_fts.document_id`.**

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

- **`wrangler pages deploy` tags the deployment with the current git branch.**
  The project's production branch is `main`, so deploying from any other
  branch silently produces a *preview* deployment — wrangler prints "Success"
  and a pages.dev URL, but epsteinproject.org keeps serving the old code.
  Pass `--branch=main` explicitly when deploying from another branch
  (learned 2026-08-09 deploying from the desktop's `production` branch).
- Stored OAuth from `wrangler login` DOES carry Pages deploys in
  non-interactive shells (verified on the desktop 2026-08-09, wrangler 4.54) —
  the CLOUDFLARE_API_TOKEN requirement noted below was observed on the laptop
  before OAuth credentials existed there.
- **Hosting moved to GitHub on 2026-08-09**: origin is
  `https://github.com/eternalgr3y/epstein-files` (public), default branch
  `main`. The Codeberg repo (`thunksuck3r/epstein-files`, renamed from
  `rillow`) is abandoned — its git backend 504s on incremental fetches and
  push auth there is expired. **On the laptop, switch once with:**
  `git remote set-url origin https://github.com/eternalgr3y/epstein-files.git`
  then `git pull` (its main fast-forwards; the old branch name `production`
  from the desktop was renamed to `main` before the first push).
- Desktop (Windows) specifics: repo at `D:\epstein-files`, git auth via
  `gh` CLI (`gh auth setup-git`). bun is not installed; run wrangler as
  `node_modules\.bin\wrangler.cmd` and port bun:test assertions to node
  when needed.
- **NEVER run wrangler under bun.** `bunx wrangler deploy` prints its version
  banner, exits **0**, and deploys nothing — silently, every time (3/3). This
  was previously recorded here as "wrangler is flaky"; it is not flaky, it is
  bun. `node_modules/.bin/wrangler` has a `#!/usr/bin/env node` shebang and
  works first try:
  `PATH=~/.local/node/bin:$PATH node_modules/.bin/wrangler deploy`
  Note `package.json`'s `deploy:worker` script still says `bunx wrangler
  deploy` and therefore does not work.
- The exit code is useless here, so still confirm the `Deployed
  epstein-files-api triggers` line and curl the new behaviour before believing
  a deploy landed.
- **Pages deploys need `CLOUDFLARE_API_TOKEN` explicitly**; worker deploys fall
  back to stored OAuth credentials and succeed without sourcing `.env`. A Pages
  deploy without it fails with "In a non-interactive environment, it's
  necessary to set a CLOUDFLARE_API_TOKEN". `~/deploy-pages.sh` handles both
  this and the node-on-PATH requirement.
- Pages: `PATH=~/.local/node/bin:$PATH bun run deploy:pages` (needs Node,
  bun alone won't do it).
- Tests: `bun test` (worker + frontend suites). `bun test | tail` swallows
  the exit code — check the pass/fail line, not the pipeline status.
- Deploys need auth in non-interactive shells: `set -a && source .env &&
  set +a` first (CLOUDFLARE_API_TOKEN lives in .env).

## Analytics

- The .env API token has no Analytics:Read — GraphQL zone analytics
  returns authz errors. Read analytics through the logged-in dashboard
  in Chrome instead (zone → Analytics → HTTP Traffic / Web analytics).
- Web Analytics (RUM) auto-inject does NOT reach Pages-served HTML — it
  silently undercounted ~25x. The site is set to manual-snippet mode;
  the beacon (token deeb9a9acadd4b9e88871189785a062e) is embedded in
  frontend/index.html and functions/_lib/html.js. CSP already allowlists
  static.cloudflareinsights.com (script-src) + cloudflareinsights.com
  (connect-src) — keep both if the CSP changes.
- Workers Logs is now enabled (`[observability]` in wrangler.toml,
  head_sampling_rate 1), so request/error data is queryable via the
  observability MCP. Before 2026-07-27 it was off and queries returned zero
  events — which reads as "no traffic" rather than "not collecting".
- **Bandwidth is not billed.** CDN bandwidth is unmetered on all plans, R2 has
  zero egress fees, and Workers bill on requests/CPU. 30 GB/month of traffic
  costs nothing; the only R2 charge is storage (~$1.62/mo for 198 GB).

## Caching and replication (learned 2026-07-27)

- **Cloudflare does NOT edge-cache Worker-generated responses.** The
  `Cache-Control` headers the worker sets only instruct the *browser*; the CDN
  ignores them for anything a Worker constructs. This produced a 55/153,560
  cache hit ratio. `withEdgeCache()` in worker.js now wraps the six media
  routes with the Cache API. Range requests bypass it (a cached 206 would
  poison whole-file requests and break video seeking) and objects >100 MB are
  skipped (Cloudflare caps cacheable objects; DOJ-OGR videos exceed 1 GB).
- Caching moves *where* bytes are served from; it does not reduce bandwidth.
  What it cuts is latency, R2 Class B operations, and Worker CPU.
- **D1 read replication requires the Sessions API.** The dashboard toggle alone
  is inert — without `env.DB.withSession(...)` every query still goes to the
  primary. worker.js creates one session per request with
  `'first-unconstrained'` (correct here: zero writes, archive changes only via
  batch imports).
- **Pages HTML shows `cf-cache-status: DYNAMIC`, and that is fine.** Pages
  serves assets from Cloudflare's own distributed network with tiered caching.
  Measured TTFB for cache-busted index.html (86–153 ms) matches a fully cached
  immutable asset (83–121 ms). A "cache everything" rule for HTML buys
  essentially nothing and adds a purge-on-deploy staleness footgun — it was
  proposed, measured, and rejected.
- `frontend/_headers` marks `app.js` and the icons `immutable`. **This makes
  bumping the `?v=` string in index.html mandatory** — editing app.js without
  it strands returning visitors on the old file for a year. index.html itself
  stays `max-age=0`, which is what makes the versioning safe.
- **The SSR pages cache their own HTML for an hour** in the Cache API, keyed on
  path with the query string stripped, so a deploy is invisible until the hour
  is up and no `?cachebust=` on the request can dodge it. The `.env` token has
  no cache-purge scope either. **Bump `PAGE_CACHE_VERSION` in
  `frontend/functions/_lib/html.js`** whenever you change what those pages
  render — it changes every cache key at once and the deploy lands instantly.
- To check a Pages deploy before the cache clears, fetch the preview hostname
  (`https://<hash>.epstein-chd.pages.dev/...`) — separate cache, real code.
- Browsers cache these pages too (`max-age=3600`), so a stale-looking page in
  Chrome after a deploy may just be the local cache; append a query string.

## Server-rendered pages (frontend/functions/)

- These are where **all** organic search traffic lands. Treat them as the
  primary reading surface, not a crawler fallback.
- `_lib/html.js` holds the shared shell, CSS, `setLabel()` and
  `cleanDocTitle()`. **No webfonts there on purpose** — a render-blocking font
  request on the highest-volume template would undo the CWV work.
- **Data traps that bit on 2026-07-27**, all verified in D1:
  - `house_oversight_documents.text_content` is empty on all 2,897 rows; the
    text lives in `document_texts` via `legacy_document_id` (2,895 resolve).
    Reading the column made every estate page say "no extracted text" while
    `/api/search` returned the same documents *with* text.
  - `house_oversight_documents.created_at` is NULL on all 2,897 rows.
  - `documents.title` is NULL on 17,326 rows, and for the 1,657
    `house-oversight-doj` rows it holds the *upload filename*
    (`20250115134822946_Certificate of Service.pdf`) while `filename` holds the
    real Bates. Use `cleanDocTitle()`; do not just prefer one field.
  - `document_type` is a MIME bucket — 19,163 of 22,310 rows are plain `pdf`,
    so it cannot supply a document-kind hint.
- Collection indexes accept `?page=N`. Each page is its **own canonical** —
  pointing them all at the bare path tells Google the deeper pages are
  duplicates and undoes the crawl paths. JSON-LD `position` is absolute across
  the collection, not per page.
- The SSR shell carries an inline theme-sync script (reads the SPA's
  `epstein-project-theme` localStorage key, stamps `data-theme` pre-paint).
  It is allowlisted **by sha256 hash in two places** — the function CSP in
  `_lib/html.js` and `frontend/_headers` (the `_headers` copy is what
  browsers actually receive). Editing that script means recomputing the hash
  over the exact bytes between `<script>` and `</script>` and updating both,
  or the theme silently stops applying.
- A Pages Function **cannot reach the API through the zone**: a subrequest to
  `https://epsteinproject.org/api/...` silently returned nothing and the page
  rendered empty. Use the workers.dev origin
  (`https://epstein-files-api.protonuser597.workers.dev/api/...`).

## Entity data (as of 2026-07-27)

- **41% of `entities` is duplicates.** The table holds two extraction
  vocabularies side by side — spaCy's uppercase `PERSON`/`ORG` (83k rows) and a
  lowercase `person`/`organization` set (133k) — plus exact duplicates within
  each. 27,774 name+type groups hold more than one row; 88,571 of 216,591 rows
  are redundant. `entities.mention_count` is also out of sync with the
  `mentions` table (29,111 claimed vs 370,382 actual rows for Jeffrey Epstein).
- worker.js merges these **at read time** rather than migrating: search groups
  by `LOWER(canonical_name)` + normalised type and sums counts, and the entity/
  mentions endpoints expand an id to its siblings. Repointing 3.7M
  `mentions.entity_id` rows is destructive; this reverts with a deploy.
- Two traps when touching that code: `ORG` and `organization` lowercase to
  different strings so SQL must normalise them the way the JS does, and sibling
  sets have a long tail of one-mention rows (Jeffrey Epstein has 827 siblings,
  826 holding a single mention). Expanding all of them made
  `ORDER BY m.id LIMIT 100` sort every matching mention — 1,418ms over 1.1M
  rows. Queries joining `mentions` use the 20 heaviest siblings instead.

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
- Reliably blocked, so do not waste turns retrying: **sourcing `.env`**
  (`set -a && . ./.env && set +a && …`), **D1 writes via the MCP
  `d1_database_query` tool**, and **typing into dashboard forms** via the
  browser tools. Each needs a staged script the user runs with `!`.
- Long command lines get **truncated by terminal wrapping** when the user
  pastes them — a `bun run deploy:pages` invocation lost its script argument
  this way. Stage anything long as a script at `$HOME` and hand over
  `! ~/name.sh` instead.
- Ready-made staged scripts: `~/deploy-pages.sh`, `~/backfill-texts.sh`,
  `import-ocr.sh` (repo root).

## OCR backfill (added 2026-07-27)

- Originals are **no longer on local disk** — `documents.local_path` points at
  `/mnt/e/...`, a drive that is not attached. R2 is the only source, reachable
  via `/api/documents/<id>/file`, which bypasses the rate limiter because it is
  classed as media delivery.
- `ocr_backfill.py` (repo root) re-OCRs everything with no stored text:
  downloads from R2, renders at 300 DPI, tesseract via TSV for text +
  confidence, results into a resumable local SQLite state file. Then
  `export_ocr_sql.py` → `import-ocr.sh`. ~8 docs/min on 6 workers.
- It deliberately does **not** import `src/ocr_pipeline.py`: that module drives
  the stale local SQLite and expects the missing `/mnt/e` originals.
- Only `status='done'` is exported. Documents that OCR to nothing are recorded
  as `empty` and get **no** `document_texts` row — the worker derives
  `has_text` from that table, so an empty row would recreate the
  "advertises text, then 404s" bug.
- Run under `systemd-inhibit --what=idle:sleep` — this laptop suspends, and a
  multi-hour run will otherwise be interrupted mid-document.
