import { describe, expect, test } from 'bun:test';

const frontendUrl = new URL('.', import.meta.url);

function classList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name),
    toggle(name, force) {
      const enabled = force === undefined ? !values.has(name) : Boolean(force);
      if (enabled) values.add(name);
      else values.delete(name);
      return enabled;
    },
  };
}

function fakeElement(focusState = null) {
  const attributes = new Map();
  return {
    classList: classList(),
    dataset: {},
    hidden: false,
    innerHTML: '',
    style: {},
    textContent: '',
    addEventListener() {},
    appendChild() {},
    closest(selector) { return selector === '[data-action]' && this.dataset.action ? this : null; },
    contains() { return false; },
    focus() { if (focusState) focusState.activeElement = this; },
    hasAttribute(name) { return attributes.has(name); },
    matches() { return false; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    remove() {},
    removeAttribute(name) { attributes.delete(name); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    toggleAttribute(name, force) {
      if (force) attributes.set(name, '');
      else attributes.delete(name);
    },
  };
}

async function runApp(initialHash, fetchImpl, { mobile = false, online = true } = {}) {
  const app = await Bun.file(new URL('app.js', frontendUrl)).text();
  const documentEvents = new Map();
  const windowEvents = new Map();
  const focusState = { activeElement: null };
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement(focusState));
    return elements.get(id);
  };
  const menuButton = fakeElement(focusState);
  menuButton.dataset.action = 'toggle-menu';
  const themeButton = fakeElement(focusState);
  themeButton.querySelector = () => fakeElement(focusState);
  const logo = fakeElement(focusState);
  const main = fakeElement(focusState);
  const footer = fakeElement(focusState);
  const navLinks = Array.from({ length: 6 }, () => fakeElement(focusState));
  const slideMenu = element('slide-menu');
  slideMenu.querySelector = (selector) => selector === 'a[href]' ? navLinks[0] : null;
  slideMenu.querySelectorAll = () => navLinks;
  slideMenu.contains = (candidate) => navLinks.includes(candidate);
  const location = {
    hash: initialHash,
    origin: 'https://example.test',
    pathname: '/',
    search: '',
  };
  const history = {
    length: 2,
    pushState(_state, _unused, url) {
      const parsed = new URL(url, location.origin);
      location.hash = parsed.hash;
      location.pathname = parsed.pathname;
      location.search = parsed.search;
    },
    replaceState(_state, _unused, url) {
      this.pushState(_state, _unused, url);
    },
  };
  const document = {
    get activeElement() { return focusState.activeElement; },
    set activeElement(value) { focusState.activeElement = value; },
    body: fakeElement(focusState),
    documentElement: fakeElement(focusState),
    title: '',
    addEventListener(name, handler) {
      const handlers = documentEvents.get(name) || [];
      handlers.push(handler);
      documentEvents.set(name, handlers);
    },
    createElement() { return fakeElement(); },
    getElementById: element,
    querySelector(selector) {
      if (selector === '.menu-btn') return menuButton;
      if (selector === '[data-action="theme"]') return themeButton;
      if (selector === '.logo') return logo;
      if (selector === 'main') return main;
      if (selector === 'footer') return footer;
      return null;
    },
    querySelectorAll() { return []; },
    removeEventListener() {},
  };
  const mediaQuery = {
    matches: mobile,
    addEventListener() {},
  };
  const window = {
    history,
    innerWidth: 1280,
    addEventListener(name, handler) {
      const handlers = windowEvents.get(name) || [];
      handlers.push(handler);
      windowEvents.set(name, handlers);
    },
    matchMedia: () => mediaQuery,
    scrollTo() {},
  };

  const previous = new Map();
  const globals = {
    document,
    fetch: fetchImpl,
    history,
    HTMLImageElement: class {},
    HTMLMediaElement: { HAVE_METADATA: 1 },
    HTMLElement: class {},
    IntersectionObserver: class {},
    localStorage: { getItem: () => null, removeItem() {}, setItem() {} },
    location,
    navigator: { onLine: online },
    requestAnimationFrame: (callback) => callback(),
    window,
  };
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.prototype.hasOwnProperty.call(globalThis, name)
      ? globalThis[name] : undefined);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  try {
    new Function(app)();
    for (const handler of documentEvents.get('DOMContentLoaded') || []) handler();
    await Promise.resolve();
    return {
      elements,
      document,
      footer,
      location,
      main,
      menuButton,
      navLinks,
      slideMenu,
      click(control) {
        const event = { target: control, preventDefault() {} };
        for (const handler of documentEvents.get('click') || []) handler(event);
      },
      keydown(key, shiftKey = false) {
        let prevented = false;
        const event = {
          key,
          shiftKey,
          target: document.activeElement || fakeElement(focusState),
          preventDefault() { prevented = true; },
        };
        for (const handler of documentEvents.get('keydown') || []) handler(event);
        return prevented;
      },
      navigate(hash) {
        location.hash = hash;
        for (const handler of windowEvents.get('popstate') || []) handler();
      },
      restore() {
        for (const [name, value] of previous) {
          if (value === undefined) delete globalThis[name];
          else Object.defineProperty(globalThis, name, {
            configurable: true, writable: true, value,
          });
        }
      },
    };
  } catch (error) {
    for (const [name, value] of previous) {
      if (value === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, {
        configurable: true, writable: true, value,
      });
    }
    throw error;
  }
}

describe('frontend navigation request lifecycle', () => {
  test('aborts a delayed collection request when a newer route wins', async () => {
    let videoRequestAborted = false;
    const fetchImpl = (input, init = {}) => {
      const url = String(input);
      if (url === '/api/stats') {
        return Promise.resolve(new Response(JSON.stringify({
          total_documents: 1,
          total_entities: 1,
          total_mentions: 1,
          data_sets: [],
        }), { headers: { 'content-type': 'application/json' } }));
      }
      if (url.startsWith('/api/videos?')) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            videoRequestAborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const harness = await runApp('#videos/0', fetchImpl);
    try {
      harness.navigate('#about');
      await Promise.resolve();
      await Promise.resolve();

      expect(videoRequestAborted).toBe(true);
      expect(harness.location.hash).toBe('#about');
      expect(harness.elements.get('results-view').innerHTML).toContain('About');
      expect(harness.elements.get('results-view').innerHTML).not.toContain('Video Evidence');
    } finally {
      harness.restore();
    }
  });

  test('contains keyboard focus while the mobile drawer is open', async () => {
    const stats = new Response(JSON.stringify({
      total_documents: 1,
      total_entities: 1,
      total_mentions: 1,
      data_sets: [],
    }), { headers: { 'content-type': 'application/json' } });
    const harness = await runApp(
      '#home',
      () => Promise.resolve(stats.clone()),
      { mobile: true },
    );
    try {
      harness.click(harness.menuButton);

      expect(harness.document.activeElement).toBe(harness.navLinks[0]);
      expect(harness.main.hasAttribute('inert')).toBe(true);
      expect(harness.footer.hasAttribute('inert')).toBe(true);

      harness.document.activeElement = harness.navLinks.at(-1);
      expect(harness.keydown('Tab')).toBe(true);
      expect(harness.document.activeElement).toBe(harness.menuButton);

      expect(harness.keydown('Tab', true)).toBe(true);
      expect(harness.document.activeElement).toBe(harness.navLinks.at(-1));
    } finally {
      harness.restore();
    }
  });

  test('renders Retry-After guidance for a rate-limited collection', async () => {
    const fetchImpl = (input) => {
      const url = String(input);
      if (url === '/api/stats') {
        return Promise.resolve(new Response(JSON.stringify({ data_sets: [] }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.startsWith('/api/videos?')) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'Retry-After': '37' },
        }));
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const harness = await runApp('#videos/0', fetchImpl);
    try {
      await Bun.sleep(0);
      const html = harness.elements.get('results-view').innerHTML;
      expect(html).toContain('Request paused');
      expect(html).toContain('Try again in about 37 seconds.');
      expect(html).toContain('data-action="videos"');
    } finally {
      harness.restore();
    }
  });

  test('distinguishes an offline collection request from a server failure', async () => {
    const fetchImpl = (input) => {
      if (String(input) === '/api/stats') {
        return Promise.resolve(new Response(JSON.stringify({ data_sets: [] }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      return Promise.reject(new TypeError('Network request failed'));
    };

    const harness = await runApp('#images/0', fetchImpl, { online: false });
    try {
      await Bun.sleep(0);
      const html = harness.elements.get('results-view').innerHTML;
      expect(html).toContain('Failed to load images');
      expect(html).toContain('You appear to be offline. Reconnect and try again.');
      expect(html).toContain('data-action="images"');
    } finally {
      harness.restore();
    }
  });

  test('renders a retryable timeout state for a slow API response', async () => {
    const fetchImpl = (input) => {
      if (String(input) === '/api/stats') {
        return Promise.resolve(Response.json({ data_sets: [] }));
      }
      return Promise.reject(new DOMException('Timed out', 'TimeoutError'));
    };

    const harness = await runApp('#maxwell', fetchImpl);
    try {
      await Bun.sleep(0);
      const html = harness.elements.get('results-view').innerHTML;
      expect(html).toContain('Failed to load Maxwell recordings');
      expect(html).toContain('The archive server took too long to respond. Try again.');
      expect(html).toContain('data-action="maxwell"');
    } finally {
      harness.restore();
    }
  });

  test('offers first-page recovery instead of rendering a reversed entity range', async () => {
    const fetchImpl = (input) => {
      const url = String(input);
      if (url === '/api/stats') {
        return Promise.resolve(new Response(JSON.stringify({ data_sets: [] }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url === '/api/entities/17415') {
        return Promise.resolve(Response.json({
          canonical_name: 'Ghislaine Maxwell',
          entity_type: 'person',
          mention_count: 16_892,
        }));
      }
      if (url.startsWith('/api/entities/17415/mentions?')) {
        return Promise.resolve(Response.json({ mentions: [], total_mentions: 16_892 }));
      }
      if (url.startsWith('/api/entities/17415/co-occurrences?')) {
        return Promise.resolve(Response.json({ results: [] }));
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const harness = await runApp('#entity/17415/1000000', fetchImpl);
    try {
      await Bun.sleep(0);
      const html = harness.elements.get('results-view').innerHTML;
      expect(html).toContain('No mentions on this page');
      expect(html).toContain('data-action="entity" data-id="17415" data-offset="0"');
      expect(html).not.toContain('1000001-16892');
      expect(html).not.toContain('class="pagination"');
    } finally {
      harness.restore();
    }
  });

  test('recovers empty and unknown document collection pages explicitly', async () => {
    const statsPayload = {
      data_sets: [{ name: 'data-set-8', count: 1 }],
      total_documents: 1,
      total_entities: 1,
      total_mentions: 1,
    };
    const fetchImpl = (input) => {
      const url = String(input);
      if (url === '/api/stats') return Promise.resolve(Response.json(statsPayload));
      if (url.startsWith('/api/browse?')) {
        return Promise.resolve(Response.json({ total: 1, results: [] }));
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const empty = await runApp('#documents/50', fetchImpl);
    try {
      await Bun.sleep(0);
      const html = empty.elements.get('results-view').innerHTML;
      expect(html).toContain('No documents on this page');
      expect(html).toContain('data-action="documents" data-offset="0"');
    } finally {
      empty.restore();
    }

    const unknown = await runApp('#documents/0/not-a-release', fetchImpl);
    try {
      await Bun.sleep(0);
      const html = unknown.elements.get('results-view').innerHTML;
      expect(html).toContain('Dataset not found');
      expect(html).toContain('Browse all document sets');
      expect(html).not.toContain('All source sets</option>');
    } finally {
      unknown.restore();
    }
  });

  test('canonicalizes a stale estate document hash into the House viewer', async () => {
    const fetchImpl = (input) => {
      const url = String(input);
      if (url === '/api/stats') {
        return Promise.resolve(Response.json({ data_sets: [] }));
      }
      if (url === '/api/documents/15999') {
        return Promise.resolve(Response.json({
          id: 15999,
          filename: 'HOUSE_OVERSIGHT_026678',
          title: 'IMG_0642.MP4.mov',
          document_type: 'video',
          data_set: 'house-oversight-estate',
          content_type: 'video/quicktime',
        }));
      }
      if (url === '/api/house-oversight/documents/HOUSE_OVERSIGHT_026678') {
        return Promise.resolve(Response.json({
          bates: 'HOUSE_OVERSIGHT_026678',
          title: 'IMG_0642.MP4.mov',
          document_id: 15999,
          document_type: 'video',
          content_type: 'video/quicktime',
          playback_content_type: 'video/mp4',
          page_count: 1,
          pages: [{ url: '/api/house-oversight/page/HOUSE_OVERSIGHT_026678/0' }],
          entities: [],
        }));
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const harness = await runApp('#doc/15999', fetchImpl);
    try {
      await Bun.sleep(0);
      await Bun.sleep(0);
      const html = harness.elements.get('results-view').innerHTML;
      expect(harness.location.hash).toBe('#house-oversight/HOUSE_OVERSIGHT_026678');
      expect(html).toContain('House Oversight Document');
      expect(html).toContain('HOUSE_OVERSIGHT_026678');
      expect(html).toContain('<video controls preload="metadata"');
      expect(html).toContain('/api/documents/15999/file?stream=1');
      expect(html).toContain('type="video/mp4"');
    } finally {
      harness.restore();
    }
  });
});
