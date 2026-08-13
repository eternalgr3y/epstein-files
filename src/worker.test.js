import { describe, expect, test } from 'bun:test';
import worker from './worker.js';

function request(path, init = {}) {
  return new Request(`https://api.example.test${path}`, init);
}

const allowLimiter = {
  async limit() {
    return { success: true };
  },
};

function testEnv(env = {}) {
  return {
    API_RATE_LIMITER: allowLimiter,
    MEDIA_RATE_LIMITER: allowLimiter,
    ...env,
  };
}

async function responseJson(path, env = {}, init = {}) {
  const response = await worker.fetch(request(path, init), testEnv(env), {});
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

  test('rejects declared entity request bodies over 10 KiB before reading', async () => {
    let pulls = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array([123]));
      },
    });
    const response = await worker.fetch(new Request(
      'https://api.example.test/api/entities/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(10 * 1024 + 1),
        },
        body,
        duplex: 'half',
      }
    ), testEnv(), {});
    expect(response.status).toBe(413);
    // Bun may prime a request stream once while constructing Request, but the
    // Worker must reject on Content-Length without advancing it further.
    expect(pulls).toBeLessThanOrEqual(1);
  });

  test('cancels a chunked entity request as soon as it exceeds 10 KiB', async () => {
    let pulls = 0;
    let cancelled = false;
    const chunk = new Uint8Array(4096).fill(0x61);
    const body = new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await worker.fetch(new Request(
      'https://api.example.test/api/entities/search',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        duplex: 'half',
      }
    ), testEnv(), {});
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(4);
  });

  test('returns 405 for unsupported methods', async () => {
    const { response, body } = await responseJson('/api/stats', {}, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, OPTIONS');
    expect(body.error).toBe('Method not allowed');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
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

describe('Video collection', () => {
  test('keeps verified House Oversight native videos in the collection', async () => {
    const queries = [];
    const estateVideo = {
      id: 15999,
      filename: 'HOUSE_OVERSIGHT_026678',
      title: 'IMG_0642.MP4.mov',
      data_set: 'house-oversight-estate',
    };
    const env = {
      DB: {
        prepare(sql) {
          queries.push(sql);
          return {
            async first() { return { count: 1 }; },
            bind() {
              return { async all() { return { results: [estateVideo] }; } };
            },
          };
        },
      },
    };

    const { response, body } = await responseJson('/api/videos?limit=48&offset=0', env);
    expect(response.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.videos[0]).toMatchObject(estateVideo);
    expect(queries).toHaveLength(2);
    for (const sql of queries) {
      expect(sql).toContain("document_type = 'video'");
      expect(sql).not.toContain("data_set != 'house-oversight-estate'");
    }
  });
});

describe('Worker security behavior', () => {
  test('uses the API rate-limit binding and returns 429', async () => {
    let key;
    const env = {
      API_RATE_LIMITER: {
        async limit(input) {
          key = input.key;
          return { success: false };
        },
      },
    };
    const { response, body } = await responseJson('/api/stats', env, {
      headers: { 'CF-Connecting-IP': '203.0.113.10' },
    });
    expect(key).toBe('203.0.113.10');
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(body.retry_after).toBe(60);
  });

  test('uses the separate media limiter for R2-backed image delivery', async () => {
    let mediaKey;
    let apiCalls = 0;
    const env = {
      API_RATE_LIMITER: {
        async limit() {
          apiCalls++;
          return { success: false };
        },
      },
      MEDIA_RATE_LIMITER: {
        async limit(input) {
          mediaKey = input.key;
          return { success: true };
        },
      },
    };

    env.R2 = {
      async get(key) {
        return key === 'images/14672_p0_0.png'
          ? { body: 'png-bytes', httpMetadata: { contentType: 'text/html' } }
          : null;
      },
    };

    const response = await worker.fetch(request('/api/images/14672_p0_0.png'), testEnv(env), {});
    expect(apiCalls).toBe(0);
    expect(mediaKey).toBe('media:unknown');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toContain('max-age=60');
    expect(response.headers.get('cache-control')).not.toContain('immutable');
    expect(response.headers.get('link')).toBe(
      '<https://epsteinproject.org/documents/14672>; rel=canonical'
    );
  });

  test('uses a distinct media limiter key for Range delivery', async () => {
    let key;
    const response = await worker.fetch(request('/api/documents/42/file', {
      headers: { Range: 'bytes=0-0', 'CF-Connecting-IP': '203.0.113.12' },
    }), {
      API_RATE_LIMITER: allowLimiter,
      MEDIA_RATE_LIMITER: {
        async limit(input) {
          key = input.key;
          return { success: false };
        },
      },
    }, {});

    expect(key).toBe('range:203.0.113.12');
    expect(response.status).toBe(429);
    expect(response.headers.get('x-ratelimit-limit')).toBe('300');
  });

  test('fails closed when the API limiter binding is absent', async () => {
    const response = await worker.fetch(request('/api/search?q=test'), {}, {});
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body.error).toBe('Service temporarily unavailable. Please retry shortly.');
  });

  test('fails closed before R2 when the media limiter binding is absent', async () => {
    let r2Calls = 0;
    const response = await worker.fetch(request('/api/images/14672_p0_0.png'), {
      API_RATE_LIMITER: allowLimiter,
      R2: {
        async get() {
          r2Calls++;
          return { body: 'must not be served' };
        },
      },
    }, {});
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(r2Calls).toBe(0);
  });

  test('fails closed when the API limiter binding throws', async () => {
    const response = await worker.fetch(request('/api/search?q=test'), {
      API_RATE_LIMITER: {
        async limit() {
          throw new Error('binding unavailable');
        },
      },
    }, {});
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
  });

  test('keeps health and API discovery available without limiter bindings', async () => {
    const health = await worker.fetch(request('/health'), {}, {});
    const info = await worker.fetch(request('/api'), {}, {});
    expect(health.status).toBe(200);
    expect(info.status).toBe(200);
  });

  test('redirects cleartext requests before body, D1, or limiter work', async () => {
    let limiterCalls = 0;
    let d1Calls = 0;
    const req = new Request(
      'http://epstein-files-api.protonuser597.workers.dev/api/entities/search?x=1',
      { method: 'POST', body: '{}' }
    );
    const response = await worker.fetch(req, {
      DB: {
        withSession() {
          d1Calls++;
          throw new Error('D1 must not be touched before redirect');
        },
      },
      API_RATE_LIMITER: {
        async limit() {
          limiterCalls++;
          return { success: true };
        },
      },
    }, {});
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(
      'https://epstein-files-api.protonuser597.workers.dev/api/entities/search?x=1'
    );
    expect(limiterCalls).toBe(0);
    expect(d1Calls).toBe(0);
    expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000');
  });

  test('redirects missing video and estate thumbnails to a stable placeholder', async () => {
    const env = testEnv({
      DB: {
        prepare() {
          return {
            bind() {
              return {
                async first() {
                  return { legacy_document_id: 15999, page_count: 1 };
                },
              };
            },
          };
        },
      },
      R2: { async get() { return null; } },
    });

    const video = await worker.fetch(request('/api/videos/15999/thumb'), env, {});
    expect(video.status).toBe(302);
    expect(video.headers.get('location')).toBe('https://epsteinproject.org/static/og-image-cfb5f4496123.jpg');
    expect(video.headers.get('cache-control')).toBe('public, max-age=3600');

    const estate = await worker.fetch(
      request('/api/house-oversight/thumbnail/HOUSE_OVERSIGHT_013489'),
      env,
      {},
    );
    expect(estate.status).toBe(302);
    expect(estate.headers.get('location')).toBe('https://epsteinproject.org/static/og-image-cfb5f4496123.jpg');
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

    const response = await worker.fetch(request('/api/documents/20913/file'), testEnv(env), {});
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.get('link')).toBe(
      '<https://epsteinproject.org/documents/20913>; rel=canonical'
    );
  });

  test('streams a verified House Oversight native video instead of its page scan', async () => {
    const requestedKeys = [];
    const env = {
      DB: {
        prepare() {
          return {
            bind() {
              return {
                async first() {
                  return {
                    local_path: '/archive/epstein-files/raw/house-oversight-estate/NATIVES/001/HOUSE_OVERSIGHT_026678.mov',
                    filename: 'HOUSE_OVERSIGHT_026678',
                    title: 'IMG_0642.MP4.mov',
                    data_set: 'house-oversight-estate',
                    document_type: 'video',
                    content_type: 'video/quicktime',
                    file_size: 2_504_613,
                  };
                },
              };
            },
          };
        },
      },
      R2: {
        async head(key) {
          expect(key).toBe('streaming/house-oversight/NATIVES/001/HOUSE_OVERSIGHT_026678.mp4');
          return { size: 2_513_782 };
        },
        async get(key, options) {
          requestedKeys.push(key);
          if (key.endsWith('.mov')) {
            expect(options).toBeUndefined();
            return {
              body: new Uint8Array(2_504_613),
              size: 2_504_613,
              httpMetadata: { contentType: 'video/quicktime' },
            };
          }
          expect(options.range.get('range')).toBe('bytes=1024-2047');
          return {
            body: new Uint8Array(1024),
            size: 2_513_782,
            range: { offset: 1024, length: 1024 },
            httpMetadata: { contentType: 'video/mp4' },
          };
        },
      },
    };

    const response = await worker.fetch(request('/api/documents/15999/file', {
      headers: { Range: 'bytes=1024-2047' },
    }), testEnv(env), {});

    expect(requestedKeys[0]).toBe('streaming/house-oversight/NATIVES/001/HOUSE_OVERSIGHT_026678.mp4');
    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-range')).toBe('bytes 1024-2047/2513782');

    const download = await worker.fetch(
      request('/api/documents/15999/file?download=1'),
      testEnv(env),
      {}
    );
    expect(requestedKeys[1]).toBe('house-oversight/NATIVES/001/HOUSE_OVERSIGHT_026678.mov');
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('video/quicktime');
  });

  test('validates estate playback ranges against the MP4 derivative size', async () => {
    let getCalled = false;
    const env = {
      DB: {
        prepare() {
          return {
            bind() {
              return {
                async first() {
                  return {
                    filename: 'HOUSE_OVERSIGHT_026678',
                    title: 'IMG_0642.MP4.mov',
                    data_set: 'house-oversight-estate',
                    document_type: 'video',
                    content_type: 'video/quicktime',
                    file_size: 2_504_613,
                  };
                },
              };
            },
          };
        },
      },
      R2: {
        async head() { return { size: 2_513_782 }; },
        async get(_key, options) {
          getCalled = true;
          expect(options.range.get('range')).toBe('bytes=2505000-2506000');
          return {
            body: new Uint8Array(1001),
            size: 2_513_782,
            range: { offset: 2_505_000, length: 1001 },
            httpMetadata: { contentType: 'video/mp4' },
          };
        },
      },
    };

    const response = await worker.fetch(request('/api/documents/15999/file?stream=1', {
      headers: { Range: 'bytes=2505000-2506000' },
    }), testEnv(env), {});

    expect(getCalled).toBe(true);
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 2505000-2506000/2513782');
  });

  test('uses the native R2 size for a ranged estate download when D1 size is unknown', async () => {
    let getCalled = false;
    const response = await worker.fetch(
      request('/api/documents/15999/file?download=1', {
        headers: { Range: 'bytes=200-' },
      }),
      testEnv({
        DB: {
          prepare() {
            return {
              bind() {
                return {
                  async first() {
                    return {
                      filename: 'HOUSE_OVERSIGHT_026678',
                      title: 'IMG_0642.MP4.mov',
                      data_set: 'house-oversight-estate',
                      document_type: 'video',
                      content_type: 'video/quicktime',
                      file_size: null,
                    };
                  },
                };
              },
            };
          },
        },
        R2: {
          async head(key) {
            expect(key).toBe('house-oversight/NATIVES/001/HOUSE_OVERSIGHT_026678.mov');
            return { size: 100 };
          },
          async get() {
            getCalled = true;
            return null;
          },
        },
      }),
      {}
    );

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */100');
    expect(getCalled).toBe(false);
  });

  test('returns authoritative 416 for an unsatisfiable scan-only document alias range', async () => {
    let getCalled = false;
    const response = await worker.fetch(
      request('/api/documents/42/file', {
        headers: { Range: 'bytes=200-' },
      }),
      testEnv({
        DB: {
          prepare() {
            return {
              bind() {
                return {
                  async first() {
                    return {
                      filename: 'HOUSE_OVERSIGHT_010477',
                      title: 'HOUSE_OVERSIGHT_010477',
                      data_set: 'house-oversight-estate',
                      document_type: 'image',
                      content_type: 'image/jpeg',
                      file_size: 100,
                    };
                  },
                };
              },
            };
          },
        },
        R2: {
          async head(key) {
            expect(key).toBe('house-oversight/IMAGES/001/HOUSE_OVERSIGHT_010477.jpg');
            return { size: 100 };
          },
          async get() {
            getCalled = true;
            return null;
          },
        },
      }),
      {}
    );

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */100');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(getCalled).toBe(false);
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

    const missing = await worker.fetch(request('/api/documents/88/file'), testEnv(env), {});
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'File not available' });
    expect(missing.headers.get('cache-control')).toBe('no-store');

    storedObject = { body: new Uint8Array(), size: 0 };
    const empty = await worker.fetch(request('/api/documents/88/file'), testEnv(env), {});
    expect(empty.status).toBe(502);
    expect(await empty.json()).toEqual({ error: 'File is empty' });
    expect(empty.headers.get('cache-control')).toBe('no-store');
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
        async get(key, options) {
          expect(key).toBe('streaming/raw/house-oversight-doj/DOJ-OGR-00022168.mp4');
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
    }), testEnv(env), {});

    expect(getOptions.range.get('range')).toBe('bytes=0-1023');
    expect(response.status).toBe(206);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBe('bytes 0-1023/20955328421');
    expect(response.headers.get('content-length')).toBe('1024');
    expect(response.headers.get('link')).toContain('/documents/22425');
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
    }), testEnv(env), {});

    expect(response.status).toBe(206);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('content-range')).toBe('bytes 1048576-1049599/20955328421');
    expect(response.headers.get('content-length')).toBe('1024');
    expect(gets).toEqual([
      { key: 'streaming/raw/house-oversight-doj/DOJ-OGR-00022168.mp4', range: 'bytes=1048576-1049599' },
      { key: 'raw/house-oversight-doj/DOJ-OGR-00022168.mp4', range: 'bytes=1048576-1049599' },
    ]);
  });

  test('does not treat an unknown legacy video size as a zero-byte object', async () => {
    let requestedRange;
    const env = {
      DB: {
        prepare() {
          return {
            bind() {
              return {
                async first() {
                  return {
                    local_path: '/archive/epstein-files/extracted/data-set-8/EFTA00028842.mp4',
                    filename: 'EFTA00028842.mp4',
                    title: 'EFTA00028842',
                    data_set: 'data-set-8',
                    document_type: 'video',
                    content_type: 'video/mp4',
                    file_size: null,
                  };
                },
              };
            },
          };
        },
      },
      R2: {
        async get(key, options) {
          expect(key).toBe('streaming/extracted/data-set-8/EFTA00028842.mp4');
          requestedRange = options.range.get('range');
          return {
            body: new Uint8Array(1024),
            size: 8_388_608,
            range: { offset: 0, length: 1024 },
            httpMetadata: { contentType: 'video/mp4' },
          };
        },
      },
    };

    const response = await worker.fetch(request('/api/documents/14685/file?stream=1', {
      headers: { Range: 'bytes=0-1023' },
    }), testEnv(env), {});

    expect(requestedRange).toBe('bytes=0-1023');
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-1023/8388608');
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
        async head(key) {
          expect(key).toBe('streaming/raw/house-oversight-doj/DOJ-OGR-00022168.mp4');
          return { size: 20_955_328_421 };
        },
      },
    };

    const response = await worker.fetch(request('/api/documents/22425/file', {
      headers: { Range: 'bytes=20955328421-' },
    }), testEnv(env), {});

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */20955328421');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'Requested range is not satisfiable' });
  });

  test('keeps ordinary whole-video playback behind the Worker', async () => {
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
        async get(key) {
          expect(key).toBe('streaming/raw/video.mp4');
          return {
            body: new Uint8Array(1234),
            size: 1234,
            httpMetadata: { contentType: 'video/mp4' },
          };
        },
      },
    };

    const response = await worker.fetch(request('/api/documents/7/file'), testEnv(env), {});
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('content-length')).toBe('1234');
    expect(response.headers.get('link')).toContain('/documents/7');
  });

  test('keeps an initial browser metadata request on the Worker in streaming mode', async () => {
    const gets = [];
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
                    file_size: 1234,
                  };
                },
              };
            },
          };
        },
      },
      R2: {
        async get(key, options) {
          gets.push({ key, options });
          if (key.startsWith('streaming/')) return null;
          return {
            body: new Uint8Array(1024 * 1024),
            size: 20_955_328_421,
            range: { offset: 0, length: 1024 * 1024 },
          };
        },
        async head() {
          throw new Error('streaming mode should use R2.get');
        },
      },
    };

    const response = await worker.fetch(request('/api/documents/7/file?stream=1'), testEnv(env), {});

    expect(response.status).toBe(206);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('content-length')).toBe('1048576');
    expect(response.headers.get('content-range')).toBe('bytes 0-1048575/20955328421');
    expect(gets.map(item => item.key)).toEqual([
      'streaming/raw/video.mp4',
      'raw/video.mp4',
    ]);
    expect(gets.every(item => item.options?.range?.offset === 0)).toBe(true);
    expect(gets.every(item => item.options?.range?.length === 1024 * 1024)).toBe(true);
  });

  test('streams faststart video through the Worker without a public-media redirect', async () => {
    const keys = [];
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
                  };
                },
              };
            },
          };
        },
      },
      R2: {
        async get(key) {
          keys.push(key);
          return {
            body: new Uint8Array([0, 1, 2, 3]),
            size: 4,
            httpMetadata: {
              contentType: 'text/html',
              cacheControl: 'public, max-age=31536000, immutable',
            },
          };
        },
      },
    };

    const response = await worker.fetch(
      request('/api/documents/22425/file'),
      testEnv(env),
      {}
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('cache-control')).toContain('max-age=60');
    expect(response.headers.get('cache-control')).not.toContain('immutable');
    expect(response.headers.get('link')).toBe(
      '<https://epsteinproject.org/documents/22425>; rel=canonical'
    );
    expect(keys).toEqual(['streaming/raw/house-oversight-doj/DOJ-OGR-00022168.mp4']);
  });

  test('bypasses stale edge media cache whenever publication exclusions are active', async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'caches');
    let cacheReads = 0;
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: {
        default: {
          async match() {
            cacheReads++;
            return new Response('stale media');
          },
        },
      },
    });

    try {
      const response = await worker.fetch(request('/api/documents/42/file'), testEnv({
        PUBLICATION_EXCLUSIONS: 'house:HOUSE_OVERSIGHT_010477',
        DB: {
          prepare() {
            return {
              bind() {
                return {
                  async first() {
                    return {
                      local_path: '/archive/epstein-files/house-oversight/file.jpg',
                      filename: 'HOUSE_OVERSIGHT_010477',
                      data_set: 'house-oversight-estate',
                    };
                  },
                };
              },
            };
          },
        },
        R2: {
          async get() {
            throw new Error('excluded media must not reach R2');
          },
        },
      }), {
        waitUntil() {
          throw new Error('excluded media must not be cached');
        },
      });
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(cacheReads).toBe(0);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'caches', previous);
      else delete globalThis.caches;
    }
  });

  test('versions private-media cache keys away from pre-policy responses', async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'caches');
    let matchedUrl;
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: {
        default: {
          async match(cacheKey) {
            matchedUrl = cacheKey.url;
            return new Response('cached image', {
              headers: {
                'Content-Type': 'image/png',
                'Cache-Control': 'public, max-age=60, s-maxage=60, must-revalidate',
              },
            });
          },
        },
      },
    });

    try {
      const response = await worker.fetch(
        request('/api/images/14672_p0_0.png'),
        testEnv(),
        { waitUntil() {} }
      );
      expect(response.status).toBe(200);
      expect(new URL(matchedUrl).searchParams.get('__ep_media_cache')).toBe('private-r2-v2');
      expect(response.headers.get('x-robots-tag')).toBe('noindex');
    } finally {
      if (previous) Object.defineProperty(globalThis, 'caches', previous);
      else delete globalThis.caches;
    }
  });

  test('rejects fabricated House page aliases before reading R2', async () => {
    let r2Reads = 0;
    const response = await worker.fetch(
      request('/api/house-oversight/page/HOUSE_OVERSIGHT_010478/0'),
      testEnv({
        DB: {
          prepare() {
            return {
              bind() {
                return { async first() { return null; } };
              },
            };
          },
        },
        R2: {
          async get() {
            r2Reads++;
            return { body: 'hidden adjacent scan' };
          },
        },
      }),
      {}
    );
    expect(response.status).toBe(404);
    expect(r2Reads).toBe(0);
  });

  test('serves an authorized House page range with its record canonical', async () => {
    const response = await worker.fetch(
      request('/api/house-oversight/page/HOUSE_OVERSIGHT_010477/1', {
        headers: { Range: 'bytes=10-19' },
      }),
      testEnv({
        DB: {
          prepare() {
            return {
              bind() {
                return {
                  async first() { return { legacy_document_id: 42, page_count: 2 }; },
                };
              },
            };
          },
        },
        R2: {
          async get(key, options) {
            expect(key).toBe('house-oversight/IMAGES/001/HOUSE_OVERSIGHT_010478.jpg');
            expect(options.range.get('range')).toBe('bytes=10-19');
            return {
              body: new Uint8Array(10),
              size: 100,
              range: { offset: 10, length: 10 },
              httpMetadata: { contentType: 'text/html' },
            };
          },
        },
      }),
      {}
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('content-range')).toBe('bytes 10-19/100');
    expect(response.headers.get('link')).toBe(
      '<https://epsteinproject.org/house-oversight/HOUSE_OVERSIGHT_010477>; rel=canonical'
    );
  });

  test('returns authoritative 416 for an unsatisfiable image range', async () => {
    let getCalled = false;
    const response = await worker.fetch(
      request('/api/images/14672_p0_0.png', {
        headers: { Range: 'bytes=256-' },
      }),
      testEnv({
        R2: {
          async head(key) {
            expect(key).toBe('images/14672_p0_0.png');
            return { size: 128 };
          },
          async get() {
            getCalled = true;
            return null;
          },
        },
      }),
      {}
    );
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */128');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(getCalled).toBe(false);
  });

  test('downloads the released video original even when streaming is also requested', async () => {
    const keys = [];
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
                    file_size: 8,
                  };
                },
              };
            },
          };
        },
      },
      R2: {
        async get(key, options) {
          keys.push({ key, options });
          if (key.startsWith('streaming/')) {
            throw new Error('downloads must never read the faststart derivative');
          }
          return {
            body: new Uint8Array(8),
            size: 8,
            httpMetadata: { contentType: 'video/mp4' },
          };
        },
      },
    };

    const response = await worker.fetch(
      request('/api/documents/7/file?download=1&stream=1'),
      testEnv(env),
      {}
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('content-length')).toBe('8');
    expect(keys).toEqual([{ key: 'raw/video.mp4', options: undefined }]);
  });

  test('validates regular playback ranges against the derivative size', async () => {
    let getCalled = false;
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
                    file_size: 20_000,
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
          return { size: 10_000 };
        },
        async get() {
          getCalled = true;
          return null;
        },
      },
    };
    const response = await worker.fetch(request('/api/documents/7/file?stream=1', {
      headers: { Range: 'bytes=15000-' },
    }), testEnv(env), {});
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */10000');
    expect(getCalled).toBe(false);
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
    const response = await worker.fetch(request('/api/search', { method: 'OPTIONS' }), testEnv(), {});
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000');
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    expect(response.headers.get('allow')).toBe('GET, OPTIONS');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
  });
  test('advertises POST only for the entity-search preflight', async () => {
    const response = await worker.fetch(
      request('/api/entities/search', { method: 'OPTIONS' }),
      testEnv(),
      {}
    );
    expect(response.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(response.headers.get('allow')).toBe('POST, OPTIONS');
  });

  test('marks successful JSON as non-cacheable and non-indexable', async () => {
    const response = await worker.fetch(request('/health'), {}, {});
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000');
  });

  test('blocks excluded direct document routes before D1 or R2 access', async () => {
    let touched = false;
    const env = testEnv({
      PUBLICATION_EXCLUSIONS: 'doc:42',
      DB: {
        prepare() {
          touched = true;
          throw new Error('must not touch D1');
        },
      },
      R2: {
        async get() {
          touched = true;
          throw new Error('must not touch R2');
        },
      },
    });
    for (const suffix of ['', '/text', '/file', '/thumbnail']) {
      const response = await worker.fetch(request('/api/documents/42' + suffix), env, {});
      expect(response.status).toBe(404);
      expect((await response.json()).error).toBe('Document not found');
    }
    for (const path of ['/api/videos/42/thumb', '/api/images/42_p0_0.png']) {
      const response = await worker.fetch(request(path), env, {});
      expect(response.status).toBe(404);
    }
    expect(touched).toBe(false);
  });

  test('blocks excluded House detail, page, and thumbnail routes before storage', async () => {
    let touched = false;
    const env = testEnv({
      PUBLICATION_EXCLUSIONS: 'house:house_oversight_010477',
      DB: {
        prepare() {
          touched = true;
          throw new Error('must not touch D1');
        },
      },
      R2: {
        async get() {
          touched = true;
          throw new Error('must not touch R2');
        },
      },
    });
    const paths = [
      '/api/house-oversight/documents/HOUSE_OVERSIGHT_010477',
      '/api/house-oversight/page/HOUSE_OVERSIGHT_010477/0',
      '/api/house-oversight/thumbnail/HOUSE_OVERSIGHT_010477',
    ];
    for (const path of paths) {
      const response = await worker.fetch(request(path), env, {});
      expect(response.status).toBe(404);
    }
    expect(touched).toBe(false);
  });

  test('fails closed on malformed publication-exclusion configuration', async () => {
    const response = await worker.fetch(request('/api/documents/42'), testEnv({
      PUBLICATION_EXCLUSIONS: 'doc:not-a-number',
    }), {});
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('accepts 80 publication exclusions and fails closed at 81', async () => {
    const eighty = Array.from({ length: 80 }, (_, index) => `doc:${index + 1}`).join(' ');
    const accepted = await worker.fetch(request('/api'), {
      PUBLICATION_EXCLUSIONS: eighty,
    }, {});
    expect(accepted.status).toBe(200);

    const rejected = await worker.fetch(request('/api'), {
      PUBLICATION_EXCLUSIONS: eighty + ' doc:81',
    }, {});
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get('retry-after')).toBe('5');
  });

  test('filters the image manifest and corrects its total', async () => {
    const { response, body } = await responseJson('/api/images?limit=50', {
      PUBLICATION_EXCLUSIONS: 'doc:12',
      R2: {
        async get(key) {
          expect(key).toBe('images/manifest.json');
          return {
            async json() {
              return {
                total_images: 3,
                images: [
                  { doc_id: 12, page: 0, filename: '12_p0_0.png' },
                  { doc_id: 13, page: 0, filename: '13_p0_0.png' },
                  { filename: 'unattributed.png' },
                ],
              };
            },
          };
        },
      },
    });
    expect(response.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.images).toEqual([
      { doc_id: 13, page: 0, filename: '13_p0_0.png' },
    ]);
  });

  test('adds bound exclusions to browse totals and rows', async () => {
    const calls = [];
    const DB = {
      prepare(sql) {
        return {
          bind(...params) {
            calls.push({ sql, params });
            return {
              async first() { return { count: 1 }; },
              async all() {
                return { results: [{ id: 13, filename: 'visible.pdf', data_set: 'court-records' }] };
              },
            };
          },
        };
      },
    };
    const { body } = await responseJson('/api/browse', {
      DB,
      PUBLICATION_EXCLUSIONS: 'doc:12 house:HOUSE_OVERSIGHT_010477',
    });
    expect(body.total).toBe(1);
    expect(body.results.map(row => row.document_id)).toEqual([13]);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.sql).toContain('documents.id NOT IN (?)');
      expect(call.sql).toContain('UPPER(documents.filename) NOT IN (?)');
      expect(call.params.slice(0, 2)).toEqual([12, 'HOUSE_OVERSIGHT_010477']);
    }
  });

  test('adds bound exclusions to FTS results and counts', async () => {
    const documentCalls = [];
    const DB = {
      prepare(sql) {
        return {
          bind(...params) {
            if (sql.includes('FROM document_fts')) documentCalls.push({ sql, params });
            return {
              async first() { return { total: 1 }; },
              async all() {
                if (sql.includes('FROM entities')) return { results: [] };
                return { results: [{ id: 13, filename: 'visible.pdf', data_set: 'court-records' }] };
              },
            };
          },
        };
      },
    };
    const { body } = await responseJson('/api/search?q=visible', {
      DB,
      PUBLICATION_EXCLUSIONS: 'doc:12 house:HOUSE_OVERSIGHT_010477',
    });
    expect(body.total).toBe(1);
    expect(body.results.map(row => row.document_id)).toEqual([13]);
    expect(body.entities).toEqual([]);
    expect(documentCalls).toHaveLength(2);
    for (const call of documentCalls) {
      expect(call.sql).toContain('d.id NOT IN (?)');
      expect(call.sql).toContain('UPPER(d.filename) NOT IN (?)');
      expect(call.params.slice(1, 3)).toEqual([12, 'HOUSE_OVERSIGHT_010477']);
    }
  });

  test('filters entity mention document sidecars with bound predicates', async () => {
    let mentionQuery;
    const DB = {
      prepare(sql) {
        return {
          bind(...params) {
            return {
              async first() { return { canonical_name: 'Example Entity' }; },
              async all() {
                mentionQuery = { sql, params };
                return { results: [{ id: 2, document_id: 13, filename: 'visible.pdf' }] };
              },
            };
          },
        };
      },
    };
    const { body } = await responseJson('/api/entities/1/mentions', {
      DB,
      PUBLICATION_EXCLUSIONS: 'doc:12',
    });
    expect(body.total_mentions).toBe(1);
    expect(body.mentions.map(row => row.document_id)).toEqual([13]);
    expect(mentionQuery.sql).toContain('d.id NOT IN (?)');
    expect(mentionQuery.params).toContain(12);
  });

  test('blocks House tokens through legacy document aliases before text or R2', async () => {
    let secondaryReads = 0;
    const env = testEnv({
      PUBLICATION_EXCLUSIONS: 'house:HOUSE_OVERSIGHT_010477',
      DB: {
        prepare(sql) {
          if (!sql.includes('FROM documents')) secondaryReads++;
          return {
            bind() {
              return {
                async first() {
                  return {
                    id: 42,
                    filename: 'HOUSE_OVERSIGHT_010477',
                    data_set: 'house-oversight-estate',
                  };
                },
              };
            },
          };
        },
      },
      R2: {
        async get() {
          secondaryReads++;
          return { body: 'must not be served' };
        },
      },
    });
    for (const suffix of ['', '/text', '/file', '/thumbnail']) {
      const response = await worker.fetch(request('/api/documents/42' + suffix), env, {});
      expect(response.status).toBe(404);
    }
    expect(secondaryReads).toBe(0);
  });

  test('blocks doc tokens through House aliases before text or R2', async () => {
    let r2Reads = 0;
    const env = testEnv({
      PUBLICATION_EXCLUSIONS: 'doc:42',
      DB: {
        prepare() {
          return {
            bind() {
              return { async first() { return { legacy_document_id: 42 }; } };
            },
          };
        },
      },
      R2: {
        async get() {
          r2Reads++;
          return { body: 'must not be served' };
        },
      },
    });
    for (const path of [
      '/api/house-oversight/documents/HOUSE_OVERSIGHT_010477',
      '/api/house-oversight/page/HOUSE_OVERSIGHT_010477/0',
      '/api/house-oversight/thumbnail/HOUSE_OVERSIGHT_010477',
    ]) {
      const response = await worker.fetch(request(path), env, {});
      expect(response.status).toBe(404);
    }
    expect(r2Reads).toBe(0);
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
