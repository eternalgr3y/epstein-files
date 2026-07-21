import { SECURITY_HEADERS } from './_lib/html.js';

const CACHE_SECONDS = 3600;

export async function onRequestGet(context) {
  const { env, request } = context;
  const cache = caches.default;
  // Key on the path only — dropping the query string prevents cache-busting
  // via arbitrary "?x=..." params from forcing a full-table scan every hit.
  const cacheKey = new Request(new URL('/sitemap.xml', request.url), request);

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const [docs, houseOversight] = await Promise.all([
    // house-oversight-estate rows are intentionally excluded from the main
    // documents listing (see the same filter in src/worker.js) and already
    // get a canonical URL under /house-oversight/{bates} below — including
    // them here too would publish duplicate-content URLs for the same doc.
    env.DB.prepare("SELECT id FROM documents WHERE data_set != 'house-oversight-estate'").all(),
    env.DB.prepare('SELECT bates_number FROM house_oversight_documents').all(),
  ]);

  const urls = [
    url('https://epsteinproject.org/', 'daily', '1.0'),
    url('https://epsteinproject.org/documents', 'daily', '0.9'),
    url('https://epsteinproject.org/images', 'weekly', '0.8'),
    url('https://epsteinproject.org/videos', 'weekly', '0.8'),
    url('https://epsteinproject.org/recordings', 'weekly', '0.8'),
    url('https://epsteinproject.org/house-oversight', 'weekly', '0.9'),
    ...docs.results.map((d) => url(`https://epsteinproject.org/documents/${d.id}`, 'monthly', '0.6')),
    ...houseOversight.results.map((d) =>
      url(`https://epsteinproject.org/house-oversight/${encodeURIComponent(d.bates_number)}`, 'monthly', '0.6')
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

function url(loc, changefreq, priority) {
  return `  <url>\n    <loc>${loc}</loc>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
}
