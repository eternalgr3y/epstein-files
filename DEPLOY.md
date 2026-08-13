# Deploying Epstein Files

## Cloudflare Stack (Recommended - $0/month)

The production site runs entirely on Cloudflare's free tier:

| Component | Service | Cost |
|-----------|---------|------|
| API | Workers | Free (100k req/day) |
| Database | D1 | Free (5GB) |
| Media Storage | R2 | Free (10GB) |
| Frontend | Pages | Free |
| Domain | epsteinproject.org | ~$10/year |

### Prerequisites

Production release commands use the repository-pinned Wrangler and run a
mandatory Python smoke before success. Install Node.js/npm and Python 3.11,
then materialize the exact Bun lock before authenticating:

```bash
npx --yes bun@1.3.14 install --frozen-lockfile
node node_modules/wrangler/bin/wrangler.js login
```

Do not substitute a global Wrangler. `npm run deploy:pages` fails before any
deployment if the local pinned CLI, Python 3.11, clean `main` checkout, or exact
Git HEAD is unavailable.

### 1. Create D1 Database

```bash
node node_modules/wrangler/bin/wrangler.js d1 create epstein-files-db
# Note the database_id from output
```

### 2. Create R2 Bucket

```bash
node node_modules/wrangler/bin/wrangler.js r2 bucket create epstein-files
```

Keep this bucket private. Do not enable an R2 public development URL or attach
a custom media domain. Browser downloads are served by the Worker routes under
`/api/`, where rate limits and `PUBLICATION_EXCLUSIONS` are enforced before the
R2 binding is read.

For an existing production bucket, disabling both public access mechanisms is
a required release step: R2 > bucket > Settings > Public Development URL must
be disabled, and the `media.epsteinproject.org` custom domain must be removed.
Verify that a known old object URL fails before treating an emergency exclusion
as complete.

#### Emergency publication withdrawal

`PUBLICATION_EXCLUSIONS` is deliberately enforced in two independent public
planes: the Worker (API and R2 bytes) and the Pages **production** environment
(SSR HTML, collections and sitemap). Set the identical comma-separated policy
on both public planes before considering a withdrawal complete; valid tokens are `doc:123` and
`house:HOUSE_OVERSIGHT_010477`, with at most 80 combined tokens. A malformed or
oversized policy fails closed.

Pages preview/deployment hosts are not a public third plane only while the
project-level Cloudflare Access policy remains enabled. Access protects old
immutable deployments that cannot receive newer middleware. Current root
middleware additionally redirects every newly built `pages.dev` request before
route code or static fallback runs: the stable project hostname redirects
permanently to the apex, and preview/unknown Pages hostnames redirect
temporarily with `Cache-Control: no-store`. Keep both controls enabled; neither
`noindex` nor new middleware alone retrofits historical deployments. If preview
access is ever made public, first configure the identical
`PUBLICATION_EXCLUSIONS` value in the Pages preview environment and treat it as
a third public plane throughout this checklist.

Withdrawal stops future delivery from origins under project control; it cannot
revoke copies already downloaded by a browser, crawler, cache, archive, or
third party. Normal SSR and sitemap responses require browser revalidation and
may remain in shared caches for up to one hour. Record both the origin cutoff
time and this residual-copy limitation in the incident log.

1. Update the Worker secret/variable and the Pages production environment
   variable to the exact same value. Confirm project-level Access still blocks
   a known historical preview and new middleware redirects a fresh preview;
   otherwise set the same value in the Pages preview environment before
   deploying. Do not deploy only one public plane.
2. Deploy the Worker, then deploy Pages through `npm run deploy:pages` from a
   clean `main` checkout. Active-policy media/SSR/sitemap responses are
   `Cache-Control: no-store`; normal media responses revalidate within 60s.
3. Read back both configured values in Cloudflare without pasting their content
   into logs. Confirm their hashes/lengths match.
4. Verify the numeric document URL, House Bates URL, collection membership,
   sitemap, API metadata/text/file/thumbnail, image/video aliases, and a Range
   request all hide the record. Verify a fresh Pages preview hostname redirects
   to the apex without returning its SSR/sitemap body, a known historical
   preview requires Cloudflare Access, and historical public R2/custom-domain
   URLs still fail.
5. Only then record the withdrawal as complete. Keep the policy in both planes
   until the durable database/content change is deployed and independently
   verified.

### 3. Configure wrangler.toml

```toml
name = "epstein-files-api"
main = "src/worker.js"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "epstein-files-db"
database_id = "your-database-id"

[[r2_buckets]]
binding = "R2"
bucket_name = "epstein-files"
```

### 4. Import Database

```bash
# Export from SQLite
sqlite3 epstein_files.db ".dump documents" > documents.sql
sqlite3 epstein_files.db ".dump entities" > entities.sql
# ... repeat for each table

# Import to D1
node node_modules/wrangler/bin/wrangler.js d1 execute epstein-files-db --file=documents.sql
```

### 5. Upload Media to R2

```bash
# Configure rclone
rclone config
# Add R2 remote with your credentials

# Upload
rclone sync ./raw/ r2:epstein-files/raw/
rclone sync ./extracted/ r2:epstein-files/extracted/
```

### 6. Deploy Worker

```bash
npm run deploy:worker
```

### 7. Deploy Frontend

```bash
# Create Pages project
node node_modules/wrangler/bin/wrangler.js pages project create epstein

# Deploy from the repository root, then run the mandatory production smoke gate.
# This wrapper invokes exactly:
# wrangler --cwd frontend pages deploy . --project-name=epstein --branch=main
npm run deploy:pages
```

Do not run `wrangler pages deploy frontend` or deploy from inside `frontend/`.
Those forms can publish only the static directory and silently omit Pages
Functions. A successful deployment is not complete until the wrapper's
bounded, read-only production requests pass. To rerun that gate without a
deployment, use `npm run qa:release`.

### 8. Custom Domain

1. Buy domain via Cloudflare Registrar
2. Add CNAME record: `@ → your-pages-project.pages.dev`
3. Add custom domain in Pages settings

---

## VPS Deployment (Legacy API/HTML Alternative)

This target serves the legacy SQLite API and the HTML shell, including exact
content-hashed JS/CSS aliases. It deliberately does **not** contain or mount the
private R2 media corpus and is not a feature-equivalent production fallback;
document media routes require a separate private storage design. The CI smoke
therefore validates startup, asset aliases, and `/api/stats`, not Cloudflare R2
delivery or `PUBLICATION_EXCLUSIONS`.

### Cost: ~$7/month
- DigitalOcean $6/mo droplet
- Domain ~$12/year

### Setup

```bash
# On server
curl -fsSL https://get.docker.com | sh
git clone https://github.com/eternalgr3y/epstein-files.git
cd epstein-files

# Copy database
scp database/epstein_files.db root@server:/root/epstein-files/database/

# Deploy
docker compose up -d
```

### Architecture

```
nginx (SSL/rate limiting)
    ↓
FastAPI (search/API)
    ↓
SQLite (FTS5 index)
```

---

## Monitoring

Free uptime monitoring:
- https://uptimerobot.com
- Monitor: https://epsteinproject.org/api/stats

---

## Security Notes

- All data from public government releases
- No user accounts or PII
- Rate limiting at edge (Cloudflare) and app level
- HTTPS enforced
