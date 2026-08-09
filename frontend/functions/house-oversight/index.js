import { pageParam, renderCollectionResponse } from '../_lib/collection.js';
import { cleanDocTitle } from '../_lib/html.js';

const PAGE_SIZE = 100;

export async function onRequestGet({ env, request }) {
  // Count first so the requested page can be clamped against the real total
  // before the listing query runs.
  const count = await env.DB
    .prepare('SELECT COUNT(*) AS count FROM house_oversight_documents')
    .first();
  const page = pageParam(request, PAGE_SIZE, count.count);
  const docs = await env.DB.prepare(
    'SELECT bates_number, title, page_count FROM house_oversight_documents '
    + 'ORDER BY bates_number LIMIT ? OFFSET ?'
  ).bind(PAGE_SIZE, (page - 1) * PAGE_SIZE).all();

  const items = docs.results.map((doc) => ({
    url: `/house-oversight/${encodeURIComponent(doc.bates_number)}`,
    // Raw estate titles are upload filenames ("James Patterson 3_4.pdf");
    // clean them the way every other listing does, falling back to the Bates.
    title: cleanDocTitle(doc.title) || doc.bates_number,
    meta: `${doc.bates_number} · ${doc.page_count} ${doc.page_count === 1 ? 'page' : 'pages'}`,
  }));

  return renderCollectionResponse({
    path: '/house-oversight',
    title: 'House Oversight Epstein Estate Documents',
    description: 'Browse House Oversight Committee records from the Epstein estate document release, with searchable OCR text and page scans.',
    intro: 'House Oversight Committee estate records organized by Bates number with their original page scans and available OCR text.',
    items,
    total: count.count,
    page,
    pageSize: PAGE_SIZE,
    spaHash: 'house-oversight/page/0',
  });
}
