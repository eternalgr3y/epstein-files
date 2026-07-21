import { documentItems, renderCollectionResponse } from './_lib/collection.js';

export async function onRequestGet({ env }) {
  const [count, docs] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM documents WHERE document_type = 'video'").first(),
    env.DB.prepare("SELECT id, filename, title, document_type, data_set, page_count FROM documents WHERE document_type = 'video' ORDER BY id DESC LIMIT 100").all(),
  ]);
  return renderCollectionResponse({
    path: '/videos',
    title: 'Epstein Case Video Evidence',
    description: 'Browse video files released in the public Epstein case document archive, including DOJ and House Oversight releases.',
    intro: 'Video files preserved from official public releases. Each watch page links to its archive record and streams the original file.',
    items: documentItems(docs.results),
    total: count.count,
    spaHash: 'videos/0',
  });
}
