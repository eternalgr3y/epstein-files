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

  test('bounds long entity LIKE patterns without failing document search', async () => {
    const captured = [];
    const env = {
      DB: {
        prepare(sql) {
          return {
            bind(...params) {
              captured.push({ sql, params });
              return {
                async all() { return { results: [] }; },
                async first() { return { total: 0 }; },
              };
            },
          };
        },
      },
    };
    const query = 'x'.repeat(100);
    const { response } = await responseJson(`/api/search?q=${query}`, env);
    expect(response.status).toBe(200);
    const likeParams = captured.flatMap(item => item.params)
      .filter(param => typeof param === 'string' && param.startsWith('%'));
    expect(likeParams.length).toBeGreaterThan(0);
    expect(likeParams.every(pattern => new TextEncoder().encode(pattern).byteLength <= 50)).toBe(true);
  });

  test('bounds escaped entity search patterns to the D1 limit', async () => {
    const captured = [];
    const env = {
      DB: {
        prepare(sql) {
          return {
            bind(...params) {
              captured.push({ sql, params });
              return {
                async all() { return { results: [] }; },
                async first() { return { total: 0 }; },
              };
            },
          };
        },
      },
    };
    const query = '_'.repeat(100);
    const { response } = await responseJson('/api/entities/search', env, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    expect(response.status).toBe(200);
    const likeParams = captured.flatMap(item => item.params)
      .filter(param => typeof param === 'string' && param.startsWith('%'));
    expect(likeParams).toHaveLength(2);
    expect(likeParams.every(pattern => new TextEncoder().encode(pattern).byteLength <= 50)).toBe(true);
    expect(likeParams.every(pattern => !pattern.endsWith('\\%'))).toBe(true);
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

describe('Search result metadata', () => {
  test('derives has_text from stored text, not the documents column', async () => {
    const env = {
      DB: {
        prepare(sql) {
          if (sql.includes('snippet(document_fts')) {
            // documents.has_text is wrong for ~2,500 rows (marked completed
            // with has_text=1 but no document_texts row), so the search
            // response must not be built from that column.
            expect(sql).toContain('FROM document_texts dt');
            expect(sql).not.toContain('d.has_text');
            expect(sql).toContain('d.processing_status');
            expect(sql).toContain('d.ocr_confidence');
            return {
              bind() {
                return {
                  async all() {
                    return {
                      results: [{
                        id: 42,
                        filename: 'source.pdf',
                        title: 'Source PDF',
                        data_set: 'data-set-8',
                        document_type: 'pdf',
                        source_url: 'https://example.test/source.pdf',
                        has_text: 1,
                        processing_status: 'completed',
                        ocr_confidence: 0.91,
                        snippet: 'matching text',
                      }],
                    };
                  },
                };
              },
            };
          }
          if (sql.includes('SELECT COUNT(*) as total')) {
            return {
              bind() {
                return { async first() { return { total: 1 }; } };
              },
            };
          }
          if (sql.includes('FROM entities')) {
            return {
              bind() {
                return { async all() { return { results: [] }; } };
              },
            };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      },
    };

    const { response, body } = await responseJson('/api/search?q=matching', env);
    expect(response.status).toBe(200);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].has_text).toBe(true);
    expect(body.results[0].processing_status).toBe('completed');
    expect(body.results[0].ocr_confidence).toBe(0.91);
  });
});

describe('Document text availability', () => {
  // Regression: ~2,500 documents are stored as processing_status='completed'
  // with has_text=1 but have no document_texts row at all. The API used to
  // echo that column, so the UI promised searchable text and the follow-up
  // /documents/:id/text request then 404'd.
  test('reports has_text false when the documents column lies', async () => {
    const env = {
      DB: {
        prepare(sql) {
          if (sql.includes('FROM documents')) {
            return {
              bind() {
                return {
                  async first() {
                    return {
                      id: 4080,
                      filename: 'EFTA00009676.pdf',
                      data_set: 'data-set-8',
                      document_type: 'pdf',
                      processing_status: 'completed',
                      has_text: 1, // the lie
                    };
                  },
                };
              },
            };
          }
          if (sql.includes('FROM document_texts')) {
            return {
              bind() {
                return { async first() { return null; } }; // no text stored
              },
            };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      },
    };

    const { response, body } = await responseJson('/api/documents/4080', env);
    expect(response.status).toBe(200);
    expect(body.has_text).toBe(false);
    expect(body.word_count).toBe(0);
    expect(body.text_preview).toBe(null);
  });

  test('reports has_text true when text is actually stored', async () => {
    const env = {
      DB: {
        prepare(sql) {
          if (sql.includes('FROM documents')) {
            return {
              bind() {
                return {
                  async first() {
                    return {
                      id: 4197,
                      filename: 'EFTA00010062.pdf',
                      processing_status: 'completed',
                      has_text: 1,
                    };
                  },
                };
              },
            };
          }
          if (sql.includes('FROM document_texts')) {
            return {
              bind() {
                return {
                  async first() {
                    return { full_text: 'EPSTEIN JEFFREY', word_count: 2 };
                  },
                };
              },
            };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      },
    };

    const { body } = await responseJson('/api/documents/4197', env);
    expect(body.has_text).toBe(true);
    expect(body.word_count).toBe(2);
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

    env.R2 = {
      async get(key) {
        return key === 'images/14672_p0_0.png'
          ? { body: 'png-bytes', httpMetadata: { contentType: 'image/png' } }
          : null;
      },
    };

    const response = await worker.fetch(request('/api/images/14672_p0_0.png'), env, {});
    expect(calls).toBe(0);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toContain('immutable');
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

  test('returns explicit non-cacheable errors for missing and zero-byte document files', async () => {
    let storedObject = null;
    const env = {
      DB: {
        prepare() {
          return {
            bind() {
              return {
                async first() {
                  return {
                    local_path: '/archive/epstein-files/raw/missing.pdf',
                    filename: 'missing.pdf',
                    document_type: 'pdf',
                    content_type: 'application/pdf',
                  };
                },
              };
            },
          };
        },
      },
      R2: { async get() { return storedObject; } },
    };

    const missing = await worker.fetch(request('/api/documents/88/file'), env, {});
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'File not available' });
    expect(missing.headers.get('cache-control')).toBeNull();

    storedObject = { body: new Uint8Array(), size: 0 };
    const empty = await worker.fetch(request('/api/documents/88/file'), env, {});
    expect(empty.status).toBe(502);
    expect(await empty.json()).toEqual({ error: 'File is empty' });
    expect(empty.headers.get('cache-control')).toBeNull();
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

  test('keeps ranged video playback on the Worker instead of redirecting to a full file', async () => {
    const gets = [];
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
                    document_type: 'video',
                    content_type: 'video/mp4',
                    file_size: 20_955_328_421,
                  };
                },
              };
            },
          };
        },
      },
      R2: {
        async get(key, options) {
          gets.push({ key, range: options?.range?.get('range') });
          if (key.startsWith('streaming/')) return null;
          return {
            body: new Uint8Array(1024),
            size: 20_955_328_421,
            range: { offset: 1_048_576, length: 1024 },
            httpEtag: '"huge-video"',
          };
        },
      },
    };

    const response = await worker.fetch(request('/api/documents/22425/file', {
      headers: { Range: 'bytes=1048576-1049599' },
    }), env, {});

    expect(response.status).toBe(206);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('content-range')).toBe('bytes 1048576-1049599/20955328421');
    expect(response.headers.get('content-length')).toBe('1024');
    expect(gets).toEqual([
      { key: 'streaming/raw/house-oversight-doj/DOJ-OGR-00022168.mp4', range: 'bytes=1048576-1049599' },
      { key: 'raw/house-oversight-doj/DOJ-OGR-00022168.mp4', range: 'bytes=1048576-1049599' },
    ]);
  });

  test('returns 416 with the object size for an unsatisfiable video range', async () => {
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
                    document_type: 'video',
                    content_type: 'video/mp4',
                    file_size: 20_955_328_421,
                  };
                },
              };
            },
          };
        },
      },
      R2: {
        async get() {
          throw new Error('an unsatisfiable range should be rejected before R2.get');
        },
        async head() {
          throw new Error('an unsatisfiable range should be rejected before R2.head');
        },
      },
    };

    const response = await worker.fetch(request('/api/documents/22425/file', {
      headers: { Range: 'bytes=20955328421-' },
    }), env, {});

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */20955328421');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'Requested range is not satisfiable' });
  });

  test('still redirects an ordinary whole-video playback request', async () => {
    const env = {
      DB: {
        prepare() {
          return {
            bind() {
              return {
                async first() {
                  return {
                    local_path: '/archive/epstein-files/raw/video.mp4',
                    filename: 'video.mp4',
                    document_type: 'video',
                    content_type: 'video/mp4',
                  };
                },
              };
            },
          };
        },
      },
      R2: {
        async head(key) {
          expect(key).toBe('streaming/raw/video.mp4');
          return { size: 1234 };
        },
        async get() {
          throw new Error('whole playback should redirect before R2.get');
        },
      },
    };

    const response = await worker.fetch(request('/api/documents/7/file'), env, {});
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://media.epsteinproject.org/streaming/raw/video.mp4'
    );
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

describe('Entity co-occurrences', () => {
  test('returns partners ordered by shared documents', async () => {
    const env = {
      DB: {
        prepare(sql) {
          return {
            bind() {
              return {
                async all() {
                  expect(sql).toContain('FROM entity_cooccurrence');
                  return { results: [
                    { other_entity_id: 2, shared_docs: 9, canonical_name: 'B', entity_type: 'person', mention_count: 40 },
                  ] };
                },
              };
            },
          };
        },
      },
    };
    const { response, body } = await responseJson('/api/entities/1/co-occurrences', env);
    expect(response.status).toBe(200);
    expect(body.results).toEqual([
      { entity_id: 2, name: 'B', type: 'person', mention_count: 40, shared_docs: 9 },
    ]);
  });

  test('degrades to empty results while the table is not imported', async () => {
    const env = {
      DB: {
        prepare() {
          return { bind() { return { async all() { throw new Error('D1_ERROR: no such table: entity_cooccurrence'); } }; } };
        },
      },
    };
    const { response, body } = await responseJson('/api/entities/1/co-occurrences', env);
    expect(response.status).toBe(200);
    expect(body.results).toEqual([]);
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
