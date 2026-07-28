    const API = '/api';
    const API_BASE = API.replace(/\/api$/, '');

    // Navigation state
    let currentView = 'home';
    let currentHash = '';  // Track current hash to prevent redundant fetches
    let isLoading = false; // Prevent double-fetches
    let searchSeq = 0;     // Orders deferred search renders against late fetches
    let currentPdfBlobUrl = null;
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
    const imagesState = { items: [], index: 0, offset: 0, total: 0 };
    const themeButton = document.querySelector('[data-action="theme"]');
    const THEME_KEY = 'epstein-project-theme';

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

    function toggleMenu(forceOpen = null) {
        const shouldOpen = forceOpen === null ? !slideMenu.classList.contains('open') : forceOpen;
        slideMenu.classList.toggle('open', shouldOpen);
        navOverlay.classList.toggle('open', shouldOpen);
        document.body.style.overflow = shouldOpen ? 'hidden' : '';
        menuButton?.setAttribute('aria-expanded', String(shouldOpen));
        menuButton?.setAttribute('aria-label', shouldOpen ? 'Close menu' : 'Menu');
    }

    const parseDataNumber = (control, key, fallback = 0) => {
        const value = Number(control.dataset[key]);
        return Number.isFinite(value) ? value : fallback;
    };

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
        if (!['toggle-menu', 'theme'].includes(control.dataset.action)) toggleMenu(false);
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
        image.closest('.image-card, .video-card, .oversight-card')?.classList.add('is-broken');
    }, true);

    // Escape key closes mobile menu
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && slideMenu.classList.contains('open')) {
            toggleMenu(false);
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
            handleHash();
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

    function handleHash() {
        const hash = location.hash.slice(1);
        if (!hash || hash === 'home') { goHome(true); return; }

        const [type, ...rest] = hash.split('/');
        const param = rest.join('/');

        if (type === 'search' && rest[0]) {
            searchInput.value = decodeURIComponent(rest[0]);
            searchFilters.source = SOURCE_OPTIONS.some(o => o.value === rest[1]) ? rest[1] : '';
            // rest[2] is the offset; '-' is the placeholder for "no source
            // filter". Older links without either segment still work.
            const searchOffset = /^\d+$/.test(rest[2] || '') ? parseInt(rest[2], 10) : 0;
            doSearch(true, searchOffset); // true = don't pushState, we're already at this hash
        } else if (type === 'images') {
            const parsedOffset = rest[0] ? parseInt(rest[0]) : 0;
            const parsedIndex = rest[1] !== undefined ? parseInt(rest[1]) : null;
            showImages(
                Number.isFinite(parsedOffset) ? parsedOffset : 0,
                true,
                Number.isFinite(parsedIndex) ? parsedIndex : null,
            );
        } else if (type === 'videos') {
            const parsedOffset = rest[0] ? parseInt(rest[0]) : 0;
            showVideos(Number.isFinite(parsedOffset) ? parsedOffset : 0, true);
        } else if (type === 'maxwell') {
            showMaxwellTapes(true);
        } else if (type === 'documents') {
            const parsedOffset = rest[0] ? parseInt(rest[0]) : 0;
            documentFilters.dataSet = rest[1] ? decodeURIComponent(rest[1]) : '';
            documentFilters.hasText = ['0', '1'].includes(rest[2]) ? rest[2] : '';
            showDocuments(Number.isFinite(parsedOffset) ? parsedOffset : 0, true);
        } else if (type === 'house-oversight') {
            if (rest[0] === 'page') {
                const parsedOffset = rest[1] ? parseInt(rest[1]) : 0;
                showHouseOversight(Number.isFinite(parsedOffset) ? parsedOffset : 0, true);
            } else if (param) {
                viewHouseOversightDoc(decodeURIComponent(param), true);
            } else {
                showHouseOversight(0, true);
            }
        } else if (type === 'doc' && param) {
            viewDoc(parseInt(param), true);
        } else if (type === 'entity' && param) {
            const id = parseInt(rest[0]);
            const offset = rest[1] ? parseInt(rest[1]) : 0;
            viewEntity(id, Number.isFinite(offset) ? offset : 0, true);
        } else if (type === 'about') {
            showAbout(true);
        }
    }

    function setView(view) {
        currentView = view;
        homeView.style.display = view === 'home' ? 'block' : 'none';
        resultsView.style.display = view === 'home' ? 'none' : 'block';
        resultsView.classList.toggle('active', view !== 'home');
        if (view !== 'doc') {
            revokePdfBlobUrl();
        }

        // Update nav active state
        document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
        if (view === 'images') document.getElementById('nav-images').classList.add('active');
        else if (view === 'videos') document.getElementById('nav-videos').classList.add('active');
        else if (view === 'maxwell') document.getElementById('nav-maxwell').classList.add('active');
        else if (view === 'documents') document.getElementById('nav-docs').classList.add('active');
        else if (view === 'house-oversight') document.getElementById('nav-oversight').classList.add('active');
        else if (view === 'about') document.getElementById('nav-about').classList.add('active');
    }

    function goHome(skipPush = false) {
        saveScrollPosition();
        setView('home');
        searchInput.value = '';
        currentHash = 'home';
        if (!skipPush && location.hash) {
            history.pushState(null, '', location.pathname);
        }
        window.scrollTo(0, 0);
    }

    function revokePdfBlobUrl() {
        if (currentPdfBlobUrl) {
            URL.revokeObjectURL(currentPdfBlobUrl);
            currentPdfBlobUrl = null;
        }
    }

    // Search was the only paged view with no pagination: a hard limit=50 with
    // no offset, while the page printed "3,387 found". The API already
    // accepted offset, so ~92% of matches were simply unreachable.
    const SEARCH_PAGE = 50;

    function doSearch(skipPush = false, offset = 0) {
        const q = searchInput.value.trim();
        if (!q) return;
        if (isLoading) return; // Prevent double-fetch
        saveScrollPosition();

        setView('search');
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

        // An error body is still valid JSON, so .json() resolved and .catch()
        // never fired: a 400 (bad query syntax) or a 429 (rate limited) left
        // docs.results undefined and the view rendered "No results found."
        // On an archive of primary sources that is a factual claim the
        // documents do not exist -- the worst thing this UI can say when it
        // never actually looked. Fail loudly instead.
        const readJson = async (response) => {
            const data = await response.json().catch(() => null);
            if (!response.ok) {
                const err = new Error(data?.error || `Request failed (${response.status})`);
                err.status = response.status;
                throw err;
            }
            return data;
        };

        const sourceParam = searchFilters.source ? `&source=${encodeURIComponent(searchFilters.source)}` : '';
        Promise.all([
            fetch(`${API}/search?q=${encodeURIComponent(q)}&limit=${SEARCH_PAGE}&offset=${offset}${sourceParam}`).then(readJson),
            fetch(`${API}/entities/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: q, limit: 5 })
            }).then(readJson)
        ]).then(([docs, ents]) => {
            if (seq !== searchSeq) return; // superseded by a newer search
            renderSearchResults(q, docs, ents, offset);
        }).catch((err) => {
            if (seq !== searchSeq) return;
            // Say what actually happened. A rejected query and a rate limit
            // need different actions from the reader, and neither is "no
            // results".
            const rateLimited = err?.status === 429;
            const detail = rateLimited
                ? 'Too many searches from your network. Wait a minute and try again.'
                : err?.status >= 400 && err?.status < 500 && err?.message
                    ? esc(err.message)
                    : 'Unable to reach the server. Check your connection and try again.';
            resultsView.innerHTML = `
                <div class="error-state">
                    <h3>${rateLimited ? 'Search paused' : 'Search failed'}</h3>
                    <p>${detail}</p>
                    <p class="result-meta">Your search terms are still in the box above.</p>
                    <button class="btn" data-action="search">Try again</button>
                </div>
            `;
        }).finally(() => {
            isLoading = false;
        });
    }

    function renderSearchResults(query, docs, ents, offset = 0) {
        let html = `
            <button class="back-btn" data-action="home">← Back</button>
            <div class="section-kicker">Search Results</div>
            <h1 class="page-title">Search Results</h1>
            <div class="results-intro">Results for “${esc(query)}”.</div>
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
                const titleLink = isEstate
                    ? `<a href="/house-oversight/${esc(d.filename)}" data-action="house-oversight" data-bates="${esc(d.filename)}">${esc(d.title || d.filename)}</a>`
                    : `<a href="/documents/${Number(d.document_id)}" data-action="doc" data-id="${Number(d.document_id)}">${esc(d.title || d.filename)}</a>`;
                html += `
                    <div class="result-card">
                        <div class="result-title${titleClass(d.title || d.filename)}">${titleLink}</div>
                        ${docMeta.length ? `<div class="meta-row">${docMeta.map(m => `<span class="meta-pill">${m}</span>`).join('')}</div>` : ''}
                        ${d.snippet ? `<div class="result-snippet">${highlight(esc(d.snippet))}</div>` : ''}
                        ${sourceUrl ? `<a class="source-link" href="${esc(sourceUrl)}" target="_blank" rel="noopener">Open Source</a>` : ''}
                    </div>
                `;
            });
        }

        if (!ents.results?.length && !docs.results?.length) {
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
    }

    // === VIDEOS ===
    async function showVideos(offset = 0, skipPush = false) {
        setView('videos');
        resultsView.innerHTML = '<div class="loading">Loading videos</div>';
        currentHash = `videos/${offset}`;
        if (!skipPush) history.pushState(null, '', `#${currentHash}`);

        try {
            const r = await fetch(`${API}/videos?limit=48&offset=${offset}`).then(r => r.json());

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
                            <div class="info">
                                <h2>${esc(v.filename)}</h2>
                                ${v.data_set ? `<span class="meta-pill">${esc(setLabel(v.data_set))}</span>` : ''}
                            </div>
                        </div>
                    `).join('')}
                </div>
                <div class="pagination">
                    ${offset > 0 ? `<button class="btn" data-action="videos" data-offset="${offset - 48}">← Previous</button>` : ''}
                    ${r.videos.length === 48 ? `<button class="btn" data-action="videos" data-offset="${offset + 48}">Next →</button>` : ''}
                </div>
            `;
            resultsView.innerHTML = html;
        } catch (e) {
            resultsView.innerHTML = `
                <div class="error-state">
                    <h3>Failed to load videos</h3>
                    <p>Check your connection and try again.</p>
                    <button class="btn" data-action="videos" data-offset="${offset}">Retry</button>
                </div>
            `;
        }
    }

    // === MAXWELL TAPES ===
    async function showMaxwellTapes(skipPush = false) {
        setView('maxwell');
        resultsView.innerHTML = '<div class="loading">Loading</div>';
        currentHash = 'maxwell';
        if (!skipPush && location.hash !== '#maxwell') history.pushState(null, '', '#maxwell');

        try {
            const r = await fetch(`${API}/maxwell-tapes`).then(r => r.json());
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
                    <h1>Maxwell Deposition Tapes</h1>
                    <span class="results-count">${r.total} recordings</span>
                </div>
                <div class="results-intro">Audio recordings from deposition exhibits.</div>

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
        } catch (e) {
            resultsView.innerHTML = `
                <div class="error-state">
                    <h3>Failed to load Maxwell tapes</h3>
                    <p>Check your connection and try again.</p>
                    <button class="btn" data-action="maxwell">Retry</button>
                </div>
            `;
        }
    }

    // === DOCUMENTS ===
    async function showDocuments(offset = 0, skipPush = false) {
        setView('documents');
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
                fetch(`${API}/browse?${query}`).then(r => r.json()),
                archiveStats ? Promise.resolve(archiveStats) : fetch(`${API}/stats`).then(r => r.json()),
            ]);
            archiveStats = stats;
            const setCounts = new Map((stats.data_sets || [])
                .filter(item => item.name && item.name !== 'house-oversight-estate')
                .map(item => [item.name, Number(item.count)]));
            const dojSets = DOJ_RELEASE_SETS.filter(name => setCounts.has(name));
            const dojTotal = dojSets.reduce((sum, name) => sum + setCounts.get(name), 0);
            const otherSets = [...setCounts.keys()]
                .filter(name => !DOJ_RELEASE_SETS.includes(name))
                .sort((a, b) => setLabel(a).localeCompare(setLabel(b)));
            const setOption = name => `<option value="${esc(name)}"${name === documentFilters.dataSet ? ' selected' : ''}>${esc(setLabel(name))} (${setCounts.get(name).toLocaleString()})</option>`;

            let html = `
                <button class="back-btn" data-action="home">← Back</button>
                <div class="section-kicker">Archive</div>
                <div class="results-intro">DOJ document set.</div>
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
                html += `
                    <div class="result-card" style="cursor:pointer;">
                        <div class="result-title${titleClass(d.title || d.filename)}"><a href="/documents/${Number(d.document_id)}" data-action="doc" data-id="${Number(d.document_id)}">${esc(d.title || d.filename)}</a></div>
                        ${docMeta.length ? `<div class="meta-row">${docMeta.map(m => `<span class="meta-pill">${m}</span>`).join('')}</div>` : ''}
                    </div>
                `;
            });

            html += `
                <div class="pagination">
                    ${offset > 0 ? `<button class="btn" data-action="documents" data-offset="${offset - 50}">← Previous</button>` : ''}
                    ${r.results.length === 50 ? `<button class="btn" data-action="documents" data-offset="${offset + 50}">Next →</button>` : ''}
                </div>
            `;

            resultsView.innerHTML = html;
        } catch (e) {
            resultsView.innerHTML = `
                <div class="error-state">
                    <h3>Failed to load documents</h3>
                    <p>Check your connection and try again.</p>
                    <button class="btn" data-action="documents" data-offset="${offset}">Retry</button>
                </div>
            `;
        }
    }

    // === HOUSE OVERSIGHT ===
    async function showHouseOversight(offset = 0, skipPush = false) {
        setView('house-oversight');
        resultsView.innerHTML = '<div class="loading">Loading House Oversight documents</div>';
        currentHash = `house-oversight/page/${offset}`;
        if (!skipPush) history.pushState(null, '', `#${currentHash}`);

        try {
            const statsPromise = fetch(`${API}/house-oversight/stats`)
                .then(r => r.ok ? r.json() : null)
                .catch(() => null);
            const docsResponse = await fetch(`${API}/house-oversight/documents?limit=36&offset=${offset}`);
            if (!docsResponse.ok) throw new Error('House Oversight documents request failed');
            const docs = await docsResponse.json();
            const stats = await Promise.race([
                statsPromise,
                new Promise(resolve => setTimeout(() => resolve(null), 750)),
            ]);
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
                            <div class="info">
                                <span class="meta-pill">${pageLabel(d.page_count)}</span>
                                <h2>${esc(d.title || d.bates)}</h2>
                                <div class="result-meta">${esc(d.bates)}</div>
                            </div>
                        </a>
                    `).join('')}
                </div>
            `;

            html += `
                <div class="pagination">
                    ${offset > 0 ? `<button class="btn" data-action="house-oversight" data-offset="${Math.max(0, offset - pageSize)}">← Previous</button>` : ''}
                    ${offset + pageSize < totalDocs ? `<button class="btn" data-action="house-oversight" data-offset="${offset + pageSize}">Next →</button>` : ''}
                </div>
            `;

            resultsView.innerHTML = html;
            if (!totalPages) {
                statsPromise.then(lateStats => {
                    const pageTotal = resultsView.querySelector('[data-oversight-page-total]');
                    if (pageTotal && lateStats?.pages) {
                        pageTotal.textContent = `, ${Number(lateStats.pages).toLocaleString()} page scans`;
                    }
                });
            }
        } catch (e) {
            resultsView.innerHTML = `
                <div class="error-state">
                    <h3>Failed to load House Oversight documents</h3>
                    <p>Check your connection and try again.</p>
                    <button class="btn" data-action="house-oversight" data-offset="${offset}">Retry</button>
                </div>
            `;
        }
    }

    async function viewHouseOversightDoc(bates, skipPush = false) {
        setView('house-oversight');
        resultsView.innerHTML = '<div class="loading">Loading document</div>';
        const encodedBates = encodeURIComponent(bates);
        currentHash = `house-oversight/${encodedBates}`;
        if (!skipPush) history.pushState(null, '', `#house-oversight/${encodedBates}`);

        try {
            const doc = await fetch(`${API}/house-oversight/documents/${bates}`).then(r => r.json());

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
            `;

            html += `<div class="page-grid">`;
            doc.pages.forEach((p, i) => {
                const pageUrl = `${API_BASE}${p.url}`;
                html += `
                    <a href="${pageUrl}" target="_blank" aria-label="Open page ${i + 1}">
                        <img src="${pageUrl}" alt="Page ${i + 1}" loading="lazy">
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
        } catch (e) {
            resultsView.innerHTML = `
                <div class="error-state">
                    <h3>Failed to load document</h3>
                    <p>Check your connection and try again.</p>
                    <button class="btn" data-action="house-oversight" data-bates="${esc(bates)}">Retry</button>
                </div>
            `;
        }
    }

    // === IMAGES ===
    async function showImages(offset = 0, skipPush = false, openIndex = null) {
        setView('images');
        resultsView.innerHTML = '<div class="loading">Loading images</div>';
        currentHash = `images/${offset}`;
        if (!skipPush) history.pushState(null, '', `#${currentHash}`);

        try {
            const r = await fetch(`${API}/images?limit=60&offset=${offset}`).then(r => r.json());

            if (r.status === 'extraction in progress') {
                resultsView.innerHTML = `
                    <button class="back-btn" data-action="home">← Back</button>
                    <div class="empty">Image extraction in progress. Check back soon!</div>
                `;
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
                <div class="pagination">
                    ${offset > 0 ? `<button class="btn" data-action="images" data-offset="${offset - 60}">← Previous</button>` : ''}
                    <span style="color: var(--text-dim); padding: 0.5rem 1rem;">${Math.floor(offset / 60) + 1} / ${Math.ceil(r.total / 60)}</span>
                    ${r.images.length === 60 ? `<button class="btn" data-action="images" data-offset="${offset + 60}">Next →</button>` : ''}
                </div>
            `;
            resultsView.innerHTML = html;
            initLazyImages();
            if (openIndex !== null && openIndex >= 0 && openIndex < imagesState.items.length) {
                openImageModal(openIndex, true);
            }
        } catch (e) {
            resultsView.innerHTML = `
                <div class="error-state">
                    <h3>Failed to load images</h3>
                    <p>Check your connection and try again.</p>
                    <button class="btn" data-action="images" data-offset="${offset}">Retry</button>
                </div>
            `;
        }
    }

    function renderImageCard(img, idx) {
        const url = imageApiUrl(img.filename);
        return `
            <div class="image-card" data-action="image" data-index="${idx}" role="button" tabindex="0">
                <img data-src="${esc(url)}" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt="Page ${Number(img.page) + 1} from document ${Number(img.docId)}" class="lazy-img">
                <div class="image-overlay">
                    <span>Doc #${Number(img.docId)} · Page ${Number(img.page) + 1}</span>
                </div>
            </div>
        `;
    }

    function openImageModal(index, skipPush = false) {
        document.querySelector('.image-modal')?.remove();
        imagesState.index = index;
        const initialItem = imagesState.items[index];
        if (!initialItem) return;
        const initialImageUrl = imageApiUrl(initialItem.filename);
        const previousFocus = document.activeElement;
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
                <div class="image-modal-meta" aria-live="polite"></div>
                <div class="image-modal-actions">
                    <button class="btn" data-modal-action="prev">← Prev</button>
                    <button class="btn" data-modal-action="next">Next →</button>
                    <button class="btn" data-modal-action="doc">View Source Document</button>
                    <a href="${esc(initialImageUrl)}" download class="btn">Download Image</a>
                </div>
            </div>
        `;
        const close = () => {
            document.removeEventListener('keydown', onKey);
            modal.remove();
            currentHash = `images/${imagesState.offset}`;
            history.replaceState(null, '', `#${currentHash}`);
            if (previousFocus instanceof HTMLElement) previousFocus.focus();
        };
        const renderModalImage = () => {
            const item = imagesState.items[imagesState.index];
            const imgEl = modal.querySelector('img');
            const dl = modal.querySelector('a[download]');
            const meta = modal.querySelector('.image-modal-meta');
            const itemUrl = imageApiUrl(item.filename);
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
        modal.querySelector('.image-modal-close').addEventListener('click', close);
        modal.querySelector('[data-modal-action="prev"]').addEventListener('click', () => move(-1));
        modal.querySelector('[data-modal-action="next"]').addEventListener('click', () => move(1));
        modal.querySelector('[data-modal-action="doc"]').addEventListener('click', () => {
            const item = imagesState.items[imagesState.index];
            viewDoc(item.docId);
            document.removeEventListener('keydown', onKey);
            modal.remove();
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
        setView('doc');
        resultsView.innerHTML = '<div class="loading">Loading</div>';
        currentHash = newHash;
        if (!skipPush) history.pushState(null, '', `#${newHash}`);

        try {
            const doc = await fetch(`${API}/documents/${id}`).then(r => r.json());
            const docTitle = esc(doc.title || doc.filename);
            const docTitleClass = titleClass(doc.title || doc.filename);
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
                            <audio controls preload="metadata">
                                <source src="${API}/documents/${id}/file" type="${doc.content_type || 'audio/wav'}">
                            </audio>
                        </div>
                    </div>
                `;
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
                            <video controls preload="metadata" poster="${API}/videos/${id}/thumb" data-buffering-video>
                                <source src="${API}/documents/${id}/file" type="${doc.content_type || 'video/mp4'}">
                            </video>
                            <div class="video-buffering" role="status" aria-live="polite" aria-hidden="false">
                                <span class="video-buffering-spinner" aria-hidden="true"></span>
                                <span data-buffering-label>Loading video…</span>
                            </div>
                            </div>
                        </div>
                    </div>
                `;
                initVideoBuffering();
                return;
            }

            // PDF/Text
            const text = await fetch(`${API}/documents/${id}/text`).then(r => r.json()).catch(() => null);
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
                            <button class="btn" data-action="pdf-text">Toggle Text</button>
                            <a href="${pdfUrl}" target="_blank" class="btn">New Tab</a>
                            <a href="${pdfUrl}" download class="btn">Download</a>
                        </div>
                    </div>
                    <div id="pdf-view" style="height:80vh;">
                        <iframe id="pdf-iframe" title="${docTitle} PDF viewer" style="width:100%;height:100%;border:none;border-radius:8px;background:var(--pdf-bg);"></iframe>
                    </div>
                    <div id="text-view" class="doc-content" style="display:none;">${esc(text?.full_text || 'No text available.')}</div>
                </div>
            `;
            // Load PDF as blob to bypass Chrome cross-origin restrictions
            try {
                const pdfResponse = await fetch(pdfUrl);
                if (!pdfResponse.ok) {
                    throw new Error('PDF fetch failed');
                }
                const pdfBlob = await pdfResponse.blob();
                revokePdfBlobUrl();
                currentPdfBlobUrl = URL.createObjectURL(pdfBlob);
                document.getElementById('pdf-iframe').src = currentPdfBlobUrl;
            } catch (e) {
                document.getElementById('pdf-view').innerHTML = '<div style="padding:20px;color:var(--text-dim);">Failed to load PDF. <a href="' + pdfUrl + '" target="_blank" style="color:var(--accent);">Open in new tab</a></div>';
            }
        } catch (e) {
            resultsView.innerHTML = `
                <div class="error-state">
                    <h3>Failed to load document</h3>
                    <p>Check your connection and try again.</p>
                    <button class="btn" data-action="doc" data-id="${Number(id)}">Retry</button>
                </div>
            `;
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
        if (pdf.style.display === 'none') {
            pdf.style.display = 'block';
            txt.style.display = 'none';
        } else {
            pdf.style.display = 'none';
            txt.style.display = 'block';
        }
    }

    // === ENTITY ===
    async function viewEntity(id, offset = 0, skipPush = false) {
        const newHash = `entity/${id}/${offset}`;
        saveScrollPosition();
        setView('entity');
        resultsView.innerHTML = '<div class="loading">Loading</div>';
        currentHash = newHash;
        if (!skipPush) history.pushState(null, '', `#${newHash}`);

        try {
            const [entity, mentions, cooc] = await Promise.all([
                fetch(`${API}/entities/${id}`).then(r => r.json()),
                fetch(`${API}/entities/${id}/mentions?limit=50&offset=${offset}`).then(r => r.json()),
                fetch(`${API}/entities/${id}/co-occurrences?limit=16`).then(r => r.json()).catch(() => ({ results: [] })),
            ]);

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
                html += '<div class="empty">No mentions found.</div>';
            }

            // Pagination
            const totalMentions = entity.mention_count || 0;
            if (totalMentions > 50 || offset > 0) {
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
        } catch (e) {
            resultsView.innerHTML = `
                <div class="error-state">
                    <h3>Failed to load entity</h3>
                    <p>Check your connection and try again.</p>
                    <button class="btn" data-action="entity" data-id="${Number(id)}" data-offset="${offset}">Retry</button>
                </div>
            `;
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
                    This site indexes public records from official releases of the Jeffrey Epstein case and preserves links back to source material.
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
