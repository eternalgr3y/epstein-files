import { esc, renderDocPage } from '../_lib/html.js';

export async function onRequestGet(context) {
  const { params, env, request } = context;
  const id = parseInt(params.id, 10);
  if (!Number.isInteger(id) || String(id) !== params.id) {
    return new Response('Not found', { status: 404 });
  }

  const cache = caches.default;
  const cacheKey = new Request(new URL(`/documents/${id}`, request.url), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const doc = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first();
  if (!doc) {
    return new Response('Document not found', { status: 404 });
  }

  // house-oversight-estate docs already have a canonical URL at
  // /house-oversight/{bates} (filename == bates_begin for these rows) —
  // redirect instead of serving the same content under two URLs.
  if (doc.data_set === 'house-oversight-estate') {
    return Response.redirect(`https://epsteinproject.org/house-oversight/${doc.filename}`, 301);
  }

  const text = await env.DB.prepare(
    'SELECT full_text FROM document_texts WHERE document_id = ?'
  ).bind(id).first();

  const title = doc.title || doc.filename || `Document ${id}`;
  const preview = (text?.full_text || '').slice(0, 2000);
  const description = preview
    ? preview.replace(/\s+/g, ' ').trim().slice(0, 280)
    : `${doc.document_type || 'Document'} from ${doc.data_set || 'the Epstein case archive'}.`;

  const bodyHtml = `
<h1>${esc(title)}</h1>
<dl>
${doc.document_type ? `<dt>Type</dt><dd>${esc(doc.document_type)}</dd>` : ''}
${doc.data_set ? `<dt>Source set</dt><dd>${esc(doc.data_set)}</dd>` : ''}
${doc.page_count ? `<dt>Pages</dt><dd>${esc(doc.page_count)}</dd>` : ''}
</dl>
${/^https?:\/\//i.test(doc.source_url || '') ? `<p><a href="${esc(doc.source_url)}" rel="noopener" target="_blank">Original source</a></p>` : ''}
${preview ? `<h2>Extracted text</h2><pre>${esc(preview)}${text?.full_text?.length > 2000 ? '…' : ''}</pre>` : '<p>No extracted text available for this document.</p>'}
`;

  const html = renderDocPage({
    canonicalPath: `/documents/${id}`,
    title,
    description,
    bodyHtml,
    spaHash: `doc/${id}`,
  });

  const response = new Response(html, {
    headers: { 'content-type': 'text/html;charset=UTF-8', 'cache-control': 'public, max-age=3600' },
  });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
