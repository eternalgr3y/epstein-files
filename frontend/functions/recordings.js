import { documentItems, renderCollectionResponse } from './_lib/collection.js';

export async function onRequestGet({ env }) {
  const [count, docs] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM documents WHERE document_type = 'audio'").first(),
    env.DB.prepare("SELECT id, filename, title, document_type, data_set, page_count FROM documents WHERE document_type = 'audio' ORDER BY id DESC LIMIT 100").all(),
  ]);
  return renderCollectionResponse({
    path: '/recordings',
    title: 'Epstein Case Audio Recordings',
    description: 'Browse deposition recordings and other audio files in the Epstein Project public-record archive.',
    intro: 'Audio preserved from official public releases, including deposition exhibits and DOJ records.',
    items: documentItems(docs.results),
    total: count.count,
    spaHash: 'maxwell',
  });
}
