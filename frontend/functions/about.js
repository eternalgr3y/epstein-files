import { htmlResponseHeaders, pageCacheKey, renderDocPage } from './_lib/html.js';

// The methodology and OCR-accuracy disclosure existed only inside app.js at
// the #about hash, so it had no crawlable URL and no way to be linked or
// cited. On an archive whose text is machine-read from degraded scans, the
// statement of how the text was produced -- and how it can be wrong -- is the
// part a reader most needs to be able to reach and quote.
//
// Copy is kept in step with showAbout() in frontend/app.js.
export async function onRequestGet(context) {
  const { request } = context;
  const cache = caches.default;
  const cacheKey = pageCacheKey(request, '/about');
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const title = 'About this archive';
  const description =
    'How the Epstein Project archive is built: sources, text extraction, '
    + 'OCR accuracy and its limits, and how to report corrections.';

  const bodyHtml = `
<article class="record">
<p class="eyebrow">Methodology</p>
<h1 class="bates">About this archive</h1>
<p class="record-title">What is here, where it came from, and how far to trust it</p>
</article>

<h2>What this is</h2>
<p>This site indexes public records from official releases of the Jeffrey
Epstein case &mdash; Department of Justice productions, court filings, and House
Oversight Committee releases &mdash; and preserves a link back to the source
material for every document.</p>

<h2>How the text is produced</h2>
<p>Where a document carries a machine-readable text layer, that text is used as
released. Image-only pages are read with optical character recognition (OCR).
Every document page states which applies and, where text was extracted, a
confidence figure.</p>

<h2>Where it can be wrong</h2>
<p>OCR misreads names, dates, handwriting, and degraded or photocopied scans.
Some documents in this archive were scanned, printed, faxed, and scanned again
before release, and the text reflects that. Government redactions also appear
in the text as noise where a black bar was read as characters.</p>
<p>A confidence figure describes how certain the character recognition was, not
whether the reading is correct. <strong>Check anything you intend to rely on
against the original page</strong>, which is linked from every document.</p>

<h2>Search coverage is not complete</h2>
<p>Search matches extracted text, so a document with no readable text cannot be
found by searching its contents &mdash; only by its Bates number or filename.
Work to extract text from the remaining scans is ongoing, and a document's page
states its current status.</p>

<h2>Names and organisations</h2>
<p>Names mentioned in the text are indexed automatically. This is imperfect:
the same person may appear under several spellings, OCR fragments produce
entries that are not really names, and similarly named people are not
distinguished. Treat the index as a way to find documents, not as a finding of
fact about anyone.</p>

<h2>Corrections</h2>
<p>Errors, missing files, and misattributions can be reported through the
feedback link in the footer. Methodology last reviewed July 2026.</p>
`;

  const response = new Response(renderDocPage({
    canonicalPath: '/about',
    title,
    description,
    bodyHtml,
    spaHash: 'about',
    ogType: 'website',
    structuredData: {
      '@context': 'https://schema.org',
      '@type': 'AboutPage',
      name: title,
      description,
      url: 'https://epsteinproject.org/about',
    },
  }), { headers: htmlResponseHeaders() });

  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
