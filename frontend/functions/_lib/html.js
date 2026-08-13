// These pages cache their own HTML in the Cache API for an hour, keyed on path
// with the query string deliberately stripped (so "?x=" cannot force a
// full-table scan). That also means a deploy is invisible until the hour is
// up, and no amount of cache-busting on the request will help -- confirmed
// twice while shipping the sitemap and the document redesign, and the API
// token in .env has no cache-purge scope to work around it.
//
// Bumping this string changes every cache key at once, so a deploy takes
// effect immediately. Change it whenever you change what these pages render.
export const PAGE_CACHE_VERSION = 'sha256-72eca63dbb1e';

// Build the Cache API key for a server-rendered page.
export function pageCacheKey(request, path) {
  const url = new URL(path, request.url);
  url.search = `v=${PAGE_CACHE_VERSION}`;
  return new Request(url, request);
}

// The SPA has had DATA_SET_LABELS since the beginning, but the server-rendered
// pages had no equivalent, so raw slugs reached readers -- and, worse, reached
// Google: a text-less document's meta description read "pdf from data-set-5.",
// which is the SERP snippet. Mirrors DATA_SET_LABELS in frontend/app.js; keep
// the two in step.
const DATA_SET_LABELS = {
  'data-set': 'DOJ Data Set 1',
  'data-set-2': 'DOJ Data Set 2',
  'data-set-3': 'DOJ Data Set 3',
  'data-set-4': 'DOJ Data Set 4',
  'data-set-5': 'DOJ Data Set 5',
  'data-set-6': 'DOJ Data Set 6',
  'data-set-7': 'DOJ Data Set 7',
  'data-set-8': 'DOJ Data Set 8',
  'Data Set 8': 'DOJ Data Set 8',
  'court-records': 'Court Records',
  'doj-disclosures': 'DOJ Disclosures',
  'house-oversight-doj': 'House Oversight (DOJ)',
  'house-oversight-estate': 'House Oversight (Estate)',
  'maxwell-interview': 'Maxwell Interview',
};

export function setLabel(name) {
  return DATA_SET_LABELS[name] || name;
}


// house-oversight-doj rows carry the original upload filename in `title` while
// `filename` holds the real Bates number -- e.g. title
// "20250115134822946_Certificate of Service.pdf", filename
// "DOJ-OGR-00000001". Discarding the title would throw away the only human
// description these 1,657 documents have; using it raw puts an upload
// timestamp in the page title. Strip the machinery and keep the words.
//
// Returns '' when nothing meaningful survives, so callers can fall back.
export function cleanDocTitle(raw) {
  const text = String(raw || '')
    .replace(/\.[a-z0-9]{2,4}$/i, '')       // trailing extension
    .replace(/^\d{6,}[_-]\s*/, '')          // leading upload timestamp
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Reject anything that is mostly digits or punctuation: Bates numbers,
  // scanner artefacts and OCR sludge make worse titles than none.
  const letters = (text.match(/[a-z]/gi) || []).length;
  if (text.length < 4 || letters < text.length * 0.4) return '';
  return text;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; script-src 'self' 'sha256-bYsn7nsGP7uuXfrf/dG7upexhfvmAGHpMI8+IRI8cEs=' https://static.cloudflareinsights.com; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; img-src 'self' data:; media-src 'self'; connect-src 'self' https://cloudflareinsights.com; form-action 'self'; upgrade-insecure-requests",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
});

export function htmlResponseHeaders(
  cacheControl = 'public, max-age=0, s-maxage=3600, must-revalidate'
) {
  return {
    ...SECURITY_HEADERS,
    'content-type': 'text/html;charset=UTF-8',
    'cache-control': cacheControl,
  };
}

// A plain-text 404 is a dead end for a reader arriving from a search result
// or a stale link, and those arrivals are this site's main traffic. Render
// the full shell — masthead, search field, footer — so a miss is a fork in
// the road instead of a wall. The 404 status keeps crawlers away on its own;
// no-store keeps browsers and the SSR cache from holding onto it.
export function notFoundResponse(heading = 'Record not found') {
  const html = renderDocPage({
    canonicalPath: null,
    title: heading,
    description: 'This record is not in the archive.',
    bodyHtml: `
<article class="record">
<p class="eyebrow">Not in the archive</p>
<h1 class="bates">${esc(heading)}</h1>
</article>
<p>There is no record at this address. It may have been renumbered, or the link may be mistyped. The search above covers the full archive.</p>
<p class="onward"><a href="/documents">Browse the document index</a></p>`,
    spaHash: null,
    robots: 'noindex, follow',
  });
  return new Response(html, {
    status: 404,
    headers: htmlResponseHeaders('no-store'),
  });
}

export function renderDocPage({
  canonicalPath,
  title,
  description,
  bodyHtml,
  spaHash,
  ogType = 'article',
  imageUrl = 'https://epsteinproject.org/og-image.png',
  structuredData = null,
  robots = 'index, follow, max-snippet:-1',
}) {
  const canonical = canonicalPath ? `https://epsteinproject.org${canonicalPath}` : null;
  const canonicalHtml = canonical
    ? `<link rel="canonical" href="${canonical}">`
    : '';
  const openGraphUrlHtml = canonical
    ? `<meta property="og:url" content="${canonical}">`
    : '';
  const structuredDataHtml = structuredData
    ? `<script type="application/ld+json">${JSON.stringify(structuredData).replace(/</g, '\\u003c')}</script>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<script>(function(){var d=document.documentElement,K='epstein-project-theme';function g(){try{var v=localStorage.getItem(K);return v==='light'||v==='dark'?v:'auto'}catch(e){return'auto'}}function a(t){t==='auto'?d.removeAttribute('data-theme'):d.setAttribute('data-theme',t);var b=document.querySelector('[data-action=theme]');if(b){var l=b.querySelector('[data-theme-label]');if(l)l.textContent=t[0].toUpperCase()+t.slice(1);b.setAttribute('aria-label','Color theme: '+t+'. Activate to change.')}}a(g());addEventListener('DOMContentLoaded',function(){a(g());var b=document.querySelector('[data-action=theme]');if(b)b.addEventListener('click',function(){var c=g(),n=c==='auto'?'light':c==='light'?'dark':'auto';try{n==='auto'?localStorage.removeItem(K):localStorage.setItem(K,n)}catch(e){}a(n)})})})();</script>
<title>${esc(title)} | Epstein Project</title>
<meta name="description" content="${esc(description)}">
${canonicalHtml}
<meta name="robots" content="${esc(robots)}">
<meta property="og:type" content="${esc(ogType)}">
${openGraphUrlHtml}
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(imageUrl)}">
<meta property="og:site_name" content="Epstein Project">
<meta name="twitter:card" content="summary_large_image">
${structuredDataHtml}
<link rel="stylesheet" href="/static/ssr.css?v=20260813-csp-hardening">
</head>
<body>
<header class="masthead">
<a class="wordmark" href="/">Epstein<span>Project</span>.org</a>
<nav aria-label="Collections"><a href="/documents">Documents</a><a href="/house-oversight">House Oversight</a><a href="/images">Images</a><a href="/videos">Videos</a><a href="/recordings">Recordings</a><a href="/about">About</a></nav>
<form class="find" action="/" method="get" role="search">
<label for="q" class="sr-only">Search the archive</label>
<input id="q" name="q" type="search" placeholder="Search the archive" maxlength="200" autocomplete="off">
<button type="submit">Search</button>
</form>
<button class="theme-btn" type="button" data-action="theme" aria-label="Color theme: auto. Activate to change.">Theme: <span data-theme-label>Auto</span></button>
</header>
<main class="doc-page">
${bodyHtml}
${spaHash ? `<p class="onward"><a href="/#${esc(spaHash)}">Open in the archive</a></p>` : ''}
</main>
<footer>
<a href="/about">About &amp; methodology</a> &nbsp;·&nbsp;
<a href="https://docs.google.com/forms/d/e/1FAIpQLSdu5whC_64CsbCUP-6wjtwGx28y0oFOVMv290bREt45O0CWJg/viewform?usp=dialog" target="_blank" rel="noopener">Report a correction</a> &nbsp;·&nbsp;
<a href="https://justice.gov/epstein" target="_blank" rel="noopener">Original source</a>
</footer>
<script type='module' src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "deeb9a9acadd4b9e88871189785a062e"}'></script>
</body>
</html>`;
}
