export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function renderDocPage({ canonicalPath, title, description, bodyHtml, spaHash }) {
  const canonical = `https://epsteinproject.org${canonicalPath}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} | Epstein Project</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<meta name="robots" content="index, follow, max-snippet:-1">
<meta property="og:type" content="article">
<meta property="og:url" content="${canonical}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:site_name" content="Epstein Project">
<style>
body{font-family:system-ui,sans-serif;max-width:760px;margin:0 auto;padding:1.5rem;line-height:1.5;color:#1a1a1a}
header a{font-weight:600;text-decoration:none;color:#1a1a1a}
dl{display:grid;grid-template-columns:auto 1fr;gap:0.25rem 1rem;margin:1rem 0}
dt{font-weight:600;color:#555}
pre{white-space:pre-wrap;background:#f5f5f5;padding:1rem;border-radius:6px;font-size:0.9rem}
footer{margin-top:2rem;font-size:0.85rem;color:#666}
</style>
</head>
<body>
<header><a href="/">Epstein Project</a></header>
<main class="doc-page">
${bodyHtml}
<p><a href="/#${spaHash}">Open in the interactive archive →</a></p>
</main>
<footer><p>Being mentioned in a document does not imply guilt or wrongdoing. RAINN: 1-800-656-4673</p></footer>
</body>
</html>`;
}
