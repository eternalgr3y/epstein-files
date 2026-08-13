import { describe, expect, test } from 'bun:test';
import { renderDocPage, SECURITY_HEADERS } from './functions/_lib/html.js';

const frontendUrl = new URL('.', import.meta.url);

describe('frontend browser hardening', () => {
  test('keeps executable JavaScript in an external file', async () => {
    const html = await Bun.file(new URL('index.html', frontendUrl)).text();
    expect(html).toMatch(/<script src="\/app-[a-f0-9]{12}\.js" defer><\/script>/);
    expect(html).not.toMatch(/\son(?:click|error|load|change|input|submit|keydown)=/i);
  });

  test('blocks script attributes without allowing arbitrary inline JavaScript', async () => {
    const html = await Bun.file(new URL('index.html', frontendUrl)).text();
    const headers = await Bun.file(new URL('_headers', frontendUrl)).text();
    const csp = headers.split('\n').find((line) => line.includes('Content-Security-Policy')) || '';
    expect(csp).toContain("script-src-attr 'none'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain('workers.dev');

    const structuredData = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    expect(structuredData).toHaveLength(2);
    for (const match of structuredData) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(match[1]));
      const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
      expect(csp).toContain(`'sha256-${hash}'`);
    }
  });

  test('uses physical app paths derived from executable and stylesheet content', async () => {
    const html = await Bun.file(new URL('index.html', frontendUrl)).text();
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    const css = await Bun.file(new URL('static/app.css', frontendUrl)).text();
    const shortHash = async (content) => {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)));
      return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 12);
    };
    const appHash = await shortHash(app);
    const cssHash = await shortHash(css);
    expect(html).toContain(`/app-${appHash}.js`);
    expect(html).toContain(`/static/app-${cssHash}.css`);

    const redirects = await Bun.file(new URL('_redirects', frontendUrl)).text();
    expect(redirects).toContain(`/app-${appHash}.js /app.js 200`);
    expect(redirects).toContain(`/static/app-${cssHash}.css /static/app.css 200`);

    const headers = await Bun.file(new URL('_headers', frontendUrl)).text();
    expect(headers).toMatch(/\/app-\*\.js\s+Cache-Control: public, max-age=31536000, immutable/);
    expect(headers).toMatch(/\/static\/app-\*\.css\s+Cache-Control: public, max-age=31536000, immutable/);
    expect(headers).not.toMatch(/\/static\/\*\s+Cache-Control: public, max-age=31536000, immutable/);
  });

  test('keeps shared CSP restrictions and inline hashes aligned', async () => {
    const staticHeaders = await Bun.file(new URL('_headers', frontendUrl)).text();
    const staticCsp = staticHeaders.split('\n')
      .find((line) => line.includes('Content-Security-Policy')) || '';
    const ssrCsp = SECURITY_HEADERS['content-security-policy'];
    for (const directive of [
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'self'",
      "script-src-attr 'none'",
      "style-src-attr 'none'",
      "form-action 'self'",
      'upgrade-insecure-requests',
    ]) {
      expect(staticCsp).toContain(directive);
      expect(ssrCsp).toContain(directive);
    }
    for (const csp of [staticCsp, ssrCsp]) {
      expect(csp).not.toContain('media.epsteinproject.org');
      expect(csp).not.toContain('.r2.dev');
      expect(csp).not.toContain("'unsafe-inline'");
    }

    const rendered = renderDocPage({
      canonicalPath: '/documents/1',
      title: 'Document 1',
      description: 'Fixture',
      bodyHtml: '<h1>Document 1</h1>',
      spaHash: 'doc/1',
    });
    const inlineScripts = [...rendered.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(inlineScripts).toHaveLength(1);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(inlineScripts[0][1]),
    );
    const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
    expect(ssrCsp).toContain(`'sha256-${hash}'`);
  });

  test('serves every production stylesheet externally and blocks style attributes', async () => {
    const rootUrl = new URL('..', frontendUrl);
    const [index, notFound, socialCard, app, htmlHelper, documentRoute, headers, nginx, legacyApi] = await Promise.all([
      Bun.file(new URL('index.html', frontendUrl)).text(),
      Bun.file(new URL('404.html', frontendUrl)).text(),
      Bun.file(new URL('og-image.html', frontendUrl)).text(),
      Bun.file(new URL('app.js', frontendUrl)).text(),
      Bun.file(new URL('functions/_lib/html.js', frontendUrl)).text(),
      Bun.file(new URL('functions/documents/[id].js', frontendUrl)).text(),
      Bun.file(new URL('_headers', frontendUrl)).text(),
      Bun.file(new URL('nginx/nginx.conf', rootUrl)).text(),
      Bun.file(new URL('src/api.py', rootUrl)).text(),
    ]);

    for (const source of [index, notFound, socialCard, app, htmlHelper, documentRoute]) {
      expect(source).not.toMatch(/<style(?:\s|>)/i);
      expect(source).not.toMatch(/\sstyle\s*=/i);
      expect(source).not.toMatch(/\.style\s*[.[]/);
    }

    expect(index).toMatch(/\/static\/app-[a-f0-9]{12}\.css/);
    expect(notFound).toContain('/static/not-found.css?v=20260813-csp-hardening');
    expect(socialCard).toContain('href="static/og-image.css"');
    expect(htmlHelper).toContain('/static/ssr.css?v=20260813-csp-hardening');
    expect(legacyApi).toContain('StaticFiles(directory=str(FRONTEND_DIR / "static"))');

    const staticCsp = headers.split('\n').find((line) => line.includes('Content-Security-Policy')) || '';
    const nginxCsp = nginx.split('\n').find((line) => line.includes('Content-Security-Policy')) || '';
    for (const csp of [staticCsp, nginxCsp]) {
      expect(csp).toContain("style-src 'self'");
      expect(csp).toContain("style-src-attr 'none'");
      expect(csp).not.toContain("'unsafe-inline'");
    }
    for (const hash of staticCsp.match(/'sha256-[^']+'/g) || []) {
      expect(nginxCsp).toContain(hash);
    }
    expect(nginx).toContain('server_name epsteinproject.org www.epsteinproject.org;');
    expect(nginx).toContain('/etc/letsencrypt/live/epsteinproject.org/fullchain.pem');
    expect(nginx).not.toContain('epsteinfiles.org');

    for (const name of ['app.css', 'not-found.css', 'og-image.css', 'ssr.css']) {
      expect((await Bun.file(new URL(`static/${name}`, frontendUrl)).text()).length).toBeGreaterThan(500);
    }
  });

  test('keeps HSTS durable without opting the domains into the preload list', async () => {
    const rootUrl = new URL('..', frontendUrl);
    const [headers, helper, worker, nginx] = await Promise.all([
      Bun.file(new URL('_headers', frontendUrl)).text(),
      Bun.file(new URL('functions/_lib/html.js', frontendUrl)).text(),
      Bun.file(new URL('src/worker.js', rootUrl)).text(),
      Bun.file(new URL('nginx/nginx.conf', rootUrl)).text(),
    ]);
    for (const source of [headers, helper, worker, nginx]) {
      const hsts = source.split('\n').find((line) => /strict-transport-security/i.test(line)) || '';
      expect(hsts).toMatch(/max-age=(?:31536000|63072000)/);
      expect(hsts).toContain('includeSubDomains');
      expect(hsts.toLowerCase()).not.toContain('preload');
    }
  });

  test('allowlists media source MIME types before inserting them into markup', async () => {
    const script = await Bun.file(new URL('app.js', frontendUrl)).text();
    expect(script).toContain('function safeMediaType(value, kind)');
    expect(script).toContain("safeMediaType(doc.content_type, 'audio')");
    expect(script).toContain("safeMediaType(doc.content_type, 'video')");
    expect(script).not.toContain("type=\"${doc.content_type");

    const helper = Function(
      'const AUDIO_MIME_TYPES = new Set(["audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav"]);'
      + 'const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);'
      + `${script.match(/function safeMediaType\(value, kind\) \{[\s\S]*?\n    \}/)[0]};`
      + 'return safeMediaType;'
    )();
    const payload = 'video/mp4\" onerror=\"alert(1)';
    const rendered = `<source type="${helper(payload, 'video')}">`;
    expect(rendered).toBe('<source type="video/mp4">');
    expect(rendered).not.toContain('onerror');
    expect(helper(' AUDIO/MPEG; codecs=mp3 ', 'audio')).toBe('audio/mpeg');
  });

  test('keeps every browser media path on the policy-aware same-origin API', async () => {
    const rootUrl = new URL('..', frontendUrl);
    const runtimeFiles = await Promise.all([
      Bun.file(new URL('_headers', frontendUrl)).text(),
      Bun.file(new URL('functions/_lib/html.js', frontendUrl)).text(),
      Bun.file(new URL('src/worker.js', rootUrl)).text(),
      Bun.file(new URL('src/api.py', rootUrl)).text(),
      Bun.file(new URL('src/config.py', rootUrl)).text(),
      Bun.file(new URL('nginx/nginx.conf', rootUrl)).text(),
    ]);
    const retiredFlyConfig = Bun.file(new URL('fly.toml', rootUrl));
    if (await retiredFlyConfig.exists()) {
      runtimeFiles.push(await retiredFlyConfig.text());
    }
    for (const runtime of runtimeFiles) {
      expect(runtime).not.toMatch(/media\.epsteinproject\.org|\.r2\.dev|R2_PUBLIC_URL/);
    }

    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    const documentRoute = await Bun.file(
      new URL('functions/documents/[id].js', frontendUrl)
    ).text();
    for (const source of [app, documentRoute]) {
      expect(source).toContain('/documents/${id}/file');
      expect(source).not.toContain('media.epsteinproject.org');
    }
    expect(app).toContain('/file?stream=1&delivery=private-worker-v1');
    expect(documentRoute).toContain("?stream=1&delivery=private-worker-v1");
  });
});
