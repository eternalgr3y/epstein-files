import { documentItems, pageParam, renderCollectionResponse } from '../_lib/collection.js';
import { setLabel } from '../_lib/html.js';

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

  // Per-release indexes, ordered by size, as crawlable entry points.
  const sets = await env.DB.prepare(
    "SELECT data_set, COUNT(*) AS n FROM documents "
    + "WHERE data_set != 'house-oversight-estate' GROUP BY data_set ORDER BY n DESC"
  ).all();
  const links = sets.results
    .filter((r) => r.data_set && r.data_set !== 'Data Set 8')
    .map((r) => ({
      url: `/documents/set/${encodeURIComponent(r.data_set)}`,
      label: setLabel(r.data_set),
      count: r.n,
    }));

  return renderCollectionResponse({
    path: '/documents',
    title: 'Epstein Case Documents',
    description: `Browse and search ${Number(count.count).toLocaleString('en-US')} public records from the Jeffrey Epstein case — DOJ evidence releases, court filings, depositions, flight logs, and House Oversight files — each linked to its official source.`,
    // Ordered newest-first by id, which is why the opening pages are
    // media-heavy: the most recently imported records have the highest ids.
    intro: 'Public records from official releases, most recently added first. Open a record for its source information and available searchable text.',
    items: documentItems(docs.results),
    total: count.count,
    page,
    pageSize: PAGE_SIZE,
    links,
    spaHash: 'documents/0',
  });
}
