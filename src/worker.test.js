import { describe, expect, test } from 'bun:test';
import worker from './worker.js';

function request(path, init = {}) {
  return new Request(`https://api.example.test${path}`, init);
}

async function responseJson(path, env = {}, init = {}) {
  const response = await worker.fetch(request(path, init), env, {});
  return { response, body: await response.json() };
}

describe('Worker request validation', () => {
  test('rejects a non-numeric search limit without touching D1', async () => {
    const { response, body } = await responseJson('/api/search?q=test&limit=abc');
    expect(response.status).toBe(400);
    expect(body.error).toContain('limit must be a whole number');
    expect(body.error).not.toContain('D1_ERROR');
  });

  test('rejects a non-numeric browse limit without touching D1', async () => {
    const { response, body } = await responseJson('/api/browse?limit=abc');
    expect(response.status).toBe(400);
    expect(body.error).toContain('limit must be a whole number');
  });

  test('rejects an invalid OCR availability filter without touching D1', async () => {
    const { response, body } = await responseJson('/api/browse?has_text=yes');
    expect(response.status).toBe(400);
    expect(body.error).toBe('has_text must be 0 or 1');
  });

  test('rejects malformed OR syntax before issuing an FTS query', async () => {
    const { response, body } = await responseJson('/api/search?q=OR');
    expect(response.status).toBe(400);
    expect(body.error).toBe('OR must appear between two search terms');
  });

  test('rejects malformed JSON entity searches', async () => {
    const { response, body } = await responseJson('/api/entities/search', {}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad json',
    });
    expect(response.status).toBe(400);
    expect(body.error).toBe('Request body must be valid JSON');
  });

  test('returns 405 for unsupported methods', async () => {
    const { response, body } = await responseJson('/api/stats', {}, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, OPTIONS');
    expect(body.error).toBe('Method not allowed');
  });
});

describe('Worker security behavior', () => {
  test('uses the Cloudflare rate-limit binding and returns 429', async () => {
    let key;
    const env = {
      API_RATE_LIMITER: {
        async limit(input) {
          key = input.key;
          return { success: false };
        },
      },
    };
    const { response, body } = await responseJson('/health', env, {
      headers: { 'CF-Connecting-IP': '203.0.113.10' },
    });
    expect(key).toBe('203.0.113.10');
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(body.retry_after).toBe(60);
  });

  test('does not rate-limit R2-backed image delivery', async () => {
    let calls = 0;
    const env = {
      API_RATE_LIMITER: {
        async limit() {
          calls++;
          return { success: false };
        },
      },
    };

    const response = await worker.fetch(request('/api/images/14672_p0_0.png'), env, {});
    expect(calls).toBe(0);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/images/14672_p0_0.png');
  });

  test('serves extensionless Bates PDFs with their stored media type', async () => {
    const env = {
      DB: {
        prepare() {
          return {
            bind() {
              return {
                async first() {
                  return {
                    local_path: '/archive/epstein-files/raw/house-oversight-doj/DOJ-OGR-00000001.pdf',
                    filename: 'DOJ-OGR-00000001',
                    title: 'Certificate of Service.pdf',
                    data_set: 'house-oversight-doj',
                    content_type: 'application/pdf',
                  };
                },
              };
            },
          };
        },
      },
      R2: {
        async get(key) {
          expect(key).toBe('raw/house-oversight-doj/DOJ-OGR-00000001.pdf');
          return { body: new Uint8Array([0x25, 0x50, 0x44, 0x46]) };
        },
      },
    };

    const response = await worker.fetch(request('/api/documents/20913/file'), env, {});
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
  });

  test('streams document byte ranges instead of returning the entire object', async () => {
    let getOptions;
    const env = {
      DB: {
        prepare() {
          return {
            bind() {
              return {
                async first() {
                  return {
                    local_path: '/archive/epstein-files/raw/house-oversight-doj/DOJ-OGR-00022168.mp4',
                    filename: 'DOJ-OGR-00022168',
                    title: 'video1.mp4',
                    data_set: 'house-oversight-doj',
                    content_type: 'video/mp4',
                  };
                },
              };
            },
          };
        },
      },
      R2: {
        async get(key, options) {
          expect(key).toBe('raw/house-oversight-doj/DOJ-OGR-00022168.mp4');
          getOptions = options;
          return {
            body: new Uint8Array(1024),
            size: 20_955_328_421,
            range: { offset: 0, length: 1024 },
            httpEtag: '"video-etag"',
          };
        },
      },
    };

    const response = await worker.fetch(request('/api/documents/22425/file', {
      headers: { Range: 'bytes=0-1023' },
    }), env, {});

    expect(getOptions.range.get('range')).toBe('bytes=0-1023');
    expect(response.status).toBe(206);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBe('bytes 0-1023/20955328421');
    expect(response.headers.get('content-length')).toBe('1024');
    expect(response.headers.get('etag')).toBe('"video-etag"');
  });

  test('scopes House Oversight stats from documents into the mentions index', async () => {
    const queries = [];
    const env = {
      DB: {
        prepare(sql) {
          queries.push(sql);
          return {
            async first() {
              return {
                documents: 2897,
                pages: 23124,
                entities: 59627,
                mentions: 315124,
                top_entities: '[]',
              };
            },
          };
        },
      },
    };

    const { response } = await responseJson('/api/house-oversight/stats', env);
    expect(response.status).toBe(200);
    const mentionQueries = queries.filter(sql => sql.includes('mentions m'));
    expect(mentionQueries).toHaveLength(1);
    expect(mentionQueries[0]).toContain('AS MATERIALIZED');
    expect(mentionQueries[0]).toContain('CROSS JOIN mentions m');
  });

  test('does not expose unexpected D1 exception details', async () => {
    const env = {
      DB: {
        prepare() {
          throw new Error('D1_ERROR: secret schema detail');
        },
      },
    };
    const { response, body } = await responseJson('/api/stats', env);
    expect(response.status).toBe(500);
    expect(body.error).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('secret schema detail');
  });

  test('adds security headers to preflight responses', async () => {
    const response = await worker.fetch(request('/api/search', { method: 'OPTIONS' }), {}, {});
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('Source filtering', () => {
  function capturingDb(rows = []) {
    const captured = [];
    return {
      captured,
      DB: {
        prepare(sql) {
          return {
            bind(...params) {
              captured.push({ sql, params });
              return {
                async all() { return { results: rows }; },
                async first() { return { total: rows.length, count: rows.length }; },
              };
            },
            async all() { captured.push({ sql, params: [] }); return { results: rows }; },
            async first() { captured.push({ sql, params: [] }); return { total: rows.length, count: rows.length }; },
          };
        },
      },
    };
  }

  test('rejects an unknown source without touching D1', async () => {
    const { response, body } = await responseJson('/api/browse?source=nonsense');
    expect(response.status).toBe(400);
    expect(body.error).toContain('source must be one of');
  });

  test('expands source=doj-release to all DOJ sets including the legacy alias', async () => {
    const { captured, DB } = capturingDb();
    const { response } = await responseJson('/api/browse?source=doj-release', { DB });
    expect(response.status).toBe(200);
    const filtered = captured.find(q => q.sql.includes('data_set IN'));
    expect(filtered).toBeDefined();
    expect(filtered.params).toContain('data-set');
    expect(filtered.params).toContain('data-set-8');
    expect(filtered.params).toContain('Data Set 8');
  });

  test('matches the legacy alias when filtering by data_set directly', async () => {
    const { captured, DB } = capturingDb();
    await responseJson('/api/search?source=doj-release&data_set=data-set-8&document_type=video', { DB });
    const filtered = captured.find(q => q.sql.includes('data_set IN'));
    expect(filtered.params).toEqual(expect.arrayContaining(['data-set-8', 'Data Set 8']));
    expect(filtered.params).not.toContain('data-set-7');
  });

  test('stats merges legacy alias counts into the canonical set name', async () => {
    const rows = [
      { data_set: 'data-set-8', count: 10 },
      { data_set: 'Data Set 8', count: 5 },
      { data_set: 'court-records', count: 3 },
    ];
    const { DB } = capturingDb(rows);
    const { response, body } = await responseJson('/api/stats', { DB });
    expect(response.status).toBe(200);
    const merged = body.data_sets.find(s => s.name === 'data-set-8');
    expect(merged.count).toBe(15);
    expect(body.data_sets.some(s => s.name === 'Data Set 8')).toBe(false);
  });
});
