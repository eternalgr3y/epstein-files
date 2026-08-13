import { documentItems, renderCollectionResponse } from './_lib/collection.js';
import { hasPublicationExclusions, notExcludedSql, publicationPolicy } from './_lib/publication.js';

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

export async function onRequestGet({ env }) {
  const policy = publicationPolicy(env);
  const excluded = collectionExclusions(policy);
  const [count, docs] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM documents WHERE document_type = 'audio'" + excluded.clause).bind(...excluded.bindings).first(),
    env.DB.prepare("SELECT id, filename, title, document_type, data_set, page_count FROM documents WHERE document_type = 'audio'" + excluded.clause + " ORDER BY id DESC LIMIT 100").bind(...excluded.bindings).all(),
  ]);
  return renderCollectionResponse({
    path: '/recordings',
    title: 'Epstein Case Audio Recordings',
    description: 'Browse DOJ interview audio and other recordings in the Epstein Project public-record archive.',
    intro: 'Audio preserved from official public releases: DOJ interview recordings and Palm Beach case audio, including controlled calls, witness interviews and voicemails.',
    items: documentItems(docs.results),
    total: count.count,
    spaHash: 'maxwell',
    cacheControl: hasPublicationExclusions(policy) ? 'no-store' : undefined,
  });
}
