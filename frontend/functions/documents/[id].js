import { esc, htmlResponseHeaders, renderDocPage } from '../_lib/html.js';

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

  const bodyHtml = `
<h1>${esc(title)}</h1>
${mediaHtml}
<dl>
${doc.document_type ? `<dt>Type</dt><dd>${esc(doc.document_type)}</dd>` : ''}
${doc.data_set ? `<dt>Source set</dt><dd>${esc(doc.data_set)}</dd>` : ''}
${doc.page_count ? `<dt>Pages</dt><dd>${esc(doc.page_count)}</dd>` : ''}
<dt>Text status</dt><dd>${doc.has_text || preview ? 'Searchable text available' : esc(doc.processing_status || 'OCR pending')}</dd>
${doc.ocr_confidence ? `<dt>OCR confidence</dt><dd>${esc(doc.ocr_confidence)}</dd>` : ''}
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
