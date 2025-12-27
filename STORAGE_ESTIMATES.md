# Storage & Infrastructure Estimates

## Current Release Size

### What's Been Released
- ~11,000+ files in initial release
- ~30,000 pages
- Mix: PDFs, images (FBI photos), court records, emails

### Coming Soon
- DOJ says 1,000,000+ additional documents discovered
- Estimated weeks more of releases

---

## Storage Calculations

### Raw Documents

| Document Type | Avg Size | Count (Current) | Count (Projected) | Storage |
|--------------|----------|-----------------|-------------------|---------|
| PDF (text-based) | 200 KB | 3,000 | 300,000 | 60 GB |
| PDF (scanned) | 2 MB | 2,000 | 200,000 | 400 GB |
| Images (FBI photos) | 500 KB | 4,000 | 400,000 | 200 GB |
| Other (emails, etc) | 100 KB | 2,000 | 100,000 | 10 GB |
| **Total Raw** | | **11,000** | **1,000,000** | **~670 GB** |

**Conservative estimate: 500 GB - 1 TB for raw documents**

### Extracted Text

| Component | Size per Doc | Total (1M docs) |
|-----------|-------------|-----------------|
| OCR/extracted text | 50 KB avg | 50 GB |
| Metadata JSON | 2 KB | 2 GB |
| **Total Text** | | **~52 GB** |

### Embeddings (for semantic search)

| Model | Dimensions | Size per Doc | Total (1M docs) |
|-------|------------|--------------|-----------------|
| OpenAI text-embedding-3-small | 1536 | 6 KB | 6 GB |
| OpenAI text-embedding-3-large | 3072 | 12 KB | 12 GB |
| Local (sentence-transformers) | 768 | 3 KB | 3 GB |

**Embedding storage: 3-12 GB depending on model**

### Database

| Table | Rows (Projected) | Avg Row Size | Total |
|-------|------------------|--------------|-------|
| documents | 1,000,000 | 5 KB | 5 GB |
| entities | 50,000 | 1 KB | 50 MB |
| mentions | 5,000,000 | 500 B | 2.5 GB |
| relationships | 500,000 | 500 B | 250 MB |
| embeddings (pgvector) | 1,000,000 | 6 KB | 6 GB |
| search indexes | - | - | 10 GB |
| **Total DB** | | | **~25 GB** |

---

## Total Storage Summary

| Component | Current (11K docs) | Full Scale (1M docs) |
|-----------|-------------------|---------------------|
| Raw documents | 5-10 GB | 500 GB - 1 TB |
| Extracted text | 500 MB | 50 GB |
| Database | 300 MB | 25 GB |
| Embeddings | 70 MB | 6-12 GB |
| Backups (1x) | 6 GB | 600 GB |
| **TOTAL** | **~12 GB** | **~1.2 - 1.7 TB** |

---

## Infrastructure Options

### Option 1: Minimal (Current release only)
- **Storage**: 20 GB SSD
- **Compute**: 2 vCPU, 4 GB RAM
- **Cost**: ~$20-40/month (DigitalOcean, Hetzner)
- **Good for**: MVP, proof of concept

### Option 2: Medium (Full release, moderate traffic)
- **Storage**: 2 TB SSD
- **Compute**: 4 vCPU, 16 GB RAM
- **Database**: Managed PostgreSQL (50 GB)
- **Object Storage**: S3/R2 for raw docs (1.5 TB)
- **Cost**: ~$100-200/month
- **Good for**: Public tool, moderate usage

### Option 3: Scale (High traffic, full features)
- **Storage**: Distributed object storage
- **Compute**: 8+ vCPU, 32+ GB RAM (or auto-scaling)
- **Database**: Managed PostgreSQL with read replicas
- **CDN**: For document serving
- **Cost**: $300-500+/month
- **Good for**: Viral traffic, full semantic search

---

## Cost Breakdown (Option 2 - Recommended)

| Service | Provider | Monthly Cost |
|---------|----------|--------------|
| VPS (4 vCPU, 16 GB) | Hetzner | $25 |
| Object Storage (2 TB) | Cloudflare R2 | $30 |
| Managed PostgreSQL | Supabase / Neon | $25 |
| Embeddings (one-time) | OpenAI | $50-100 (one-time) |
| Domain + CDN | Cloudflare | Free |
| **Monthly Total** | | **~$80/month** |
| **One-time Processing** | | **~$100-200** |

---

## Processing Costs (One-Time)

### OCR
- Tesseract: Free (self-hosted)
- Cloud OCR (Google Vision, AWS Textract): ~$1.50 per 1000 pages
- **1M pages = $1,500** if using cloud OCR
- **Recommended**: Self-hosted Tesseract = $0

### Embeddings
- OpenAI text-embedding-3-small: $0.02 per 1M tokens
- Average document: ~2000 tokens
- 1M documents = 2B tokens = **$40**
- Local model (sentence-transformers): $0 but slower

### LLM Processing (Entity/Role Extraction)
- If using GPT-4o-mini for classification: $0.15 per 1M input tokens
- 1M documents × 2000 tokens = $300
- **Recommended**: Use spaCy (free) for initial NER, LLM only for ambiguous cases

---

## Bandwidth Considerations

| Scenario | Monthly Bandwidth | Cost |
|----------|------------------|------|
| 1,000 users, 10 docs each | 100 GB | Free (most providers) |
| 10,000 users, 20 docs each | 2 TB | $20-50 |
| Viral (100K users) | 20+ TB | $200+ (need CDN) |

**Mitigation**:
- Serve thumbnails/previews first
- Lazy-load full documents
- Use CDN (Cloudflare free tier)
- Cache aggressively

---

## Recommended Starting Point

### Phase 1: MVP ($20-40/month)
```
Hetzner CX32 (4 vCPU, 8 GB RAM, 80 GB SSD): $15/month
Cloudflare R2 (100 GB): $5/month
PostgreSQL on same VPS: $0
Cloudflare CDN: Free
Domain: $10/year

Total: ~$25/month
```

### Phase 2: Full Corpus ($80-100/month)
```
Hetzner CX42 (8 vCPU, 16 GB RAM, 160 GB SSD): $30/month
Cloudflare R2 (2 TB): $30/month
Managed PostgreSQL (Supabase): $25/month
Cloudflare CDN: Free

Total: ~$85/month
```

---

## Notes

- Start with current release (~11K docs, ~10 GB) for MVP
- Scale storage as DOJ releases more documents
- Object storage (S3/R2) is cheap for raw docs
- PostgreSQL handles search/metadata well up to millions of rows
- Embeddings can be generated incrementally
- Consider: Hetzner (EU, cheap), Cloudflare R2 (no egress fees), Supabase (generous free tier)
