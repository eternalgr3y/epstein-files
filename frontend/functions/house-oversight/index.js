import { renderCollectionResponse } from '../_lib/collection.js';

export async function onRequestGet({ env }) {
  const [count, docs] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS count FROM house_oversight_documents').first(),
    env.DB.prepare('SELECT bates_number, title, page_count FROM house_oversight_documents ORDER BY bates_number LIMIT 100').all(),
  ]);
  const items = docs.results.map((doc) => ({
    url: `/house-oversight/${encodeURIComponent(doc.bates_number)}`,
    title: doc.title || doc.bates_number,
    meta: `${doc.bates_number} · ${doc.page_count} ${doc.page_count === 1 ? 'page' : 'pages'}`,
  }));
  return renderCollectionResponse({
    path: '/house-oversight',
    title: 'House Oversight Epstein Estate Documents',
    description: 'Browse House Oversight Committee records from the Epstein estate document release, with searchable OCR text and page scans.',
    intro: 'House Oversight Committee estate records organized by Bates number with their original page scans and available OCR text.',
    items,
    total: count.count,
    spaHash: 'house-oversight/page/0',
  });
}
