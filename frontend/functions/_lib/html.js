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
:root{color-scheme:light dark}
body{font-family:system-ui,sans-serif;max-width:760px;margin:0 auto;padding:1.5rem;line-height:1.5;color:#1a1a1a}
header{display:flex;flex-wrap:wrap;justify-content:space-between;gap:1rem;margin-bottom:2rem}
header a{font-weight:600;text-decoration:none;color:#1a1a1a}
nav{display:flex;flex-wrap:wrap;gap:0.8rem}nav a{font-size:0.85rem;font-weight:500}
dl{display:grid;grid-template-columns:auto 1fr;gap:0.25rem 1rem;margin:1rem 0}
dt{font-weight:600;color:#555}
pre{white-space:pre-wrap;background:#f5f5f5;padding:1rem;border-radius:6px;font-size:0.9rem}
.item-list{padding:0;list-style:none}.item-list li{padding:0.9rem 0;border-top:1px solid #ddd}.item-list small{display:block;color:#666;margin-top:0.2rem}
footer{margin-top:2rem;font-size:0.85rem;color:#666}
@media(prefers-color-scheme:dark){body{background:#111517;color:#e7ece9}header a{color:#e7ece9}dt,footer,.item-list small{color:#aab5b0}a{color:#8bb1c2}pre{background:#1a2023;color:#e7ece9}.item-list li{border-color:#30383b}}
</style>
</head>
<body>
<header><a href="/">Epstein Project</a><nav aria-label="Collections"><a href="/documents">Documents</a><a href="/images">Images</a><a href="/videos">Videos</a><a href="/recordings">Recordings</a><a href="/house-oversight">House Oversight</a></nav></header>
<main class="doc-page">
${bodyHtml}
${spaHash ? `<p><a href="/#${esc(spaHash)}">Open in the interactive archive →</a></p>` : ''}
</main>
<footer><p>Being mentioned in a document does not imply guilt or wrongdoing. RAINN: 1-800-656-4673</p></footer>
</body>
</html>`;
}
