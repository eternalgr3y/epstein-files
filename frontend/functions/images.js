import { renderCollectionResponse } from './_lib/collection.js';
import { pageCacheKey } from './_lib/html.js';
import {
  hasPublicationExclusions,
  publicationPolicy,
} from './_lib/publication.js';

async function excludedSourceDocumentIds(env, policy) {
  const documentIds = new Set(policy.documentIds.map(Number));
  if (!policy.houseOversightBates.length) return documentIds;

  // The images service returns only document ids. Resolve Bates withdrawals
  // against Pages' local D1 before trusting that service response, because a
  // deployment lag between Pages and the Worker must not expose a withdrawn
  // House record through its title, filename, or document link.
  const placeholders = policy.houseOversightBates.map(() => '?').join(', ');
  const aliases = await env.DB.prepare(`
    SELECT id AS document_id, UPPER(filename) AS bates_number
    FROM documents
    WHERE UPPER(filename) IN (${placeholders})
  `).bind(...policy.houseOversightBates).all();

  const resolvedBates = new Set();
  for (const alias of aliases.results || []) {
    const bates = String(alias.bates_number || '').toUpperCase();
    const documentId = Number(alias.document_id);
    if (policy.houseOversightBates.includes(bates) &&
        Number.isSafeInteger(documentId) && documentId > 0) {
      resolvedBates.add(bates);
      documentIds.add(documentId);
    }
  }

  // An unresolved alias cannot be proven safe against a stale API response.
  // Fail closed instead of rendering an incomplete emergency withdrawal.
  if (resolvedBates.size !== policy.houseOversightBates.length) {
    throw new Error('Unable to resolve all publication exclusion aliases');
  }
  return documentIds;
}

// This page told every reader and crawler the collection was empty --
// "No records are currently available", plus JSON-LD numberOfItems: 0 --
// while the archive holds 37,332 extracted page images. It passed items: []
// and ran no query at all, unlike videos.js and recordings.js.
//
// Images live in the Worker's R2 manifest rather than the Pages D1 binding.
// If the internal service binding is temporarily unavailable, the index
// remains usable and simply omits its preview list.
export async function onRequestGet(context) {
  const policy = publicationPolicy(context.env);
  const hasExclusions = hasPublicationExclusions(policy);
  const excludedDocumentIds = await excludedSourceDocumentIds(context.env, policy);
  const cache = context.cache || globalThis.caches?.default;
  const cacheKey = context.request
    ? pageCacheKey(context.request, '/images')
    : null;
  if (!hasExclusions && cache && cacheKey) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }
  let items = [];
  let total;
  let hasValidApiPayload = false;

  try {
    const headers = new Headers({ 'user-agent': 'epsteinproject-ssr' });
    // Cloudflare supplies this header on the incoming Pages request. Forward
    // that edge-authenticated value through the private service binding so all
    // SSR visitors do not collapse into the Worker's shared `media:unknown`
    // limiter bucket. Never accept a query/body override for this identity.
    const clientIp = context.request?.headers.get('CF-Connecting-IP');
    if (clientIp) headers.set('CF-Connecting-IP', clientIp);
    const response = await context.env.API.fetch(
      new Request('https://api.internal/api/images?limit=48', {
        headers,
      }),
    );
    if (response.ok) {
      const data = await response.json();
      if (!data || typeof data !== 'object' || !Array.isArray(data.images)) {
        throw new Error('Invalid images API response');
      }
      hasValidApiPayload = true;
      // If Pages has a local emergency exclusion that has not yet reached the
      // API service, its aggregate count is no longer safe or accurate.
      if (!hasExclusions && Number.isFinite(Number(data.total))) {
        total = Number(data.total);
      }
      items = (data.images || [])
        // The gallery itself is a SPA view with no indexable URL per image, so
        // link to the source document, which is a real page. Anything without
        // a usable document id is dropped rather than pointed at a dead route.
        .filter((image) => Number.isFinite(Number(image.doc_id))
          && !excludedDocumentIds.has(Number(image.doc_id)))
        .map((image) => ({
          url: `/documents/${Number(image.doc_id)}`,
          title: `Page ${Number(image.page) + 1} of document ${Number(image.doc_id)}`,
          meta: String(image.filename || ''),
        }));
    }
  } catch {
    // Leave items empty and total undefined.
  }

  const response = renderCollectionResponse({
    path: '/images',
    title: 'Images Extracted from Epstein Case Documents',
    description: 'Browse page images extracted from searchable public records in the Epstein Project archive.',
    intro: 'This gallery presents images extracted from released document pages. Every image links back to its source document in the interactive archive.',
    items,
    total,
    spaHash: 'images/0',
    cacheControl: hasExclusions ? 'no-store' : undefined,
  });
  if (hasValidApiPayload && !hasExclusions && cache && cacheKey && context.waitUntil) {
    context.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}
