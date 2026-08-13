import { describe, expect, test } from 'bun:test';
import {
  hasPublicationExclusions,
  isDocumentExcluded,
  isHouseOversightExcluded,
  notExcludedSql,
  publicationPolicy,
} from './publication.js';

describe('emergency publication exclusions', () => {
  test('defaults to an empty policy', () => {
    const policy = publicationPolicy();
    expect(policy.documentIds).toEqual([]);
    expect(policy.houseOversightBates).toEqual([]);
    expect(hasPublicationExclusions(policy)).toBe(false);
  });

  test('parses, normalizes, and deduplicates bounded record tokens', () => {
    const policy = publicationPolicy({
      PUBLICATION_EXCLUSIONS:
        'doc:12, DOC:12\nhouse:house_oversight_010477',
    });
    expect(policy.documentIds).toEqual([12]);
    expect(policy.houseOversightBates).toEqual(['HOUSE_OVERSIGHT_010477']);
    expect(isDocumentExcluded(policy, '12')).toBe(true);
    expect(isHouseOversightExcluded(policy, 'house_oversight_010477')).toBe(true);
    expect(hasPublicationExclusions(policy)).toBe(true);
  });

  test('rejects malformed non-empty configuration instead of failing open', () => {
    expect(() => publicationPolicy({ PUBLICATION_EXCLUSIONS: 'document:12' })).toThrow();
    expect(() => publicationPolicy({ PUBLICATION_EXCLUSIONS: 'doc:0' })).toThrow();
    expect(() => publicationPolicy({ PUBLICATION_EXCLUSIONS: 12 })).toThrow();
    expect(() => publicationPolicy({
      PUBLICATION_EXCLUSIONS: 'x'.repeat(16_385),
    })).toThrow();
  });

  test('caps exclusions below the D1 bound-parameter ceiling', () => {
    const eighty = Array.from({ length: 80 }, (_, i) => `doc:${i + 1}`).join(',');
    const eightyOne = `${eighty},doc:81`;
    expect(publicationPolicy({ PUBLICATION_EXCLUSIONS: eighty }).documentIds).toHaveLength(80);
    expect(() => publicationPolicy({ PUBLICATION_EXCLUSIONS: eightyOne })).toThrow(
      'supports at most 80 records'
    );
  });

  test('builds a bound NOT IN clause and validates its identifier', () => {
    expect(notExcludedSql('d.id', [12, 34])).toEqual({
      clause: ' AND d.id NOT IN (?, ?)',
      bindings: [12, 34],
    });
    expect(notExcludedSql('d.id', [])).toEqual({ clause: '', bindings: [] });
    expect(() => notExcludedSql('id) OR 1=1 --', [12])).toThrow();
  });
});
