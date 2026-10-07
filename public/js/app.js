/* 應用程式主流程：載入書本／單元、切換、搜尋、登入、管理區塊開關 */
(function () {
    const api = window.PDApi;
    const { el, clear, toast, setFormMessage } = window.PDUI;
    const t = (key, vars) => window.PDI18n.t(key, vars);

    const state = {
        books: [],
        units: [],
        entries: [],
        currentBookId: null,
        currentUnitId: null,
        currentBookName: '',
        currentUnit: null,
        query: '',
        health: null
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

    /* ---------------- 書本與單元 ---------------- */
    function renderBookTabs() {
        const box = document.getElementById('bookTabs');
        clear(box);
        for (const book of state.books) {
            box.appendChild(el('button', {
                text: `${book.name}（${book.unit_count}）`,
                attrs: {
                    type: 'button',
                    role: 'tab',
                    'aria-selected': String(String(book.id) === String(state.currentBookId)),
                    'data-book-id': book.id
                }
            }));
        }
    }

    function renderUnitTabs() {
        const box = document.getElementById('unitTabs');
        clear(box);
        for (const unit of state.units) {
            const label = `Unit ${unit.unit_no}${unit.title ? ` · ${unit.title}` : ''}`;
            const chip = el('button', {
                attrs: {
                    type: 'button',
                    role: 'tab',
                    'aria-selected': String(String(unit.id) === String(state.currentUnitId)),
                    'data-unit-id': unit.id
                }
            }, [
                el('span', { text: label }),
                el('span', { class: 'chip-count', text: `${unit.published_count}${unit.pending_count ? `+${unit.pending_count}⏳` : ''}` })
            ]);
            box.appendChild(chip);
        }
    }

    function renderUnitHead() {
        const unit = state.currentUnit;
        const section = document.getElementById('unitSection');
        const empty = document.getElementById('emptyState');
        if (!unit) {
            section.hidden = true;
            /* 沒有可選的單元時要給學生一個清楚的起始畫面，不能只留一片空白。 */
            const firstText = empty.querySelector('.empty-state-text');
            if (firstText) {
                firstText.textContent = state.books.length === 0 ? t('picker.noBooks') : t('picker.noUnits');
            }
            empty.hidden = false;
            return;
        }
        section.hidden = false;
        empty.hidden = true;
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
        const data = await api.get('/api/books');
        state.books = data.books || [];
        renderBookTabs();
    }

    async function reloadUnits(bookId) {
        const data = await api.get(`/api/books/${bookId}/units`);
        state.units = data.units || [];
        state.currentBookName = data.book ? data.book.name : '';
        renderUnitTabs();
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
        renderUnitTabs();
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

    async function selectBook(bookId) {
        state.currentBookId = bookId;
        renderBookTabs();
        await reloadUnits(bookId);
        if (state.units.length) {
            await selectUnit(state.units[0].id);
        } else {
            state.currentUnitId = null;
            state.entries = [];
            state.currentUnit = null;
            renderUnitTabs();
            renderUnitHead();
            renderVocab();
            window.PDAdmin.refreshAvailability();
        }
        await window.PDAdmin.loadAudit();
    }

    async function selectUnit(unitId) {
        state.currentUnitId = unitId;
        renderUnitTabs();
        await reloadUnit();
        await window.PDAdmin.loadAudit();
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
            text: t('nav.logout'),
            attrs: { type: 'button', id: 'logoutBtn' },
            on: { click: doLogout }
        }));
        const auditBlock = document.getElementById('auditBlock');
        auditBlock.hidden = !window.PDAuth.can('can_view_audit');
    }

    async function toggleAdminSection() {
        const section = document.getElementById('adminSection');
        const button = document.getElementById('adminToggleBtn');
        section.hidden = !section.hidden;
        if (button) button.textContent = section.hidden ? t('nav.manage') : t('nav.manageClose');
        if (section.hidden) return;
        await window.PDAdmin.refreshAvailability();
        await window.PDAdmin.loadAudit();
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
        document.getElementById('entryForm').hidden = true;
        toast(t('login.loggedOut'));
        await refreshAfterAuthChange();
    }

    async function refreshAfterAuthChange() {
        await reloadBooks();
        if (state.currentBookId) await reloadUnits(state.currentBookId);
        await reloadUnit();
        const canEdit = window.PDAuth.can('can_edit');
        if (!canEdit) document.getElementById('adminSection').hidden = true;
        renderUnitHead();
        renderVocab();
    }

    /* ---------------- 事件綁定 ---------------- */
    function bindEvents() {
        document.getElementById('bookTabs').addEventListener('click', (event) => {
            const button = event.target.closest('[data-book-id]');
            if (button) selectBook(button.dataset.bookId).catch((err) => toast(err.message, 'error'));
        });
        document.getElementById('unitTabs').addEventListener('click', (event) => {
            const button = event.target.closest('[data-unit-id]');
            if (button) selectUnit(button.dataset.unitId).catch((err) => toast(err.message, 'error'));
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
            renderUnitHead();
            renderVocab();
            window.PDAdmin.renderPending(state.entries);
            window.PDAdmin.refreshAvailability();
            if (!document.getElementById('auditBlock').hidden) window.PDAdmin.loadAudit();
            toast(event.detail.lang === 'zh' ? t('toast.langChanged') : 'Language: English');
        });
        document.getElementById('printBtn').addEventListener('click', () => window.print());
        document.getElementById('loginForm').addEventListener('submit', doLogin);
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
        bindEvents();
        renderAuth();
        try {
            await reloadBooks();
            if (state.books.length) {
                await selectBook(state.books[0].id);
            } else {
                // 完全沒有資料：顯示起始畫面（寫清楚下一步），不要只丟一句提示訊息
                renderUnitTabs();
                renderUnitHead();
                renderVocab();
                window.PDAdmin.refreshAvailability();
            }
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
        refreshAfterAuthChange,
        renderVocab,
        renderUnitHead,
        setLanguage
    };
})();
