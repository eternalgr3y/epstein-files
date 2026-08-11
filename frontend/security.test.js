import { describe, expect, test } from 'bun:test';
import { renderDocPage, SECURITY_HEADERS } from './functions/_lib/html.js';

const frontendUrl = new URL('.', import.meta.url);

describe('frontend browser hardening', () => {
  test('keeps executable JavaScript in an external file', async () => {
    const html = await Bun.file(new URL('index.html', frontendUrl)).text();
    expect(html).toMatch(/<script src="\/app\.js\?v=[\w-]+" defer><\/script>/);
    expect(html).not.toMatch(/\son(?:click|error|load|change|input|submit|keydown)=/i);
  });

  test('blocks script attributes without allowing arbitrary inline JavaScript', async () => {
    const html = await Bun.file(new URL('index.html', frontendUrl)).text();
    const headers = await Bun.file(new URL('_headers', frontendUrl)).text();
    const csp = headers.split('\n').find((line) => line.includes('Content-Security-Policy')) || '';
    expect(csp).toContain("script-src-attr 'none'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain('workers.dev');

    const structuredData = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    expect(structuredData).toHaveLength(2);
    for (const match of structuredData) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(match[1]));
      const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
      expect(csp).toContain(`'sha256-${hash}'`);
    }
  });

  test('uses an app.js cache key derived from the file content', async () => {
    const html = await Bun.file(new URL('index.html', frontendUrl)).text();
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(app)));
    const shortHash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 12);
    expect(html).toContain(`/app.js?v=sha256-${shortHash}`);

    const headers = await Bun.file(new URL('_headers', frontendUrl)).text();
    expect(headers).toMatch(/\/app\.js\s+Cache-Control: public, max-age=31536000, immutable/);
  });

  test('keeps shared CSP restrictions and inline hashes aligned', async () => {
    const staticHeaders = await Bun.file(new URL('_headers', frontendUrl)).text();
    const staticCsp = staticHeaders.split('\n')
      .find((line) => line.includes('Content-Security-Policy')) || '';
    const ssrCsp = SECURITY_HEADERS['content-security-policy'];
    for (const directive of [
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'self'",
      "script-src-attr 'none'",
      "form-action 'self'",
      'upgrade-insecure-requests',
    ]) {
      expect(staticCsp).toContain(directive);
      expect(ssrCsp).toContain(directive);
    }
    expect(staticCsp).toContain('https://media.epsteinproject.org');
    expect(ssrCsp).toContain('https://media.epsteinproject.org');

    const rendered = renderDocPage({
      canonicalPath: '/documents/1',
      title: 'Document 1',
      description: 'Fixture',
      bodyHtml: '<h1>Document 1</h1>',
      spaHash: 'doc/1',
    });
    const inlineScripts = [...rendered.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(inlineScripts).toHaveLength(1);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(inlineScripts[0][1]),
    );
    const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
    expect(ssrCsp).toContain(`'sha256-${hash}'`);
  });
});
