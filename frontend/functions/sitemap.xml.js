import { SECURITY_HEADERS, pageCacheKey } from './_lib/html.js';

const CACHE_SECONDS = 3600;

export async function onRequestGet(context) {
  const { env, request } = context;
  const cache = caches.default;
  // Key on the path only — dropping the query string prevents cache-busting
  // via arbitrary "?x=..." params from forcing a full-table scan every hit.
  const cacheKey = pageCacheKey(request, '/sitemap.xml');

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const [docs, houseOversight] = await Promise.all([
    // house-oversight-estate rows are intentionally excluded from the main
    // documents listing (see the same filter in src/worker.js) and already
    // get a canonical URL under /house-oversight/{bates} below — including
    // them here too would publish duplicate-content URLs for the same doc.
    // lastmod tells Google which pages actually changed, so a re-crawl spends
    // budget on the handful that moved instead of re-checking 22k unchanged
    // URLs. Without it every page looks equally (un)interesting, which matters
    // on an archive this size.
    //
    // Dates are taken with substr(...,1,10) rather than date(): document_texts
    // rows written by the backfills carry a provenance tag in created_at
    // ("2026-07-27 backfill-fts") so they parse as NULL through date() but
    // give a correct YYYY-MM-DD prefix. MAX() picks whichever of the document
    // row or its text was touched most recently.
    env.DB.prepare(`
      SELECT d.id,
             MAX(COALESCE(substr(d.updated_at, 1, 10), ''),
                 COALESCE(substr(t.created_at, 1, 10), '')) AS lastmod
      FROM documents d
      LEFT JOIN document_texts t ON t.document_id = d.id
      WHERE d.data_set != 'house-oversight-estate'
    `).all(),
    // house_oversight_documents.created_at is NULL for all 2,897 rows (the
    // import wrote explicit NULLs, so DEFAULT CURRENT_TIMESTAMP never fired),
    // which left every estate URL with no lastmod. Their OCR text lives in
    // document_texts via legacy_document_id, so take the date from there --
    // it is the better signal anyway, being when the content last changed
    // rather than when the row was created. Resolves for 2,895 of 2,897.
    env.DB.prepare(`
      SELECT ho.bates_number,
             COALESCE(substr(t.created_at, 1, 10), substr(ho.created_at, 1, 10)) AS lastmod
      FROM house_oversight_documents ho
      LEFT JOIN document_texts t ON t.document_id = ho.legacy_document_id
    `).all(),
  ]);

  const urls = [
    url('https://epsteinproject.org/', 'daily', '1.0'),
    url('https://epsteinproject.org/documents', 'daily', '0.9'),
    url('https://epsteinproject.org/images', 'weekly', '0.8'),
    url('https://epsteinproject.org/videos', 'weekly', '0.8'),
    url('https://epsteinproject.org/recordings', 'weekly', '0.8'),
    url('https://epsteinproject.org/house-oversight', 'weekly', '0.9'),
    // The methodology and OCR-accuracy disclosure now has a real URL.
    url('https://epsteinproject.org/about', 'monthly', '0.5'),
    // Per-release indexes: topic-clustered entry points into the corpus.
    ...['data-set', 'data-set-2', 'data-set-3', 'data-set-4', 'data-set-5',
        'data-set-6', 'data-set-7', 'data-set-8', 'court-records',
        'doj-disclosures', 'house-oversight-doj', 'maxwell-interview']
      .map((slug) => url(`https://epsteinproject.org/documents/set/${slug}`, 'weekly', '0.7')),
    ...docs.results.map((d) =>
      url(`https://epsteinproject.org/documents/${d.id}`, 'monthly', '0.6', d.lastmod)),
    ...houseOversight.results.map((d) =>
      url(`https://epsteinproject.org/house-oversight/${encodeURIComponent(d.bates_number)}`,
          'monthly', '0.6', d.lastmod)
    ),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;

  const response = new Response(xml, {
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'application/xml;charset=UTF-8',
      'cache-control': `public, max-age=${CACHE_SECONDS}`,
    },
  });

  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function url(loc, changefreq, priority, lastmod) {
  // Emit lastmod only when it is a well-formed W3C date. A malformed value
  // invalidates the whole sitemap for Google, so anything unexpected (a bad
  // timestamp, a NULL, a stray provenance tag) is dropped rather than shipped.
  const stamp = /^\d{4}-\d{2}-\d{2}$/.test(lastmod || '')
    ? `\n    <lastmod>${lastmod}</lastmod>`
    : '';
  return `  <url>\n    <loc>${loc}</loc>${stamp}\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
}
