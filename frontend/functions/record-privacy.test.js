import { describe, expect, test } from 'bun:test';
import { onRequestGet as getDocument } from './documents/[id].js';
import { onRequestGet as getHouseDocument } from './house-oversight/[bates].js';

const SENTINEL = 'PRIVATE_OCR_SENTINEL_7E3A';

function fakeCache() {
  return {
    match: async () => null,
    put: async () => undefined,
  };
}

function fakeDb(rows) {
  let index = 0;
  return {
    prepare() {
      return {
        bind() { return this; },
        async first() { return rows[index++]; },
      };
    },
  };
}

describe('record snippet privacy and emergency exclusions', () => {
  test('document OCR stays in data-nosnippet and out of the meta description', async () => {
    const response = await getDocument({
      params: { id: '12' },
      request: new Request('https://epsteinproject.org/documents/12'),
      env: {
        DB: fakeDb([
          {
            id: 12, filename: 'EFTA00000012.pdf', title: 'Released memorandum.pdf',
            data_set: 'data-set-8', document_type: 'pdf', page_count: 1,
          },
          { full_text: `${SENTINEL} searchable released text` },
          null,
          null,
        ]),
      },
      cache: fakeCache(),
      waitUntil() {},
    });
    const html = await response.text();
    const description = /<meta name="description" content="([^"]*)">/.exec(html)?.[1];
    expect(description).toContain('DOJ Data Set 8');
    expect(description).not.toContain(SENTINEL);
    expect(html).toContain(`<pre data-nosnippet>${SENTINEL}`);
  });

  test('House Oversight OCR stays in data-nosnippet and out of metadata', async () => {
    const response = await getHouseDocument({
      params: { bates: 'HOUSE_OVERSIGHT_010477' },
      request: new Request(
        'https://epsteinproject.org/house-oversight/HOUSE_OVERSIGHT_010477'
      ),
      env: {
        DB: fakeDb([
          {
            bates_number: 'HOUSE_OVERSIGHT_010477',
            legacy_document_id: 50,
            title: 'Released letter.pdf',
            page_count: 1,
            full_text: `${SENTINEL} searchable estate text`,
          },
          null,
          null,
        ]),
      },
      cache: fakeCache(),
      waitUntil() {},
    });
    const html = await response.text();
    const description = /<meta name="description" content="([^"]*)">/.exec(html)?.[1];
    expect(description).toContain('HOUSE_OVERSIGHT_010477');
    expect(description).not.toContain(SENTINEL);
    expect(html).toContain(`<pre data-nosnippet>${SENTINEL}`);
  });

  test('excluded records return a noindex 404 before any database lookup', async () => {
    const env = {
      PUBLICATION_EXCLUSIONS: 'doc:12 house:HOUSE_OVERSIGHT_010477',
      DB: { prepare: () => { throw new Error('database must not be queried'); } },
    };
    const documentResponse = await getDocument({
      params: { id: '12' },
      request: new Request('https://epsteinproject.org/documents/12'),
      env,
    });
    const houseResponse = await getHouseDocument({
      params: { bates: 'HOUSE_OVERSIGHT_010477' },
      request: new Request(
        'https://epsteinproject.org/house-oversight/HOUSE_OVERSIGHT_010477'
      ),
      env,
    });
    for (const response of [documentResponse, houseResponse]) {
      expect(response.status).toBe(404);
      const html = await response.text();
      expect(html).toContain('<meta name="robots" content="noindex, follow">');
      expect(html).not.toContain('<link rel="canonical"');
    }
  });

  test('an active exclusion policy bypasses cached detail HTML', async () => {
    let cacheTouched = false;
    const response = await getDocument({
      params: { id: '13' },
      request: new Request('https://epsteinproject.org/documents/13'),
      env: {
        PUBLICATION_EXCLUSIONS: 'doc:12',
        DB: fakeDb([
          {
            id: 13, filename: 'EFTA00000013.pdf', title: 'Allowed record.pdf',
            data_set: 'data-set-8', document_type: 'pdf', page_count: 1,
          },
          { full_text: 'Allowed searchable text' },
          null,
          null,
        ]),
      },
      cache: {
        async match() {
          cacheTouched = true;
          return new Response('stale cached detail');
        },
        async put() {
          cacheTouched = true;
        },
      },
      waitUntil() {
        cacheTouched = true;
      },
    });
    expect(cacheTouched).toBe(false);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('EFTA00000013');
  });
});
