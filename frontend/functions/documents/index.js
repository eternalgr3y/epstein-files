import { documentItems, renderCollectionResponse } from '../_lib/collection.js';

export async function onRequestGet({ env }) {
  const [count, docs] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM documents WHERE data_set != 'house-oversight-estate'").first(),
    env.DB.prepare("SELECT id, filename, title, document_type, data_set, page_count FROM documents WHERE data_set != 'house-oversight-estate' ORDER BY id DESC LIMIT 100").all(),
  ]);
  return renderCollectionResponse({
    path: '/documents',
    title: 'Epstein Case Documents',
    description: 'Browse searchable DOJ releases, court records, and evidence files in the Epstein Project public-record archive.',
    intro: 'Recently added public records from official releases. Open a record for its source information and available searchable text.',
    items: documentItems(docs.results),
    total: count.count,
    spaHash: 'documents/0',
  });
}
