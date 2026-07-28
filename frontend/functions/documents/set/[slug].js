import {
  documentItems, pageParam, renderCollectionResponse,
} from '../../_lib/collection.js';
import { setLabel } from '../../_lib/html.js';

const PAGE_SIZE = 100;

// Browsing by release was only possible through the SPA's filter dropdown,
// which has no URL — so there was no way to link to "the DOJ Data Set 8
// documents", and no crawlable entry point between the single flat /documents
// listing and 19,413 individual records. These pages give each release its own
// paginated, indexable index.
//
// Allow-list rather than passthrough: the slug goes into a SQL parameter and a
// page title, and an open list would let arbitrary strings mint empty pages.
const SETS = {
  'data-set': 'DOJ Data Set 1',
  'data-set-2': 'DOJ Data Set 2',
  'data-set-3': 'DOJ Data Set 3',
  'data-set-4': 'DOJ Data Set 4',
  'data-set-5': 'DOJ Data Set 5',
  'data-set-6': 'DOJ Data Set 6',
  'data-set-7': 'DOJ Data Set 7',
  'data-set-8': 'DOJ Data Set 8',
  'court-records': 'Court Records',
  'doj-disclosures': 'DOJ Disclosures',
  'house-oversight-doj': 'House Oversight (DOJ)',
  'maxwell-interview': 'Maxwell Interview',
};

// 'Data Set 8' is a legacy mislabel of data-set-8 still present in the data
// (see DATA_SET_ALIASES in src/worker.js); include it so the count and the
// listing agree with the rest of the site.
const ALIASES = { 'data-set-8': ['Data Set 8'] };

export async function onRequestGet({ params, env, request }) {
  const slug = params.slug;
  if (!Object.prototype.hasOwnProperty.call(SETS, slug)) {
    return new Response('Not found', { status: 404 });
  }

  const values = [slug, ...(ALIASES[slug] || [])];
  const placeholders = values.map(() => '?').join(', ');

  const count = await env.DB
    .prepare(`SELECT COUNT(*) AS count FROM documents WHERE data_set IN (${placeholders})`)
    .bind(...values).first();
  const page = pageParam(request, PAGE_SIZE, count.count);
  const docs = await env.DB.prepare(
    'SELECT id, filename, title, document_type, data_set, page_count FROM documents '
    + `WHERE data_set IN (${placeholders}) ORDER BY id DESC LIMIT ? OFFSET ?`
  ).bind(...values, PAGE_SIZE, (page - 1) * PAGE_SIZE).all();

  const label = SETS[slug] || setLabel(slug);

  return renderCollectionResponse({
    path: `/documents/set/${slug}`,
    title: `${label} — Epstein Case Documents`,
    description: `Browse the ${label} release: ${count.count.toLocaleString()} public records with source information and available searchable text.`,
    intro: `Documents released as ${label}, most recently added first. Open a record for its source information and available searchable text.`,
    items: documentItems(docs.results),
    total: count.count,
    page,
    pageSize: PAGE_SIZE,
    spaHash: 'documents/0',
  });
}
