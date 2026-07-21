import { esc, htmlResponseHeaders, renderDocPage } from './html.js';

export function renderCollectionResponse({ path, title, description, intro, items, total, spaHash }) {
  const canonical = `https://epsteinproject.org${path}`;
  const bodyHtml = `
<h1>${esc(title)}</h1>
<p>${esc(intro)}</p>
${Number.isFinite(total) ? `<p><strong>${Number(total).toLocaleString()}</strong> records in this collection.</p>` : ''}
${items.length ? `<ul class="item-list">${items.map((item) => `
<li><a href="${esc(item.url)}">${esc(item.title)}</a>${item.meta ? `<small>${esc(item.meta)}</small>` : ''}</li>`).join('')}</ul>` : '<p>No records are currently available.</p>'}
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
        position: index + 1,
        url: `https://epsteinproject.org${item.url}`,
        name: item.title,
      })),
    },
  };
  return new Response(renderDocPage({
    canonicalPath: path,
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
