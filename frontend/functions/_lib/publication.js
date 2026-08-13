const MAX_CONFIG_LENGTH = 16_384;
// D1 allows at most 100 bound parameters per query. Keep enough headroom for
// route-specific filters, pagination, and policies that contain both document
// and Bates exclusions in one statement.
const MAX_EXCLUSIONS = 80;
const EMPTY_POLICY = Object.freeze({
  documentIds: Object.freeze([]),
  houseOversightBates: Object.freeze([]),
});

// Example: PUBLICATION_EXCLUSIONS="doc:123,house:HOUSE_OVERSIGHT_010477".
export function publicationPolicy(env = {}) {
  const value = env?.PUBLICATION_EXCLUSIONS;
  if (value == null || value === '') return EMPTY_POLICY;
  if (typeof value !== 'string') {
    throw new Error('PUBLICATION_EXCLUSIONS must be a string');
  }
  if (value.length > MAX_CONFIG_LENGTH) {
    throw new Error('PUBLICATION_EXCLUSIONS is too long');
  }

  const tokens = value.split(/[\s,]+/).filter(Boolean);
  if (tokens.length > MAX_EXCLUSIONS) {
    throw new Error(`PUBLICATION_EXCLUSIONS supports at most ${MAX_EXCLUSIONS} records`);
  }

  const documentIds = new Set();
  const houseOversightBates = new Set();
  for (const token of tokens) {
    const documentMatch = /^doc:(\d+)$/i.exec(token);
    if (documentMatch) {
      const id = Number(documentMatch[1]);
      if (!Number.isSafeInteger(id) || id < 1) {
        throw new Error(`Invalid publication exclusion: ${token}`);
      }
      documentIds.add(id);
      continue;
    }

    const houseMatch = /^house:(HOUSE_OVERSIGHT_\d+)$/i.exec(token);
    if (houseMatch) {
      houseOversightBates.add(houseMatch[1].toUpperCase());
      continue;
    }

    throw new Error(`Invalid publication exclusion: ${token}`);
  }

  return Object.freeze({
    documentIds: Object.freeze([...documentIds]),
    houseOversightBates: Object.freeze([...houseOversightBates]),
  });
}

export function hasPublicationExclusions(policy) {
  return policy.documentIds.length > 0 || policy.houseOversightBates.length > 0;
}

export function isDocumentExcluded(policy, id) {
  return policy.documentIds.includes(Number(id));
}

export function isHouseOversightExcluded(policy, bates) {
  return policy.houseOversightBates.includes(String(bates || '').toUpperCase());
}

export function notExcludedSql(column, values) {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(column)) {
    throw new Error('Unsafe SQL column name');
  }
  if (!values.length) return { clause: '', bindings: [] };
  return {
    clause: ` AND ${column} NOT IN (${values.map(() => '?').join(', ')})`,
    bindings: [...values],
  };
}
