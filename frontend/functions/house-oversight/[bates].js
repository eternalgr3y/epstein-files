import { cleanDocTitle, esc, htmlResponseHeaders, notFoundResponse, pageCacheKey, renderDocPage } from '../_lib/html.js';

export async function onRequestGet(context) {
  const { params, env, request } = context;
  const bates = params.bates;
  if (!/^[A-Z_\d]+$/.test(bates || '')) {
    return notFoundResponse();
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
    return notFoundResponse('Document not found');
  }

  // Same sibling-links rationale as documents/[id].js: these pages were
  // crawl leaves. bates_number is the natural order for estate records.
  const [prevDoc, nextDoc] = await Promise.all([
    env.DB.prepare('SELECT bates_number FROM house_oversight_documents WHERE bates_number < ? ORDER BY bates_number DESC LIMIT 1').bind(bates).first(),
    env.DB.prepare('SELECT bates_number FROM house_oversight_documents WHERE bates_number > ? ORDER BY bates_number LIMIT 1').bind(bates).first(),
  ]);

  const fullText = doc.full_text || '';
  // Estate titles are upload filenames ("James Patterson 3_4.pdf"); clean them
  // the way document pages do, with the Bates leading as the citable name.
  // Many rows carry the Bates itself as the title — cleaning turns it into
  // "HOUSE OVERSIGHT 010477", which is not a description, just the name with
  // the underscores swapped. Compare normalized forms and drop it.
  const cleaned = cleanDocTitle(doc.title);
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const described = cleaned && norm(cleaned) !== norm(bates) ? cleaned : '';
  const title = described ? `${bates} — ${described}` : bates;
  const preview = fullText.slice(0, 2000);
  const description = preview
    ? preview.replace(/\s+/g, ' ').trim().slice(0, 280)
    : `House Oversight Committee document, Bates ${bates}.`;

  const confidencePct = preview && Number(doc.ocr_confidence) > 0
    ? `${Math.round(Number(doc.ocr_confidence) * 100)}%`
    : '';

  const bodyHtml = `
<article class="record">
<p class="eyebrow">House Oversight — Estate records</p>
<h1 class="bates">${esc(bates)}</h1>
${described ? `<p class="record-title">${esc(described)}</p>` : ''}
</article>
<dl>
${doc.page_count ? `<dt>Pages</dt><dd>${esc(doc.page_count)}</dd>` : ''}
<dt>Text</dt><dd>${preview ? 'Searchable' : 'Not extracted'}</dd>
${confidencePct ? `<dt>Text confidence</dt><dd>${esc(confidencePct)}</dd>` : ''}
</dl>
${preview
  ? `<h2>Text as released</h2><p class="ocr-note">Machine-read from the scan. Names, dates and numbers can be misread &mdash; check anything you rely on against the <a href="/about">original page</a>.</p><pre>${esc(preview)}${fullText.length > 2000 ? '\n\n[…]' : ''}</pre>`
  : '<h2>Text as released</h2><p>This scan produced no machine-readable text.</p>'}
${prevDoc || nextDoc ? `<nav class="siblings" aria-label="Adjacent estate records">
${prevDoc ? `<a href="/house-oversight/${encodeURIComponent(prevDoc.bates_number)}" rel="prev">&larr; ${esc(prevDoc.bates_number)}</a>` : '<span></span>'}
${nextDoc ? `<a href="/house-oversight/${encodeURIComponent(nextDoc.bates_number)}" rel="next">${esc(nextDoc.bates_number)} &rarr;</a>` : '<span></span>'}
</nav>` : ''}
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
