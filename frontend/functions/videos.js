import { documentItems, pageParam, renderCollectionResponse } from './_lib/collection.js';
import { hasPublicationExclusions, notExcludedSql, publicationPolicy } from './_lib/publication.js';

const PAGE_SIZE = 100;

function collectionExclusions(policy) {
  const byId = notExcludedSql('id', policy.documentIds);
  const bates = policy.houseOversightBates;
  if (!bates.length) return byId;
  return {
    clause: byId.clause
      + ` AND (filename IS NULL OR UPPER(filename) NOT IN (${bates.map(() => '?').join(', ')}))`,
    bindings: [...byId.bindings, ...bates],
  };
}

export async function onRequestGet({ env, request }) {
  const policy = publicationPolicy(env);
  const excluded = collectionExclusions(policy);
  // Count first so the requested page can be clamped against the real total
  // before the listing query runs.
  const count = await env.DB
    .prepare("SELECT COUNT(*) AS count FROM documents WHERE document_type = 'video'" + excluded.clause)
    .bind(...excluded.bindings).first();
  const page = pageParam(request, PAGE_SIZE, count.count);
  const docs = await env.DB.prepare(
    "SELECT id, filename, title, document_type, data_set, page_count FROM documents "
    + "WHERE document_type = 'video'" + excluded.clause
    + " ORDER BY id DESC LIMIT ? OFFSET ?"
  ).bind(...excluded.bindings, PAGE_SIZE, (page - 1) * PAGE_SIZE).all();

  return renderCollectionResponse({
    path: '/videos',
    title: 'Epstein Case Video Evidence',
    description: 'Browse video files released in the public Epstein case document archive, including DOJ and House Oversight releases.',
    intro: 'Video files preserved from official public releases. Watch pages stream a playback copy and link to the byte-identical released download.',
    items: documentItems(docs.results),
    total: count.count,
    page,
    pageSize: PAGE_SIZE,
    spaHash: 'videos/0',
    cacheControl: hasPublicationExclusions(policy) ? 'no-store' : undefined,
  });
}
