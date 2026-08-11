import { describe, expect, test } from 'bun:test';
import { onRequestGet as documentPage } from './documents/[id].js';
import { onRequestGet as setPage } from './documents/set/[slug].js';
import { onRequestGet as videosPage } from './videos.js';

function cacheHarness() {
  const writes = [];
  const previous = globalThis.caches;
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      default: {
        async match() { return undefined; },
        async put(request, response) { writes.push({ request, response }); },
      },
    },
  });
  return {
    writes,
    restore() {
      if (previous === undefined) delete globalThis.caches;
      else Object.defineProperty(globalThis, 'caches', {
        configurable: true,
        value: previous,
      });
    },
  };
}

function documentDb(doc, text = null) {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes('SELECT * FROM documents WHERE id')) return doc;
              if (sql.includes('SELECT full_text FROM document_texts')) return text;
              if (sql.includes('filename <') || sql.includes('filename >')) return null;
              throw new Error(`Unexpected document query: ${sql}`);
            },
          };
        },
      };
    },
  };
}

describe('canonical Pages routes', () => {
  test('renders malformed and missing document paths as recoverable no-store 404 pages', async () => {
    const malformed = await documentPage({
      params: { id: '01' },
      request: new Request('https://epsteinproject.org/documents/01'),
      env: {},
    });
    expect(malformed.status).toBe(404);
    expect(malformed.headers.get('cache-control')).toBe('no-store');
    expect(await malformed.text()).toContain('There is no record at this address.');

    const cache = cacheHarness();
    try {
      const missing = await documentPage({
        params: { id: '999999' },
        request: new Request('https://epsteinproject.org/documents/999999'),
        env: { DB: documentDb(null) },
        waitUntil() {},
      });
      const html = await missing.text();
      expect(missing.status).toBe(404);
      expect(missing.headers.get('cache-control')).toBe('no-store');
      expect(html).toContain('<link rel="canonical" href="https://epsteinproject.org/">');
      expect(html).toContain('Browse the document index');
      expect(cache.writes).toHaveLength(0);
    } finally {
      cache.restore();
    }
  });

  test('redirects estate records to their one canonical House Oversight URL', async () => {
    const cache = cacheHarness();
    try {
      const response = await documentPage({
        params: { id: '77' },
        request: new Request('https://epsteinproject.org/documents/77'),
        env: {
          DB: documentDb({
            id: 77,
            filename: 'HOUSE_OVERSIGHT_010477',
            data_set: 'house-oversight-estate',
          }),
        },
        waitUntil() {},
      });
      expect(response.status).toBe(301);
      expect(response.headers.get('location')).toBe(
        'https://epsteinproject.org/house-oversight/HOUSE_OVERSIGHT_010477'
      );
      expect(cache.writes).toHaveLength(0);
    } finally {
      cache.restore();
    }
  });

  test('renders a canonical video page with media schema, CSP, and honest transcript state', async () => {
    const cache = cacheHarness();
    const pending = [];
    try {
      const response = await documentPage({
        params: { id: '22425' },
        request: new Request('https://epsteinproject.org/documents/22425?tracking=ignored'),
        env: {
          DB: documentDb({
            id: 22425,
            filename: 'DOJ-OGR-00022168',
            title: 'video1.mp4',
            document_type: 'video',
            content_type: 'video/mp4',
            data_set: 'house-oversight-doj',
            source_url: 'https://oversight.house.gov/source',
            created_at: '2026-07-19 15:36:31',
          }),
        },
        waitUntil(promise) { pending.push(promise); },
      });
      const html = await response.text();
      await Promise.all(pending);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toContain(
        "media-src 'self' https://media.epsteinproject.org"
      );
      expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
      expect(html).toContain('<link rel="canonical" href="https://epsteinproject.org/documents/22425">');
      expect(html).toContain('"@type":"VideoObject"');
      expect(html).toContain('<video controls preload="metadata"');
      expect(html).toContain('<h2>Transcript</h2>');
      expect(html).toContain('No transcript has been extracted for this media file.');
      expect(cache.writes).toHaveLength(1);
      expect(cache.writes[0].request.url).toContain('v=');
      expect(cache.writes[0].request.url).not.toContain('tracking=ignored');
    } finally {
      cache.restore();
    }
  });

  test('clamps a rare out-of-range collection page and canonicalizes the result', async () => {
    const DB = {
      prepare(sql) {
        const statement = {
          bind() { return statement; },
          async first() {
            if (sql.includes('COUNT(*)')) return { count: 101 };
            throw new Error(`Unexpected first query: ${sql}`);
          },
          async all() {
            if (sql.includes("document_type = 'video'")) {
              return {
                results: [{
                  id: 1,
                  filename: 'final-video.mp4',
                  title: 'Final video',
                  document_type: 'video',
                  data_set: 'data-set-8',
                }],
              };
            }
            throw new Error(`Unexpected all query: ${sql}`);
          },
        };
        return statement;
      },
    };
    const response = await videosPage({
      env: { DB },
      request: new Request('https://epsteinproject.org/videos?page=999999'),
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<link rel="canonical" href="https://epsteinproject.org/videos?page=2">');
    expect(html).toContain('<span aria-current="page">2</span>');
    expect(html).toContain('<a rel="prev" href="/videos">← Previous</a>');
    expect(html).not.toContain('rel="next"');
    expect(html).toContain('"position":101');
  });

  test('rejects unknown dataset collection slugs without querying D1', async () => {
    const response = await setPage({
      params: { slug: 'not-a-release' },
      request: new Request('https://epsteinproject.org/documents/set/not-a-release'),
      env: {
        DB: { prepare() { throw new Error('D1 should not be queried'); } },
      },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('Collection not found');
  });
});
