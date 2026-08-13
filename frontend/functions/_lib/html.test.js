import { describe, expect, test } from 'bun:test';
import { PAGE_CACHE_VERSION, esc, htmlResponseHeaders, notFoundResponse, renderDocPage } from './html.js';

describe('crawlable page HTML helpers', () => {
  test('escapes strings and safely handles non-string values', () => {
    expect(esc('<script>')).toBe('&lt;script&gt;');
    expect(esc(42)).toBe('42');
    expect(esc(null)).toBe('');
  });

  test('sets browser security headers on Pages Function responses', () => {
    const headers = htmlResponseHeaders();
    expect(headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(headers['content-security-policy']).toContain("media-src 'self'");
    expect(headers['content-security-policy']).not.toMatch(/media\.epsteinproject\.org|r2\.dev/);
    expect(headers['content-security-policy']).toContain("style-src 'self'");
    expect(headers['content-security-policy']).toContain("style-src-attr 'none'");
    expect(headers['content-security-policy']).not.toContain("'unsafe-inline'");
    expect(headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(headers['cache-control']).toBe(
      'public, max-age=0, s-maxage=3600, must-revalidate'
    );
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['strict-transport-security']).toContain('includeSubDomains');
    expect(headers['strict-transport-security']).not.toContain('preload');
  });

  test('escapes document metadata in rendered pages', () => {
    const html = renderDocPage({
      canonicalPath: '/documents/1',
      title: '<img src=x onerror=alert(1)>',
      description: 'safe',
      bodyHtml: '<p>trusted body</p>',
      spaHash: 'doc/1',
    });
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<title><img');
  });

  test('renders canonical navigation and safely serializes structured data', () => {
    const html = renderDocPage({
      canonicalPath: '/videos',
      title: 'Videos',
      description: 'Archive videos',
      bodyHtml: '<h1>Videos</h1>',
      spaHash: 'videos/0',
      ogType: 'website',
      structuredData: { '@type': 'CollectionPage', name: '</script><script>alert(1)</script>' },
    });
    expect(html).toContain('<link rel="canonical" href="https://epsteinproject.org/videos">');
    expect(html).toContain('<a href="/documents">Documents</a>');
    expect(html).toContain('/static/ssr.css?v=20260813-csp-hardening');
    expect(html).not.toMatch(/<style(?:\s|>)/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).toContain('\\u003c/script>');
    expect(html).not.toContain('</script><script>alert(1)</script>');
  });

  test('renders dynamic misses as noindex 404s without a homepage canonical', async () => {
    const response = notFoundResponse('Document not found');
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    expect(html).toContain('<meta name="robots" content="noindex, follow">');
    expect(html).not.toContain('<link rel="canonical"');
    expect(html).not.toContain('<meta property="og:url"');
  });

  test('describes missing media transcripts without calling them failed OCR', async () => {
    const route = await Bun.file(new URL('../documents/[id].js', import.meta.url)).text();
    expect(route).toContain("? 'No transcript available'");
    expect(route).toContain('<h2>Transcript</h2><p>No transcript has been extracted for this media file.</p>');
  });

  test('derives the Pages cache namespace from all server-rendering source', async () => {
    const files = [
      'html.js',
      'collection.js',
      '../about.js',
      '../images.js',
      '../recordings.js',
      '../videos.js',
      '../documents/index.js',
      '../documents/[id].js',
      '../documents/set/[slug].js',
      '../house-oversight/index.js',
      '../house-oversight/[bates].js',
    ];
    const contents = await Promise.all(files.map(async (file) => {
      const source = await Bun.file(new URL(file, import.meta.url)).text();
      return source.replace(
        /export const PAGE_CACHE_VERSION = '[^']+';/,
        "export const PAGE_CACHE_VERSION = '<content-hash>';",
      );
    }));
    const digest = new Uint8Array(await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(contents.join('\n--FILE--\n')),
    ));
    const shortHash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 12);
    expect(PAGE_CACHE_VERSION).toBe(`sha256-${shortHash}`);
  });

  test('keeps OCR indexable while excluding it from generated snippets', async () => {
    const routes = await Promise.all([
      Bun.file(new URL('../documents/[id].js', import.meta.url)).text(),
      Bun.file(new URL('../house-oversight/[bates].js', import.meta.url)).text(),
    ]);
    for (const route of routes) {
      expect(route).toContain('<pre data-nosnippet>');
      expect(route).not.toMatch(/description\s*=\s*preview/);
      expect(route).not.toMatch(/preview\.replace\(/);
    }
  });
});
