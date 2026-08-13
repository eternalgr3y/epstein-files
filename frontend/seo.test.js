import { describe, expect, test } from 'bun:test';

const frontendUrl = new URL('.', import.meta.url);
const TITLE = 'EpsteinProject.org: Search Jeffrey Epstein Case Records';
const DESCRIPTION = 'Search 22,000+ public Jeffrey Epstein records from DOJ, court, and House Oversight releases, including documents, photos, video, and audio.';

describe('search presentation and crawl paths', () => {
  test('aligns concise homepage metadata, site name, and visible heading', async () => {
    const html = await Bun.file(new URL('index.html', frontendUrl)).text();
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain(`<meta name="title" content="${TITLE}">`);
    expect(html).toContain(`<meta name="description" content="${DESCRIPTION}">`);
    expect(html).toContain(`<meta property="og:title" content="${TITLE}">`);
    expect(html).toContain(`<meta property="og:description" content="${DESCRIPTION}">`);
    expect(html).toContain(`<meta property="twitter:title" content="${TITLE}">`);
    expect(html).toContain(`<meta property="twitter:description" content="${DESCRIPTION}">`);
    expect(html).toContain('<h1>Search Jeffrey Epstein case records.</h1>');

    const objects = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map((match) => JSON.parse(match[1]));
    const website = objects.find((object) => object['@type'] === 'WebSite');
    expect(website).toEqual(expect.objectContaining({
      name: 'EpsteinProject.org',
      alternateName: ['Epstein Project', 'epsteinproject.org'],
      url: 'https://epsteinproject.org/',
      description: DESCRIPTION,
    }));
    expect(website).not.toHaveProperty('potentialAction');
  });

  test('links homepage collections to canonical crawlable indexes', async () => {
    const html = await Bun.file(new URL('index.html', frontendUrl)).text();
    for (const [href, dataSet] of [
      ['/documents', 'source:doj-release'],
      ['/documents/set/court-records', 'court-records'],
      ['/documents/set/house-oversight-doj', 'house-oversight-doj'],
      ['/documents/set/doj-disclosures', 'doj-disclosures'],
    ]) {
      expect(html).toContain(`href="${href}" data-action="documents" data-set="${dataSet}"`);
    }
    expect(html).not.toContain('href="#documents/');
  });
});
