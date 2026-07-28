import { esc, htmlResponseHeaders, pageCacheKey, renderDocPage, setLabel } from '../_lib/html.js';

export async function onRequestGet(context) {
  const { params, env, request } = context;
  const id = parseInt(params.id, 10);
  if (!Number.isInteger(id) || String(id) !== params.id) {
    return new Response('Not found', { status: 404 });
  }

  const cache = caches.default;
  const cacheKey = pageCacheKey(request, `/documents/${id}`);
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
    : `${doc.document_type || 'Document'} from ${doc.data_set ? setLabel(doc.data_set) : 'the Epstein case archive'}, `
      + `Bates ${String(doc.filename || '').replace(/\.[a-z0-9]+$/i, '') || id}.`;
  const isVideo = doc.document_type === 'video';
  const isAudio = doc.document_type === 'audio';
  const sourceDate = doc.download_timestamp || doc.created_at;
  const parsedDate = sourceDate
    ? new Date(`${String(sourceDate).trim().replace(' ', 'T').replace(/Z?$/, 'Z')}`)
    : null;
  const uploadDate = parsedDate && !Number.isNaN(parsedDate.getTime())
    ? parsedDate.toISOString()
    : null;
  const mediaUrl = `https://epsteinproject.org/api/documents/${id}/file`;
  const thumbnailUrl = `https://epsteinproject.org/api/videos/${id}/thumb`;
  const mediaHtml = isVideo
    ? `<video controls preload="metadata" poster="${thumbnailUrl}" style="display:block;width:100%;background:#0b0d0e"><source src="${mediaUrl}" type="video/mp4"></video>`
    : isAudio
      ? `<audio controls preload="metadata" style="display:block;width:100%"><source src="${mediaUrl}"></audio>`
      : '';
  const structuredData = isVideo ? {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: title,
    description,
    thumbnailUrl: [thumbnailUrl],
    contentUrl: mediaUrl,
    ...(uploadDate ? { uploadDate } : {}),
  } : isAudio ? {
    '@context': 'https://schema.org',
    '@type': 'AudioObject',
    name: title,
    description,
    contentUrl: mediaUrl,
  } : {
    '@context': 'https://schema.org',
    '@type': 'DigitalDocument',
    name: title,
    description,
    url: `https://epsteinproject.org/documents/${id}`,
  };

  // The Bates/production number is the document's real identifier -- it is how
  // these records are cited in filings and by reporters -- so it leads, and
  // the descriptive title (often just the filename) follows as a caption.
  const bates = String(doc.filename || '').replace(/\.[a-z0-9]+$/i, '');
  const heading = bates || title;
  const subtitle = doc.title && doc.title !== doc.filename ? doc.title : '';

  const SET_LABELS = {
    'court-records': 'Court records',
    'doj-disclosures': 'DOJ disclosures',
    'house-oversight-doj': 'House Oversight — DOJ production',
    'maxwell-interview': 'Maxwell interview',
  };
  const provenance = SET_LABELS[doc.data_set]
    || (/^data-set/.test(doc.data_set || '') ? 'DOJ evidence release' : 'Public release');

  // has_text is unreliable on its own (see hasTextExpr in src/worker.js); the
  // presence of extracted text is the honest signal.
  const textStatus = preview
    ? 'Searchable'
    : `Not extracted${doc.processing_status ? ` — ${doc.processing_status}` : ''}`;

  // ocr_confidence is a 0-1 float and was rendered raw, so most documents read
  // "OCR confidence 1", which tells a reader nothing. Show it as a percentage,
  // and only where there is text for it to describe.
  const confidencePct = preview && Number.isFinite(Number(doc.ocr_confidence))
    ? `${Math.round(Number(doc.ocr_confidence) * 100)}%`
    : '';

  const bodyHtml = `
<article class="record">
<p class="eyebrow">${esc(provenance)}</p>
<h1 class="bates">${esc(heading)}</h1>
${subtitle ? `<p class="record-title">${esc(subtitle)}</p>` : ''}
</article>
${mediaHtml}
<dl>
${doc.document_type ? `<dt>Format</dt><dd>${esc(doc.document_type)}</dd>` : ''}
${doc.data_set ? `<dt>Set</dt><dd>${esc(setLabel(doc.data_set))}</dd>` : ''}
${doc.page_count ? `<dt>Pages</dt><dd>${esc(doc.page_count)}</dd>` : ''}
<dt>Text</dt><dd>${esc(textStatus)}</dd>
${confidencePct ? `<dt>Text confidence</dt><dd>${esc(confidencePct)}</dd>` : ''}
</dl>
${/^https?:\/\//i.test(doc.source_url || '') ? `<p class="onward"><a href="${esc(doc.source_url)}" rel="noopener" target="_blank">View at the original source</a></p>` : ''}
${preview
  ? `<h2>Text as released</h2><pre>${esc(preview)}${text?.full_text?.length > 2000 ? '\n\n[…]' : ''}</pre>`
  : '<h2>Text as released</h2><p>This scan produced no machine-readable text. The original file is still available above.</p>'}
`;

  const html = renderDocPage({
    canonicalPath: `/documents/${id}`,
    title,
    description,
    bodyHtml,
    spaHash: `doc/${id}`,
    ogType: isVideo ? 'video.other' : 'article',
    imageUrl: isVideo ? thumbnailUrl : undefined,
    structuredData,
  });

  const response = new Response(html, {
    headers: htmlResponseHeaders(),
  });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
