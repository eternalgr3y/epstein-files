import { describe, expect, test } from 'bun:test';
import { onRequestGet } from './sitemap.xml.js';

function sitemapDb() {
  return {
    prepare() {
      return {
        bind() {
          return { all: async () => ({ results: [] }) };
        },
      };
    },
  };
}

function populatedSitemapDb() {
  let call = 0;
  return {
    prepare() {
      call += 1;
      const rows = call === 1
        ? [
            { id: 1, lastmod: '2026-07-27' },
            { id: 2, lastmod: '2026-09-01' },
          ]
        : [
            { bates_number: 'HOUSE_OVERSIGHT_000001', lastmod: null },
            { bates_number: 'HOUSE_OVERSIGHT_000002', lastmod: '2026-09-02' },
          ];
      return {
        bind() { return { all: async () => ({ results: rows }) }; },
      };
    },
  };
}

describe('sitemap publication exclusions', () => {
  test('uses significant template dates without masking newer record updates', async () => {
    const response = await onRequestGet({
      env: { DB: populatedSitemapDb() },
      request: new Request('https://epsteinproject.org/sitemap.xml'),
      cache: { async match() { return null; }, async put() {} },
      waitUntil() {},
    });
    const xml = await response.text();

    expect(xml).toMatch(/<loc>https:\/\/epsteinproject\.org\/documents\/1<\/loc>\s*<lastmod>2026-08-13<\/lastmod>/);
    expect(xml).toMatch(/<loc>https:\/\/epsteinproject\.org\/documents\/2<\/loc>\s*<lastmod>2026-09-01<\/lastmod>/);
    expect(xml).toMatch(/<loc>https:\/\/epsteinproject\.org\/house-oversight\/HOUSE_OVERSIGHT_000001<\/loc>\s*<lastmod>2026-08-13<\/lastmod>/);
    expect(xml).toMatch(/<loc>https:\/\/epsteinproject\.org\/house-oversight\/HOUSE_OVERSIGHT_000002<\/loc>\s*<lastmod>2026-09-02<\/lastmod>/);
    expect(xml).toMatch(/<loc>https:\/\/epsteinproject\.org\/documents\/set\/court-records<\/loc>\s*<lastmod>2026-08-13<\/lastmod>/);
    expect(xml).toMatch(/<loc>https:\/\/epsteinproject\.org\/videos<\/loc>\s*<lastmod>2026-08-13<\/lastmod>/);
    expect(xml).toMatch(/<loc>https:\/\/epsteinproject\.org\/about<\/loc>\s*<changefreq>/);
  });
  test('requires browser revalidation while retaining the shared one-hour cache', async () => {
    const cache = {
      async match() { return null; },
      async put() {},
    };
    const response = await onRequestGet({
      env: { DB: sitemapDb() },
      request: new Request('https://epsteinproject.org/sitemap.xml'),
      cache,
      waitUntil() {},
    });
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=0, s-maxage=3600, must-revalidate'
    );
  });

  test('uses bound exclusions and bypasses the shared cache while active', async () => {
    const queries = [];
    let cacheTouched = false;
    const env = {
      PUBLICATION_EXCLUSIONS: 'doc:12 house:HOUSE_OVERSIGHT_010477',
      DB: {
        prepare(sql) {
          const query = { sql, bindings: [] };
          queries.push(query);
          return {
            bind(...bindings) {
              query.bindings = bindings;
              return {
                all: async () => ({ results: [] }),
              };
            },
          };
        },
      },
    };
    const response = await onRequestGet({
      env,
      request: new Request('https://epsteinproject.org/sitemap.xml?cache-bust=1'),
      cache: {
        async match() {
          cacheTouched = true;
          return null;
        },
        async put() {
          cacheTouched = true;
        },
      },
      waitUntil() {
        cacheTouched = true;
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/xml');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(cacheTouched).toBe(false);
    expect(queries).toHaveLength(2);
    expect(queries[0].sql).toContain('d.id NOT IN (?)');
    expect(queries[0].bindings).toEqual([12]);
    expect(queries[1].sql).toContain('ho.bates_number NOT IN (?)');
    expect(queries[1].sql).toContain('ho.legacy_document_id NOT IN (?)');
    expect(queries[1].bindings).toEqual(['HOUSE_OVERSIGHT_010477', 12]);
  });
});
