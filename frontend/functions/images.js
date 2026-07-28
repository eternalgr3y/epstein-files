import { renderCollectionResponse } from './_lib/collection.js';

// This page told every reader and crawler the collection was empty --
// "No records are currently available", plus JSON-LD numberOfItems: 0 --
// while the archive holds 37,332 extracted page images. It passed items: []
// and ran no query at all, unlike videos.js and recordings.js.
//
// Images are the one collection not held in D1: src/worker.js serves them from
// an R2 manifest and this Pages project only has a DB binding. So rather than
// query, call the same public API the SPA uses. If that fails the page still
// renders, just without the listing -- an SSR page should not 500 because a
// subrequest did.
// Deliberately the workers.dev origin, not epsteinproject.org/api/...: a
// same-zone subrequest from a Pages Function back through the zone did not
// reach the API worker (the page rendered empty with no error), so this
// addresses the worker directly and skips zone routing entirely.
const IMAGES_API =
  'https://epstein-files-api.protonuser597.workers.dev/api/images?limit=48';

export async function onRequestGet() {
  let items = [];
  let total;

  try {
    const response = await fetch(IMAGES_API, {
      headers: { 'user-agent': 'epsteinproject-ssr' },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (response.ok) {
      const data = await response.json();
      if (Number.isFinite(Number(data.total))) total = Number(data.total);
      items = (data.images || [])
        // The gallery itself is a SPA view with no indexable URL per image, so
        // link to the source document, which is a real page. Anything without
        // a usable document id is dropped rather than pointed at a dead route.
        .filter((image) => Number.isFinite(Number(image.doc_id)))
        .map((image) => ({
          url: `/documents/${Number(image.doc_id)}`,
          title: `Page ${Number(image.page) + 1} of document ${Number(image.doc_id)}`,
          meta: String(image.filename || ''),
        }));
    }
  } catch {
    // Leave items empty and total undefined.
  }

  return renderCollectionResponse({
    path: '/images',
    title: 'Images Extracted from Epstein Case Documents',
    description: 'Browse page images extracted from searchable public records in the Epstein Project archive.',
    intro: 'This gallery presents images extracted from released document pages. Every image links back to its source document in the interactive archive.',
    items,
    total,
    spaHash: 'images/0',
  });
}
