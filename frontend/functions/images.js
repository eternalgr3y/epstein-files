import { renderCollectionResponse } from './_lib/collection.js';

export async function onRequestGet() {
  return renderCollectionResponse({
    path: '/images',
    title: 'Images Extracted from Epstein Case Documents',
    description: 'Browse page images extracted from searchable public records in the Epstein Project archive.',
    intro: 'This gallery presents images extracted from released document pages. Every image links back to its source document in the interactive archive.',
    items: [],
    spaHash: 'images/0',
  });
}
