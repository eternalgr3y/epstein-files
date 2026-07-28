import { documentItems, pageParam, renderCollectionResponse } from '../_lib/collection.js';

const PAGE_SIZE = 100;

export async function onRequestGet({ env, request }) {
  // Count first so the requested page can be clamped against the real total
  // before the listing query runs.
  const count = await env.DB
    .prepare("SELECT COUNT(*) AS count FROM documents WHERE data_set != 'house-oversight-estate'")
    .first();
  const page = pageParam(request, PAGE_SIZE, count.count);
  const docs = await env.DB.prepare(
    "SELECT id, filename, title, document_type, data_set, page_count FROM documents "
    + "WHERE data_set != 'house-oversight-estate' ORDER BY id DESC LIMIT ? OFFSET ?"
  ).bind(PAGE_SIZE, (page - 1) * PAGE_SIZE).all();

  return renderCollectionResponse({
    path: '/documents',
    title: 'Epstein Case Documents',
    description: 'Browse searchable DOJ releases, court records, and evidence files in the Epstein Project public-record archive.',
    // Ordered newest-first by id, which is why the opening pages are
    // media-heavy: the most recently imported records have the highest ids.
    intro: 'Public records from official releases, most recently added first. Open a record for its source information and available searchable text.',
    items: documentItems(docs.results),
    total: count.count,
    page,
    pageSize: PAGE_SIZE,
    spaHash: 'documents/0',
  });
}
