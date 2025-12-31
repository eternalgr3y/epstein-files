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

```bash
npm install -g wrangler
wrangler login
```

### 1. Create D1 Database

```bash
wrangler d1 create epstein-files-db
# Note the database_id from output
```

### 2. Create R2 Bucket

```bash
wrangler r2 bucket create epstein-files
```

### 3. Configure wrangler.toml

```toml
name = "epstein-files-api"
main = "src/worker.js"
compatibility_date = "2024-01-01"

[vars]
R2_PUBLIC_URL = "https://your-bucket.r2.dev"

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
wrangler d1 execute epstein-files-db --file=documents.sql
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
wrangler deploy
```

### 7. Deploy Frontend

```bash
# Create Pages project
wrangler pages project create epstein

# Deploy
wrangler pages deploy frontend/ --project-name=epstein
```

### 8. Custom Domain

1. Buy domain via Cloudflare Registrar
2. Add CNAME record: `@ → your-pages-project.pages.dev`
3. Add custom domain in Pages settings

---

## VPS Deployment (Alternative)

For self-hosted deployment with nginx + Docker:

### Cost: ~$7/month
- DigitalOcean $6/mo droplet
- Domain ~$12/year

### Setup

```bash
# On server
curl -fsSL https://get.docker.com | sh
git clone https://codeberg.org/rillow/epstein-files.git
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
