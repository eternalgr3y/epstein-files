# Deploying Epstein Files Search

## Quick Start

### 1. Get a VPS

**Recommended: DigitalOcean**
- $6/mo droplet (1GB RAM, 25GB SSD)
- Ubuntu 22.04 LTS
- Datacenter: NYC or SFO

Create droplet: https://cloud.digitalocean.com/droplets/new

### 2. Register Domain

Register `epsteinfiles.org` at:
- Namecheap (~$12/year)
- Porkbun (~$10/year)
- Cloudflare Registrar (~$10/year)

### 3. Point DNS

Add these DNS records:
```
A    @    → <your-server-ip>
A    www  → <your-server-ip>
```

### 4. Server Setup

SSH into your server:
```bash
ssh root@<your-server-ip>
```

Install Docker:
```bash
curl -fsSL https://get.docker.com | sh
apt install docker-compose-plugin git
```

Clone and deploy:
```bash
git clone https://github.com/YOUR_USERNAME/epstein-files.git
cd epstein-files

# Copy your database (from local machine)
# scp database/epstein_files.db root@<server>:/root/epstein-files/database/

# Configure
cp .env.example .env
nano .env  # Set your email for SSL

# Deploy
chmod +x deploy.sh
./deploy.sh init
```

### 5. Verify

Visit https://epsteinfiles.org - you should see the landing page.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│                   nginx                      │
│  - SSL termination (Let's Encrypt)          │
│  - Rate limiting (2 req/s for search)       │
│  - Gzip compression                          │
│  - Security headers                          │
└────────────────────┬────────────────────────┘
                     │
┌────────────────────▼────────────────────────┐
│              FastAPI App                     │
│  - Document search (FTS5)                    │
│  - Entity lookup                             │
│  - Claim verification                        │
│  - Rate limiting (slowapi)                   │
└────────────────────┬────────────────────────┘
                     │
┌────────────────────▼────────────────────────┐
│              SQLite Database                 │
│  - 14,672 documents                          │
│  - 14,439 entities                           │
│  - 40,724 mentions                           │
│  - Full-text search index                    │
└─────────────────────────────────────────────┘
```

---

## Commands

```bash
# View logs
./deploy.sh logs

# Update application
./deploy.sh update

# Renew SSL (auto-runs every 12h)
./deploy.sh ssl

# Backup database
./deploy.sh backup

# Stop services
./deploy.sh stop

# Start services
./deploy.sh start
```

---

## Cost Breakdown

| Item | Cost |
|------|------|
| DigitalOcean Droplet | $6/mo |
| Domain (.org) | $12/year |
| SSL Certificate | Free (Let's Encrypt) |
| **Total** | **~$7/mo** |

---

## Security

- HTTPS enforced with HSTS
- Rate limiting at nginx AND application level
- No user accounts or PII stored
- All data is from public DOJ releases
- Input sanitization on all endpoints

---

## Monitoring

Free uptime monitoring:
- https://uptimerobot.com (5-min checks, free)
- Set up alert for https://epsteinfiles.org/api/stats

---

## Scaling

Current setup handles ~100 concurrent users easily.

If you need more:
1. Upgrade droplet ($12/mo for 2GB RAM)
2. Add nginx caching for static responses
3. Consider CloudFlare CDN (free tier)

For massive scale, migrate SQLite → PostgreSQL.
