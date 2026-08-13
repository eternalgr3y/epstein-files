/**
 * Epstein Files API - Cloudflare Worker
 *
 * Provides REST API access to DOJ Epstein case documents.
 * Uses D1 for database, R2 for file storage.
 */

const MISSING_THUMBNAIL_URL = 'https://epsteinproject.org/static/og-image-cfb5f4496123.jpg';

// Rate limiting: 100 requests per minute per IP, enforced by Cloudflare's
// Rate Limiting binding in production (see wrangler.toml).
const RATE_LIMIT = 100;
const RATE_WINDOW_SECONDS = 60;
// Media galleries legitimately fan out dozens of requests at once, so give
// R2-backed delivery its own larger bucket instead of exempting it entirely.
// Range requests use a separate key so ordinary thumbnails cannot starve
// video/audio seeking (and vice versa), while each class remains bounded.
const MEDIA_RATE_LIMIT = 300;
const MEDIA_RATE_WINDOW_SECONDS = 60;
const MAX_QUERY_LENGTH = 200;
const MAX_ENTITY_REQUEST_BYTES = 10 * 1024;
// Cloudflare D1 rejects LIKE patterns longer than 50 bytes. Reserve two bytes
// for the surrounding wildcards and truncate at a complete escaped character.
const MAX_LIKE_PATTERN_BYTES = 50;

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

// Friendly source collections spanning one or more data_set values, used by
// the `source` query param on /search and /browse. 'Data Set 8' is a legacy
// mislabel of 'data-set-8' still present in D1, aliased here at read time.
// (This previously said writes were blocked by the plan's max DB size; that
// is no longer true — a 32 MB import ran fine on 2026-07-27 — so the rows
// could now simply be corrected, making this alias removable.)
const DATA_SET_ALIASES = { 'data-set-8': ['Data Set 8'] };

const SOURCE_GROUPS = {
  'doj-release': ['data-set', 'data-set-2', 'data-set-3', 'data-set-4',
                  'data-set-5', 'data-set-6', 'data-set-7', 'data-set-8'],
  'court-records': ['court-records'],
  'doj-disclosures': ['doj-disclosures'],
  'house-oversight-doj': ['house-oversight-doj'],
  'house-oversight-estate': ['house-oversight-estate'],
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

// documents.has_text does not mean the text exists. ~2,500 rows are marked
// processing_status='completed' with has_text=1 but have no document_texts
// row and no document_fts entry, so the API advertised searchable text that
// /documents/:id/text then 404'd on. Derive the flag from the text that is
// actually stored instead of trusting the column. document_texts.document_id
// is UNIQUE, so this is an indexed lookup, not a scan.
//
// `idColumn` is always a literal from this file, never user input.
function hasTextExpr(idColumn) {
  return `EXISTS (SELECT 1 FROM document_texts dt WHERE dt.document_id = ${idColumn})`;
}

// The entities table holds two extraction vocabularies side by side -- spaCy's
// uppercase PERSON/ORG (83k rows) and a lowercase person/organization set
// (133k rows) -- plus exact duplicates within each. 27,774 name+type groups
// contain more than one row, so 88,571 of 216,591 entities are redundant.
//
// The visible damage is on search: "maxwell" returned Ghislaine Maxwell twice
// with the mentions split 15,543 / 1,126, so every count on the site reads low
// and the reader cannot tell which row to click.
//
// These helpers merge duplicates at read time. That is deliberate: repointing
// 3.7M mentions.entity_id rows is a destructive migration, whereas this is a
// deploy away from being reverted, and it makes the data fix optional rather
// than urgent. canonical_name is indexed (idx_entities_name), so expanding an
// id to its siblings is cheap.
// Takes the entity id TWICE as positional parameters. Numbered placeholders
// (?1) would read better but mix badly with the bare ? used elsewhere in the
// same statements, so callers bind the id twice.
// spaCy emits ORG where the other extractor emits organization. LOWER() alone
// leaves those in separate groups, so normalise in SQL exactly as
// normalizeEntityType() does in JS -- otherwise search still shows "Maxwell"
// twice under organization.
const ENTITY_TYPE_NORM_SQL =
  "CASE WHEN LOWER(entity_type) = 'org' THEN 'organization' ELSE LOWER(entity_type) END";

// Names are matched case-insensitively: "Jeffrey Epstein" (29,111 mentions)
// and "JEFFREY EPSTEIN" (4,709) are one person, and readers saw them as two
// results. Grouping merges 902 variants into a single row of 33,822, and
// SQLite's bare-column rule means the displayed name and id come from the
// heaviest variant -- so the well-cased "Jeffrey Epstein" wins, not the
// shouted one. Needs idx_entities_name_lower, an expression index on
// LOWER(canonical_name): without it this is a 216k-row scan at 66ms, with it
// 922 rows at 3ms.
const ENTITY_SIBLINGS_SQL = `
  SELECT id FROM entities
  WHERE LOWER(canonical_name) = (SELECT LOWER(canonical_name) FROM entities WHERE id = ?)
    AND ${ENTITY_TYPE_NORM_SQL} = (SELECT ${ENTITY_TYPE_NORM_SQL} FROM entities WHERE id = ?)
`;

// Same expansion, bounded, for anything that joins `mentions`.
//
// Sibling sets have a long tail of single-mention rows: "Jeffrey Epstein" has
// 827 siblings of which 826 hold exactly one mention. Merging all of them made
// `ORDER BY m.id LIMIT 100` materialise and sort every matching mention --
// measured at 1,418ms and 1.1M rows read. Taking the 20 heaviest siblings
// instead returns a byte-identical first page in 3.5ms from 1,917 rows.
//
// The cap is a deliberate approximation: it merges the substantive duplicates
// (Ghislaine Maxwell's 15,543 + 1,126) and drops a tail worth ~1 mention each.
const ENTITY_SIBLINGS_CAPPED_SQL = `
  SELECT id FROM entities
  WHERE LOWER(canonical_name) = (SELECT LOWER(canonical_name) FROM entities WHERE id = ?)
    AND ${ENTITY_TYPE_NORM_SQL} = (SELECT ${ENTITY_TYPE_NORM_SQL} FROM entities WHERE id = ?)
  ORDER BY mention_count DESC
  LIMIT 20
`;

// Type casing is an artefact of which extractor produced the row, never
// something a reader should see. Present one vocabulary.
function normalizeEntityType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'org') return 'organization';
  return t;
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

const MAX_PUBLICATION_EXCLUSIONS_BYTES = 16_384;
// D1 permits at most 100 bound parameters per query. Visibility predicates
// share that budget with search/filter/pagination bindings, so keep the
// emergency list below the tightest document query's remaining headroom.
const MAX_PUBLICATION_EXCLUSION_TOKENS = 80;

function publicationExclusions(env) {
  const raw = env.PUBLICATION_EXCLUSIONS;
  if (raw === undefined || raw === null || raw === '') {
    return { documentIds: new Set(), houseBates: new Set() };
  }
  if (typeof raw !== 'string' ||
      new TextEncoder().encode(raw).byteLength > MAX_PUBLICATION_EXCLUSIONS_BYTES) {
    throw new Error('Invalid PUBLICATION_EXCLUSIONS configuration');
  }

  const tokens = raw.split(/[\s,]+/).filter(Boolean);
  if (tokens.length > MAX_PUBLICATION_EXCLUSION_TOKENS) {
    throw new Error('Invalid PUBLICATION_EXCLUSIONS configuration');
  }

  const documentIds = new Set();
  const houseBates = new Set();
  for (const token of tokens) {
    const docMatch = token.match(/^doc:(\d+)$/i);
    if (docMatch) {
      const id = Number(docMatch[1]);
      if (Number.isSafeInteger(id) && id > 0) {
        documentIds.add(id);
        continue;
      }
    }

    const houseMatch = token.match(/^house:(HOUSE_OVERSIGHT_\d+)$/i);
    if (houseMatch) {
      houseBates.add(houseMatch[1].toUpperCase());
      continue;
    }

    throw new Error('Invalid PUBLICATION_EXCLUSIONS configuration');
  }

  return { documentIds, houseBates };
}

function imageDocumentId(image) {
  const explicit = image && typeof image === 'object'
    ? image.doc_id ?? image.document_id
    : undefined;
  const explicitId = Number(explicit);
  if (Number.isSafeInteger(explicitId) && explicitId > 0) return explicitId;

  const filename = typeof image === 'string' ? image : image?.filename;
  const filenameMatch = String(filename || '').match(/^(\d+)_p\d+_\d+\.[a-z0-9]+$/i);
  if (!filenameMatch) return null;
  const filenameId = Number(filenameMatch[1]);
  return Number.isSafeInteger(filenameId) && filenameId > 0 ? filenameId : null;
}

function assertSqlColumn(column) {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(column)) {
    throw new Error('Unsafe SQL column name');
  }
  return column;
}

function documentVisibilitySql(idColumn, filenameColumn, exclusions) {
  const clauses = [];
  const bindings = [];
  idColumn = assertSqlColumn(idColumn);
  filenameColumn = assertSqlColumn(filenameColumn);

  if (exclusions.documentIds.size) {
    clauses.push(`${idColumn} NOT IN (${[...exclusions.documentIds].map(() => '?').join(', ')})`);
    bindings.push(...exclusions.documentIds);
  }
  if (exclusions.houseBates.size) {
    clauses.push(`(${filenameColumn} IS NULL OR UPPER(${filenameColumn}) NOT IN (${[...exclusions.houseBates].map(() => '?').join(', ')}))`);
    bindings.push(...exclusions.houseBates);
  }
  return {
    clause: clauses.length ? ' AND ' + clauses.join(' AND ') : '',
    bindings,
  };
}

function houseVisibilitySql(batesColumn, legacyIdColumn, exclusions) {
  const clauses = [];
  const bindings = [];
  batesColumn = assertSqlColumn(batesColumn);
  legacyIdColumn = assertSqlColumn(legacyIdColumn);

  if (exclusions.houseBates.size) {
    clauses.push(`UPPER(${batesColumn}) NOT IN (${[...exclusions.houseBates].map(() => '?').join(', ')})`);
    bindings.push(...exclusions.houseBates);
  }
  if (exclusions.documentIds.size) {
    clauses.push(`(${legacyIdColumn} IS NULL OR ${legacyIdColumn} NOT IN (${[...exclusions.documentIds].map(() => '?').join(', ')}))`);
    bindings.push(...exclusions.documentIds);
  }
  return {
    clause: clauses.length ? ' AND ' + clauses.join(' AND ') : '',
    bindings,
  };
}

function hasPublicationExclusions(exclusions) {
  return exclusions.documentIds.size > 0 || exclusions.houseBates.size > 0;
}

function documentRowExcluded(id, row, exclusions) {
  return exclusions.documentIds.has(Number(id)) ||
    exclusions.houseBates.has(String(row?.filename || '').toUpperCase());
}

function bindIfNeeded(statement, bindings) {
  return bindings.length ? statement.bind(...bindings) : statement;
}

function exclusionForPath(path, exclusions) {
  const docMatch = path.match(/^\/api\/documents\/(\d+)(?:\/(?:text|file|thumbnail))?$/);
  if (docMatch && exclusions.documentIds.has(Number(docMatch[1]))) {
    return true;
  }

  const videoThumbMatch = path.match(/^\/api\/videos\/(\d+)\/thumb$/);
  if (videoThumbMatch && exclusions.documentIds.has(Number(videoThumbMatch[1]))) {
    return true;
  }

  const imageMatch = path.match(/^\/api\/images\/([^/]+)$/);
  if (imageMatch && exclusions.documentIds.has(imageDocumentId(imageMatch[1]))) {
    return true;
  }

  const houseMatch = path.match(
    /^\/api\/house-oversight\/(?:documents|thumbnail)\/(HOUSE_OVERSIGHT_\d+)$/
  );
  if (houseMatch && exclusions.houseBates.has(houseMatch[1].toUpperCase())) {
    return true;
  }

  const housePageMatch = path.match(
    /^\/api\/house-oversight\/page\/(HOUSE_OVERSIGHT_\d+)\/\d+$/
  );
  return Boolean(
    housePageMatch &&
    exclusions.houseBates.has(housePageMatch[1].toUpperCase())
  );
}

function containsLikePattern(value) {
  const encoder = new TextEncoder();
  const maxBodyBytes = MAX_LIKE_PATTERN_BYTES - 2;
  let escaped = '';
  for (const char of String(value)) {
    const next = escapeLikePattern(char);
    if (encoder.encode(escaped + next).byteLength > maxBodyBytes) break;
    escaped += next;
  }
  return `%${escaped}%`;
}

async function checkRateLimit(limiter, key, label) {
  // The binding is absent in lightweight local/unit-test environments. Wrangler
  // provides it in production through the ratelimits entry in wrangler.toml.
  if (!limiter?.limit) {
    console.error(label + ' rate limiter binding is unavailable');
    return { allowed: false, unavailable: true };
  }

  try {
    const result = await limiter.limit({ key });
    if (typeof result?.success !== 'boolean') {
      throw new Error('Rate limiter returned an invalid result');
    }
    return { allowed: result.success, unavailable: false };
  } catch (e) {
    // Expensive routes fail closed when their configured limiter is unhealthy.
    // Otherwise a transient binding failure silently removes the only request
    // bound in front of D1 searches and uncacheable R2 Range reads.
    console.error(label + ' rate limiter error:', e);
    return { allowed: false, unavailable: true };
  }
}

async function documentIdExcludedByHouseToken(id, db, exclusions) {
  if (!exclusions.houseBates.size) return false;
  const row = await db.prepare('SELECT filename FROM documents WHERE id = ?').bind(id).first();
  return Boolean(row && exclusions.houseBates.has(String(row.filename || '').toUpperCase()));
}

async function imageSourceExcluded(filename, db, exclusions) {
  if (!hasPublicationExclusions(exclusions)) return false;
  const documentId = imageDocumentId(filename);
  // An object with no attributable source cannot be proven safe while an
  // emergency withdrawal is active, so fail closed instead of exposing it.
  if (documentId === null) return true;
  if (exclusions.documentIds.has(documentId)) return true;
  return documentIdExcludedByHouseToken(documentId, db, exclusions);
}

function isMediaDeliveryPath(path) {
  return (
    path === '/api/images' ||
    /^\/api\/documents\/\d+\/(?:file|thumbnail)$/.test(path) ||
    /^\/api\/videos\/\d+\/thumb$/.test(path) ||
    /^\/api\/images\/[^/]+$/.test(path) ||
    /^\/api\/house-oversight\/(?:page\/HOUSE_OVERSIGHT_\d+\/\d+|thumbnail\/HOUSE_OVERSIGHT_\d+)$/.test(path)
  );
}

function isLimiterExemptPath(path) {
  return path === '/health' || path === '/api' || path === '/api/' ||
    path === '/robots.txt' || path === '/' || path === '/app';
}

function rateLimitPolicy(request, path, env) {
  if (isLimiterExemptPath(path) || !path.startsWith('/api/')) return null;

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (isMediaDeliveryPath(path)) {
    const requestClass = request.headers.has('Range') ? 'range' : 'media';
    return {
      limiter: env.MEDIA_RATE_LIMITER,
      key: requestClass + ':' + ip,
      label: 'Media',
      limit: MEDIA_RATE_LIMIT,
      windowSeconds: MEDIA_RATE_WINDOW_SECONDS,
    };
  }

  return {
    limiter: env.API_RATE_LIMITER,
    key: ip,
    label: 'API',
    limit: RATE_LIMIT,
    windowSeconds: RATE_WINDOW_SECONDS,
  };
}

// Largest response we will store at the edge. Cloudflare caps cacheable
// objects (512 MB on this plan) and the DOJ-OGR videos run past 1 GB, so
// anything big is streamed straight through rather than failing a put.
const MAX_EDGE_CACHE_BYTES = 100 * 1024 * 1024;
// Browsers revalidate media quickly enough for an emergency publication
// exclusion to take effect. The Worker may keep a visible object at the edge
// longer, because active exclusions bypass the Cache API entirely below.
const MEDIA_CACHE_CONTROL = 'public, max-age=60, s-maxage=60, must-revalidate';
// Do not reuse entries written before media moved behind the private Worker;
// those responses can carry the old immutable policy or omit canonical/MIME
// headers. Bump this whenever the cached media response contract changes.
const MEDIA_CACHE_VERSION = 'private-r2-v2';

function mediaCacheKey(request) {
  const url = new URL(request.url);
  url.searchParams.set('__ep_media_cache', MEDIA_CACHE_VERSION);
  return new Request(url.toString(), request);
}

// Cloudflare's edge does NOT cache Worker-generated responses on its own --
// the Cache-Control headers set below only instruct the visitor's browser.
// The result was a 55 / 153,560 cache hit ratio: every media request re-read
// R2 and re-streamed through the Worker, even for a file thousands of people
// had already fetched. Putting media responses in the Cache API lets repeat
// requests be served at the edge, which cuts latency plus R2 Class B
// operations and Worker CPU. (Bytes delivered to the visitor are unchanged --
// caching moves where they are served from, it does not reduce them.)
//
// Range requests bypass this deliberately: storing a 206 would poison the
// entry for whole-file requests, and video seeking depends on them.
async function withEdgeCache(request, ctx, exclusions, produce) {
  // Never consult an entry created under an older publication policy. This is
  // especially important for aliases (a House Bates token reached through a
  // numeric /documents/:id route), which require D1 to resolve safely.
  if (hasPublicationExclusions(exclusions)) {
    const response = await produce();
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  if (request.method !== 'GET' || request.headers.has('Range')) {
    return await produce();
  }

  // caches/waitUntil are absent in lightweight local and unit-test
  // environments, same as the rate-limit binding above. Serving uncached is
  // always correct, so fall through rather than fail the request.
  if (typeof caches === 'undefined' || !caches?.default || !ctx?.waitUntil) {
    return await produce();
  }

  const cache = caches.default;
  const cacheKey = mediaCacheKey(request);
  const hit = await cache.match(cacheKey);
  if (hit) {
    // Cache entries can outlive a Worker deployment. Re-apply the current
    // response policy so an older cached media object cannot omit headers that
    // are now mandatory on every response class.
    return workerResponse(hit.body, {
      status: hit.status,
      statusText: hit.statusText,
      headers: {
        ...Object.fromEntries(hit.headers),
        ...noIndexHeaders,
      },
    });
  }

  const response = await produce();
  if (response.status === 200) {
    const declared = Number(response.headers.get('Content-Length') || 0);
    if (!declared || declared <= MAX_EDGE_CACHE_BYTES) {
      // waitUntil so the visitor is never made to wait on the cache write.
      ctx.waitUntil(
        cache.put(cacheKey, response.clone()).catch(e => {
          console.error('Edge cache put failed:', e);
        })
      );
    }
  }
  return response;
}

// Security headers
const securityHeaders = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

const noIndexHeaders = {
  'X-Robots-Tag': 'noindex',
};

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function allowedMethodsForPath(path) {
  return path === '/api/entities/search'
    ? ['POST', 'OPTIONS']
    : ['GET', 'OPTIONS'];
}

function workerResponse(body = null, init = {}) {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(securityHeaders)) {
    headers.set(name, value);
  }
  return new Response(body, { ...init, headers });
}

// JSON response helper
function json(data, status = 200, extraHeaders = {}) {
  return workerResponse(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders,
      ...noIndexHeaders,
      ...extraHeaders,
    },
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

    // workers.dev is directly reachable outside browser HSTS enforcement.
    // Redirect before rate limiting, body reads, D1 sessions, or R2 work.
    if (url.protocol !== 'https:') {
      url.protocol = 'https:';
      return workerResponse(null, {
        status: 308,
        headers: {
          Location: url.toString(),
          ...corsHeaders,
          ...noIndexHeaders,
        },
      });
    }

    let exclusions;
    try {
      exclusions = publicationExclusions(env);
    } catch (e) {
      console.error('Publication exclusions error:', e);
      return json(
        { error: 'Service temporarily unavailable. Please retry shortly.' },
        503,
        { 'Cache-Control': 'no-store', 'Retry-After': '5' }
      );
    }
    if (exclusionForPath(path, exclusions)) {
      return error('Document not found', 404);
    }

    // D1 read replication only takes effect through the Sessions API: without
    // withSession() every query is served by the primary in ENAM regardless of
    // the dashboard toggle. This API performs zero writes and the archive only
    // changes via occasional batch imports, so 'first-unconstrained' is the
    // right constraint -- read from whichever replica is nearest rather than
    // waiting on the primary. Sequential consistency still holds within the
    // session, so a single request never sees results move backwards.
    //
    // The guard keeps the unit-test env (a bare object exposing prepare()) and
    // any pre-replication binding working unchanged.
    const db = typeof env.DB?.withSession === 'function'
      ? env.DB.withSession('first-unconstrained')
      : env.DB;

    const allowedMethods = allowedMethodsForPath(path);

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return workerResponse(null, {
        headers: {
          ...corsHeaders,
          'Access-Control-Allow-Methods': allowedMethods.join(', '),
          Allow: allowedMethods.join(', '),
          ...noIndexHeaders,
        },
      });
    }

    const isEntitySearch = path === '/api/entities/search' && method === 'POST';
    if (method !== 'GET' && !isEntitySearch) {
      return json({ error: 'Method not allowed' }, 405, {
        Allow: allowedMethods.join(', '),
        'Access-Control-Allow-Methods': allowedMethods.join(', '),
      });
    }

    const ratePolicy = rateLimitPolicy(request, path, env);
    if (ratePolicy) {
      const rateLimit = await checkRateLimit(
        ratePolicy.limiter,
        ratePolicy.key,
        ratePolicy.label
      );

      if (rateLimit.unavailable) {
        return json(
          { error: 'Service temporarily unavailable. Please retry shortly.' },
          503,
          {
            'Cache-Control': 'no-store',
            'Retry-After': '5',
          }
        );
      }

      if (!rateLimit.allowed) {
        return json(
          { error: 'Rate limit exceeded. Please slow down.', retry_after: ratePolicy.windowSeconds },
          429,
          {
            'X-RateLimit-Limit': ratePolicy.limit.toString(),
            'Retry-After': ratePolicy.windowSeconds.toString(),
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
        return await getStats(db, exclusions);
      }

      if (path === '/api/search') {
        return await searchDocuments(url, db, exclusions);
      }

      if (path === '/api/browse') {
        return await browseDocuments(url, db, exclusions);
      }

      // Document routes
      const docMatch = path.match(/^\/api\/documents\/(\d+)$/);
      if (docMatch) {
        return await getDocument(parseInt(docMatch[1]), db, exclusions);
      }

      const docTextMatch = path.match(/^\/api\/documents\/(\d+)\/text$/);
      if (docTextMatch) {
        return await getDocumentText(parseInt(docTextMatch[1]), url, db, exclusions);
      }

      const docFileMatch = path.match(/^\/api\/documents\/(\d+)\/file$/);
      if (docFileMatch) {
        return await withEdgeCache(request, ctx, exclusions, () =>
          getDocumentFile(parseInt(docFileMatch[1]), request, db, env.R2, exclusions));
      }

      const docThumbMatch = path.match(/^\/api\/documents\/(\d+)\/thumbnail$/);
      if (docThumbMatch) {
        return await withEdgeCache(request, ctx, exclusions, () =>
          getDocumentThumbnail(parseInt(docThumbMatch[1]), request, db, env.R2, exclusions));
      }

      // Video routes
      if (path === '/api/videos') {
        return await listVideos(url, db, exclusions);
      }

      const videoThumbMatch = path.match(/^\/api\/videos\/(\d+)\/thumb$/);
      if (videoThumbMatch) {
        if (await documentIdExcludedByHouseToken(
          Number(videoThumbMatch[1]), db, exclusions
        )) return error('Document not found', 404);
        return await withEdgeCache(request, ctx, exclusions, () =>
          getVideoThumbnail(parseInt(videoThumbMatch[1]), request, env.R2));
      }

      // Maxwell tapes
      if (path === '/api/maxwell-tapes') {
        return await listMaxwellTapes(db, exclusions);
      }

      // Images
      if (path === '/api/images') {
        return await listImages(url, env.R2, db, exclusions);
      }

      const imageMatch = path.match(/^\/api\/images\/([^/]+)$/);
      if (imageMatch) {
        if (await imageSourceExcluded(imageMatch[1], db, exclusions)) {
          return error('Image not found', 404);
        }
        return await withEdgeCache(request, ctx, exclusions, () =>
          getImage(imageMatch[1], request, env.R2));
      }

      // Entity routes
      const entityMatch = path.match(/^\/api\/entities\/(\d+)$/);
      if (entityMatch) {
        return await getEntity(parseInt(entityMatch[1]), db, exclusions);
      }

      const entityMentionsMatch = path.match(/^\/api\/entities\/(\d+)\/mentions$/);
      if (entityMentionsMatch) {
        return await getEntityMentions(parseInt(entityMentionsMatch[1]), url, db, exclusions);
      }

      const entityCoocMatch = path.match(/^\/api\/entities\/(\d+)\/co-occurrences$/);
      if (entityCoocMatch) {
        return await getEntityCoOccurrences(parseInt(entityCoocMatch[1]), url, db, exclusions);
      }

      if (path === '/api/entities/search' && method === 'POST') {
        const declaredLength = request.headers.get('Content-Length');
        if (declaredLength !== null) {
          const contentLength = Number(declaredLength);
          if (!Number.isFinite(contentLength) || contentLength < 0 ||
              contentLength > MAX_ENTITY_REQUEST_BYTES) {
            throw new HttpError('Request body too large', 413);
          }
        }
        return await searchEntities(request, db, exclusions);
      }

      // Utility routes
      if (path === '/api/roles') {
        return getRoles();
      }

      if (path === '/api/document-types') {
        return await getDocumentTypes(db, exclusions);
      }

      if (path === '/api/data-sets') {
        return await getDataSets(db, exclusions);
      }

      // House Oversight routes
      if (path === '/api/house-oversight/documents') {
        return await listHouseOversightDocs(url, db, exclusions);
      }

      const hoDocMatch = path.match(/^\/api\/house-oversight\/documents\/(HOUSE_OVERSIGHT_\d+)$/);
      if (hoDocMatch) {
        if (await houseLegacyDocumentExcluded(hoDocMatch[1], db, exclusions)) {
          return error('Document not found', 404);
        }
        return await getHouseOversightDoc(hoDocMatch[1], db, env.R2, exclusions);
      }

      const hoPageMatch = path.match(/^\/api\/house-oversight\/page\/(HOUSE_OVERSIGHT_\d+)\/(\d+)$/);
      if (hoPageMatch) {
        const pageIndex = Number(hoPageMatch[2]);
        if (!Number.isSafeInteger(pageIndex) || pageIndex > 10_000) {
          throw new HttpError('page index must be between 0 and 10000');
        }
        const houseDoc = await getVisibleHouseMediaDocument(hoPageMatch[1], db, exclusions);
        if (!houseDoc || pageIndex >= Math.max(1, Number(houseDoc.page_count) || 1)) {
          return error('Document not found', 404);
        }
        return await withEdgeCache(request, ctx, exclusions, () =>
          getHouseOversightPage(hoPageMatch[1], pageIndex, request, env.R2));
      }

      const hoThumbMatch = path.match(/^\/api\/house-oversight\/thumbnail\/(HOUSE_OVERSIGHT_\d+)$/);
      if (hoThumbMatch) {
        if (!await getVisibleHouseMediaDocument(hoThumbMatch[1], db, exclusions)) {
          return error('Document not found', 404);
        }
        return await withEdgeCache(request, ctx, exclusions, () =>
          getHouseOversightThumbnail(hoThumbMatch[1], request, env.R2));
      }

      if (path === '/api/house-oversight/stats') {
        return await getHouseOversightStats(db, exclusions);
      }

      if (path === '/health') {
        return json({ status: 'healthy' });
      }

      if (path === '/robots.txt') {
        return workerResponse(
          'User-agent: *\nAllow: /\nDisallow: /api/\nCrawl-delay: 10\n',
          { headers: { 'Content-Type': 'text/plain', ...corsHeaders, ...noIndexHeaders } }
        );
      }

      // Frontend - redirect to Pages
      if (path === '/' || path === '/app') {
        // Will be served by Pages, this is fallback
        return workerResponse('Frontend served by Cloudflare Pages', {
          status: 200,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', ...noIndexHeaders },
        });
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
    endpoints: {
      search: '/api/search',
      documents: '/api/documents',
      entities: '/api/entities',
      stats: '/api/stats',
    },
  });
}

async function getStats(db, exclusions) {
  let docs;
  let entities;
  let mentions;
  let texts;
  let types;
  let dataSets;

  if (!hasPublicationExclusions(exclusions)) {
    [docs, entities, mentions, texts] = await Promise.all([
      db.prepare('SELECT COUNT(*) as count FROM documents').first(),
      db.prepare('SELECT COUNT(*) as count FROM entities').first(),
      db.prepare('SELECT COUNT(*) as count FROM mentions').first(),
      db.prepare('SELECT COUNT(*) as count FROM document_texts').first(),
    ]);
    types = await db.prepare(
      'SELECT document_type, COUNT(*) as count FROM documents GROUP BY document_type'
    ).all();
    dataSets = await db.prepare(
      'SELECT data_set, COUNT(*) as count FROM documents WHERE data_set IS NOT NULL GROUP BY data_set'
    ).all();
  } else {
    // Aggregate endpoints must not reveal stale totals from withdrawn records.
    // This more expensive join path runs only while an emergency policy is
    // active; the normal no-exclusion stats path remains unchanged.
    const visibility = documentVisibilitySql('d.id', 'd.filename', exclusions);
    const visible = (sql) => bindIfNeeded(db.prepare(sql), visibility.bindings);
    [docs, entities, mentions, texts] = await Promise.all([
      visible(`SELECT COUNT(*) as count FROM documents d WHERE 1=1${visibility.clause}`).first(),
      visible(`
        SELECT COUNT(DISTINCT m.entity_id) as count
        FROM mentions m JOIN documents d ON d.id = m.document_id
        WHERE 1=1${visibility.clause}
      `).first(),
      visible(`
        SELECT COUNT(*) as count
        FROM mentions m JOIN documents d ON d.id = m.document_id
        WHERE 1=1${visibility.clause}
      `).first(),
      visible(`
        SELECT COUNT(*) as count
        FROM document_texts t JOIN documents d ON d.id = t.document_id
        WHERE 1=1${visibility.clause}
      `).first(),
    ]);
    types = await visible(`
      SELECT d.document_type, COUNT(*) as count
      FROM documents d WHERE 1=1${visibility.clause}
      GROUP BY d.document_type
    `).all();
    dataSets = await visible(`
      SELECT d.data_set, COUNT(*) as count
      FROM documents d
      WHERE d.data_set IS NOT NULL${visibility.clause}
      GROUP BY d.data_set
    `).all();
  }

  return json({
    total_documents: docs.count,
    total_entities: entities.count,
    total_mentions: mentions.count,
    documents_with_text: texts.count,
    document_types: types.results.map(r => ({ type: r.document_type, count: r.count })),
    data_sets: mergeDataSetCounts(dataSets.results),
  });
}

async function searchDocuments(url, db, exclusions) {
  const q = url.searchParams.get('q') || '';
  const documentType = url.searchParams.get('document_type');
  const dataSets = resolveDataSetFilter(url.searchParams);
  const limit = parseIntegerParam(url.searchParams, 'limit', { defaultValue: 50, min: 1, max: 100 });
  const offset = parseIntegerParam(url.searchParams, 'offset', { defaultValue: 0, min: 0, max: 1_000_000 });

  // If no query but filters, browse by filter
  if (!q && (documentType || dataSets)) {
    let sql = 'SELECT * FROM documents WHERE 1=1';
    const visibility = documentVisibilitySql('documents.id', 'documents.filename', exclusions);
    sql += visibility.clause;
    const params = [...visibility.bindings];

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
  const visibility = documentVisibilitySql('d.id', 'd.filename', exclusions);

  // Run document search and entity search in parallel
  const [results, countResult, entityResults] = await Promise.all([
    // Document search
    db.prepare(`
      SELECT d.id, d.filename, d.title, d.data_set, d.document_type, d.source_url,
             ${hasTextExpr('d.id')} AS has_text,
             d.processing_status, d.ocr_confidence,
             snippet(document_fts, 1, '>>>', '<<<', '...', 32) as snippet
      FROM document_fts
      JOIN documents d ON d.id = document_fts.document_id
      WHERE document_fts MATCH ?
      ${visibility.clause}
      ${documentType ? 'AND d.document_type = ?' : ''}
      ${dataSets ? `AND d.data_set IN (${dataSetPlaceholders(dataSets)})` : ''}
      ORDER BY rank
      LIMIT ? OFFSET ?
    `).bind(
      ftsQuery,
      ...visibility.bindings,
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
      ${visibility.clause}
      ${documentType ? 'AND d.document_type = ?' : ''}
      ${dataSets ? `AND d.data_set IN (${dataSetPlaceholders(dataSets)})` : ''}
    `).bind(
      ftsQuery,
      ...visibility.bindings,
      ...(documentType ? [documentType] : []),
      ...(dataSets || []),
    ).first(),

    // Entity search (top 5 matching entities)
    // Extract individual terms for multi-word queries
    (async () => {
      const cleanQ = cleanSearchText(q);
      const terms = cleanQ.split(/\s+/).filter(t => t.length > 2 && !/^(OR|AND|THE|FOR|WITH)$/i.test(t));
      if (terms.length === 0) return { results: [] };

      // Search for entities matching any significant term
      const conditions = terms.slice(0, 3).map(() => "canonical_name LIKE ? ESCAPE '\\'").join(' OR ');
      const params = terms.slice(0, 3).map(containsLikePattern);

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
    entities: (hasPublicationExclusions(exclusions) ? [] : entityResults.results).map(e => ({
      entity_id: e.id,
      name: e.canonical_name,
      type: e.entity_type,
      mention_count: e.mention_count,
    })),
  });
}

async function browseDocuments(url, db, exclusions) {
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
  const visibility = documentVisibilitySql('documents.id', 'documents.filename', exclusions);
  sql += visibility.clause;
  const params = [...visibility.bindings];

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

  // Filter on stored text rather than the has_text column, so the filter and
  // the flag the response reports can never disagree.
  if (hasText !== null) {
    sql += Number(hasText)
      ? ` AND ${hasTextExpr('documents.id')}`
      : ` AND NOT ${hasTextExpr('documents.id')}`;
  }

  // Get total. Built before the select list gains the derived column below,
  // so the `SELECT *` replacement still matches.
  const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as count');
  const total = await db.prepare(countSql).bind(...params).first();

  sql = sql.replace('SELECT *', `SELECT *, ${hasTextExpr('documents.id')} AS has_text_actual`);
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
      has_text: !!d.has_text_actual,
      processing_status: d.processing_status,
      ocr_confidence: d.ocr_confidence,
    })),
  });
}

async function getDocument(id, db, exclusions) {
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first();
  if (!doc) {
    return error('Document not found', 404);
  }
  if (documentRowExcluded(id, doc, exclusions)) return error('Document not found', 404);

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
    // The text row was just fetched — report what is actually there rather
    // than the stale column, so this never disagrees with /documents/:id/text.
    has_text: !!text?.full_text,
    processing_status: doc.processing_status,
    ocr_confidence: doc.ocr_confidence,
    download_timestamp: doc.download_timestamp,
    text_preview: text?.full_text?.substring(0, 2000) || null,
    word_count: text?.word_count || 0,
  });
}

async function getDocumentText(id, url, db, exclusions) {
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first();
  if (!doc) {
    return error('Document not found', 404);
  }
  if (documentRowExcluded(id, doc, exclusions)) return error('Document not found', 404);

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

const IMAGE_MEDIA_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
]);

function r2GetOptions(request) {
  return request.headers.has('Range') ? { range: request.headers } : undefined;
}

async function getR2MediaObject(r2, key, request) {
  if (request.headers.has('Range') && typeof r2.head === 'function') {
    const head = await r2.head(key);
    if (head && Number.isFinite(head.size) &&
        requestRangeIsUnsatisfiable(request.headers.get('Range'), head.size)) {
      return { response: rangeNotSatisfiableResponse(head.size) };
    }
  }
  return { object: await r2.get(key, r2GetOptions(request)) };
}

function canonicalLink(path) {
  return `<https://epsteinproject.org${path}>; rel=canonical`;
}

function safeDownloadFilename(value) {
  return String(value || 'download').replace(/["\\\r\n]/g, '_').slice(0, 180);
}

function imageMediaType(filename, object) {
  const stored = String(object?.httpMetadata?.contentType || '')
    .split(';', 1)[0].trim().toLowerCase();
  if (IMAGE_MEDIA_TYPES.has(stored)) return stored;

  const extension = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return ({
    gif: 'image/gif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    webp: 'image/webp',
  })[extension] || null;
}

function r2MediaResponse(object, request, {
  contentType,
  canonicalPath,
  downloadName = null,
  forceRange = false,
}) {
  const rangeRequested = forceRange || request.headers.has('Range');
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, ETag, Link',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    ...corsHeaders,
    ...noIndexHeaders,
  });
  object.writeHttpMetadata?.(headers);

  // Stored object metadata is descriptive, not policy. Re-apply the public
  // response contract after writeHttpMetadata() so an old R2 Cache-Control or
  // Content-Type value cannot weaken withdrawal timing or MIME enforcement.
  headers.set('Content-Type', contentType);
  headers.set('Cache-Control', MEDIA_CACHE_CONTROL);
  headers.set('Link', canonicalLink(canonicalPath));
  if (object.httpEtag) headers.set('ETag', object.httpEtag);
  if (downloadName) {
    headers.set('Content-Disposition', `attachment; filename="${safeDownloadFilename(downloadName)}"`);
  } else {
    headers.delete('Content-Disposition');
  }

  let status = 200;
  if (rangeRequested) {
    const range = object.range;
    const suffix = Number(range?.suffix);
    const start = Number.isFinite(Number(range?.offset))
      ? Number(range.offset)
      : Number.isFinite(suffix) && Number.isFinite(object.size)
        ? Math.max(0, object.size - suffix)
        : NaN;
    const length = Number.isFinite(Number(range?.length))
      ? Number(range.length)
      : Number.isFinite(suffix) && Number.isFinite(object.size)
        ? Math.min(suffix, object.size)
        : NaN;

    if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0 ||
        !Number.isFinite(object.size) || start >= object.size) {
      headers.set('Cache-Control', 'no-store');
      if (Number.isFinite(object.size)) {
        headers.set('Content-Range', `bytes */${object.size}`);
      }
      headers.set('Content-Length', '0');
      return workerResponse(null, { status: 416, headers });
    }

    headers.set('Content-Range', `bytes ${start}-${start + length - 1}/${object.size}`);
    headers.set('Content-Length', String(length));
    status = 206;
  } else if (Number.isFinite(object.size)) {
    headers.set('Content-Length', String(object.size));
  }

  return workerResponse(object.body, { status, headers });
}

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

function documentFileResponse(
  id,
  doc,
  object,
  request,
  canonicalPath = `/documents/${id}`,
  forceRange = false
) {
  if (object?.size === 0) {
    return error('File is empty', 502);
  }
  const wantsDownload = new URL(request.url).searchParams.get('download') === '1';
  return r2MediaResponse(object, request, {
    contentType: documentMediaType(doc, object),
    canonicalPath,
    downloadName: wantsDownload ? doc.filename || doc.title || `document-${id}` : null,
    forceRange,
  });
}

function rangeNotSatisfiableResponse(size) {
  return json({ error: 'Requested range is not satisfiable' }, 416, {
    'Accept-Ranges': 'bytes',
    'Content-Range': `bytes */${size}`,
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range',
    'Cache-Control': 'no-store',
  });
}

function requestRangeIsUnsatisfiable(value, objectSize) {
  // A NULL D1 file_size means "unknown", not a zero-byte object. Number(null)
  // is 0, which previously rejected every valid browser range for legacy
  // data-set-8 videos before R2 could return the authoritative object size.
  if (objectSize === null || objectSize === undefined || objectSize === '') return false;
  const size = Number(objectSize);
  if (!Number.isFinite(size) || size < 0) return false;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(value || '').trim());
  if (!match || (!match[1] && !match[2])) return false;
  if (!match[1]) return Number(match[2]) === 0;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : null;
  return !Number.isFinite(start) || start >= size || (end !== null && end < start);
}

function houseOversightNative(doc) {
  if (doc.data_set !== 'house-oversight-estate' || doc.document_type !== 'video') return null;
  if (!/^HOUSE_OVERSIGHT_\d+$/.test(String(doc.filename || ''))) return null;
  const match = String(doc.title || '').match(/\.(mp4|mov|avi|wmv)$/i);
  if (!match) return null;
  const extension = match[1].toLowerCase();
  const contentTypes = {
    avi: 'video/x-msvideo',
    mov: 'video/quicktime',
    mp4: 'video/mp4',
    wmv: 'video/x-ms-wmv',
  };
  return {
    key: `house-oversight/NATIVES/001/${doc.filename}.${extension}`,
    contentType: contentTypes[extension],
    playbackKey: `streaming/house-oversight/NATIVES/001/${doc.filename}.mp4`,
    playbackContentType: 'video/mp4',
  };
}

async function getHouseOversightNativeFile(id, doc, request, r2, native) {
  const rangeRequested = request.headers.has('Range');
  const searchParams = new URL(request.url).searchParams;
  const wantsDownload = searchParams.get('download') === '1';
  const wantsStream = searchParams.get('stream') === '1';
  const target = wantsDownload
    ? { key: native.key, contentType: native.contentType }
    : { key: native.playbackKey, contentType: native.playbackContentType };
  if (rangeRequested) {
    const storedSize = Number(doc.file_size);
    const targetHead = typeof r2.head === 'function' ? await r2.head(target.key) : null;
    // Prefer the authoritative selected R2 representation. Legacy estate rows
    // can have a null/unknown file_size even when the released native exists.
    const targetSize = Number(targetHead?.size) > 0
      ? Number(targetHead.size)
      : wantsDownload && Number.isFinite(storedSize) && storedSize > 0
        ? storedSize
        : NaN;
    if (!Number.isFinite(targetSize) || targetSize <= 0) return error('File not available', 404);
    if (requestRangeIsUnsatisfiable(request.headers.get('Range'), targetSize)) {
      return rangeNotSatisfiableResponse(targetSize);
    }
  }
  const bootstrapsStream = !wantsDownload && wantsStream && !rangeRequested;
  const rangeOpts = rangeRequested
    ? { range: request.headers }
    : bootstrapsStream
      ? { range: { offset: 0, length: 1024 * 1024 } }
      : undefined;

  const object = await r2.get(target.key, rangeOpts);
  if (!object) return error('File not available', 404);
  if (object.size === 0) return error('File is empty', 502);
  return r2MediaResponse(object, request, {
    contentType: target.contentType,
    canonicalPath: `/documents/${id}`,
    downloadName: wantsDownload
      ? doc.title || doc.filename || `document-${id}`
      : null,
    forceRange: bootstrapsStream,
  });
}

async function getDocumentFile(id, request, db, r2, exclusions) {
  const doc = await db.prepare(
    'SELECT local_path, filename, title, data_set, content_type, document_type, file_size FROM documents WHERE id = ?'
  ).bind(id).first();

  if (!doc) {
    return error('Document not found', 404);
  }
  if (documentRowExcluded(id, doc, exclusions)) return error('Document not found', 404);

  const estateNative = houseOversightNative(doc);
  if (estateNative) {
    try {
      return await getHouseOversightNativeFile(id, doc, request, r2, estateNative);
    } catch (e) {
      console.error('R2 fetch error for House Oversight native:', e);
      return error('File not available', 404);
    }
  }

  // House Oversight scan-only docs - serve first page image from R2
  if (doc.data_set === 'house-oversight-estate') {
    const bates = doc.filename; // e.g., HOUSE_OVERSIGHT_010477
    const batesNum = parseInt(bates.replace('HOUSE_OVERSIGHT_', ''));
    const folderNum = Math.floor((batesNum - 10477) / 2000 + 1);
    const folder = folderNum.toString().padStart(3, '0');
    const r2Key = `house-oversight/IMAGES/${folder}/${bates}.jpg`;

    try {
      const { object, response } = await getR2MediaObject(r2, r2Key, request);
      if (response) return response;
      if (object) {
        return r2MediaResponse(object, request, {
          contentType: 'image/jpeg',
          canonicalPath: `/house-oversight/${bates}`,
          downloadName: new URL(request.url).searchParams.get('download') === '1'
            ? `${bates}.jpg`
            : null,
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
      let effectiveRangeOpts = rangeOpts;
      let bootstrapsStream = false;
      let rangeTargetSize = null;
      // Videos: prefer the faststart remux under streaming/ (originals stay
      // byte-identical to the DOJ release for hash verification). Both playback
      // and downloads remain behind this policy-aware, rate-limited Worker.
      if (doc.document_type === 'video') {
        const searchParams = new URL(request.url).searchParams;
        const wantsDownload = searchParams.get('download') === '1';
        const wantsStream = searchParams.get('stream') === '1';
        bootstrapsStream = !wantsDownload && wantsStream && !rangeRequested;
        effectiveRangeOpts = bootstrapsStream
          ? { range: { offset: 0, length: 1024 * 1024 } }
          : rangeOpts;
        const streamKey = `streaming/${r2Key}`;
        if (!wantsDownload) {
          if (rangeRequested && typeof r2.head === 'function') {
            const streamHead = await r2.head(streamKey);
            if (streamHead && Number.isFinite(streamHead.size)) {
              rangeTargetSize = streamHead.size;
              if (requestRangeIsUnsatisfiable(request.headers.get('Range'), rangeTargetSize)) {
                return rangeNotSatisfiableResponse(rangeTargetSize);
              }
            }
          }
          const streamObject = await r2.get(streamKey, effectiveRangeOpts);
          if (streamObject) {
            return documentFileResponse(id, doc, streamObject, request, `/documents/${id}`, bootstrapsStream);
          }
        }
      }
      if (rangeRequested && requestRangeIsUnsatisfiable(request.headers.get('Range'), doc.file_size)) {
        return rangeNotSatisfiableResponse(Number(doc.file_size));
      }
      const object = await r2.get(r2Key, effectiveRangeOpts);
      if (object) {
        return documentFileResponse(id, doc, object, request, `/documents/${id}`, bootstrapsStream);
      }
      if (rangeRequested && typeof r2.head === 'function') {
        const objectHead = await r2.head(r2Key);
        if (objectHead && Number.isFinite(objectHead.size)) rangeTargetSize = objectHead.size;
        if (rangeTargetSize !== null) return rangeNotSatisfiableResponse(rangeTargetSize);
      }
    } catch (e) {
      console.error('R2 fetch error:', e);
    }
  }

  return error('File not available', 404);
}

async function getDocumentThumbnail(id, request, db, r2, exclusions) {
  const doc = await db.prepare('SELECT local_path, filename FROM documents WHERE id = ?').bind(id).first();
  if (!doc) {
    return error('Document not found', 404);
  }
  if (documentRowExcluded(id, doc, exclusions)) return error('Document not found', 404);

  // Try pre-generated thumbnail first
  try {
    const { object: thumb, response } = await getR2MediaObject(
      r2, `thumbnails/${id}.jpg`, request
    );
    if (response) return response;
    if (thumb) {
      return r2MediaResponse(thumb, request, {
        contentType: 'image/jpeg',
        canonicalPath: `/documents/${id}`,
      });
    }
  } catch (e) {
    // No thumbnail, fall through
  }

  // Fallback: serve first page of PDF as "thumbnail" (returns PDF, not image)
  // For now, return a placeholder or 404
  return error('Thumbnail not available', 404);
}

async function listVideos(url, db, exclusions) {
  const limit = parseIntegerParam(url.searchParams, 'limit', { defaultValue: 100, min: 1, max: 500 });
  const offset = parseIntegerParam(url.searchParams, 'offset', { defaultValue: 0, min: 0, max: 1_000_000 });

  const visibility = documentVisibilitySql('documents.id', 'documents.filename', exclusions);
  const totalStatement = db.prepare(
    "SELECT COUNT(*) as count FROM documents WHERE document_type = 'video'" + visibility.clause
  );
  const total = await bindIfNeeded(totalStatement, visibility.bindings).first();

  const videos = await db.prepare(
    "SELECT id, filename, title, data_set FROM documents WHERE document_type = 'video'" +
    visibility.clause + ' ORDER BY id LIMIT ? OFFSET ?'
  ).bind(...visibility.bindings, limit, offset).all();

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

// Stream every object through this Worker so publication policy and the media
// limiter remain authoritative even when somebody knows the old R2 key.
async function getVideoThumbnail(id, request, r2) {
  const { object, response } = await getR2MediaObject(
    r2, `thumbnails/${id}.jpg`, request
  );
  if (response) return response;
  if (!object) {
    return missingThumbnailResponse();
  }
  return r2MediaResponse(object, request, {
    contentType: 'image/jpeg',
    canonicalPath: `/documents/${id}`,
  });
}

function missingThumbnailResponse() {
  return workerResponse(null, {
    status: 302,
    headers: {
      'Location': MISSING_THUMBNAIL_URL,
      'Cache-Control': 'public, max-age=3600',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      ...corsHeaders,
      ...noIndexHeaders,
    },
  });
}

async function listMaxwellTapes(db, exclusions) {
  const visibility = documentVisibilitySql('documents.id', 'documents.filename', exclusions);
  const tapes = await db.prepare(
    "SELECT * FROM documents WHERE document_type = 'audio' AND data_set = 'maxwell-interview'" +
    visibility.clause + ' ORDER BY filename'
  ).bind(...visibility.bindings).all();

  return json({
    total: tapes.results.length,
    description: 'Ghislaine Maxwell DOJ interview recordings',
    tapes: tapes.results.map(t => ({
      id: t.id,
      filename: t.filename,
      title: t.title || t.filename,
      day: t.title?.includes('Day 1') ? 'Day 1' : t.title?.includes('Day 2') ? 'Day 2' : 'Unknown',
      part: t.title?.match(/Part\s*(\d+)/)?.[1] || null,
    })),
  });
}

async function listImages(url, r2, db, exclusions) {
  const limit = parseIntegerParam(url.searchParams, 'limit', { defaultValue: 60, min: 1, max: 200 });
  const offset = parseIntegerParam(url.searchParams, 'offset', { defaultValue: 0, min: 0, max: 1_000_000 });

  // Try to get manifest from R2
  try {
    const manifest = await r2.get('images/manifest.json');
    if (manifest) {
      const data = await manifest.json();
      const images = Array.isArray(data.images) ? data.images : [];
      const excludedImageDocumentIds = new Set(exclusions.documentIds);
      if (exclusions.houseBates.size) {
        const bates = [...exclusions.houseBates];
        const houseRows = await db.prepare(`
          SELECT legacy_document_id
          FROM house_oversight_documents
          WHERE UPPER(bates_number) IN (${bates.map(() => '?').join(', ')})
        `).bind(...bates).all();
        for (const row of houseRows.results || []) {
          const legacyId = Number(row.legacy_document_id);
          if (Number.isSafeInteger(legacyId) && legacyId > 0) {
            excludedImageDocumentIds.add(legacyId);
          }
        }
      }
      const visibleImages = images.filter((image) => {
        const documentId = imageDocumentId(image);
        if (documentId !== null && excludedImageDocumentIds.has(documentId)) return false;
        const bates = String(
          image?.bates ?? image?.bates_number ?? image?.document_filename ?? ''
        ).toUpperCase();
        if (bates && exclusions.houseBates.has(bates)) return false;
        // When policy is active, do not publish a manifest object that cannot
        // be attributed to either a source document or an explicit Bates id.
        return !hasPublicationExclusions(exclusions) || documentId !== null || Boolean(bates);
      });
      return json({
        total: exclusions.documentIds.size || exclusions.houseBates.size
          ? visibleImages.length
          : Number(data.total_images) || visibleImages.length,
        offset,
        images: visibleImages.slice(offset, offset + limit),
      });
    }
  } catch (e) {
    console.error('Error loading manifest:', e);
  }

  return json({ total: 0, images: [], status: 'manifest not found' });
}

async function getImage(filename, request, r2) {
  // Sanitize filename
  if (filename.includes('..') || filename.includes('/')) {
    return error('Invalid filename', 400);
  }

  const { object, response } = await getR2MediaObject(
    r2, `images/${filename}`, request
  );
  if (response) return response;
  if (!object) {
    return error('Image not found', 404);
  }
  const contentType = imageMediaType(filename, object);
  if (!contentType) return error('Image not found', 404);
  const documentId = imageDocumentId(filename);
  return r2MediaResponse(object, request, {
    contentType,
    canonicalPath: documentId === null ? '/images' : `/documents/${documentId}`,
  });
}

async function getEntity(id, db, exclusions) {
  const entity = await db.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first();
  if (!entity) {
    return error('Entity not found', 404);
  }

  // During an emergency exclusion, derive the public count from visible
  // mentions rather than the precomputed all-record total. If the entity only
  // occurred in withdrawn documents, the entity itself is no longer public.
  let merged;
  if (hasPublicationExclusions(exclusions)) {
    const visibility = documentVisibilitySql('d.id', 'd.filename', exclusions);
    merged = await db.prepare(`
      SELECT COUNT(*) AS total
      FROM mentions m
      JOIN documents d ON d.id = m.document_id
      WHERE m.entity_id IN (${ENTITY_SIBLINGS_SQL})
      ${visibility.clause}
    `).bind(id, id, ...visibility.bindings).first();
    if (!merged?.total) return error('Entity not found', 404);
  } else {
    // Report the merged total so this agrees with search and the mentions list.
    merged = await db.prepare(
      `SELECT SUM(mention_count) AS total FROM entities WHERE id IN (${ENTITY_SIBLINGS_SQL})`
    ).bind(id, id).first();
  }

  return json({
    id: entity.id,
    canonical_name: entity.canonical_name,
    entity_type: normalizeEntityType(entity.entity_type),
    first_name: entity.first_name,
    last_name: entity.last_name,
    aliases: entity.aliases ? JSON.parse(entity.aliases) : null,
    description: entity.description,
    is_public_figure: !!entity.is_public_figure,
    disambiguation_notes: entity.disambiguation_notes,
    confidence: entity.confidence,
    mention_count: merged?.total ?? entity.mention_count,
    needs_review: !!entity.needs_review,
  });
}

// Served from entity_cooccurrence, precomputed offline by
// src/build_cooccurrence.py from the backup dumps (top 40 partners per
// entity, >= 2 shared docs, mega-documents excluded). Computing this live
// over 3.7M mentions is not viable in D1.
async function getEntityCoOccurrences(entityId, url, db, exclusions) {
  const type = url.searchParams.get('type');
  const limit = parseIntegerParam(url.searchParams, 'limit', { defaultValue: 20, min: 1, max: 40 });
  if (type && type.length > 40) {
    throw new HttpError('type must be 40 characters or fewer');
  }
  // The precomputed table has no per-document provenance, so it cannot be
  // safely subtracted after a record is withdrawn. Fail closed until rebuilt.
  if (hasPublicationExclusions(exclusions)) {
    return json({ entity_id: entityId, results: [] });
  }

  try {
    const results = await db.prepare(`
      SELECT c.other_entity_id, c.shared_docs, e.canonical_name, e.entity_type, e.mention_count
      FROM entity_cooccurrence c
      JOIN entities e ON e.id = c.other_entity_id
      WHERE c.entity_id = ?
      ${type ? 'AND LOWER(e.entity_type) = LOWER(?)' : ''}
      ORDER BY c.shared_docs DESC
      LIMIT ?
    `).bind(entityId, ...(type ? [type] : []), limit).all();

    return json({
      entity_id: entityId,
      results: results.results.map(r => ({
        entity_id: r.other_entity_id,
        name: r.canonical_name,
        type: r.entity_type,
        mention_count: r.mention_count,
        shared_docs: r.shared_docs,
      })),
    });
  } catch (e) {
    // Table not imported yet — degrade to an empty list instead of a 500.
    if (String(e).includes('no such table')) {
      return json({ entity_id: entityId, results: [] });
    }
    throw e;
  }
}

async function getEntityMentions(entityId, url, db, exclusions) {
  const role = url.searchParams.get('role');
  const limit = parseIntegerParam(url.searchParams, 'limit', { defaultValue: 100, min: 1, max: 500 });
  const offset = parseIntegerParam(url.searchParams, 'offset', { defaultValue: 0, min: 0, max: 1_000_000 });

  const entity = await db.prepare('SELECT canonical_name FROM entities WHERE id = ?').bind(entityId).first();
  if (!entity) {
    return error('Entity not found', 404);
  }

  // Search merges duplicate entity rows, so the mentions view must too --
  // otherwise clicking a result showing 16,669 mentions lands on a page
  // listing only the 15,543 that happen to hang off the representative id.
  let sql = `
    SELECT m.*, d.filename, d.title, d.document_type, d.data_set
    FROM mentions m
    JOIN documents d ON d.id = m.document_id
    WHERE m.entity_id IN (${ENTITY_SIBLINGS_CAPPED_SQL})
  `;
  const visibility = documentVisibilitySql('d.id', 'd.filename', exclusions);
  sql += visibility.clause;
  const params = [entityId, entityId, ...visibility.bindings];

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

async function readUtf8Body(request, maxBytes) {
  if (!request.body) return '';

  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytesRead = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel('Request body too large');
        throw new HttpError('Request body too large', 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError('Request body must be valid UTF-8');
  } finally {
    reader.releaseLock();
  }
}

async function searchEntities(request, db, exclusions) {
  const rawBody = await readUtf8Body(request, MAX_ENTITY_REQUEST_BYTES);

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

  // Collapse duplicate rows into one result per name+type, summing the split
  // mention counts, so a search for a person returns that person once with a
  // true total rather than several partial rows.
  let sql = `
    SELECT id, canonical_name, ${ENTITY_TYPE_NORM_SQL} AS entity_type,
           SUM(mention_count) AS mention_count, MAX(mention_count) AS heaviest
    FROM entities
    WHERE canonical_name LIKE ? ESCAPE '\\'
  `;
  const likePattern = containsLikePattern(cleanQuery);
  const params = [likePattern];

  if (entity_type) {
    if (typeof entity_type !== 'string' || entity_type.length > 50) {
      throw new HttpError('entity_type must be a string of at most 50 characters');
    }
    sql += ` AND ${ENTITY_TYPE_NORM_SQL} = LOWER(?)`;
    params.push(entity_type);
  }

  sql += ` GROUP BY LOWER(canonical_name), ${ENTITY_TYPE_NORM_SQL} ORDER BY SUM(mention_count) DESC LIMIT ?`;
  params.push(resultLimit);

  const results = await db.prepare(sql).bind(...params).all();
  const visibility = documentVisibilitySql('d.id', 'd.filename', exclusions);

  // Get distinct documents where entity is mentioned
  const entities = await Promise.all(results.results.map(async (e) => {
    const [mentions, visibleCount] = await Promise.all([
      db.prepare(`
        SELECT DISTINCT m.document_id, d.filename as document_filename, m.role
        FROM mentions m
        JOIN documents d ON d.id = m.document_id
        WHERE m.entity_id IN (${ENTITY_SIBLINGS_CAPPED_SQL})
        ${visibility.clause}
        GROUP BY m.document_id
        LIMIT 5
      `).bind(e.id, e.id, ...visibility.bindings).all(),
      hasPublicationExclusions(exclusions)
        ? db.prepare(`
            SELECT COUNT(*) AS total
            FROM mentions m
            JOIN documents d ON d.id = m.document_id
            WHERE m.entity_id IN (${ENTITY_SIBLINGS_CAPPED_SQL})
            ${visibility.clause}
          `).bind(e.id, e.id, ...visibility.bindings).first()
        : Promise.resolve(null),
    ]);

    return {
      entity_id: e.id,
      canonical_name: e.canonical_name,
      entity_type: normalizeEntityType(e.entity_type),
      mention_count: visibleCount?.total ?? e.mention_count,
      mentions: mentions.results.map(m => ({
        role: m.role || 'unknown',
        document_id: m.document_id,
        document_filename: m.document_filename,
      })),
    };
  }));

  // total_results used to be entities.length -- the page size. The UI rendered
  // it as "5 found" under People & Organizations while the real match count
  // for "maxwell" is in the hundreds, sitting next to a genuine COUNT(*) of
  // documents, so the two read as equally authoritative. Count the merged
  // groups, not the rows: a bare COUNT(*) over the same predicate returns the
  // pre-merge row count, which is several times larger and equally wrong.
  const totalRow = await db.prepare(`
    SELECT COUNT(*) AS total FROM (
      SELECT 1 FROM entities
      WHERE canonical_name LIKE ? ESCAPE '\\'
      ${entity_type ? `AND ${ENTITY_TYPE_NORM_SQL} = LOWER(?)` : ''}
      GROUP BY LOWER(canonical_name), ${ENTITY_TYPE_NORM_SQL}
    )
  `).bind(likePattern, ...(entity_type ? [entity_type] : [])).first();
  const visibleEntities = hasPublicationExclusions(exclusions)
    ? entities.filter(entity => entity.mentions.length > 0)
    : entities;

  return json({
    query,
    total_results: visibleEntities.length,
    total_matches: hasPublicationExclusions(exclusions)
      ? visibleEntities.length
      : totalRow?.total ?? visibleEntities.length,
    results: visibleEntities,
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

async function getDocumentTypes(db, exclusions) {
  const visibility = documentVisibilitySql('documents.id', 'documents.filename', exclusions);
  const types = await db.prepare(
    'SELECT document_type, COUNT(*) as count FROM documents WHERE 1=1' +
    visibility.clause + ' GROUP BY document_type ORDER BY count DESC'
  ).bind(...visibility.bindings).all();

  return json({
    document_types: types.results.map(t => ({
      type: t.document_type,
      count: t.count,
    })),
  });
}

async function getDataSets(db, exclusions) {
  const visibility = documentVisibilitySql('documents.id', 'documents.filename', exclusions);
  const sets = await db.prepare(
    'SELECT data_set, COUNT(*) as count FROM documents WHERE data_set IS NOT NULL' +
    visibility.clause + ' GROUP BY data_set ORDER BY count DESC'
  ).bind(...visibility.bindings).all();

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

async function houseLegacyDocumentExcluded(bates, db, exclusions) {
  if (!exclusions.documentIds.size) return false;
  const row = await db.prepare(
    'SELECT legacy_document_id FROM house_oversight_documents WHERE bates_number = ?'
  ).bind(bates).first();
  return Boolean(row && exclusions.documentIds.has(Number(row.legacy_document_id)));
}

async function getVisibleHouseMediaDocument(bates, db, exclusions) {
  const row = await db.prepare(
    'SELECT legacy_document_id, page_count FROM house_oversight_documents WHERE bates_number = ?'
  ).bind(bates).first();
  if (!row) return null;
  if (exclusions.houseBates.has(String(bates).toUpperCase()) ||
      exclusions.documentIds.has(Number(row.legacy_document_id))) {
    return null;
  }
  return row;
}

async function listHouseOversightDocs(url, db, exclusions) {
  const limit = parseIntegerParam(url.searchParams, 'limit', { defaultValue: 50, min: 1, max: 100 });
  const offset = parseIntegerParam(url.searchParams, 'offset', { defaultValue: 0, min: 0, max: 1_000_000 });
  const search = url.searchParams.get('search') || '';

  if (search.length > 100) {
    throw new HttpError('Search too long. Maximum 100 characters allowed.');
  }

  let sql = 'SELECT * FROM house_oversight_documents WHERE 1=1';
  const visibility = houseVisibilitySql(
    'house_oversight_documents.bates_number',
    'house_oversight_documents.legacy_document_id',
    exclusions
  );
  sql += visibility.clause;
  const params = [...visibility.bindings];

  if (search) {
    sql += " AND (bates_number LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')";
    const pattern = containsLikePattern(search);
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

async function getHouseOversightDoc(bates, db, r2, exclusions) {
  // text_content is empty on all 2,897 estate rows -- the importer writes their
  // OCR text to document_texts keyed by legacy_document_id. Reading the column
  // made this endpoint report no text for documents whose text /api/search was
  // already returning.
  const doc = await db.prepare(`
    SELECT h.*, t.full_text,
      d.id AS archive_document_id,
      d.document_type AS archive_document_type,
      d.content_type AS archive_content_type
    FROM house_oversight_documents h
    LEFT JOIN document_texts t ON t.document_id = h.legacy_document_id
    LEFT JOIN documents d ON d.id = h.legacy_document_id
    WHERE h.bates_number = ?
  `).bind(bates).first();

  if (!doc) {
    return error('Document not found', 404);
  }
  if (exclusions.houseBates.has(String(doc.bates_number).toUpperCase()) ||
      exclusions.documentIds.has(Number(doc.legacy_document_id))) {
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
    document_id: doc.archive_document_id,
    document_type: doc.archive_document_type,
    content_type: doc.archive_content_type,
    playback_content_type: doc.archive_document_type === 'video' ? 'video/mp4' : null,
    page_count: pageCount,
    pages,
    text_preview: doc.full_text?.substring(0, 2000) || null,
    entities,
  });
}

async function getHouseOversightPage(bates, pageIndex, request, r2) {
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
    const { object, response } = await getR2MediaObject(r2, r2Key, request);
    if (response) return response;
    if (!object) {
      return error('Image not found', 404);
    }

    return r2MediaResponse(object, request, {
      contentType: 'image/jpeg',
      canonicalPath: `/house-oversight/${bates}`,
    });
  } catch (e) {
    console.error('House Oversight R2 fetch error:', e);
    // Do not fall back to any public object-storage hostname: that would route
    // around both publication policy and this Worker's media limiter.
    return json(
      { error: 'Media temporarily unavailable. Please retry shortly.' },
      503,
      { 'Retry-After': '5' }
    );
  }
}

async function getHouseOversightThumbnail(bates, request, r2) {
  // Pre-generated small thumbnail (~420px wide) — falls back to the full-res
  // page-0 scan for any doc that hasn't been processed by
  // generate_ho_thumbnails.py yet, so this route never 404s outright.
  const thumbKey = `house-oversight/thumbnails/${bates}.jpg`;
  const { object, response } = await getR2MediaObject(r2, thumbKey, request);
  if (response) return response;
  if (object) {
    return r2MediaResponse(object, request, {
      contentType: 'image/jpeg',
      canonicalPath: `/house-oversight/${bates}`,
    });
  }
  const firstPage = await getHouseOversightPage(bates, 0, request, r2);
  return firstPage.status === 404 ? missingThumbnailResponse() : firstPage;
}

async function getHouseOversightStats(db, exclusions) {
  // Materialize the 315k oversight mentions once. Starting from the 2.9k
  // legacy documents lets SQLite use idx_mentions_document instead of walking
  // every entity and its mentions in the much larger combined archive.
  const visibility = houseVisibilitySql('h.bates_number', 'h.legacy_document_id', exclusions);
  const statement = db.prepare(`
    WITH visible_house AS MATERIALIZED (
      SELECT h.*
      FROM house_oversight_documents h
      WHERE 1=1
      ${visibility.clause}
    ),
    oversight_mentions AS MATERIALIZED (
      SELECT m.entity_id
      FROM visible_house h
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
      (SELECT COUNT(*) FROM visible_house) AS documents,
      (SELECT COALESCE(SUM(page_count), 0) FROM visible_house) AS pages,
      (SELECT COUNT(DISTINCT entity_id) FROM oversight_mentions) AS entities,
      (SELECT COUNT(*) FROM oversight_mentions) AS mentions,
      (SELECT json_group_array(json_object(
        'id', id,
        'name', canonical_name,
        'type', entity_type,
        'mentions', mention_count
      )) FROM top_entities) AS top_entities
  `);
  const stats = await bindIfNeeded(statement, visibility.bindings).first();

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
