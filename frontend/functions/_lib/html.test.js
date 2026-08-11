import { describe, expect, test } from 'bun:test';
import { esc, htmlResponseHeaders, PAGE_CACHE_VERSION, renderDocPage } from './html.js';

describe('crawlable page HTML helpers', () => {
  test('escapes strings and safely handles non-string values', () => {
    expect(esc('<script>')).toBe('&lt;script&gt;');
    expect(esc(42)).toBe('42');
    expect(esc(null)).toBe('');
  });

  test('sets browser security headers on Pages Function responses', () => {
    const headers = htmlResponseHeaders();
    expect(headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(headers['content-security-policy']).toContain(
      "media-src 'self' https://media.epsteinproject.org"
    );
    expect(headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(headers['x-content-type-options']).toBe('nosniff');
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
    expect(html).toContain('\\u003c/script>');
    expect(html).not.toContain('</script><script>alert(1)</script>');
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
});
