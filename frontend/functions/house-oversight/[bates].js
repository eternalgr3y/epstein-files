import { DEFAULT_SOCIAL_IMAGE_URL, cleanDocTitle, esc, htmlResponseHeaders, notFoundResponse, pageCacheKey, renderDocPage } from '../_lib/html.js';
import {
  hasPublicationExclusions,
  isDocumentExcluded,
  isHouseOversightExcluded,
  notExcludedSql,
  publicationPolicy,
} from '../_lib/publication.js';

export async function onRequestGet(context) {
  const { params, env, request } = context;
  const rawBates = String(params.bates || '');
  const bates = rawBates.toUpperCase();
  if (!/^HOUSE_OVERSIGHT_\d+$/.test(bates)) {
    return notFoundResponse();
  }
  if (rawBates !== bates) {
    return Response.redirect(
      `https://epsteinproject.org/house-oversight/${encodeURIComponent(bates)}`,
      301,
    );
  }
  const policy = publicationPolicy(env);
  const hasExclusions = hasPublicationExclusions(policy);
  if (isHouseOversightExcluded(policy, bates)) {
    return notFoundResponse('Document not found');
  }

  const cache = context.cache || caches.default;
  const cacheKey = pageCacheKey(request, `/house-oversight/${bates}`);
  if (!hasExclusions) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  // house_oversight_documents.text_content is empty on all 2,897 rows -- the
  // importer writes estate OCR text to document_texts keyed by
  // legacy_document_id. Reading the column meant every one of these canonical
  // pages served "No extracted text available" while /api/search happily
  // returned the same documents WITH their text. 2,895 of 2,897 resolve
  // through the join.
  const doc = await env.DB.prepare(`
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
    return notFoundResponse('Document not found');
  }
  if (isDocumentExcluded(policy, doc.legacy_document_id)) {
    return notFoundResponse('Document not found');
  }

  // Same sibling-links rationale as documents/[id].js: these pages were
  // crawl leaves. bates_number is the natural order for estate records.
  const excludedSiblingBates = notExcludedSql(
    'bates_number', policy.houseOversightBates
  );
  const excludedSiblingLegacy = notExcludedSql(
    'legacy_document_id', policy.documentIds
  );
  const siblingExclusions = `${excludedSiblingBates.clause}${excludedSiblingLegacy.clause}`;
  const siblingBindings = [
    ...excludedSiblingBates.bindings, ...excludedSiblingLegacy.bindings,
  ];
  const [prevDoc, nextDoc] = await Promise.all([
    env.DB.prepare('SELECT bates_number FROM house_oversight_documents WHERE bates_number < ?' + siblingExclusions + ' ORDER BY bates_number DESC LIMIT 1').bind(bates, ...siblingBindings).first(),
    env.DB.prepare('SELECT bates_number FROM house_oversight_documents WHERE bates_number > ?' + siblingExclusions + ' ORDER BY bates_number LIMIT 1').bind(bates, ...siblingBindings).first(),
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
  const description = (
    `House Oversight Committee document, Bates ${bates}`
    + `${described ? `: ${described}` : ''}.`
  ).slice(0, 280);

  const confidencePct = preview && Number(doc.ocr_confidence) > 0
    ? `${Math.round(Number(doc.ocr_confidence) * 100)}%`
    : '';
  const archiveDocumentId = Number(doc.archive_document_id);
  const isVideo = doc.archive_document_type === 'video'
    && Number.isSafeInteger(archiveDocumentId)
    && archiveDocumentId > 0;
  const mediaUrl = `https://epsteinproject.org/api/documents/${archiveDocumentId}/file`;
  const playbackUrl = `${mediaUrl}?stream=1&delivery=private-worker-v1`;
  const thumbnailUrl = `https://epsteinproject.org/api/videos/${archiveDocumentId}/thumb`;
  const videoType = 'video/mp4';
  const mediaHtml = isVideo
    ? `<h2>Video preview</h2><video class="record-media record-video" controls preload="metadata" poster="${thumbnailUrl}"><source src="${playbackUrl}" type="${esc(videoType)}"></video><p><a href="${mediaUrl}?download=1">Download the byte-identical released file</a></p>`
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
${mediaHtml}
${preview
  ? `<h2>Text as released</h2><p class="ocr-note">Machine-read from the scan. Names, dates and numbers can be misread &mdash; check anything you rely on against the <a href="/about">original page</a>.</p><pre data-nosnippet>${esc(preview)}${fullText.length > 2000 ? '\n\n[…]' : ''}</pre>`
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
    ogType: isVideo ? 'video.other' : 'article',
    imageUrl: isVideo ? thumbnailUrl : DEFAULT_SOCIAL_IMAGE_URL,
    structuredData: isVideo ? {
      '@context': 'https://schema.org',
      '@type': 'VideoObject',
      name: title,
      description,
      thumbnailUrl: [thumbnailUrl],
      contentUrl: playbackUrl,
    } : null,
  });

  const response = new Response(html, {
    headers: htmlResponseHeaders(hasExclusions ? 'no-store' : undefined),
  });
  if (!hasExclusions) {
    context.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}
