import { describe, expect, test } from 'bun:test';

const frontendUrl = new URL('.', import.meta.url);

describe('frontend navigation and heading semantics', () => {
  test('keeps the mobile menu button above the open drawer', async () => {
    const html = await Bun.file(new URL('index.html', frontendUrl)).text();
    expect(html).toContain('aria-controls="slide-menu"');
    expect(html).toMatch(/\.menu-btn\s*\{[\s\S]*?z-index:\s*102;/);
    expect(html).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.site-nav\s*\{[\s\S]*?z-index:\s*101;/);
    expect(html).toMatch(/\/app\.js\?v=sha256-[a-f0-9]{12}/);
  });

  test('removes the closed mobile drawer from keyboard and accessibility navigation', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    expect(app).toContain("window.matchMedia('(max-width: 768px)')");
    expect(app).toContain("slideMenu.toggleAttribute('inert', isClosedMobile)");
    expect(app).toContain("slideMenu.setAttribute('aria-hidden', String(!isOpen))");
    expect(app).toContain("mobileMenuQuery.addEventListener?.('change', syncMenuForViewport)");
    expect(app).toContain("window.addEventListener('resize', syncMenuForViewport)");
    expect(app).toContain("menuBackgroundElements.forEach(element => element.toggleAttribute('inert', isOpenMobile))");
    expect(app).toContain("...slideMenu.querySelectorAll('a[href], button:not([disabled])')");
    expect(app).toContain("else if (!focusable.includes(document.activeElement))");
  });

  test('uses one primary heading for collection and detail views', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    for (const title of ['Video Evidence', 'Maxwell Interview Recordings', 'All Documents', 'Estate Documents', 'Images']) {
      expect(app).toContain(`<h1>${title}</h1>`);
      expect(app).not.toContain(`<h2>${title}</h2>`);
    }
    expect(app.match(/<h1 class="doc-title\$\{docTitleClass\}">\$\{docTitle\}<\/h1>/g)).toHaveLength(3);
    expect(app).toContain('<h1>${esc(doc.title || doc.bates)}</h1>');
    expect(app).toContain('<h1>${esc(entity.canonical_name)}</h1>');
  });

  test('singularizes one-page document labels', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    expect(app).toContain("pages === 1 ? 'page' : 'pages'");
    expect(app).not.toMatch(/\$\{(?:d|doc)\.page_count\} pages/);
  });

  test('shows video loading and buffering status without blocking controls', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    const html = await Bun.file(new URL('index.html', frontendUrl)).text();
    expect(app).toContain('preload="metadata"');
    expect(app).toContain('data-buffering-video');
    expect(app).toContain("video.addEventListener('waiting', () => show('Buffering…'))");
    expect(app).toContain("video.addEventListener('seeking', () => show('Seeking…'))");
    expect(app).toContain("poster=\"${API}/videos/${id}/thumb\"");
    expect(html).toMatch(/\.video-buffering\s*\{[\s\S]*?pointer-events:\s*none;/);
  });

  test('renders missing hash-routed documents as not found records', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    expect(app).toContain('fetchForView(navigationId, `${API}/documents/${id}`).then(readApiJson)');
    expect(app).toContain("const notFound = e?.status === 404");
    expect(app).toContain('<h1 class="page-title">Document not found</h1>');
    expect(app).toContain('data-action="documents">Browse the document index</button>');
  });

  test('keeps a labelled search form visible on result and error views', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    expect(app).toContain('function renderSearchForm(query)');
    expect(app).toContain('for="results-q">Search the archive</label>');
    expect(app).toContain('${renderSearchForm(query)}');
    expect(app).toContain('${renderSearchForm(q)}');
    expect(app).toContain("event.target.closest('[data-search-form]')");
    expect(app).toContain("describeApiError(err, 'Search failed', { rateLimitTitle: 'Search paused' })");
    expect(app).toContain("if (error?.status === 429)");
    expect(app).toContain("if (error?.name === 'TimeoutError')");
    expect(app).toContain("if (navigator.onLine === false)");
    expect(app).toContain("Try again in about ${error.retryAfter} seconds.");
    expect(app).toContain('if (seq === searchSeq) isLoading = false;');
    expect(app).toContain("if (view !== 'search' && isLoading)");
    expect(app).not.toContain('Your search terms are still in the box above.');
  });

  test('exposes the extracted-text disclosure target and state', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    expect(app).toContain('aria-controls="text-view" aria-expanded="false">Show text</button>');
    expect(app).toContain("button.setAttribute('aria-expanded', String(showText))");
    expect(app).toContain("button.textContent = showText ? 'Show PDF' : 'Show text'");
  });

  test('rejects malformed and ambiguous archive hashes without throwing', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    expect(app).toContain('function decodeHashPart(value)');
    expect(app).toContain('function parseHashInteger(value');
    expect(app).toContain('function showRouteNotFound()');
    expect(app).toContain('<h1 class="page-title">Page not found</h1>');
    expect(app).not.toMatch(/decodeURIComponent\(rest\[/);
    expect(app).not.toContain('viewDoc(parseInt(param), true)');
  });

  test('announces every primary SPA collection and detail view', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    expect(app).toContain("announceView('Maxwell Interview Recordings'");
    expect(app).toContain("announceView('Images'");
    expect(app).toContain('const announceDocument = () => announceView(');
    expect(app).toContain('entity.canonical_name,');
    expect(app).toContain("announceView('About', 'About this archive and its methodology.')");
    expect(app).toContain("const BASE_TITLE = 'Epstein Project — Public Archive of Jeffrey Epstein Case Records';");
    expect(app).toContain('function goHome(skipPush = false, moveFocus = true)');
    expect(app).toContain("const heading = homeView.querySelector('h1')");
    expect(app).toContain('handleHash(true);');
  });

  test('dismisses the image dialog when history or navigation changes the view', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    expect(app).toContain('let dismissImageModal = null;');
    expect(app).toContain("dismissImageModal?.({ syncUrl: false, restoreFocus: false });");
    expect(app).toContain('if (dismissImageModal === close) dismissImageModal = null;');
    expect(app).toContain("if (view !== 'images')");
    expect(app).toContain("modalBackgroundElements.forEach(element => element.toggleAttribute('inert', true))");
    expect(app).toContain("modalBackgroundElements.forEach(element => element.toggleAttribute('inert', false))");
    expect(app).toContain("else if (!e.shiftKey && document.activeElement === last)");
    expect(app).toContain("&& slideMenu.classList.contains('open'))");
  });

  test('ignores a late video response after the user navigates elsewhere', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    expect(app).toContain('let navigationSeq = 0;');
    expect(app).toContain('navigationAbortController?.abort();');
    expect(app).toContain('function fetchForView(navigationId, input, init = {}, timeoutMs = API_TIMEOUT_MS)');
    expect(app).toContain('function isCurrentView(view, navigationId)');
    expect(app).toMatch(/async function showVideos[\s\S]*?const navigationId = setView\('videos'\);[\s\S]*?await fetchForView[\s\S]*?if \(!isCurrentView\('videos', navigationId\)\) return;/);
  });

  test('ignores a late document collection response after navigation', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    expect(app).toMatch(/async function showDocuments[\s\S]*?const navigationId = setView\('documents'\);[\s\S]*?await Promise\.all[\s\S]*?if \(!isCurrentView\('documents', navigationId\)\) return;/);
  });

  test('stops a document detail load from writing after navigation', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    const viewDoc = app.slice(app.indexOf('async function viewDoc'), app.indexOf('function goBack'));
    expect(viewDoc).toContain("const navigationId = setView('doc');");
    expect(viewDoc).toContain('<iframe id="pdf-iframe" src="${pdfUrl}"');
    expect(viewDoc).toContain('If the embedded preview does not load, use New Tab or Download above.');
    expect(viewDoc).not.toContain('pdfResponse.blob()');
    expect(viewDoc).not.toContain('URL.createObjectURL');
    expect((viewDoc.match(/isCurrentView\('doc', navigationId\)/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  test('explains an empty document page and offers a direct recovery', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    expect(app).toContain('<h2>No documents on this page</h2>');
    expect(app).toContain('This page is beyond the available results for the selected filters.');
    expect(app).toContain('data-action="documents" data-offset="0">Return to the first page</button>');
    expect(app).toContain('<h2>No matching documents</h2>');
    expect(app).toContain('<h2>No videos on this page</h2>');
    expect(app).toContain('<h2>No estate records on this page</h2>');
    expect(app).toContain('<h2>No images on this page</h2>');
    expect(app).toContain('<h2>No mentions on this page</h2>');
    expect(app).toContain('<h2>No documents on this results page</h2>');
    expect(app).toContain('if (mentions.mentions.length && (totalMentions > 50 || offset > 0))');
  });

  test('does not present an unknown dataset hash as an all-source filter', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    expect(app).toContain("const validDataSet = !documentFilters.dataSet");
    expect(app).toContain("'Dataset not found'");
    expect(app).toContain('The selected document source set does not exist or is no longer available.');
    expect(app).toContain('data-action="documents" data-offset="0">Browse all document sets</button>');
  });

  test('ignores a late image collection response after navigation', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    expect(app).toMatch(/async function showImages[\s\S]*?const navigationId = setView\('images'\);[\s\S]*?await fetchForView[\s\S]*?if \(!isCurrentView\('images', navigationId\)\) return;/);
  });

  test('ignores a late Maxwell collection response after navigation', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    expect(app).toMatch(/async function showMaxwellTapes[\s\S]*?const navigationId = setView\('maxwell'\);[\s\S]*?await fetchForView[\s\S]*?if \(!isCurrentView\('maxwell', navigationId\)\) return;/);
  });

  test('guards both phases of a late House Oversight collection response', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    const collection = app.slice(app.indexOf('async function showHouseOversight'), app.indexOf('async function viewHouseOversightDoc'));
    expect(collection).toContain("const navigationId = setView('house-oversight');");
    expect((collection.match(/isCurrentView\('house-oversight', navigationId\)/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  test('ignores a late House Oversight detail response after navigation', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    expect(app).toMatch(/async function viewHouseOversightDoc[\s\S]*?const navigationId = setView\('house-oversight'\);[\s\S]*?await fetchForView[\s\S]*?if \(!isCurrentView\('house-oversight', navigationId\)\) return;/);
  });

  test('ignores a late entity detail response after navigation', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    expect(app).toMatch(/async function viewEntity[\s\S]*?const navigationId = setView\('entity'\);[\s\S]*?await Promise\.all[\s\S]*?if \(!isCurrentView\('entity', navigationId\)\) return;/);
  });

  test('announces missing audio and video files after media source errors', async () => {
    const app = await Bun.file(new URL('app.js', frontendUrl)).text();
    expect(app).toContain('function initMediaFailureState()');
    expect(app).toContain("media.querySelector('source')?.addEventListener('error', showFailure)");
    expect(app).toContain('This audio file could not be loaded. Try Download or report the broken file.');
    expect(app).toContain('This video file could not be loaded. Try Download or report the broken file.');
    expect(app).toContain('data-media-error role="alert" hidden');
    expect(app).toContain('data-preview-error hidden>Preview unavailable</span>');
    expect(app).toContain("const fallback = preview.querySelector('[data-preview-error]')");
    expect(app).toContain('data-modal-image-error role="alert" hidden');
    expect(app).toContain('This image could not be loaded. Try Download Image or open its source document.');
  });
});
