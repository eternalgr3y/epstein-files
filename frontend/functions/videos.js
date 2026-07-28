import { documentItems, pageParam, renderCollectionResponse } from './_lib/collection.js';

const PAGE_SIZE = 100;

export async function onRequestGet({ env, request }) {
  // Count first so the requested page can be clamped against the real total
  // before the listing query runs.
  const count = await env.DB
    .prepare("SELECT COUNT(*) AS count FROM documents WHERE document_type = 'video'")
    .first();
  const page = pageParam(request, PAGE_SIZE, count.count);
  const docs = await env.DB.prepare(
    "SELECT id, filename, title, document_type, data_set, page_count FROM documents "
    + "WHERE document_type = 'video' ORDER BY id DESC LIMIT ? OFFSET ?"
  ).bind(PAGE_SIZE, (page - 1) * PAGE_SIZE).all();

  return renderCollectionResponse({
    path: '/videos',
    title: 'Epstein Case Video Evidence',
    description: 'Browse video files released in the public Epstein case document archive, including DOJ and House Oversight releases.',
    intro: 'Video files preserved from official public releases. Each watch page links to its archive record and streams the original file.',
    items: documentItems(docs.results),
    total: count.count,
    page,
    pageSize: PAGE_SIZE,
    spaHash: 'videos/0',
  });
}
