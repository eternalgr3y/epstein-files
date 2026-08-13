const CANONICAL_ORIGIN = 'https://epsteinproject.org';
const PAGES_PRODUCTION_HOST = 'epstein-chd.pages.dev';

export function pagesHostKind(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (host === PAGES_PRODUCTION_HOST) return 'production';
  // Treat every Cloudflare Pages hostname as non-public. This deliberately
  // fails closed if the project hostname changes or Cloudflare creates a new
  // preview/deployment alias: none of those hosts may bypass publication
  // exclusions that are configured only on the production environment.
  if (host === 'pages.dev' || host.endsWith('.pages.dev')) return 'preview';
  return 'other';
}

export function canonicalPagesUrl(request) {
  const url = new URL(request.url);
  const canonical = new URL(CANONICAL_ORIGIN);
  canonical.pathname = url.pathname;
  canonical.search = url.search;
  return canonical.toString();
}

export async function onRequest({ request, next }) {
  const kind = pagesHostKind(new URL(request.url).hostname);
  if (kind === 'other') return next();

  const headers = new Headers({
    Location: canonicalPagesUrl(request),
  });
  if (kind === 'preview') {
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Robots-Tag', 'noindex, nofollow');
  }

  return new Response(null, {
    status: kind === 'production' ? 301 : 307,
    headers,
  });
}
