/**
 * Epstein Files API - Cloudflare Worker
 *
 * Provides REST API access to DOJ Epstein case documents.
 * Uses D1 for database, R2 for file storage.
 */

const R2_PUBLIC_URL = 'https://pub-440e605d59b24afeb9a9d3291bf7a927.r2.dev';

// Rate limiting: 100 requests per minute per IP, enforced by Cloudflare's
// Rate Limiting binding in production (see wrangler.toml).
const RATE_LIMIT = 100;
const RATE_WINDOW_SECONDS = 60;
const MAX_QUERY_LENGTH = 200;

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

// Friendly source collections spanning one or more data_set values, used by
// the `source` query param on /search and /browse. 'Data Set 8' is a legacy
// mislabel of 'data-set-8' still present in D1 (writes are currently blocked
// by the plan's max DB size, so it is aliased here instead of updated).
const DATA_SET_ALIASES = { 'data-set-8': ['Data Set 8'] };

const SOURCE_GROUPS = {
  'doj-release': ['data-set', 'data-set-2', 'data-set-3', 'data-set-4',
                  'data-set-5', 'data-set-6', 'data-set-7', 'data-set-8'],
  'court-records': ['court-records'],
  'doj-disclosures': ['doj-disclosures'],
  'house-oversight-doj': ['house-oversight-doj'],
  'maxwell-interview': ['maxwell-interview'],
};

function normalizeDataSet(name) {
  for (const [canonical, aliases] of Object.entries(DATA_SET_ALIASES)) {
    if (aliases.includes(name)) return canonical;
  }
  return name;
}

function expandDataSets(sets) {
  return sets.flatMap(s => [s, ...(DATA_SET_ALIASES[s] || [])]);
}

// Resolves the `source` and `data_set` params to a list of data_set values to
// match (aliases included), or null when neither filter is present.
function resolveDataSetFilter(searchParams) {
  const source = searchParams.get('source');
  const dataSet = searchParams.get('data_set');
  if (dataSet && dataSet.length > 100) {
    throw new HttpError('data_set must be 100 characters or fewer');
  }
  if (source) {
    const sets = SOURCE_GROUPS[source];
    if (!sets) {
      throw new HttpError(`source must be one of: ${Object.keys(SOURCE_GROUPS).join(', ')}`);
    }
    return expandDataSets(dataSet ? sets.filter(s => s === dataSet) : sets);
  }
  return dataSet ? expandDataSets([dataSet]) : null;
}

function dataSetPlaceholders(sets) {
  return sets.map(() => '?').join(', ');
}

function mergeDataSetCounts(rows) {
  const counts = new Map();
  for (const row of rows) {
    const name = normalizeDataSet(row.data_set);
    counts.set(name, (counts.get(name) || 0) + row.count);
  }
  return [...counts].map(([name, count]) => ({ name, count }));
}

function parseIntegerParam(searchParams, name, { defaultValue, min = 0, max = Number.MAX_SAFE_INTEGER }) {
  const raw = searchParams.get(name);
  if (raw === null || raw === '') return defaultValue;
  if (!/^\d+$/.test(raw)) {
    throw new HttpError(`${name} must be a whole number between ${min} and ${max}`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new HttpError(`${name} must be a whole number between ${min} and ${max}`);
  }
  return value;
}

function parseIntegerValue(value, name, { defaultValue, min = 0, max = Number.MAX_SAFE_INTEGER }) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(`${name} must be a whole number between ${min} and ${max}`);
  }
  return parsed;
}

function cleanSearchText(value) {
  return String(value).replace(/[^\p{L}\p{N}_\s-]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function buildFtsQuery(query) {
  if (query.length > MAX_QUERY_LENGTH) {
    throw new HttpError(`Query too long. Maximum ${MAX_QUERY_LENGTH} characters allowed.`);
  }

  const rawTokens = query.match(/"[^"]*"|\bOR\b|[^\s"]+/giu) || [];
  const output = [];
  let hasTerm = false;
  let pendingOr = false;

  for (const rawToken of rawTokens) {
    if (/^OR$/i.test(rawToken)) {
      if (!hasTerm || pendingOr) throw new HttpError('OR must appear between two search terms');
      pendingOr = true;
      continue;
    }

    const unquoted = rawToken.startsWith('"') ? rawToken.slice(1, -1) : rawToken;
    const cleaned = cleanSearchText(unquoted);
    if (!cleaned) continue;

    if (hasTerm) output.push(pendingOr ? 'OR' : 'AND');
    output.push(`"${cleaned}"`);
    hasTerm = true;
    pendingOr = false;
  }

  if (!hasTerm) throw new HttpError('Query must contain at least one letter or number');
  if (pendingOr) throw new HttpError('OR must appear between two search terms');
  return output.join(' ');
}

function escapeLikePattern(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

async function checkRateLimit(ip, env) {
  // The binding is absent in lightweight local/unit-test environments. Wrangler
  // provides it in production through the ratelimits entry in wrangler.toml.
  if (!env.API_RATE_LIMITER?.limit) return { allowed: true };

  try {
    const result = await env.API_RATE_LIMITER.limit({ key: ip });
    return { allowed: result.success };
  } catch (e) {
    // Availability wins if Cloudflare's limiter is temporarily unavailable;
    // the failure is still visible in Worker logs.
    console.error('Rate limiter error:', e);
    return { allowed: true };
  }
}

function isMediaDeliveryPath(path) {
  return (
    /^\/api\/documents\/\d+\/(?:file|thumbnail)$/.test(path) ||
    /^\/api\/videos\/\d+\/thumb$/.test(path) ||
    /^\/api\/images\/[^/]+$/.test(path) ||
    /^\/api\/house-oversight\/(?:page\/HOUSE_OVERSIGHT_\d+\/\d+|thumbnail\/HOUSE_OVERSIGHT_\d+)$/.test(path)
  );
}

// Security headers
const securityHeaders = {
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// JSON response helper
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders, ...securityHeaders, ...extraHeaders },
  });
}

// Error response helper
function error(message, status = 400) {
  return json({ error: message }, status);
}

// Router
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: { ...corsHeaders, ...securityHeaders } });
    }

    const isEntitySearch = path === '/api/entities/search' && method === 'POST';
    if (method !== 'GET' && !isEntitySearch) {
      return json({ error: 'Method not allowed' }, 405, {
        Allow: path === '/api/entities/search' ? 'POST, OPTIONS' : 'GET, OPTIONS',
      });
    }

    // Limit database/query endpoints, but not R2-backed media delivery. A
    // single gallery page can legitimately request 60 thumbnails at once.
    if (!isMediaDeliveryPath(path)) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rateLimit = await checkRateLimit(ip, env);

      if (!rateLimit.allowed) {
        return json(
          { error: 'Rate limit exceeded. Please slow down.', retry_after: RATE_WINDOW_SECONDS },
          429,
          {
            'X-RateLimit-Limit': RATE_LIMIT.toString(),
            'Retry-After': RATE_WINDOW_SECONDS.toString(),
          }
        );
      }
    }

    try {
      // Route matching
      if (path === '/api' || path === '/api/') {
        return apiInfo();
      }

      if (path === '/api/stats') {
        return await getStats(env.DB);
      }

      if (path === '/api/search') {
        return await searchDocuments(url, env.DB);
      }

      if (path === '/api/browse') {
        return await browseDocuments(url, env.DB);
      }

      // Document routes
      const docMatch = path.match(/^\/api\/documents\/(\d+)$/);
      if (docMatch) {
        return await getDocument(parseInt(docMatch[1]), env.DB);
      }

      const docTextMatch = path.match(/^\/api\/documents\/(\d+)\/text$/);
      if (docTextMatch) {
        return await getDocumentText(parseInt(docTextMatch[1]), url, env.DB);
      }

      const docFileMatch = path.match(/^\/api\/documents\/(\d+)\/file$/);
      if (docFileMatch) {
        return await getDocumentFile(parseInt(docFileMatch[1]), request, env.DB, env.R2);
      }

      const docThumbMatch = path.match(/^\/api\/documents\/(\d+)\/thumbnail$/);
      if (docThumbMatch) {
        return await getDocumentThumbnail(parseInt(docThumbMatch[1]), env.DB, env.R2);
      }

      // Video routes
      if (path === '/api/videos') {
        return await listVideos(url, env.DB);
      }

      const videoThumbMatch = path.match(/^\/api\/videos\/(\d+)\/thumb$/);
      if (videoThumbMatch) {
        return await getVideoThumbnail(parseInt(videoThumbMatch[1]), env.R2);
      }

      // Maxwell tapes
      if (path === '/api/maxwell-tapes') {
        return await listMaxwellTapes(env.DB);
      }

      // Images
      if (path === '/api/images') {
        return await listImages(url, env.R2);
      }

      const imageMatch = path.match(/^\/api\/images\/([^/]+)$/);
      if (imageMatch) {
        return await getImage(imageMatch[1], env.R2);
      }

      // Entity routes
      const entityMatch = path.match(/^\/api\/entities\/(\d+)$/);
      if (entityMatch) {
        return await getEntity(parseInt(entityMatch[1]), env.DB);
      }

      const entityMentionsMatch = path.match(/^\/api\/entities\/(\d+)\/mentions$/);
      if (entityMentionsMatch) {
        return await getEntityMentions(parseInt(entityMentionsMatch[1]), url, env.DB);
      }

      if (path === '/api/entities/search' && method === 'POST') {
        return await searchEntities(request, env.DB);
      }

      // Utility routes
      if (path === '/api/roles') {
        return getRoles();
      }

      if (path === '/api/document-types') {
        return await getDocumentTypes(env.DB);
      }

      if (path === '/api/data-sets') {
        return await getDataSets(env.DB);
      }

      // House Oversight routes
      if (path === '/api/house-oversight/documents') {
        return await listHouseOversightDocs(url, env.DB);
      }

      const hoDocMatch = path.match(/^\/api\/house-oversight\/documents\/(HOUSE_OVERSIGHT_\d+)$/);
      if (hoDocMatch) {
        return await getHouseOversightDoc(hoDocMatch[1], env.DB, env.R2);
      }

      const hoPageMatch = path.match(/^\/api\/house-oversight\/page\/(HOUSE_OVERSIGHT_\d+)\/(\d+)$/);
      if (hoPageMatch) {
        const pageIndex = Number(hoPageMatch[2]);
        if (!Number.isSafeInteger(pageIndex) || pageIndex > 10_000) {
          throw new HttpError('page index must be between 0 and 10000');
        }
        return await getHouseOversightPage(hoPageMatch[1], pageIndex, env.R2);
      }

      const hoThumbMatch = path.match(/^\/api\/house-oversight\/thumbnail\/(HOUSE_OVERSIGHT_\d+)$/);
      if (hoThumbMatch) {
        return await getHouseOversightThumbnail(hoThumbMatch[1], env.R2);
      }

      if (path === '/api/house-oversight/stats') {
        return await getHouseOversightStats(env.DB);
      }

      if (path === '/health') {
        return json({ status: 'healthy' });
      }

      if (path === '/robots.txt') {
        return new Response(
          'User-agent: *\nAllow: /\nDisallow: /api/\nCrawl-delay: 10\n',
          { headers: { 'Content-Type': 'text/plain', ...corsHeaders } }
        );
      }

      // Frontend - redirect to Pages
      if (path === '/' || path === '/app') {
        // Will be served by Pages, this is fallback
        return new Response('Frontend served by Cloudflare Pages', { status: 200 });
      }

      return error('Not found', 404);

    } catch (e) {
      if (e instanceof HttpError) {
        return error(e.message, e.status);
      }
      console.error('Worker error:', e);
      return error('Internal server error', 500);
    }
  },
};

// =============================================================================
// API HANDLERS
// =============================================================================

function apiInfo() {
  return json({
    name: 'Epstein Files API',
    version: '1.0.0',
    disclaimer: 'Being mentioned in a document does NOT imply guilt. Verify claims by reading source documents.',
    survivor_resources: {
      RAINN: '1-800-656-4673',
      website: 'https://www.rainn.org',
    },
    endpoints: {
      search: '/api/search',
      documents: '/api/documents',
      entities: '/api/entities',
      stats: '/api/stats',
    },
  });
}

async function getStats(db) {
  const [docs, entities, mentions, texts] = await Promise.all([
    db.prepare('SELECT COUNT(*) as count FROM documents').first(),
    db.prepare('SELECT COUNT(*) as count FROM entities').first(),
    db.prepare('SELECT COUNT(*) as count FROM mentions').first(),
    db.prepare('SELECT COUNT(*) as count FROM document_texts').first(),
  ]);

  // Get document type counts
  const types = await db.prepare(
    'SELECT document_type, COUNT(*) as count FROM documents GROUP BY document_type'
  ).all();

  // Get data set counts
  const dataSets = await db.prepare(
    'SELECT data_set, COUNT(*) as count FROM documents WHERE data_set IS NOT NULL GROUP BY data_set'
  ).all();

  return json({
    total_documents: docs.count,
    total_entities: entities.count,
    total_mentions: mentions.count,
    documents_with_text: texts.count,
    document_types: types.results.map(r => ({ type: r.document_type, count: r.count })),
    data_sets: mergeDataSetCounts(dataSets.results),
  });
}

async function searchDocuments(url, db) {
  const q = url.searchParams.get('q') || '';
  const documentType = url.searchParams.get('document_type');
  const dataSets = resolveDataSetFilter(url.searchParams);
  const limit = parseIntegerParam(url.searchParams, 'limit', { defaultValue: 50, min: 1, max: 100 });
  const offset = parseIntegerParam(url.searchParams, 'offset', { defaultValue: 0, min: 0, max: 1_000_000 });

  // If no query but filters, browse by filter
  if (!q && (documentType || dataSets)) {
    let sql = "SELECT * FROM documents WHERE data_set != 'house-oversight-estate'";
    const params = [];

    if (documentType) {
      sql += ' AND document_type = ?';
      params.push(documentType);
    }
    if (dataSets) {
      sql += ` AND data_set IN (${dataSetPlaceholders(dataSets)})`;
      params.push(...dataSets);
    }

    sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const results = await db.prepare(sql).bind(...params).all();

    return json({
      query: '',
      total_results: results.results.length,
      results: results.results.map(d => ({
        document_id: d.id,
        filename: d.filename,
        title: d.title,
        data_set: normalizeDataSet(d.data_set),
        document_type: d.document_type,
        source_url: d.source_url,
        relevance_score: 1.0,
        snippet: d.title || d.filename || '',
      })),
    });
  }

  if (!q) {
    return error('Query cannot be empty', 400);
  }

  // Parse the supported query language into quoted FTS5 terms. Quoting every
  // sanitized term prevents user input from becoming an FTS operator.
  const ftsQuery = buildFtsQuery(q);

  // Run document search and entity search in parallel
  const [results, countResult, entityResults] = await Promise.all([
    // Document search
    db.prepare(`
      SELECT d.id, d.filename, d.title, d.data_set, d.document_type, d.source_url,
             snippet(document_fts, 1, '>>>', '<<<', '...', 32) as snippet
      FROM document_fts
      JOIN documents d ON d.id = document_fts.document_id
      WHERE document_fts MATCH ?
      AND d.data_set != 'house-oversight-estate'
      ${documentType ? 'AND d.document_type = ?' : ''}
      ${dataSets ? `AND d.data_set IN (${dataSetPlaceholders(dataSets)})` : ''}
      ORDER BY rank
      LIMIT ? OFFSET ?
    `).bind(
      ftsQuery,
      ...(documentType ? [documentType] : []),
      ...(dataSets || []),
      limit,
      offset
    ).all(),

    // Total count (without LIMIT)
    db.prepare(`
      SELECT COUNT(*) as total
      FROM document_fts
      JOIN documents d ON d.id = document_fts.document_id
      WHERE document_fts MATCH ?
      AND d.data_set != 'house-oversight-estate'
      ${documentType ? 'AND d.document_type = ?' : ''}
      ${dataSets ? `AND d.data_set IN (${dataSetPlaceholders(dataSets)})` : ''}
    `).bind(
      ftsQuery,
      ...(documentType ? [documentType] : []),
      ...(dataSets || []),
    ).first(),

    // Entity search (top 5 matching entities)
    // Extract individual terms for multi-word queries
    (async () => {
      const cleanQ = cleanSearchText(q);
      const terms = cleanQ.split(/\s+/).filter(t => t.length > 2 && !/^(OR|AND|THE|FOR|WITH)$/i.test(t));
      if (terms.length === 0) return { results: [] };

      // Limit query length to prevent SQLite LIKE pattern complexity errors
      const searchTerm = terms.slice(0, 3).join(' ').substring(0, 100);

      // Search for entities matching any significant term
      const conditions = terms.slice(0, 3).map(() => "canonical_name LIKE ? ESCAPE '\\'").join(' OR ');
      const params = terms.slice(0, 3).map(t => `%${escapeLikePattern(t.substring(0, 50))}%`);

      return db.prepare(`
        SELECT id, canonical_name, entity_type, mention_count
        FROM entities
        WHERE ${conditions}
        ORDER BY mention_count DESC
        LIMIT 5
      `).bind(...params).all();
    })()
  ]);

  return json({
    query: q,
    total: countResult?.total || results.results.length,
    offset,
    limit,
    results: results.results.map(r => ({
      document_id: r.id,
      filename: r.filename,
      title: r.title,
      data_set: normalizeDataSet(r.data_set),
      document_type: r.document_type,
      source_url: r.source_url,
      has_text: !!r.has_text,
      processing_status: r.processing_status,
      ocr_confidence: r.ocr_confidence,
      relevance_score: 1.0,
      snippet: r.snippet || '',
    })),
    entities: entityResults.results.map(e => ({
      entity_id: e.id,
      name: e.canonical_name,
      type: e.entity_type,
      mention_count: e.mention_count,
    })),
  });
}

async function browseDocuments(url, db) {
  const limit = parseIntegerParam(url.searchParams, 'limit', { defaultValue: 24, min: 1, max: 100 });
  const offset = parseIntegerParam(url.searchParams, 'offset', { defaultValue: 0, min: 0, max: 1_000_000 });
  const filter = url.searchParams.get('filter');
  const documentType = url.searchParams.get('document_type');
  const dataSet = url.searchParams.get('data_set');
  const dataSets = resolveDataSetFilter(url.searchParams);
  const hasText = url.searchParams.get('has_text');

  if (hasText !== null && !['0', '1'].includes(hasText)) {
    throw new HttpError('has_text must be 0 or 1');
  }

  // DOJ only - House Oversight has separate endpoints
  let sql = "SELECT * FROM documents WHERE data_set != 'house-oversight-estate'";
  const params = [];

  if (documentType) {
    sql += ' AND document_type = ?';
    params.push(documentType);
  } else if (filter === 'photos') {
    sql += ' AND category = ?';
    params.push('photo');
  } else if (filter === 'videos') {
    sql += ' AND category = ?';
    params.push('video');
  } else if (filter === 'audio') {
    sql += ' AND category = ?';
    params.push('audio');
  } else if (filter === 'docs') {
    sql += ' AND category = ?';
    params.push('document');
  }

  if (dataSets) {
    sql += ` AND data_set IN (${dataSetPlaceholders(dataSets)})`;
    params.push(...dataSets);
  }

  if (hasText !== null) {
    sql += ' AND has_text = ?';
    params.push(Number(hasText));
  }

  // Get total
  const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as count');
  const total = await db.prepare(countSql).bind(...params).first();

  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const results = await db.prepare(sql).bind(...params).all();

  return json({
    total: total.count,
    offset,
    filter,
    data_set: dataSet,
    has_text: hasText,
    results: results.results.map(d => ({
      document_id: d.id,
      filename: d.filename,
      title: d.title,
      data_set: normalizeDataSet(d.data_set),
      document_type: d.document_type,
      page_count: d.page_count,
      has_text: !!d.has_text,
      processing_status: d.processing_status,
      ocr_confidence: d.ocr_confidence,
    })),
  });
}

async function getDocument(id, db) {
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first();
  if (!doc) {
    return error('Document not found', 404);
  }

  const text = await db.prepare(
    'SELECT full_text, word_count FROM document_texts WHERE document_id = ?'
  ).bind(id).first();

  return json({
    id: doc.id,
    filename: doc.filename,
    title: doc.title,
    document_type: doc.document_type,
    content_type: doc.content_type,
    data_set: normalizeDataSet(doc.data_set),
    category: doc.category,
    source_url: doc.source_url,
    source_page: doc.source_page,
    file_size: doc.file_size,
    file_hash: doc.file_hash,
    page_count: doc.page_count,
    has_text: !!doc.has_text,
    processing_status: doc.processing_status,
    ocr_confidence: doc.ocr_confidence,
    download_timestamp: doc.download_timestamp,
    text_preview: text?.full_text?.substring(0, 2000) || null,
    word_count: text?.word_count || 0,
  });
}

async function getDocumentText(id, url, db) {
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first();
  if (!doc) {
    return error('Document not found', 404);
  }

  const text = await db.prepare(
    'SELECT * FROM document_texts WHERE document_id = ?'
  ).bind(id).first();

  if (!text) {
    return error('No text content available', 404);
  }

  const page = url.searchParams.get('page');
  if (page !== null && text.pages_text) {
    const pages = JSON.parse(text.pages_text);
    const pageNum = parseIntegerParam(url.searchParams, 'page', {
      defaultValue: 0,
      min: 0,
      max: Math.max(0, pages.length - 1),
    });
    if (pageNum >= 0 && pageNum < pages.length) {
      return json({
        document_id: id,
        page: pageNum,
        total_pages: pages.length,
        text: pages[pageNum],
      });
    }
    return error('Page not found', 404);
  }

  return json({
    document_id: id,
    total_pages: text.pages_text ? JSON.parse(text.pages_text).length : 1,
    word_count: text.word_count,
    full_text: text.full_text,
  });
}

const DOCUMENT_MEDIA_TYPES = new Set([
  'application/pdf',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);

function documentMediaType(doc, object) {
  for (const value of [object?.httpMetadata?.contentType, doc.content_type]) {
    const normalized = String(value || '').split(';', 1)[0].trim().toLowerCase();
    if (DOCUMENT_MEDIA_TYPES.has(normalized)) return normalized;
  }

  const path = `${doc.local_path || ''} ${doc.filename || ''} ${doc.title || ''}`.toLowerCase();
  if (path.includes('.pdf')) return 'application/pdf';
  if (path.includes('.mp4')) return 'video/mp4';
  if (path.includes('.mov')) return 'video/quicktime';
  if (path.includes('.webm')) return 'video/webm';
  if (path.includes('.wav')) return 'audio/wav';
  if (path.includes('.mp3')) return 'audio/mpeg';
  if (path.includes('.m4a')) return 'audio/mp4';
  return 'application/octet-stream';
}

function documentFileResponse(doc, object, rangeRequested) {
  const headers = new Headers({
    'Content-Type': documentMediaType(doc, object),
    'Cache-Control': 'public, max-age=86400',
    'Accept-Ranges': 'bytes',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, ETag',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    ...corsHeaders,
  });
  object.writeHttpMetadata?.(headers);
  headers.set('Content-Type', documentMediaType(doc, object));
  if (object.httpEtag) headers.set('ETag', object.httpEtag);

  let status = 200;
  if (rangeRequested && object.range && Number.isFinite(object.size)) {
    const suffix = Number(object.range.suffix);
    const start = Number.isFinite(object.range.offset)
      ? Number(object.range.offset)
      : Math.max(0, object.size - suffix);
    const length = Number.isFinite(object.range.length)
      ? Number(object.range.length)
      : Math.min(suffix, object.size);
    if (Number.isFinite(start) && Number.isFinite(length) && length > 0) {
      headers.set('Content-Range', `bytes ${start}-${start + length - 1}/${object.size}`);
      headers.set('Content-Length', String(length));
      status = 206;
    }
  } else if (Number.isFinite(object.size)) {
    headers.set('Content-Length', String(object.size));
  }

  return new Response(object.body, { status, headers });
}

async function getDocumentFile(id, request, db, r2) {
  const doc = await db.prepare(
    'SELECT local_path, filename, title, data_set, content_type, document_type FROM documents WHERE id = ?'
  ).bind(id).first();

  if (!doc) {
    return error('Document not found', 404);
  }

  // House Oversight docs - serve first page image from R2
  if (doc.data_set === 'house-oversight-estate') {
    const bates = doc.filename; // e.g., HOUSE_OVERSIGHT_010477
    const batesNum = parseInt(bates.replace('HOUSE_OVERSIGHT_', ''));
    const folderNum = Math.floor((batesNum - 10477) / 2000 + 1);
    const folder = folderNum.toString().padStart(3, '0');
    const r2Key = `house-oversight/IMAGES/${folder}/${bates}.jpg`;

    try {
      const object = await r2.get(r2Key);
      if (object) {
        return new Response(object.body, {
          headers: {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=86400',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            ...corsHeaders,
          },
        });
      }
    } catch (e) {
      console.error('R2 fetch error for House Oversight:', e);
    }
    return error('File not available', 404);
  }

  // DOJ docs - serve PDF from local_path
  const pathMatch = doc.local_path?.match(/epstein-files\/(.+)$/);
  if (pathMatch) {
    const r2Key = pathMatch[1];
    try {
      const rangeRequested = request.headers.has('Range');
      const rangeOpts = rangeRequested ? { range: request.headers } : undefined;
      // Videos: prefer the faststart remux under streaming/ (originals stay
      // byte-identical to the DOJ release for hash verification).
      if (doc.document_type === 'video') {
        const streamObject = await r2.get(`streaming/${r2Key}`, rangeOpts);
        if (streamObject) {
          return documentFileResponse(doc, streamObject, rangeRequested);
        }
      }
      const object = await r2.get(r2Key, rangeOpts);
      if (object) {
        return documentFileResponse(doc, object, rangeRequested);
      }
    } catch (e) {
      console.error('R2 fetch error:', e);
    }
  }

  return error('File not available', 404);
}

async function getDocumentThumbnail(id, db, r2) {
  const doc = await db.prepare('SELECT local_path, filename FROM documents WHERE id = ?').bind(id).first();
  if (!doc) {
    return error('Document not found', 404);
  }

  // Try pre-generated thumbnail first
  try {
    const thumb = await r2.get(`thumbnails/${id}.jpg`);
    if (thumb) {
      return new Response(thumb.body, {
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
          ...corsHeaders,
        },
      });
    }
  } catch (e) {
    // No thumbnail, fall through
  }

  // Fallback: serve first page of PDF as "thumbnail" (returns PDF, not image)
  // For now, return a placeholder or 404
  return error('Thumbnail not available', 404);
}

async function listVideos(url, db) {
  const limit = parseIntegerParam(url.searchParams, 'limit', { defaultValue: 100, min: 1, max: 500 });
  const offset = parseIntegerParam(url.searchParams, 'offset', { defaultValue: 0, min: 0, max: 1_000_000 });

  const total = await db.prepare(
    "SELECT COUNT(*) as count FROM documents WHERE document_type = 'video'"
  ).first();

  const videos = await db.prepare(
    "SELECT id, filename, title, data_set FROM documents WHERE document_type = 'video' ORDER BY id LIMIT ? OFFSET ?"
  ).bind(limit, offset).all();

  return json({
    total: total.count,
    offset,
    videos: videos.results.map(v => ({
      id: v.id,
      filename: v.filename,
      title: v.title || v.filename,
      data_set: normalizeDataSet(v.data_set),
      has_thumbnail: true, // Assume all have thumbs in R2
    })),
  });
}

// Streamed from R2 rather than redirected to R2_PUBLIC_URL: r2.dev dev URLs
// are rate-limited by Cloudflare and stall for tens of seconds under the
// burst a 48-card gallery produces, which held up video poster loads (and
// with them Chrome's media requests) long enough to look broken.
async function getVideoThumbnail(id, r2) {
  const object = await r2.get(`thumbnails/${id}.jpg`);
  if (!object) {
    return error('Thumbnail not found', 404);
  }
  return new Response(object.body, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      ...corsHeaders,
    },
  });
}

async function listMaxwellTapes(db) {
  const tapes = await db.prepare(
    "SELECT * FROM documents WHERE document_type = 'audio' AND data_set = 'maxwell-interview' ORDER BY filename"
  ).all();

  return json({
    total: tapes.results.length,
    description: 'Ghislaine Maxwell deposition recordings',
    tapes: tapes.results.map(t => ({
      id: t.id,
      filename: t.filename,
      title: t.title || t.filename,
      day: t.title?.includes('Day 1') ? 'Day 1' : t.title?.includes('Day 2') ? 'Day 2' : 'Unknown',
      part: t.title?.match(/Part\s*(\d+)/)?.[1] || null,
    })),
  });
}

async function listImages(url, r2) {
  const limit = parseIntegerParam(url.searchParams, 'limit', { defaultValue: 60, min: 1, max: 200 });
  const offset = parseIntegerParam(url.searchParams, 'offset', { defaultValue: 0, min: 0, max: 1_000_000 });

  // Try to get manifest from R2
  try {
    const manifest = await r2.get('images/manifest.json');
    if (manifest) {
      const data = await manifest.json();
      const images = data.images || [];
      return json({
        total: data.total_images || 0,
        offset,
        images: images.slice(offset, offset + limit),
      });
    }
  } catch (e) {
    console.error('Error loading manifest:', e);
  }

  return json({ total: 0, images: [], status: 'manifest not found' });
}

async function getImage(filename, r2) {
  // Sanitize filename
  if (filename.includes('..') || filename.includes('/')) {
    return error('Invalid filename', 400);
  }

  // Streamed rather than redirected to the rate-limited r2.dev URL (see
  // getVideoThumbnail).
  const object = await r2.get(`images/${filename}`);
  if (!object) {
    return error('Image not found', 404);
  }
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      ...corsHeaders,
    },
  });
}

async function getEntity(id, db) {
  const entity = await db.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first();
  if (!entity) {
    return error('Entity not found', 404);
  }

  return json({
    id: entity.id,
    canonical_name: entity.canonical_name,
    entity_type: entity.entity_type,
    first_name: entity.first_name,
    last_name: entity.last_name,
    aliases: entity.aliases ? JSON.parse(entity.aliases) : null,
    description: entity.description,
    is_public_figure: !!entity.is_public_figure,
    disambiguation_notes: entity.disambiguation_notes,
    confidence: entity.confidence,
    mention_count: entity.mention_count,
    needs_review: !!entity.needs_review,
  });
}

async function getEntityMentions(entityId, url, db) {
  const role = url.searchParams.get('role');
  const limit = parseIntegerParam(url.searchParams, 'limit', { defaultValue: 100, min: 1, max: 500 });
  const offset = parseIntegerParam(url.searchParams, 'offset', { defaultValue: 0, min: 0, max: 1_000_000 });

  const entity = await db.prepare('SELECT canonical_name FROM entities WHERE id = ?').bind(entityId).first();
  if (!entity) {
    return error('Entity not found', 404);
  }

  let sql = `
    SELECT m.*, d.filename, d.title, d.document_type, d.data_set
    FROM mentions m
    JOIN documents d ON d.id = m.document_id
    WHERE m.entity_id = ?
  `;
  const params = [entityId];

  if (role) {
    sql += ' AND m.role = ?';
    params.push(role);
  }

  sql += ' ORDER BY m.id LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const mentions = await db.prepare(sql).bind(...params).all();

  return json({
    entity_id: entityId,
    entity_name: entity.canonical_name,
    role_filter: role,
    total_mentions: mentions.results.length,
    disclaimer: 'Role indicates appearance in specific document, not overall characterization',
    mentions: mentions.results.map(m => ({
      id: m.id,
      document_id: m.document_id,
      document_filename: m.filename || m.title || `Document ${m.document_id}`,
      filename: m.filename,
      title: m.title,
      document_type: m.document_type,
      data_set: normalizeDataSet(m.data_set),
      name_as_appears: m.name_as_appears,
      role: m.role,
      role_confidence: m.role_confidence,
      page_number: m.page_number,
      context_snippet: m.context_snippet,
    })),
  });
}

async function searchEntities(request, db) {
  const rawBody = await request.text();
  if (rawBody.length > 10_000) {
    throw new HttpError('Request body too large', 413);
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new HttpError('Request body must be valid JSON');
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError('Request body must be a JSON object');
  }

  const { query, entity_type } = body;

  if (typeof query !== 'string' || !query.trim()) {
    return error('Query is required', 400);
  }

  // Limit query length to prevent SQLite LIKE pattern complexity errors
  if (query.length > 200) {
    return error('Query too long. Maximum 200 characters allowed.', 400);
  }

  const cleanQuery = cleanSearchText(query);
  if (!cleanQuery) {
    throw new HttpError('Query must contain at least one letter or number');
  }
  const resultLimit = parseIntegerValue(body.limit, 'limit', { defaultValue: 50, min: 1, max: 100 });

  let sql = "SELECT * FROM entities WHERE canonical_name LIKE ? ESCAPE '\\'";
  const params = [`%${escapeLikePattern(cleanQuery)}%`];

  if (entity_type) {
    if (typeof entity_type !== 'string' || entity_type.length > 50) {
      throw new HttpError('entity_type must be a string of at most 50 characters');
    }
    sql += ' AND entity_type = ?';
    params.push(entity_type);
  }

  sql += ' ORDER BY mention_count DESC LIMIT ?';
  params.push(resultLimit);

  const results = await db.prepare(sql).bind(...params).all();

  // Get distinct documents where entity is mentioned
  const entities = await Promise.all(results.results.map(async (e) => {
    const mentions = await db.prepare(`
      SELECT DISTINCT m.document_id, d.filename as document_filename, m.role
      FROM mentions m
      JOIN documents d ON d.id = m.document_id
      WHERE m.entity_id = ?
      GROUP BY m.document_id
      LIMIT 5
    `).bind(e.id).all();

    return {
      entity_id: e.id,
      canonical_name: e.canonical_name,
      entity_type: e.entity_type,
      mention_count: e.mention_count,
      mentions: mentions.results.map(m => ({
        role: m.role || 'unknown',
        document_id: m.document_id,
        document_filename: m.document_filename,
      })),
    };
  }));

  return json({
    query,
    total_results: entities.length,
    results: entities,
  });
}

function getRoles() {
  return json({
    roles: [
      { role: 'victim', description: 'Named as victim in official records' },
      { role: 'witness', description: 'Provided testimony or information' },
      { role: 'investigator', description: 'Law enforcement or prosecutor' },
      { role: 'legal_counsel', description: 'Attorney' },
      { role: 'accused', description: 'Named in indictment or allegations' },
      { role: 'associate', description: 'Business or social connection documented' },
      { role: 'mentioned', description: 'Name appears, role unclear' },
      { role: 'author', description: 'Wrote the document' },
      { role: 'recipient', description: 'Received the document' },
      { role: 'unknown', description: 'Cannot determine from context' },
    ],
    disclaimer: 'Role indicates appearance in a specific document. A person may have different roles in different documents.',
  });
}

async function getDocumentTypes(db) {
  const types = await db.prepare(
    'SELECT document_type, COUNT(*) as count FROM documents GROUP BY document_type ORDER BY count DESC'
  ).all();

  return json({
    document_types: types.results.map(t => ({
      type: t.document_type,
      count: t.count,
    })),
  });
}

async function getDataSets(db) {
  const sets = await db.prepare(
    'SELECT data_set, COUNT(*) as count FROM documents WHERE data_set IS NOT NULL GROUP BY data_set ORDER BY count DESC'
  ).all();

  return json({
    data_sets: mergeDataSetCounts(sets.results).sort((a, b) => b.count - a.count),
  });
}

// =============================================================================
// HOUSE OVERSIGHT HANDLERS
// =============================================================================

// Cache for page mappings (loaded from R2 or hardcoded)
let houseOversightPagesCache = null;

async function loadHouseOversightPages(r2) {
  if (houseOversightPagesCache) return houseOversightPagesCache;

  try {
    const manifest = await r2.get('house-oversight/pages.json');
    if (manifest) {
      houseOversightPagesCache = await manifest.json();
      return houseOversightPagesCache;
    }
  } catch (e) {
    console.error('Error loading House Oversight pages:', e);
  }
  return {};
}

async function listHouseOversightDocs(url, db) {
  const limit = parseIntegerParam(url.searchParams, 'limit', { defaultValue: 50, min: 1, max: 100 });
  const offset = parseIntegerParam(url.searchParams, 'offset', { defaultValue: 0, min: 0, max: 1_000_000 });
  const search = url.searchParams.get('search') || '';

  if (search.length > 100) {
    throw new HttpError('Search too long. Maximum 100 characters allowed.');
  }

  let sql = "SELECT * FROM house_oversight_documents";
  const params = [];

  if (search) {
    sql += " WHERE (bates_number LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')";
    const pattern = `%${escapeLikePattern(search)}%`;
    params.push(pattern, pattern);
  }

  // Get total count
  const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as count');
  const total = await db.prepare(countSql).bind(...params).first();

  sql += ' ORDER BY bates_number LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const results = await db.prepare(sql).bind(...params).all();

  return json({
    total: total.count,
    offset,
    limit,
    documents: results.results.map(d => ({
      id: d.id,
      bates: d.bates_number,
      title: d.title,
      page_count: d.page_count || 1,
      thumbnail: `/api/house-oversight/thumbnail/${d.bates_number}`,
    })),
  });
}

async function getHouseOversightDoc(bates, db, r2) {
  const doc = await db.prepare(
    "SELECT * FROM house_oversight_documents WHERE bates_number = ?"
  ).bind(bates).first();

  if (!doc) {
    return error('Document not found', 404);
  }

  // Get page info from page_count
  const pages = [];
  const pageCount = doc.page_count || 1;

  // Page filenames follow pattern: BATES number increments
  const batesNum = parseInt(bates.replace('HOUSE_OVERSIGHT_', ''));
  for (let i = 0; i < pageCount; i++) {
    const pageNum = batesNum + i;
    const padded = pageNum.toString().padStart(6, '0');
    pages.push({
      page: i,
      url: `/api/house-oversight/page/${bates}/${i}`,
      bates: `HOUSE_OVERSIGHT_${padded}`,
    });
  }

  // Get mentions/entities using legacy_document_id
  let entities = [];
  if (doc.legacy_document_id) {
    const mentions = await db.prepare(`
      SELECT e.id, e.canonical_name, e.entity_type, m.name_as_appears, m.role
      FROM mentions m
      JOIN entities e ON e.id = m.entity_id
      WHERE m.document_id = ?
      LIMIT 100
    `).bind(doc.legacy_document_id).all();
    entities = mentions.results.map(m => ({
      id: m.id,
      name: m.canonical_name,
      type: m.entity_type,
      as_appears: m.name_as_appears,
      role: m.role,
    }));
  }

  return json({
    id: doc.id,
    bates: doc.bates_number,
    title: doc.title,
    page_count: pageCount,
    pages,
    text_preview: doc.text_content?.substring(0, 2000) || null,
    entities,
  });
}

async function getHouseOversightPage(bates, pageIndex, r2) {
  // Calculate actual page bates number
  const baseBates = parseInt(bates.replace('HOUSE_OVERSIGHT_', ''));
  const pageNum = baseBates + pageIndex;
  const padded = pageNum.toString().padStart(6, '0');

  // Determine folder based on page number ranges
  // 001: 010477-012476, 002: 012477-014476, etc. (2000 per folder)
  const folderNum = Math.floor((pageNum - 10477) / 2000 + 1);
  const folder = folderNum.toString().padStart(3, '0');

  const imagePath = `IMAGES/${folder}/HOUSE_OVERSIGHT_${padded}.jpg`;
  const r2Key = `house-oversight/${imagePath}`;

  // Serve directly from R2 binding
  try {
    const object = await r2.get(r2Key);
    if (!object) {
      return error('Image not found', 404);
    }

    return new Response(object.body, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
        ...corsHeaders,
      },
    });
  } catch (e) {
    // Fallback to redirect
    return new Response(null, {
      status: 302,
      headers: {
        'Location': `${R2_PUBLIC_URL}/${r2Key}`,
        ...corsHeaders,
      },
    });
  }
}

async function getHouseOversightThumbnail(bates, r2) {
  // Pre-generated small thumbnail (~420px wide) — falls back to the full-res
  // page-0 scan for any doc that hasn't been processed by
  // generate_ho_thumbnails.py yet, so this route never 404s outright.
  const thumbKey = `house-oversight/thumbnails/${bates}.jpg`;
  const object = await r2.get(thumbKey);
  if (object) {
    return new Response(object.body, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable',
        ...corsHeaders,
      },
    });
  }
  return await getHouseOversightPage(bates, 0, r2);
}

async function getHouseOversightStats(db) {
  // Materialize the 315k oversight mentions once. Starting from the 2.9k
  // legacy documents lets SQLite use idx_mentions_document instead of walking
  // every entity and its mentions in the much larger combined archive.
  const stats = await db.prepare(`
    WITH oversight_mentions AS MATERIALIZED (
      SELECT m.entity_id
      FROM house_oversight_documents h
      CROSS JOIN mentions m ON m.document_id = h.legacy_document_id
    ),
    top_entities AS (
      SELECT e.id, e.canonical_name, e.entity_type, COUNT(*) AS mention_count
      FROM oversight_mentions om
      JOIN entities e ON e.id = om.entity_id
      GROUP BY e.id
      ORDER BY mention_count DESC
      LIMIT 20
    )
    SELECT
      (SELECT COUNT(*) FROM house_oversight_documents) AS documents,
      (SELECT COALESCE(SUM(page_count), 0) FROM house_oversight_documents) AS pages,
      (SELECT COUNT(DISTINCT entity_id) FROM oversight_mentions) AS entities,
      (SELECT COUNT(*) FROM oversight_mentions) AS mentions,
      (SELECT json_group_array(json_object(
        'id', id,
        'name', canonical_name,
        'type', entity_type,
        'mentions', mention_count
      )) FROM top_entities) AS top_entities
  `).first();

  let topEntities = [];
  try {
    topEntities = JSON.parse(stats.top_entities || '[]');
  } catch {
    topEntities = [];
  }

  return json({
    documents: stats.documents,
    pages: stats.pages || 0,
    entities: stats.entities,
    mentions: stats.mentions,
    description: 'House Oversight Committee Estate Documents - Litigation load files from the Epstein estate investigation',
    top_entities: topEntities,
  });
}
