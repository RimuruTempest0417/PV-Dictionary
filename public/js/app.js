/* 應用程式主流程：載入書本／單元、切換、搜尋、登入、管理區塊開關 */
(function () {
    const api = window.PDApi;
    const { el, clear, toast, setFormMessage } = window.PDUI;
    const t = (key, vars) => window.PDI18n.t(key, vars);
    const errText = (err) => window.PDI18n.errorMessage(err);

    const state = {
        books: [],
        units: [],
        entries: [],
        currentBookId: null,
        currentUnitId: null,
        currentBookName: '',
        currentUnit: null,
        query: '',
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
            document.title = `PV_Dictionary v${info.version}`;
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
    function showView(name) {
        state.view = name;
        document.getElementById('shelfView').hidden = name !== 'shelf';
        document.getElementById('unitsView').hidden = name !== 'units';
        document.getElementById('unitSection').hidden = name !== 'vocab';
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
                book.grade,
                t('count.units', { n: book.unit_count }),
                t('unit.words', { n: book.entry_count })
            ].filter(Boolean).join(' · ');
            /* 封面網址帶 cover_updated_at 當版本號：換封面後學生不會看到舊圖（快取） */
            const cover = book.has_cover
                ? el('img', {
                    class: 'shelf-cover-img',
                    attrs: {
                        src: `${book.cover_url}?v=${encodeURIComponent(book.cover_updated_at || '1')}`,
                        alt: '',
                        loading: 'lazy'
                    }
                })
                : el('span', { class: 'shelf-cover-fallback', text: String(book.code || book.name || '?').slice(0, 6) });
            box.appendChild(el('li', { class: 'shelf-item' }, [
                el('button', {
                    class: 'shelf-card',
                    attrs: { type: 'button', 'data-book-id': book.id, 'aria-label': book.name },
                    on: { click: () => selectBook(book.id).catch((err) => toast(errText(err), 'error')) }
                }, [
                    el('span', { class: 'shelf-cover' }, [cover]),
                    el('span', { class: 'shelf-name', text: book.name }),
                    el('span', { class: 'shelf-meta', text: meta })
                ])
            ]));
        }
        updateEmptyState();
    }

    /* ---------------- 目錄（單元列表） ---------------- */
    function renderUnitList() {
        const box = document.getElementById('unitList');
        clear(box);
        document.getElementById('unitsTitle').textContent = state.currentBookName || '—';
        document.getElementById('unitsMeta').textContent = state.units.length
            ? t('count.units', { n: state.units.length })
            : '';
        document.getElementById('unitsEmpty').hidden = state.units.length > 0;
        for (const unit of state.units) {
            const words = t('unit.words', { n: unit.published_count });
            const pending = unit.pending_count ? ` · ${t('unit.pending', { n: unit.pending_count })}` : '';
            box.appendChild(el('li', { class: 'unit-row' }, [
                el('button', {
                    class: 'unit-row-btn',
                    attrs: { type: 'button', 'data-unit-id': unit.id },
                    on: { click: () => selectUnit(unit.id).catch((err) => toast(errText(err), 'error')) }
                }, [
                    el('span', { class: 'unit-row-no', text: `Unit ${unit.unit_no}` }),
                    el('span', { class: 'unit-row-title', text: unit.title || '' }),
                    el('span', { class: 'unit-row-count', text: `${words}${pending}` })
                ])
            ]));
        }
    }

    function renderUnitHead() {
        const unit = state.currentUnit;
        if (!unit) return;
        document.getElementById('unitTitle').textContent
            = `Unit ${unit.unit_no}${unit.title ? ` · ${unit.title}` : ''}`;
        const published = state.entries.filter((entry) => entry.status === 'published').length;
        const pending = state.entries.filter((entry) => entry.status === 'pending').length;
        const parts = [unit.book_name || state.currentBookName, t('unit.words', { n: published })];
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

    async function reloadUnits(bookId) {
        const data = await api.get(`/api/books/${bookId}/units`);
        state.units = data.units || [];
        state.currentBookName = data.book ? data.book.name : '';
        renderUnitList();
    }

    async function reloadUnit(options) {
        if (!state.currentUnitId) return;
        const data = await api.get(`/api/units/${state.currentUnitId}`);
        state.entries = data.entries || [];
        state.currentUnit = data.unit;
        /* 順便把單元清單的數字更新：新增／刪除／核准生字後，
         * chips 上的生字數也要跟著變，否則畫面上兩個地方的數字會不一致。 */
        if (state.currentBookId) {
            const list = await api.get(`/api/books/${state.currentBookId}/units`);
            state.units = list.units || [];
            state.currentBookName = list.book ? list.book.name : state.currentBookName;
        }
        renderUnitList();
        renderUnitHead();
        renderVocab();
        window.PDAdmin.renderPending(state.entries);
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
    function openPasswordModal() {
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

    function closeLoginModal() {
        document.getElementById('loginModal').hidden = true;
        document.getElementById('loginPassword').value = '';
    }

    async function doLogin(event) {
        event.preventDefault();
        const msg = document.getElementById('loginMsg');
        try {
            await window.PDAuth.login(
                document.getElementById('loginUsername').value.trim(),
                document.getElementById('loginPassword').value
            );
            setFormMessage(msg, '');
            closeLoginModal();
            renderAuth();
            toast(t('login.welcome', { name: window.PDAuth.user.display_name, role: window.PDI18n.roleLabel(window.PDAuth.user.role) }));
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
        document.getElementById('unitsBackBtn').addEventListener('click', backToShelf);
        document.getElementById('vocabBackBtn').addEventListener('click', backToUnits);
        /* 管理區的選單：按哪個才顯示哪一塊（管理頁面太長了） */
        document.getElementById('adminNav').addEventListener('click', (event) => {
            const button = event.target.closest('[data-admin-tab]');
            if (button) window.PDAdmin.showPanel(button.dataset.adminTab);
        });
        document.getElementById('searchInput').addEventListener('input', (event) => {
            state.query = event.target.value;
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
            window.PDAdmin.renderPending(state.entries);
            window.PDAdmin.refreshAvailability();
            window.PDAdmin.renderCoverPanel();
            if (!document.getElementById('auditBlock').hidden) window.PDAdmin.loadAudit();
            if (!document.getElementById('usersBlock').hidden) window.PDUsers.refresh();
            toast(event.detail.lang === 'zh' ? t('toast.langChanged') : 'Language: English');
        });
        document.getElementById('printBtn').addEventListener('click', () => window.print());
        document.getElementById('loginForm').addEventListener('submit', doLogin);
        document.getElementById('passwordForm').addEventListener('submit', submitPassword);
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
            window.PDAdmin.refreshAvailability();
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
    window.PDApp = {
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
        setLanguage
    };
})();
