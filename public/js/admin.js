/* 管理功能（老師以上；科代表可新增但進待審核）
 * 全部走自家 API；權限一律由後端重新驗證，前端只是「不顯示你不能用的按鈕」。
 */
(function () {
    const { el, clear, toast, setFormMessage, formatDateTime } = window.PDUI;
    const api = window.PDApi;
    const t = (key, vars) => window.PDI18n.t(key, vars);
    /* ★ 一定要在這裡自己定義：errText 原本只定義在 app.js 的 IIFE 裡（不是全域），
     *   admin.js 的錯誤路徑每次都會丟 ReferenceError（正式站日誌 UNHANDLED_REJECTION），
     *   導致「真正的錯誤訊息」被蓋掉。tests/frontend-scope.test.js 會守門。 */
    const errText = (err) => window.PDI18n.errorMessage(err);

    let pendingCleanup = false;    /* 清理稽核紀錄的兩段式確認（第一次只預覽） */

    const state = {
        editingId: null,
        editingEntry: null,          /* D-2：記住讀到的那一筆（送 updated_at 當版本） */
        audioEntryId: null,
        recorder: null,
        recordedChunks: [],
        recordTimer: null
    };

    /* ---------------- 管理選單：一次只顯示一塊 ---------------- */
    /* 使用者反映「管理頁面太長了」：管理區改成選單，按哪個才顯示哪一塊。
     * 每個分頁對應一個面板 id；可見性只在 showPanel() 決定，其他函式不要自己動 hidden。 */
    const TABS = {
        pending: 'pendingBlock',
        entry: 'entryForm',
        import: 'importForm',
        unit: 'unitForm',
        unitEdit: 'unitEditForm',
        book: 'bookForm',
        audit: 'auditBlock',
        errors: 'errorsBlock',
        stats: 'statsBlock',
        users: 'usersBlock',
        grants: 'grantsBlock'
    };

    function tabAllowed(tab) {
        if (tab === 'pending' || tab === 'entry' || tab === 'import') return window.PDAuth.can('can_edit');
        if (tab === 'unit' || tab === 'unitEdit' || tab === 'book') return window.PDAuth.can('can_manage_content');
        if (tab === 'audit' || tab === 'errors' || tab === 'stats') return window.PDAuth.can('can_view_audit');
        if (tab === 'users' || tab === 'grants') return window.PDAuth.can('can_manage_users');
        return false;
    }

    function showPanel(tab) {
        const panelId = tab && TABS[tab] ? TABS[tab] : null;
        const open = Boolean(panelId) && tabAllowed(tab);
        for (const id of Object.values(TABS)) {
            const node = document.getElementById(id);
            if (node) node.hidden = !(open && id === panelId);
        }
        for (const button of document.querySelectorAll('#adminNav [data-admin-tab]')) {
            const active = open && button.dataset.adminTab === tab;
            button.setAttribute('aria-selected', String(Boolean(active)));
            button.classList.toggle('is-active', Boolean(active));
        }
        if (open) {
            if (tab === 'audit') loadAudit();
            if (tab === 'errors') loadErrors();
            if (tab === 'stats') loadStats();
            if (tab === 'users' || tab === 'grants') window.PDUsers.refresh();
            if (tab === 'unitEdit') fillUnitEditOptions();
        }
        /* v0.6.0：年級清單與「修改年級」表單跟著「📗 新增年級」分頁一起出現／收起。
         * ★ 一定要在 return 之前（第一次寫在 return 之後，那段程式永遠不會執行，
         *   畫面症狀是「點了新增年級，清單卻不出現」）。 */
        const gradeListBlock = document.getElementById('gradeListBlock');
        if (gradeListBlock) gradeListBlock.hidden = !(open && tab === 'book');
        const gradeEditForm = document.getElementById('gradeEditForm');
        if (gradeEditForm && !(open && tab === 'book')) gradeEditForm.hidden = true;
        if (open && tab === 'book') renderGradeList();
        return open ? panelId : null;
    }

    /* 依「目前有沒有書本／單元」與角色更新管理選單的可用狀態。
     * 第一次使用時資料是空的：沒有書本就沒有單元、沒有單元就不能加生字；
     * 按鈕要直接停用並說明原因，而不是按下去才報錯。 */
    function refreshAvailability() {
        const appState = window.PDState || {};
        const hasBook = Boolean(appState.currentBookId);
        const hasUnit = Boolean(appState.currentUnitId);
        const canEdit = window.PDAuth.can('can_edit');

        for (const button of document.querySelectorAll('#adminNav [data-admin-tab]')) {
            const tab = button.dataset.adminTab;
            const allowed = tabAllowed(tab);
            button.hidden = !allowed;
            button.disabled = !allowed
                || ((tab === 'unit' || tab === 'unitEdit') && !hasBook)
                || ((tab === 'entry' || tab === 'import') && !hasUnit);
        }

        const unitBtn = document.getElementById('newUnitBtn');
        const entryBtn = document.getElementById('newEntryBtn');
        document.getElementById('newBookBtn').title = t('admin.titleNewBook');
        unitBtn.title = hasBook ? t('admin.titleUnitFor', { book: appState.currentBookGrade || '—' }) : t('admin.titleNeedBook');
        entryBtn.title = hasUnit ? '' : t('admin.titleNeedUnit');
        document.getElementById('importToggleBtn').title = entryBtn.title;

        /* 提示要分清三種情況（使用者回報：目錄明明有單元，卻顯示「這本書還沒有單元」）：
         *   1. 連書本都沒有        → 警告色：先建立書本
         *   2. 這本書真的沒有單元  → 警告色：先建立單元
         *   3. 有單元、只是還沒點進去 → 中性色：點開其中一個就能加入生字（這不是問題，不該用警告色）
         * 判斷「這本書有沒有單元」要用 PDState.units（書本層級的資料），不是 currentUnitId。 */
        const allBooks = window.PDState.books || [];
        const bookUnitCount = (window.PDState.units || []).length;
        const hint = document.getElementById('adminHint');
        let hintKey = '';
        let hintTone = 'warn';
        if (canEdit && !hasUnit) {
            if (!hasBook) {
                /* 書架上：有書但還沒點進去 ≠ 沒有書（使用者回報過兩次同一類錯誤） */
                if (allBooks.length === 0) hintKey = 'admin.hintNoBook';
                else {
                    hintKey = 'admin.hintPickBook';
                    hintTone = 'info';
                }
            } else if (bookUnitCount === 0) hintKey = 'admin.hintNoUnit';
            else {
                hintKey = 'admin.hintPickUnit';
                hintTone = 'info';
            }
        }
        hint.hidden = !hintKey;
        if (hintKey) {
            const count = hintKey === 'admin.hintPickBook' ? allBooks.length : bookUnitCount;
            hint.textContent = t(hintKey, { n: count });
            hint.dataset.tone = hintTone;
        }

        /* 開著的分頁若已經不該顯示（換了單元、資料被刪光），把它關掉，不要停在做不了事的表單上 */
        const openBtn = document.querySelector('#adminNav [data-admin-tab][aria-selected="true"]');
        if (openBtn && (openBtn.hidden || openBtn.disabled)) showPanel(null);
    }

    /* 從生字卡按「編輯」時，管理區如果沒開就自動打開（使用者回報：沒開管理頁面就看不到表單） */
    function ensureAdminOpen(tab) {
        const section = document.getElementById('adminSection');
        if (section.hidden) {
            section.hidden = false;
            const button = document.getElementById('adminToggleBtn');
            if (button) button.textContent = t('nav.manageClose');
        }
        refreshAvailability();
        showPanel(tab);
        if (section.scrollIntoView) section.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    function requireUnit() {
        if (!window.PDState.currentUnitId) {
            window.PDUI.toast(window.PDState.currentBookId ? t('admin.needUnit') : t('admin.needBookUnit'), 'error');
            return false;
        }
        return true;
    }

    function fillEntryForm(entry) {
        document.getElementById('entryId').value = entry ? entry.id : '';
        document.getElementById('fHeadword').value = entry ? entry.headword : '';
        document.getElementById('fPos').value = entry ? (entry.part_of_speech || '') : '';
        document.getElementById('fIpaUs').value = entry ? (entry.ipa_us || '') : '';
        document.getElementById('fIpaUk').value = entry ? (entry.ipa_uk || '') : '';
        document.getElementById('fZh').value = entry ? (entry.zh_meaning || '') : '';
        document.getElementById('fEn').value = entry ? (entry.en_definition || '') : '';
        document.getElementById('fExampleEn').value = entry ? (entry.example_en || '') : '';
        document.getElementById('fExampleZh').value = entry ? (entry.example_zh || '') : '';
    }

    function openEntryForm(entry) {
        if (!entry && !requireUnit()) return;
        state.editingId = entry ? entry.id : null;
        state.editingEntry = entry || null;
        fillEntryForm(entry || null);
        document.getElementById('entryFormTitle').textContent = entry
            ? t('entry.editTitle', { word: entry.headword })
            : t('entry.newTitle');
        document.getElementById('entryFormNote').textContent = entry ? t('entry.editNote') : t('entry.newNote');
        setFormMessage(document.getElementById('entryFormMsg'), '');
        ensureAdminOpen('entry');
        document.getElementById('fHeadword').focus();
    }

    function closeEntryForm() {
        state.editingId = null;
        state.editingEntry = null;
        showPanel(null);
        setFormMessage(document.getElementById('entryFormMsg'), '');
    }

    async function submitEntry(event) {
        event.preventDefault();
        const msg = document.getElementById('entryFormMsg');
        const unitId = window.PDState.currentUnitId;
        if (!unitId) {
            setFormMessage(msg, t('admin.needUnit'), 'error');
            return;
        }
        const payload = {
            headword: document.getElementById('fHeadword').value,
            part_of_speech: document.getElementById('fPos').value,
            ipa_us: document.getElementById('fIpaUs').value,
            ipa_uk: document.getElementById('fIpaUk').value,
            zh_meaning: document.getElementById('fZh').value,
            en_definition: document.getElementById('fEn').value,
            example_en: document.getElementById('fExampleEn').value,
            example_zh: document.getElementById('fExampleZh').value
        };
        const button = document.getElementById('saveEntryBtn');
        button.disabled = true;
        try {
            if (state.editingId) {
                /* D-2：帶著讀到的版本；別人先改過就會回 409 STALE_WRITE */
                const version = state.editingEntry ? state.editingEntry.updated_at : undefined;
                await api.patch(`/api/entries/${state.editingId}`, Object.assign({ version }, payload));
                setFormMessage(msg, t('entry.saved'), 'ok');
                toast(t('entry.toastUpdated'));
            } else {
                const result = await api.post(`/api/units/${unitId}/entries`, payload);
                setFormMessage(msg, result.status === 'pending' ? t('entry.createdPending') : t('entry.created'), 'ok');
                toast(result.status === 'pending' ? t('entry.toastPending') : t('entry.toastCreated'));
            }
            await window.PDApp.reloadUnit({ keepForm: true });
            if (!state.editingId) fillEntryForm(null);
        } catch (err) {
            setFormMessage(msg, window.PDI18n.errorMessage(err), 'error');
        } finally {
            button.disabled = false;
        }
    }

    /* ---------------- 批次貼上 ---------------- */
    function openImport() {
        if (!requireUnit()) return;
        setFormMessage(document.getElementById('importMsg'), '');
        ensureAdminOpen('import');
        document.getElementById('importText').focus();
    }

    /* ---------------- 從 CSV／Excel 匯入（B-3） ---------------- */
    const importState = { rows: [], mapping: [], headerSkipped: false };

    function importPreviewCell(tag, text, className) {
        return el(tag, { class: className || '', text: String(text == null ? '' : text) });
    }

    /* 讀檔 → 解析（.xlsx 走 PDXlsx.parseXlsx、CSV／TSV 走 parseDelimited）→ 畫出預覽與欄位對應 */
    async function loadImportFile(file) {
        const msg = document.getElementById('importFileMsg');
        const preview = document.getElementById('importPreview');
        if (!file) return;
        const isExcel = /\.xlsx$/i.test(file.name);
        try {
            let rows = [];
            if (isExcel) {
                const buffer = await file.arrayBuffer();
                rows = (await window.PDXlsx.parseXlsx(buffer)).rows;
            } else {
                rows = window.PDXlsx.parseDelimited(await file.text()).rows;
            }
            if (!rows.length) {
                setFormMessage(msg, t('import.empty'), 'error');
                preview.hidden = true;
                return;
            }
            const header = window.PDXlsx.looksLikeHeader(rows[0]) ? rows[0] : null;
            importState.rows = header ? rows.slice(1) : rows;
            importState.headerSkipped = Boolean(header);
            importState.mapping = header
                ? window.PDXlsx.guessMapping(header)
                : window.PDXlsx.defaultMapping(rows[0].length);
            /* 有沒有猜不到生字欄？沒有就預設第一欄（老師的檔案幾乎都是生字在第一欄） */
            if (!importState.mapping.includes('headword')) importState.mapping[0] = 'headword';
            setFormMessage(msg, t('import.fileParsed', { n: importState.rows.length }), 'ok');
            renderImportPreview(header);
            preview.hidden = false;
        } catch (err) {
            setFormMessage(msg, err.message || String(err), 'error');
            preview.hidden = true;
        }
    }

    function renderImportPreview(header) {
        const table = document.getElementById('importPreviewTable');
        const note = document.getElementById('importPreviewNote');
        const fields = window.PDXlsx.FIELD_ORDER;
        clear(table);
        const previewRows = importState.rows.slice(0, 8);
        const width = Math.max(importState.mapping.length, ...previewRows.map((row) => row.length), 1);

        /* 第一列：每一欄一個下拉（選擇這一欄對應到哪個欄位） */
        const headRow = el('tr');
        for (let column = 0; column < width; column += 1) {
            const cell = el('th');
            const select = el('select', { class: 'import-map', attrs: { 'data-column': column } });
            select.appendChild(el('option', { text: t('import.mapNone'), attrs: { value: '' } }));
            for (const field of fields) {
                select.appendChild(el('option', { text: t(`import.field.${field}`), attrs: { value: field } }));
            }
            select.value = importState.mapping[column] || '';
            select.addEventListener('change', () => { importState.mapping[column] = select.value; });
            cell.appendChild(select);
            headRow.appendChild(cell);
        }
        table.appendChild(headRow);
        if (header) {
            const origRow = el('tr');
            for (let column = 0; column < width; column += 1) origRow.appendChild(importPreviewCell('th', header[column] || '', 'cell-hint'));
            table.appendChild(origRow);
        }
        for (const row of previewRows) {
            const tr = el('tr');
            for (let column = 0; column < width; column += 1) tr.appendChild(importPreviewCell('td', row[column] || ''));
            table.appendChild(tr);
        }
        const entries = window.PDXlsx.toEntries(importState.rows, importState.mapping);
        const dupes = importState.rows.filter((row) => row.some((cell) => String(cell || '').trim())).length - entries.length;
        note.textContent = t('import.previewNote', { n: previewRows.length });
        const count = document.getElementById('importFileMsg');
        if (count) setFormMessage(count, t('import.previewCount', { rows: importState.rows.length, dupes: Math.max(0, dupes) }), 'ok');
    }

    async function runImportFile() {
        const msg = document.getElementById('importFileMsg');
        const unitId = window.PDState.currentUnitId;
        if (!unitId) {
            setFormMessage(msg, t('import.needUnit'), 'error');
            return;
        }
        const rows = window.PDXlsx.toEntries(importState.rows, importState.mapping)
            .map((entry, index) => Object.assign({ line: index + (importState.headerSkipped ? 2 : 1) }, entry));
        if (!rows.length) {
            setFormMessage(msg, t('import.empty'), 'error');
            return;
        }
        const button = document.getElementById('importFileRunBtn');
        button.disabled = true;
        try {
            const result = await api.post(`/api/units/${unitId}/entries/import`, { rows, source: 'file' });
            let parts = t('import.fileResult', { created: result.created });
            if (result.skipped) parts += t('import.skipped', { skipped: result.skipped });
            if (result.errors && result.errors.length) parts += t('import.errors', { n: result.errors.length });
            if (result.status === 'pending') parts += t('import.pendingNote');
            setFormMessage(msg, parts, result.created ? 'ok' : 'error');
            document.getElementById('importPreview').hidden = true;
            const input = document.getElementById('importFileInput');
            if (input) input.value = '';
            importState.rows = [];
            importState.mapping = [];
            await window.PDApp.reloadUnit({ keepForm: true });
        } catch (err) {
            setFormMessage(msg, window.PDI18n.errorMessage(err), 'error');
        } finally {
            button.disabled = false;
        }
    }

    function cancelImportFile() {
        importState.rows = [];
        importState.mapping = [];
        document.getElementById('importPreview').hidden = true;
        const input = document.getElementById('importFileInput');
        if (input) input.value = '';
        setFormMessage(document.getElementById('importFileMsg'), '', 'ok');
    }

    async function submitImport(event) {
        event.preventDefault();
        const msg = document.getElementById('importMsg');
        const unitId = window.PDState.currentUnitId;
        if (!unitId) {
            setFormMessage(msg, '請先建立或選擇一個單元', 'error');
            return;
        }
        const text = document.getElementById('importText').value;
        const button = document.getElementById('importBtn');
        button.disabled = true;
        try {
            const result = await api.post(`/api/units/${unitId}/entries/import`, { text });
            let parts = t('import.result', { created: result.created });
            if (result.skipped) parts += t('import.skipped', { skipped: result.skipped });
            if (result.errors && result.errors.length) parts += t('import.errors', { n: result.errors.length });
            if (result.status === 'pending') parts += t('import.pendingNote');
            setFormMessage(msg, parts, result.created ? 'ok' : 'error');
            document.getElementById('importText').value = '';
            await window.PDApp.reloadUnit({ keepForm: true });
        } catch (err) {
            setFormMessage(msg, window.PDI18n.errorMessage(err), 'error');
        } finally {
            button.disabled = false;
        }
    }

    /* ---------------- 新增單元／書本 ---------------- */
    async function submitUnit(event) {
        event.preventDefault();
        const msg = document.getElementById('unitMsg');
        const bookId = window.PDState.currentBookId;
        if (!bookId) return;
        try {
            const unitNo = Number(document.getElementById('fUnitNo').value);
            const title = document.getElementById('fUnitTitle').value;
            const result = await api.post(`/api/books/${bookId}/units`, { unit_no: unitNo, title });
            setFormMessage(msg, t('unitForm.done', { n: result.unit.unit_no }), 'ok');
            toast(t('unitForm.toast'));
            document.getElementById('fUnitTitle').value = '';
            showPanel(null);
            await window.PDApp.reloadBooks();
            await window.PDApp.selectUnit(result.unit.id);
        } catch (err) {
            setFormMessage(msg, window.PDI18n.errorMessage(err), 'error');
        }
    }

    async function submitBook(event) {
        event.preventDefault();
        const msg = document.getElementById('bookMsg');
        try {
            /* v0.5.0：只需要年級（代號由伺服器產生；書名不再存在於畫面上） */
            const result = await api.post('/api/books', {
                grade: document.getElementById('fBookGrade').value
            });
            setFormMessage(msg, t('bookForm.done', { grade: result.book.grade }), 'ok');
            toast(t('bookForm.toast'));
            document.getElementById('fBookGrade').value = '';
            showPanel(null);
            /* 書建立後直接進它的目錄（接著就能按「新增單元」），不要把使用者丟回書架 */
            await window.PDApp.reloadBooks();
            await window.PDApp.selectBook(result.book.id);
        } catch (err) {
            setFormMessage(msg, window.PDI18n.errorMessage(err), 'error');
        }
    }

    /* ---------------- 修改年級（v0.6.0，使用者指定） ----------------
     * 管理區的「📗 新增年級」分頁順便列出所有年級；每一列有 ✏️ 可以改名。
     * 為什麼要有：年級就是學生看到的課本（S1／S2），打錯字或升級後要能改，
     * 不然只能刪掉重建（會連單元與生字一起重來）。 */
    function renderGradeList() {
        const list = document.getElementById('gradeList');
        if (!list) return;
        list.textContent = '';
        const books = window.PDState.books || [];
        if (!books.length) {
            list.appendChild(el('li', { class: 'grade-row grade-row--empty', text: t('bookEdit.empty') }));
            return;
        }
        const canManage = window.PDAuth.can('can_manage_content');
        for (const book of books) {
            const row = el('li', { class: 'grade-row', dataset: { bookId: book.id } });
            row.appendChild(el('span', { class: 'grade-name', text: book.grade }));
            row.appendChild(el('span', {
                class: 'grade-meta',
                text: t('count.units', { n: book.unit_count || 0 })
            }));
            if (canManage) {
                row.appendChild(el('button', {
                    class: 'btn btn-ghost btn-icon',
                    type: 'button',
                    text: '✏️',
                    attrs: {
                        'data-action': 'edit-grade',
                        'data-book-id': book.id,
                        'aria-label': t('bookEdit.edit'),
                        title: t('bookEdit.edit')
                    }
                }));
                /* v0.12.0（B-8）：刪除年級（兩段式；有內容時只有網站管理員刪得掉 —— 後端會擋） */
                row.appendChild(el('button', {
                    class: 'btn btn-ghost btn-icon',
                    type: 'button',
                    text: '🗑',
                    attrs: {
                        'data-action': 'delete-grade',
                        'data-book-id': book.id,
                        'aria-label': t('delete.book'),
                        title: t('delete.book')
                    }
                }));
            }
            list.appendChild(row);
        }
    }

    /* ---------------- 刪除年級（v0.12.0／B-8，使用者指定） ----------------
     * 兩段式（不用原生 confirm）：第一次點 🗑 先打 delete-preview 看「會連帶刪掉多少」，
     * 在那一列下面長出確認列；第二次點「確定刪除」才真的刪（帶 ?confirm=1）。
     * 有內容（單元／生字／錄音）時只有網站管理員能刪：前端先講清楚，後端也會再擋一次。 */
    let pendingDeleteRow = null;

    function clearDeleteConfirm() {
        if (pendingDeleteRow) pendingDeleteRow.remove();
        pendingDeleteRow = null;
    }

    async function askDeleteBook(bookId, row) {
        clearDeleteConfirm();
        const book = (window.PDState.books || []).find((b) => String(b.id) === String(bookId));
        try {
            const preview = await api.get(`/api/books/${bookId}/delete-preview`);
            const counts = preview.counts || {};
            const line = el('li', { class: 'grade-row grade-row--confirm' });
            line.appendChild(el('span', {
                class: 'grade-meta',
                text: t('delete.bookPreview', {
                    units: counts.units || 0, entries: counts.entries || 0, audio: counts.audio || 0
                })
            }));
            if (preview.requires_site_manager) {
                line.appendChild(el('span', { class: 'grade-meta', text: t('delete.ownerOnly') }));
            }
            const confirmBtn = el('button', { class: 'btn btn-danger btn-small', type: 'button', text: t('delete.confirm') });
            confirmBtn.addEventListener('click', async () => {
                confirmBtn.disabled = true;
                try {
                    await api.del(`/api/books/${bookId}?confirm=1`);
                    clearDeleteConfirm();
                    toast(`${t('delete.done')}：${book ? book.grade : ''}`);
                    await window.PDApp.reloadBooks();
                    renderGradeList();
                } catch (err) {
                    confirmBtn.disabled = false;
                    toast(window.PDI18n.errorMessage(err), 'error');
                }
            });
            const cancelBtn = el('button', { class: 'btn btn-ghost btn-small', type: 'button', text: t('delete.cancel') });
            cancelBtn.addEventListener('click', clearDeleteConfirm);
            line.appendChild(confirmBtn);
            line.appendChild(cancelBtn);
            row.after(line);
            pendingDeleteRow = line;
        } catch (err) {
            toast(window.PDI18n.errorMessage(err), 'error');
        }
    }

    function openGradeEdit(bookId) {
        const book = (window.PDState.books || []).find((b) => String(b.id) === String(bookId));
        if (!book) return;
        document.getElementById('gradeEditId').value = book.id;
        document.getElementById('fGradeEditValue').value = book.grade;
        setFormMessage(document.getElementById('gradeEditMsg'), '');
        document.getElementById('gradeEditForm').hidden = false;
        document.getElementById('fGradeEditValue').focus();
        document.getElementById('fGradeEditValue').select();
    }

    async function submitGradeEdit(event) {
        event.preventDefault();
        const msgEl = document.getElementById('gradeEditMsg');
        const id = document.getElementById('gradeEditId').value;
        const grade = document.getElementById('fGradeEditValue').value.trim();
        const book = (window.PDState.books || []).find((b) => String(b.id) === String(id));
        try {
            const result = await api.patch(`/api/books/${id}`, { grade, version: book ? book.updated_at : undefined });
            setFormMessage(msgEl, t('bookEdit.done', { grade: result.book.grade }), 'ok');
            toast(t('bookEdit.toast'));
            document.getElementById('gradeEditForm').hidden = true;
            await window.PDApp.reloadBooks();
            renderGradeList();
        } catch (err) {
            /* 409 = 別人先改過：重新載入清單並提示（不要讓使用者以為存好了） */
            if (err && err.code === 'STALE_WRITE') {
                await window.PDApp.reloadBooks();
                renderGradeList();
            }
            setFormMessage(msgEl, window.PDI18n.errorMessage(err), 'error');
        }
    }

    /* ---------------- 刪除生字（兩段式確認，不用原生 confirm） ---------------- */
    async function deleteEntry(entryId, button) {
        const entry = (window.PDState.entries || []).find((e) => String(e.id) === String(entryId));
        if (!entry) return;
        if (button && button.dataset.confirm !== '1') {
            button.dataset.confirm = '1';
            button.textContent = t('action.deleteConfirm');
            window.setTimeout(() => {
                button.dataset.confirm = '';
                button.textContent = t('action.delete');
            }, 4000);
            return;
        }
        try {
            await api.del(`/api/entries/${entryId}`);
            toast(`${t('auditAction.ENTRY_DELETE')}：${entry.headword}`);
            await window.PDApp.reloadUnit();
        } catch (err) {
            toast(window.PDI18n.errorMessage(err), 'error');
        }
    }

    /* ---------------- 待審核 ---------------- */
    /* 批次審核（B-6）：把勾選的每一筆送出，回報成功／失敗筆數 */
    async function reviewBatch(action) {
        const ids = Array.from(document.querySelectorAll('#pendingList .pending-check:checked')).map((node) => node.dataset.entryId);
        if (!ids.length) return toast(t('errors.REVIEW_IDS_EMPTY'), 'error');
        const note = (document.getElementById('pendingBatchNote') || {}).value || '';
        const buttons = Array.from(document.querySelectorAll('#pendingBatch [data-batch]'));
        for (const button of buttons) button.disabled = true;
        try {
            const result = await api.post('/api/entries/review-batch', { ids, action, note });
            if (result.done) {
                toast(action === 'approve' ? t('pending.batchApproved', { n: result.done }) : t('pending.batchRejected', { n: result.done }));
            }
            if (result.failed && result.failed.length) {
                setFormMessage(document.getElementById('pendingNote'), t('pending.batchFailed', { n: result.failed.length }), 'error');
            }
            const box = document.getElementById('pendingBatchNote');
            if (box) box.value = '';
            await window.PDApp.reloadUnit({ keepForm: true });
        } catch (err) {
            toast(window.PDI18n.errorMessage(err), 'error');
        } finally {
            for (const button of buttons) button.disabled = true;   /* 重新載入後沒有任何勾選 → 保持停用 */
        }
    }

    function renderPending(entries) {
        const block = document.getElementById('pendingBlock');
        const list = document.getElementById('pendingList');
        const count = document.getElementById('pendingCount');
        const note = document.getElementById('pendingNote');
        const pending = (entries || []).filter((entry) => entry.status === 'pending');
        const canReview = window.PDAuth.can('can_publish');
        const canEdit = window.PDAuth.can('can_edit');
        clear(list);
        count.textContent = String(pending.length);
        /* 待審核數量顯示在選單按鈕上（面板本身由 showPanel 決定要不要開） */
        const navBadge = document.getElementById('navPendingBtn');
        if (navBadge) navBadge.textContent = pending.length ? `⏳ ${t('admin.tabPending')} (${pending.length})` : `⏳ ${t('admin.tabPending')}`;
        note.textContent = canReview ? t('pending.noteTeacher') : t('pending.noteRep');
        if (canEdit && !pending.length) {
            list.appendChild(el('li', { class: 'audit-item', text: t('pending.empty') }));
        }
        /* 批次審核（B-6）：老師可以勾選多筆再一次核准／退回（退回可附原因） */
        const batchIds = [];
        for (const entry of pending) {
            const info = el('div', { class: 'pending-item-info' }, [
                el('strong', { text: entry.headword }),
                el('span', { text: [entry.ipa_us, entry.part_of_speech, entry.zh_meaning].filter(Boolean).join(' · ') }),
                el('span', {
                    class: 'unit-meta',
                    text: t('pending.by', { user: entry.created_by || '—', date: formatDateTime(entry.created_at) })
                })
            ]);
            if (canReview) {
                const check = el('input', { class: 'pending-check', attrs: { type: 'checkbox', 'data-entry-id': entry.id, 'aria-label': entry.headword } });
                check.addEventListener('change', () => {
                    const current = Array.from(document.querySelectorAll('#pendingList .pending-check:checked')).map((node) => node.dataset.entryId);
                    const count = document.getElementById('pendingBatchCount');
                    if (count) count.textContent = current.length ? t('pending.selected', { n: current.length }) : '';
                    for (const button of document.querySelectorAll('#pendingBatch [data-batch]')) button.disabled = current.length === 0;
                });
                batchIds.push(check);
                info.insertBefore(check, info.firstChild);
            }
            const actions = canReview ? el('div', { class: 'pending-item-actions' }, [
                el('button', {
                    class: 'btn btn-primary btn-small',
                    text: t('pending.approve'),
                    attrs: { type: 'button', 'data-action': 'approve-entry', 'data-entry-id': entry.id }
                }),
                el('button', {
                    class: 'btn btn-ghost btn-small',
                    text: t('pending.reject'),
                    attrs: { type: 'button', 'data-action': 'reject-entry', 'data-entry-id': entry.id }
                })
            ]) : null;
            list.appendChild(el('li', { class: 'pending-item' }, [info, actions]));
        }
    }

    async function review(entryId, action) {
        try {
            await api.post(`/api/entries/${entryId}/review`, { action });
            toast(action === 'approve' ? t('pending.approved') : t('pending.rejected'));
            await window.PDApp.reloadUnit();
            await PDAdmin.loadAudit();
        } catch (err) {
            toast(window.PDI18n.errorMessage(err), 'error');
        }
    }

    /* ---------------- 稽核紀錄（可依動作／帳號／日期篩選，並用顏色分類） ---------------- */
    const auditFilterIds = ['auditActionFilter', 'auditUserFilter', 'auditFromFilter', 'auditToFilter'];

    function readAuditFilters() {
        const value = (id) => {
            const node = document.getElementById(id);
            return node && typeof node.value === 'string' ? node.value.trim() : '';
        };
        return { action: value('auditActionFilter'), user: value('auditUserFilter'), from: value('auditFromFilter'), to: value('auditToFilter') };
    }

    /* 動作下拉只填一次（用後端回傳的 actions 清單，兩邊永遠一致），之後只更新選中的值 */
    function fillAuditActionOptions(actions, selected) {
        const select = document.getElementById('auditActionFilter');
        if (!select || !Array.isArray(actions) || !actions.length) return;
        const wanted = selected === undefined ? select.value : selected;
        clear(select);
        select.appendChild(el('option', { text: t('audit.filterAll'), attrs: { value: '' } }));
        for (const item of actions) {
            const label = window.PDI18n.auditActionLabel(item.value, item.label);
            select.appendChild(el('option', { text: label === item.value ? item.value : `${label}（${item.value}）`, attrs: { value: item.value } }));
        }
        select.value = wanted && actions.some((item) => item.value === wanted) ? wanted : '';
    }

    async function loadAudit() {
        const block = document.getElementById('auditBlock');
        const list = document.getElementById('auditList');
        if (!block || block.hidden || !window.PDAuth.can('can_view_audit')) return;
        const filters = readAuditFilters();
        const params = new URLSearchParams({ limit: '50' });
        for (const key of Object.keys(filters)) if (filters[key]) params.set(key, filters[key]);
        try {
            const data = await api.get(`/api/admin/audit-logs?${params.toString()}`);
            fillAuditActionOptions(data.actions, filters.action);
            const count = document.getElementById('auditCount');
            if (count) {
                count.textContent = t('audit.count', { shown: data.logs.length, total: data.total });
                count.dataset.total = String(data.total);
                count.dataset.shown = String(data.logs.length);
            }
            clear(list);
            if (!data.logs.length) {
                list.appendChild(el('li', { class: 'audit-item', text: t('audit.empty') }));
                return;
            }
            for (const row of data.logs) {
                const tone = window.PDI18n.auditTone(row.action);
                list.appendChild(el('li', { class: 'audit-item', dataset: { tone, action: row.action } }, [
                    el('span', { class: 'audit-when', text: formatDateTime(row.created_at) }),
                    el('span', { class: 'audit-main' }, [
                        el('span', { class: `audit-chip audit-chip--${tone}`, text: window.PDI18n.auditActionLabel(row.action, row.action_label) }),
                        el('span', { class: 'audit-detail', text: row.details || row.target_id || '' })
                    ]),
                    el('span', { class: 'audit-who', text: row.display_name || row.user_id || '' })
                ]));
            }
        } catch (err) {
            clear(list);
            list.appendChild(el('li', { class: 'audit-item', text: t('audit.failed', { message: window.PDI18n.errorMessage(err) }) }));
        }
    }

    function clearAuditFilters() {
        for (const id of auditFilterIds) {
            const node = document.getElementById(id);
            if (node) node.value = '';
        }
        return loadAudit();
    }

    function bindAuditFilters() {
        const action = document.getElementById('auditActionFilter');
        if (action) action.addEventListener('change', loadAudit);
        for (const id of ['auditFromFilter', 'auditToFilter']) {
            const node = document.getElementById(id);
            if (node) node.addEventListener('change', loadAudit);
        }
        /* 帳號欄位打字時不要每個字都打一次 API：停 350ms 再查 */
        const user = document.getElementById('auditUserFilter');
        if (user) {
            let timer = null;
            user.addEventListener('input', () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => { timer = null; loadAudit(); }, 350);
            });
        }
        const clearBtn = document.getElementById('auditClearBtn');
        if (clearBtn) clearBtn.addEventListener('click', clearAuditFilters);
    }

    /* ---------------- 老師錄音（上傳檔案或直接用麥克風錄） ---------------- */
    function openAudioModal(entryId) {
        const entry = (window.PDState.entries || []).find((e) => String(e.id) === String(entryId));
        if (!entry) return;
        state.audioEntryId = entry.id;
        document.getElementById('audioModalHeadword').textContent = entry.headword;
        setFormMessage(document.getElementById('audioMsg'), entry.has_audio
            ? t('audio.existing')
            : t('audio.note'));
        /* D-3：讓老師看得到「這個單元還剩幾段可以錄」（單位：段數，不是檔案大小） */
        const unit = (window.PDState.units || []).find((u) => String(u.id) === String(window.PDState.currentUnitId));
        const usage = document.getElementById('audioUsage');
        if (usage) {
            usage.textContent = unit && unit.audio_limit
                ? t('audio.usage', { n: unit.audio_count || 0, limit: unit.audio_limit })
                : '';
        }
        const del = document.getElementById('audioDeleteBtn');
        del.hidden = !entry.has_audio;
        document.getElementById('audioStopBtn').hidden = true;
        document.getElementById('audioRecordBtn').disabled = false;
        document.getElementById('audioModal').hidden = false;
    }

    function closeAudioModal() {
        stopRecording();
        state.audioEntryId = null;
        document.getElementById('audioModal').hidden = true;
        setFormMessage(document.getElementById('audioMsg'), '');
    }

    async function uploadAudio(dataUrl, mime, durationMs) {
        const entryId = state.audioEntryId;
        if (!entryId) return;
        setFormMessage(document.getElementById('audioMsg'), t('audio.uploading'));
        try {
            await api.post(`/api/entries/${entryId}/audio`, {
                data: dataUrl,
                mime,
                duration_ms: durationMs || 0
            });
            setFormMessage(document.getElementById('audioMsg'), t('audio.saved'), 'ok');
            toast(t('audio.toastSaved'));
            await window.PDApp.reloadUnit();
            window.setTimeout(closeAudioModal, 900);
        } catch (err) {
            setFormMessage(document.getElementById('audioMsg'), window.PDI18n.errorMessage(err), 'error');
        }
    }

    /* 檔案輸入元件固定在 HTML 裡（id=audioFileInput），按鈕只是去點它。
     * 這樣真實瀏覽器與自動化檢查都能沿著同一條路徑走（不必各自造一份）。 */
    function onAudioFileChosen() {
        const input = document.getElementById('audioFileInput');
        const file = input.files && input.files[0];
        if (!file) return;
        if (file.size > 1024 * 1024) {
            setFormMessage(document.getElementById('audioMsg'), t('audio.tooBig', { kb: Math.round(file.size / 1024) }), 'error');
            return;
        }
        const reader = new FileReader();
        reader.onload = () => uploadAudio(String(reader.result), file.type || 'audio/mpeg', 0);
        reader.onerror = () => setFormMessage(document.getElementById('audioMsg'), t('audio.readFailed'), 'error');
        reader.readAsDataURL(file);
    }

    function pickAudioFile() {
        const input = document.getElementById('audioFileInput');
        input.value = '';
        input.click();
    }

    function stopRecording() {
        if (state.recordTimer) {
            window.clearInterval(state.recordTimer);
            state.recordTimer = null;
        }
        if (state.recorder && state.recorder.state !== 'inactive') {
            try {
                state.recorder.stop();
            } catch (err) {
                /* 已經停止 */
            }
        }
        state.recorder = null;
    }

    async function startRecording() {
        const msg = document.getElementById('audioMsg');
        if (!navigator.mediaDevices || !window.MediaRecorder) {
            setFormMessage(msg, t('audio.noMic'), 'error');
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mime = ['audio/webm', 'audio/mp4', 'audio/ogg'].find((type) => {
                try {
                    return window.MediaRecorder.isTypeSupported(type);
                } catch (err) {
                    return false;
                }
            }) || '';
            const recorder = mime ? new window.MediaRecorder(stream, { mimeType: mime }) : new window.MediaRecorder(stream);
            state.recordedChunks = [];
            const startedAt = Date.now();
            recorder.addEventListener('dataavailable', (event) => {
                if (event.data && event.data.size) state.recordedChunks.push(event.data);
            });
            recorder.addEventListener('stop', () => {
                stream.getTracks().forEach((track) => track.stop());
                const blob = new Blob(state.recordedChunks, { type: recorder.mimeType || 'audio/webm' });
                if (!blob.size) {
                    setFormMessage(msg, t('audio.emptyRecording'), 'error');
                    return;
                }
                const reader = new FileReader();
                reader.onload = () => uploadAudio(String(reader.result), blob.type || 'audio/webm', Date.now() - startedAt);
                reader.readAsDataURL(blob);
            });
            state.recorder = recorder;
            recorder.start();
            document.getElementById('audioRecordBtn').disabled = true;
            document.getElementById('audioStopBtn').hidden = false;
            setFormMessage(msg, t('audio.recording'));
            state.recordTimer = window.setInterval(() => {
                const seconds = Math.round((Date.now() - startedAt) / 1000);
                setFormMessage(msg, t('audio.recordingSeconds', { seconds }));
                if (seconds >= 60) stopRecording();
            }, 500);
        } catch (err) {
            setFormMessage(msg, t('audio.micFailed', { message: err.message }), 'error');
        }
    }

    async function deleteTeacherAudio() {
        const entryId = state.audioEntryId;
        const entry = (window.PDState.entries || []).find((e) => String(e.id) === String(entryId));
        if (!entry || !entry.audio_id) return;
        try {
            await api.del(`/api/audio/${entry.audio_id}`);
            toast(t('audio.deleted'));
            await window.PDApp.reloadUnit();
            closeAudioModal();
        } catch (err) {
            setFormMessage(document.getElementById('audioMsg'), window.PDI18n.errorMessage(err), 'error');
        }
    }

    /* ---------------- 初始化 ---------------- */
    /* ---------------- 修改單元（v0.4.1） ----------------
     * 使用者指定：要有修改單元名稱的功能。
     * 從「目錄」每一列的 ✏️ 進來會直接帶入那一本單元；從管理選單自己點進來則預設目前選到的單元。
     * 編號與名稱都可以改（編號會影響學生看到的順序），後端一樣會重新驗證權限與編號合法性。 */
    function unitById(id) {
        return (window.PDState.units || []).find((unit) => String(unit.id) === String(id)) || null;
    }

    function fillUnitEditOptions(preferId) {
        const select = document.getElementById('fUnitEditPick');
        if (!select) return;
        const units = window.PDState.units || [];
        const wanted = preferId !== undefined && preferId !== null
            ? String(preferId)
            : (window.PDState.currentUnitId ? String(window.PDState.currentUnitId) : (units[0] ? String(units[0].id) : ''));
        clear(select);
        for (const unit of units) {
            select.appendChild(el('option', {
                text: `Unit ${unit.unit_no}${unit.title ? ` · ${unit.title}` : ''}`,
                attrs: { value: unit.id }
            }));
        }
        select.value = wanted;
        fillUnitEditFields(select.value);
    }

    /* 注意：這裡**不要**清訊息 —— 存檔成功後會再呼叫一次這個函式（把下拉與欄位重填），
     * 清了就會把「已儲存：Unit 3」蓋掉，使用者看不到成功回饋。清訊息只在真正切換單元時做。 */
    function fillUnitEditFields(unitId) {
        const unit = unitById(unitId);
        document.getElementById('unitEditId').value = unit ? unit.id : '';
        document.getElementById('fUnitEditNo').value = unit ? unit.unit_no : '';
        document.getElementById('fUnitEditTitle').value = unit ? (unit.title || '') : '';
    }

    function openUnitEdit(unitId) {
        ensureAdminOpen('unitEdit');
        fillUnitEditOptions(unitId);
        setFormMessage(document.getElementById('unitEditMsg'), '');
        document.getElementById('fUnitEditNo').focus();
    }

    async function submitUnitEdit(event) {
        event.preventDefault();
        const msg = document.getElementById('unitEditMsg');
        const id = document.getElementById('unitEditId').value;
        if (!id) {
            setFormMessage(msg, t('unitEdit.pick'), 'error');
            return;
        }
        const unit = (window.PDState.units || []).find((u) => String(u.id) === String(id));
        const body = {
            unit_no: Number(document.getElementById('fUnitEditNo').value),
            title: document.getElementById('fUnitEditTitle').value.trim(),
            /* D-2：帶著讀到的版本（沒讀到就不檢查） */
            version: unit ? unit.updated_at : undefined
        };
        try {
            const result = await api.patch(`/api/units/${id}`, body);
            setFormMessage(msg, t('unitEdit.done', { n: result.unit.unit_no }), 'ok');
            toast(t('unitEdit.toast'));
            /* 畫面要跟著更新：目錄那一列、以及（如果改的就是目前這本）生字表的標題 */
            await window.PDApp.reloadUnits(window.PDState.currentBookId);
            if (String(window.PDState.currentUnitId) === String(result.unit.id)) {
                await window.PDApp.reloadUnit({ keepForm: true });
            }
            fillUnitEditOptions(result.unit.id);
        } catch (err) {
            setFormMessage(msg, errText(err), 'error');
        }
    }

    /* ---------------- 錯誤紀錄（v0.4.2, A-5） ----------------
     * 後端把前端回報的錯誤與伺服器自己的 500 記在 dict_error_logs（不進 hydrate 快取）。
     * 這裡只做四件事：列出、篩選、標記已處理、重新載入。不提供刪除 ——
     * 要清舊資料用 scripts/cleanup-logs.js（有 dry-run），避免在畫面上誤刪。 */
    function readErrorFilters() {
        return {
            level: document.getElementById('errorsLevelFilter').value,
            source: document.getElementById('errorsSourceFilter').value,
            resolved: document.getElementById('errorsResolvedFilter').value,
            from: document.getElementById('errorsFromFilter').value,
            to: document.getElementById('errorsToFilter').value
        };
    }

    async function loadErrors() {
        const list = document.getElementById('errorsList');
        const count = document.getElementById('errorsCount');
        const filters = readErrorFilters();
        const params = new URLSearchParams({ limit: '50' });
        for (const key of Object.keys(filters)) if (filters[key]) params.set(key, filters[key]);
        try {
            const data = await api.get(`/api/admin/error-logs?${params.toString()}`);
            renderErrors(data.rows || []);
            count.textContent = t('errorLog.count', { shown: (data.rows || []).length, total: data.total || 0, open: data.open_count || 0 });
        } catch (err) {
            count.textContent = errText(err);
        }
    }

    function renderErrors(rows) {
        const list = document.getElementById('errorsList');
        clear(list);
        if (!rows.length) {
            list.appendChild(el('li', { class: 'empty', text: t('errorLog.empty') }));
            return;
        }
        for (const row of rows) {
            const tone = row.level === 'warn' ? 'update' : 'remove';
            const when = row.created_at ? formatDateTime(row.created_at) : '';
            const chips = [
                el('span', { class: 'audit-chip', text: row.level === 'warn' ? 'warn' : 'error' }),
                el('span', { class: 'audit-chip', text: row.source === 'server' ? t('errorLog.sourceServer') : t('errorLog.sourceClient') })
            ];
            if (row.code) chips.push(el('span', { class: 'audit-chip', text: row.code }));
            if (row.is_self_test) chips.push(el('span', { class: 'audit-chip', text: t('errorLog.selfTest') }));
            if (row.resolved) chips.push(el('span', { class: 'audit-chip', text: t('errorLog.statusDone') }));
            list.appendChild(el('li', { class: 'audit-item', dataset: { tone, action: row.level } }, [
                el('div', { class: 'audit-main' }, [
                    el('span', { class: 'audit-chip', text: when }),
                    ...chips
                ]),
                el('p', { class: 'audit-detail', text: `${row.message}${row.path ? `  ·  ${row.path}` : ''}${row.version ? `  ·  v${row.version}` : ''}` }),
                el('div', { class: 'error-actions' }, [
                    el('button', {
                        class: 'btn btn-ghost btn-small',
                        text: row.resolved ? t('errorLog.markOpen') : t('errorLog.markHandled'),
                        attrs: { type: 'button', 'data-action': 'toggle-error', 'data-error-id': row.id, 'data-resolved': row.resolved ? '1' : '0' }
                    }),
                    /* 同一個錯誤常常一次來好幾筆（擴充功能、迴圈例外）：一顆按鈕清掉同類 */
                    row.resolved ? null : el('button', {
                        class: 'btn btn-ghost btn-small',
                        text: t('errorLog.resolveSimilar'),
                        attrs: {
                            type: 'button', 'data-action': 'resolve-similar',
                            'data-error-code': row.code || '', 'data-error-message': row.message || ''
                        }
                    })
                ].filter(Boolean))
            ]));
        }
    }

    async function resolveSimilarErrors(button) {
        try {
            const result = await api.post('/api/admin/error-logs/resolve-similar', {
                code: button.dataset.errorCode || '',
                message: button.dataset.errorMessage || ''
            });
            toast(t('errorLog.resolveSimilarDone', { n: result.resolved }));
            await loadErrors();
        } catch (err) {
            toast(errText(err), 'error');
        }
    }

    async function toggleError(button) {
        const id = button.dataset.errorId;
        const resolved = button.dataset.resolved !== '1';
        try {
            await api.patch(`/api/admin/error-logs/${id}`, { resolved });
            toast(resolved ? t('errorLog.handled') : t('errorLog.reopened'));
            await loadErrors();
        } catch (err) {
            toast(errText(err), 'error');
        }
    }

    function clearErrorFilters() {
        document.getElementById('errorsLevelFilter').value = '';
        document.getElementById('errorsSourceFilter').value = '';
        document.getElementById('errorsResolvedFilter').value = '';
        document.getElementById('errorsFromFilter').value = '';
        document.getElementById('errorsToFilter').value = '';
        loadErrors();
    }

    /* ---------------- 使用統計（B-7） ---------------- */
    function statsLine(labelKey, value) {
        return el('li', { class: 'audit-item', dataset: { tone: 'review', action: 'stats' } }, [
            el('div', { class: 'audit-main' }, [
                el('span', { class: 'audit-chip', text: t(labelKey) }),
                el('span', { text: String(value) })
            ])
        ]);
    }

    async function loadStats() {
        const list = document.getElementById('statsList');
        const unitsBox = document.getElementById('statsUnits');
        try {
            const data = await api.get('/api/admin/stats');
            clear(list);
            clear(unitsBox);
            list.appendChild(statsLine('stats.entries', `${data.entries.published} ${t('stats.confirmed')} · ${data.entries.pending} ${t('stats.pending')} · ${data.entries.total}`));
            list.appendChild(statsLine('books.title', `${data.books.published}／${data.books.total}`));
            list.appendChild(statsLine('units.title', `${data.units.published}／${data.units.total} · ${data.units.empty}`));
            list.appendChild(statsLine('audio.title', `${data.audio.total} · ${t('stats.audioMissing', { n: Math.max(0, data.audio.missing) })}`));
            list.appendChild(statsLine('users.title', `${data.users.active}／${data.users.total} · ${data.users.two_factor}`));
            list.appendChild(statsLine('grants.title', data.grants.total));
            list.appendChild(statsLine('audit.title', `${data.recent.total}（7d）`));
            /* D-6（v0.7.0）：資料庫容量（真實大小 → 百分比）。到了門檻（預設 70%）要用警告色
             * 並寫清楚「要做什麼」——這一項存在的目的就是讓人不靠記憶也看得到容量。 */
            if (data.usage) {
                const u = data.usage;
                const text = u.available
                    ? `${u.human} / ${u.quota_human}（${u.percent}%）`
                    : t('stats.usageUnknown');
                list.appendChild(el('li', {
                    class: 'audit-item',
                    dataset: { tone: u.warn ? 'remove' : 'create', action: 'usage' }
                }, [
                    el('div', { class: 'audit-main' }, [
                        el('span', { class: 'audit-chip', text: t('stats.usage') }),
                        el('span', { text }),
                        u.warn ? el('span', { class: 'cell-hint', text: t('stats.usageWarn', { percent: u.warn_percent }) }) : null
                    ].filter(Boolean))
                ]));
            }
            for (const unit of data.per_unit.slice(0, 30)) {
                unitsBox.appendChild(el('li', { class: 'audit-item', dataset: { tone: unit.published ? 'create' : 'update', action: 'unit' } }, [
                    el('div', { class: 'audit-main' }, [
                        el('span', { class: 'audit-chip', text: unit.book || '' }),
                        el('span', { text: unit.label }),
                        el('span', { class: 'cell-hint', text: `${unit.published} ${t('stats.confirmed')}${unit.pending ? ` · ${unit.pending} ${t('stats.pending')}` : ''}` })
                    ])
                ]));
            }
        } catch (err) {
            setFormMessage(document.getElementById('errorsCount') || list, errText(err), 'error');
        }
    }

    /* 匯出稽核紀錄（A-3）：走瀏覽器下載（Excel 可開） */
    async function exportAudit() {
        const button = document.getElementById('auditExportBtn');
        const filters = readAuditFilters();
        const params = new URLSearchParams();
        for (const key of Object.keys(filters)) if (filters[key]) params.set(key, filters[key]);
        try {
            const res = await fetch(`/api/admin/audit-logs/export?${params.toString()}`, { credentials: 'same-origin', cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const link = el('a', { attrs: { href: url, download: 'gary-dictionary-audit.csv' } });
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            toast(t('audit.exported', { n: '-' }));
            setTimeout(() => { button.blur(); }, 0);
        } catch (err) {
            toast(err.message || String(err), 'error');
        }
    }

    /* 清理舊稽核紀錄（A-3）：第一次按只預覽，第二次才真的刪 */
    async function cleanupAudit(confirmed) {
        try {
            const body = { keep_days: 365, dry_run: !confirmed };
            const result = await api.post('/api/admin/audit-logs/cleanup', body);
            if (result.dry_run) {
                if (result.would_delete === 0) toast(t('audit.cleanupNothing', { days: result.keep_days }));
                else {
                    toast(t('audit.cleanupPreview', { n: result.would_delete, days: result.keep_days }), 'error');
                    pendingCleanup = true;
                }
                return;
            }
            pendingCleanup = false;
            toast(t('audit.cleanupDone', { n: result.would_delete }));
            await loadAudit();
        } catch (err) {
            toast(errText(err), 'error');
        }
    }

    function init() {
        document.getElementById('entryForm').addEventListener('submit', submitEntry);
        document.getElementById('cancelEntryBtn').addEventListener('click', closeEntryForm);
        document.getElementById('importForm').addEventListener('submit', submitImport);
        /* 選檔案 → 預覽欄位 → 才送出（B-3） */
        document.getElementById('importFileInput').addEventListener('change', (event) => {
            const file = event.target.files && event.target.files[0];
            loadImportFile(file).catch((err) => setFormMessage(document.getElementById('importFileMsg'), err.message || String(err), 'error'));
        });
        document.getElementById('importFileRunBtn').addEventListener('click', runImportFile);
        document.getElementById('importFileCancelBtn').addEventListener('click', cancelImportFile);
        document.getElementById('importToggleBtn').addEventListener('click', openImport);
        document.getElementById('importCancelBtn').addEventListener('click', () => showPanel(null));
        document.getElementById('unitForm').addEventListener('submit', submitUnit);
        document.getElementById('unitEditForm').addEventListener('submit', submitUnitEdit);
        document.getElementById('fUnitEditPick').addEventListener('change', (event) => {
            fillUnitEditFields(event.target.value);
            setFormMessage(document.getElementById('unitEditMsg'), '');
        });
        document.getElementById('navUnitEditBtn').addEventListener('click', () => openUnitEdit(window.PDState.currentUnitId));
        document.getElementById('unitEditCancelBtn').addEventListener('click', () => showPanel(null));
        document.getElementById('bookForm').addEventListener('submit', submitBook);
        /* v0.6.0：修改年級 */
        document.getElementById('gradeEditForm').addEventListener('submit', submitGradeEdit);
        document.getElementById('gradeEditCancelBtn').addEventListener('click', () => {
            document.getElementById('gradeEditForm').hidden = true;
            setFormMessage(document.getElementById('gradeEditMsg'), '');
        });
        document.getElementById('gradeList').addEventListener('click', (event) => {
            const edit = event.target.closest('[data-action="edit-grade"]');
            if (edit) {
                openGradeEdit(edit.dataset.bookId);
                return;
            }
            /* v0.12.0（B-8）：刪除年級（兩段式，確認列長在那一列下面） */
            const remove = event.target.closest('[data-action="delete-grade"]');
            if (remove) askDeleteBook(remove.dataset.bookId, remove.closest('.grade-row'));
        });
        document.getElementById('newEntryBtn').addEventListener('click', () => openEntryForm(null));
        document.getElementById('newUnitBtn').addEventListener('click', () => {
            const note = document.getElementById('unitFormNote');
            if (note) note.textContent = t('unitForm.note', { book: window.PDState.currentBookGrade || '—' });
            showPanel('unit');
            document.getElementById('fUnitNo').focus();
        });
        document.getElementById('newBookBtn').addEventListener('click', () => {
            showPanel('book');
            document.getElementById('fBookGrade').focus();
        });
        document.getElementById('navPendingBtn').addEventListener('click', () => showPanel('pending'));
        document.getElementById('navAuditBtn').addEventListener('click', () => showPanel('audit'));
        document.getElementById('navUsersBtn').addEventListener('click', () => showPanel('users'));
        document.getElementById('navGrantsBtn').addEventListener('click', () => showPanel('grants'));

        /* 使用者權限不同的分頁按鈕：沒權限的直接不顯示（後端一樣會再擋一次） */
        for (const button of document.querySelectorAll('#adminNav [data-admin-tab]')) {
            if (!tabAllowed(button.dataset.adminTab)) button.hidden = true;
        }
        document.getElementById('unitCancelBtn').addEventListener('click', () => showPanel(null));
        document.getElementById('bookCancelBtn').addEventListener('click', () => showPanel(null));
        document.getElementById('auditRefreshBtn').addEventListener('click', loadAudit);
        document.getElementById('auditExportBtn').addEventListener('click', exportAudit);
        document.getElementById('auditCleanupBtn').addEventListener('click', () => cleanupAudit(pendingCleanup));
        document.getElementById('statsRefreshBtn').addEventListener('click', loadStats);
        bindAuditFilters();
        document.getElementById('errorsReloadBtn').addEventListener('click', loadErrors);
        for (const id of ['errorsLevelFilter', 'errorsSourceFilter', 'errorsResolvedFilter', 'errorsFromFilter', 'errorsToFilter']) {
            document.getElementById(id).addEventListener('change', loadErrors);
        }
        document.getElementById('errorsClearBtn').addEventListener('click', clearErrorFilters);
        document.getElementById('errorsList').addEventListener('click', (event) => {
            const toggle = event.target.closest('[data-action="toggle-error"]');
            if (toggle) {
                toggleError(toggle);
                return;
            }
            const similar = event.target.closest('[data-action="resolve-similar"]');
            if (similar) resolveSimilarErrors(similar);
        });

        document.getElementById('audioPickFileBtn').addEventListener('click', pickAudioFile);
        document.getElementById('audioFileInput').addEventListener('change', onAudioFileChosen);
        document.getElementById('audioRecordBtn').addEventListener('click', startRecording);
        document.getElementById('audioStopBtn').addEventListener('click', stopRecording);
        document.getElementById('audioCancelBtn').addEventListener('click', closeAudioModal);
        document.getElementById('audioDeleteBtn').addEventListener('click', deleteTeacherAudio);

        // 生字列與待審核列的按鈕都靠事件委派（動態產生的節點不個別綁定）
        document.getElementById('vocabList').addEventListener('click', (event) => {
            const button = event.target.closest('[data-action]');
            if (!button) return;
            const entryId = button.dataset.entryId;
            if (button.dataset.action === 'speak') window.PDVocab.speakEntry(entryId, button);
            if (button.dataset.action === 'edit-entry') {
                const entry = (window.PDState.entries || []).find((e) => String(e.id) === String(entryId));
                if (entry) openEntryForm(entry);
            }
            if (button.dataset.action === 'delete-entry') deleteEntry(entryId, button);
            if (button.dataset.action === 'upload-audio') openAudioModal(entryId);
        });
        for (const button of document.querySelectorAll('#pendingBatch [data-batch]')) {
            button.addEventListener('click', () => reviewBatch(button.dataset.batch));
        }
        document.getElementById('pendingList').addEventListener('click', (event) => {
            const button = event.target.closest('[data-action]');
            if (!button) return;
            if (button.dataset.action === 'approve-entry') review(button.dataset.entryId, 'approve');
            if (button.dataset.action === 'reject-entry') review(button.dataset.entryId, 'reject');
        });
    }

    window.PDAdmin = {
        init,
        loadAudit,
        loadErrors,
        refreshAvailability,
        showPanel,
        openEntryForm,
        closeEntryForm,
        renderPending,
        renderGradeList,
        openUnitEdit,
        openAudioModal,
        closeAudioModal
    };
})();
