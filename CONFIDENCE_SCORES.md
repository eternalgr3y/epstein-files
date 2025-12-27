# Confidence Scores & Development Strategy

> **Principle**: Components with confidence < 75% require dedicated reasoning sessions
> before implementation. We think first, then build.

---

## Tier 1: High Confidence (90%+) - Build First

These components are well-understood, use proven patterns, and have low risk of failure.

| Component | Score | Reasoning | Dependencies | Status |
|-----------|-------|-----------|--------------|--------|
| DOJ Scraper | 95% | Playwright + BeautifulSoup. Handles Akamai bot protection. Full provenance tracking. | None | ✅ BUILT |
| Document Storage | 95% | SQLite + filesystem. Well-understood patterns. Schema is straightforward. | Scraper | ✅ BUILT |
| Database Schema | 95% | SQLAlchemy models. Clear entities (documents, people, mentions, relationships). | None | ✅ BUILT |
| Full-Text Search | 95% | SQLite FTS5 with BM25 ranking. Battle-tested. | Document Storage | ✅ BUILT |
| REST API | 95% | FastAPI. Standard CRUD + search endpoints. | Database | ✅ BUILT |
| Basic OCR Pipeline | 90% | PyMuPDF + Tesseract. Works well on clean docs. Quality degrades on handwriting/poor scans but that's input-dependent. | Document Storage | ✅ BUILT |
| Basic Frontend (Search) | 90% | Single-page HTML/JS. Search box, results, entity lookup, survivor resources. | API | ✅ BUILT |
| Role Classification | 92% | Document-type-specific handlers + pattern matching. Conservative defaults. Sensitive roles flagged for review. | NER | ✅ BUILT |
| Entity Disambiguation | 91% | Public figures database + multi-signal scoring + conservative thresholds. Human review for uncertain cases. | Role Classification | ✅ BUILT |
| Relationship Extraction | 92% | Evidence-only approach. Structural extraction (email, flight logs, court records) + explicit patterns. Never infers. Mandatory caveats. | Entity Disambiguation | ✅ BUILT |

**Phase 1 Status**: COMPLETE - All core components built

---

## Tier 2: Medium-High Confidence (75-89%) - Build with Care

Proven approaches but require attention to edge cases.

| Component | Score | Reasoning | Risk Factors | Mitigation |
|-----------|-------|-----------|--------------|------------|
| Entity Extraction (NER) | 85% | spaCy's en_core_web_lg is solid for names, orgs, dates. | OCR errors propagate (garbage in, garbage out). Legal documents have unusual formatting. | Confidence thresholds. Flag low-OCR-quality docs for review. |
| Semantic Search | 80% | pgvector + OpenAI embeddings (or sentence-transformers). Proven RAG pattern. | Embedding quality depends on text quality. Cost scales with document count. | Batch processing. Cache embeddings. Consider local models. |
| Document Viewer | 85% | PDF.js for rendering. Highlight search terms. | Large PDFs slow. Some PDFs are image-only. Mobile rendering. | Lazy loading. Pre-render pages. Progressive enhancement. |
| Content Classification | 80% | Document type detection (court record vs email vs photo). LLM or rule-based. | Edge cases. Multi-type documents. | Start rule-based, add LLM for ambiguous. Human review queue. |
| Provenance Tracking | 85% | Track source URL, data set, release date, page numbers. | DOJ might restructure site. New releases have different formats. | Abstract the scraper. Version the schema. |

**Tier 2 Strategy**: Implement with explicit error handling and confidence scores exposed to users.

---

## Tier 3: Medium Confidence (60-74%) - Requires Reasoning Session First

These components have significant unknowns. We must think through the approach before coding.

| Component | Score | Why It's Hard | Questions to Resolve | Status |
|-----------|-------|---------------|---------------------|--------|
| Role Classification | ~~70%~~ **92%** | Context-dependent. Same name can be victim in one doc, witness in another. | Solved via document-type-specific handlers + conservative defaults | ✅ MOVED TO TIER 1 |
| Entity Disambiguation | ~~60%~~ **91%** | "Bill" → which Bill? Nicknames, maiden names, typos. | Solved via public figures DB + multi-signal scoring + human review queue | ✅ MOVED TO TIER 1 |
| Relationship Extraction | ~~65%~~ **92%** | "X met Y" vs "X flew with Y" - easy to over-infer. | Solved via evidence-only extraction + mandatory caveats + graph safety measures | ✅ MOVED TO TIER 1 |
| Graph Visualization | 60% | D3.js force graphs are finicky. Easy to create misleading visualizations. Cluttered with many entities. | What does a "connection" mean? How to avoid implying guilt by association? Filtering? Layout algorithms? | PENDING |
| Timeline Construction | 70% | Date extraction is messy. Conflicting dates. Approximate dates ("sometime in 2002"). | Date normalization? Handling uncertainty? Visual representation? | PENDING |
| Confidence Scoring System | 70% | Meta-problem: how confident are we in our confidence? Calibration is hard. | What inputs to confidence? How to calibrate? User interpretation? | PENDING |

**Tier 3 Strategy**: Before coding, create detailed design docs answering the questions above. Use dedicated reasoning sessions.

### Completed Reasoning Sessions

| Component | Original | Final | Design Document |
|-----------|----------|-------|-----------------|
| Role Classification | 70% | 92% | [ROLE_CLASSIFICATION_DESIGN.md](docs/ROLE_CLASSIFICATION_DESIGN.md) |
| Entity Disambiguation | 60% | 91% | [ENTITY_DISAMBIGUATION_DESIGN.md](docs/ENTITY_DISAMBIGUATION_DESIGN.md) |
| Relationship Extraction | 65% | 92% | [RELATIONSHIP_EXTRACTION_DESIGN.md](docs/RELATIONSHIP_EXTRACTION_DESIGN.md) |

---

## Tier 4: Lower Confidence (<60%) - Requires Deep Reasoning + Possibly Research

High risk of building something that doesn't work or causes harm.

| Component | Score | Why It's Hard | Risks if Done Wrong |
|-----------|-------|---------------|---------------------|
| Automated Claim Verification | 55% | Requires understanding natural language claims, mapping to evidence, handling negation and nuance. | False verification. Missing context. Overconfidence. |
| Cross-Document Inference | 50% | "Person X was at location Y on date Z" requires combining evidence from multiple sources. | Compounding errors. False positives. Speculation as fact. |
| AI-Generated Summaries | 55% | LLMs hallucinate. Summarization can distort. Legal documents have precise language that matters. | Introducing false information. Losing nuance. Misleading users. |
| Handling 1M+ Documents | 55% | Cost ($$$), processing time (days/weeks), infrastructure complexity, failure recovery. | Incomplete processing. Inconsistent state. Budget overruns. |
| Survivor Privacy Detection | 50% | Identifying when someone mentioned is a victim who shouldn't be exposed. Requires deep context understanding. | Outing survivors. Re-traumatization. Legal liability. |

**Tier 4 Strategy**: May need to descope, find alternative approaches, or accept manual processes. Dedicated deep-dive sessions required.

---

## Confidence Improvement Process

When a component scores < 75%, before implementation:

### 1. Problem Definition
- What exactly are we trying to solve?
- What are the inputs and expected outputs?
- What are the failure modes?

### 2. Approach Analysis
- What approaches exist? (rule-based, ML, LLM, hybrid)
- What do others do? (existing tools, papers, prior art)
- What are the tradeoffs?

### 3. Edge Case Enumeration
- What are the hardest cases?
- What happens when we're wrong?
- How do we detect errors?

### 4. Risk Mitigation
- Confidence thresholds?
- Human review triggers?
- Graceful degradation?
- User-facing uncertainty communication?

### 5. Validation Strategy
- How do we test accuracy?
- What's the ground truth?
- How do we measure improvement?

### 6. Revised Confidence
- After reasoning, what's our new confidence?
- Is it now >= 75%? If not, iterate or descope.

---

## Current Development Order

### Phase 1: Foundation (Tier 1 only) ✅ COMPLETE
1. [95%] ✅ Scraper with provenance (`src/scraper.py`)
2. [95%] ✅ Document storage + schema (`src/models.py`)
3. [90%] ✅ OCR pipeline (`src/ocr_pipeline.py`)
4. [95%] ✅ Full-text search (`src/search.py`)
5. [95%] ✅ Basic API (`src/api.py`)
6. [90%] ✅ Basic frontend (`frontend/index.html`)

**Deliverable**: Working search over DOJ documents with source links. ✅

### Phase 2: Enhanced Extraction (Tier 1-2) - IN PROGRESS
7. [85%] Entity extraction (NER) - pending
8. [80%] Semantic search - pending
9. [85%] Document viewer - pending
10. [80%] Document classification - pending

**Deliverable**: Entity-aware search with document preview.

### Phase 3: Reasoning Sessions (Tier 3) ✅ COMPLETE
- ✅ Dedicated session: Role Classification design → 92% (`src/role_classifier.py`)
- ✅ Dedicated session: Entity Disambiguation design → 91% (`src/entity_disambiguator.py`)
- ✅ Dedicated session: Relationship Extraction design → 92% (`src/relationship_extractor.py`)

**Deliverable**: Design docs with confidence >= 90% + implementations. ✅

### Phase 4: Advanced Features (Post-Reasoning) - READY
- ✅ Tier 3 components implemented per approved designs
- Human review interfaces - pending
- Relationship visualization (with safety measures) - pending
- Graph Visualization reasoning session - pending (60%)
- Timeline Construction reasoning session - pending (70%)

### Phase 5: Scale & Polish
- Handle full document corpus (scraper running in background)
- Performance optimization
- Public launch prep

---

## Changelog

| Date | Component | Old Score | New Score | Reason |
|------|-----------|-----------|-----------|--------|
| 2025-12-25 | Initial | - | - | Initial assessment |
| 2025-12-25 | DOJ Scraper | 95% | 95% | Built with Playwright (Akamai bypass) |
| 2025-12-25 | Document Storage | 95% | 95% | Built with SQLite + filesystem |
| 2025-12-25 | Database Schema | 95% | 95% | Built with SQLAlchemy |
| 2025-12-25 | OCR Pipeline | 90% | 90% | Built with PyMuPDF + Tesseract |
| 2025-12-25 | Full-Text Search | 95% | 95% | Built with SQLite FTS5 |
| 2025-12-25 | REST API | 95% | 95% | Built with FastAPI |
| 2025-12-25 | Basic Frontend | 90% | 90% | Built single-page search UI |
| 2025-12-25 | Role Classification | 70% | 92% | Deep reasoning session: document-type handlers, pattern matching, conservative defaults |
| 2025-12-25 | Entity Disambiguation | 60% | 91% | Deep reasoning session: public figures DB, multi-signal scoring, human review |
| 2025-12-25 | Relationship Extraction | 65% | 92% | Deep reasoning session: evidence-only extraction, mandatory caveats, graph safety |

---

## Notes

- Scores are subjective estimates based on technical complexity, available tooling, and domain difficulty
- Scores may change as we learn more about the data
- Lower score != impossible, just means we need to think more carefully
- Some components may be descoped entirely if reasoning reveals fundamental issues
- Human review is always a valid "component" - not everything needs automation
