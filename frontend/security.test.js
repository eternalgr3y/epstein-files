import { describe, expect, test } from 'bun:test';

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
});
