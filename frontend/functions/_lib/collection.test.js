import { describe, expect, test } from 'bun:test';
import { renderCollectionResponse } from './collection.js';

function linksOn(page, pageCount = 195) {
  const response = renderCollectionResponse({
    path: '/documents',
    title: 'Documents',
    description: 'Fixture',
    intro: 'Fixture',
    items: [{ url: `/documents/${page}`, title: `Document ${page}` }],
    total: pageCount * 100,
    page,
    pageSize: 100,
    spaHash: 'documents/0',
  });
  return response.text().then((html) => [...html.matchAll(/href="\/documents\?page=(\d+)"/g)]
    .map((match) => Number(match[1])));
}

describe('collection crawl graph', () => {
  test('keeps paginated CollectionPage schema aligned with the self-canonical URL', async () => {
    const response = renderCollectionResponse({
      path: '/documents',
      title: 'Documents',
      description: 'Fixture',
      intro: 'Fixture',
      items: [{ url: '/documents/101', title: 'Document 101' }],
      total: 200,
      page: 2,
      pageSize: 100,
      spaHash: 'documents/0',
    });
    const html = await response.text();
    expect(html).toContain('<link rel="canonical" href="https://epsteinproject.org/documents?page=2">');
    expect(html).toContain('"url":"https://epsteinproject.org/documents?page=2"');
  });

  test('keeps pagination bounded and reaches all 195 pages within four hops', async () => {
    const graph = new Map();
    for (let page = 1; page <= 195; page += 1) {
      const links = await linksOn(page);
      expect(new Set(links).size).toBeLessThanOrEqual(18);
      graph.set(page, new Set([1, ...links]));
    }

    const seen = new Set([1]);
    let frontier = new Set([1]);
    for (let hop = 0; hop < 4 && seen.size < 195; hop += 1) {
      const next = new Set();
      for (const page of frontier) {
        for (const linked of graph.get(page) || []) {
          if (!seen.has(linked)) next.add(linked);
          seen.add(linked);
        }
      }
      frontier = next;
    }
    expect(seen.size).toBe(195);
  });
});
