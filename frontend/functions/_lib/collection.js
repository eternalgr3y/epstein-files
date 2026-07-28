import { esc, htmlResponseHeaders, renderDocPage } from './html.js';

// Collection indexes were hardcoded to the newest 100 records with no next
// link, so only 316 of 22,316 document URLs had any inbound internal link.
// The SPA browse view does paginate, but its control is a <button> with a
// data-action, which serves people and is invisible to a crawler -- so the
// human and crawler link graphs disagreed. These pages now walk the whole
// collection with real anchors and rel=next/prev.

// ?page=N, 1-based. Anything unparseable is page 1 rather than an error --
// these are crawler-facing URLs and a bad one should still render.
export function pageParam(request, pageSize, total) {
  const raw = new URL(request.url).searchParams.get('page');
  const n = /^\d+$/.test(raw || '') ? parseInt(raw, 10) : 1;
  const max = Number.isFinite(total) && total > 0
    ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  return Math.min(Math.max(1, n), max);
}

export function renderCollectionResponse({
  path, title, description, intro, items, total, spaHash,
  page = 1, pageSize = 100,
}) {
  const canonical = `https://epsteinproject.org${path}`;
  const pageCount = Number.isFinite(total) && pageSize > 0
    ? Math.max(1, Math.ceil(Number(total) / pageSize))
    : 1;
  const pageUrl = (n) => (n <= 1 ? path : `${path}?page=${n}`);
  const from = (page - 1) * pageSize + 1;
  const to = (page - 1) * pageSize + items.length;

  // Numbered links to the immediate neighbours plus the ends, so every page is
  // reachable in a few hops rather than only sequentially.
  const near = new Set([1, pageCount, page - 1, page, page + 1, page - 2, page + 2]);
  const numbered = [...near]
    .filter((n) => n >= 1 && n <= pageCount)
    .sort((a, b) => a - b);

  const pagination = pageCount > 1 ? `
<nav class="collection-pages" aria-label="Pages">
${page > 1 ? `<a rel="prev" href="${esc(pageUrl(page - 1))}">← Previous</a>` : ''}
${numbered.map((n, i) => {
    const gap = i > 0 && n - numbered[i - 1] > 1 ? '<span aria-hidden="true">…</span>' : '';
    return gap + (n === page
      ? `<span aria-current="page">${n}</span>`
      : `<a href="${esc(pageUrl(n))}">${n}</a>`);
  }).join('')}
${page < pageCount ? `<a rel="next" href="${esc(pageUrl(page + 1))}">Next →</a>` : ''}
</nav>` : '';

  const bodyHtml = `
<h1>${esc(title)}</h1>
<p>${esc(intro)}</p>
${Number.isFinite(total) ? `<p><strong>${Number(total).toLocaleString()}</strong> records in this collection${
    pageCount > 1 && items.length ? `, showing ${from.toLocaleString()}–${to.toLocaleString()}` : ''
  }.</p>` : ''}
${items.length ? `<ul class="item-list">${items.map((item) => `
<li><a href="${esc(item.url)}">${esc(item.title)}</a>${item.meta ? `<small>${esc(item.meta)}</small>` : ''}</li>`).join('')}</ul>` : '<p>No records are currently available.</p>'}
${pagination}
`;
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    description,
    url: canonical,
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: Number.isFinite(total) ? total : items.length,
      itemListElement: items.map((item, index) => ({
        '@type': 'ListItem',
        // Position is absolute within the collection, not within the page,
        // so page 3 does not claim to hold items 1-100 again.
        position: (page - 1) * pageSize + index + 1,
        url: `https://epsteinproject.org${item.url}`,
        name: item.title,
      })),
    },
  };
  return new Response(renderDocPage({
    // Each page is its own canonical: pointing every page at /documents would
    // tell Google the deeper pages are duplicates and undo the crawl paths
    // this pagination exists to create.
    canonicalPath: page > 1 ? `${path}?page=${page}` : path,
    title,
    description,
    bodyHtml,
    spaHash,
    ogType: 'website',
    structuredData,
  }), { headers: htmlResponseHeaders() });
}

export function documentItems(rows) {
  return rows.map((doc) => ({
    url: `/documents/${doc.id}`,
    title: doc.title || doc.filename || `Document ${doc.id}`,
    meta: [doc.data_set, doc.document_type, doc.page_count ? `${doc.page_count} ${doc.page_count === 1 ? 'page' : 'pages'}` : null]
      .filter(Boolean)
      .join(' · '),
  }));
}
