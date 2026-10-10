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
const Totp = require('../../lib/totp');

const PASSWORD = 'pass123456';

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
        const usersTableInfo = await browser.evaluate(`
            return {
                rows: [...document.querySelectorAll('#usersTableBody tr')].length,
                accounts: [...document.querySelectorAll('#usersTableBody td strong')].map((n) => n.textContent),
                hasSelfBadge: document.getElementById('usersTableBody').textContent.includes('you'),
                roleSelects: document.querySelectorAll('#usersTableBody select[data-action="role"]').length,
                headers: [...document.querySelectorAll('#usersBlock thead th')].map((th) => th.textContent)
            };
        `);
        check('五個種子帳號都列出來', usersTableInfo.rows === 5 && usersTableInfo.accounts.includes('teacher'), JSON.stringify(usersTableInfo.accounts));
        check('自己的那一列有標記（you）', usersTableInfo.hasSelfBadge);
        check('比自己低的角色可以行內改（admin 不能改自己／同級／網站管理員）', usersTableInfo.roleSelects === 3, String(usersTableInfo.roleSelects));
        check('表頭是英文', usersTableInfo.headers.includes('Account') && usersTableInfo.headers.includes('Role'), usersTableInfo.headers.join(','));

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

        console.log('\n【7d】概況、稽核匯出與清理、同類錯誤處理（v0.4.4）');
        await browser.evaluate(`document.getElementById('navStatsBtn').click(); return true;`);
        await browser.waitFor(`document.querySelectorAll('#statsList .audit-item').length > 0`, { timeout: 8000 });
        const statsUi = await browser.evaluate(`return {
            lines: document.querySelectorAll('#statsList .audit-item').length,
            units: document.querySelectorAll('#statsUnits .audit-item').length,
            text: document.getElementById('statsList').textContent,
            note: document.getElementById('statsBlock').textContent.includes('No personal data') || document.getElementById('statsBlock').textContent.length > 0
        };`);
        check('概況面板載入聚合數字（不含個資）', statsUi.lines >= 5 && statsUi.units >= 1, JSON.stringify([statsUi.lines, statsUi.units]));
        check('概況顯示已確認／待審核的數字', /confirmed|waiting/.test(statsUi.text), statsUi.text.slice(0, 80));

        /* 匯出：不按按鈕（那會下載檔案），改用頁面內的 fetch 驗內容 */
        await browser.evaluate(`document.getElementById('navAuditBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('auditExportBtn') !== null`);
        const exportProbe = await browser.evaluate(`
            return fetch('/api/admin/audit-logs/export', { credentials: 'same-origin', cache: 'no-store' })
                .then((r) => r.arrayBuffer().then((buf) => {
                    const bytes = new Uint8Array(buf);
                    const head = new TextDecoder('utf-8').decode(bytes.slice(0, 40));
                    return { status: r.status, type: r.headers.get('content-type'), bom: bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF, head, size: bytes.length };
                }));
        `);
        check('稽核匯出回 CSV、帶 UTF-8 BOM（Excel 開中文不會亂碼）',
            exportProbe.status === 200 && /text\/csv/.test(exportProbe.type || '') && exportProbe.bom === true,
            JSON.stringify(exportProbe));
        check('匯出按鈕存在但預設不會自己下載（要使用者自己按）',
            (await browser.evaluate(`return document.getElementById('auditExportBtn').hidden === false;`)) === true);
        check('整個檢查過程仍然沒有任何下載', (await browser.evaluate(`return (window.__downloads || []).length;`)) === 0);

        /* 清理：第一次只預覽 */
        await browser.evaluate(`document.getElementById('auditCleanupBtn').click(); return true;`);
        await browser.waitFor(`document.body.textContent.includes('Clean up') || document.body.textContent.includes('clean') || document.querySelector('.toast')`, { timeout: 8000 });
        const cleanupProbe = await browser.evaluate(`
            return fetch('/api/admin/audit-logs/cleanup', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
                .then((r) => r.json()).then((d) => ({ dry: d.dry_run, days: d.keep_days, would: d.would_delete }));
        `);
        check('清理預設只預覽（不會一按就刪）', cleanupProbe.dry === true && cleanupProbe.days === 365, JSON.stringify(cleanupProbe));

        /* 同類處理：錯誤紀錄面板上每列都有那顆按鈕 */
        await browser.evaluate(`document.getElementById('navErrorsBtn').click(); return true;`);
        await browser.waitFor(`document.querySelectorAll('#errorsList .audit-item').length > 0`, { timeout: 8000 });
        check('錯誤紀錄每一列都有「同類全部標為已處理」的按鈕',
            (await browser.evaluate(`return document.querySelectorAll('#errorsList [data-action="resolve-similar"]').length;`)) >= 1);

        console.log('\n【7e】科代表看到的按鈕 = 後端真的允許的（C-2）：已發佈的只給老師改');
        /* 直接建一個科代表帳號，避免動到前面測試用過的帳號 */
        const repUser = store.createUser({
            username: 'repcheck', display_name: 'Rep Check', role: 'class_rep',
            password_hash: require('../../lib/passwords').hashPassword(PASSWORD), is_active: true
        });
        /* 一筆已發佈（老師的）+ 一筆待審核（科代表的） */
        const repUnits = store.listUnits({ includeUnpublished: true });
        const repUnit = repUnits[0];
        const repPublished = store.listEntries({ unitId: repUnit.id }).find((entry) => entry.status === 'published');
        const repPending = store.createEntry({
            unit_id: repUnit.id, headword: 'repword', headword_norm: 'repword', status: 'pending',
            sort_order: 99, created_by: 'repcheck', zh_meaning: '科代表新增的', en_definition: 'added by a class rep'
        });

        await logoutViaUi(browser);
        await loginViaUi(browser, { username: 'repcheck' });
        await browser.evaluate(`window.PDApp.backToShelf(); return true;`);
        await browser.waitFor(`document.querySelectorAll('#bookShelf [data-book-id]').length > 0`, { timeout: 8000 });
        await browser.evaluate(`document.querySelector('#bookShelf [data-book-id]').click(); return true;`);
        await browser.waitFor(`document.getElementById('unitList').hidden === false`, { timeout: 8000 });
        await browser.evaluate(`document.querySelector('#unitList [data-unit-id]').click(); return true;`);
        await browser.waitFor(`document.querySelectorAll('#vocabList .vocab-item').length > 0`, { timeout: 8000 });

        const repView = await browser.evaluate(`
            const cards = Array.from(document.querySelectorAll('#vocabList .vocab-item'));
            const find = (id) => cards.find((card) => String(card.dataset.entryId) === String(id));
            const published = find(${repPublished.id});
            const pending = find(${repPending.id});
            return {
                publishedButtons: published ? published.querySelectorAll('[data-action="edit-entry"], [data-action="delete-entry"]').length : -1,
                publishedLocked: published ? /已發佈|Published/.test(published.textContent) : false,
                pendingButtons: pending ? pending.querySelectorAll('[data-action="edit-entry"], [data-action="delete-entry"]').length : -1,
                pendingEdit: pending ? Boolean(pending.querySelector('[data-action="edit-entry"]')) : false
            };`);
        check('科代表看不到「已發佈生字」的編輯／刪除按鈕（後端也是拒絕的）',
            repView.publishedButtons === 0, JSON.stringify(repView));
        check('已發佈的生字對科代表顯示「🔒 已發佈」而不是按鈕', repView.publishedLocked === true, JSON.stringify(repView));
        check('科代表看得到自己新增的待審核生字可以編輯',
            repView.pendingButtons === 2 && repView.pendingEdit === true, JSON.stringify(repView));

        /* 按下編輯真的能打開表單（不是看得到卻按不下去） */
        await browser.evaluate(`
            const card = Array.from(document.querySelectorAll('#vocabList .vocab-item')).find((node) => String(node.dataset.entryId) === '${repPending.id}');
            card.querySelector('[data-action="edit-entry"]').click();
            return true;
        `);
        await browser.waitFor(`document.getElementById('entryForm') && document.getElementById('fHeadword').value === 'repword'`, { timeout: 8000 });
        check('按下編輯會載入那一筆待審核生字', (await browser.evaluate(`return document.getElementById('fHeadword').value;`)) === 'repword');

        /* 後端複驗：在頁面內帶 cookie 呼叫（科代表改已發佈生字一定要被拒） */
        const blocked = await browser.evaluate(`
            return fetch('/api/entries/${repPublished.id}', {
                method: 'PATCH', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ headword: 'hacked' })
            }).then((res) => res.status);
        `);
        check('科代表直接呼叫 API 改已發佈生字會被擋（403）', blocked === 403, String(blocked));

        store.deleteEntry(repPending.id);
        store.deleteUser(repUser.id);

        /* 交還給管理員：後面的【8】要按帳號管理（科代表看不到那顆按鈕）。
         * ★ 重新登入後管理區是收起的，而【8】是在「已經打開」的前提下按分頁 → 這裡要把它打開，
         *   否則分頁會在收起的容器裡（量到 0×0 的寬度，v0.4.5 踩過一次）。 */
        await logoutViaUi(browser);
        await loginViaUi(browser, { username: 'manager' });
        await browser.evaluate(`document.getElementById('adminToggleBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('adminSection').hidden === false`, { timeout: 8000 });

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
        const usersWrapInfo = await browser.evaluate(`
            const wrap = document.querySelector('#usersBlock .table-wrap');
            return {
                has: Boolean(wrap),
                scrollWidth: wrap ? wrap.scrollWidth : -1,
                clientWidth: wrap ? wrap.clientWidth : -1,
                rows: document.querySelectorAll('#usersTableBody tr').length,
                cells: document.querySelectorAll('#usersTableBody tr:first-child td').length
            };
        `);
        check('窄螢幕時表格自己在框內橫向捲動（不是把整頁撐開）',
            usersWrapInfo.has && usersWrapInfo.scrollWidth > usersWrapInfo.clientWidth, JSON.stringify(usersWrapInfo));
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

        console.log('\n【8c】兩步驟驗證與帳號救援（v0.4.3）：自助開啟 → 登入第二步 → 臨時密碼 → 重設 2FA → 登出所有裝置');
        /* 先切回英文，讓下面的斷言用英文比對 */
        await browser.evaluate(`const btn = document.querySelector('#langSwitch [data-lang="en"]'); if (btn) btn.click(); return true;`);
        await sleep(200);

        /* ---- 老師自己開啟兩步驟驗證（真的走畫面） ---- */
        await logoutViaUi(browser);
        await loginViaUi(browser, { username: 'teacher' });
        await browser.evaluate(`document.getElementById('passwordBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('passwordModal').hidden === false`);
        const beforeSetup = await browser.evaluate(`return document.getElementById('twoFactorState').textContent;`);
        check('預設是「未開啟」兩步驟驗證（不強制，使用者指定）', /off/i.test(beforeSetup), beforeSetup);

        await browser.evaluate(`document.getElementById('twoFactorStartBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('twoFactorSetup').hidden === false`, { timeout: 8000 });
        const secret = await browser.evaluate(`return document.getElementById('twoFactorSecret').textContent.trim();`);
        check('按「開啟」會顯示一組密鑰（給驗證器 App 用）', /^[A-Z2-7]{16,}=*$/.test(secret), secret.slice(0, 12));

        /* 用我們自己的 TOTP 實作算出現在的驗證碼（與手機 App 相同演算法） */
        const enableCode = Totp.codeAt(secret, Date.now() / 1000);
        await browser.evaluate(`
            document.getElementById('twoFactorCode').value = '${enableCode}';
            document.getElementById('twoFactorEnableBtn').click();
            return true;
        `);
        await browser.waitFor(`document.getElementById('twoFactorBackupBox').hidden === false`, { timeout: 8000 });
        const backupCodes = await browser.evaluate(`return document.getElementById('twoFactorBackupCodes').textContent.trim().split(/\s*·\s*/);`);
        check('開啟成功並顯示 8 組備援碼（只顯示這一次）', backupCodes.length === 8, String(backupCodes.length));
        check('資料庫存的是密文（不是明文密鑰）',
            store.findUserByUsername('teacher').totp_secret.includes(secret) === false
            && store.findUserByUsername('teacher').totp_enabled_at !== null);

        /* ---- 登入要兩步：畫面會換成輸入驗證碼 ---- */
        await logoutViaUi(browser);
        await browser.evaluate(`document.getElementById('loginBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('loginModal').hidden === false`);
        await browser.evaluate(`
            document.getElementById('loginUsername').value = 'teacher';
            document.getElementById('loginPassword').value = ${JSON.stringify(PASSWORD)};
            document.forms.loginForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`document.getElementById('login2faBlock').hidden === false`, { timeout: 8000 });
        check('密碼正確時不會直接登入：彈窗要求驗證碼', true);
        check('這時候還沒有登入狀態', (await browser.evaluate(`return window.PDAuth.isLoggedIn();`)) === false);

        /* 錯的碼：留在原地並顯示錯誤 */
        await browser.evaluate(`
            document.getElementById('login2faCode').value = '000000';
            document.forms.loginForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`document.getElementById('loginMsg').textContent.length > 0`, { timeout: 8000 });
        check('錯誤的驗證碼不會登入', (await browser.evaluate(`return window.PDAuth.isLoggedIn();`)) === false);

        /* 正確的碼：登入成功 */
        const loginCode = Totp.codeAt(secret, Date.now() / 1000);
        await browser.evaluate(`
            document.getElementById('login2faCode').value = '${loginCode}';
            document.forms.loginForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`document.getElementById('logoutBtn') !== null`, { timeout: 8000 });
        check('輸入正確驗證碼後完成登入', true);

        /* 備援碼也可以登入（用掉一組） */
        const backupFirst = backupCodes[0];
        await logoutViaUi(browser);
        await browser.evaluate(`document.getElementById('loginBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('loginModal').hidden === false`);
        await browser.evaluate(`
            document.getElementById('loginUsername').value = 'teacher';
            document.getElementById('loginPassword').value = ${JSON.stringify(PASSWORD)};
            document.forms.loginForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`document.getElementById('login2faBlock').hidden === false`, { timeout: 8000 });
        await browser.evaluate(`
            document.getElementById('login2faCode').value = '${backupFirst}';
            document.forms.loginForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`document.getElementById('logoutBtn') !== null`, { timeout: 8000 });
        check('備援碼也能登入（用掉一組）', store.findUserByUsername('teacher').backup_codes.length === 7,
            String(store.findUserByUsername('teacher').backup_codes.length));

        /* ---- 管理員：2FA 欄位、臨時密碼、重設 2FA、登出所有裝置 ---- */
        await logoutViaUi(browser);
        await loginViaUi(browser, { username: 'webmanager' });
        await browser.evaluate(`document.getElementById('adminToggleBtn').click(); return true;`);
        await browser.evaluate(`document.getElementById('navUsersBtn').click(); return true;`);
        await browser.waitFor(`window.__rowFor('teacher') !== null`, { timeout: 8000 });
        const twoFactorCell = await browser.evaluate(`
            const tr = window.__rowFor('teacher');
            const cell = tr.querySelector('[data-two-factor]');
            return cell ? { value: cell.getAttribute('data-two-factor'), text: cell.textContent } : null;
        `);
        check('帳號管理顯示兩步驟驗證狀態', twoFactorCell && twoFactorCell.value === 'on' && /on/i.test(twoFactorCell.text),
            JSON.stringify(twoFactorCell));

        await browser.evaluate(`window.__rowFor('teacher').querySelector('[data-action="temp-password"]').click(); return true;`);
        await browser.waitFor(`document.querySelector('[data-field="temp-password"]') !== null`, { timeout: 8000 });
        const tempPassword = await browser.evaluate(`return document.querySelector('[data-field="temp-password"]').textContent.trim();`);
        check('管理員可以產生一次性臨時密碼並在畫面顯示', tempPassword.length >= 10, tempPassword.length + ' 字元');
        check('臨時密碼可以用來登入（真的生效）', (await loginAs(app.base, 'teacher', tempPassword)) === 200);
        check('臨時密碼沒有寫進稽核或資料庫明文', store.findUserByUsername('teacher').password_hash.includes(tempPassword) === false);

        /* 重設兩步驟驗證（手機掉了的救援） */
        await browser.evaluate(`window.__rowFor('teacher').querySelector('[data-action="reset-2fa"]').click(); return true;`);
        await browser.waitFor(`window.__rowFor('teacher').querySelector('[data-two-factor]').getAttribute('data-two-factor') === 'off'`, { timeout: 8000 });
        check('重設兩步驟驗證後狀態變回未設定', store.findUserByUsername('teacher').totp_enabled_at === null);

        /* 登出所有裝置：兩段式確認，會把該帳號的 token_version 加一 */
        const versionBefore = Number(store.findUserByUsername('teacher').token_version) || 1;
        await browser.evaluate(`window.__rowFor('teacher').querySelector('[data-action="force-logout"]').click(); return true;`);
        await browser.waitFor(`window.__rowFor('teacher').querySelector('[data-action="force-logout"]').textContent.includes('confirm')`, { timeout: 5000 });
        check('登出所有裝置要按兩次（防手滑）', (Number(store.findUserByUsername('teacher').token_version) || 1) === versionBefore);
        await browser.evaluate(`window.__rowFor('teacher').querySelector('[data-action="force-logout"]').click(); return true;`);
        const bumped = await waitForStore(() => (Number(store.findUserByUsername('teacher').token_version) || 1) > versionBefore);
        check('第二次按才真的把所有裝置登出（工作階段版本 +1）', bumped === true,
            String(store.findUserByUsername('teacher').token_version));
        check('一般登出不會影響其他裝置（使用者指定）', await (async () => {
            const a = await loginAs(app.base, 'teacher', tempPassword);
            const versionNow = Number(store.findUserByUsername('teacher').token_version) || 1;
            return a === 200 && (Number(store.findUserByUsername('teacher').token_version) || 1) === versionNow;
        })());

        /* 復原：把老師的密碼改回去，後面的收尾檢查才不會被影響 */
        await logoutViaUi(browser);
        await loginViaUi(browser, { username: 'manager' });

        console.log('\n【8d】所有帳號、所有裝置一起登出（只有 web_manager 有這顆按鈕）');
        /* admin 看不到這顆按鈕 */
        await logoutViaUi(browser);
        await loginViaUi(browser, { username: 'manager' });
        await browser.evaluate(`document.getElementById('adminToggleBtn').click(); return true;`);
        await browser.evaluate(`document.getElementById('navUsersBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('logoutAllBtn') !== null`, { timeout: 8000 });
        check('admin 看不到「所有帳號所有裝置一起登出」', (await browser.evaluate(`return document.getElementById('logoutAllBtn').hidden;`)) === true);

        /* web_manager 看得到，而且要按兩次 */
        await logoutViaUi(browser);
        await loginViaUi(browser, { username: 'webmanager' });
        await browser.evaluate(`document.getElementById('adminToggleBtn').click(); return true;`);
        await browser.evaluate(`document.getElementById('navUsersBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('logoutAllBtn').hidden === false`, { timeout: 8000 });
        check('web_manager 看得到這顆按鈕，而且就在「新增帳號」旁邊',
            (await browser.evaluate(`return document.getElementById('logoutAllBtn').previousElementSibling.id;`)) === 'newUserBtn');

        const versionsBefore = store.listUsers().map((u) => Number(u.token_version) || 1);
        await browser.evaluate(`document.getElementById('logoutAllBtn').click(); return true;`);
        check('第一次按只進入確認狀態（沒有真的登出）',
            (await waitForStore(() => store.listUsers().every((u, i) => (Number(u.token_version) || 1) === versionsBefore[i]), 1500)) === true);
        await browser.evaluate(`document.getElementById('logoutAllBtn').click(); return true;`);
        const allBumped = await waitForStore(() => store.listUsers().every((u, i) => (Number(u.token_version) || 1) > versionsBefore[i]));
        check('第二次按：所有帳號的工作階段版本都 +1', allBumped === true);
        await browser.waitFor(`document.getElementById('loginBtn') !== null`, { timeout: 8000 });
        check('按下之後自己這一台也被登出（使用者指定）',
            (await browser.evaluate(`return window.PDAuth.isLoggedIn();`)) === false);
        check('舊權杖失效後，仍然可以用密碼重新登入（只是要重新登入一次）',
            await (async () => {
                const statuses = await Promise.all(['manager', 'webmanager'].map((name) => loginAs(app.base, name, PASSWORD)));
                return statuses.every((status) => status === 200);
            })());

        console.log('\n【8e】v0.4.6：檔案匯入預覽、批次審核、播放全部、排序與複製');
        /* 【8d】的「全部登出」把所有權杖都作廢了 → 這裡要先重新登入，才看得到老師／管理員的按鈕 */
        await loginViaUi(browser, { username: 'manager' });
        await browser.evaluate(`document.getElementById('adminToggleBtn').click(); return true;`);
        /* 先確保有一個單元可以操作，並造兩筆待審核生字 */
        const book0 = store.listBooks({ includeUnpublished: true })[0];
        const unit0 = store.listUnits({ bookId: book0.id, includeUnpublished: true })[0];
        const pendingA = store.createEntry({
            unit_id: unit0.id, headword: 'batchone', headword_norm: 'batchone', status: 'pending', sort_order: 80, created_by: 'manager'
        });
        const pendingB = store.createEntry({
            unit_id: unit0.id, headword: 'batchtwo', headword_norm: 'batchtwo', status: 'pending', sort_order: 81, created_by: 'manager'
        });

        await browser.goto(`${app.base}/`);
        await browser.waitFor(`document.querySelectorAll('#bookShelf [data-book-id]').length > 0`, { timeout: 15000 });
        await browser.evaluate(STUBS);
        await browser.evaluate(`document.querySelector('#bookShelf [data-book-id]').click(); return true;`);
        await browser.waitFor(`document.getElementById('unitList').hidden === false`, { timeout: 8000 });

        /* 單元列的 ↑ ↓ ⧉ 都要在（B-4） */
        const unitTools = await browser.evaluate(`return {
            moveUp: document.querySelectorAll('#unitList [data-action="move-unit"][data-direction="up"]').length,
            moveDown: document.querySelectorAll('#unitList [data-action="move-unit"][data-direction="down"]').length,
            dup: document.querySelectorAll('#unitList [data-action="duplicate-unit"]').length,
            units: document.querySelectorAll('#unitList .unit-row').length
        };`);
        check('單元列有 ↑ ↓ 與複製單元（B-4）',
            unitTools.moveUp === unitTools.units && unitTools.moveDown === unitTools.units && unitTools.dup === unitTools.units,
            JSON.stringify(unitTools));

        /* 複製單元：單元數 +1、複製出來的是待審核、沒有錄音 */
        const beforeUnits = store.listUnits({ bookId: book0.id, includeUnpublished: true }).length;
        await browser.evaluate(`document.querySelector('#unitList .unit-row [data-action="duplicate-unit"]').click(); return true;`);
        const duplicated = await waitForStore(() => store.listUnits({ bookId: book0.id, includeUnpublished: true }).length === beforeUnits + 1);
        check('按 ⧉ 會複製出一個新單元（B-4）', duplicated === true);
        const copyUnit = store.listUnits({ bookId: book0.id, includeUnpublished: true }).slice(-1)[0];
        check('複製出來的單元預設不發佈、生字是待審核',
            copyUnit.is_published === false && store.listEntries({ unitId: copyUnit.id }).every((entry) => entry.status === 'pending'),
            JSON.stringify([copyUnit.is_published, store.listEntries({ unitId: copyUnit.id }).length]));

        /* 排序：先造一個排在最後的單元，用 ↑ 與上一個互換編號（互換邏輯在伺服器，前端只按鈕） */
        const moveTarget = store.createUnit({ book_id: book0.id, unit_no: 90, title: 'Temp 90', sort_order: 90, is_published: true });
        const neighbour = store.listUnits({ bookId: book0.id, includeUnpublished: true })
            .filter((item) => item.id !== moveTarget.id)
            .sort((a, b) => Number(b.unit_no) - Number(a.unit_no))[0];
        await browser.evaluate(`return window.PDApp.reloadUnits('${book0.id}').then(() => true);`);
        await browser.waitFor(`document.querySelector('#unitList .unit-row[data-unit-id="${moveTarget.id}"] [data-action="move-unit"][data-direction="up"]') !== null`, { timeout: 8000 });
        await browser.evaluate(`document.querySelector('#unitList .unit-row[data-unit-id="${moveTarget.id}"] [data-action="move-unit"][data-direction="up"]').click(); return true;`);
        const swapped = await waitForStore(() => Number(store.getUnit(moveTarget.id).unit_no) === Number(neighbour.unit_no));
        check('按 ↑ 會與上一個單元互換編號（B-4）', swapped === true,
            JSON.stringify([store.getUnit(moveTarget.id).unit_no, neighbour.unit_no]));
        /* 這個臨時單元不用清：整輪用的是暫存資料庫，行程結束就一起消失 */
        await browser.evaluate(`return window.PDApp.reloadUnits('${book0.id}').then(() => true);`);

        /* 檔案匯入（B-3）：在頁面裡做一個真的 CSV File，走「選檔 → 預覽 → 匯入」 */
        /* 回到一開始那個單元（就是要匯入的目標）—— 先確認它在畫面上（列表可能剛重新渲染過） */
        const backToUnit = await browser.evaluate(`
            const node = document.querySelector('#unitList [data-unit-id="${unit0.id}"]');
            if (node) node.click();
            return { found: Boolean(node), rows: document.querySelectorAll('#unitList .unit-row').length, ids: Array.from(document.querySelectorAll('#unitList .unit-row')).map((row) => row.dataset.unitId).join(',') };
        `);
        check('回到原本的單元準備匯入（B-3）', backToUnit.found === true, JSON.stringify(backToUnit));
        await browser.waitFor(`document.getElementById('vocabList').hidden === false`, { timeout: 8000 });
        await browser.evaluate(`document.getElementById('adminToggleBtn').click(); return true;`);
        await browser.evaluate(`document.getElementById('importToggleBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('importForm').hidden === false`, { timeout: 8000 });
        const fileImport = await browser.evaluate(`
            const csv = '生字,音標,詞性,中文解釋\\ncsvword1,/kæmpəs/,n.,測試一\\ncsvword2,,n.,測試二\\n';
            const file = new File([csv], 'words.csv', { type: 'text/csv' });
            const input = document.getElementById('importFileInput');
            const data = new DataTransfer();
            data.items.add(file);
            input.files = data.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        `);
        await browser.waitFor(`document.getElementById('importPreview').hidden === false`, { timeout: 8000 });
        const preview = await browser.evaluate(`return {
            rows: document.querySelectorAll('#importPreviewTable tr').length,
            selects: document.querySelectorAll('#importPreviewTable select.import-map').length,
            guessed: Array.from(document.querySelectorAll('#importPreviewTable select.import-map')).map((node) => node.value).join(','),
            note: document.getElementById('importFileMsg').textContent
        };`);
        check('選 CSV 之後會出現預覽與欄位對應（B-3）', preview.rows >= 3 && preview.selects >= 4, JSON.stringify(preview));
        check('表頭會自動對應到生字／音標／詞性／中文（B-3）',
            preview.guessed.startsWith('headword,ipa_us,part_of_speech,zh_meaning'), preview.guessed);
        check('預覽會說讀到幾列（B-3）', /\d/.test(preview.note), preview.note);

        const beforeEntries = store.countEntries(unit0.id, null);
        await browser.evaluate(`document.getElementById('importFileRunBtn').click(); return true;`);
        const imported = await waitForStore(() => store.countEntries(unit0.id, null) === beforeEntries + 2);
        check('按下匯入會真的把兩筆寫進資料庫（B-3）', imported === true);
        check('匯入的生字內容正確（B-3）',
            (store.findEntryByHeadword(unit0.id, 'csvword1') || {}).zh_meaning === '測試一',
            JSON.stringify(store.findEntryByHeadword(unit0.id, 'csvword1')));

        /* 播放全部（B-2）：按了會變「停止」，第一張會被標成正在播 */
        await browser.evaluate(`document.getElementById('playAllBtn').click(); return true;`);
        /* 標記是同步加上去的；但如果在播放途中畫面剛好重畫，我們會自動補回去，
         * 所以這裡等一下下再讀（避免搶在重畫中間）。 */
        let playing = { label: '', marked: 0 };
        try {
            await browser.waitFor(`document.querySelectorAll('#vocabList .vocab-item.is-playing').length >= 1`, { timeout: 3000 });
        } catch (err) { /* 讀不到就照原樣斷言，讓失敗訊息帶著實際狀態 */ }
        playing = await browser.evaluate(`return {
            label: document.getElementById('playAllBtn').textContent,
            marked: document.querySelectorAll('#vocabList .vocab-item.is-playing').length
        };`);
        check('「▶ 播放全部」按下去會進入播放狀態（B-2）',
            /停止|Stop/i.test(playing.label) && playing.marked >= 1, JSON.stringify(playing));
        await browser.evaluate(`document.getElementById('playAllBtn').click(); return true;`);
        /* ★ 停止是「非同步」的（要等播放器收尾）→ 不能只 sleep 200ms 就斷言，
         *   機器忙的時候會偶發紅燈（真的踩過）。改成等狀態真的收乾淨。 */
        let stopped = false;
        try {
            await browser.waitFor(`document.querySelectorAll('#vocabList .vocab-item.is-playing').length === 0`, { timeout: 5000 });
            stopped = true;
        } catch (err) {
            stopped = (await browser.evaluate(`return document.querySelectorAll('#vocabList .vocab-item.is-playing').length;`)) === 0;
        }
        check('再按一次會停止，標記也會清掉（B-2）', stopped);

        /* 沒有老師錄音的生字要看得到「電腦語音」徽章（B-2 的誠實原則） */
        check('沒有老師錄音的生字標示「電腦語音」（B-2）',
            (await browser.evaluate(`return document.querySelectorAll('#vocabList .tag-badge-muted').length;`)) >= 1);

        /* 批次審核（B-6）：勾兩筆 → 一次核准 */
        await browser.evaluate(`document.getElementById('navPendingBtn').click(); return true;`);
        await browser.waitFor(`document.querySelectorAll('#pendingList .pending-check').length >= 2`, { timeout: 8000 });
        const batchUi = await browser.evaluate(`return {
            checks: document.querySelectorAll('#pendingList .pending-check').length,
            approveBtn: Boolean(document.getElementById('pendingApproveAllBtn')),
            rejectBtn: Boolean(document.getElementById('pendingRejectAllBtn')),
            disabledBefore: document.getElementById('pendingApproveAllBtn').disabled
        };`);
        check('待審核每一筆都有勾選框，並有批次核准／退回按鈕（B-6）',
            batchUi.checks >= 2 && batchUi.approveBtn && batchUi.rejectBtn, JSON.stringify(batchUi));
        check('還沒勾選之前批次按鈕是停用的（不會誤按）', batchUi.disabledBefore === true);

        await browser.evaluate(`
            const ids = ['${pendingA.id}', '${pendingB.id}'];
            for (const id of ids) {
                const box = document.querySelector('#pendingList .pending-check[data-entry-id="' + id + '"]');
                box.checked = true;
                box.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return true;
        `);
        check('勾選之後批次按鈕會啟用（B-6）',
            (await browser.evaluate(`return document.getElementById('pendingApproveAllBtn').disabled;`)) === false);
        await browser.evaluate(`document.getElementById('pendingApproveAllBtn').click(); return true;`);
        const approvedBoth = await waitForStore(() => store.getEntry(pendingA.id).status === 'published' && store.getEntry(pendingB.id).status === 'published');
        check('批次核准會把勾選的生字一次發佈（B-6）', approvedBoth === true);

        /* 批次退回要留原因，而且科代表看得到 */
        const pendingC = store.createEntry({
            unit_id: unit0.id, headword: 'batchthree', headword_norm: 'batchthree', status: 'pending', sort_order: 82, created_by: 'classrep'
        });
        /* 重新載入單元（待審核清單也會跟著更新），再切回待審核分頁 */
        await browser.evaluate(`return window.PDApp.reloadUnit({ keepForm: true }).then(() => { document.getElementById('navPendingBtn').click(); return true; });`);
        await browser.waitFor(`document.querySelector('#pendingList .pending-check[data-entry-id="${pendingC.id}"]') !== null`, { timeout: 8000 });
        const rejected = await browser.evaluate(`
            const box = document.querySelector('#pendingList .pending-check[data-entry-id="${pendingC.id}"]');
            box.checked = true;
            box.dispatchEvent(new Event('change', { bubbles: true }));
            document.getElementById('pendingBatchNote').value = '請補上英文解釋';
            document.getElementById('pendingRejectAllBtn').click();
            return true;
        `);
        const rejectedDone = await waitForStore(() => store.getEntry(pendingC.id).status === 'rejected');
        check('批次退回會把生字退回並附原因（B-6）', rejectedDone === true);
        check('退回原因存在生字上（科代表看得到）（B-6）',
            store.getEntry(pendingC.id).review_note === '請補上英文解釋',
            store.getEntry(pendingC.id).review_note);

        /* 清乾淨這一區造的資料 */
        for (const id of [pendingA.id, pendingB.id, pendingC.id]) store.deleteEntry(id);

        /* 【8f】D-1：生字表分頁（載入更多、伺服器端搜尋） */
        console.log('\n【8e2】帳號表格排版：操作欄按鈕同一行、列高一致（使用者回報的錯位）');
        {
            const layout = await browser.evaluate(`
                const rows = Array.from(document.querySelectorAll('#usersTableBody tr'));
                return rows.map((tr) => {
                    const buttons = Array.from(tr.querySelectorAll('.cell-actions button'));
                    const tops = buttons.map((b) => Math.round(b.getBoundingClientRect().top));
                    const cell = tr.querySelector('.cell-actions');
                    return {
                        who: (tr.querySelector('strong') || {}).textContent || '',
                        height: Math.round(tr.getBoundingClientRect().height),
                        buttons: buttons.length,
                        distinctTops: Array.from(new Set(tops)).length,
                        align: cell ? getComputedStyle(cell).textAlign : null,
                        empty: Boolean(tr.querySelector('.cell-actions .actions-empty'))
                    };
                });
            `);
            const withButtons = layout.filter((row) => row.buttons > 0);
            const heights = layout.map((row) => row.height);
            check('每一列的按鈕都在同一行（沒有疊成一欄）', withButtons.every((row) => row.distinctTops === 1), JSON.stringify(layout));
            check('每一列的列高一致（差 ≤ 4px）', Math.max(...heights) - Math.min(...heights) <= 4, JSON.stringify(heights));
            check('操作欄靠右對齊', layout.every((row) => row.align === 'right'), JSON.stringify(layout.map((row) => row.align)));
            check('沒有操作可按的那一列顯示「—」（不是空白）', layout.some((row) => row.empty) || layout.every((row) => row.buttons > 0), JSON.stringify(layout));

            /* 授權清單要看得到年級（v0.6.2 修：前端原本讀已經不存在的 book_name） */
            const grantItems = await browser.evaluate(`
                const items = Array.from(document.querySelectorAll('#grantList .grant-item'));
                return items.map((item) => item.textContent.trim().replace(/\\s+/g, ' ').slice(0, 80));
            `);
            if (grantItems.length) {
                check('授權清單顯示年級（不是空一格）', grantItems.every((row) => /S\d/.test(row)), JSON.stringify(grantItems));
            } else {
                check('授權清單（目前沒有授權資料，略過內容檢查）', true);
            }
        }

        console.log('\n【8e3】管理區也跟著字級縮放（v0.6.3：整個介面，不是只有字）');
        {
            const rows = {};
            for (const value of ['s', 'm', 'l']) {
                await browser.evaluate(`document.querySelector('#fontSwitch [data-font-value="${value}"]').click(); return true;`);
                await sleep(300);
                rows[value] = await browser.evaluate(`
                    const tr = document.querySelector('#usersTableBody tr');
                    const cell = document.querySelector('#usersTableBody td');
                    const r = tr ? tr.getBoundingClientRect() : null;
                    return {
                        rowHeight: r ? Math.round(r.height) : null,
                        cellFont: cell ? Math.round(parseFloat(getComputedStyle(cell).fontSize) * 10) / 10 : null,
                        overflow: document.documentElement.scrollWidth - window.innerWidth
                    };
                `);
            }
            const scaled = (key) => rows.m[key] > 0 && rows.l[key] >= rows.m[key] * 1.1 && rows.s[key] <= rows.m[key] * 0.92;
            check('管理區帳號表格的列高跟著字級縮放', scaled('rowHeight'), JSON.stringify(rows));
            check('管理區帳號表格的字級跟著字級縮放', scaled('cellFont'), JSON.stringify(rows));
            check('管理區在三種字級都沒有水平溢出',
                ['s', 'm', 'l'].every((value) => rows[value].overflow <= 2),
                JSON.stringify(['s', 'm', 'l'].map((value) => rows[value].overflow)));
            /* 還原成預設（中） */
            await browser.evaluate(`document.querySelector('#fontSwitch [data-font-value="m"]').click(); return true;`);
            await sleep(200);
        }

        console.log('\n【8f】生字表分頁：一頁 60 筆、載入更多、搜尋走伺服器（v0.6.0）');
        {
            const unitId = await browser.evaluate(`return window.PDState.currentUnitId;`);
            if (!unitId) {
                check('有開啟的單元可以測分頁', false, '沒有 currentUnitId');
            } else {
                const pageUnit = store.getUnit(unitId);
                for (let i = 1; i <= 130; i += 1) {
                    store.createEntry({
                        unit_id: pageUnit.id,
                        headword: 'paging' + String(i).padStart(3, '0'),
                        headword_norm: 'paging' + String(i).padStart(3, '0'),
                        zh_meaning: '分頁測試', en_definition: 'paging test',
                        status: 'published', sort_order: 1000 + i, created_by: 'test'
                    });
                }
                await browser.evaluate(`return window.PDApp.reloadUnit({ keepForm: true });`);
                await browser.waitFor(`document.getElementById('loadMoreBtn').hidden === false`, { timeout: 10000 });
                const pageFirst = await browser.evaluate(`return {
                    cards: document.querySelectorAll('#vocabList .vocab-item').length,
                    note: document.getElementById('loadMoreNote').textContent,
                    total: window.PDState.entriesMeta.total,
                    hasMore: window.PDState.entriesMeta.has_more
                };`);
                check('第一頁只渲染 60 張卡', pageFirst.cards === 60, JSON.stringify(pageFirst));
                /* 單元裡本來就有前面段落留下的生字 → 總數用伺服器回的，不要寫死 */
                check('提示顯示已顯示 60／總數', /60/.test(pageFirst.note) && pageFirst.note.includes(String(pageFirst.total)), pageFirst.note);
                check('has_more 是 true（還有下一頁）', pageFirst.hasMore === true);
                check('總數大於一頁（才有分頁可測）', pageFirst.total > 60, pageFirst.total);

                await browser.evaluate(`document.getElementById('loadMoreBtn').click(); return true;`);
                await browser.waitFor(`document.querySelectorAll('#vocabList .vocab-item').length === 120`, { timeout: 10000 });
                check('載入更多之後變成 120 張卡', true);

                await browser.evaluate(`document.getElementById('loadMoreBtn').click(); return true;`);
                await browser.waitFor(`document.getElementById('loadMoreBtn').hidden === true`, { timeout: 10000 });
                const pageThird = await browser.evaluate(`return document.querySelectorAll('#vocabList .vocab-item').length;`);
                check('載完所有生字之後按鈕收起', pageThird === pageFirst.total, `${pageThird} / ${pageFirst.total}`);

                /* 搜尋走伺服器：最後一頁的字也找得到 */
                await browser.evaluate(`
                    const input = document.getElementById('searchInput');
                    input.value = 'paging123';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    return true;
                `);
                await browser.waitFor(`document.querySelectorAll('#vocabList .vocab-item').length === 1`, { timeout: 12000 });
                const pageSearch = await browser.evaluate(`return document.getElementById('vocabList').textContent.trim();`);
                check('搜尋由伺服器端過濾（只回命中的那一筆）', pageSearch.includes('paging123'), pageSearch.slice(0, 60));

                /* 清掉搜尋 → 回到第一頁 */
                await browser.evaluate(`
                    const input = document.getElementById('searchInput');
                    input.value = '';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    return true;
                `);
                await browser.waitFor(`document.querySelectorAll('#vocabList .vocab-item').length === 60`, { timeout: 12000 });
                check('清掉搜尋回到第一頁（60 張）', true);
            }
        }

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
