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

describe('sitemap publication exclusions', () => {
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
