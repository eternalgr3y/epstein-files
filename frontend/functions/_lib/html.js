// These pages cache their own HTML in the Cache API for an hour, keyed on path
// with the query string deliberately stripped (so "?x=" cannot force a
// full-table scan). That also means a deploy is invisible until the hour is
// up, and no amount of cache-busting on the request will help -- confirmed
// twice while shipping the sitemap and the document redesign, and the API
// token in .env has no cache-purge scope to work around it.
//
// Bumping this string changes every cache key at once, so a deploy takes
// effect immediately. Change it whenever you change what these pages render.
export const PAGE_CACHE_VERSION = '2026-07-28b';

// Build the Cache API key for a server-rendered page.
export function pageCacheKey(request, path) {
  const url = new URL(path, request.url);
  url.search = `v=${PAGE_CACHE_VERSION}`;
  return new Request(url, request);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self'; form-action 'self'; upgrade-insecure-requests",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
});

export function htmlResponseHeaders(cacheControl = 'public, max-age=3600') {
  return {
    ...SECURITY_HEADERS,
    'content-type': 'text/html;charset=UTF-8',
    'cache-control': cacheControl,
  };
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
}) {
  const canonical = `https://epsteinproject.org${canonicalPath}`;
  const structuredDataHtml = structuredData
    ? `<script type="application/ld+json">${JSON.stringify(structuredData).replace(/</g, '\\u003c')}</script>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<title>${esc(title)} | Epstein Project</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<meta name="robots" content="index, follow, max-snippet:-1">
<meta property="og:type" content="${esc(ogType)}">
<meta property="og:url" content="${canonical}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(imageUrl)}">
<meta property="og:site_name" content="Epstein Project">
<meta name="twitter:card" content="summary_large_image">
${structuredDataHtml}
<style>
/* These server-rendered pages are where all organic search traffic lands, so
   they carry no webfonts on purpose: a render-blocking third-party font
   request here would undo the Core Web Vitals work on the main app. The
   identity comes from colour, structure, and the Bates treatment instead.
   Colours mirror the SPA so a click through does not feel like a new site. */
:root{
 color-scheme:light dark;
 --paper:#eeefec;--surface:#f8f8f6;--ink:#1b1e21;--muted:#5c636a;--dim:#636970;
 --rule:rgba(27,30,33,.14);--accent:#3a5463;--stamp:#8b3a3a;
 --sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
 --serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
 --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*,*::before,*::after{box-sizing:border-box}
body{font-family:var(--sans);max-width:70rem;margin:0 auto;padding:1.5rem 1.5rem 4rem;
 line-height:1.55;color:var(--ink);background:var(--paper);
 -webkit-text-size-adjust:100%}
a{color:var(--accent)}
a:focus-visible,input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

/* Masthead: wordmark, collections, and a search field. The field matters most
   -- an arriving reader previously had no way to search from this page. */
.masthead{display:flex;flex-wrap:wrap;align-items:baseline;gap:.75rem 1.5rem;
 padding-bottom:1rem;border-bottom:1px solid var(--rule);margin-bottom:2.5rem}
.wordmark{font-family:var(--mono);font-size:.72rem;letter-spacing:.18em;
 text-transform:uppercase;text-decoration:none;color:var(--ink);font-weight:600}
.masthead nav{display:flex;flex-wrap:wrap;gap:1rem;margin-right:auto}
.masthead nav a{font-family:var(--mono);font-size:.68rem;letter-spacing:.12em;
 text-transform:uppercase;text-decoration:none;color:var(--muted)}
.masthead nav a:hover{color:var(--accent)}
.find{display:flex;gap:.4rem;flex:1 1 15rem;max-width:22rem}
.find input{flex:1;min-width:0;font:inherit;font-size:.85rem;padding:.45rem .6rem;
 color:var(--ink);background:var(--surface);border:1px solid var(--rule);border-radius:0}
.find button{font-family:var(--mono);font-size:.66rem;letter-spacing:.12em;
 text-transform:uppercase;padding:.45rem .8rem;cursor:pointer;
 color:var(--paper);background:var(--accent);border:1px solid var(--accent);border-radius:0}

/* The record head. The Bates number is the document's real name -- it is how
   these are cited in filings and by reporters -- so it is the headline, and
   the filename is demoted to a caption. */
.eyebrow{font-family:var(--mono);font-size:.66rem;letter-spacing:.18em;
 text-transform:uppercase;color:var(--stamp);margin:0 0 .6rem}
.bates{font-family:var(--mono);font-weight:500;letter-spacing:.02em;
 font-size:clamp(1.6rem,5.5vw,2.9rem);line-height:1.1;margin:0;overflow-wrap:anywhere}
.record-title{font-family:var(--serif);font-size:clamp(1.05rem,2.2vw,1.35rem);
 color:var(--muted);margin:.5rem 0 0;font-style:italic}
.record{padding-bottom:1.5rem;border-bottom:2px solid var(--stamp);margin-bottom:1.75rem}

/* Metadata as a production strip rather than a definition list. */
dl{display:flex;flex-wrap:wrap;gap:.4rem 2.5rem;margin:1.5rem 0}
dt{font-family:var(--mono);font-size:.62rem;letter-spacing:.14em;
 text-transform:uppercase;color:var(--dim);margin:0}
dd{font-family:var(--mono);font-size:.82rem;margin:.15rem 0 0}
dl>dt{flex:0 0 auto}dl>dd{flex:0 0 auto;margin-right:1.5rem}

h2{font-family:var(--mono);font-size:.68rem;letter-spacing:.16em;
 text-transform:uppercase;color:var(--dim);font-weight:600;margin:2.5rem 0 .75rem}
/* The released text, set as the photocopy it is. */
pre{white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--mono);
 font-size:.82rem;line-height:1.7;background:var(--surface);
 border:1px solid var(--rule);border-left:3px solid var(--rule);
 padding:1.5rem;margin:0;max-width:62ch}
video,audio,img{max-width:100%}
.item-list{padding:0;list-style:none;margin:0}
.item-list li{padding:1rem 0;border-top:1px solid var(--rule)}
.item-list small{display:block;color:var(--muted);margin-top:.25rem;
 font-family:var(--mono);font-size:.72rem}
/* Filenames like 01_06CF009454_Controlled_Call_from_S.G._to_Haley_R.wav have no
   UAX#14 break opportunity and pushed the body sideways on a 360px screen. */
.item-list a,.item-list small,.record-title{overflow-wrap:anywhere}
.onward{margin-top:2.5rem;padding-top:1.25rem;border-top:1px solid var(--rule)}
.onward a{font-family:var(--mono);font-size:.72rem;letter-spacing:.1em;
 text-transform:uppercase;text-decoration:none}
.onward a:hover{text-decoration:underline}
footer{margin-top:3rem;font-size:.8rem;color:var(--dim)}
@media(prefers-color-scheme:dark){
 :root{--paper:#14181a;--surface:#1a1f22;--ink:#e7ece9;--muted:#9aa5a1;--dim:#7e8a86;
  --rule:rgba(231,236,233,.14);--accent:#8bb1c2;--stamp:#c07a7a}
 .find button{color:#14181a}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<header class="masthead">
<a class="wordmark" href="/">Epstein Project</a>
<nav aria-label="Collections"><a href="/documents">Documents</a><a href="/images">Images</a><a href="/videos">Videos</a><a href="/recordings">Recordings</a><a href="/house-oversight">House Oversight</a></nav>
<form class="find" action="/" method="get" role="search">
<label for="q" class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Search the archive</label>
<input id="q" name="q" type="search" placeholder="Search 22,310 documents" maxlength="200" autocomplete="off">
<button type="submit">Search</button>
</form>
</header>
<main class="doc-page">
${bodyHtml}
${spaHash ? `<p class="onward"><a href="/#${esc(spaHash)}">Open in the archive</a></p>` : ''}
</main>
<script type='module' src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "deeb9a9acadd4b9e88871189785a062e"}'></script>
</body>
</html>`;
}
