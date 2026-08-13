import { describe, expect, test } from 'bun:test';

const nginxUrl = new URL('nginx.conf', import.meta.url);

function locationBlocks(source) {
  return [...source.matchAll(/location\s+[^\{]+\{[^\}]*\}/g)].map((match) => match[0]);
}

describe('nginx response-header inheritance', () => {
  test('keeps all add_header directives at server scope', async () => {
    const nginx = await Bun.file(nginxUrl).text();
    const headers = [
      'Strict-Transport-Security',
      'X-Frame-Options',
      'X-Content-Type-Options',
      'X-XSS-Protection',
      'Referrer-Policy',
      'Content-Security-Policy',
      'Permissions-Policy',
    ];

    for (const header of headers) {
      const directives = nginx.match(new RegExp(`^\\s*add_header ${header} .+ always;$`, 'gm')) || [];
      expect(directives, `${header} must be emitted once with always`).toHaveLength(1);
    }

    expect(nginx.match(/^\s*add_header Cache-Control .+;$/gm) || []).toHaveLength(1);

    for (const location of locationBlocks(nginx)) {
      expect(location).not.toMatch(/^\s*add_header\b/m);
    }
  });

  test('sets one cache policy for static responses without hiding security headers', async () => {
    const nginx = await Bun.file(nginxUrl).text();
    const staticLocation = locationBlocks(nginx).find((block) => block.startsWith('location /static/'));

    expect(nginx).toContain('map $uri $static_asset_cache_control {');
    expect(nginx).toContain('~^/static/app-[0-9a-f]{12}\\.css$ "public, max-age=31536000, immutable";');
    expect(nginx).toContain('~^/static/ "public, max-age=86400";');
    expect(nginx).toContain('add_header Cache-Control $static_asset_cache_control;');
    expect(staticLocation).toBeDefined();
    expect(staticLocation).toContain('proxy_hide_header Cache-Control;');
    expect(staticLocation).not.toMatch(/^\s*add_header\b/m);
  });
});
