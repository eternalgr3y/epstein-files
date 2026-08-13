import { describe, expect, test } from 'bun:test';
import { onRequestGet } from './images.js';
import { PAGE_CACHE_VERSION } from './_lib/html.js';

describe('crawlable images index', () => {
  test('loads previews through the API service binding', async () => {
    let requestedUrl;
    let forwardedIp;
    const response = await onRequestGet({
      request: new Request('https://epsteinproject.org/images?cache-bust=1', {
        headers: { 'CF-Connecting-IP': '203.0.113.25' },
      }),
      env: {
        API: {
          fetch: async (request) => {
            requestedUrl = request.url;
            forwardedIp = request.headers.get('CF-Connecting-IP');
            return Response.json({
              total: 1,
              images: [{ doc_id: 12, page: 0, filename: 'page.jpg' }],
            });
          },
        },
      },
    });
    expect(requestedUrl).toBe('https://api.internal/api/images?limit=48');
    expect(forwardedIp).toBe('203.0.113.25');
    const html = await response.text();
    expect(html).toContain('/documents/12');
    expect(html).toContain('Page 1 of document 12');
  });

  test('uses the path-only cache when no emergency exclusions are active', async () => {
    let fetched = false;
    let cachedKey;
    const cachedResponse = new Response('cached image index');
    const response = await onRequestGet({
      request: new Request('https://epsteinproject.org/images?arbitrary=1'),
      env: {
        API: { fetch: async () => { fetched = true; return Response.json({}); } },
      },
      cache: {
        async match(request) {
          cachedKey = request.url;
          return cachedResponse;
        },
      },
    });
    expect(cachedKey).toBe(`https://epsteinproject.org/images?v=${PAGE_CACHE_VERSION}`);
    expect(fetched).toBe(false);
    expect(await response.text()).toBe('cached image index');
  });

  test('fails soft when the service binding is unavailable', async () => {
    const response = await onRequestGet({ env: {} });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('No records are currently available.');
  });

  test('does not cache fail-soft output from a failed or malformed API response', async () => {
    for (const apiResponse of [
      new Response('temporarily unavailable', { status: 503 }),
      Response.json({ total: 0 }),
    ]) {
      let cachePuts = 0;
      let waitUntilCalls = 0;
      const response = await onRequestGet({
        request: new Request('https://epsteinproject.org/images'),
        env: { API: { fetch: async () => apiResponse.clone() } },
        cache: {
          match: async () => null,
          put: async () => { cachePuts += 1; },
        },
        waitUntil: () => { waitUntilCalls += 1; },
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('No records are currently available.');
      expect(cachePuts).toBe(0);
      expect(waitUntilCalls).toBe(0);
    }
  });

  test('omits locally excluded source documents and the stale API total', async () => {
    const response = await onRequestGet({
      env: {
        PUBLICATION_EXCLUSIONS: 'doc:12',
        API: {
          fetch: async () => Response.json({
            total: 2,
            images: [
              { doc_id: 12, page: 0, filename: 'excluded.jpg' },
              { doc_id: 13, page: 0, filename: 'allowed.jpg' },
            ],
          }),
        },
      },
    });
    const html = await response.text();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(html).not.toContain('/documents/12');
    expect(html).not.toContain('excluded.jpg');
    expect(html).toContain('/documents/13');
    expect(html).not.toContain('<strong>2</strong> records');
  });

  test('resolves a House token locally and filters stale service aliases', async () => {
    let aliasSql;
    let aliasBindings;
    let apiCalls = 0;
    const response = await onRequestGet({
      env: {
        PUBLICATION_EXCLUSIONS: 'house:house_oversight_010477',
        DB: {
          prepare(sql) {
            aliasSql = sql;
            const statement = {
              bind(...bindings) {
                aliasBindings = bindings;
                return statement;
              },
              async all() {
                return {
                  results: [{
                    document_id: 12,
                    bates_number: 'HOUSE_OVERSIGHT_010477',
                  }],
                };
              },
            };
            return statement;
          },
        },
        API: {
          fetch: async () => {
            apiCalls += 1;
            return Response.json({
              total: 2,
              images: [
                {
                  doc_id: 12,
                  page: 0,
                  filename: 'HOUSE_OVERSIGHT_010477_WITHDRAWN.jpg',
                },
                { doc_id: 13, page: 0, filename: 'allowed.jpg' },
              ],
            });
          },
        },
      },
    });
    const html = await response.text();

    expect(aliasSql).toContain('UPPER(filename) IN (?)');
    expect(aliasBindings).toEqual(['HOUSE_OVERSIGHT_010477']);
    expect(apiCalls).toBe(1);
    expect(html).not.toContain('/documents/12');
    expect(html).not.toContain('HOUSE_OVERSIGHT_010477_WITHDRAWN.jpg');
    expect(html).toContain('/documents/13');
    expect(html).toContain('allowed.jpg');
    expect(html).not.toContain('<strong>2</strong> records');
  });

  test('fails closed when a House alias cannot be resolved locally', async () => {
    let apiCalls = 0;
    const invocation = onRequestGet({
      env: {
        PUBLICATION_EXCLUSIONS: 'house:HOUSE_OVERSIGHT_010477',
        DB: {
          prepare() {
            const statement = {
              bind() { return statement; },
              async all() { return { results: [] }; },
            };
            return statement;
          },
        },
        API: { fetch: async () => { apiCalls += 1; return Response.json({}); } },
      },
    });

    await expect(invocation).rejects.toThrow('Unable to resolve all publication exclusion aliases');
    expect(apiCalls).toBe(0);
  });

  test('rejects malformed policy before resolving aliases or calling the service', async () => {
    let touched = false;
    const invocation = onRequestGet({
      env: {
        PUBLICATION_EXCLUSIONS: 'house:not-a-bates-number',
        DB: { prepare() { touched = true; throw new Error('must not query'); } },
        API: { fetch: async () => { touched = true; return Response.json({}); } },
      },
    });

    await expect(invocation).rejects.toThrow('Invalid publication exclusion');
    expect(touched).toBe(false);
  });
});
