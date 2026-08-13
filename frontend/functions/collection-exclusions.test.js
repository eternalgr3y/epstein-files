import { describe, expect, test } from 'bun:test';
import { onRequestGet as recordingsPage } from './recordings.js';
import { onRequestGet as videosPage } from './videos.js';

function collectionDb(rows) {
  const calls = [];
  return {
    calls,
    DB: {
      prepare(sql) {
        const call = { sql, bindings: [] };
        calls.push(call);
        const statement = {
          bind(...bindings) {
            call.bindings = bindings;
            return statement;
          },
          visibleRows() {
            const ids = sql.includes('id NOT IN')
              ? new Set(call.bindings.filter(Number.isSafeInteger))
              : new Set();
            const bates = sql.includes('UPPER(filename) NOT IN')
              ? new Set(call.bindings.filter(value => String(value).startsWith('HOUSE_OVERSIGHT_')))
              : new Set();
            return rows.filter(row => !ids.has(row.id)
              && !bates.has(String(row.filename || '').toUpperCase()));
          },
          async first() {
            return { count: statement.visibleRows().length };
          },
          async all() {
            return { results: statement.visibleRows() };
          },
        };
        return statement;
      },
    },
  };
}

const collections = [
  {
    name: 'videos',
    handler: videosPage,
    path: '/videos',
    type: 'video',
  },
  {
    name: 'recordings',
    handler: recordingsPage,
    path: '/recordings',
    type: 'audio',
  },
];

describe('SSR media collection publication exclusions', () => {
  for (const collection of collections) {
    test(`${collection.name} excludes a House token through its document alias`, async () => {
      const withdrawnTitle = `WITHDRAWN_${collection.name.toUpperCase()}_TITLE`;
      const fixture = collectionDb([
        {
          id: 12,
          filename: 'HOUSE_OVERSIGHT_010477',
          title: withdrawnTitle,
          document_type: collection.type,
          data_set: 'house-oversight-estate',
        },
        {
          id: 13,
          filename: `allowed-${collection.type}.bin`,
          title: `Allowed ${collection.name}`,
          document_type: collection.type,
          data_set: 'data-set-8',
        },
      ]);

      const response = await collection.handler({
        env: {
          DB: fixture.DB,
          PUBLICATION_EXCLUSIONS: 'house:house_oversight_010477',
        },
        request: new Request(`https://epsteinproject.org${collection.path}`),
      });
      const html = await response.text();

      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(html).not.toContain(withdrawnTitle);
      expect(html).not.toContain('HOUSE_OVERSIGHT_010477');
      expect(html).toContain(`Allowed ${collection.name}`);
      expect(fixture.calls).toHaveLength(2);
      for (const call of fixture.calls) {
        expect(call.sql).toContain('(filename IS NULL OR UPPER(filename) NOT IN (?))');
        expect(call.bindings).toContain('HOUSE_OVERSIGHT_010477');
      }
    });

    test(`${collection.name} excludes a document token symmetrically`, async () => {
      const withdrawnTitle = `WITHDRAWN_DOC_${collection.name.toUpperCase()}`;
      const fixture = collectionDb([
        {
          id: 12,
          filename: `withdrawn-${collection.type}.bin`,
          title: withdrawnTitle,
          document_type: collection.type,
          data_set: 'data-set-8',
        },
        {
          id: 13,
          filename: `allowed-${collection.type}.bin`,
          title: `Allowed ${collection.name}`,
          document_type: collection.type,
          data_set: 'data-set-8',
        },
      ]);

      const response = await collection.handler({
        env: { DB: fixture.DB, PUBLICATION_EXCLUSIONS: 'doc:12' },
        request: new Request(`https://epsteinproject.org${collection.path}`),
      });
      const html = await response.text();

      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(html).not.toContain(withdrawnTitle);
      expect(html).toContain(`Allowed ${collection.name}`);
      for (const call of fixture.calls) {
        expect(call.sql).toContain('id NOT IN (?)');
        expect(call.bindings).toContain(12);
      }
    });

    test(`${collection.name} rejects malformed policy before querying D1`, async () => {
      let queried = false;
      const invocation = collection.handler({
        env: {
          PUBLICATION_EXCLUSIONS: 'house:not-a-bates-number',
          DB: { prepare() { queried = true; throw new Error('must not query'); } },
        },
        request: new Request(`https://epsteinproject.org${collection.path}`),
      });
      await expect(invocation).rejects.toThrow('Invalid publication exclusion');
      expect(queried).toBe(false);
    });
  }
});
