/**
 * Epstein Files API - Cloudflare Worker
 *
 * Provides REST API access to DOJ Epstein case documents.
 * Uses D1 for database, R2 for file storage.
 */

const R2_PUBLIC_URL = 'https://pub-440e605d59b24afeb9a9d3291bf7a927.r2.dev';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// JSON response helper
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// Error response helper
function error(message, status = 400) {
  return json({ error: message }, status);
}

// Router
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Route matching
      if (path === '/api' || path === '/api/') {
        return apiInfo();
      }

      if (path === '/api/stats') {
        return await getStats(env.DB);
      }

      if (path === '/api/search') {
        return await searchDocuments(url, env.DB);
      }

      if (path === '/api/browse') {
        return await browseDocuments(url, env.DB);
      }

      // Document routes
      const docMatch = path.match(/^\/api\/documents\/(\d+)$/);
      if (docMatch) {
        return await getDocument(parseInt(docMatch[1]), env.DB);
      }

      const docTextMatch = path.match(/^\/api\/documents\/(\d+)\/text$/);
      if (docTextMatch) {
        return await getDocumentText(parseInt(docTextMatch[1]), url, env.DB);
      }

      const docFileMatch = path.match(/^\/api\/documents\/(\d+)\/file$/);
      if (docFileMatch) {
        return await getDocumentFile(parseInt(docFileMatch[1]), env.DB);
      }

      const docThumbMatch = path.match(/^\/api\/documents\/(\d+)\/thumbnail$/);
      if (docThumbMatch) {
        return await getDocumentThumbnail(parseInt(docThumbMatch[1]), env.DB);
      }

      // Video routes
      if (path === '/api/videos') {
        return await listVideos(url, env.DB);
      }

      const videoThumbMatch = path.match(/^\/api\/videos\/(\d+)\/thumb$/);
      if (videoThumbMatch) {
        return await getVideoThumbnail(parseInt(videoThumbMatch[1]), env.DB);
      }

      // Maxwell tapes
      if (path === '/api/maxwell-tapes') {
        return await listMaxwellTapes(env.DB);
      }

      // Images
      if (path === '/api/images') {
        return await listImages(url, env.R2);
      }

      const imageMatch = path.match(/^\/api\/images\/([^/]+)$/);
      if (imageMatch) {
        return getImage(imageMatch[1]);
      }

      // Entity routes
      const entityMatch = path.match(/^\/api\/entities\/(\d+)$/);
      if (entityMatch) {
        return await getEntity(parseInt(entityMatch[1]), env.DB);
      }

      const entityMentionsMatch = path.match(/^\/api\/entities\/(\d+)\/mentions$/);
      if (entityMentionsMatch) {
        return await getEntityMentions(parseInt(entityMentionsMatch[1]), url, env.DB);
      }

      if (path === '/api/entities/search' && method === 'POST') {
        return await searchEntities(request, env.DB);
      }

      // Utility routes
      if (path === '/api/roles') {
        return getRoles();
      }

      if (path === '/api/document-types') {
        return await getDocumentTypes(env.DB);
      }

      if (path === '/api/data-sets') {
        return await getDataSets(env.DB);
      }

      if (path === '/health') {
        return json({ status: 'healthy' });
      }

      if (path === '/robots.txt') {
        return new Response(
          'User-agent: *\nAllow: /\nDisallow: /api/\nCrawl-delay: 10\n',
          { headers: { 'Content-Type': 'text/plain', ...corsHeaders } }
        );
      }

      // Frontend - redirect to Pages
      if (path === '/' || path === '/app') {
        // Will be served by Pages, this is fallback
        return new Response('Frontend served by Cloudflare Pages', { status: 200 });
      }

      return error('Not found', 404);

    } catch (e) {
      console.error('Worker error:', e);
      return error('Internal server error: ' + e.message, 500);
    }
  },
};

// =============================================================================
// API HANDLERS
// =============================================================================

function apiInfo() {
  return json({
    name: 'Epstein Files API',
    version: '1.0.0',
    disclaimer: 'Being mentioned in a document does NOT imply guilt. Verify claims by reading source documents.',
    survivor_resources: {
      RAINN: '1-800-656-4673',
      website: 'https://www.rainn.org',
    },
    endpoints: {
      search: '/api/search',
      documents: '/api/documents',
      entities: '/api/entities',
      stats: '/api/stats',
    },
  });
}

async function getStats(db) {
  const [docs, entities, mentions, texts] = await Promise.all([
    db.prepare('SELECT COUNT(*) as count FROM documents').first(),
    db.prepare('SELECT COUNT(*) as count FROM entities').first(),
    db.prepare('SELECT COUNT(*) as count FROM mentions').first(),
    db.prepare('SELECT COUNT(*) as count FROM document_texts').first(),
  ]);

  // Get document type counts
  const types = await db.prepare(
    'SELECT document_type, COUNT(*) as count FROM documents GROUP BY document_type'
  ).all();

  // Get data set counts
  const dataSets = await db.prepare(
    'SELECT data_set, COUNT(*) as count FROM documents WHERE data_set IS NOT NULL GROUP BY data_set'
  ).all();

  return json({
    total_documents: docs.count,
    total_entities: entities.count,
    total_mentions: mentions.count,
    documents_with_text: texts.count,
    document_types: types.results.map(r => ({ type: r.document_type, count: r.count })),
    data_sets: dataSets.results.map(r => ({ name: r.data_set, count: r.count })),
  });
}

async function searchDocuments(url, db) {
  const q = url.searchParams.get('q') || '';
  const documentType = url.searchParams.get('document_type');
  const dataSet = url.searchParams.get('data_set');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0');

  // If no query but filters, browse by filter
  if (!q && (documentType || dataSet)) {
    let sql = 'SELECT * FROM documents WHERE 1=1';
    const params = [];

    if (documentType) {
      sql += ' AND document_type = ?';
      params.push(documentType);
    }
    if (dataSet) {
      sql += ' AND data_set = ?';
      params.push(dataSet);
    }

    sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const results = await db.prepare(sql).bind(...params).all();

    return json({
      query: '',
      total_results: results.results.length,
      results: results.results.map(d => ({
        document_id: d.id,
        filename: d.filename,
        title: d.title,
        data_set: d.data_set,
        document_type: d.document_type,
        source_url: d.source_url,
        relevance_score: 1.0,
        snippet: d.title || d.filename || '',
      })),
    });
  }

  if (!q) {
    return error('Query cannot be empty', 400);
  }

  // Full-text search using FTS5
  const ftsQuery = q.replace(/[^\w\s]/g, '').split(/\s+/).join(' OR ');

  const results = await db.prepare(`
    SELECT d.id, d.filename, d.title, d.data_set, d.document_type, d.source_url,
           snippet(document_fts, 3, '<mark>', '</mark>', '...', 32) as snippet
    FROM document_fts
    JOIN documents d ON d.id = document_fts.document_id
    WHERE document_fts MATCH ?
    ${documentType ? 'AND d.document_type = ?' : ''}
    ${dataSet ? 'AND d.data_set = ?' : ''}
    ORDER BY rank
    LIMIT ? OFFSET ?
  `).bind(
    ftsQuery,
    ...(documentType ? [documentType] : []),
    ...(dataSet ? [dataSet] : []),
    limit,
    offset
  ).all();

  return json({
    query: q,
    total_results: results.results.length,
    results: results.results.map(r => ({
      document_id: r.id,
      filename: r.filename,
      title: r.title,
      data_set: r.data_set,
      document_type: r.document_type,
      source_url: r.source_url,
      relevance_score: 1.0,
      snippet: r.snippet || '',
    })),
  });
}

async function browseDocuments(url, db) {
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '24'), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0');
  const filter = url.searchParams.get('filter');
  const documentType = url.searchParams.get('document_type');

  let sql = 'SELECT * FROM documents WHERE 1=1';
  const params = [];

  if (documentType) {
    sql += ' AND document_type = ?';
    params.push(documentType);
  } else if (filter === 'photos') {
    sql += ' AND category = ?';
    params.push('photo');
  } else if (filter === 'videos') {
    sql += ' AND category = ?';
    params.push('video');
  } else if (filter === 'audio') {
    sql += ' AND category = ?';
    params.push('audio');
  } else if (filter === 'docs') {
    sql += ' AND category = ?';
    params.push('document');
  }

  // Get total
  const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as count');
  const total = await db.prepare(countSql).bind(...params).first();

  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const results = await db.prepare(sql).bind(...params).all();

  return json({
    total: total.count,
    offset,
    filter,
    results: results.results.map(d => ({
      document_id: d.id,
      filename: d.filename,
      title: d.title,
      data_set: d.data_set,
    })),
  });
}

async function getDocument(id, db) {
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first();
  if (!doc) {
    return error('Document not found', 404);
  }

  const text = await db.prepare(
    'SELECT full_text, word_count FROM document_texts WHERE document_id = ?'
  ).bind(id).first();

  return json({
    id: doc.id,
    filename: doc.filename,
    title: doc.title,
    document_type: doc.document_type,
    data_set: doc.data_set,
    category: doc.category,
    source_url: doc.source_url,
    source_page: doc.source_page,
    file_size: doc.file_size,
    file_hash: doc.file_hash,
    page_count: doc.page_count,
    has_text: !!doc.has_text,
    processing_status: doc.processing_status,
    ocr_confidence: doc.ocr_confidence,
    download_timestamp: doc.download_timestamp,
    text_preview: text?.full_text?.substring(0, 2000) || null,
    word_count: text?.word_count || 0,
  });
}

async function getDocumentText(id, url, db) {
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first();
  if (!doc) {
    return error('Document not found', 404);
  }

  const text = await db.prepare(
    'SELECT * FROM document_texts WHERE document_id = ?'
  ).bind(id).first();

  if (!text) {
    return error('No text content available', 404);
  }

  const page = url.searchParams.get('page');
  if (page !== null && text.pages_text) {
    const pages = JSON.parse(text.pages_text);
    const pageNum = parseInt(page);
    if (pageNum >= 0 && pageNum < pages.length) {
      return json({
        document_id: id,
        page: pageNum,
        total_pages: pages.length,
        text: pages[pageNum],
      });
    }
    return error('Page not found', 404);
  }

  return json({
    document_id: id,
    total_pages: text.pages_text ? JSON.parse(text.pages_text).length : 1,
    word_count: text.word_count,
    full_text: text.full_text,
  });
}

async function getDocumentFile(id, db) {
  const doc = await db.prepare('SELECT local_path FROM documents WHERE id = ?').bind(id).first();
  if (!doc) {
    return error('Document not found', 404);
  }

  // Convert local path to R2 URL
  // local_path is like /mnt/e/epstein-files/raw/...
  const pathMatch = doc.local_path.match(/epstein-files\/(.+)$/);
  if (pathMatch) {
    const r2Path = pathMatch[1];
    return Response.redirect(`${R2_PUBLIC_URL}/${r2Path}`, 302);
  }

  return error('File not available', 404);
}

async function getDocumentThumbnail(id, db) {
  const doc = await db.prepare('SELECT local_path FROM documents WHERE id = ?').bind(id).first();
  if (!doc) {
    return error('Document not found', 404);
  }

  // Try pre-generated thumbnail first
  return Response.redirect(`${R2_PUBLIC_URL}/thumbnails/${id}.jpg`, 302);
}

async function listVideos(url, db) {
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0');

  const total = await db.prepare(
    "SELECT COUNT(*) as count FROM documents WHERE document_type = 'video'"
  ).first();

  const videos = await db.prepare(
    "SELECT id, filename, title, data_set FROM documents WHERE document_type = 'video' ORDER BY id LIMIT ? OFFSET ?"
  ).bind(limit, offset).all();

  return json({
    total: total.count,
    offset,
    videos: videos.results.map(v => ({
      id: v.id,
      filename: v.filename,
      title: v.title || v.filename,
      data_set: v.data_set,
      has_thumbnail: true, // Assume all have thumbs in R2
    })),
  });
}

async function getVideoThumbnail(id, db) {
  return Response.redirect(`${R2_PUBLIC_URL}/thumbnails/${id}.jpg`, 302);
}

async function listMaxwellTapes(db) {
  const tapes = await db.prepare(
    "SELECT * FROM documents WHERE document_type = 'audio' AND data_set = 'maxwell-interview' ORDER BY filename"
  ).all();

  return json({
    total: tapes.results.length,
    description: 'Ghislaine Maxwell deposition recordings',
    tapes: tapes.results.map(t => ({
      id: t.id,
      filename: t.filename,
      title: t.title || t.filename,
      day: t.title?.includes('Day 1') ? 'Day 1' : t.title?.includes('Day 2') ? 'Day 2' : 'Unknown',
      part: t.title?.match(/Part\s*(\d+)/)?.[1] || null,
    })),
  });
}

async function listImages(url, r2) {
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '60'), 200);
  const offset = parseInt(url.searchParams.get('offset') || '0');

  // Try to get manifest from R2
  try {
    const manifest = await r2.get('images/manifest.json');
    if (manifest) {
      const data = await manifest.json();
      const images = data.images || [];
      return json({
        total: data.total_images || 0,
        offset,
        images: images.slice(offset, offset + limit),
      });
    }
  } catch (e) {
    console.error('Error loading manifest:', e);
  }

  return json({ total: 0, images: [], status: 'manifest not found' });
}

function getImage(filename) {
  // Sanitize filename
  if (filename.includes('..') || filename.includes('/')) {
    return error('Invalid filename', 400);
  }

  return Response.redirect(`${R2_PUBLIC_URL}/images/${filename}`, 302);
}

async function getEntity(id, db) {
  const entity = await db.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first();
  if (!entity) {
    return error('Entity not found', 404);
  }

  return json({
    id: entity.id,
    canonical_name: entity.canonical_name,
    entity_type: entity.entity_type,
    first_name: entity.first_name,
    last_name: entity.last_name,
    aliases: entity.aliases ? JSON.parse(entity.aliases) : null,
    description: entity.description,
    is_public_figure: !!entity.is_public_figure,
    disambiguation_notes: entity.disambiguation_notes,
    confidence: entity.confidence,
    mention_count: entity.mention_count,
    needs_review: !!entity.needs_review,
  });
}

async function getEntityMentions(entityId, url, db) {
  const role = url.searchParams.get('role');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0');

  const entity = await db.prepare('SELECT canonical_name FROM entities WHERE id = ?').bind(entityId).first();
  if (!entity) {
    return error('Entity not found', 404);
  }

  let sql = `
    SELECT m.*, d.filename, d.title, d.document_type, d.data_set
    FROM mentions m
    JOIN documents d ON d.id = m.document_id
    WHERE m.entity_id = ?
  `;
  const params = [entityId];

  if (role) {
    sql += ' AND m.role = ?';
    params.push(role);
  }

  sql += ' ORDER BY m.id LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const mentions = await db.prepare(sql).bind(...params).all();

  return json({
    entity_id: entityId,
    entity_name: entity.canonical_name,
    role_filter: role,
    total_mentions: mentions.results.length,
    disclaimer: 'Role indicates appearance in specific document, not overall characterization',
    mentions: mentions.results.map(m => ({
      id: m.id,
      document_id: m.document_id,
      filename: m.filename,
      title: m.title,
      document_type: m.document_type,
      data_set: m.data_set,
      name_as_appears: m.name_as_appears,
      role: m.role,
      role_confidence: m.role_confidence,
      page_number: m.page_number,
      context_snippet: m.context_snippet,
    })),
  });
}

async function searchEntities(request, db) {
  const body = await request.json();
  const { query, role, entity_type, limit = 50 } = body;

  if (!query) {
    return error('Query is required', 400);
  }

  let sql = 'SELECT * FROM entities WHERE canonical_name LIKE ?';
  const params = [`%${query}%`];

  if (entity_type) {
    sql += ' AND entity_type = ?';
    params.push(entity_type);
  }

  sql += ' ORDER BY mention_count DESC LIMIT ?';
  params.push(Math.min(limit, 100));

  const results = await db.prepare(sql).bind(...params).all();

  // Get mention counts by role if needed
  const entities = await Promise.all(results.results.map(async (e) => {
    const mentions = await db.prepare(
      'SELECT role, COUNT(*) as count FROM mentions WHERE entity_id = ? GROUP BY role'
    ).bind(e.id).all();

    return {
      entity_id: e.id,
      canonical_name: e.canonical_name,
      entity_type: e.entity_type,
      mention_count: e.mention_count,
      mentions: mentions.results.reduce((acc, m) => {
        acc[m.role || 'unknown'] = m.count;
        return acc;
      }, {}),
    };
  }));

  return json({
    query,
    total_results: entities.length,
    results: entities,
  });
}

function getRoles() {
  return json({
    roles: [
      { role: 'victim', description: 'Named as victim in official records' },
      { role: 'witness', description: 'Provided testimony or information' },
      { role: 'investigator', description: 'Law enforcement or prosecutor' },
      { role: 'legal_counsel', description: 'Attorney' },
      { role: 'accused', description: 'Named in indictment or allegations' },
      { role: 'associate', description: 'Business or social connection documented' },
      { role: 'mentioned', description: 'Name appears, role unclear' },
      { role: 'author', description: 'Wrote the document' },
      { role: 'recipient', description: 'Received the document' },
      { role: 'unknown', description: 'Cannot determine from context' },
    ],
    disclaimer: 'Role indicates appearance in a specific document. A person may have different roles in different documents.',
  });
}

async function getDocumentTypes(db) {
  const types = await db.prepare(
    'SELECT document_type, COUNT(*) as count FROM documents GROUP BY document_type ORDER BY count DESC'
  ).all();

  return json({
    document_types: types.results.map(t => ({
      type: t.document_type,
      count: t.count,
    })),
  });
}

async function getDataSets(db) {
  const sets = await db.prepare(
    'SELECT data_set, COUNT(*) as count FROM documents WHERE data_set IS NOT NULL GROUP BY data_set ORDER BY count DESC'
  ).all();

  return json({
    data_sets: sets.results.map(s => ({
      name: s.data_set,
      count: s.count,
    })),
  });
}
