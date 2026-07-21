import { describe, expect, test } from 'bun:test';

const frontendUrl = new URL('.', import.meta.url);

describe('frontend navigation and heading semantics', () => {
  test('keeps the mobile menu button above the open drawer', async () => {
    const html = await Bun.file(new URL('index.html', frontendUrl)).text();
    expect(html).toContain('aria-controls="slide-menu"');
    expect(html).toMatch(/\.menu-btn\s*\{[\s\S]*?z-index:\s*102;/);
    expect(html).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.site-nav\s*\{[\s\S]*?z-index:\s*101;/);
  });

  test('uses one primary heading for collection and detail views', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    for (const title of ['Video Evidence', 'Maxwell Deposition Tapes', 'All Documents', 'Estate Documents', 'Images']) {
      expect(app).toContain(`<h1>${title}</h1>`);
      expect(app).not.toContain(`<h2>${title}</h2>`);
    }
    expect(app.match(/<h1 class="doc-title\$\{docTitleClass\}">\$\{docTitle\}<\/h1>/g)).toHaveLength(3);
    expect(app).toContain('<h1>${esc(doc.title || doc.bates)}</h1>');
    expect(app).toContain('<h1>${esc(entity.canonical_name)}</h1>');
  });

  test('singularizes one-page document labels', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    expect(app).toContain("pages === 1 ? 'page' : 'pages'");
    expect(app).not.toMatch(/\$\{(?:d|doc)\.page_count\} pages/);
  });

  test('shows video loading and buffering status without blocking controls', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    const html = await Bun.file(new URL('index.html', frontendUrl)).text();
    expect(app).toContain('preload="metadata"');
    expect(app).toContain('data-buffering-video');
    expect(app).toContain("video.addEventListener('waiting', () => show('Buffering…'))");
    expect(app).toContain("video.addEventListener('seeking', () => show('Seeking…'))");
    expect(app).toContain("poster=\"${API}/videos/${id}/thumb\"");
    expect(html).toMatch(/\.video-buffering\s*\{[\s\S]*?pointer-events:\s*none;/);
  });
});
