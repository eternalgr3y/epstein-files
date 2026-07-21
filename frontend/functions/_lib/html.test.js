import { describe, expect, test } from 'bun:test';
import { esc, htmlResponseHeaders, renderDocPage } from './html.js';

describe('crawlable page HTML helpers', () => {
  test('escapes strings and safely handles non-string values', () => {
    expect(esc('<script>')).toBe('&lt;script&gt;');
    expect(esc(42)).toBe('42');
    expect(esc(null)).toBe('');
  });

  test('sets browser security headers on Pages Function responses', () => {
    const headers = htmlResponseHeaders();
    expect(headers['content-security-policy']).toContain("frame-ancestors 'self'");
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
});
