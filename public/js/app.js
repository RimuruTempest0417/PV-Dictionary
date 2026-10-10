/* 應用程式主流程：載入書本／單元、切換、搜尋、登入、管理區塊開關 */
        if (window.PDGuide) window.PDGuide.init();
(function () {
    const api = window.PDApi;
    const { el, clear, toast, setFormMessage } = window.PDUI;
    const t = (key, vars) => window.PDI18n.t(key, vars);
    const errText = (err) => window.PDI18n.errorMessage(err);

    const state = {
        twoFactorSetup: null,      /* 正在設定的 2FA 密鑰（畫面用，不落地） */
        twoFactorCodes: [],        /* 剛開啟時顯示一次的備援碼 */
        books: [],
        units: [],
        entries: [],
        currentBookId: null,
        currentUnitId: null,
        currentBookGrade: '',
        currentUnit: null,
        query: '',
        /* D-1：分頁狀態（畫面上的清單目前是哪一頁、總共幾筆、還有沒有下一頁） */
        entriesMeta: { page: 1, per_page: 0, total: 0, has_more: false },
        health: null,
        /* 三個畫面：shelf（書架）→ units（目錄）→ vocab（生字表） */
        view: 'shelf'
    };
    window.PDState = state;

    /* ---------------- CSP 自我檢查 ----------------
     * 行內事件或行內樣式被 CSP 擋掉時，畫面看起來完全正常、按下去卻沒反應，
     * 而且不會有任何例外。這裡把違規記錄下來，檢查腳本（與除錯）才有依據。 */
    function installCspRecorder() {
        window.__cspViolations = window.__cspViolations || [];
        document.addEventListener('securitypolicyviolation', (event) => {
            window.__cspViolations.push({
                directive: event.effectiveDirective || event.violatedDirective || '',
                blocked: event.blockedURI || '',
                at: Date.now()
            });
        });
    }

    /* ---------------- 版本與後端資訊 ---------------- */
    async function loadVersion() {
        try {
            const info = await api.get('/api/version');
            document.getElementById('versionLabel').textContent = `v${info.version}`;
            /* ★ 標題不要寫死品牌名：v0.5.0 更名時這裡漏改，線上分頁標題一直是舊名字（E-3 的真瀏覽器檢查抓到） */
            document.title = `Gary-Dictionary v${info.version}`;
        } catch (err) {
            /* 版本顯示失敗不影響使用 */
        }
    }

    async function loadHealth() {
        try {
            const info = await api.get('/api/health');
            state.health = info;
            const key = `backend.${info.backend}`;
            const label = window.PDI18n.has(key) ? t(key) : (info.backend_label || info.backend);
            document.getElementById('backendLabel').textContent = t('app.footerSource', { name: label });
        } catch (err) {
            document.getElementById('backendLabel').textContent = t('toast.loadFailed', { message: err.message });
        }
    }

    /* ---------------- 三個畫面的切換 ---------------- */

    /* 一次只顯示一個畫面：書架 → 目錄 → 生字表。
     * ★ 可見性只在這裡決定（其他函式只負責填內容），否則兩邊互相覆蓋會出現「畫面空白」的鬼故事。 */
    /* 調整單元順序（B-4）：一次交換，完成後重新載入目錄 */
    async function moveUnit(unitId, direction) {
        try {
            await window.PDApi.post(`/api/units/${unitId}/move`, { direction });
            await reloadUnits(state.currentBookId);
        } catch (err) {
            toast(errText(err), 'error');
        }
    }

    /* 複製單元（B-4）：名稱預設加「（複製）」，複製出來的是待審核、沒有錄音 */
    async function duplicateUnit(unit) {
        const title = t('unit.copyTitle', { title: unit.title || `Unit ${unit.unit_no}` });
        try {
            const result = await window.PDApi.post(`/api/units/${unit.id}/duplicate`, { title });
            toast(t('unit.duplicated', { n: result.entries }));
            await reloadUnits(state.currentBookId);
        } catch (err) {
            toast(errText(err), 'error');
        }
    }

    /* 調整書本順序（B-4）：書架卡片上的 ↑↓（只有能管理教材的人看得到） */
    async function moveBook(bookId, direction) {
        try {
            await window.PDApi.post(`/api/books/${bookId}/move`, { direction });
            await reloadBooks();
        } catch (err) {
            toast(errText(err), 'error');
        }
    }

    /* 「我的單元」（C-1）：登入後一眼看到「我可以編輯的單元」，點一下直接跳過去 */
    async function renderMyUnits() {
        const box = document.getElementById('myUnitsBlock');
        const list = document.getElementById('myUnitsList');
        if (!box || !list) return;
        if (!window.PDAuth.isLoggedIn() || !window.PDAuth.can('can_edit')) {
            box.hidden = true;
            list.textContent = '';
            return;
        }
        try {
            const data = await window.PDApi.get('/api/my/units');
            list.textContent = '';
            if (!data.units.length) {
                const item = el('li', { class: 'my-units-empty', text: t('myUnits.empty') });
                list.appendChild(item);
            }
            for (const unit of data.units) {
                const chip = el('button', {
                    class: 'my-units-chip',
                    attrs: { type: 'button', 'data-unit-id': unit.id, 'data-book-id': unit.book_id, title: `${unit.grade || ''} · Unit ${unit.unit_no}` },
                    dataset: { unitId: unit.id, bookId: unit.book_id }
                }, [
                    el('span', { class: 'my-units-book', text: unit.grade || '' }),
                    el('span', { text: `Unit ${unit.unit_no}${unit.title ? ` · ${unit.title}` : ''}` }),
                    el('span', { class: 'cell-hint', text: `${unit.entries}${unit.pending ? ` · ${t('myUnits.pending', { n: unit.pending })}` : ''}` })
                ]);
                chip.addEventListener('click', async () => {
                    await selectBook(unit.book_id);
                    await selectUnit(unit.id);
                });
                list.appendChild(chip);
            }
            box.hidden = false;
        } catch (err) {
            box.hidden = true;
        }
    }

    /* ---------------- 外觀：主題與字級（F-3／F-5） ----------------
     * 兩個選擇都記在 localStorage，重新載入後還在。
     * 「跟隨系統」＝不設 data-theme，交給 CSS 的 prefers-color-scheme；
     * 明確選了就設 data-theme 覆蓋它。
     */
    const THEME_KEY = 'pv-theme';
    const FONT_KEY = 'pv-font';
    const PRINT_KEY = 'pv-print';
    const THEME_VALUES = ['auto', 'light', 'dark'];
    /* v0.6.5（使用者指定）：只留 'm'（A，16px）與 'l'（A+，19px），**移除 's'（A−）**。
     * 舊裝置記著的 'pv-font' = 's' 不在這份清單裡 → readSetting 會回預設 'm'，自動回到 A。 */
    const FONT_VALUES = ['m', 'l'];

    function readSetting(key, allowed, fallback) {
        try {
            const value = window.localStorage.getItem(key);
            return allowed.includes(value) ? value : fallback;
        } catch (err) {
            return fallback;                 /* 無痕模式可能禁止 localStorage：不能因此壞掉 */
        }
    }

    function writeSetting(key, value) {
        try {
            window.localStorage.setItem(key, value);
        } catch (err) {
            /* 忽略：記不住只影響下次開啟，不影響這次使用 */
        }
    }

    function applyTheme(value) {
        const theme = THEME_VALUES.includes(value) ? value : 'auto';
        if (theme === 'auto') delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = theme;
        document.querySelectorAll('#themeSwitch [data-theme-value]').forEach((button) => {
            button.setAttribute('aria-pressed', String(button.dataset.themeValue === theme));
        });
        writeSetting(THEME_KEY, theme);
    }

    function applyFont(value) {
        const font = FONT_VALUES.includes(value) ? value : 'm';
        if (font === 'm') delete document.documentElement.dataset.font;
        else document.documentElement.dataset.font = font;
        document.querySelectorAll('#fontSwitch [data-font-value]').forEach((button) => {
            button.setAttribute('aria-pressed', String(button.dataset.fontValue === font));
        });
        writeSetting(FONT_KEY, font);
    }

    /* 列印時要包含什麼（B-5）：用 body 上的 data 標記，交給 print.css 隱藏 */
    function applyPrintOptions(options) {
        const zh = options.zh !== false;
        const example = options.example !== false;
        if (zh) delete document.body.dataset.printNoZh;
        else document.body.dataset.printNoZh = '1';
        if (example) delete document.body.dataset.printNoExample;
        else document.body.dataset.printNoExample = '1';
        writeSetting(PRINT_KEY, zh ? (example ? 'both' : 'zh') : (example ? 'example' : 'none'));
    }

    function initAppearance() {
        applyTheme(readSetting(THEME_KEY, THEME_VALUES, 'auto'));
        applyFont(readSetting(FONT_KEY, FONT_VALUES, 'm'));
        const stored = readSetting(PRINT_KEY, ['both', 'zh', 'example', 'none'], 'both');
        const zhBox = document.getElementById('printZh');
        const exampleBox = document.getElementById('printExample');
        if (zhBox) zhBox.checked = stored === 'both' || stored === 'zh';
        if (exampleBox) exampleBox.checked = stored === 'both' || stored === 'example';
        applyPrintOptions({ zh: zhBox ? zhBox.checked : true, example: exampleBox ? exampleBox.checked : true });

        for (const button of document.querySelectorAll('#themeSwitch [data-theme-value]')) {
            button.addEventListener('click', () => applyTheme(button.dataset.themeValue));
        }
        for (const button of document.querySelectorAll('#fontSwitch [data-font-value]')) {
            button.addEventListener('click', () => applyFont(button.dataset.fontValue));
        }
        for (const box of [zhBox, exampleBox]) {
            if (box) {
                box.addEventListener('change', () => applyPrintOptions({
                    zh: document.getElementById('printZh').checked,
                    example: document.getElementById('printExample').checked
                }));
            }
        }
    }

    /* ---------------- 鍵盤操作（F-4） ----------------
     * 1. 「/」或 Ctrl/⌘+K → 跳到搜尋框（在輸入框裡打字時不要搶）
     * 2. Esc → 關掉最上層的東西（錄音視窗／登入視窗／說明頁／管理區）
     * 3. 全域快捷鍵都要看得到（說明頁有寫），所以不做隱藏組合鍵。
     */
    function isTypingTarget(node) {
        if (!node) return false;
        const tag = String(node.tagName || '').toLowerCase();
        return tag === 'input' || tag === 'textarea' || tag === 'select' || node.isContentEditable === true;
    }

    function closeTopLayer() {
        const audioModal = document.getElementById('audioModal');
        if (audioModal && !audioModal.hidden) {
            window.PDAudio.stopTts();
            window.PDAudio.stopAudio();
            document.getElementById('audioCancelBtn').click();
            return true;
        }
        const loginModal = document.getElementById('loginModal');
        if (loginModal && !loginModal.hidden) {
            document.getElementById('loginCancelBtn').click();
            return true;
        }
        const passwordModal = document.getElementById('passwordModal');
        if (passwordModal && !passwordModal.hidden) {
            document.getElementById('passwordCancelBtn').click();
            return true;
        }
        const guide = document.getElementById('guidePanel');
        if (guide && !guide.hidden) {
            window.PDGuide.close();
            return true;
        }
        const admin = document.getElementById('adminSection');
        if (admin && !admin.hidden) {
            window.PDAdmin.showPanel(null);
            admin.hidden = true;
            const toggle = document.getElementById('adminToggleBtn');
            if (toggle) toggle.setAttribute('aria-expanded', 'false');
            return true;
        }
        return false;
    }

    function initKeyboard() {
        document.addEventListener('keydown', (event) => {
            if ((event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                const search = document.getElementById('searchInput');
                if (search && !search.closest('#searchWrap').hidden) search.focus();
                return;
            }
            if (event.key === '/' && !isTypingTarget(event.target)) {
                const search = document.getElementById('searchInput');
                if (search && !search.closest('#searchWrap').hidden) {
                    event.preventDefault();
                    search.focus();
                }
                return;
            }
            if (event.key === 'Escape' && closeTopLayer()) event.preventDefault();
        });
    }

    /* 「▶ 播放全部」（B-2）：依畫面上的順序一個一個播，中途可以停。
     * 正在播的那一張會加上 .is-playing，讓學生知道現在播到哪裡。 */
    let playlist = null;
    function stopsPlaylist() {
        if (playlist) playlist.stop();
        playlist = null;
        document.querySelectorAll('#vocabList .vocab-item.is-playing').forEach((node) => node.classList.remove('is-playing'));
        const button = document.getElementById('playAllBtn');
        if (button) button.textContent = t('unit.playAll');
    }

    let playingEntryId = null;
    let searchTimer = null;       /* D-1：搜尋的 debounce 計時器 */

    function markPlaying(entry) {
        playingEntryId = entry ? entry.id : null;
        document.querySelectorAll('#vocabList .vocab-item.is-playing').forEach((node) => node.classList.remove('is-playing'));
        if (!entry) return;
        const card = document.querySelector(`#vocabList .vocab-item[data-entry-id="${entry.id}"]`);
        if (card) card.classList.add('is-playing');
    }

    /* D-1：連續播放要整個單元的生字 → 先一頁一頁抓完（播放是明確的使用者動作，值得這幾個請求） */
    async function ensureAllEntriesLoaded() {
        let meta = state.entriesMeta;
        let guard = 0;
        while (meta && meta.has_more && guard < 50) {
            guard += 1;
            const data = await api.get(unitPageUrl({ page: (meta.page || 1) + 1 }));
            const seen = new Set(state.entries.map((entry) => String(entry.id)));
            for (const entry of (data.entries || [])) {
                if (!seen.has(String(entry.id))) state.entries.push(entry);
            }
            meta = {
                page: data.page || (meta.page || 1) + 1,
                per_page: data.per_page || meta.per_page,
                total: typeof data.total === 'number' ? data.total : meta.total,
                has_more: Boolean(data.has_more)
            };
            state.entriesMeta = meta;
        }
        renderVocab();
        renderLoadMore();
    }

    async function togglePlayAll() {
        const button = document.getElementById('playAllBtn');
        if (!button) return;
        if (playlist) {
            stopsPlaylist();
            return;
        }
        /* D-1：分頁之下畫面可能只有第一頁 → 播放全部之前先把整個單元載完 */
        await ensureAllEntriesLoaded();
        const entries = state.entries.slice();
        if (!entries.length) return;
        button.textContent = t('unit.stopPlay');
        /* 先標第一個：播放裝置可能慢半拍才出聲，學生要馬上看到「現在從哪裡開始」 */
        markPlaying(entries[0]);
        playlist = window.PDPlaylist.create({
            onChange: (entry) => markPlaying(entry),
            onDone: () => stopsPlaylist(),
            onStop: () => {
                if (window.PDAudio) {
                    window.PDAudio.stopTts();
                    window.PDAudio.stopAudio();
                }
            }
        });
        playlist.run(entries);
    }

    function showView(name) {
        state.view = name;
        document.getElementById('shelfView').hidden = name !== 'shelf';
        document.getElementById('unitsView').hidden = name !== 'units';
        document.getElementById('unitSection').hidden = name !== 'vocab';
        /* 使用說明（B-1）是第四個「畫面」，切過去時書架／目錄／生字表都要收起來 */
        const guide = document.getElementById('guidePanel');
        if (guide) guide.hidden = name !== 'guide';
        /* 搜尋只對「目前單元的生字表」有意義 */
        document.getElementById('searchWrap').hidden = name !== 'vocab';
        updateEmptyState();
    }

    function updateEmptyState() {
        const empty = document.getElementById('emptyState');
        const noBooks = state.books.length === 0;
        const firstText = empty.querySelector('.empty-state-text');
        if (firstText) {
            firstText.textContent = noBooks ? t('picker.noBooks') : t('picker.noUnits');
        }
        empty.hidden = !(state.view === 'shelf' && noBooks);
        /* 「建立順序」那幾步只有能編輯的人才做得到，學生看到標題就好 */
        const canEdit = window.PDAuth.can('can_edit');
        const steps = empty.querySelector('.empty-state-steps');
        const stepsTitle = empty.querySelector('.empty-state-steps-title');
        if (steps) steps.hidden = !canEdit;
        if (stepsTitle) stepsTitle.hidden = !canEdit;
    }

    /* ---------------- 書架（封面 + 書名） ---------------- */
    function renderShelf() {
        const box = document.getElementById('bookShelf');
        clear(box);
        for (const book of state.books) {
            const meta = [
                t('count.units', { n: book.unit_count }),
                t('unit.words', { n: book.entry_count })
            ].filter(Boolean).join(' · ');
            /* v0.5.0：書架只看得到年級（封面與書名都不再顯示）。 */
            const gradeLabel = el('span', { class: 'shelf-grade', text: book.grade || '—' });
            const children = [
                el('button', {
                    class: 'shelf-card',
                    attrs: { type: 'button', 'data-book-id': book.id, 'aria-label': t('shelf.gradeAria', { grade: book.grade || '—' }) },
                    on: { click: () => selectBook(book.id).catch((err) => toast(errText(err), 'error')) }
                }, [
                    gradeLabel,
                    el('span', { class: 'shelf-meta', text: meta })
                ])
            ];
            /* 調整書本順序（B-4）：只有能管理教材的人看得到，按鈕要 stopPropagation，
             * 不然會變成「按 ↑ 卻打開了那本書」。 */
            if (window.PDAuth.can('can_manage_content')) {
                children.push(el('div', { class: 'shelf-tools' }, [
                    el('button', {
                        class: 'btn btn-ghost btn-small',
                        text: '↑',
                        attrs: { type: 'button', 'data-action': 'move-book', 'data-book-id': book.id, 'data-direction': 'up', title: t('book.moveUp'), 'aria-label': t('book.moveUp') },
                        on: {
                            click: (event) => {
                                event.stopPropagation();
                                moveBook(book.id, 'up');
                            }
                        }
                    }),
                    el('button', {
                        class: 'btn btn-ghost btn-small',
                        text: '↓',
                        attrs: { type: 'button', 'data-action': 'move-book', 'data-book-id': book.id, 'data-direction': 'down', title: t('book.moveDown'), 'aria-label': t('book.moveDown') },
                        on: {
                            click: (event) => {
                                event.stopPropagation();
                                moveBook(book.id, 'down');
                            }
                        }
                    })
                ]));
            }
            box.appendChild(el('li', { class: 'shelf-item' }, children));
        }
        updateEmptyState();
    }

    /* ---------------- 目錄（單元列表） ---------------- */
    function renderUnitList() {
        const box = document.getElementById('unitList');
        clear(box);
        document.getElementById('unitsTitle').textContent = state.currentBookGrade || '—';
        document.getElementById('unitsMeta').textContent = state.units.length
            ? t('count.units', { n: state.units.length })
            : '';
        document.getElementById('unitsEmpty').hidden = state.units.length > 0;
        /* 老師以上在每一列多一顆 ✏️（修改單元名稱／編號）；學生與科代表看不到（後端也會再擋） */
        const canEditUnits = window.PDAuth.can('can_manage_content');   /* 修改單元＝後端 can_manage_content */
        for (const unit of state.units) {
            const words = t('unit.words', { n: unit.published_count });
            const pending = unit.pending_count ? ` · ${t('unit.pending', { n: unit.pending_count })}` : '';
            const row = el('li', { class: 'unit-row', dataset: { unitId: unit.id } }, [
                el('button', {
                    class: 'unit-row-btn',
                    attrs: { type: 'button', 'data-unit-id': unit.id },
                    on: { click: () => selectUnit(unit.id).catch((err) => toast(errText(err), 'error')) }
                }, [
                    el('span', { class: 'unit-row-no', text: `Unit ${unit.unit_no}` }),
                    el('span', { class: 'unit-row-title', text: unit.title || '' }),
                    el('span', { class: 'unit-row-count', text: `${words}${pending}` })
                ])
            ]);
            if (canEditUnits) {
                /* ↑ ↓ 調整順序、⧉ 複製單元（B-4）：都由伺服器做「一次做完的交換」，
                 * 前端不要自己算編號（連續兩個互換時前端做會撞到「同書不重複」的檢查）。 */
                const tools = el('div', { class: 'unit-row-tools' }, [
                    el('button', {
                        class: 'unit-row-edit',
                        text: '✏️',
                        attrs: { type: 'button', 'data-action': 'edit-unit', title: t('unit.editTitle'), 'aria-label': t('unit.editTitle') },
                        on: { click: () => window.PDAdmin.openUnitEdit(unit.id) }
                    }),
                    el('button', {
                        class: 'unit-row-edit',
                        text: '↑',
                        attrs: { type: 'button', 'data-action': 'move-unit', 'data-direction': 'up', title: t('unit.moveUp'), 'aria-label': t('unit.moveUp') },
                        on: { click: () => moveUnit(unit.id, 'up') }
                    }),
                    el('button', {
                        class: 'unit-row-edit',
                        text: '↓',
                        attrs: { type: 'button', 'data-action': 'move-unit', 'data-direction': 'down', title: t('unit.moveDown'), 'aria-label': t('unit.moveDown') },
                        on: { click: () => moveUnit(unit.id, 'down') }
                    }),
                    el('button', {
                        class: 'unit-row-edit',
                        text: '⧉',
                        attrs: { type: 'button', 'data-action': 'duplicate-unit', title: t('unit.duplicate'), 'aria-label': t('unit.duplicate') },
                        on: { click: () => duplicateUnit(unit) }
                    })
                ]);
                row.appendChild(tools);
            }
            box.appendChild(row);
        }
    }

    function renderUnitHead() {
        const unit = state.currentUnit;
        if (!unit) return;
        document.getElementById('unitTitle').textContent
            = `Unit ${unit.unit_no}${unit.title ? ` · ${unit.title}` : ''}`;
        const published = state.entries.filter((entry) => entry.status === 'published').length;
        const pending = state.entries.filter((entry) => entry.status === 'pending').length;
        const parts = [unit.grade || state.currentBookGrade, t('unit.words', { n: published })];
        if (pending) parts.push(t('unit.pending', { n: pending }));
        document.getElementById('unitMeta').textContent = parts.filter(Boolean).join(' · ');
        document.getElementById('printBtn').hidden = false;
        const hint = document.getElementById('unitHint');
        if (!window.PDAudio.ttsSupported()) {
            hint.hidden = false;
            hint.textContent = t('unit.noTts');
        } else {
            hint.hidden = true;
        }
    }

    function renderVocab() {
        const result = window.PDVocab.render(state.entries, {
            canEdit: window.PDAuth.can('can_edit'),
            canPublish: window.PDAuth.can('can_publish'),
            canUploadAudio: window.PDAuth.can('can_upload_audio'),
            query: state.query,
            total: state.entries.length
        });
        if (state.query && result.shown !== result.total) {
            const meta = document.getElementById('unitMeta');
            const base = meta.dataset.base || meta.textContent;
            meta.dataset.base = base;
            meta.textContent = `${base} · ${t('unit.found', { n: result.shown })}`;
        } else if (state.query === '') {
            const meta = document.getElementById('unitMeta');
            if (meta.dataset.base) meta.textContent = meta.dataset.base;
        }
        /* 如果正在連續播放，畫面重畫之後要把「正在播」的標記補回去
         * （不然匯入／重新載入完成時剛好蓋掉，學生會以為停止播放了）。 */
        if (playingEntryId) markPlaying({ id: playingEntryId });
    }

    async function reloadBooks() {
        /* 第一次載入（還沒有任何資料）先顯示骨架屏，不要給使用者空白畫面 */
        const skeleton = document.getElementById('shelfSkeleton');
        const shelf = document.getElementById('bookShelf');
        const firstLoad = !state.books.length;
        if (skeleton && shelf && firstLoad) {
            skeleton.hidden = false;
            shelf.hidden = true;
        }
        try {
            const data = await api.get('/api/books');
            state.books = data.books || [];
        } finally {
            if (skeleton) skeleton.hidden = true;
            if (shelf) shelf.hidden = false;
        }
        renderShelf();
    }

    /* D-1：抓目前單元的「待審核」生字（伺服器端過濾；看不到 pending 的身分會拿到空清單） */
    async function fetchPendingEntries() {
        if (!state.currentUnitId) return [];
        if (!window.PDAuth.can('can_edit')) return [];
        try {
            const data = await api.get(`/api/units/${state.currentUnitId}?status=pending&per_page=200`);
            return data.entries || [];
        } catch (err) {
            return [];
        }
    }

    /* D-1：組出單元生字表的分頁網址（搜尋字串也在這裡帶上） */
    function unitPageUrl({ page = 1 } = {}) {
        const params = new URLSearchParams();
        params.set('page', String(page));
        const query = (state.query || '').trim();
        if (query) params.set('q', query);
        return `/api/units/${state.currentUnitId}?${params.toString()}`;
    }

    /* D-1：「載入更多」按鈕與「已顯示 n／total」提示 */
    function renderLoadMore() {
        const button = document.getElementById('loadMoreBtn');
        const note = document.getElementById('loadMoreNote');
        if (!button || !note) return;
        const meta = state.entriesMeta || { total: state.entries.length, has_more: false };
        const shown = state.entries.length;
        const more = Boolean(meta.has_more) && shown < meta.total;
        button.hidden = !more;
        button.disabled = false;
        note.hidden = meta.total <= (meta.per_page || shown) && !more;
        note.textContent = note.hidden ? '' : t('unit.loadMoreNote', { shown, total: meta.total });
    }

    async function loadMoreEntries() {
        const meta = state.entriesMeta;
        if (!meta || !meta.has_more) return;
        const button = document.getElementById('loadMoreBtn');
        button.disabled = true;
        try {
            const data = await api.get(unitPageUrl({ page: (meta.page || 1) + 1 }));
            const seen = new Set(state.entries.map((entry) => String(entry.id)));
            for (const entry of (data.entries || [])) {
                if (!seen.has(String(entry.id))) state.entries.push(entry);
            }
            state.entriesMeta = {
                page: data.page || (meta.page || 1) + 1,
                per_page: data.per_page || meta.per_page,
                total: typeof data.total === 'number' ? data.total : meta.total,
                has_more: Boolean(data.has_more)
            };
            renderVocab();
            renderLoadMore();
        } catch (err) {
            window.PDUI.toast(window.PDI18n.errorMessage(err), 'error');
            button.disabled = false;
        }
    }

    async function reloadUnits(bookId) {
        const data = await api.get(`/api/books/${bookId}/units`);
        state.units = data.units || [];
        state.currentBookGrade = data.book ? data.book.grade : '';
        renderUnitList();
    }

    async function reloadUnit(options) {
        if (!state.currentUnitId) return;
        /* D-1：一頁一頁抓（page／per_page／q 都交給伺服器）。
         * state.entries 永遠代表「畫面上這一份清單」，不是「這個單元的所有生字」。 */
        const firstPage = 1;
        const data = await api.get(unitPageUrl({ page: firstPage }));
        state.entries = data.entries || [];
        state.entriesMeta = {
            page: data.page || firstPage,
            per_page: data.per_page || (data.entries || []).length,
            total: typeof data.total === 'number' ? data.total : (data.entries || []).length,
            has_more: Boolean(data.has_more)
        };
        state.currentUnit = data.unit;
        renderLoadMore();
        /* 順便把單元清單的數字更新：新增／刪除／核准生字後，
         * chips 上的生字數也要跟著變，否則畫面上兩個地方的數字會不一致。 */
        if (state.currentBookId) {
            const list = await api.get(`/api/books/${state.currentBookId}/units`);
            state.units = list.units || [];
            state.currentBookGrade = list.book ? list.book.grade : state.currentBookGrade;
        }
        renderUnitList();
        renderUnitHead();
        renderVocab();
        /* D-1：待審核清單不能只看畫面上那一頁（分頁之後可能還有沒載入的待審核生字）
         * → 另外抓一次「這個單元所有 pending」（老師／科代表才看得到）。 */
        window.PDAdmin.renderPending(await fetchPendingEntries());
        window.PDAdmin.refreshAvailability();
        if (typeof options === 'object' && options && options.keepForm) {
            /* 表單保持開啟（連續輸入情境） */
        } else {
            document.getElementById('entryForm').hidden = true;
        }
    }

    /* 封面 → 目錄（不自動選第一個單元：使用者要自己選） */
    async function selectBook(bookId) {
        state.currentBookId = bookId;
        state.currentUnitId = null;
        state.entries = [];
        state.currentUnit = null;
        await reloadUnits(bookId);
        showView('units');
        renderUnitHead();
        renderVocab();
        window.PDAdmin.refreshAvailability();
        window.PDAdmin.renderPending([]);
        await window.PDAdmin.loadAudit();
    }

    /* 目錄 → 生字表 */
    async function selectUnit(unitId) {
        state.currentUnitId = unitId;
        showView('vocab');
        await reloadUnit();
        await window.PDAdmin.loadAudit();
    }

    function backToShelf() {
        state.query = '';
        document.getElementById('searchInput').value = '';
        showView('shelf');
        /* 回到書架＝沒有選取任何書本：管理區的按鈕與提示要立刻跟著變（與 backToUnits 同一個道理） */
        window.PDAdmin.refreshAvailability();
    }

    function backToUnits() {
        state.query = '';
        document.getElementById('searchInput').value = '';
        state.currentUnitId = null;
        state.entries = [];
        state.currentUnit = null;
        showView('units');
        renderUnitList();
        renderVocab();
        /* 回到目錄＝沒有選取任何單元：管理區的按鈕與提示要立刻跟著變，
         * 不能等到使用者下次打開管理區才更新（不然會停在「已選單元」的狀態）。 */
        window.PDAdmin.refreshAvailability();
    }

    /* ---------------- 登入狀態 ---------------- */
    function renderAuth() {
        const area = document.getElementById('authArea');
        clear(area);
        const user = window.PDAuth.user;
        if (!user) {
            area.appendChild(el('button', {
                class: 'btn btn-primary',
                text: t('nav.login'),
                attrs: { type: 'button', id: 'loginBtn' },
                on: { click: openLoginModal }
            }));
            return;
        }
        /* 「✏️ 管理」放在這裡（而不是單元卡片裡）：完全沒有書本與單元時也要進得去，
         * 否則第一次使用時永遠建立不了第一本書。 */
        if (window.PDAuth.can('can_edit')) {
            const adminOpen = !document.getElementById('adminSection').hidden;
            area.appendChild(el('button', {
                class: 'btn btn-secondary',
                text: adminOpen ? t('nav.manageClose') : t('nav.manage'),
                attrs: { type: 'button', id: 'adminToggleBtn' },
                on: { click: toggleAdminSection }
            }));
        }
        area.appendChild(el('span', { class: 'user-chip' }, [
            /* 顯示名稱若與角色名稱相同（manager 的顯示名稱就叫「網頁管理員」），改顯示帳號，
             * 免得標題列出現「網頁管理員 網頁管理員」。兩種語言的標籤都比對一次，
             * 這樣切換語言時顯示不會跳動。 */
            el('strong', {
                text: user.display_name && ![user.role_label, window.PDI18n.roleLabel(user.role)].includes(user.display_name)
                    ? user.display_name
                    : user.username
            }),
            el('span', { text: window.PDI18n.roleLabel(user.role) })
        ]));
        area.appendChild(el('button', {
            class: 'btn btn-ghost',
            text: '🔑',
            attrs: { type: 'button', id: 'passwordBtn', title: t('password.open'), 'aria-label': t('password.open') },
            on: { click: openPasswordModal }
        }));
        area.appendChild(el('button', {
            class: 'btn btn-ghost',
            text: t('nav.logout'),
            attrs: { type: 'button', id: 'logoutBtn' },
            on: { click: doLogout }
        }));
        /* 帳號／授權／稽核都是管理選單裡的分頁：可見性交給 showPanel() 決定，
         * 這裡只更新「哪些分頁按鈕該出現」（沒有權限的分頁按鈕會直接藏起來）。 */
        window.PDAdmin.refreshAvailability();
    }

    async function toggleAdminSection() {
        const section = document.getElementById('adminSection');
        const button = document.getElementById('adminToggleBtn');
        section.hidden = !section.hidden;
        if (button) button.textContent = section.hidden ? t('nav.manage') : t('nav.manageClose');
        if (section.hidden) return;
        /* 打開管理區時，預設停在最常用的分頁：有待審核就看待審核，否則直接新增生字 */
        const pendingBtn = document.getElementById('navPendingBtn');
        const entryBtn = document.getElementById('newEntryBtn');
        window.PDAdmin.showPanel(pendingBtn && !pendingBtn.hidden && !pendingBtn.disabled ? 'pending' : 'entry');
        await window.PDAdmin.refreshAvailability();
        await window.PDUsers.refresh();
    }

    /* 切換語言：靜態文字由 i18n 掃描更新，動態內容靠 pd:langchange 事件重畫 */
    function setLanguage(lang) {
        window.PDI18n.setLang(lang);
    }

    function openLoginModal() {
        document.getElementById('loginModal').hidden = false;
        setFormMessage(document.getElementById('loginMsg'), '');
        document.getElementById('loginUsername').focus();
    }

    /* 修改自己的密碼（任何登入者都能用；要輸入目前的密碼） */
    /* ---------------- 兩步驟驗證（A-1，v0.4.3） ---------------- */
    function twoFactorUi() {
        return {
            state: document.getElementById('twoFactorState'),
            setup: document.getElementById('twoFactorSetup'),
            secret: document.getElementById('twoFactorSecret'),
            code: document.getElementById('twoFactorCode'),
            backupBox: document.getElementById('twoFactorBackupBox'),
            backupCodes: document.getElementById('twoFactorBackupCodes'),
            msg: document.getElementById('twoFactorMsg'),
            startBtn: document.getElementById('twoFactorStartBtn'),
            enableBtn: document.getElementById('twoFactorEnableBtn'),
            disableBtn: document.getElementById('twoFactorDisableBtn')
        };
    }

    function renderTwoFactor() {
        const ui = twoFactorUi();
        if (!ui.state) return;
        const user = window.PDAuth.user;
        const on = Boolean(user && user.two_factor);
        const codes = Array.isArray(state.twoFactorCodes) ? state.twoFactorCodes : [];
        ui.state.textContent = on
            ? t('twoFactor.stateOn', { n: state.twoFactorBackupCount || 0 })
            : t('twoFactor.stateOff');
        ui.startBtn.hidden = on;
        ui.disableBtn.hidden = !on;
        ui.setup.hidden = !state.twoFactorSetup;
        ui.backupBox.hidden = codes.length === 0;
        if (state.twoFactorSetup && state.twoFactorSetup.secret) {
            ui.secret.textContent = state.twoFactorSetup.secret;
        }
        if (codes.length) ui.backupCodes.textContent = codes.join('  ·  ');
    }

    async function startTwoFactorSetup() {
        const ui = twoFactorUi();
        try {
            const data = await api.post('/api/auth/2fa/setup', {});
            state.twoFactorSetup = { secret: data.secret, otpauth_url: data.otpauth_url };
            state.twoFactorCodes = [];
            setFormMessage(ui.msg, t('twoFactor.setupNote'), 'ok');
            renderTwoFactor();
            ui.code.value = '';
            ui.code.focus();
        } catch (err) {
            setFormMessage(ui.msg, window.PDI18n.errorMessage(err), 'error');
        }
    }

    async function enableTwoFactor() {
        const ui = twoFactorUi();
        const code = ui.code.value.trim();
        if (!code) return setFormMessage(ui.msg, t('twoFactor.code'), 'error');
        try {
            const data = await api.post('/api/auth/2fa/enable', { code });
            state.twoFactorCodes = data.backup_codes || [];
            state.twoFactorSetup = null;
            window.PDAuth.state.user = Object.assign({}, window.PDAuth.user, { two_factor: true });
            setFormMessage(ui.msg, t('twoFactor.enabled'), 'ok');
            toast(t('twoFactor.copied'));
            renderTwoFactor();
        } catch (err) {
            setFormMessage(ui.msg, window.PDI18n.errorMessage(err), 'error');
        }
    }

    async function disableTwoFactor() {
        const ui = twoFactorUi();
        const password = document.getElementById('currentPassword').value;
        if (!password) return setFormMessage(ui.msg, t('password.current'), 'error');
        try {
            await api.post('/api/auth/2fa/disable', { password });
            window.PDAuth.state.user = Object.assign({}, window.PDAuth.user, { two_factor: false });
            state.twoFactorSetup = null;
            state.twoFactorCodes = [];
            setFormMessage(ui.msg, t('twoFactor.disabled'), 'ok');
            renderTwoFactor();
        } catch (err) {
            setFormMessage(ui.msg, window.PDI18n.errorMessage(err), 'error');
        }
    }

    function openPasswordModal() {
        state.twoFactorSetup = null;
        state.twoFactorCodes = [];
        const ui = twoFactorUi();
        if (ui.msg) setFormMessage(ui.msg, '');
        renderTwoFactor();
        document.getElementById('passwordModal').hidden = false;
        document.getElementById('currentPassword').value = '';
        document.getElementById('newPassword').value = '';
        setFormMessage(document.getElementById('passwordMsg'), '');
        document.getElementById('currentPassword').focus();
    }

    function closePasswordModal() {
        document.getElementById('passwordModal').hidden = true;
        document.getElementById('currentPassword').value = '';
        document.getElementById('newPassword').value = '';
    }

    async function submitPassword(event) {
        event.preventDefault();
        const msg = document.getElementById('passwordMsg');
        const button = document.getElementById('passwordSaveBtn');
        button.disabled = true;
        try {
            await api.post('/api/auth/change-password', {
                current_password: document.getElementById('currentPassword').value,
                new_password: document.getElementById('newPassword').value
            });
            closePasswordModal();
            toast(t('password.saved'));
        } catch (err) {
            setFormMessage(msg, errText(err), 'error');
        } finally {
            button.disabled = false;
        }
    }

    function setLoginTwoFactor(active) {
        const block = document.getElementById('login2faBlock');
        const code = document.getElementById('login2faCode');
        const submit = document.getElementById('loginSubmitBtn');
        block.hidden = !active;
        if (submit) submit.textContent = active ? t('login.twoFactorCode') : t('login.submit');
        if (active) {
            code.value = '';
            code.focus();
        } else {
            code.value = '';
        }
    }

    function closeLoginModal() {
        document.getElementById('loginModal').hidden = true;
        document.getElementById('loginPassword').value = '';
        setLoginTwoFactor(false);
        window.PDAuth.state.challenge = '';
    }

    async function doLogin(event) {
        event.preventDefault();
        const msg = document.getElementById('loginMsg');
        const twoFactorActive = document.getElementById('login2faBlock').hidden === false;
        try {
            if (twoFactorActive) {
                await window.PDAuth.loginTwoFactor(document.getElementById('login2faCode').value);
            } else {
                const result = await window.PDAuth.login(
                    document.getElementById('loginUsername').value.trim(),
                    document.getElementById('loginPassword').value
                );
                /* 這個帳號開了兩步驟驗證：留在同一個彈窗，請使用者輸入驗證碼 */
                if (result && result.two_factor_required) {
                    setLoginTwoFactor(true);
                    setFormMessage(msg, t('login.twoFactorNote'), 'ok');
                    return;
                }
            }
            setFormMessage(msg, '');
            closeLoginModal();
            renderAuth();
            toast(t('login.welcome', { name: window.PDAuth.user.display_name, role: window.PDI18n.roleLabel(window.PDAuth.user.role) }));
            /* A-8：來源與上次不同時提醒一次（不是錯誤，只是讓使用者有機會發現異常登入） */
            if (window.PDAuth.state.newDevice) {
                window.PDAuth.state.newDevice = false;
                toast(t('login.newDevice'), 'error');
            }
            await refreshAfterAuthChange();
        } catch (err) {
            setFormMessage(msg, window.PDI18n.errorMessage(err), 'error');
        }
    }

    async function doLogout() {
        await window.PDAuth.logout();
        renderAuth();
        document.getElementById('adminSection').hidden = true;
        window.PDAdmin.showPanel(null);
        toast(t('login.loggedOut'));
        await refreshAfterAuthChange();
    }

    async function refreshAfterAuthChange() {
        await reloadBooks();
        if (state.currentBookId) await reloadUnits(state.currentBookId);
        await reloadUnit();
        const canEdit = window.PDAuth.can('can_edit');
        if (!canEdit) document.getElementById('adminSection').hidden = true;
        if (!canEdit) window.PDAdmin.showPanel(null);
        /* 換人登入後，目前畫面可能已經不該顯示（例如學生看到一半被登出） */
        if (state.view === 'vocab' && !state.currentUnit) showView('units');
        await renderMyUnits();
        renderShelf();
        renderUnitHead();
        renderVocab();
        updateEmptyState();
    }

    /* ---------------- 事件綁定 ---------------- */
    function bindEvents() {
        document.getElementById('bookShelf').addEventListener('click', (event) => {
            const button = event.target.closest('[data-book-id]');
            if (button) selectBook(button.dataset.bookId).catch((err) => toast(errText(err), 'error'));
        });
        document.getElementById('unitList').addEventListener('click', (event) => {
            const button = event.target.closest('[data-unit-id]');
            if (button) selectUnit(button.dataset.unitId).catch((err) => toast(errText(err), 'error'));
        });
        document.getElementById('playAllBtn').addEventListener('click', togglePlayAll);
        document.getElementById('unitsBackBtn').addEventListener('click', backToShelf);
        document.getElementById('vocabBackBtn').addEventListener('click', backToUnits);
        /* 管理區的選單：按哪個才顯示哪一塊（管理頁面太長了） */
        document.getElementById('adminNav').addEventListener('click', (event) => {
            const button = event.target.closest('[data-admin-tab]');
            if (button) window.PDAdmin.showPanel(button.dataset.adminTab);
        });
        document.getElementById('loadMoreBtn').addEventListener('click', () => {
            loadMoreEntries();
        });
        document.getElementById('searchInput').addEventListener('input', (event) => {
            state.query = event.target.value;
            /* D-1：生字表是分頁的 → 搜尋要回伺服器（不能只過濾手上這一頁，否則會找不到還沒載入的字）。
             * 打太快會一直重抓，所以等手停下來 300ms 再送。 */
            if (window.clearTimeout(searchTimer)) window.clearTimeout(searchTimer);
            searchTimer = window.setTimeout(() => {
                if (state.currentUnitId) reloadUnit({ keepForm: true });
            }, 300);
            renderVocab();
        });
        document.getElementById('langSwitch').addEventListener('click', (event) => {
            const button = event.target.closest('[data-lang]');
            if (!button) return;
            setLanguage(button.dataset.lang);
        });
        /* 換語言：靜態文字由 i18n 掃過，動態產生的內容（清單、待審核、角色標籤）要在這裡重畫 */
        document.addEventListener('pd:langchange', (event) => {
            const buttons = document.querySelectorAll('#langSwitch [data-lang]');
            buttons.forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.lang === event.detail.lang)));
            renderAuth();
            renderShelf();
            renderUnitList();
            renderUnitHead();
            renderVocab();
            updateEmptyState();
            /* D-1：待審核清單是另外抓的（非同步）—— 這個監聽器本身不能 await，只好 then */
            fetchPendingEntries().then((pending) => window.PDAdmin.renderPending(pending));
            window.PDAdmin.refreshAvailability();
            if (!document.getElementById('auditBlock').hidden) window.PDAdmin.loadAudit();
            if (!document.getElementById('usersBlock').hidden) window.PDUsers.refresh();
            toast(event.detail.lang === 'zh' ? t('toast.langChanged') : 'Language: English');
        });
        document.getElementById('printBtn').addEventListener('click', () => {
            const zhBox = document.getElementById('printZh');
            const exampleBox = document.getElementById('printExample');
            applyPrintOptions({
                zh: zhBox ? zhBox.checked : true,
                example: exampleBox ? exampleBox.checked : true
            });
            window.print();
        });
        document.getElementById('loginForm').addEventListener('submit', doLogin);
        document.getElementById('passwordForm').addEventListener('submit', submitPassword);
        document.getElementById('twoFactorStartBtn').addEventListener('click', startTwoFactorSetup);
        document.getElementById('twoFactorEnableBtn').addEventListener('click', enableTwoFactor);
        document.getElementById('twoFactorDisableBtn').addEventListener('click', disableTwoFactor);
        document.getElementById('passwordCancelBtn').addEventListener('click', closePasswordModal);
        document.getElementById('passwordModal').addEventListener('click', (event) => {
            if (event.target.id === 'passwordModal') closePasswordModal();
        });
        document.getElementById('loginCancelBtn').addEventListener('click', closeLoginModal);
        document.getElementById('loginModal').addEventListener('click', (event) => {
            if (event.target.id === 'loginModal') closeLoginModal();
        });
    }

    /* ---------------- 啟動 ---------------- */
    async function boot() {
        const lang = window.PDI18n.init();
        document.querySelectorAll('#langSwitch [data-lang]').forEach((btn) => {
            btn.setAttribute('aria-pressed', String(btn.dataset.lang === lang));
        });
        installCspRecorder();
        initAppearance();
        initKeyboard();
        await Promise.all([loadVersion(), loadHealth()]);
        try {
            await window.PDAuth.loadMe();
        } catch (err) {
            /* 未登入是正常狀態 */
        }
        window.PDAdmin.init();
        window.PDUsers.init();
        bindEvents();
        renderAuth();
        try {
            await reloadBooks();
            /* 首頁是書架：學生要先看到書本封面，點進去才是目錄，再點單元才看到生字表 */
            showView('shelf');
            renderUnitHead();
            renderVocab();
            stopsPlaylist();
            window.PDAdmin.refreshAvailability();
            await renderMyUnits();
        } catch (err) {
            toast(t('toast.loadFailed', { message: err.message }), 'error');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    /* 供其他模組（admin.js）在動作完成後要求重新載入畫面。
     * 沒有把這幾個函式掛出來時，症狀是「API 成功、畫面沒更新」——而且不會有任何例外。 */
    /* 錯誤回報要在最早期安裝（後面的程式出錯才抓得到） */
    if (window.PDErrorLog && typeof window.PDErrorLog.install === 'function') window.PDErrorLog.install();

    window.PDApp = {
        renderAuth,
        reloadBooks,
        reloadUnits,
        reloadUnit,
        selectBook,
        selectUnit,
        showView,
        backToShelf,
        backToUnits,
        renderShelf,
        renderUnitList,
        updateEmptyState,
        refreshAfterAuthChange,
        renderVocab,
        renderUnitHead,
        setLanguage,
        applyTheme,
        applyFont,
        applyPrintOptions,
        initAppearance,
        initKeyboard,
        get view() {
            return state.view;
        }
    };
})();
