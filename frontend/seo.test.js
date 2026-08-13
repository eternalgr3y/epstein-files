import { describe, expect, test } from 'bun:test';

const frontendUrl = new URL('.', import.meta.url);
const TITLE = 'EpsteinProject.org: Search Jeffrey Epstein Case Records';
const DESCRIPTION = 'Search 22,000+ public Jeffrey Epstein records from DOJ, court, and House Oversight releases, including documents, photos, video, and audio.';
const SOCIAL_IMAGE_PATH = '/static/og-image-cfb5f4496123.jpg';
const SOCIAL_IMAGE_URL = `https://epsteinproject.org${SOCIAL_IMAGE_PATH}`;
const SOCIAL_IMAGE_ALT = 'EpsteinProject.org social card: Search 22,000+ Jeffrey Epstein case records from DOJ, court, and House Oversight releases.';

function jpegDimensions(bytes) {
  expect([...bytes.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += length;
  }
  throw new Error('JPEG dimensions not found');
}

describe('search presentation and crawl paths', () => {
  test('aligns concise homepage metadata, site name, and visible heading', async () => {
    const html = await Bun.file(new URL('index.html', frontendUrl)).text();
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain(`<meta name="title" content="${TITLE}">`);
    expect(html).toContain(`<meta name="description" content="${DESCRIPTION}">`);
    expect(html).toContain(`<meta property="og:title" content="${TITLE}">`);
    expect(html).toContain(`<meta property="og:description" content="${DESCRIPTION}">`);
    expect(html).toContain(`<meta name="twitter:title" content="${TITLE}">`);
    expect(html).toContain(`<meta name="twitter:description" content="${DESCRIPTION}">`);
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

  test('publishes one compact content-addressed social card with complete metadata', async () => {
    const html = await Bun.file(new URL('index.html', frontendUrl)).text();
    expect(html).toContain(`<meta property="og:image" content="${SOCIAL_IMAGE_URL}">`);
    expect(html).toContain(`<meta property="og:image:secure_url" content="${SOCIAL_IMAGE_URL}">`);
    expect(html).toContain('<meta property="og:image:type" content="image/jpeg">');
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta property="og:image:height" content="630">');
    expect(html).toContain(`<meta property="og:image:alt" content="${SOCIAL_IMAGE_ALT}">`);
    expect(html).toContain(`<meta name="twitter:image" content="${SOCIAL_IMAGE_URL}">`);
    expect(html).toContain(`<meta name="twitter:image:alt" content="${SOCIAL_IMAGE_ALT}">`);

    const imageFile = Bun.file(new URL(SOCIAL_IMAGE_PATH.slice(1), frontendUrl));
    expect(await imageFile.exists()).toBe(true);
    expect(imageFile.size).toBeLessThan(300_000);
    const bytes = new Uint8Array(await imageFile.arrayBuffer());
    expect(jpegDimensions(bytes)).toEqual({ width: 1200, height: 630 });
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const shortHash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 12);
    expect(SOCIAL_IMAGE_PATH).toBe(`/static/og-image-${shortHash}.jpg`);

    const headers = await Bun.file(new URL('_headers', frontendUrl)).text();
    expect(headers).toContain(`${SOCIAL_IMAGE_PATH}\n  Cache-Control: public, max-age=31536000, immutable`);
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
