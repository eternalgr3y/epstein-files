    const API = '/api';
    const API_BASE = API.replace(/\/api$/, '');

    // Navigation state
    let currentView = 'home';
    let currentHash = '';  // Track current hash to prevent redundant fetches
    let navigationSeq = 0; // Prevent late async responses from replacing newer routes
    let navigationAbortController = null; // Cancel obsolete API and file transfers
    let isLoading = false; // Prevent double-fetches
    let searchSeq = 0;     // Orders deferred search renders against late fetches
    let dismissImageModal = null;
    let archiveStats = null;
    const documentFilters = { dataSet: '', hasText: '' };
    const searchFilters = { source: '' };

    // Source groups mirror the worker's SOURCE_GROUPS for the `source` param.
    const SOURCE_OPTIONS = [
        { value: 'doj-release', label: 'DOJ Release' },
        { value: 'court-records', label: 'Court Records' },
        { value: 'doj-disclosures', label: 'DOJ Disclosures' },
        { value: 'house-oversight-doj', label: 'House Oversight (DOJ)' },
        { value: 'house-oversight-estate', label: 'House Oversight (Estate)' },
        { value: 'maxwell-interview', label: 'Maxwell Interview' },
    ];
    const DOJ_RELEASE_SETS = ['data-set', 'data-set-2', 'data-set-3', 'data-set-4',
        'data-set-5', 'data-set-6', 'data-set-7', 'data-set-8'];
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
    const setLabel = name => DATA_SET_LABELS[name] || name;

    // Elements
    const homeView = document.getElementById('home-view');
    const resultsView = document.getElementById('results-view');
    const searchInput = document.getElementById('q');
    const navOverlay = document.getElementById('nav-overlay');
    const slideMenu = document.getElementById('slide-menu');
    const menuButton = document.querySelector('.menu-btn');
    const mobileMenuQuery = window.matchMedia('(max-width: 768px)');
    const imagesState = { items: [], index: 0, offset: 0, total: 0 };
    const themeButton = document.querySelector('[data-action="theme"]');
    const menuBackgroundElements = [
        document.querySelector('main'),
        document.querySelector('footer'),
        document.querySelector('.logo'),
        themeButton,
    ].filter(Boolean);
    const modalBackgroundElements = [
        document.querySelector('header'),
        document.querySelector('main'),
        document.querySelector('footer'),
        navOverlay,
    ].filter(Boolean);
    const THEME_KEY = 'epstein-project-theme';
    const BASE_TITLE = 'Epstein Project — Public Archive of Jeffrey Epstein Case Records';
    const API_TIMEOUT_MS = 20_000;
    const FEEDBACK_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSdu5whC_64CsbCUP-6wjtwGx28y0oFOVMv290bREt45O0CWJg/viewform';
    const FEEDBACK_LOOKUP_ENTRY = 'entry.962036122';
    const FEEDBACK_ISSUE_ENTRY = 'entry.1729274358';

    function storedTheme() {
        try {
            const value = localStorage.getItem(THEME_KEY);
            return ['light', 'dark'].includes(value) ? value : 'auto';
        } catch {
            return 'auto';
        }
    }

    function applyTheme(theme) {
        if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
        else document.documentElement.dataset.theme = theme;
        const label = themeButton?.querySelector('[data-theme-label]');
        if (label) label.textContent = theme[0].toUpperCase() + theme.slice(1);
        themeButton?.setAttribute('aria-label', `Color theme: ${theme}. Activate to change.`);
    }

    function cycleTheme() {
        const current = storedTheme();
        const next = current === 'auto' ? 'light' : current === 'light' ? 'dark' : 'auto';
        try {
            if (next === 'auto') localStorage.removeItem(THEME_KEY);
            else localStorage.setItem(THEME_KEY, next);
        } catch {
            // The visual theme can still change when storage is unavailable.
        }
        applyTheme(next);
    }

    applyTheme(storedTheme());

    function syncMenuAccessibility(isOpen) {
        const isClosedMobile = mobileMenuQuery.matches && !isOpen;
        const isOpenMobile = mobileMenuQuery.matches && isOpen;
        if (isClosedMobile && slideMenu.contains(document.activeElement)) {
            menuButton?.focus({ preventScroll: true });
        }
        slideMenu.toggleAttribute('inert', isClosedMobile);
        menuBackgroundElements.forEach(element => element.toggleAttribute('inert', isOpenMobile));
        if (mobileMenuQuery.matches) {
            slideMenu.setAttribute('aria-hidden', String(!isOpen));
        } else {
            slideMenu.removeAttribute('aria-hidden');
        }
    }

    function toggleMenu(forceOpen = null) {
        const shouldOpen = forceOpen === null ? !slideMenu.classList.contains('open') : forceOpen;
        slideMenu.classList.toggle('open', shouldOpen);
        navOverlay.classList.toggle('open', shouldOpen);
        document.body.style.overflow = shouldOpen ? 'hidden' : '';
        menuButton?.setAttribute('aria-expanded', String(shouldOpen));
        menuButton?.setAttribute('aria-label', shouldOpen ? 'Close menu' : 'Menu');
        syncMenuAccessibility(shouldOpen);
        if (shouldOpen && mobileMenuQuery.matches) {
            requestAnimationFrame(() => slideMenu.querySelector('a[href]')?.focus({ preventScroll: true }));
        }
    }

    function syncMenuForViewport() {
        const isOpen = slideMenu.classList.contains('open');
        if (!mobileMenuQuery.matches && isOpen) {
            toggleMenu(false);
            return;
        }
        syncMenuAccessibility(isOpen);
    }

    syncMenuForViewport();
    mobileMenuQuery.addEventListener?.('change', syncMenuForViewport);
    window.addEventListener('resize', syncMenuForViewport);

    const parseDataNumber = (control, key, fallback = 0) => {
        const value = Number(control.dataset[key]);
        return Number.isFinite(value) ? value : fallback;
    };

    async function readApiJson(response) {
        const data = await response.json().catch(() => null);
        if (!response.ok) {
            const err = new Error(data?.error || `Request failed (${response.status})`);
            err.status = response.status;
            const retryAfter = Number(response.headers.get('Retry-After') || data?.retry_after);
            if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfter = retryAfter;
            throw err;
        }
        return data;
    }

    function fetchForView(navigationId, input, init = {}, timeoutMs = API_TIMEOUT_MS) {
        // Every route render owns one controller. Starting another render
        // aborts its database requests and, importantly, any whole-file PDF
        // transfer that would otherwise continue after the reader left.
        const navigationSignal = navigationId === navigationSeq
            ? navigationAbortController?.signal
            : AbortSignal.abort();
        const signal = timeoutMs > 0
            ? AbortSignal.any([navigationSignal, AbortSignal.timeout(timeoutMs)])
            : navigationSignal;
        return fetch(input, { ...init, signal });
    }

    function describeApiError(error, fallbackTitle, { rateLimitTitle = 'Request paused' } = {}) {
        if (error?.status === 429) {
            const wait = Number.isFinite(error.retryAfter)
                ? ` Try again in about ${error.retryAfter} seconds.`
                : ' Wait a minute and try again.';
            return {
                title: rateLimitTitle,
                message: `Too many requests from your network.${wait}`,
            };
        }
        if (error?.name === 'TimeoutError') {
            return {
                title: fallbackTitle,
                message: 'The archive server took too long to respond. Try again.',
            };
        }
        if (navigator.onLine === false) {
            return {
                title: fallbackTitle,
                message: 'You appear to be offline. Reconnect and try again.',
            };
        }
        if (error?.status >= 500) {
            return {
                title: fallbackTitle,
                message: 'The archive server is temporarily unavailable. Try again shortly.',
            };
        }
        if (error?.status >= 400 && error?.status < 500 && error?.message) {
            return { title: fallbackTitle, message: error.message };
        }
        return {
            title: fallbackTitle,
            message: 'Unable to reach the archive server. Check your connection and try again.',
        };
    }

    const pageLabel = value => {
        const pages = Number(value);
        if (!Number.isFinite(pages)) return '';
        return `${pages.toLocaleString()} ${pages === 1 ? 'page' : 'pages'}`;
    };

    function initVideoBuffering() {
        const video = resultsView.querySelector('[data-buffering-video]');
        const shell = video?.closest('.video-shell');
        const status = shell?.querySelector('.video-buffering');
        const label = status?.querySelector('[data-buffering-label]');
        if (!video || !shell || !status || !label) return;

        const show = message => {
            label.textContent = message;
            shell.classList.add('is-buffering');
            shell.setAttribute('aria-busy', 'true');
            status.setAttribute('aria-hidden', 'false');
        };
        const hide = () => {
            shell.classList.remove('is-buffering');
            shell.setAttribute('aria-busy', 'false');
            status.setAttribute('aria-hidden', 'true');
        };

        video.addEventListener('loadstart', () => show('Loading video…'));
        video.addEventListener('waiting', () => show('Buffering…'));
        video.addEventListener('stalled', () => {
            if (!video.paused) show('Buffering…');
        });
        video.addEventListener('seeking', () => show('Seeking…'));
        ['loadedmetadata', 'canplay', 'playing', 'seeked', 'pause', 'ended', 'error']
            .forEach(eventName => video.addEventListener(eventName, hide));

        if (video.readyState >= HTMLMediaElement.HAVE_METADATA) hide();
        else show('Loading video…');
    }

    function brokenFileReportUrl(media) {
        const kind = media.dataset.mediaKind || media.tagName?.toLowerCase() || 'media';
        const documentId = media.dataset.documentId || 'unknown';
        const title = media.dataset.documentTitle || 'Untitled record';
        const source = media.currentSrc || media.querySelector('source')?.src || 'unknown';
        const errorCode = media.error?.code ? String(media.error.code) : 'source-error';
        const page = new URL(
            `${location.pathname}${location.search}${location.hash}`,
            location.origin,
        ).href;
        const reportUrl = new URL(FEEDBACK_FORM_URL);
        reportUrl.searchParams.set('usp', 'pp_url');
        reportUrl.searchParams.set(
            FEEDBACK_LOOKUP_ENTRY,
            `${kind} document ${documentId}`,
        );
        reportUrl.searchParams.set(FEEDBACK_ISSUE_ENTRY, [
            `Broken ${kind} file`,
            `Document ID: ${documentId}`,
            `Title: ${title}`,
            `Page: ${page}`,
            `Media source: ${source}`,
            `Browser media error code: ${errorCode}`,
        ].join('\n'));
        return reportUrl.href;
    }

    function initMediaFailureState() {
        const media = resultsView.querySelector('[data-media-file]');
        const errorState = resultsView.querySelector('[data-media-error]');
        if (!media || !errorState) return;

        const showFailure = () => {
            const reportLink = errorState.querySelector('[data-broken-file-report]');
            if (reportLink) reportLink.href = brokenFileReportUrl(media);
            errorState.hidden = false;
            const shell = media.closest('.video-shell');
            const buffering = shell?.querySelector('.video-buffering');
            shell?.classList.remove('is-buffering');
            shell?.setAttribute('aria-busy', 'false');
            buffering?.setAttribute('aria-hidden', 'true');
        };

        media.addEventListener('error', showFailure);
        media.querySelector('source')?.addEventListener('error', showFailure);
    }

    async function sharePage(control) {
        const url = new URL(control.dataset.url || location.pathname, location.origin).href;
        const title = resultsView.querySelector('h1')?.textContent?.trim() || document.title;
        try {
            if (navigator.share) {
                await navigator.share({ title, url });
                return;
            }
            await navigator.clipboard.writeText(url);
            const original = control.textContent;
            control.textContent = 'Link copied';
            setTimeout(() => { control.textContent = original; }, 1800);
        } catch (error) {
            if (error?.name !== 'AbortError') window.prompt('Copy this link:', url);
        }
    }

    const actionHandlers = {
        home: () => goHome(),
        search: () => doSearch(),
        images: control => showImages(parseDataNumber(control, 'offset')),
        videos: control => showVideos(parseDataNumber(control, 'offset')),
        documents: control => showDocuments(parseDataNumber(control, 'offset')),
        'document-filter': () => {
            documentFilters.dataSet = document.getElementById('documents-data-set')?.value || '';
            documentFilters.hasText = document.getElementById('documents-has-text')?.value || '';
            showDocuments(0);
        },
        'search-page': control => doSearch(false, parseDataNumber(control, 'offset')),
        'search-filter': () => {
            searchFilters.source = document.getElementById('search-source')?.value || '';
            doSearch();
        },
        'house-oversight': control => control.dataset.bates
            ? viewHouseOversightDoc(control.dataset.bates)
            : showHouseOversight(parseDataNumber(control, 'offset')),
        maxwell: () => showMaxwellTapes(),
        about: () => showAbout(),
        back: () => goBack(),
        doc: control => viewDoc(parseDataNumber(control, 'id')),
        entity: control => viewEntity(parseDataNumber(control, 'id'), parseDataNumber(control, 'offset')),
        image: control => openImageModal(parseDataNumber(control, 'index')),
        'pdf-text': () => togglePdfText(),
        share: control => sharePage(control),
        'toggle-menu': control => toggleMenu(control.dataset.open === undefined ? null : control.dataset.open === 'true'),
        theme: () => cycleTheme(),
    };

    document.addEventListener('click', (event) => {
        const control = event.target.closest('[data-action]');
        if (!control) return;
        const handler = actionHandlers[control.dataset.action];
        if (!handler) return;
        event.preventDefault();
        handler(control);
        if (!['toggle-menu', 'theme'].includes(control.dataset.action)
            && slideMenu.classList.contains('open')) {
            toggleMenu(false);
        }
    });

    document.addEventListener('submit', (event) => {
        const form = event.target.closest('[data-search-form]');
        if (!form) return;
        event.preventDefault();
        const input = form.querySelector('[data-results-search]');
        searchInput.value = input?.value || '';
        doSearch();
    });

    document.addEventListener('keydown', (event) => {
        if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[role="button"][data-action]')) {
            event.preventDefault();
            event.target.click();
        }
    });

    document.addEventListener('error', (event) => {
        const image = event.target;
        if (!(image instanceof HTMLImageElement)) return;
        image.classList.add('image-load-failed');
        const preview = image.closest('.image-card, .video-card, .oversight-card, .oversight-page');
        if (preview) {
            preview.classList.add('is-broken');
            image.setAttribute('aria-hidden', 'true');
            const fallback = preview.querySelector('[data-preview-error]');
            if (fallback) fallback.hidden = false;
        }
    }, true);

    // Keep keyboard focus inside the open mobile navigation. The menu button
    // remains in the cycle so there is always an obvious close control.
    document.addEventListener('keydown', (e) => {
        if (!mobileMenuQuery.matches || !slideMenu.classList.contains('open')) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            toggleMenu(false);
            return;
        }
        if (e.key === 'Tab') {
            const focusable = [
                menuButton,
                ...slideMenu.querySelectorAll('a[href], button:not([disabled])'),
            ].filter(Boolean);
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            } else if (!focusable.includes(document.activeElement)) {
                e.preventDefault();
                (e.shiftKey ? last : first).focus();
            }
        }
    });

    // Scroll position restoration
    const scrollPositions = new Map();

    function saveScrollPosition() {
        if (currentHash) {
            scrollPositions.set(currentHash, window.scrollY);
        }
    }

    function restoreScrollPosition(hash) {
        const pos = scrollPositions.get(hash);
        if (pos !== undefined) {
            requestAnimationFrame(() => window.scrollTo(0, pos));
        } else {
            window.scrollTo(0, 0);
        }
    }

    // Initialize
    document.addEventListener('DOMContentLoaded', () => {
        loadStats();

        // The server-rendered document pages carry a plain GET form that posts
        // here as /?q=... Those pages are where organic search traffic lands
        // and they ship no JavaScript, so this is the handoff that lets a
        // first-time visitor search without bouncing through the home page.
        const handoff = new URLSearchParams(location.search).get('q');
        if (handoff && !location.hash) {
            searchInput.value = handoff.slice(0, 200);
            // Drop ?q= so a refresh does not re-run the search; doSearch()
            // pushes the #search/... hash immediately after.
            history.replaceState(null, '', '/');
            doSearch();
        } else {
            currentHash = location.hash.slice(1) || 'home';
            handleHash(true);
        }

        searchInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') doSearch();
        });
    });

    window.addEventListener('popstate', () => {
        const newHash = location.hash.slice(1) || 'home';
        // Only handle if hash actually changed
        if (newHash !== currentHash) {
            saveScrollPosition(); // Save before navigating away
            currentHash = newHash;
            handleHash();
            restoreScrollPosition(newHash); // Restore after loading
        }
    });

    function loadStats() {
        fetch(`${API}/stats`).then(r => r.json()).then(s => {
            archiveStats = s;
            if (!s.total_documents) return;
            document.getElementById('stat-documents').textContent = s.total_documents.toLocaleString();
            document.getElementById('stat-entities').textContent = s.total_entities.toLocaleString();
            document.getElementById('stat-mentions').textContent = s.total_mentions.toLocaleString();

            // Live counts for the collections ledger.
            const counts = new Map((s.data_sets || []).map(item => [item.name, Number(item.count)]));
            const ledgerCounts = {
                'doj-release': DOJ_RELEASE_SETS.reduce((sum, name) => sum + (counts.get(name) || 0), 0),
                'court-records': counts.get('court-records'),
                'house-oversight-estate': counts.get('house-oversight-estate'),
                'house-oversight-doj': counts.get('house-oversight-doj'),
                'doj-disclosures': counts.get('doj-disclosures'),
                'maxwell-interview': counts.get('maxwell-interview'),
            };
            document.querySelectorAll('[data-ledger]').forEach(el => {
                const n = ledgerCounts[el.dataset.ledger];
                if (!n) return;
                const unit = el.dataset.ledger === 'maxwell-interview' ? 'recordings' : 'files';
                el.textContent = `${n.toLocaleString()} ${unit}`;
            });
        }).catch(() => {
            // Keep the static fallback text already in the DOM.
        });
    }

    function decodeHashPart(value) {
        try {
            return decodeURIComponent(value);
        } catch {
            return null;
        }
    }

    function parseHashInteger(value, { defaultValue = null, min = 0, max = 1_000_000 } = {}) {
        if ((value === undefined || value === '') && defaultValue !== null) return defaultValue;
        if (!/^\d+$/.test(value || '')) return null;
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
    }

    function showRouteNotFound() {
        setView('not-found');
        resultsView.innerHTML = `
            <div class="error-state">
                <h1 class="page-title">Page not found</h1>
                <p>This archive link is incomplete or malformed.</p>
                <button class="btn" data-action="home">Return to the archive</button>
            </div>
        `;
        announceView('Page not found', 'The requested archive page was not found.');
    }

    function showViewError(title, message, retryHtml = '') {
        resultsView.innerHTML = `
            <div class="error-state">
                <h1 class="page-title">${esc(title)}</h1>
                <p>${esc(message)}</p>
                ${retryHtml}
            </div>
        `;
        announceView(title, message);
    }

    function handleHash(initialLoad = false) {
        const hash = location.hash.slice(1);
        if (!hash || hash === 'home') { goHome(true, !initialLoad); return; }

        const [type, ...rest] = hash.split('/');

        if (type === 'search' && rest[0] && rest.length <= 3) {
            const query = decodeHashPart(rest[0]);
            const validSource = !rest[1] || rest[1] === '-' || SOURCE_OPTIONS.some(o => o.value === rest[1]);
            // rest[2] is the offset; '-' is the placeholder for "no source
            // filter". Older links without either segment still work.
            const searchOffset = parseHashInteger(rest[2], { defaultValue: 0 });
            if (query === null || !validSource || searchOffset === null) { showRouteNotFound(); return; }
            searchInput.value = query;
            searchFilters.source = SOURCE_OPTIONS.some(o => o.value === rest[1]) ? rest[1] : '';
            doSearch(true, searchOffset); // true = don't pushState, we're already at this hash
        } else if (type === 'images' && rest.length <= 2) {
            const offset = parseHashInteger(rest[0], { defaultValue: 0 });
            const index = rest[1] === undefined ? null : parseHashInteger(rest[1]);
            if (offset === null || (rest[1] !== undefined && index === null)) { showRouteNotFound(); return; }
            showImages(offset, true, index);
        } else if (type === 'videos' && rest.length <= 1) {
            const offset = parseHashInteger(rest[0], { defaultValue: 0 });
            if (offset === null) { showRouteNotFound(); return; }
            showVideos(offset, true);
        } else if (type === 'maxwell' && rest.length === 0) {
            showMaxwellTapes(true);
        } else if (type === 'documents' && rest.length <= 3) {
            const offset = parseHashInteger(rest[0], { defaultValue: 0 });
            const dataSet = rest[1] ? decodeHashPart(rest[1]) : '';
            const hasText = rest[2] || '';
            if (offset === null || dataSet === null || !['', '0', '1'].includes(hasText)) { showRouteNotFound(); return; }
            documentFilters.dataSet = dataSet;
            documentFilters.hasText = hasText;
            showDocuments(offset, true);
        } else if (type === 'house-oversight') {
            if (rest.length === 0) {
                showHouseOversight(0, true);
            } else if (rest[0] === 'page' && rest.length <= 2) {
                const offset = parseHashInteger(rest[1], { defaultValue: 0 });
                if (offset === null) { showRouteNotFound(); return; }
                showHouseOversight(offset, true);
            } else if (rest.length === 1) {
                const bates = decodeHashPart(rest[0]);
                if (!bates || !/^HOUSE_OVERSIGHT_\d+$/.test(bates)) { showRouteNotFound(); return; }
                viewHouseOversightDoc(bates, true);
            } else {
                showRouteNotFound();
            }
        } else if (type === 'doc' && rest.length === 1) {
            const id = parseHashInteger(rest[0], { min: 1, max: Number.MAX_SAFE_INTEGER });
            if (id === null) { showRouteNotFound(); return; }
            viewDoc(id, true);
        } else if (type === 'entity' && rest.length >= 1 && rest.length <= 2) {
            const id = parseHashInteger(rest[0], { min: 1, max: Number.MAX_SAFE_INTEGER });
            const offset = parseHashInteger(rest[1], { defaultValue: 0 });
            if (id === null || offset === null) { showRouteNotFound(); return; }
            viewEntity(id, offset, true);
        } else if (type === 'about' && rest.length === 0) {
            showAbout(true);
        } else {
            showRouteNotFound();
        }
    }

    // The #sr-announce live region has existed in index.html since the start
    // and nothing ever wrote to it, document.title never changed between
    // views, and setView() hides #home-view while the search input that
    // triggered the search lives inside it -- so focus fell to <body> on every
    // search and again on every pagination click, since resultsView.innerHTML
    // is replaced wholesale. To a screen reader or a keyboard user, navigating
    // this site was silent and lost their place. WCAG 4.1.3 and 2.4.3.
    //
    // Compose the message from real values, never from the rendered <h1>:
    // renderSearchResults emits a literal "Search Results", which is why
    // sharePage() currently shares every search under that name.
    function announceView(pageTitle, message) {
        document.title = pageTitle
            ? `${pageTitle} | Epstein Project`
            : BASE_TITLE;
        const region = document.getElementById('sr-announce');
        if (region) region.textContent = message || pageTitle || '';
        // Move focus to the new heading so the next Tab continues from the
        // content rather than restarting at the top of the document.
        const heading = resultsView.querySelector('h1');
        if (heading) {
            heading.setAttribute('tabindex', '-1');
            heading.focus({ preventScroll: true });
        }
    }

    function setView(view) {
        navigationAbortController?.abort();
        navigationAbortController = new AbortController();
        navigationSeq += 1;
        if (view !== 'images') {
            dismissImageModal?.({ syncUrl: false, restoreFocus: false });
        }
        // A search may finish after the reader has already selected another
        // collection. Invalidate it here so the stale response cannot replace
        // the newer view, and so a later search is not blocked as "loading".
        if (view !== 'search' && isLoading) {
            searchSeq += 1;
            isLoading = false;
        }
        currentView = view;
        homeView.style.display = view === 'home' ? 'block' : 'none';
        resultsView.style.display = view === 'home' ? 'none' : 'block';
        resultsView.classList.toggle('active', view !== 'home');

        // Update nav active state
        document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
        if (view === 'images') document.getElementById('nav-images').classList.add('active');
        else if (view === 'videos') document.getElementById('nav-videos').classList.add('active');
        else if (view === 'maxwell') document.getElementById('nav-maxwell').classList.add('active');
        else if (view === 'documents') document.getElementById('nav-docs').classList.add('active');
        else if (view === 'house-oversight') document.getElementById('nav-oversight').classList.add('active');
        else if (view === 'about') document.getElementById('nav-about').classList.add('active');

        return navigationSeq;
    }

    function isCurrentView(view, navigationId) {
        return currentView === view && navigationSeq === navigationId;
    }

    function goHome(skipPush = false, moveFocus = true) {
        saveScrollPosition();
        setView('home');
        searchInput.value = '';
        currentHash = 'home';
        document.title = BASE_TITLE;
        const region = document.getElementById('sr-announce');
        if (region) region.textContent = 'Archive home.';
        if (moveFocus) {
            const heading = homeView.querySelector('h1');
            if (heading) {
                heading.setAttribute('tabindex', '-1');
                heading.focus({ preventScroll: true });
            }
        }
        if (!skipPush && location.hash) {
            history.pushState(null, '', location.pathname);
        }
        window.scrollTo(0, 0);
    }

    // Search was the only paged view with no pagination: a hard limit=50 with
    // no offset, while the page printed "3,387 found". The API already
    // accepted offset, so ~92% of matches were simply unreachable.
    const SEARCH_PAGE = 50;

    function renderSearchForm(query) {
        return `
            <form class="search-container results-search" data-search-form>
                <label class="sr-only" for="results-q">Search the archive</label>
                <div class="search-box">
                    <input type="search" id="results-q" data-results-search value="${esc(query)}"
                        placeholder="Search names, places, case files" maxlength="200">
                    <button class="search-btn" type="submit">Search</button>
                </div>
            </form>
        `;
    }

    function doSearch(skipPush = false, offset = 0) {
        const q = searchInput.value.trim();
        if (!q) return;
        if (isLoading) return; // Prevent double-fetch
        saveScrollPosition();

        const navigationId = setView('search');
        isLoading = true;

        // Swapping in the loading state tears down the previous result set (up
        // to 50 cards plus entity cards). Done inline it runs inside the click
        // handler and delays the paint the tap is waiting on — the measured
        // INP 1,640ms attributed to the outgoing results header. Yield first,
        // and skip the swap entirely if the fetch already won the race.
        const seq = ++searchSeq;
        afterPaint(() => {
            if (seq === searchSeq && isLoading) {
                resultsView.innerHTML = '<div class="loading">Searching</div>';
            }
        });

        // The offset lives in the hash so a page of results is linkable and
        // survives back/forward. The source segment stays in place even when
        // empty, so the offset never shifts position.
        const newHash = `search/${encodeURIComponent(q)}/${searchFilters.source || '-'}`
            + (offset ? `/${offset}` : '');
        currentHash = newHash;
        if (!skipPush) {
            history.pushState(null, '', `#${newHash}`);
        }

        const sourceParam = searchFilters.source ? `&source=${encodeURIComponent(searchFilters.source)}` : '';
        Promise.all([
            fetchForView(navigationId, `${API}/search?q=${encodeURIComponent(q)}&limit=${SEARCH_PAGE}&offset=${offset}${sourceParam}`).then(readApiJson),
            fetchForView(navigationId, `${API}/entities/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: q, limit: 5 })
            }).then(readApiJson)
        ]).then(([docs, ents]) => {
            if (seq !== searchSeq) return; // superseded by a newer search
            renderSearchResults(q, docs, ents, offset);
        }).catch((err) => {
            if (seq !== searchSeq) return;
            // Say what actually happened. A rejected query and a rate limit
            // need different actions from the reader, and neither is "no
            // results".
            const failure = describeApiError(err, 'Search failed', { rateLimitTitle: 'Search paused' });
            showViewError(
                failure.title,
                failure.message,
                `<p class="result-meta">Edit the query below or try it again.</p>
                ${renderSearchForm(q)}
                <button class="btn" data-action="search">Try again</button>`,
            );
        }).finally(() => {
            if (seq === searchSeq) isLoading = false;
        });
    }

    function renderSearchResults(query, docs, ents, offset = 0) {
        let html = `
            <button class="back-btn" data-action="home">← Back</button>
            <div class="section-kicker">Search Results</div>
            <h1 class="page-title">Search Results</h1>
            <div class="results-intro">Results for “${esc(query)}”.</div>
            ${renderSearchForm(query)}
            <div class="filter-bar" aria-label="Search filters">
                <label>Source
                    <select id="search-source">
                        <option value="">All sources</option>
                        ${SOURCE_OPTIONS.map(o => `<option value="${o.value}"${o.value === searchFilters.source ? ' selected' : ''}>${o.label}</option>`).join('')}
                    </select>
                </label>
                <button class="btn" data-action="search-filter">Apply filter</button>
            </div>
        `;

        if (ents.results?.length) {
            html += `
                <div class="results-header">
                    <h2>People & Organizations</h2>
                    <span class="results-count">${entityCountLabel(ents)}</span>
                </div>
            `;
            ents.results.forEach(e => {
                html += `
                    <div class="entity-card" style="display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <div class="result-title">${esc(e.canonical_name)}</div>
                            <div class="result-meta">${esc(e.entity_type)} · ${e.mention_count.toLocaleString()} mentions across documents</div>
                        </div>
                        <button class="btn" data-action="entity" data-id="${Number(e.entity_id)}">View all mentions →</button>
                    </div>
                `;
            });
        }

        if (docs.results?.length) {
            html += `
                <div class="results-header" style="margin-top: 2rem;">
                    <h2>Documents</h2>
                    <span class="results-count">${(docs.total ?? 0).toLocaleString()} found</span>
                </div>
            `;
            docs.results.forEach(d => {
                const sourceUrl = safeHttpUrl(d.source_url);
                const docMeta = [
                    d.data_set ? esc(setLabel(d.data_set)) : null,
                    d.document_type ? esc(d.document_type) : null,
                    d.document_id ? `DOC ${d.document_id}` : null,
                    ocrLabel(d)
                ].filter(Boolean);
                // Estate docs open in the House Oversight scan viewer, not the
                // generic document view.
                const isEstate = d.data_set === 'house-oversight-estate';
                const named = docLabel(d);
                const titleLink = isEstate
                    ? `<a href="/house-oversight/${esc(d.filename)}" data-action="house-oversight" data-bates="${esc(d.filename)}">${esc(named.label)}</a>`
                    : `<a href="/documents/${Number(d.document_id)}" data-action="doc" data-id="${Number(d.document_id)}">${esc(named.label)}</a>`;
                html += `
                    <div class="result-card">
                        <div class="result-title${named.cls}">${titleLink}</div>
                        ${docMeta.length ? `<div class="meta-row">${docMeta.map(m => `<span class="meta-pill">${m}</span>`).join('')}</div>` : ''}
                        ${d.snippet ? `<div class="result-snippet">${highlight(esc(d.snippet))}</div>` : ''}
                        ${sourceUrl ? `<a class="source-link" href="${esc(sourceUrl)}" target="_blank" rel="noopener">Open Source</a>` : ''}
                    </div>
                `;
            });
        }

        if (!docs.results?.length && offset > 0) {
            html += `
                <div class="empty">
                    <h2>No documents on this results page</h2>
                    <p>This page is beyond the available document matches.</p>
                    <button class="btn" data-action="search-page" data-offset="0">Return to the first results page</button>
                </div>
            `;
        } else if (!ents.results?.length && !docs.results?.length) {
            html += '<div class="empty">No results found.</div>';
        }

        // Pagination over documents. Total comes from the API's real COUNT, so
        // the range is stated explicitly rather than leaving the reader to
        // guess how much of "3,387 found" they have actually seen.
        const shown = docs.results?.length || 0;
        const total = Number(docs.total) || 0;
        if (shown && total > SEARCH_PAGE) {
            const from = offset + 1;
            const to = offset + shown;
            html += `
                <div class="pagination">
                    ${offset > 0 ? `<button class="btn" data-action="search-page" data-offset="${Math.max(0, offset - SEARCH_PAGE)}">← Previous</button>` : ''}
                    <span class="results-count">${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}</span>
                    ${to < total ? `<button class="btn" data-action="search-page" data-offset="${offset + SEARCH_PAGE}">Next →</button>` : ''}
                </div>
            `;
        }

        resultsView.innerHTML = html;

        const docTotal = Number(docs.total) || 0;
        announceView(
            `Search: ${query}`,
            docTotal
                ? `${docTotal.toLocaleString()} documents match ${query}. Showing ${docs.results?.length || 0}.`
                : `No documents match ${query}.`
        );
    }

    // === VIDEOS ===
    async function showVideos(offset = 0, skipPush = false) {
        const navigationId = setView('videos');
        resultsView.innerHTML = '<div class="loading">Loading videos</div>';
        currentHash = `videos/${offset}`;
        if (!skipPush) history.pushState(null, '', `#${currentHash}`);

        try {
            const r = await fetchForView(navigationId, `${API}/videos?limit=48&offset=${offset}`).then(readApiJson);
            if (!isCurrentView('videos', navigationId)) return;

            let html = `
                <button class="back-btn" data-action="home">← Back</button>
                <div class="section-kicker">Archive</div>
                <div class="results-intro">Video files in the archive.</div>
                <div class="results-header">
                    <h1>Video Evidence</h1>
                    <span class="results-count">${r.total.toLocaleString()} videos</span>
                </div>
                <div class="video-grid">
                    ${r.videos.map(v => `
                        <div class="video-card" data-action="doc" data-id="${Number(v.id)}" role="button" tabindex="0">
                            <img src="${API}/videos/${v.id}/thumb" loading="lazy" alt="${esc(v.title)}">
                            <span class="preview-error" data-preview-error hidden>Preview unavailable</span>
                            <div class="info">
                                <h2>${esc(v.filename)}</h2>
                                ${v.data_set ? `<span class="meta-pill">${esc(setLabel(v.data_set))}</span>` : ''}
                            </div>
                        </div>
                    `).join('')}
                </div>
                ${!r.videos.length ? offset > 0 ? `
                    <div class="empty">
                        <h2>No videos on this page</h2>
                        <p>This page is beyond the available videos.</p>
                        <button class="btn" data-action="videos" data-offset="0">Return to the first page</button>
                    </div>
                ` : '<div class="empty"><h2>No videos available</h2></div>' : ''}
                <div class="pagination">
                    ${offset > 0 ? `<button class="btn" data-action="videos" data-offset="${offset - 48}">← Previous</button>` : ''}
                    ${r.videos.length === 48 ? `<button class="btn" data-action="videos" data-offset="${offset + 48}">Next →</button>` : ''}
                </div>
            `;
            resultsView.innerHTML = html;
            announceView('Video Evidence', `${Number(r.total || 0).toLocaleString()} videos in this collection.`);
        } catch (e) {
            if (!isCurrentView('videos', navigationId)) return;
            const failure = describeApiError(e, 'Failed to load videos');
            showViewError(
                failure.title,
                failure.message,
                `<button class="btn" data-action="videos" data-offset="${offset}">Retry</button>`,
            );
        }
    }

    // === MAXWELL TAPES ===
    async function showMaxwellTapes(skipPush = false) {
        const navigationId = setView('maxwell');
        resultsView.innerHTML = '<div class="loading">Loading</div>';
        currentHash = 'maxwell';
        if (!skipPush && location.hash !== '#maxwell') history.pushState(null, '', '#maxwell');

        try {
            const r = await fetchForView(navigationId, `${API}/maxwell-tapes`).then(readApiJson);
            if (!isCurrentView('maxwell', navigationId)) return;
            const day1 = r.tapes.filter(t => t.day === 'Day 1');
            const day2 = r.tapes.filter(t => t.day === 'Day 2');

            const micIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;

            const renderTapes = (tapes) => tapes.map(t => `
                <div class="tape-card" data-action="doc" data-id="${Number(t.id)}" role="button" tabindex="0">
                    <div class="tape-icon">${micIcon}</div>
                    <div class="tape-info">
                        <h3>Part ${t.part || '?'}</h3>
                        <span>${esc(t.filename)}</span>
                    </div>
                </div>
            `).join('');

            let html = `
                <button class="back-btn" data-action="home">← Back</button>
                <div class="section-kicker">Audio Archive</div>
                <div class="results-header">
                    <h1>Maxwell Interview Recordings</h1>
                    <span class="results-count">${r.total} recordings</span>
                </div>
                <div class="results-intro">DOJ interview audio released in the House Oversight production.</div>

                <div class="tape-section">
                    <h2>Day 1</h2>
                    ${renderTapes(day1)}
                </div>

                <div class="tape-section">
                    <h2>Day 2</h2>
                    ${renderTapes(day2)}
                </div>
            `;
            resultsView.innerHTML = html;
            announceView('Maxwell Interview Recordings', `${Number(r.total || 0).toLocaleString()} recordings in this collection.`);
        } catch (e) {
            if (!isCurrentView('maxwell', navigationId)) return;
            const failure = describeApiError(e, 'Failed to load Maxwell recordings');
            showViewError(
                failure.title,
                failure.message,
                '<button class="btn" data-action="maxwell">Retry</button>',
            );
        }
    }

    // === DOCUMENTS ===
    async function showDocuments(offset = 0, skipPush = false) {
        const navigationId = setView('documents');
        resultsView.innerHTML = '<div class="loading">Loading</div>';
        const filterPath = [
            `documents/${offset}`,
            documentFilters.dataSet ? encodeURIComponent(documentFilters.dataSet) : '',
            documentFilters.hasText,
        ];
        while (filterPath.length > 1 && !filterPath[filterPath.length - 1]) filterPath.pop();
        currentHash = filterPath.join('/');
        if (!skipPush) history.pushState(null, '', `#${currentHash}`);

        try {
            const query = new URLSearchParams({ limit: '50', offset: String(offset), document_type: 'pdf' });
            if (documentFilters.dataSet.startsWith('source:')) query.set('source', documentFilters.dataSet.slice(7));
            else if (documentFilters.dataSet) query.set('data_set', documentFilters.dataSet);
            if (documentFilters.hasText) query.set('has_text', documentFilters.hasText);
            const [r, stats] = await Promise.all([
                fetchForView(navigationId, `${API}/browse?${query}`).then(readApiJson),
                archiveStats ? Promise.resolve(archiveStats) : fetchForView(navigationId, `${API}/stats`).then(readApiJson),
            ]);
            if (!isCurrentView('documents', navigationId)) return;
            archiveStats = stats;
            const setCounts = new Map((stats.data_sets || [])
                .filter(item => item.name && item.name !== 'house-oversight-estate')
                .map(item => [item.name, Number(item.count)]));
            const validDataSet = !documentFilters.dataSet
                || documentFilters.dataSet === 'source:doj-release'
                || setCounts.has(documentFilters.dataSet);
            if (!validDataSet) {
                documentFilters.dataSet = '';
                documentFilters.hasText = '';
                showViewError(
                    'Dataset not found',
                    'The selected document source set does not exist or is no longer available.',
                    '<button class="btn" data-action="documents" data-offset="0">Browse all document sets</button>',
                );
                return;
            }
            const dojSets = DOJ_RELEASE_SETS.filter(name => setCounts.has(name));
            const dojTotal = dojSets.reduce((sum, name) => sum + setCounts.get(name), 0);
            const otherSets = [...setCounts.keys()]
                .filter(name => !DOJ_RELEASE_SETS.includes(name))
                .sort((a, b) => setLabel(a).localeCompare(setLabel(b)));
            const setOption = name => `<option value="${esc(name)}"${name === documentFilters.dataSet ? ' selected' : ''}>${esc(setLabel(name))} (${setCounts.get(name).toLocaleString()})</option>`;

            let html = `
                <button class="back-btn" data-action="home">← Back</button>
                <div class="section-kicker">Archive</div>
                <div class="results-intro">Public records from all archive sources.</div>
                <div class="filter-bar" aria-label="Document filters">
                    <label>Source set
                        <select id="documents-data-set">
                            <option value="">All source sets</option>
                            <optgroup label="DOJ Release">
                                <option value="source:doj-release"${documentFilters.dataSet === 'source:doj-release' ? ' selected' : ''}>All DOJ Release sets (${dojTotal.toLocaleString()})</option>
                                ${dojSets.map(setOption).join('')}
                            </optgroup>
                            ${otherSets.map(setOption).join('')}
                        </select>
                    </label>
                    <label>Searchable text
                        <select id="documents-has-text">
                            <option value=""${documentFilters.hasText === '' ? ' selected' : ''}>All documents</option>
                            <option value="1"${documentFilters.hasText === '1' ? ' selected' : ''}>OCR available</option>
                            <option value="0"${documentFilters.hasText === '0' ? ' selected' : ''}>OCR pending</option>
                        </select>
                    </label>
                    <button class="btn" data-action="document-filter">Apply filters</button>
                </div>
                <div class="results-header">
                    <h1>All Documents</h1>
                    <span class="results-count">${r.total.toLocaleString()} files</span>
                </div>
            `;

            r.results.forEach(d => {
                const docMeta = [
                    d.data_set ? esc(setLabel(d.data_set)) : null,
                    d.page_count ? pageLabel(d.page_count) : null,
                    d.document_id ? `DOC ${d.document_id}` : null,
                    ocrLabel(d)
                ].filter(Boolean);
                const named = docLabel(d);
                html += `
                    <div class="result-card" style="cursor:pointer;">
                        <div class="result-title${named.cls}"><a href="/documents/${Number(d.document_id)}" data-action="doc" data-id="${Number(d.document_id)}">${esc(named.label)}</a></div>
                        ${docMeta.length ? `<div class="meta-row">${docMeta.map(m => `<span class="meta-pill">${m}</span>`).join('')}</div>` : ''}
                    </div>
                `;
            });

            if (!r.results.length) {
                html += offset > 0 ? `
                    <div class="empty">
                        <h2>No documents on this page</h2>
                        <p>This page is beyond the available results for the selected filters.</p>
                        <button class="btn" data-action="documents" data-offset="0">Return to the first page</button>
                    </div>
                ` : `
                    <div class="empty">
                        <h2>No matching documents</h2>
                        <p>No documents match the selected filters.</p>
                    </div>
                `;
            }

            html += `
                <div class="pagination">
                    ${offset > 0 ? `<button class="btn" data-action="documents" data-offset="${offset - 50}">← Previous</button>` : ''}
                    ${r.results.length === 50 ? `<button class="btn" data-action="documents" data-offset="${offset + 50}">Next →</button>` : ''}
                </div>
            `;

            resultsView.innerHTML = html;
            announceView('Documents', `${Number(r.total || 0).toLocaleString()} documents in this collection.`);
        } catch (e) {
            if (!isCurrentView('documents', navigationId)) return;
            const failure = describeApiError(e, 'Failed to load documents');
            showViewError(
                failure.title,
                failure.message,
                `<button class="btn" data-action="documents" data-offset="${offset}">Retry</button>`,
            );
        }
    }

    // === HOUSE OVERSIGHT ===
    async function showHouseOversight(offset = 0, skipPush = false) {
        const navigationId = setView('house-oversight');
        resultsView.innerHTML = '<div class="loading">Loading House Oversight documents</div>';
        currentHash = `house-oversight/page/${offset}`;
        if (!skipPush) history.pushState(null, '', `#${currentHash}`);

        try {
            const statsPromise = fetchForView(navigationId, `${API}/house-oversight/stats`)
                .then(readApiJson)
                .catch(() => null);
            const docs = await fetchForView(navigationId, `${API}/house-oversight/documents?limit=36&offset=${offset}`).then(readApiJson);
            const stats = await Promise.race([
                statsPromise,
                new Promise(resolve => setTimeout(() => resolve(null), 750)),
            ]);
            if (!isCurrentView('house-oversight', navigationId)) return;
            const totalDocs = docs.total || 0;
            const totalPages = stats?.pages || null;
            const pageSize = docs.documents?.length || 36;

            let html = `
                <button class="back-btn" data-action="home">← Back</button>
                <div class="section-kicker">House Oversight Committee</div>
                <div class="results-intro">
                    House Oversight Committee estate documents.
                    ${totalDocs.toLocaleString()} documents<span data-oversight-page-total>${totalPages ? `, ${totalPages.toLocaleString()} page scans` : ''}</span>.
                </div>
                <div class="results-header">
                    <h1>Estate Documents</h1>
                    <span class="results-count">${totalDocs.toLocaleString()} documents</span>
                </div>
                <div class="oversight-grid">
                    ${docs.documents.map(d => `
                        <a class="oversight-card" href="/house-oversight/${encodeURIComponent(d.bates)}" data-action="house-oversight" data-bates="${esc(d.bates)}">
                            <img src="${API_BASE}${d.thumbnail}" alt="${esc(d.title || d.bates)} thumbnail" loading="lazy">
                            <span class="preview-error" data-preview-error hidden>Preview unavailable</span>
                            <div class="info">
                                <span class="meta-pill">${pageLabel(d.page_count)}</span>
                                <h2>${esc(d.title || d.bates)}</h2>
                                <div class="result-meta">${esc(d.bates)}</div>
                            </div>
                        </a>
                    `).join('')}
                </div>
                ${!docs.documents.length ? offset > 0 ? `
                    <div class="empty">
                        <h2>No estate records on this page</h2>
                        <p>This page is beyond the available House Oversight records.</p>
                        <button class="btn" data-action="house-oversight" data-offset="0">Return to the first page</button>
                    </div>
                ` : '<div class="empty"><h2>No estate records available</h2></div>' : ''}
            `;

            html += `
                <div class="pagination">
                    ${offset > 0 ? `<button class="btn" data-action="house-oversight" data-offset="${Math.max(0, offset - pageSize)}">← Previous</button>` : ''}
                    ${offset + pageSize < totalDocs ? `<button class="btn" data-action="house-oversight" data-offset="${offset + pageSize}">Next →</button>` : ''}
                </div>
            `;

            resultsView.innerHTML = html;
            announceView('House Oversight estate records', `${totalDocs.toLocaleString()} records in this collection.`);
            if (!totalPages) {
                statsPromise.then(lateStats => {
                    if (!isCurrentView('house-oversight', navigationId)) return;
                    const pageTotal = resultsView.querySelector('[data-oversight-page-total]');
                    if (pageTotal && lateStats?.pages) {
                        pageTotal.textContent = `, ${Number(lateStats.pages).toLocaleString()} page scans`;
                    }
                });
            }
        } catch (e) {
            if (!isCurrentView('house-oversight', navigationId)) return;
            const failure = describeApiError(e, 'Failed to load House Oversight documents');
            showViewError(
                failure.title,
                failure.message,
                `<button class="btn" data-action="house-oversight" data-offset="${offset}">Retry</button>`,
            );
        }
    }

    async function viewHouseOversightDoc(bates, skipPush = false) {
        const navigationId = setView('house-oversight');
        resultsView.innerHTML = '<div class="loading">Loading document</div>';
        const encodedBates = encodeURIComponent(bates);
        currentHash = `house-oversight/${encodedBates}`;
        if (!skipPush) history.pushState(null, '', `#house-oversight/${encodedBates}`);

        try {
            const doc = await fetchForView(navigationId, `${API}/house-oversight/documents/${encodedBates}`).then(readApiJson);
            if (!isCurrentView('house-oversight', navigationId)) return;
            const mediaDocumentId = Number(doc.document_id);
            const hasNativeVideo = doc.document_type === 'video'
                && Number.isSafeInteger(mediaDocumentId)
                && mediaDocumentId > 0;
            const videoContentType = doc.playback_content_type || 'video/mp4';

            let html = `
                <button class="back-btn" data-action="house-oversight">← Back to House Oversight</button>
                <div class="section-kicker">House Oversight Document</div>
                <div class="results-header">
                    <h1>${esc(doc.title || doc.bates)}</h1>
                    <span class="results-count">${pageLabel(doc.page_count)}</span>
                </div>
                <div class="meta-row">
                    <span class="meta-pill">${esc(doc.bates)}</span>
                    <span class="meta-pill">${pageLabel(doc.page_count)}</span>
                    <button class="btn" data-action="share" data-url="/house-oversight/${encodedBates}" type="button">Share</button>
                </div>
                ${hasNativeVideo ? `
                    <div class="media-player">
                        <div class="video-shell is-buffering" aria-busy="true">
                            <video controls preload="metadata" poster="${API}/videos/${mediaDocumentId}/thumb" data-buffering-video data-media-file data-media-kind="video" data-document-id="${mediaDocumentId}" data-document-title="${esc(doc.title || doc.bates)}">
                                <source src="${API}/documents/${mediaDocumentId}/file?stream=1" type="${esc(videoContentType)}">
                            </video>
                            <div class="video-buffering" role="status" aria-live="polite" aria-hidden="false">
                                <span class="video-buffering-spinner" aria-hidden="true"></span>
                                <span data-buffering-label>Loading video…</span>
                            </div>
                        </div>
                        <p class="media-error" data-media-error role="alert" hidden>
                            This video file could not be loaded. Try again or <a href="${FEEDBACK_FORM_URL}" target="_blank" rel="noopener" data-broken-file-report>report the broken file</a>.
                        </p>
                    </div>
                ` : ''}
            `;

            html += `<div class="page-grid">`;
            doc.pages.forEach((p, i) => {
                const pageUrl = `${API_BASE}${p.url}`;
                html += `
                    <a class="oversight-page" href="${pageUrl}" target="_blank" aria-label="Open page ${i + 1}">
                        <img src="${pageUrl}" alt="Page ${i + 1}" loading="lazy">
                        <span class="preview-error" data-preview-error hidden>Page image unavailable</span>
                    </a>
                `;
            });
            html += `</div>`;

            // Entities mentioned
            if (doc.entities && doc.entities.length > 0) {
                html += `
                    <div class="entities-section" style="margin-top: 2rem;">
                        <h2>Entities Mentioned</h2>
                        <div class="entity-chips">
                            ${doc.entities.slice(0, 50).map(e => `
                                <button class="entity-chip" data-action="entity" data-id="${Number(e.id)}" type="button">
                                    ${esc(e.name)} (${esc(e.type)})
                                </button>
                            `).join('')}
                        </div>
                    </div>
                `;
            }

            resultsView.innerHTML = html;
            if (hasNativeVideo) {
                initVideoBuffering();
                initMediaFailureState();
            }
            const docName = doc.title || doc.bates;
            const pages = pageLabel(doc.page_count);
            announceView(docName, pages ? `${docName}. ${pages}.` : `${docName}.`);
        } catch (e) {
            if (!isCurrentView('house-oversight', navigationId)) return;
            const notFound = e?.status === 404;
            const failure = describeApiError(e, 'Failed to load House Oversight document');
            showViewError(
                notFound ? 'House Oversight document not found' : failure.title,
                notFound ? 'There is no House Oversight record at this address.' : failure.message,
                notFound
                    ? '<button class="btn" data-action="house-oversight">Browse House Oversight records</button>'
                    : `<button class="btn" data-action="house-oversight" data-bates="${esc(bates)}">Retry</button>`,
            );
        }
    }

    // === IMAGES ===
    async function showImages(offset = 0, skipPush = false, openIndex = null) {
        dismissImageModal?.({ syncUrl: false, restoreFocus: false });
        const navigationId = setView('images');
        resultsView.innerHTML = '<div class="loading">Loading images</div>';
        currentHash = `images/${offset}`;
        if (!skipPush) history.pushState(null, '', `#${currentHash}`);

        try {
            const r = await fetchForView(navigationId, `${API}/images?limit=60&offset=${offset}`).then(readApiJson);
            if (!isCurrentView('images', navigationId)) return;

            if (r.status === 'extraction in progress') {
                resultsView.innerHTML = `
                    <button class="back-btn" data-action="home">← Back</button>
                    <h1 class="page-title">Images</h1>
                    <div class="empty">Image extraction in progress. Check back soon!</div>
                `;
                announceView('Images', 'Image extraction is in progress.');
                return;
            }

            imagesState.items = (r.images || []).map(img => ({
                filename: img.filename,
                docId: img.doc_id,
                page: img.page
            }));
            imagesState.offset = offset;
            imagesState.total = Number(r.total) || imagesState.items.length;

            let html = `
                <button class="back-btn" data-action="home">← Back</button>
                <div class="section-kicker">Archive</div>
                <div class="results-intro">Images extracted from document pages.</div>
                <div class="results-header">
                    <h1>Images</h1>
                    <span class="results-count">${r.total.toLocaleString()} images extracted from PDFs</span>
                </div>
                <div id="images-grid" class="image-grid">
                    ${imagesState.items.map((img, idx) => renderImageCard(img, idx)).join('')}
                </div>
                ${!imagesState.items.length ? offset > 0 ? `
                    <div class="empty">
                        <h2>No images on this page</h2>
                        <p>This page is beyond the available extracted images.</p>
                        <button class="btn" data-action="images" data-offset="0">Return to the first page</button>
                    </div>
                ` : '<div class="empty"><h2>No extracted images available</h2></div>' : ''}
                <div class="pagination">
                    ${offset > 0 ? `<button class="btn" data-action="images" data-offset="${offset - 60}">← Previous</button>` : ''}
                    <span style="color: var(--text-dim); padding: 0.5rem 1rem;">${Math.floor(offset / 60) + 1} / ${Math.max(1, Math.ceil(r.total / 60))}</span>
                    ${r.images.length === 60 ? `<button class="btn" data-action="images" data-offset="${offset + 60}">Next →</button>` : ''}
                </div>
            `;
            resultsView.innerHTML = html;
            initLazyImages();
            announceView('Images', `${Number(r.total || 0).toLocaleString()} images in this collection.`);
            if (openIndex !== null && openIndex >= 0 && openIndex < imagesState.items.length) {
                openImageModal(openIndex, true);
            }
        } catch (e) {
            if (!isCurrentView('images', navigationId)) return;
            const failure = describeApiError(e, 'Failed to load images');
            showViewError(
                failure.title,
                failure.message,
                `<button class="btn" data-action="images" data-offset="${offset}">Retry</button>`,
            );
        }
    }

    function renderImageCard(img, idx) {
        const url = imageApiUrl(img.filename);
        return `
            <div class="image-card" data-action="image" data-index="${idx}" role="button" tabindex="0">
                <img data-src="${esc(url)}" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt="Page ${Number(img.page) + 1} from document ${Number(img.docId)}" class="lazy-img">
                <span class="preview-error" data-preview-error hidden>Preview unavailable</span>
                <div class="image-overlay">
                    <span>Doc #${Number(img.docId)} · Page ${Number(img.page) + 1}</span>
                </div>
            </div>
        `;
    }

    function openImageModal(index, skipPush = false) {
        dismissImageModal?.({ syncUrl: false, restoreFocus: false });
        imagesState.index = index;
        const initialItem = imagesState.items[index];
        if (!initialItem) return;
        const initialImageUrl = imageApiUrl(initialItem.filename);
        const previousFocus = document.activeElement;
        const previousBodyOverflow = document.body.style.overflow;
        const modalHash = `images/${imagesState.offset}/${index}`;
        currentHash = modalHash;
        if (!skipPush) history.pushState(null, '', `#${modalHash}`);
        const modal = document.createElement('div');
        modal.className = 'image-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-label', 'Archive image viewer');
        modal.innerHTML = `
            <div class="image-modal-content">
                <button class="image-modal-close" aria-label="Close">×</button>
                <img src="${esc(initialImageUrl)}" decoding="async" fetchpriority="high" alt="Page ${Number(initialItem.page) + 1} from document ${Number(initialItem.docId)}">
                <p class="media-error" data-modal-image-error role="alert" hidden>
                    This image could not be loaded. Try Download Image or open its source document.
                </p>
                <div class="image-modal-meta" aria-live="polite"></div>
                <div class="image-modal-actions">
                    <button class="btn" data-modal-action="prev">← Prev</button>
                    <button class="btn" data-modal-action="next">Next →</button>
                    <button class="btn" data-modal-action="doc">View Source Document</button>
                    <a href="${esc(initialImageUrl)}" download class="btn">Download Image</a>
                </div>
            </div>
        `;
        modalBackgroundElements.forEach(element => element.toggleAttribute('inert', true));
        document.body.style.overflow = 'hidden';
        const close = ({ syncUrl = true, restoreFocus = true } = {}) => {
            document.removeEventListener('keydown', onKey);
            modal.remove();
            modalBackgroundElements.forEach(element => element.toggleAttribute('inert', false));
            document.body.style.overflow = previousBodyOverflow;
            if (dismissImageModal === close) dismissImageModal = null;
            if (syncUrl) {
                currentHash = `images/${imagesState.offset}`;
                history.replaceState(null, '', `#${currentHash}`);
            }
            if (restoreFocus && previousFocus instanceof HTMLElement) previousFocus.focus();
        };
        dismissImageModal = close;
        const renderModalImage = () => {
            const item = imagesState.items[imagesState.index];
            const imgEl = modal.querySelector('img');
            const dl = modal.querySelector('a[download]');
            const meta = modal.querySelector('.image-modal-meta');
            const errorState = modal.querySelector('[data-modal-image-error]');
            const itemUrl = imageApiUrl(item.filename);
            imgEl.hidden = false;
            errorState.hidden = true;
            imgEl.src = itemUrl;
            imgEl.alt = `Page ${Number(item.page) + 1} from document ${Number(item.docId)}`;
            dl.href = itemUrl;
            meta.textContent = `Image ${imagesState.offset + imagesState.index + 1} of ${imagesState.total} · Document ${Number(item.docId)} · Page ${Number(item.page) + 1}`;
            modal.querySelector('[data-modal-action="prev"]').disabled = imagesState.index === 0;
            modal.querySelector('[data-modal-action="next"]').disabled = imagesState.index === imagesState.items.length - 1;
            currentHash = `images/${imagesState.offset}/${imagesState.index}`;
            // history.replaceState forces a synchronous commit that kept the
            // prev/next tap from painting (measured INP 2,408ms). The URL only
            // needs to be right by the time the user can act again, so let the
            // interaction paint first.
            afterPaint(() => history.replaceState(null, '', `#${currentHash}`));
        };
        const onKey = (e) => {
            if (e.key === 'Escape') close();
            if (e.key === 'ArrowLeft') move(-1);
            if (e.key === 'ArrowRight') move(1);
            if (e.key === 'Tab') {
                const focusable = Array.from(modal.querySelectorAll('button:not([disabled]), a[href]'));
                if (!focusable.length) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        };
        const move = (delta) => {
            const next = imagesState.index + delta;
            if (next < 0 || next >= imagesState.items.length) return;
            imagesState.index = next;
            renderModalImage();
        };
        modal.addEventListener('click', e => { if (e.target === modal) close(); });
        modal.querySelector('.image-modal-close').addEventListener('click', () => close());
        modal.querySelector('img').addEventListener('error', event => {
            event.currentTarget.hidden = true;
            modal.querySelector('[data-modal-image-error]').hidden = false;
        });
        modal.querySelector('[data-modal-action="prev"]').addEventListener('click', () => move(-1));
        modal.querySelector('[data-modal-action="next"]').addEventListener('click', () => move(1));
        modal.querySelector('[data-modal-action="doc"]').addEventListener('click', () => {
            const item = imagesState.items[imagesState.index];
            viewDoc(item.docId);
        });
        document.addEventListener('keydown', onKey);
        document.body.appendChild(modal);
        renderModalImage();
        modal.querySelector('.image-modal-close').focus();
    }

    function initLazyImages() {
        const images = Array.from(document.querySelectorAll('img.lazy-img[data-src]'));
        if (!images.length) return;
        if (!('IntersectionObserver' in window)) {
            images.forEach(img => { img.src = img.dataset.src; img.removeAttribute('data-src'); });
            return;
        }
        const observer = new IntersectionObserver((entries, obs) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    img.src = img.dataset.src;
                    img.removeAttribute('data-src');
                    obs.unobserve(img);
                }
            });
        }, { rootMargin: '200px 0px' });
        images.forEach(img => observer.observe(img));
    }

    // === DOCUMENT VIEWER ===
    async function viewDoc(id, skipPush = false) {
        const newHash = `doc/${id}`;
        // Prevent re-fetching if we're already on this doc
        if (currentHash === newHash && !skipPush) return;

        saveScrollPosition();
        const navigationId = setView('doc');
        resultsView.innerHTML = '<div class="loading">Loading</div>';
        currentHash = newHash;
        if (!skipPush) history.pushState(null, '', `#${newHash}`);

        try {
            if (!Number.isSafeInteger(id) || id < 1) {
                const err = new Error('Document not found');
                err.status = 404;
                throw err;
            }
            const doc = await fetchForView(navigationId, `${API}/documents/${id}`).then(readApiJson);
            if (!isCurrentView('doc', navigationId)) return;
            if (doc.data_set === 'house-oversight-estate' && /^HOUSE_OVERSIGHT_\d+$/.test(doc.filename || '')) {
                const estateHash = `house-oversight/${encodeURIComponent(doc.filename)}`;
                history.replaceState(null, '', `#${estateHash}`);
                await viewHouseOversightDoc(doc.filename, true);
                return;
            }
            const docNamed = docLabel(doc);
            const docTitle = esc(docNamed.label);
            const docTitleClass = docNamed.cls;
            const docMetaParts = [
                doc.data_set ? setLabel(doc.data_set) : null,
                doc.document_type,
                doc.page_count ? pageLabel(doc.page_count) : null,
                ocrLabel(doc)
            ].filter(Boolean);
            const docMeta = docMetaParts.length ? docMetaParts.join(' · ') : '';
            const sourceUrl = safeHttpUrl(doc.source_url);
            const sourceButton = sourceUrl ? `<a href="${esc(sourceUrl)}" target="_blank" rel="noopener" class="btn">Source</a>` : '';
            const shareButton = `<button class="btn" data-action="share" data-url="/documents/${Number(id)}" type="button">Share</button>`;
            const announceDocument = () => announceView(
                docNamed.label,
                `${docNamed.label}. ${doc.document_type || 'Document'}.`,
            );

            // Audio
            if (doc.document_type === 'audio' || doc.content_type?.startsWith('audio/') || doc.filename?.match(/\.(wav|mp3|m4a)$/i)) {
                resultsView.innerHTML = `
                    <button class="back-btn" data-action="back">← Back</button>
                    <div class="doc-viewer">
                        <div class="doc-header">
                            <div>
                                ${doc.data_set ? `<div class="doc-stamp">${esc(setLabel(doc.data_set))}</div>` : ''}
                                <h1 class="doc-title${docTitleClass}">${docTitle}</h1>
                                ${docMeta ? `<div class="doc-meta">${esc(docMeta)}</div>` : ''}
                            </div>
                            <div class="doc-toolbar">
                                ${shareButton}
                                ${sourceButton}
                                <a href="${API}/documents/${id}/file" download class="btn">Download</a>
                            </div>
                        </div>
                        <div class="media-player">
                            <audio controls preload="metadata" data-media-file data-media-kind="audio" data-document-id="${Number(id)}" data-document-title="${esc(docNamed.label)}">
                                <source src="${API}/documents/${id}/file" type="${doc.content_type || 'audio/wav'}">
                            </audio>
                            <p class="media-error" data-media-error role="alert" hidden>
                                This audio file could not be loaded. Try Download or <a href="${FEEDBACK_FORM_URL}" target="_blank" rel="noopener" data-broken-file-report>report the broken file</a>.
                            </p>
                        </div>
                    </div>
                `;
                initMediaFailureState();
                announceDocument();
                return;
            }

            // Video: document_type is the reliable signal — House Oversight DOJ
            // videos have extensionless filenames (DOJ-OGR-…), and without this
            // branch they fell through to the PDF viewer, which tried to inline
            // a multi-GB file and looked like a dead blank panel.
            if (doc.document_type === 'video' || doc.content_type?.startsWith('video/') || doc.filename?.match(/\.(mp4|mov|avi)$/i)) {
                resultsView.innerHTML = `
                    <button class="back-btn" data-action="back">← Back</button>
                    <div class="doc-viewer">
                        <div class="doc-header">
                            <div>
                                ${doc.data_set ? `<div class="doc-stamp">${esc(setLabel(doc.data_set))}</div>` : ''}
                                <h1 class="doc-title${docTitleClass}">${docTitle}</h1>
                                ${docMeta ? `<div class="doc-meta">${esc(docMeta)}</div>` : ''}
                            </div>
                            <div class="doc-toolbar">
                                ${shareButton}
                                ${sourceButton}
                                <a href="${API}/documents/${id}/file?download=1" download class="btn">Download</a>
                            </div>
                        </div>
                        <div class="media-player">
                            <div class="video-shell is-buffering" aria-busy="true">
                            <video controls preload="metadata" poster="${API}/videos/${id}/thumb" data-buffering-video data-media-file data-media-kind="video" data-document-id="${Number(id)}" data-document-title="${esc(docNamed.label)}">
                                <source src="${API}/documents/${id}/file?stream=1" type="${doc.content_type || 'video/mp4'}">
                            </video>
                            <div class="video-buffering" role="status" aria-live="polite" aria-hidden="false">
                                <span class="video-buffering-spinner" aria-hidden="true"></span>
                                <span data-buffering-label>Loading video…</span>
                            </div>
                            </div>
                            <p class="media-error" data-media-error role="alert" hidden>
                                This video file could not be loaded. Try Download or <a href="${FEEDBACK_FORM_URL}" target="_blank" rel="noopener" data-broken-file-report>report the broken file</a>.
                            </p>
                        </div>
                    </div>
                `;
                initVideoBuffering();
                initMediaFailureState();
                announceDocument();
                return;
            }

            // PDF/Text
            const text = await fetchForView(navigationId, `${API}/documents/${id}/text`)
                .then(r => r.json())
                .catch(error => {
                    if (error?.name === 'AbortError') throw error;
                    return null;
                });
            if (!isCurrentView('doc', navigationId)) return;
            const pdfUrl = `${API}/documents/${id}/file`;
            resultsView.innerHTML = `
                <button class="back-btn" data-action="back">← Back</button>
                <div class="doc-viewer">
                    <div class="doc-header">
                        <div>
                            ${doc.data_set ? `<div class="doc-stamp">${esc(setLabel(doc.data_set))}</div>` : ''}
                            <h1 class="doc-title${docTitleClass}">${docTitle}</h1>
                            ${docMeta ? `<div class="doc-meta">${esc(docMeta)}</div>` : ''}
                        </div>
                        <div class="doc-toolbar">
                            ${shareButton}
                            ${sourceButton}
                            <button class="btn" data-action="pdf-text" type="button"
                                aria-controls="text-view" aria-expanded="false">Show text</button>
                            <a href="${pdfUrl}" target="_blank" class="btn">New Tab</a>
                            <a href="${pdfUrl}" download class="btn">Download</a>
                        </div>
                    </div>
                    <div id="pdf-view" style="height:80vh;">
                        <iframe id="pdf-iframe" src="${pdfUrl}" title="${docTitle} PDF viewer" loading="eager"
                            style="width:100%;height:100%;border:none;border-radius:8px;background:var(--pdf-bg);"></iframe>
                        <p class="archive-note">If the embedded preview does not load, use New Tab or Download above.</p>
                    </div>
                    <div id="text-view" class="doc-content" style="display:none;">${esc(text?.full_text || 'No text available.')}</div>
                </div>
            `;
            announceDocument();
        } catch (e) {
            if (!isCurrentView('doc', navigationId)) return;
            const notFound = e?.status === 404;
            const failure = describeApiError(e, 'Failed to load document');
            resultsView.innerHTML = notFound ? `
                <div class="error-state">
                    <h1 class="page-title">Document not found</h1>
                    <p>There is no record at this address. It may have been renumbered, or the link may be mistyped.</p>
                    <button class="btn" data-action="documents">Browse the document index</button>
                </div>
            ` : `
                <div class="error-state">
                    <h1 class="page-title">${esc(failure.title)}</h1>
                    <p>${esc(failure.message)}</p>
                    <button class="btn" data-action="doc" data-id="${Number(id)}">Retry</button>
                </div>
            `;
            announceView(
                notFound ? 'Document not found' : failure.title,
                notFound ? 'Document not found.' : failure.message,
            );
        }
    }

    function goBack() {
        if (window.history.length > 1) {
            history.back();
        } else {
            goHome();
        }
    }

    function togglePdfText() {
        const pdf = document.getElementById('pdf-view');
        const txt = document.getElementById('text-view');
        const button = resultsView.querySelector('[data-action="pdf-text"]');
        if (!pdf || !txt || !button) return;
        const showText = pdf.style.display !== 'none';
        pdf.style.display = showText ? 'none' : 'block';
        txt.style.display = showText ? 'block' : 'none';
        button.setAttribute('aria-expanded', String(showText));
        button.textContent = showText ? 'Show PDF' : 'Show text';
    }

    // === ENTITY ===
    async function viewEntity(id, offset = 0, skipPush = false) {
        const newHash = `entity/${id}/${offset}`;
        saveScrollPosition();
        const navigationId = setView('entity');
        resultsView.innerHTML = '<div class="loading">Loading</div>';
        currentHash = newHash;
        if (!skipPush) history.pushState(null, '', `#${newHash}`);

        try {
            const [entity, mentions, cooc] = await Promise.all([
                fetchForView(navigationId, `${API}/entities/${id}`).then(readApiJson),
                fetchForView(navigationId, `${API}/entities/${id}/mentions?limit=50&offset=${offset}`).then(readApiJson),
                fetchForView(navigationId, `${API}/entities/${id}/co-occurrences?limit=16`).then(readApiJson).catch(error => {
                    if (error?.name === 'AbortError') throw error;
                    return { results: [] };
                }),
            ]);
            if (!isCurrentView('entity', navigationId)) return;

            let html = `
                <button class="back-btn" data-action="back">← Back</button>
                <div class="section-kicker">Entity Record</div>
                <div class="results-header">
                    <h1>${esc(entity.canonical_name)}</h1>
                    <span class="results-count">${entity.mention_count || mentions.total_mentions} total mentions</span>
                </div>
            `;

            if (cooc.results?.length) {
                html += `
                    <div class="cooc-section">
                        <h2>Appears in documents with</h2>
                        <div class="cooc-list">
                            ${cooc.results.map(c => `
                                <button class="cooc-chip" data-action="entity" data-id="${Number(c.entity_id)}" type="button" title="${esc(c.name)} · ${Number(c.shared_docs).toLocaleString()} shared documents">
                                    <span class="cooc-name">${esc(c.name)}</span>
                                    <span class="cooc-count">${Number(c.shared_docs).toLocaleString()}</span>
                                </button>
                            `).join('')}
                        </div>
                        <p class="archive-note">Counts are documents where both names appear.</p>
                    </div>
                `;
            }

            mentions.mentions.forEach(m => {
                let snippet = m.context_snippet ? esc(m.context_snippet) : null;
                const page = m.page_number ? `Page ${m.page_number}` : '';
                const mentionMeta = [page, m.data_set ? setLabel(m.data_set) : null].filter(Boolean);

                // Highlight the name as it appears in the snippet
                if (snippet && m.name_as_appears) {
                    const nameEsc = esc(m.name_as_appears);
                    const regex = new RegExp(`(${nameEsc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
                    snippet = snippet.replace(regex, '<mark>$1</mark>');
                }

                html += `
                    <div class="result-card" style="margin-bottom: 1rem;">
                        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.5rem;">
                            <div class="result-title">
                                <a class="mono-link${titleClass(m.document_filename)}" href="/documents/${Number(m.document_id)}" data-action="doc" data-id="${Number(m.document_id)}">${esc(m.document_filename)}</a>
                            </div>
                            <span class="role-badge">${esc(m.role || 'mentioned')}</span>
                        </div>
                        ${snippet ? `<div class="result-snippet" style="margin: 0.75rem 0;">"${snippet}"</div>` : ''}
                        ${mentionMeta.length ? `<div class="meta-row">${mentionMeta.map(mv => `<span class="meta-pill">${esc(mv)}</span>`).join('')}</div>` : ''}
                    </div>
                `;
            });

            if (!mentions.mentions.length) {
                html += offset > 0 ? `
                    <div class="empty">
                        <h2>No mentions on this page</h2>
                        <p>This page is beyond the available mentions for this entity.</p>
                        <button class="btn" data-action="entity" data-id="${Number(id)}" data-offset="0">Return to the first page</button>
                    </div>
                ` : '<div class="empty">No mentions found.</div>';
            }

            // Pagination
            const totalMentions = entity.mention_count || 0;
            if (mentions.mentions.length && (totalMentions > 50 || offset > 0)) {
                html += `
                    <div class="pagination">
                        ${offset > 0 ? `<button class="btn" data-action="entity" data-id="${Number(id)}" data-offset="${offset - 50}">← Previous</button>` : ''}
                        <span style="color: var(--text-dim); padding: 0.5rem 1rem;">
                            ${offset + 1}-${Math.min(offset + mentions.mentions.length, totalMentions)} of ${totalMentions}
                        </span>
                        ${mentions.mentions.length === 50 ? `<button class="btn" data-action="entity" data-id="${Number(id)}" data-offset="${offset + 50}">Next →</button>` : ''}
                    </div>
                `;
            }

            resultsView.innerHTML = html;
            announceView(
                entity.canonical_name,
                `${Number(entity.mention_count || mentions.total_mentions || 0).toLocaleString()} total mentions for ${entity.canonical_name}.`,
            );
        } catch (e) {
            if (!isCurrentView('entity', navigationId)) return;
            const notFound = e?.status === 404;
            const failure = describeApiError(e, 'Failed to load entity');
            showViewError(
                notFound ? 'Entity not found' : failure.title,
                notFound ? 'There is no entity record at this address.' : failure.message,
                notFound
                    ? '<button class="btn" data-action="home">Return to the archive</button>'
                    : `<button class="btn" data-action="entity" data-id="${Number(id)}" data-offset="${offset}">Retry</button>`,
            );
        }
    }

    // === ABOUT ===
    function showAbout(skipPush = false) {
        setView('about');
        currentHash = 'about';
        if (!skipPush) history.pushState(null, '', '#about');

        resultsView.innerHTML = `
            <div style="max-width: 600px; margin: 0 auto;">
                <button class="back-btn" data-action="home">← Back</button>

                <div class="section-kicker">About</div>
                <h1 style="font-family: var(--font-serif); font-size: 2.5rem; font-weight: 400; margin-bottom: 2rem; color: var(--text);">About</h1>

                <p style="font-size: 1rem; color: var(--text-muted); line-height: 2; margin-bottom: 3rem;">
                    The Epstein Project is an independent, non-commercial archive that indexes public records from official releases of the Jeffrey Epstein case and preserves links back to source material.
                </p>

                <div class="methodology-card">
                    <h2>How the archive is built</h2>
                    <p>Documents retain their source dataset, filename, page count, and original-source link where available. Text is extracted directly when possible; image-only pages are processed with optical character recognition (OCR).</p>
                    <p>OCR can misread names, dates, handwriting, and degraded scans. Each document shows whether searchable text is available so findings can be checked against the underlying page.</p>
                    <p>Entity extraction identifies names and organizations mentioned in text. Similarly named people may require manual disambiguation.</p>
                    <p class="methodology-updated">Methodology reviewed July 2026 · Corrections and missing files can be reported through the feedback link.</p>
                </div>

            </div>
        `;
        announceView('About', 'About this archive and its methodology.');
    }

    // Utilities
    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // Run work after the browser has painted the current interaction. Used to
    // keep non-visual bookkeeping (history updates, heavy list rebuilds) out of
    // the input handler, which is what INP actually measures.
    function afterPaint(fn) {
        requestAnimationFrame(() => setTimeout(fn, 0));
    }

    function safeHttpUrl(value) {
        if (!value) return '';
        try {
            const url = new URL(String(value));
            return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
        } catch {
            return '';
        }
    }

    function imageApiUrl(filename) {
        return `${API}/images/${encodeURIComponent(String(filename ?? ''))}`;
    }

    // "N found" used to print the page size, so a query matching hundreds of
    // people reported "5 found" beside a genuine document count. Say what is
    // actually being shown. The total counts merged name+type groups, but OCR
    // still fragments names ("NE MAXWELL", "en MAXWELL"), so it is framed as
    // matches shown out of matches found rather than as a count of people.
    function entityCountLabel(ents) {
        const shown = ents?.results?.length || 0;
        const total = Number(ents?.total_matches);
        if (!Number.isFinite(total) || total <= shown) return `${shown} shown`;
        return `top ${shown} of ${total.toLocaleString()}`;
    }

    function ocrLabel(doc) {
        if (doc?.has_text) {
            if (Number(doc.word_count) > 0) return `${Number(doc.word_count).toLocaleString()} searchable words`;
            return 'Searchable text';
        }
        const status = String(doc?.processing_status || '').toLowerCase();
        if (status && !['complete', 'completed', 'done'].includes(status)) return `OCR ${status}`;
        // Processing finished but produced nothing searchable (image-only scan,
        // or media). "OCR pending" would imply text is still on its way.
        if (status) return 'No searchable text';
        return 'OCR pending';
    }

    function highlight(s) {
        return s.replace(/&gt;&gt;&gt;(.+?)&lt;&lt;&lt;/g, '<mark>$1</mark>');
    }

    // Raw filenames (no spaces, has an extension) read as data, not prose —
    // style them as monospace metadata instead of a serif headline.
    function looksLikeFilename(s) {
        if (!s) return false;
        return /^[\w.\-]+\.(pdf|jpe?g|png|tiff?|mp4|mov|avi|wav|mp3|m4a|docx?|xlsx?|txt)$/i.test(s.trim());
    }

    function titleClass(s) {
        return looksLikeFilename(s) ? ' is-filename' : '';
    }

    // Mirrors cleanDocTitle in functions/_lib/html.js; keep the two in step.
    // house-oversight-doj rows carry the original upload filename in `title`
    // ("20250115134822946_Certificate of Service.pdf") while `filename` holds
    // the real Bates number — strip the machinery, keep the words.
    function cleanDocTitle(raw) {
        const text = String(raw || '')
            .replace(/\.[a-z0-9]{2,4}$/i, '')
            .replace(/^\d{6,}[_-]\s*/, '')
            .replace(/[_]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const letters = (text.match(/[a-z]/gi) || []).length;
        if (text.length < 4 || letters < text.length * 0.4) return '';
        return text;
    }

    // The Bates/production number is how these records are cited, so it leads
    // and a cleaned description follows — unless the description is just the
    // filename with the underscores swapped out, in which case one of them is
    // noise. Returns the class alongside the label because only a bare number
    // should keep the monospace filename treatment.
    function docLabel(d) {
        const bates = String(d.filename || '').replace(/\.[a-z0-9]{2,4}$/i, '');
        const described = cleanDocTitle(d.title) || cleanDocTitle(d.filename);
        const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
        if (described && norm(described) !== norm(bates)) {
            return { label: `${bates} — ${described}`, cls: '' };
        }
        if (described) return { label: described, cls: '' };
        const label = bates || d.filename || (d.document_id ? `Document ${d.document_id}` : 'Document');
        return { label, cls: ' is-filename' };
    }
