import { esc, renderDocPage } from '../_lib/html.js';

export async function onRequestGet(context) {
  const { params, env, request } = context;
  const bates = params.bates;
  if (!/^[A-Z_\d]+$/.test(bates || '')) {
    return new Response('Not found', { status: 404 });
  }

  const cache = caches.default;
  const cacheKey = new Request(new URL(`/house-oversight/${bates}`, request.url), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const doc = await env.DB.prepare(
    'SELECT * FROM house_oversight_documents WHERE bates_number = ?'
  ).bind(bates).first();
  if (!doc) {
    return new Response('Document not found', { status: 404 });
  }

  const title = doc.title || bates;
  const preview = (doc.text_content || '').slice(0, 2000);
  const description = preview
    ? preview.replace(/\s+/g, ' ').trim().slice(0, 280)
    : `House Oversight Committee document, Bates ${bates}.`;

  const bodyHtml = `
<h1>${esc(title)}</h1>
<dl>
<dt>Bates</dt><dd>${esc(bates)}</dd>
${doc.page_count ? `<dt>Pages</dt><dd>${esc(doc.page_count)}</dd>` : ''}
</dl>
${preview ? `<h2>Extracted text</h2><pre>${esc(preview)}${doc.text_content?.length > 2000 ? '…' : ''}</pre>` : '<p>No extracted text available for this document.</p>'}
`;

  const html = renderDocPage({
    canonicalPath: `/house-oversight/${bates}`,
    title,
    description,
    bodyHtml,
    spaHash: `house-oversight/${encodeURIComponent(bates)}`,
  });

  const response = new Response(html, {
    headers: { 'content-type': 'text/html;charset=UTF-8', 'cache-control': 'public, max-age=3600' },
  });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
