import { esc, htmlResponseHeaders, pageCacheKey, renderDocPage } from '../_lib/html.js';

export async function onRequestGet(context) {
  const { params, env, request } = context;
  const bates = params.bates;
  if (!/^[A-Z_\d]+$/.test(bates || '')) {
    return new Response('Not found', { status: 404 });
  }

  const cache = caches.default;
  const cacheKey = pageCacheKey(request, `/house-oversight/${bates}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // house_oversight_documents.text_content is empty on all 2,897 rows -- the
  // importer writes estate OCR text to document_texts keyed by
  // legacy_document_id. Reading the column meant every one of these canonical
  // pages served "No extracted text available" while /api/search happily
  // returned the same documents WITH their text. 2,895 of 2,897 resolve
  // through the join.
  const doc = await env.DB.prepare(`
    SELECT h.*, t.full_text
    FROM house_oversight_documents h
    LEFT JOIN document_texts t ON t.document_id = h.legacy_document_id
    WHERE h.bates_number = ?
  `).bind(bates).first();
  if (!doc) {
    return new Response('Document not found', { status: 404 });
  }

  const fullText = doc.full_text || '';
  const title = doc.title || bates;
  const preview = fullText.slice(0, 2000);
  const description = preview
    ? preview.replace(/\s+/g, ' ').trim().slice(0, 280)
    : `House Oversight Committee document, Bates ${bates}.`;

  const confidencePct = preview && Number.isFinite(Number(doc.ocr_confidence))
    ? `${Math.round(Number(doc.ocr_confidence) * 100)}%`
    : '';

  const bodyHtml = `
<article class="record">
<p class="eyebrow">House Oversight — Estate records</p>
<h1 class="bates">${esc(bates)}</h1>
${doc.title && doc.title !== bates ? `<p class="record-title">${esc(doc.title)}</p>` : ''}
</article>
<dl>
${doc.page_count ? `<dt>Pages</dt><dd>${esc(doc.page_count)}</dd>` : ''}
<dt>Text</dt><dd>${preview ? 'Searchable' : 'Not extracted'}</dd>
${confidencePct ? `<dt>Text confidence</dt><dd>${esc(confidencePct)}</dd>` : ''}
</dl>
${preview
  ? `<h2>Text as released</h2><p class="ocr-note">Machine-read from the scan. Names, dates and numbers can be misread &mdash; check anything you rely on against the <a href="/about">original page</a>.</p><pre>${esc(preview)}${fullText.length > 2000 ? '\n\n[…]' : ''}</pre>`
  : '<h2>Text as released</h2><p>This scan produced no machine-readable text.</p>'}
`;

  const html = renderDocPage({
    canonicalPath: `/house-oversight/${bates}`,
    title,
    description,
    bodyHtml,
    spaHash: `house-oversight/${encodeURIComponent(bates)}`,
  });

  const response = new Response(html, {
    headers: htmlResponseHeaders(),
  });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
