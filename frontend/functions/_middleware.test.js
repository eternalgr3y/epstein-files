import { describe, expect, test } from 'bun:test';
import { canonicalPagesUrl, onRequest, pagesHostKind } from './_middleware.js';

describe('Pages host indexing middleware', () => {
  test('recognizes the production host and fails closed for every Pages hostname', () => {
    expect(pagesHostKind('epstein-chd.pages.dev')).toBe('production');
    expect(pagesHostKind('A1B2.epstein-chd.pages.dev.')).toBe('preview');
    expect(pagesHostKind('evil-epstein-chd.pages.dev')).toBe('preview');
    expect(pagesHostKind('unexpected-project.pages.dev')).toBe('preview');
    expect(pagesHostKind('pages.dev')).toBe('preview');
    expect(pagesHostKind('notpages.dev')).toBe('other');
    expect(pagesHostKind('epsteinproject.org')).toBe('other');
  });

  test('builds an apex URL without dropping the path or query string', () => {
    const request = new Request(
      'https://epstein-chd.pages.dev/documents/12?utm_source=preview&x=1'
    );
    expect(canonicalPagesUrl(request)).toBe(
      'https://epsteinproject.org/documents/12?utm_source=preview&x=1'
    );
  });

  test('redirects the production pages.dev host to the apex', async () => {
    let nextCalled = false;
    const response = await onRequest({
      request: new Request('https://epstein-chd.pages.dev/about?from=pages'),
      next: async () => {
        nextCalled = true;
        return new Response('unreachable');
      },
    });
    expect(nextCalled).toBe(false);
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe(
      'https://epsteinproject.org/about?from=pages'
    );
  });

  test('redirects preview SSR, OCR, collections, and sitemap before route code runs', async () => {
    const paths = [
      '/documents/12?preview=1',
      '/house-oversight/HOUSE_OVERSIGHT_010477',
      '/videos',
      '/recordings',
      '/images',
      '/sitemap.xml',
    ];

    for (const path of paths) {
      let nextCalled = false;
      const response = await onRequest({
        request: new Request(`https://9f5b.epstein-chd.pages.dev${path}`),
        next: async () => {
          nextCalled = true;
          return new Response('private preview body');
        },
      });

      expect(nextCalled).toBe(false);
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe(`https://epsteinproject.org${path}`);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(await response.text()).toBe('');
    }
  });

  test('fails closed on an unexpected pages.dev project hostname', async () => {
    let nextCalled = false;
    const response = await onRequest({
      request: new Request('https://renamed-project.pages.dev/sitemap.xml'),
      next: async () => {
        nextCalled = true;
        return new Response('<urlset>private record</urlset>');
      },
    });

    expect(nextCalled).toBe(false);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://epsteinproject.org/sitemap.xml'
    );
  });

  test('does not redirect or add crawler headers on the apex or localhost', async () => {
    for (const url of ['https://epsteinproject.org/', 'http://localhost:8788/']) {
      const response = await onRequest({
        request: new Request(url),
        next: async () => new Response('ok'),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('ok');
      expect(response.headers.has('x-robots-tag')).toBe(false);
    }
  });
});
