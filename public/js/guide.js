/* 站內使用說明（B-1）
 *
 * 為什麼要有一支單獨的模組：
 *   1. 說明內容是「會過期的文件」。寫在這裡 + tests/guide.test.js 守著，就不會出現
 *      「說明寫的功能根本不存在」這種最傷信任的錯誤（學生看到錯誤示範比沒有說明更糟）。
 *   2. 每一節都綁定它提到的介面元素（ids）與能力（capability）：元素不存在、或能力表沒有這一項，
 *      測試就會紅燈。
 *   3. 文字一律走 i18n（guide.* 鍵），所以中英切換會即時生效；內容只放「怎麼做」，
 *      不放任何截圖（使用者指定：不保留截圖）。
 */
(function () {
    /* 說明頁是從哪個畫面打開的（關閉時要回到那裡） */
    let previousView = 'shelf';

    /* audience：誰需要看這一節（用角色層級比較，guest 最小） */
    const SECTIONS = [
        {
            id: 'lookup', audience: 'guest',
            covers: ['bookShelf', 'unitList', 'vocabList', 'searchInput'],
            title: 'guide.lookup.title', steps: ['guide.lookup.s1', 'guide.lookup.s2', 'guide.lookup.s3'],
            ids: ['bookShelf', 'unitList', 'vocabList']
        },
        {
            id: 'listen', audience: 'student',
            covers: ['playAllBtn', 'vocabList'],
            title: 'guide.listen.title', steps: ['guide.listen.s1', 'guide.listen.s2'],
            ids: ['vocabList']
        },
        {
            id: 'addWords', audience: 'class_rep',
            covers: ['newEntryBtn', 'entryForm', 'newUnitBtn'],
            title: 'guide.addWords.title', steps: ['guide.addWords.s1', 'guide.addWords.s2', 'guide.addWords.s3', 'guide.addWords.s4', 'guide.addWords.s5'],
            ids: ['entryForm', 'importText', 'pendingList']
        },
        {
            id: 'pending', audience: 'teacher',
            covers: ['navPendingBtn'],
            title: 'guide.pending.title', steps: ['guide.pending.s1', 'guide.pending.s2'],
            ids: ['pendingList', 'navPendingBtn']
        },
        {
            id: 'audio', audience: 'teacher',
            covers: [],
            title: 'guide.audio.title', steps: ['guide.audio.s1', 'guide.audio.s2', 'guide.audio.s3'],
            ids: ['audioModal', 'audioRecordBtn', 'audioFileInput']
        },
        {
            id: 'units', audience: 'teacher',
            covers: ['newUnitBtn', 'navUnitEditBtn', 'newBookBtn'],
            title: 'guide.units.title', steps: ['guide.units.s1', 'guide.units.s2', 'guide.units.s3', 'guide.units.s4'],
            ids: ['bookForm', 'unitForm', 'unitEditForm', 'gradeList', 'gradeEditForm'],
            capability: 'can_manage_content'
        },
        {
            id: 'accounts', audience: 'admin',
            covers: ['navUsersBtn', 'navGrantsBtn'],
            title: 'guide.accounts.title', steps: ['guide.accounts.s1', 'guide.accounts.s2', 'guide.accounts.s3'],
            ids: ['newUserBtn', 'userForm', 'logoutAllBtn'],
            capability: 'can_manage_users'
        },
        {
            id: 'monitor', audience: 'admin',
            covers: ['navAuditBtn', 'navErrorsBtn', 'navStatsBtn'],
            title: 'guide.monitor.title', steps: ['guide.monitor.s1', 'guide.monitor.s2', 'guide.monitor.s3'],
            ids: ['auditList', 'auditExportBtn', 'errorsList', 'statsList'],
            capability: 'can_view_audit'
        },
        {
            id: 'importFile', audience: 'class_rep',
            title: 'guide.importFile.title', steps: ['guide.importFile.s1', 'guide.importFile.s2', 'guide.importFile.s3'],
            ids: ['importToggleBtn', 'importFileInput', 'importPreviewTable'],
            covers: ['importToggleBtn']
        },
        {
            id: 'playAll', audience: 'student',
            title: 'guide.playAll.title', steps: ['guide.playAll.s1', 'guide.playAll.s2'],
            ids: ['playAllBtn', 'vocabList'],
            covers: ['playAllBtn']
        },
        {
            id: 'reviewBatch', audience: 'teacher',
            title: 'guide.reviewBatch.title', steps: ['guide.reviewBatch.s1', 'guide.reviewBatch.s2'],
            ids: ['pendingApproveAllBtn', 'pendingRejectAllBtn', 'pendingBatchNote'],
            covers: ['navPendingBtn']
        },
        {
            id: 'organise', audience: 'teacher',
            title: 'guide.organise.title', steps: ['guide.organise.s1', 'guide.organise.s2'],
            ids: ['unitList', 'bookShelf'],
            covers: ['newUnitBtn', 'navUnitEditBtn', 'newBookBtn'],
            capability: 'can_manage_content'
        },
        {
            id: 'appearance', audience: 'guest',
            title: 'guide.appearance.title', steps: ['guide.appearance.s1', 'guide.appearance.s2'],
            ids: ['themeSwitch', 'fontSwitch'],
            covers: []
        },
        {
            id: 'printing', audience: 'guest',
            title: 'guide.printing.title', steps: ['guide.printing.s1', 'guide.printing.s2'],
            ids: ['printBtn', 'printZh', 'printExample'],
            covers: []
        },
        {
            id: 'keyboard', audience: 'guest',
            title: 'guide.keyboard.title', steps: ['guide.keyboard.s1', 'guide.keyboard.s2'],
            ids: ['searchInput', 'guidePanel'],
            covers: []
        },
        {
            id: 'safety', audience: 'web_manager',
            covers: [],
            title: 'guide.safety.title', steps: ['guide.safety.s1', 'guide.safety.s2'],
            ids: ['logoutAllBtn'],
            capability: 'can_force_logout'
        }
    ];

    function visibleSections(role) {
        const levels = { guest: 0, student: 1, class_rep: 2, teacher: 3, admin: 4, web_manager: 5 };
        const mine = levels[role] === undefined ? 0 : levels[role];
        return SECTIONS.filter((section) => mine >= (levels[section.audience] || 0));
    }

    function isVisible(section) {
        const user = window.PDAuth.user;
        const levels = { guest: 0, student: 1, class_rep: 2, teacher: 3, admin: 4, web_manager: 5 };
        const mine = user ? (levels[user.role] || 0) : 0;
        return mine >= (levels[section.audience] || 0);
    }

    async function loadRoleTable() {
        const box = document.getElementById('guideRoles');
        if (!box) return;
        try {
            const data = await window.PDApi.get('/api/roles');
            box.textContent = '';
            const table = document.createElement('table');
            table.className = 'guide-table';
            const head = document.createElement('tr');
            head.appendChild(document.createElement('th'));
            for (const role of data.roles) {
                const cell = document.createElement('th');
                cell.textContent = window.PDI18n.lang === 'zh' ? role.label_zh : role.label_en;
                head.appendChild(cell);
            }
            table.appendChild(head);
            for (const capability of data.capabilities) {
                const row = document.createElement('tr');
                const label = document.createElement('th');
                label.textContent = window.PDI18n.lang === 'zh' ? capability.label_zh : capability.label_en;
                label.setAttribute('title', window.PDI18n.lang === 'zh' ? capability.note_zh : capability.note_en);
                row.appendChild(label);
                for (const role of data.roles) {
                    const cell = document.createElement('td');
                    const levels = { guest: 0, student: 1, class_rep: 2, teacher: 3, admin: 4, web_manager: 5 };
                    const allowed = capability.key === 'can_force_logout'
                        ? role.key === 'web_manager'
                        : levels[role.key] >= levels[capability.min_role];
                    cell.textContent = allowed ? '✓' : '·';
                    cell.className = allowed ? 'guide-yes' : 'guide-no';
                    row.appendChild(cell);
                }
                table.appendChild(row);
            }
            box.appendChild(table);
        } catch (err) {
            box.textContent = '⚠️ ' + (err.message || String(err));
        }
    }

    function render() {
        const box = document.getElementById('guideSections');
        if (!box) return;
        box.textContent = '';
        const role = window.PDAuth.user ? window.PDAuth.user.role : 'guest';
        for (const section of visibleSections(role)) {
            const article = document.createElement('article');
            article.className = 'guide-section';
            article.dataset.section = section.id;
            const title = document.createElement('h3');
            title.className = 'guide-title';
            title.textContent = window.PDI18n.t(section.title);
            article.appendChild(title);
            const list = document.createElement('ol');
            list.className = 'guide-steps';
            for (const key of section.steps) {
                const item = document.createElement('li');
                item.textContent = window.PDI18n.t(key);
                list.appendChild(item);
            }
            article.appendChild(list);
            box.appendChild(article);
        }
        return loadRoleTable();
    }

    function open() {
        const panel = document.getElementById('guidePanel');
        if (!panel) return;
        /* 記住進來之前在哪個畫面，關閉時回到那裡（不要一律跳回書架） */
        previousView = (window.PDApp && window.PDApp.view) || 'shelf';
        panel.hidden = false;
        if (window.PDApp && window.PDApp.showView) window.PDApp.showView('guide');
        render();
        const button = document.getElementById('guideBtn');
        if (button) button.setAttribute('aria-expanded', 'true');
    }

    function close() {
        const panel = document.getElementById('guidePanel');
        if (!panel) return;
        panel.hidden = true;
        /* 回到說明頁之前的畫面（書架／目錄／生字表） */
        if (window.PDApp && window.PDApp.showView) window.PDApp.showView(previousView === 'guide' ? 'shelf' : previousView);
        const button = document.getElementById('guideBtn');
        if (button) button.setAttribute('aria-expanded', 'false');
    }

    /* 列印版：加一個 data 標記，print.css 只留說明頁（不印其他面板） */
    function printGuide() {
        document.body.dataset.printView = 'guide';
        window.print();
        delete document.body.dataset.printView;
    }

    function init() {
        const button = document.getElementById('guideBtn');
        if (button) button.addEventListener('click', () => {
            const panel = document.getElementById('guidePanel');
            if (panel && panel.hidden) open(); else close();
        });
        const closeBtn = document.getElementById('guideCloseBtn');
        if (closeBtn) closeBtn.addEventListener('click', close);
        const print = document.getElementById('guidePrintBtn');
        if (print) print.addEventListener('click', printGuide);
        /* 切換語言時重畫（說明內容也要跟著換） */
        /* 事件名稱是 i18n.js 發的 pd:langchange（不是 pd:language，踩過一次） */
        document.addEventListener('pd:langchange', () => {
            const panel = document.getElementById('guidePanel');
            if (panel && !panel.hidden) render();
        });
    }

    window.PDGuide = { SECTIONS, visibleSections, isVisible, render, open, close, printGuide, init };
})();
