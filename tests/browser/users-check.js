/* 帳號管理與授權管理的真實瀏覽器驗收（v0.1.0）
 *
 * 要守住的行為：
 *   1. 只有 admin 以上看得到「帳號管理 / 授權管理」，老師登入後看不到
 *   2. 管理員真的能在畫面上建立帳號 → 新帳號立刻出現在表格，而且能用新密碼登入
 *   3. 行內改角色、行內重設密碼、停用、兩段式刪除都真的有效果
 *   4. 授權某個單元之後，被授權的人真的能編輯那個單元（未授權時 403）；移除後又回到 403
 *   5. 稽核紀錄用目前語言顯示新動作（Create user / Grant permission）
 *   6. 版面不溢出、無 CSP 違規、無前端例外、不下載、不寫截圖
 */
const fs = require('node:fs');
const path = require('node:path');

const { Browser, sleep } = require('./lib/cdp');
const { STUBS, startApp, loginViaUi, logoutViaUi, visibleIds } = require('./lib/harness');

const PASSWORD = 'pass1234';

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
    if (condition) {
        passed += 1;
        console.log(`  ✔ ${label}`);
    } else {
        failed += 1;
        failures.push(label + (detail ? `（${detail}）` : ''));
        console.log(`  ✖ ${label}${detail ? ` → ${detail}` : ''}`);
    }
}

/* 等「伺服器端的權威狀態」到位再斷言。
 * 為什麼需要：有些等待條件是腳本自己設的 UI 值（恆真），等於沒等 → 斷言會跑在寫入完成之前。
 * store 是行程內的權威狀態（後端在回應前就寫好了），對它等待才是真的等。 */
async function waitForStore(predicate, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(120);
    }
    return predicate();
}

/* 等後端寫出的檔案內容（錯誤日誌是本機 JSON 檔，不是頁面狀態） */
async function waitForFile(predicate, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(150);
    }
    return predicate();
}

/* 頁面內用的小工具：靠帳號文字找到那一列（避免依賴列序） */
const ROW_HELPERS = `
    window.__rowFor = (username) => [...document.querySelectorAll('#usersTableBody tr')]
        .find((tr) => {
            const cell = tr.querySelector('td strong');
            return cell && cell.textContent.trim() === username;
        }) || null;
    return true;
`;

async function loginAs(base, username, password) {
    const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    return res.status;
}

async function apiAs(base, username, password, url, body) {
    const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    const cookies = typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [];
    const cookie = cookies.map((line) => line.split(';')[0]).join('; ');
    const res = await fetch(`${base}${url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(body || {})
    });
    return res.status;
}

async function main() {
    const app = startApp({ prefix: 'pv-users-' });
    const store = app.store;
    const book = store.createBook({ code: 'B5A', name: 'Book 5A', sort_order: 1, is_published: true });
    const unit = store.createUnit({ book_id: book.id, unit_no: 1, title: 'My New School', sort_order: 1, is_published: true });
    store.createEntry({
        unit_id: unit.id, headword: 'campus', headword_norm: 'campus',
        part_of_speech: 'n.', zh_meaning: '校園', en_definition: 'the land of a school',
        status: 'published', sort_order: 1, created_by: 'seed'
    });

    const browser = await Browser.launch({ width: 1360, height: 1000 });
    let exitCode = 0;
    try {
        await browser.goto(`${app.base}/`);
        await browser.evaluate(STUBS);
        await browser.waitFor(`document.getElementById('bookShelf').children.length > 0`);

        console.log('\n【1】訪客與老師都看不到帳號管理');
        const guestVisible = await visibleIds(browser, ['usersBlock', 'grantsBlock']);
        check('訪客看不到帳號管理與授權管理', guestVisible.length === 0, guestVisible.join('、'));

        await loginViaUi(browser, { username: 'teacher' });
        await browser.evaluate(`document.getElementById('adminToggleBtn').click(); return true;`);
        await sleep(500);
        const teacherVisible = await visibleIds(browser, ['usersBlock', 'grantsBlock']);
        check('老師打開「管理」也看不到帳號管理', teacherVisible.length === 0, teacherVisible.join('、'));
        const teacherNav = await browser.evaluate(`return {
            users: document.querySelector('#adminNav [data-admin-tab="users"]').hidden,
            grants: document.querySelector('#adminNav [data-admin-tab="grants"]').hidden,
            audit: document.querySelector('#adminNav [data-admin-tab="audit"]').hidden
        };`);
        check('老師的管理選單裡沒有帳號／授權／稽核分頁', teacherNav.users === true && teacherNav.grants === true && teacherNav.audit === true, JSON.stringify(teacherNav));
        const teacherApi = await apiAs(app.base, 'teacher', PASSWORD, '/api/admin/users', {});
        check('老師直接打 API 也是 403（前端藏起來不算防護）', teacherApi === 403, String(teacherApi));

        console.log('\n【2】管理員：管理選單按了才顯示對應頁面');
        await logoutViaUi(browser);
        await loginViaUi(browser, { username: 'manager', expectText: 'Web administrator' });
        await browser.evaluate(`document.getElementById('adminToggleBtn').click(); return true;`);
        await browser.evaluate(ROW_HELPERS);
        await browser.evaluate(`document.getElementById('navUsersBtn').click(); return true;`);
        await browser.waitFor(`document.querySelectorAll('#usersTableBody tr').length >= 5`, { timeout: 8000 });
        const adminVisible = await visibleIds(browser, ['usersBlock']);
        check('按「👥 帳號管理」才顯示帳號表', adminVisible.length === 1, adminVisible.join('、'));
        check('一次只顯示一塊（授權與稽核還關著）',
            (await browser.evaluate(`return document.getElementById('grantsBlock').hidden === true && document.getElementById('auditBlock').hidden === true;`)) === true);
        await browser.evaluate(`document.getElementById('navGrantsBtn').click(); return true;`);
        await sleep(300);
        const grantsVisible = await visibleIds(browser, ['grantsBlock']);
        check('按「🔑 授權管理」後換成授權面板（帳號表收起來）',
            grantsVisible.length === 1 && (await browser.evaluate(`return document.getElementById('usersBlock').hidden === true;`)) === true);
        await browser.evaluate(`document.getElementById('navUsersBtn').click(); return true;`);
        await sleep(300);
        const tableInfo = await browser.evaluate(`
            return {
                rows: [...document.querySelectorAll('#usersTableBody tr')].length,
                accounts: [...document.querySelectorAll('#usersTableBody td strong')].map((n) => n.textContent),
                hasSelfBadge: document.getElementById('usersTableBody').textContent.includes('you'),
                roleSelects: document.querySelectorAll('#usersTableBody select[data-action="role"]').length,
                headers: [...document.querySelectorAll('#usersBlock thead th')].map((th) => th.textContent)
            };
        `);
        check('五個種子帳號都列出來', tableInfo.rows === 5 && tableInfo.accounts.includes('teacher'), JSON.stringify(tableInfo.accounts));
        check('自己的那一列有標記（you）', tableInfo.hasSelfBadge);
        check('比自己低的角色可以行內改（admin 不能改自己／同級／網站管理員）', tableInfo.roleSelects === 3, String(tableInfo.roleSelects));
        check('表頭是英文', tableInfo.headers.includes('Account') && tableInfo.headers.includes('Role'), tableInfo.headers.join(','));

        console.log('\n【3】建立帳號（畫面操作 → 表格出現 → 新帳號可登入）');
        await browser.evaluate(`document.getElementById('newUserBtn').click(); return true;`);
        await browser.waitFor(`getComputedStyle(document.getElementById('userForm')).display !== 'none'`);
        await browser.evaluate(`
            document.getElementById('fUsername').value = 'teacherchan';
            document.getElementById('fDisplayName').value = 'Miss Chan';
            document.getElementById('fPassword').value = 'chan123456';
            document.getElementById('fUserRole').value = 'teacher';
            document.forms.userForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`window.__rowFor('teacherchan') !== null`, { timeout: 8000 });
        const createdRow = await browser.evaluate(`
            const tr = window.__rowFor('teacherchan');
            return { cells: [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()), hidden: getComputedStyle(document.getElementById('userForm')).display };
        `);
        check('新帳號出現在表格且名稱正確', createdRow.cells[1] === 'Miss Chan', JSON.stringify(createdRow.cells));
        check('新帳號預設啟用中', createdRow.cells[3].includes('Active'), createdRow.cells[3]);
        check('送出後表單自動關起來', createdRow.hidden === 'none', createdRow.hidden);
        check('新帳號可以用新密碼登入', (await loginAs(app.base, 'teacherchan', 'chan123456')) === 200);

        console.log('\n【4】行內改角色、重設密碼、停用');
        const teacherChanId = store.findUserByUsername('teacherchan').id;
        await browser.evaluate(`
            const select = document.querySelector('#usersTableBody select[data-user-id="${teacherChanId}"]');
            select.value = 'class_rep';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        `);
        await browser.waitFor(`document.querySelector('#usersTableBody select[data-user-id="${teacherChanId}"]').value === 'class_rep'`, { timeout: 8000 });
        const roleLanded = await waitForStore(() => store.findUserByUsername('teacherchan').role === 'class_rep');
        check('改角色成功（資料庫也是新角色）', roleLanded, store.findUserByUsername('teacherchan').role);

        await browser.evaluate(`
            const tr = window.__rowFor('teacherchan');
            tr.querySelector('[data-action="reset-password"]').click();
            return true;
        `);
        await browser.waitFor(`document.querySelector('#usersTableBody [data-field="new-password"]') !== null`, { timeout: 5000 });
        await browser.evaluate(`
            document.querySelector('#usersTableBody [data-field="new-password"]').value = 'reset99999';
            document.querySelector('#usersTableBody [data-action="save-password"]').click();
            return true;
        `);
        await browser.waitFor(`document.querySelector('#usersTableBody [data-field="new-password"]') === null`, { timeout: 8000 });
        check('重設密碼後可以用新密碼登入', (await loginAs(app.base, 'teacherchan', 'reset99999')) === 200);
        check('舊密碼失效', (await loginAs(app.base, 'teacherchan', 'chan123456')) === 401);

        await browser.evaluate(`
            window.__rowFor('teacherchan').querySelector('[data-action="toggle-active"]').click();
            return true;
        `);
        await browser.waitFor(`window.__rowFor('teacherchan').textContent.includes('Disabled')`, { timeout: 8000 });
        const deactivated = await waitForStore(() => store.findUserByUsername('teacherchan').is_active === false);
        check('停用後資料庫也標成停用', deactivated);
        check('停用後登不進來', (await loginAs(app.base, 'teacherchan', 'reset99999')) === 401);

        console.log('\n【5】刪除帳號要按兩次（防手滑）');
        await browser.evaluate(`
            window.__rowFor('teacherchan').querySelector('[data-action="delete-user"]').click();
            return true;
        `);
        await browser.waitFor(`window.__rowFor('teacherchan') && window.__rowFor('teacherchan').textContent.includes('Press again to confirm')`, { timeout: 5000 });
        check('第一次按只進入確認狀態，帳號還在', store.findUserByUsername('teacherchan') !== null);
        await browser.evaluate(`
            window.__rowFor('teacherchan').querySelector('[data-action="delete-user"]').click();
            return true;
        `);
        await browser.waitFor(`window.__rowFor('teacherchan') === null`, { timeout: 8000 });
        const deleted = await waitForStore(() => store.findUserByUsername('teacherchan') === null);
        check('第二次按才真的刪掉', deleted);

        console.log('\n【6】授權管理：授權單元 → 真的能編輯 → 移除 → 又不能');
        const studentId = store.findUserByUsername('student').id;
        const beforeGrant = await apiAs(app.base, 'student', PASSWORD, `/api/units/${unit.id}/entries`, { headword: 'library', en_definition: 'a place with books' });
        check('授權前，學生對這個單元是 403', beforeGrant === 403, String(beforeGrant));

        await browser.evaluate(`document.getElementById('navGrantsBtn').click(); return true;`);
        await browser.waitFor(`getComputedStyle(document.getElementById('grantsBlock')).display !== 'none'`);
        await browser.evaluate(`document.getElementById('newGrantBtn').click(); return true;`);
        await browser.waitFor(`getComputedStyle(document.getElementById('grantForm')).display !== 'none'`);
        await browser.evaluate(`
            document.getElementById('fGrantUser').value = '${studentId}';
            const scope = document.getElementById('fGrantScope');
            scope.value = 'unit';
            scope.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        `);
        await browser.waitFor(`document.querySelectorAll('#fGrantUnit option').length > 0`, { timeout: 8000 });
        const unitOptionValue = await browser.evaluate(`return document.getElementById('fGrantUnit').value;`);
        await browser.evaluate(`
            document.getElementById('fGrantPublish').checked = true;
            document.forms.grantForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`document.querySelectorAll('#grantsList .grant-item').length === 1`, { timeout: 8000 });
        const grantText = await browser.evaluate(`return document.querySelector('#grantsList .grant-item').textContent;`);
        check('授權後清單出現那一筆（含書本與單元）', grantText.includes('student') && grantText.includes('Unit 1'), grantText);
        check('標示為可編輯＋發佈', grantText.includes('Edit + publish'), grantText);
        check('單位選單帶入的是真正的單元', String(unitOptionValue) === String(unit.id), `${unitOptionValue} vs ${unit.id}`);

        const afterGrant = await apiAs(app.base, 'student', PASSWORD, `/api/units/${unit.id}/entries`, { headword: 'library', en_definition: 'a place with books' });
        check('授權後，同樣的學生可以新增生字', afterGrant === 201, String(afterGrant));

        await browser.evaluate(`document.querySelector('#grantsList [data-action="delete-grant"]').click(); return true;`);
        await browser.waitFor(`document.querySelector('#grantsList [data-action="delete-grant"]').textContent.includes('Press again to confirm')`, { timeout: 5000 });
        const grantKept = await waitForStore(() => store.listGrants({}).length === 1, 1500);
        check('移除授權也要兩段式確認', grantKept);
        await browser.evaluate(`document.querySelector('#grantsList [data-action="delete-grant"]').click(); return true;`);
        await browser.waitFor(`document.querySelectorAll('#grantsList .grant-item').length === 0`, { timeout: 8000 });
        check('移除後清單變空（顯示提示）', (await browser.evaluate(`return document.getElementById('grantsList').textContent;`)).includes('No extra permissions'), '');
        const afterRemove = await apiAs(app.base, 'student', PASSWORD, `/api/units/${unit.id}/entries`, { headword: 'gym', en_definition: 'a place to exercise' });
        check('移除授權後又回到 403', afterRemove === 403, String(afterRemove));

        console.log('\n【7】稽核紀錄：新動作有紀錄、標籤跟著語言');
        await browser.evaluate(`document.getElementById('navAuditBtn').click(); return true;`);
        await browser.waitFor(`getComputedStyle(document.getElementById('auditBlock')).display !== 'none'`);
        await browser.evaluate(`document.getElementById('auditRefreshBtn').click(); return true;`);
        /* 重新整理是非同步的：要等「新的動作」真的出現在清單裡，不是等清單非空（舊資料也會非空） */
        await browser.waitFor(`document.getElementById('auditList').textContent.includes('Remove permission')`, { timeout: 8000 });
        const auditInfo = await browser.evaluate(`return {
            items: document.querySelectorAll('#auditList > li').length,
            text: document.getElementById('auditList').textContent,
            labelUserCreate: window.PDI18n.auditActionLabel('USER_CREATE', ''),
            labelUserDelete: window.PDI18n.auditActionLabel('USER_DELETE', '')
        };`);
        check('稽核面板列出紀錄', auditInfo.items > 0, `${auditInfo.items} 筆`);
        check('授權與移除授權都出現在紀錄裡',
            auditInfo.text.includes('Grant permission') && auditInfo.text.includes('Remove permission'), '');
        check('帳號管理的新動作標籤是英文（Create user / Delete user）',
            auditInfo.labelUserCreate === 'Create user' && auditInfo.labelUserDelete === 'Delete user',
            JSON.stringify([auditInfo.labelUserCreate, auditInfo.labelUserDelete]));

        /* ---- 篩選與顏色分類 ---- */
        const filterUi = await browser.evaluate(`return {
            action: Boolean(document.getElementById('auditActionFilter')),
            user: Boolean(document.getElementById('auditUserFilter')),
            from: Boolean(document.getElementById('auditFromFilter')),
            to: Boolean(document.getElementById('auditToFilter')),
            clear: Boolean(document.getElementById('auditClearBtn')),
            options: document.getElementById('auditActionFilter').options.length,
            tones: [...new Set([...document.querySelectorAll('#auditList > li[data-tone]')].map((li) => li.dataset.tone))],
            chips: document.querySelectorAll('#auditList .audit-chip').length
        };`);
        check('稽核面板有動作／帳號／日期篩選與清除鈕',
            filterUi.action && filterUi.user && filterUi.from && filterUi.to && filterUi.clear, JSON.stringify(filterUi));
        check('動作下拉有「全部」＋各動作選項', filterUi.options > 1, `${filterUi.options} 個`);
        check('每列都有顏色分類與動作標籤', filterUi.chips > 0 && filterUi.tones.length > 0, JSON.stringify(filterUi.tones));

        await browser.evaluate(`
            const select = document.getElementById('auditActionFilter');
            select.value = 'USER_CREATE';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        `);
        await browser.waitFor(
            `document.querySelectorAll('#auditList > li[data-action]').length > 0
             && [...document.querySelectorAll('#auditList > li[data-action]')].every((li) => li.dataset.action === 'USER_CREATE')`,
            { timeout: 8000 }
        );
        const filtered = await browser.evaluate(`return {
            actions: [...new Set([...document.querySelectorAll('#auditList > li[data-action]')].map((li) => li.dataset.action))],
            tones: [...new Set([...document.querySelectorAll('#auditList > li[data-action]')].map((li) => li.dataset.tone))],
            chip: document.querySelector('#auditList .audit-chip').textContent,
            count: document.getElementById('auditCount').textContent
        };`);
        check('選了動作之後清單只剩那一種動作', filtered.actions.length === 1 && filtered.actions[0] === 'USER_CREATE', JSON.stringify(filtered.actions));
        check('USER_CREATE 歸在「新增」色系', filtered.tones.length === 1 && filtered.tones[0] === 'create', JSON.stringify(filtered.tones));
        check('標籤顯示該動作的語言標籤', filtered.chip === 'Create user', filtered.chip);
        check('筆數文字顯示「顯示 N／共 M」', /Showing/.test(filtered.count) && /of/.test(filtered.count), filtered.count);

        await browser.evaluate(`document.getElementById('auditClearBtn').click(); return true;`);
        await browser.waitFor(
            `document.getElementById('auditActionFilter').value === ''
             && document.querySelectorAll('#auditList > li[data-action]').length > 1`,
            { timeout: 8000 }
        );
        check('按「清除篩選」回到全部紀錄', true);

        console.log('\n【7b】錯誤紀錄（v0.4.2）：前端例外自動記錄 → 後台看得到 → 標記已處理');
        const errorFile = path.join(app.dir, 'error-logs.json');
        /* 真的在頁面裡製造一個沒有被捕捉的例外（不是假造資料） */
        await browser.evaluate(`setTimeout(() => { throw new Error('__check_error__ 前端例外測試'); }, 0); return true;`);
        const logged = await waitForFile(() => {
            try {
                return JSON.parse(fs.readFileSync(errorFile, 'utf8'))
                    .some((row) => String(row.message).includes('__check_error__'));
            } catch (err) {
                return false;
            }
        });
        check('前端例外會自動回報到錯誤日誌（未登入也能回報）', logged === true, logged ? '' : 'error-logs.json 沒有寫入');

        await browser.evaluate(`document.getElementById('navErrorsBtn').click(); return true;`);
        await browser.waitFor(`getComputedStyle(document.getElementById('errorsBlock')).display !== 'none'`, { timeout: 8000 });
        /* ★ 一定要等「資料回來」再取樣：分頁打開是同步的，但清單要等 API 回應才會有內容。
         * 少了這個等待，機器忙的時候就會取到「還沒渲染」的空清單（先前誤判過一次）。 */
        await browser.waitFor(`document.querySelectorAll('#errorsList .audit-item').length > 0`, { timeout: 8000 });
        /* 額外證明一次：從頁面直接查管理 API 也拿得到同一筆（不是只有畫面好看） */
        const errorProbe = await browser.evaluate(`
            return fetch('/api/admin/error-logs?limit=50', { credentials: 'same-origin', cache: 'no-store' })
                .then((r) => r.json().then((d) => ({ status: r.status, total: d.total, rows: (d.rows || []).length, err: d.error || d.code || null })))
                .catch((err) => ({ status: 0, err: String(err) }));
        `);
        check('管理 API 直接查也拿得到同一筆（畫面不是唯一來源）',
            errorProbe.status === 200 && errorProbe.rows >= 1, JSON.stringify(errorProbe));
        const errorsUi = await browser.evaluate(`return {
            items: document.querySelectorAll('#errorsList .audit-item').length,
            text: document.getElementById('errorsList').textContent,
            count: document.getElementById('errorsCount').textContent,
            chips: Array.from(document.querySelectorAll('#errorsList .audit-chip')).map((c) => c.textContent),
            othersClosed: document.getElementById('auditBlock').hidden === true && document.getElementById('usersBlock').hidden === true
        };`);
        check('錯誤紀錄分頁打得開，而且列出剛才那一筆',
            errorsUi.items >= 1 && errorsUi.text.includes('__check_error__') && errorsUi.othersClosed === true,
            JSON.stringify([errorsUi.items, errorsUi.text.slice(0, 60), errorsUi.count, errorProbe]));
        check('每一筆都標出等級與來源（error／Browser）',
            errorsUi.chips.includes('error') && errorsUi.chips.includes('Browser'), JSON.stringify(errorsUi.chips));
        check('標題列顯示筆數與未處理數量', /\d/.test(errorsUi.count), errorsUi.count);

        /* 篩選：只看已處理時，這一筆（未處理）不該出現 */
        await browser.evaluate(`
            const select = document.getElementById('errorsResolvedFilter');
            select.value = 'true';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        `);
        await browser.waitFor(`document.getElementById('errorsList').textContent.includes('No errors')`, { timeout: 8000 });
        check('篩選「已處理」時看不到未處理的那一筆', true);
        await browser.evaluate(`
            document.getElementById('errorsClearBtn').click();
            return true;
        `);
        await browser.waitFor(`document.getElementById('errorsList').textContent.includes('__check_error__')`, { timeout: 8000 });

        await browser.evaluate(`document.querySelector('#errorsList [data-action="toggle-error"]').click(); return true;`);
        const marked = await waitForFile(() => {
            try {
                return JSON.parse(fs.readFileSync(errorFile, 'utf8')).some((row) => row.resolved === true);
            } catch (err) {
                return false;
            }
        });
        check('按「標記已處理」之後資料庫也標成已處理', marked === true);

        const auditAfter = store.listAuditLogs({ limit: 20 }).items.map((row) => row.action);
        check('標記動作也留了稽核紀錄（ERROR_LOG_UPDATE）', auditAfter.includes('ERROR_LOG_UPDATE'), auditAfter.slice(0, 5).join(','));

        console.log('\n【8】切中文後新面板跟著翻譯 + 版面不溢出');
        await browser.evaluate(`document.getElementById('navUsersBtn').click(); return true;`);
        await browser.evaluate(`document.querySelector('#langSwitch [data-lang="zh"]').click(); return true;`);
        await sleep(600);
        const zhPanels = await browser.evaluate(`return {
            usersTitle: document.querySelector('#usersBlock .panel-title').textContent,
            grantsTitle: document.querySelector('#grantsBlock .panel-title').textContent,
            header: document.querySelector('#usersBlock thead th').textContent,
            newUserBtn: document.getElementById('newUserBtn').textContent
        };`);
        check('帳號管理標題變中文', zhPanels.usersTitle.includes('帳號管理'), zhPanels.usersTitle);
        check('授權管理標題變中文', zhPanels.grantsTitle.includes('授權管理'), zhPanels.grantsTitle);
        check('表頭變中文', zhPanels.header === '帳號', zhPanels.header);
        check('按鈕變中文', zhPanels.newUserBtn.includes('新增帳號'), zhPanels.newUserBtn);
        /* 稽核清單是打開分頁時才載入的（一次只顯示一塊），所以要按進去看它的語言 */
        await browser.evaluate(`document.getElementById('navAuditBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('auditList').textContent.includes('新增授權')`, { timeout: 8000 });
        check('稽核動作標籤也變中文', true);
        await browser.evaluate(`document.getElementById('navUsersBtn').click(); return true;`);
        await sleep(300);

        await browser.setViewport(402, 874, true);
        await sleep(400);
        const overflow = await browser.evaluate(`return document.documentElement.scrollWidth - window.innerWidth;`);
        check('手機版（402px）帳號管理也不會橫向溢出', overflow <= 1, `溢出 ${overflow}px`);
        const tableScrolls = await browser.evaluate(`
            const wrap = document.querySelector('#usersBlock .table-wrap');
            return wrap ? wrap.scrollWidth > wrap.clientWidth : false;
        `);
        check('窄螢幕時表格自己在框內橫向捲動（不是把整頁撐開）', tableScrolls === true);
        await browser.setViewport(1360, 1000, false);
        await sleep(300);

        console.log('\n【8b】修改自己的密碼（標題列 🔑，任何登入者都能用）');
        /* 先切回英文：上面那一段把介面切成中文了 */
        await browser.evaluate(`document.querySelector('#langSwitch [data-lang="en"]').click(); return true;`);
        await sleep(300);
        const selfRow = await browser.evaluate(`
            const tr = window.__rowFor('manager');
            return {
                reset: tr.querySelector('[data-action="reset-password"]') !== null,
                toggle: tr.querySelector('[data-action="toggle-active"]') !== null,
                del: tr.querySelector('[data-action="delete-user"]') !== null
            };
        `);
        check('自己的那一列可以改密碼，但不能停用／刪除自己',
            selfRow.reset === true && selfRow.toggle === false && selfRow.del === false, JSON.stringify(selfRow));

        await browser.evaluate(`document.getElementById('passwordBtn').click(); return true;`);
        await browser.waitFor(`getComputedStyle(document.getElementById('passwordModal')).display !== 'none'`);
        await browser.evaluate(`
            document.getElementById('currentPassword').value = 'definitely-not-it';
            document.getElementById('newPassword').value = 'newpass12345';
            document.forms.passwordForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`document.getElementById('passwordMsg').textContent.includes('not correct')`, { timeout: 8000 });
        check('目前密碼打錯會明確提示（不是靜靜失敗）', true);
        await browser.evaluate(`
            document.getElementById('currentPassword').value = ${JSON.stringify(PASSWORD)};
            document.getElementById('newPassword').value = 'newpass12345';
            document.forms.passwordForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`document.getElementById('passwordModal').hidden === true`, { timeout: 8000 });
        check('改密碼成功後彈窗自動關閉', true);
        check('新密碼可以登入', (await loginAs(app.base, 'manager', 'newpass12345')) === 200);
        check('舊密碼失效', (await loginAs(app.base, 'manager', PASSWORD)) === 401);
        /* 還原，避免影響後面的檢查 */
        const restored = await browser.evaluate(`
            return window.PDApi.post('/api/auth/change-password', { current_password: 'newpass12345', new_password: ${JSON.stringify(PASSWORD)} })
                .then(() => 'OK').catch((err) => err.code || err.message);
        `);
        check('可以再改回原本的密碼', restored === 'OK', String(restored));

        console.log('\n【9】收尾：沒有 CSP 違規、例外、下載、截圖');
        const csp = await browser.evaluate(`return window.__cspViolations || [];`);
        check('沒有 CSP 違規', csp.length === 0, JSON.stringify(csp));
        /* 【7b】故意製造的那個例外不算（那是被驗收的對象，不是意外） */
        const unexpected = browser.pageErrors.filter((line) => !String(line).includes('__check_error__'));
        check('沒有前端例外（第 7b 節故意製造的那個除外）', unexpected.length === 0, unexpected.join(' | '));
        const shot = await browser.screenshot(path.join(app.dir, 'should-not-exist.png'));
        check('截圖預設不寫檔', shot === null && !fs.existsSync(path.join(app.dir, 'should-not-exist.png')));
        check('檢查過程沒有觸發任何下載', (await browser.evaluate(`return (window.__downloads || []).length;`)) === 0);
    } catch (err) {
        failed += 1;
        failures.push(`執行錯誤：${err.message}`);
        console.error('\n✖ 檢查中斷：', err.message);
        exitCode = 1;
    } finally {
        await browser.close();
        app.cleanup();
    }

    console.log(`\n===== 帳號管理驗收：${passed} 通過 / ${failed} 失敗 =====`);
    if (failures.length) {
        console.log('失敗項目：');
        for (const item of failures) console.log(` - ${item}`);
    }
    if (failed || exitCode) process.exit(1);
}

main();
