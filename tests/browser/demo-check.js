/* 真實瀏覽器驗收（Demo 的 12 步劇本）
 *
 * 為什麼一定要用真瀏覽器：API 測試看不到「按鈕按下去沒反應」「畫面沒有更新」
 * 「CSP 把行內事件擋成啞的」這一類問題——它們不會有任何例外，只有真的點下去才會現形。
 *
 * 規則（沿用 competition-manager 的慣例）：
 * - 不寫任何截圖檔（browser.screenshot() 預設回 null）、不觸發任何下載。
 * - 判定一律來自頁面內量到的數值，不依賴截圖。
 * - 每個檢查用自己的暫存資料檔，絕不動 data/store.json。
 *
 * 用法：node tests/browser/demo-check.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Browser, sleep } = require('./lib/cdp');
const { createApp } = require('../../server');
const { hashPassword } = require('../../lib/passwords');

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

function seed(store) {
    for (const [username, role, display] of [
        ['manager', 'admin', '網頁管理員'],
        ['teacher', 'teacher', '英文老師'],
        ['classrep', 'class_rep', '英文科代表']
    ]) {
        store.createUser({
            username, role, display_name: display,
            password_hash: hashPassword(PASSWORD), is_active: true
        });
    }
    const book = store.createBook({ code: 'B5A', name: 'Book 5A', grade: 'S1', sort_order: 1, is_published: true });
    const unit = store.createUnit({ book_id: book.id, unit_no: 1, title: 'My New School', sort_order: 1, is_published: true });
    const rows = [
        ['campus', '/ˈkæm.pəs/', 'n.', '校園', 'the land and buildings of a school', 'Our campus is next to the park.', '我們的校園在公園旁邊。'],
        ['librarian', '/laɪˈbreə.ri.ən/', 'n.', '圖書館員', 'a person who works in a library', '', ''],
        ['timetable', '/ˈtaɪmˌteɪ.bəl/', 'n.', '時間表', 'a list of class times', '', '']
    ];
    rows.forEach((row, index) => {
        const [headword, ipa, pos, zh, en, exEn, exZh] = row;
        store.createEntry({
            unit_id: unit.id,
            headword,
            headword_norm: headword,
            ipa_us: ipa,
            part_of_speech: pos,
            zh_meaning: zh,
            en_definition: en,
            example_en: exEn,
            example_zh: exZh,
            status: 'published',
            sort_order: index + 1,
            created_by: 'seed'
        });
    });
    return { book, unit };
}

/* 在頁面內注入測試替身：語音合成、Audio、對話框、下載守衛 */
const STUBS = `
    window.__spoken = [];
    window.__audioSrcs = [];
    window.__ALERTS__ = [];
    window.__downloads = window.__downloads || [];
    if (window.speechSynthesis) {
        window.speechSynthesis.speak = (utterance) => {
            window.__spoken.push({ text: utterance.text, lang: utterance.lang });
        };
        window.speechSynthesis.cancel = () => {};
    }
    const OriginalAudio = window.Audio;
    window.Audio = function (src) {
        window.__audioSrcs.push(String(src));
        return {
            play: () => Promise.resolve(),
            pause: () => {},
            set onended(fn) { window.__audioEnd = fn; },
            get onended() { return window.__audioEnd; },
            set onerror(fn) { window.__audioError = fn; },
            get onerror() { return window.__audioError; }
        };
    };
    window.Audio.prototype = OriginalAudio.prototype;
    window.alert = (message) => { window.__ALERTS__.push(String(message)); };
    window.confirm = () => true;
    window.__downloadGuardInstalled = true;
    return true;
`;

async function typeLogin(browser, username) {
    await browser.evaluate(`
        document.getElementById('loginUsername').value = ${JSON.stringify(username)};
        document.getElementById('loginPassword').value = ${JSON.stringify(PASSWORD)};
        document.forms.loginForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return true;
    `);
    // 登入完成的訊號用「登出」按鈕（不依賴顯示名稱，介面已改成以英文為主）
    await browser.waitFor(`document.getElementById('logoutBtn') !== null`, { timeout: 8000 });
}

async function openLogin(browser) {
    await browser.evaluate(`document.getElementById('loginBtn').click(); return true;`);
    await browser.waitFor(`document.getElementById('loginModal').hidden === false`);
}

async function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-browser-'));
    const dataFile = path.join(dir, 'store.json');
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'browser-check-secret';
    const app = createApp({ backend: 'json', dataFile });
    const store = app.locals.store;
    const ids = seed(store);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;

    const browser = await Browser.launch({ width: 1280, height: 950 });
    let exitCode = 0;
    try {
        await browser.goto(`${base}/`);
        await browser.evaluate(STUBS);
        await browser.waitFor(`document.getElementById('bookShelf').children.length > 0`, { timeout: 8000 });

        console.log('\n【1-4】訪客：書架（封面）→ 目錄 → 單元 → 生字表 → 聽讀音 → 搜尋');
        const shelf = await browser.evaluate(`return Array.from(document.getElementById('bookShelf').children).map(b => b.textContent);`);
        check('書架顯示年級 S1（含單元數與生字數）', shelf.some((t) => t.includes('S1')), shelf.join('/'));
        check('書架上完全沒有書名（v0.5.0）', shelf.every((t) => !t.includes('Book 5A')), shelf.join('/'));
        check('書架上沒有任何封面圖（v0.5.0）',
            (await browser.evaluate(`return document.querySelectorAll('#bookShelf img').length;`)) === 0);
        const coverCards = await browser.evaluate(`return document.querySelectorAll('#bookShelf [data-book-id]').length;`);
        check('每個書本都是一個可點的封面卡片', coverCards >= 1, String(coverCards));
        const shelfFirst = await browser.evaluate(`return document.getElementById('shelfView').hidden === false;`);
        check('首頁是書架而不是生字表', shelfFirst === true);

        await browser.evaluate(`document.querySelector('#bookShelf [data-book-id]').click(); return true;`);
        await browser.waitFor(`document.getElementById('unitsView').hidden === false`);
        const chips = await browser.evaluate(`return Array.from(document.getElementById('unitList').children).map(b => b.textContent);`);
        check('目錄列出單元與生字數', chips.some((t) => t.includes('Unit 1')) && chips.some((t) => t.includes('words')), chips.join('/'));
        check('訪客看不到「修改單元」的 ✏️（後端也會再擋一次）',
            (await browser.evaluate(`return document.querySelectorAll('#unitList [data-action="edit-unit"]').length;`)) === 0);
        check('進入目錄時生字表還不顯示（要再點單元）',
            (await browser.evaluate(`return document.getElementById('unitSection').hidden === true;`)) === true);

        await browser.evaluate(`document.querySelector('#unitList [data-unit-id]').click(); return true;`);
        await browser.waitFor(`document.getElementById('unitSection').hidden === false`);
        await browser.waitFor(`document.querySelectorAll('.vocab-item').length > 0`);

        const first = await browser.evaluate(`return (() => {
            const card = document.querySelector('.vocab-item');
            return {
                headword: card.querySelector('.headword').textContent,
                ipa: card.querySelector('.ipa').textContent,
                pos: card.querySelector('.pos-badge').textContent,
                zh: card.querySelector('.meaning-zh').textContent,
                en: card.querySelector('.meaning-en').textContent,
                count: document.querySelectorAll('.vocab-item').length
            };
        })();`);
        check('生字卡顯示 生字/IPA/詞性/中文/英文', first.headword === 'campus' && first.ipa.includes('/ˈkæm.pəs/')
            && first.pos === 'n.' && first.zh === '校園' && first.en.length > 5,
        JSON.stringify(first));
        check('訪客看得到 3 個生字', first.count === 3, String(first.count));

        await browser.evaluate(`document.querySelector('.speak-btn').click(); return true;`);
        await sleep(400);
        const spoken = await browser.evaluate(`return window.__spoken;`);
        check('按下 🔊 會呼叫語音合成唸出該生字', spoken.length >= 1 && spoken[0].text === 'campus', JSON.stringify(spoken));
        check('語音合成的語言是英文', spoken.length >= 1 && /^en/.test(spoken[0].lang), JSON.stringify(spoken));

        const search = await browser.evaluate(`return (() => {
            const input = document.getElementById('searchInput');
            input.value = '圖書館';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            const shown = document.querySelectorAll('.vocab-item').length;
            const headword = document.querySelector('.vocab-item .headword').textContent;
            input.value = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return { shown, headword, restored: document.querySelectorAll('.vocab-item').length };
        })();`);
        check('搜尋「圖書館」只剩 1 個生字（比對中英文與 IPA）', search.shown === 1 && search.headword === 'librarian', JSON.stringify(search));
        check('清空搜尋後恢復全部生字', search.restored === 3, String(search.restored));

        console.log('\n【4b】訪客的站內說明（B-1）：看得到「怎麼查生字」、看不到管理員的步驟');
        await browser.evaluate(`document.getElementById('guideBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('guidePanel').hidden === false`, { timeout: 8000 });
        await browser.waitFor(`document.querySelectorAll('#guideSections .guide-section').length > 0`, { timeout: 8000 });
        await browser.waitFor(`document.querySelectorAll('#guideRoles table tr').length > 1`, { timeout: 8000 });
        const guestGuide = await browser.evaluate(`return {
            sections: document.querySelectorAll('#guideSections .guide-section').length,
            firstTitle: (document.querySelector('#guideSections .guide-title') || {}).textContent || '',
            text: document.getElementById('guideSections').textContent,
            roleRows: document.querySelectorAll('#guideRoles table tr').length,
            roleCols: document.querySelectorAll('#guideRoles table tr:first-child th').length,
            printBtn: Boolean(document.getElementById('guidePrintBtn')),
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            downloads: (window.__downloads || []).length
        };`);
        check('訪客按 ❓ 打得開說明頁', guestGuide.sections >= 1, JSON.stringify(guestGuide.sections));
        check('訪客第一眼看到的是「怎麼查生字」', /look up a word|查一個生字/i.test(guestGuide.firstTitle), guestGuide.firstTitle);
        check('訪客看不到管理員的步驟（帳號管理／稽核不在裡面）',
            !/New account|新增帳號|Audit log|稽核紀錄/i.test(guestGuide.text));
        check('角色與權限對照表由後端產生（6 個角色 + 7 項能力）',
            guestGuide.roleRows === 8 && guestGuide.roleCols === 7, JSON.stringify([guestGuide.roleRows, guestGuide.roleCols]));
        check('說明頁有列印按鈕（不按，按了會開列印視窗）', guestGuide.printBtn === true);
        check('說明頁沒有橫向溢出、也沒有下載', guestGuide.overflow <= 1 && guestGuide.downloads === 0, JSON.stringify([guestGuide.overflow, guestGuide.downloads]));
        await browser.evaluate(`document.getElementById('guideCloseBtn').click(); return true;`);
        const afterClose = await browser.evaluate(`return { panelHidden: document.getElementById('guidePanel').hidden, view: (window.PDApp && window.PDApp.view) || '', shelfHidden: document.getElementById('shelfView').hidden };`);
        check('關閉說明頁之後回到進來之前的畫面（不是停在說明）', afterClose.panelHidden === true && afterClose.view !== 'guide', JSON.stringify(afterClose));

        console.log('\n【4c】鍵盤操作（F-4）：/ 跳到搜尋、Esc 關掉說明頁、有跳至內容的連結');
        check('有「跳到主要內容」的連結（F-4）',
            (await browser.evaluate(`return document.querySelector('.skip-link') !== null;`)) === true);
        check('搜尋框在這個畫面是看得到的（鍵盤快捷鍵的前提）',
            (await browser.evaluate(`return document.getElementById('searchWrap').hidden === false;`)) === true);
        await browser.evaluate(`if (document.activeElement) document.activeElement.blur(); return true;`);
        await browser.evaluate(`
            document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
            return true;
        `);
        const slashFocus = await browser.evaluate(`return document.activeElement === document.getElementById('searchInput');`);
        check('按 / 會把游標移到搜尋框（F-4）', slashFocus === true,
            await browser.evaluate(`return document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : 'none';`));
        /* 在輸入框裡打 / 不能又被搶去（不然沒辦法打斜線） */
        check('在輸入框裡打字時 / 不會被搶走（F-4）',
            (await browser.evaluate(`
                const input = document.getElementById('searchInput');
                input.focus();
                let prevented = false;
                document.addEventListener('keydown', (event) => { if (event.key === '/') prevented = event.defaultPrevented; }, { once: true });
                /* 事件要從輸入框送出（target 才會是輸入框）—— 從 document 送的話 target 是 document，
                 * 那就變成「不在輸入框裡打字」，測不到我們要擋的情況。 */
                input.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
                return { prevented, stillFocused: document.activeElement === input };
            `)).prevented === false);
        await browser.evaluate(`document.getElementById('searchInput').blur(); return true;`);
        await browser.evaluate(`document.getElementById('guideBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('guidePanel').hidden === false`, { timeout: 6000 });
        await browser.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`);
        await sleep(200);
        check('按 Esc 會關掉說明頁（F-4）',
            (await browser.evaluate(`return document.getElementById('guidePanel').hidden;`)) === true);
        check('Esc 關掉之後回到原本的畫面（F-4）',
            (await browser.evaluate(`return (window.PDApp && window.PDApp.view) !== 'guide';`)) === true);

        console.log('\n【5-7】管理員：登入 → 新增生字 → 批次貼上 → 刪除');
        await openLogin(browser);
        await typeLogin(browser, 'manager');
        check('登入後顯示使用者與角色', (await browser.evaluate(`return document.getElementById('authArea').textContent;`)).includes('Web administrator'));
        check('登入後出現「✏️ 管理」按鈕', (await browser.evaluate(`return document.getElementById('adminToggleBtn').hidden === false;`)) === true);

        console.log('\n【5b】從生字卡按「編輯」會自動打開管理區（使用者回報：沒開就看不到）');
        await browser.evaluate(`
            document.querySelector('.vocab-item [data-action="edit-entry"]').click();
            return true;
        `);
        await browser.waitFor(`document.getElementById('adminSection').hidden === false`, { timeout: 6000 });
        check('按「編輯」時管理區自動打開', true);
        const editingValue = await browser.evaluate(`return document.getElementById('fHeadword').value;`);
        check('表單直接載入該生字（不是空白表單）', editingValue === 'campus', editingValue);
        check('一次只顯示一塊：其他表單都關著',
            (await browser.evaluate(`return document.getElementById('bookForm').hidden === true && document.getElementById('unitForm').hidden === true;`)) === true);
        await browser.evaluate(`document.getElementById('cancelEntryBtn').click(); return true;`);
        /* 收起來，讓下面「管理員：登入 → 新增生字」的流程維持原本的按鈕語意 */
        await browser.evaluate(`document.getElementById('adminToggleBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('adminSection').hidden === true`);

        console.log('\n【5c】修改單元：目錄的 ✏️ → 改名稱與編號 → 目錄與生字表都更新（使用者指定）');
        /* 先回到書架再點進同一本書：這次不選任何單元（＝使用者的情境：目錄有單元但還沒點進去） */
        await browser.evaluate(`document.getElementById('unitsBackBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('shelfView').hidden === false`);
        await browser.evaluate(`document.querySelector('#bookShelf [data-book-id]').click(); return true;`);
        await browser.waitFor(`document.getElementById('unitsView').hidden === false && document.getElementById('unitList').children.length > 0`);
        const hintState = await browser.evaluate(`return {
            hidden: document.getElementById('adminHint').hidden,
            text: document.getElementById('adminHint').textContent,
            tone: document.getElementById('adminHint').dataset.tone || '',
            unitRows: document.querySelectorAll('#unitList .unit-row').length,
            addWordDisabled: document.getElementById('newEntryBtn').disabled
        };`);
        check('目錄已經有單元時，提示不會說「這本書還沒有單元」（使用者回報的錯誤訊息）',
            hintState.hidden === false && !/no units/i.test(hintState.text) && /already has/i.test(hintState.text),
            JSON.stringify(hintState));
        check('這種提示是中性的（不是警告色）', hintState.tone === 'info', hintState.tone);
        check('還沒選單元時「新增生字」確實是停用的（只是提示文字不再誤導）', hintState.addWordDisabled === true);
        const editUi = await browser.evaluate(`return {
            buttons: document.querySelectorAll('#unitList [data-action="edit-unit"]').length,
            rows: document.querySelectorAll('#unitList .unit-row').length,
            aria: (document.querySelector('#unitList [data-action="edit-unit"]') || {}).getAttribute
                ? document.querySelector('#unitList [data-action="edit-unit"]').getAttribute('aria-label') : ''
        };`);
        check('目錄每一列都有「修改單元」（老師以上才看得到）', editUi.buttons === editUi.rows && editUi.buttons > 0,
            JSON.stringify(editUi));
        check('修改鈕有無障礙標籤（aria-label）', (editUi.aria || '').length > 0, editUi.aria);

        await browser.evaluate(`document.querySelector('#unitList [data-action="edit-unit"]').click(); return true;`);
        await browser.waitFor(`document.getElementById('unitEditForm').hidden === false`, { timeout: 6000 });
        const prefilled = await browser.evaluate(`return {
            sectionOpen: document.getElementById('adminSection').hidden === false,
            activeTab: document.querySelector('#adminNav [data-admin-tab="unitEdit"]').getAttribute('aria-selected'),
            no: document.getElementById('fUnitEditNo').value,
            title: document.getElementById('fUnitEditTitle').value,
            others: document.getElementById('unitForm').hidden === true && document.getElementById('bookForm').hidden === true
        };`);
        check('按 ✏️ 會自動打開管理區並切到「修改單元」分頁',
            prefilled.sectionOpen === true && prefilled.activeTab === 'true' && prefilled.others === true,
            JSON.stringify(prefilled));
        check('表單帶入那一列的單元（不是空白）', prefilled.no === '1' && prefilled.title === 'My New School',
            JSON.stringify([prefilled.no, prefilled.title]));

        await browser.evaluate(`
            document.getElementById('fUnitEditNo').value = '3';
            document.getElementById('fUnitEditTitle').value = 'Renamed Unit';
            document.forms.unitEditForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`document.getElementById('unitList').textContent.includes('Renamed Unit')`, { timeout: 8000 });
        const renamedRow = await browser.evaluate(`return {
            row: document.querySelector('#unitList [data-action="edit-unit"]').closest('.unit-row').textContent,
            msg: document.getElementById('unitEditMsg').textContent
        };`);
        check('目錄那一列的名稱與編號都更新了', renamedRow.row.includes('Renamed Unit') && renamedRow.row.includes('Unit 3'),
            renamedRow.row);
        check('表單顯示成功訊息（含新的編號）', renamedRow.msg.includes('Unit 3'), renamedRow.msg);
        check('資料庫（權威狀態）也是新的名稱與編號',
            store.getUnit(ids.unit.id).title === 'Renamed Unit' && store.getUnit(ids.unit.id).unit_no === 3,
            JSON.stringify([store.getUnit(ids.unit.id).title, store.getUnit(ids.unit.id).unit_no]));

        /* 改回來，讓後面的檢查維持原本的預期（Unit 1 / My New School） */
        await browser.evaluate(`
            document.getElementById('fUnitEditNo').value = '1';
            document.getElementById('fUnitEditTitle').value = 'My New School';
            document.forms.unitEditForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`document.getElementById('unitList').textContent.includes('My New School')`, { timeout: 8000 });
        check('改回原本的名稱與編號也成功', store.getUnit(ids.unit.id).unit_no === 1 && store.getUnit(ids.unit.id).title === 'My New School',
            JSON.stringify([store.getUnit(ids.unit.id).unit_no, store.getUnit(ids.unit.id).title]));

        /* 回到生字表並收起管理區，維持下面流程的起點 */
        await browser.evaluate(`document.querySelector('#unitList [data-unit-id="${ids.unit.id}"]').click(); return true;`);
        await browser.waitFor(`document.getElementById('unitSection').hidden === false`, { timeout: 8000 });
        await browser.evaluate(`document.getElementById('adminToggleBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('adminSection').hidden === true`);

        console.log('\n【5-7】管理員：新增生字 → 批次貼上 → 刪除（管理區在編輯後已收起）');
        await browser.evaluate(`document.getElementById('adminToggleBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('adminSection').hidden === false`);
        /* ★ 等「新增生字」真的可用再點：登入後／畫面重畫時它會短暫 disabled，
         *   太早點下去等於沒點（entryForm 永遠不會開 → 偶發紅燈，實際踩過）。
         *   真的沒開就再點一次（第一次可能落在重畫中間）。 */
        await browser.waitFor(`(() => { const b = document.getElementById('newEntryBtn'); return Boolean(b) && !b.disabled; })()`, { timeout: 15000 });
        await browser.evaluate(`document.getElementById('newEntryBtn').click(); return true;`);
        try {
            await browser.waitFor(`document.getElementById('entryForm').hidden === false`, { timeout: 7000 });
        } catch (err) {
            await browser.evaluate(`document.getElementById('newEntryBtn').click(); return true;`);
            await browser.waitFor(`document.getElementById('entryForm').hidden === false`, { timeout: 15000 });
        }
        await browser.evaluate(`
            document.getElementById('fHeadword').value = 'laboratory';
            document.getElementById('fPos').value = 'n.';
            document.getElementById('fIpaUs').value = '/ləˈbɒr.ə.tər.i/';
            document.getElementById('fZh').value = '實驗室';
            document.getElementById('fEn').value = 'a room used for science experiments';
            document.forms.entryForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`Array.from(document.querySelectorAll('.headword')).some(n => n.textContent === 'laboratory')`, { timeout: 6000 });
        check('新增生字後清單立即出現該字', true);
        const added = await browser.evaluate(`return (() => {
            const card = Array.from(document.querySelectorAll('.vocab-item')).find(c => c.querySelector('.headword').textContent === 'laboratory');
            return { ipa: card.querySelector('.ipa').textContent, zh: card.querySelector('.meaning-zh').textContent };
        })();`);
        check('新增的生字欄位完整', added.ipa === '/ləˈbɒr.ə.tər.i/' && added.zh === '實驗室', JSON.stringify(added));

        const duplicate = await browser.evaluate(`
            document.getElementById('fHeadword').value = 'Campus';
            document.getElementById('fZh').value = '重複測試';
            document.forms.entryForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return new Promise((resolve) => setTimeout(() => resolve(document.getElementById('entryFormMsg').textContent), 700));
        `);
        check('重複生字（大小寫不同）被擋下並說明原因', duplicate.includes('already has'), duplicate);

        await browser.evaluate(`document.getElementById('cancelEntryBtn').click(); return true;`);
        await browser.evaluate(`document.getElementById('importToggleBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('importForm').hidden === false`);
        await browser.evaluate(`
            document.getElementById('importText').value = [
                'principal\\t/ˈprɪn.sə.pəl/\\tn.\\t校長\\tthe head of a school',
                'uniform\\t/ˈjuː.nɪ.fɔːm/\\tn.\\t校服\\tschool clothes',
                'campus\\t\\t\\t重複\\tduplicate'
            ].join('\\n');
            document.forms.importForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`Array.from(document.querySelectorAll('.headword')).some(n => n.textContent === 'uniform')`, { timeout: 6000 });
        const importMsg = await browser.evaluate(`return document.getElementById('importMsg').textContent;`);
        check('批次匯入新增 2 筆、略過 1 筆', importMsg.includes('Added 2') && importMsg.includes('skipped 1'), importMsg);
        await browser.evaluate(`document.getElementById('importCancelBtn').click(); return true;`);

        const deleted = await browser.evaluate(`return (async () => {
            const card = Array.from(document.querySelectorAll('.vocab-item')).find(c => c.querySelector('.headword').textContent === 'uniform');
            const btn = card.querySelector('[data-action="delete-entry"]');
            btn.click();                                   // 第一次：變成確認狀態
            const label = btn.textContent;
            btn.click();                                   // 第二次：真的刪除
            await new Promise(r => setTimeout(r, 900));
            return { label, stillThere: Array.from(document.querySelectorAll('.headword')).some(n => n.textContent === 'uniform') };
        })();`);
        check('刪除採「再按一次確認」，第二次才真的刪除', deleted.label.includes('Press again') && deleted.stillThere === false, JSON.stringify(deleted));

        console.log('\n【8】老師錄音：上傳檔案 → 徽章 → 播放來源');
        const entryId = await browser.evaluate(`
            const card = document.querySelector('.vocab-item');
            return card.dataset.entryId;
        `);
        await browser.evaluate(`
            const card = document.querySelector('.vocab-item');
            card.querySelector('[data-action="upload-audio"]').click();
            return true;
        `);
        await browser.waitFor(`document.getElementById('audioModal').hidden === false`);
        const modalTitle = await browser.evaluate(`return document.getElementById('audioModalHeadword').textContent;`);
        check('錄音視窗顯示要錄的生字', modalTitle === 'campus', modalTitle);
        const audioSize = await browser.evaluate(`return (() => {
            const panel = document.querySelector('#audioModal .modal-panel');
            return {
                width: Math.round(panel.getBoundingClientRect().width),
                pickBtn: Math.round(document.getElementById('audioPickFileBtn').getBoundingClientRect().height),
                pickWidth: Math.round(document.getElementById('audioPickFileBtn').getBoundingClientRect().width)
            };
        })();`);
        check('錄音視窗比從前寬（≥500px）且按鈕更大（≥44px 高）',
            audioSize.width >= 500 && audioSize.pickBtn >= 44, JSON.stringify(audioSize));

        // 用真的檔案走真實路徑（選檔 → FileReader → 上傳 API → 畫面更新），不繞過 UI
        const audioFile = path.join(dir, 'teacher-sample.webm');
        fs.writeFileSync(audioFile, Buffer.from('1a45dfa3-fake-webm-bytes-for-check'));
        const doc = await browser.send('DOM.getDocument', { depth: -1 });
        const fileNode = await browser.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#audioFileInput' });
        await browser.send('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: [audioFile] });
        // CDP 設定檔案後「不一定」會自動送出 change：先等自動路徑，沒有反應才自己補一次
        let uploaded = false;
        try {
            await browser.waitFor(`document.getElementById('audioMsg').textContent.includes('Saved')`, { timeout: 2500 });
            uploaded = true;
        } catch (err) {
            uploaded = false;
        }
        if (!uploaded) {
            await browser.evaluate(`document.getElementById('audioFileInput').dispatchEvent(new Event('change', { bubbles: true })); return true;`);
        }
        await browser.waitFor(`document.getElementById('audioMsg').textContent.includes('Saved')`, { timeout: 8000 });
        check('選檔後上傳成功並提示已儲存', true);
        await browser.waitFor(`document.getElementById('audioModal').hidden === true`, { timeout: 6000 });
        const badge = await browser.evaluate(`return Array.from(document.querySelectorAll('.tag-badge')).map(n => n.textContent);`);
        check('生字卡出現「👩‍🏫 老師錄音」徽章', badge.some((t) => t.includes('Teacher recording')), badge.join('/'));

        await browser.evaluate(`window.__audioSrcs = []; window.__spoken = []; document.querySelector('.speak-btn').click(); return true;`);
        await sleep(500);
        const playback = await browser.evaluate(`return { srcs: window.__audioSrcs, spoken: window.__spoken };`);
        check('有老師錄音時 🔊 播錄音而不是語音合成',
            playback.srcs.some((src) => src.includes('/api/audio/')) && playback.spoken.length === 0,
            JSON.stringify(playback));

        console.log('\n【9-10】批次與年級／單元維護');
        await browser.evaluate(`document.getElementById('newUnitBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('unitForm').hidden === false`);
        await browser.evaluate(`
            document.getElementById('fUnitNo').value = '2';
            document.getElementById('fUnitTitle').value = 'School Life';
            document.forms.unitForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`document.getElementById('unitTitle').textContent.includes('School Life')`, { timeout: 6000 });
        check('新增單元後直接進入新單元的生字表', true);
        const newUnitEmpty = await browser.evaluate(`return document.getElementById('vocabEmpty').hidden === false;`);
        check('新單元顯示「還沒有生字」而不是空白', newUnitEmpty === true);

        await browser.evaluate(`document.getElementById('newBookBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('bookForm').hidden === false`);
        await browser.evaluate(`
            /* v0.5.0：建立年級只要填年級 */
            document.getElementById('fBookGrade').value = 'S2';
            document.forms.bookForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`document.getElementById('unitsView').hidden === false && document.getElementById('unitsTitle').textContent.includes('S2')`, { timeout: 6000 });
        check('新增書本後直接進入它的目錄（接著就能新增單元）', true);
        check('書架上也出現新的年級（S2）', (await browser.evaluate(`return document.getElementById('bookShelf').textContent.includes('S2');`)) === true);

        console.log('\n【10b-2】字級只有兩段：A（正常）／A+（放大）— v0.6.5 移除縮小的 A−（使用者指定）');
        /* v0.6.5（使用者指定）：不再修 A−，而是**把 A− 整個移除**，只留 A（16px）與 A+（19px）。
         * 為什麼：A− 的「整體頁面大小看起來不正常」根因是**書架卡片寬度跟不上字級** ——
         * `.shelf` 是 repeat(auto-fill, minmax(10rem, 1fr))，字級只影響欄寬下限，欄寬由固定的
         * 1080px 內容欄撐滿；14px 與 16px 都湊到 6 欄，所以 A− 的卡片反而比 A 略寬（163.66 vs 161.33），
         * 只有高度縮小 → 看起來「寬而扁」。 */
        const fontButtons = await browser.evaluate(`return Array.from(document.querySelectorAll('#fontSwitch [data-font-value]')).map((btn) => btn.dataset.fontValue);`);
        check('字級切換只剩兩顆鈕：A 與 A+（沒有縮小的 A−）',
            fontButtons.length === 2 && fontButtons.join(',') === 'm,l', JSON.stringify(fontButtons));

        const fontLadder = await browser.evaluate(`return Array.from(document.querySelectorAll('#fontSwitch [data-font-value]')).map((btn) => ({
            value: btn.dataset.fontValue,
            size: parseFloat(getComputedStyle(btn).fontSize)
        }));`);
        const sizeOf = (value) => (fontLadder.find((row) => row.value === value) || {}).size || 0;
        check('A+ 的字比 A 大', sizeOf('l') > sizeOf('m'), JSON.stringify(fontLadder));
        /* v0.6.2：幅度要看得出來（原本 A− 只小 1px ＝ 使用者說「根本沒改變」） */
        check('A+ 至少比 A 大 15%（幅度看得出來）', sizeOf('l') >= sizeOf('m') * 1.15, JSON.stringify(fontLadder));

        /* 真的按下去：根字級要跟著變（A＝16px、A+＝19px） */
        const rootSizes = {};
        for (const value of ['m', 'l']) {
            await browser.evaluate(`document.querySelector('#fontSwitch [data-font-value="${value}"]').click(); return true;`);
            await sleep(150);
            rootSizes[value] = await browser.evaluate(`return parseFloat(getComputedStyle(document.documentElement).fontSize);`);
        }
        check('按下 A／A+ 根字級真的變大（16 → 19）',
            rootSizes.m === 16 && rootSizes.l > rootSizes.m, JSON.stringify(rootSizes));
        /* ★ v0.6.5：就算舊裝置記著 data-font="s"（以前選過 A−），也不可以跑出第三種字級 ——
         *   CSS 已經沒有 :root[data-font="s"] 這條規則（app.js 的 FONT_VALUES 也會把它回落成 'm'）。 */
        const staleFont = await browser.evaluate(`
            document.documentElement.dataset.font = 's';
            const size = parseFloat(getComputedStyle(document.documentElement).fontSize);
            delete document.documentElement.dataset.font;
            return size;
        `);
        check('移除的 A− 不會殘留成第三種字級（data-font="s" 只會是預設大小）',
            staleFont === rootSizes.m, JSON.stringify({ staleFont, expected: rootSizes.m }));

        /* ★ v0.6.3：使用者說「不是這三個字的問題，是整個介面沒有按照這個大小變化」——
         *   所以不能只量標題的字。這裡量的是**尺寸**：切換鈕、內容欄寬、頂欄高度。
         *   真因：間距（--space-*）與各處 padding/height 原本是固定 px → 只有文字會變。 */
        const scaleSamples = {};
        for (const value of ['m', 'l']) {
            await browser.evaluate(`document.querySelector('#fontSwitch [data-font-value="${value}"]').click(); return true;`);
            await sleep(250);
            scaleSamples[value] = await browser.evaluate(`
                const box = (sel) => {
                    const el = document.querySelector(sel);
                    if (!el) return null;
                    const r = el.getBoundingClientRect();
                    return { w: Math.round(r.width), h: Math.round(r.height) };
                };
                return {
                    chip: box('#fontSwitch'),
                    page: box('.page'),
                    topbar: box('.topbar-inner'),
                    overflow: document.documentElement.scrollWidth - window.innerWidth
                };
            `);
        }
        const scaleOk = (pick) => {
            const base = pick(scaleSamples.m);
            return base > 0 && pick(scaleSamples.l) >= base * 1.1;
        };
        check('整個介面跟著字級放大：字級切換鈕的寬度', scaleOk((row) => row.chip && row.chip.w), JSON.stringify(scaleSamples));
        check('整個介面跟著字級放大：字級切換鈕的高度', scaleOk((row) => row.chip && row.chip.h), JSON.stringify(scaleSamples));
        check('整個介面跟著字級放大：頂欄（.topbar-inner）高度', scaleOk((row) => row.topbar && row.topbar.h), JSON.stringify(scaleSamples));
        /* ★ v0.6.4：內容欄寬**不可以**跟著字級變（v0.6.3 用 rem 讓整頁縮窄、空間利用率變差，
         *   使用者回報）。字級只改介面元件大小，不改版面可用寬度。 */
        check('內容欄寬不隨字級改變（空間利用率不變）',
            Boolean(scaleSamples.m.page && scaleSamples.l.page) && Math.abs(scaleSamples.l.page.w - scaleSamples.m.page.w) <= 3,
            JSON.stringify(['m', 'l'].map((value) => (scaleSamples[value].page || {}).w)));
        check('兩種字級都沒有水平溢出（不會出現橫向捲軸）',
            ['m', 'l'].every((value) => scaleSamples[value].overflow <= 2),
            JSON.stringify(['m', 'l'].map((value) => scaleSamples[value].overflow)));

        /* ★★ v0.6.5 補上的守門：這個項目以前沒有量，所以「A− 的卡片寬而扁」才會漏掉。
         *   年級卡（.shelf-card）的**寬與高**都要跟著字級放大（A+ ≥ 1.10×A）。
         *   量之前要先把書架切到看得見（隱藏時 getBoundingClientRect() 是 0，會誤判成沒縮放）。 */
        const cardSizes = {};
        for (const value of ['m', 'l']) {
            await browser.evaluate(`document.querySelector('#fontSwitch [data-font-value="${value}"]').click(); return true;`);
            await browser.evaluate(`window.PDApp.showView('shelf'); return true;`);
            await sleep(300);
            cardSizes[value] = await browser.evaluate(`
                const card = document.querySelector('#bookShelf .shelf-card');
                if (!card) return null;
                const r = card.getBoundingClientRect();
                return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 };
            `);
        }
        const cardsUsable = Boolean(cardSizes.m && cardSizes.l) && cardSizes.m.w > 0;
        check('年級卡的寬度跟著字級放大（A+ ≥ 1.10×A）',
            cardsUsable && cardSizes.l.w >= cardSizes.m.w * 1.1, JSON.stringify(cardSizes));
        check('年級卡的高度跟著字級放大（A+ ≥ 1.10×A）',
            cardsUsable && cardSizes.l.h >= cardSizes.m.h * 1.1, JSON.stringify(cardSizes));

        /* 標籤自己要有大小階梯（光看按鈕就知道按下去會變大） */
        const labelSizes = await browser.evaluate(`
            return Array.from(document.querySelectorAll('#fontSwitch button'))
                .map((b) => Math.round(parseFloat(getComputedStyle(b).fontSize) * 100) / 100);
        `);
        check('A／A+ 標籤的字級有階梯（A < A+）',
            labelSizes.length === 2 && labelSizes[0] < labelSizes[1], JSON.stringify(labelSizes));
        /* 還原成預設（A）並回到目錄（後面的段落假設在某個畫面） */
        await browser.evaluate(`document.querySelector('#fontSwitch [data-font-value="m"]').click(); return true;`);
        await browser.evaluate(`window.PDApp.showView('units'); return true;`);
        await sleep(200);

        console.log('\n【10c】年級制：新增年級 → 書架只出現年級（v0.5.0）');
        /* 建立年級（管理區只問年級） */
        await browser.evaluate(`document.getElementById('newBookBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('bookForm').hidden === false`, { timeout: 8000 });
        const gradeForm = await browser.evaluate(`return {
            code: document.getElementById('fBookCode') === null,
            name: document.getElementById('fBookName') === null,
            grade: Boolean(document.getElementById('fBookGrade')),
            coverPanel: document.getElementById('coverPanel') === null,
            coverTab: document.querySelector('[data-admin-tab="cover"]') === null
        };`);
        check('新增年級只問年級（代號與書名欄位都不見了）',
            gradeForm.code && gradeForm.name && gradeForm.grade, JSON.stringify(gradeForm));
        check('封面面板與封面分頁都移除（v0.5.0）', gradeForm.coverPanel && gradeForm.coverTab, JSON.stringify(gradeForm));

        await browser.evaluate(`
            document.getElementById('fBookGrade').value = 'S2';
            document.getElementById('bookForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        /* demo-check 沒有 waitForStore（那是 users-check 的輔助函式）→ 自己等 */
        for (let i = 0; i < 40; i += 1) {
            if (store.listBooks({ includeUnpublished: true }).some((b) => b.grade === 'S2')) break;
            await sleep(100);
        }
        check('建立年級之後資料庫真的有一筆', store.listBooks({ includeUnpublished: true }).some((b) => b.grade === 'S2'));

        /* 書架：兩個年級、沒有書名、沒有封面圖 */
        await browser.evaluate(`document.getElementById('adminToggleBtn').click(); return true;`);
        await browser.evaluate(`document.getElementById('unitsBackBtn').click(); return true;`);
        await browser.waitFor(`document.querySelectorAll('#bookShelf [data-book-id]').length >= 2`, { timeout: 8000 });
        const shelfAfter = await browser.evaluate(`return {
            grades: Array.from(document.querySelectorAll('#bookShelf [data-book-id]')).map((b) => b.textContent.trim()),
            buttons: document.querySelectorAll('#bookShelf [data-book-id]').length,
            imgs: document.querySelectorAll('#bookShelf img').length
        };`);
        check('書架看得到兩個年級（S1／S2）',
            shelfAfter.grades.some((t) => t.includes('S1')) && shelfAfter.grades.some((t) => t.includes('S2')),
            JSON.stringify(shelfAfter.grades));
        check('書架沒有書名、沒有封面圖（v0.5.0）',
            shelfAfter.imgs === 0 && shelfAfter.grades.every((t) => !t.includes('Book ')), JSON.stringify(shelfAfter));

        /* 全流程都看不到書名：把整份 HTML 的文字掃一次 */
        const leaks = await browser.evaluate(`return {
            html: /Book 5A|Book 6B/.test(document.body.textContent),
            adminOpen: document.getElementById('adminSection').hidden === false
        };`);
        check('畫面上（含管理區）沒有任何書名', leaks.html === false, JSON.stringify(leaks));

        console.log('\n【10d】修改年級：管理區的 ✏️ 改名 → 書架與稽核都跟著變（v0.6.0）');
        /* 先回到管理區的「新增年級」分頁 */
        await browser.evaluate(`document.getElementById('newBookBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('gradeListBlock').hidden === false`, { timeout: 8000 });
        await browser.waitFor(`document.querySelectorAll('#gradeList .grade-row').length >= 2`, { timeout: 8000 });
        const gradeList = await browser.evaluate(`return {
            rows: document.querySelectorAll('#gradeList .grade-row').length,
            texts: Array.from(document.querySelectorAll('#gradeList .grade-row')).map((row) => row.textContent.trim()),
            editBtns: document.querySelectorAll('#gradeList [data-action="edit-grade"]').length
        };`);
        check('年級清單列出所有年級、每一列都有 ✏️', gradeList.rows >= 2 && gradeList.editBtns === gradeList.rows, JSON.stringify(gradeList));

        /* 改第一個年級（S1 → S9） */
        await browser.evaluate(`
            const row = Array.from(document.querySelectorAll('#gradeList .grade-row')).find((r) => r.textContent.includes('S1'));
            row.querySelector('[data-action="edit-grade"]').click();
            return true;
        `);
        await browser.waitFor(`document.getElementById('gradeEditForm').hidden === false`, { timeout: 8000 });
        const gradePrefilled = await browser.evaluate(`return document.getElementById('fGradeEditValue').value;`);
        check('修改年級的表單會先填好現在的年級', gradePrefilled === 'S1', gradePrefilled);

        await browser.evaluate(`
            document.getElementById('fGradeEditValue').value = 'S9';
            document.getElementById('gradeEditForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        for (let i = 0; i < 60; i += 1) {
            if (store.listBooks({ includeUnpublished: true }).some((b) => b.grade === 'S9')) break;
            await sleep(100);
        }
        check('年級真的改到資料庫（S9）', store.listBooks({ includeUnpublished: true }).some((b) => b.grade === 'S9'));

        /* 書架與稽核都要跟著變 */
        await browser.evaluate(`document.getElementById('adminToggleBtn').click(); return true;`);
        await browser.evaluate(`document.getElementById('unitsBackBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('bookShelf').textContent.includes('S9')`, { timeout: 8000 });
        check('書架顯示新的年級', (await browser.evaluate(`return document.getElementById('bookShelf').textContent.includes('S9');`)) === true);

        /* 重複年級要被擋（S9 → S2，S2 已存在） */
        await browser.evaluate(`document.getElementById('adminToggleBtn').click(); return true;`);
        await browser.evaluate(`document.getElementById('newBookBtn').click(); return true;`);
        await browser.waitFor(`document.querySelectorAll('#gradeList .grade-row').length >= 2`, { timeout: 8000 });
        await browser.evaluate(`
            const row = Array.from(document.querySelectorAll('#gradeList .grade-row')).find((r) => r.textContent.includes('S9'));
            row.querySelector('[data-action="edit-grade"]').click();
            document.getElementById('fGradeEditValue').value = 'S2';
            document.getElementById('gradeEditForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`document.getElementById('gradeEditMsg').textContent.trim().length > 0`, { timeout: 8000 });
        const dupMsg = await browser.evaluate(`return document.getElementById('gradeEditMsg').textContent.trim();`);
        check('改成已經有的年級會顯示錯誤（不是靜默失敗）', dupMsg.length > 0, dupMsg);
        check('重複被擋時資料沒有被改（還是 S9）', store.listBooks({ includeUnpublished: true }).some((b) => b.grade === 'S9'));

        /* 稽核要有一筆 BOOK_UPDATE（年級改名） */
        await browser.evaluate(`
            document.getElementById('gradeEditCancelBtn').click();
            document.getElementById('navAuditBtn').click();
            return true;
        `);
        await browser.waitFor(`document.querySelectorAll('#auditList .audit-item').length > 0`, { timeout: 8000 });
        const gradeAuditText = await browser.evaluate(`return document.getElementById('auditList').textContent;`);
        check('稽核紀錄看得到年級改名', gradeAuditText.includes('S9'), gradeAuditText.slice(0, 80));

        /* ★ 事情做完要把年級改回 S1：後面的段落（含稽核搜尋）都在等 S1，
         *   不還原的話會變成「前面改了名字、後面找不到」的假失敗。 */
        await browser.evaluate(`document.getElementById('newBookBtn').click(); return true;`);
        await browser.waitFor(`document.querySelectorAll('#gradeList .grade-row').length >= 2`, { timeout: 8000 });
        await browser.evaluate(`
            const row = Array.from(document.querySelectorAll('#gradeList .grade-row')).find((r) => r.textContent.includes('S9'));
            row.querySelector('[data-action="edit-grade"]').click();
            document.getElementById('fGradeEditValue').value = 'S1';
            document.getElementById('gradeEditForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        for (let i = 0; i < 60; i += 1) {
            if (store.listBooks({ includeUnpublished: true }).some((b) => b.grade === 'S1')) break;
            await sleep(100);
        }
        check('測完把年級改回 S1（後面的段落要用）', store.listBooks({ includeUnpublished: true }).some((b) => b.grade === 'S1'));
        await browser.evaluate(`document.getElementById('adminToggleBtn').click(); return true;`);
        await sleep(300);

        /* 稽核細節也要用年級 */
        await browser.evaluate(`document.getElementById('adminToggleBtn').click(); return true;`);
        await browser.evaluate(`document.getElementById('navAuditBtn').click(); return true;`);
        await browser.waitFor(`document.querySelectorAll('#auditList .audit-item').length > 0`, { timeout: 8000 });
        const auditText = await browser.evaluate(`return document.getElementById('auditList').textContent;`);
        check('稽核紀錄用年級描述（不出現書名）',
            auditText.includes('S1') && !/Book 5A/.test(auditText), auditText.slice(0, 80));

        console.log('\n【11-12】科代表新增 → 老師核准');
        await browser.evaluate(`document.getElementById('logoutBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('loginBtn') !== null`, { timeout: 6000 });
        await browser.evaluate(STUBS);
        await openLogin(browser);
        await typeLogin(browser, 'classrep');
        /* 等書架真的有 Book 5A 再點（登入後書架是非同步重畫的） */
        await browser.waitFor(`Array.from(document.querySelectorAll('#bookShelf [data-book-id]')).some(b => b.textContent.includes('S1'))`, { timeout: 8000 });
        await browser.evaluate(`
            Array.from(document.querySelectorAll('#bookShelf [data-book-id]'))
                .find(b => b.textContent.includes('S1')).click();
            return true;
        `);
        /* 這裡不能用「目錄畫面已顯示」當條件：切書時它本來就還開著，要等清單真的換成新書的單元 */
        await browser.waitFor(`Array.from(document.querySelectorAll('#unitList [data-unit-id]')).some(b => b.textContent.includes('Unit 1'))`, { timeout: 8000 });
        await browser.evaluate(`
            const rows = Array.from(document.querySelectorAll('#unitList [data-unit-id]'));
            rows.find(b => b.textContent.includes('Unit 1')).click();
            return true;
        `);
        await browser.waitFor(`document.querySelectorAll('.vocab-item').length > 0`);
        /* ★ 先等按鈕真的可用（跟【5-7】同一個理由：重畫中點下去等於沒點） */
        await browser.evaluate(`
            document.getElementById('adminToggleBtn').click();
            return true;
        `);
        await browser.waitFor(`(() => { const b = document.getElementById('newEntryBtn'); return Boolean(b) && !b.disabled; })()`, { timeout: 15000 });
        await browser.evaluate(`
            document.getElementById('newEntryBtn').click();
            return true;
        `);
        await browser.waitFor(`document.getElementById('entryForm').hidden === false`, { timeout: 15000 });
        await browser.evaluate(`
            document.getElementById('fHeadword').value = 'diligent';
            document.getElementById('fZh').value = '勤奮的';
            document.getElementById('fEn').value = 'working hard and carefully';
            document.forms.entryForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`Array.from(document.querySelectorAll('.headword')).some(n => n.textContent === 'diligent')`, { timeout: 6000 });
        const pendingBadges = await browser.evaluate(`return Array.from(document.querySelectorAll('.tag-badge')).map(n => n.textContent);`);
        check('科代表新增的字顯示「待審核」標記', pendingBadges.some((t) => t.includes('Awaiting review')), pendingBadges.join('/'));
        const repView = await browser.evaluate(`return {
            items: Array.from(document.querySelectorAll('#pendingList .pending-item')).map((n) => n.textContent).join(' | '),
            note: document.getElementById('pendingNote').textContent,
            hasApprove: document.querySelector('[data-action="approve-entry"]') !== null,
            tabLabel: document.getElementById('navPendingBtn').textContent
        };`);
        check('科代表看得到自己送出的待審核清單（含說明文字）',
            repView.items.includes('diligent') && repView.note.includes('waiting for a teacher'), JSON.stringify(repView));
        check('待審核數量顯示在管理選單上', repView.tabLabel.includes('(1)'), repView.tabLabel);
        check('科代表沒有核准按鈕（核准是老師的權限）', repView.hasApprove === false);

        await browser.evaluate(`document.getElementById('logoutBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('loginBtn') !== null`);
        await browser.evaluate(STUBS);
        await openLogin(browser);
        await typeLogin(browser, 'teacher');
        await browser.evaluate(`document.getElementById('adminToggleBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('pendingBlock').hidden === false`, { timeout: 6000 });
        const pendingText = await browser.evaluate(`return document.getElementById('pendingList').textContent;`);
        check('老師看到待審核清單含 diligent（附新增者）', pendingText.includes('diligent') && pendingText.includes('classrep'), pendingText.slice(0, 80));
        await browser.evaluate(`document.querySelector('[data-action="approve-entry"]').click(); return true;`);
        await browser.waitFor(`document.querySelectorAll('#pendingList .pending-item').length === 0`, { timeout: 6000 });
        check('核准後待審核清單清空', true);

        await browser.evaluate(`document.getElementById('logoutBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('loginBtn') !== null`);
        await browser.evaluate(STUBS);
        await browser.waitFor(`Array.from(document.querySelectorAll('.headword')).some(n => n.textContent === 'diligent')`, { timeout: 6000 });
        const visitorSees = await browser.evaluate(`
            const card = Array.from(document.querySelectorAll('.vocab-item')).find(c => c.querySelector('.headword').textContent === 'diligent');
            return { badges: Array.from(card.querySelectorAll('.tag-badge')).map(n => n.textContent), card: Boolean(card) };
        `);
        check('核准後訪客（未登入）看得到 diligent', visitorSees.card === true);
        /* 發音來源徽章（👩‍🏫 老師錄音／🤖 電腦語音）是給所有人看的誠實資訊（v0.4.6），
         * 這裡要擋的是「審核狀態」標記（待審核／已退回）不能漏給訪客。 */
        const reviewBadges = visitorSees.badges.filter((text) => !/Teacher|Browser voice|老師|電腦語音/i.test(text));
        check('訪客看不到審核狀態標記', reviewBadges.length === 0, JSON.stringify(visitorSees.badges));

        console.log('\n【附加】版面、CSP、稽核、不下載不截圖');
        const overflow = await browser.evaluate(`return document.documentElement.scrollWidth - window.innerWidth;`);
        check('桌機版沒有橫向溢出', overflow <= 1, `溢出 ${overflow}px`);
        await browser.setViewport(402, 874, true);
        await sleep(400);
        const mobileOverflow = await browser.evaluate(`return document.documentElement.scrollWidth - window.innerWidth;`);
        check('手機版（402px）沒有橫向溢出', mobileOverflow <= 1, `溢出 ${mobileOverflow}px`);
        const tinyButtons = await browser.evaluate(`return Array.from(document.querySelectorAll('.page button')).filter(b => b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().height < 28).length;`);
        check('手機版沒有被壓成細條的按鈕', tinyButtons === 0, `${tinyButtons} 顆`);
        await browser.setViewport(1280, 950, false);

        const cspViolations = await browser.evaluate(`return window.__cspViolations || [];`);
        check('沒有任何 CSP 違規（行內事件／樣式都會在這裡現形）', cspViolations.length === 0, JSON.stringify(cspViolations));

        /* 忽略兩種「本機才會有」的訊息：
         *  - favicon／Failed to load resource：本機沒有那顆圖或端點
         *  - /_vercel/insights/script.js：Vercel Web Analytics 的腳本，本機沒有 Vercel 平台服務它
         *    （本機會被 SPA fallback 回 HTML，Chrome 因此報 MIME 錯誤；正式站由 Vercel 提供，是正常的 JS） */
        const consoleErrors = browser.consoleErrors.filter((line) => !/favicon|Failed to load resource|_vercel\/insights/.test(line));
        const pageErrors = browser.pageErrors;
        check('沒有前端例外', pageErrors.length === 0, pageErrors.join(' | '));
        check('沒有主控台錯誤', consoleErrors.length === 0, consoleErrors.join(' | '));

        await browser.evaluate(STUBS);
        await openLogin(browser);
        await typeLogin(browser, 'manager');

        /* 使用者回報：重新載入後停在書架（還沒點任何書），管理提示卻說「目前還沒有任何書本」。
         * 這裡故意重新載入，重現那個狀態（登入狀態在 cookie 裡，重新載入之後還在）。
         * 用瀏覽器層的 goto（真的導航），不要用頁面內 location.reload()：
         * 後者會讓後續的查詢打到已經被銷毀的執行環境，等待永遠不會成立（踩過一次）。 */
        await browser.goto(`${base}/`);
        await browser.waitFor(`document.getElementById('bookShelf') && document.getElementById('bookShelf').children.length > 0`, { timeout: 15000 });
        await browser.evaluate(STUBS);
        /* 提示是在書本載入完之後才寫上的：等它出現再斷言（先取樣會拿到空字串 —— 這個坑踩過三次了） */
        await browser.waitFor(`document.getElementById('adminHint').hidden === false && document.getElementById('adminHint').textContent.length > 0`, { timeout: 8000 });
        const shelfHint = await browser.evaluate(`return {
            text: document.getElementById('adminHint').textContent,
            tone: document.getElementById('adminHint').dataset.tone || '',
            booksOnShelf: document.querySelectorAll('#bookShelf [data-book-id]').length
        };`);
        check('重新載入停在書架時：提示不會說「還沒有任何書本」（書架上有書）',
            shelfHint.booksOnShelf > 0 && !/no books/i.test(shelfHint.text) && /already has/i.test(shelfHint.text),
            JSON.stringify(shelfHint));
        check('書架上的這種提示是中性的（不是警告色）', shelfHint.tone === 'info', shelfHint.tone);
        await browser.evaluate(`
            document.getElementById('adminToggleBtn').click();
            return true;
        `);
        /* 稽核紀錄現在是管理選單裡的一個分頁：要按「🧾」才會載入 */
        await browser.evaluate(`document.getElementById('navAuditBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('auditList').children.length > 0`, { timeout: 6000 });
        const audit = await browser.evaluate(`return document.getElementById('auditList').textContent;`);
        check('稽核紀錄看得到剛才的操作（英文動作標籤）', /Approve word|Add word|Import words/.test(audit), audit.slice(0, 120));

        /* ---- 載入指示（Loading）：頂部進度條 + 骨架屏 ---- */
        const loader = await browser.evaluate(`
            const bar = document.getElementById('appLoader');
            return {
                bar: Boolean(bar && bar.querySelector('.app-loader-bar')),
                skeleton: Boolean(document.getElementById('shelfSkeleton'))
            };
        `);
        check('有頂部載入條（#appLoader）', loader.bar === true);
        check('有書架骨架屏（#shelfSkeleton）', loader.skeleton === true);
        /* 不在同一個瞬間斷言：最短顯示時間是 350ms，剛載完時它可能還在。
         * 要驗的是「載入結束後它會自己收起」。 */
        let hiddenAfterLoad = false;
        try {
            await browser.waitFor(`document.getElementById('appLoader').hidden === true`, { timeout: 3000 });
            hiddenAfterLoad = true;
        } catch (err) {
            hiddenAfterLoad = false;
        }
        check('載入完成後載入條會自己收起', hiddenAfterLoad === true);

        const loaderLogic = await browser.evaluate(`
            window.PDLoader.show();
            const visible = document.getElementById('appLoader').hidden === false;
            window.PDLoader.hide();
            return visible;
        `);
        check('PDLoader.show() 會顯示載入條', loaderLogic === true);
        let loaderHid = false;
        try {
            await browser.waitFor(`document.getElementById('appLoader').hidden === true`, { timeout: 3000 });
            loaderHid = true;
        } catch (err) {
            loaderHid = false;
        }
        check('PDLoader.hide() 之後載入條收起（最短顯示時間過後）', loaderHid);

        console.log('\n【13】我的單元（C-1）與角色化說明（B-1）');
        await browser.goto(`${base}/`);
        await browser.waitFor(`document.getElementById('bookShelf') && document.getElementById('bookShelf').children.length > 0`, { timeout: 15000 });
        await browser.evaluate(STUBS);
        await browser.waitFor(`document.getElementById('myUnitsBlock').hidden === false`, { timeout: 8000 });
        const myUnits = await browser.evaluate(`return {
            visible: document.getElementById('myUnitsBlock').hidden === false,
            chips: document.querySelectorAll('#myUnitsList .my-units-chip').length,
            first: (document.querySelector('#myUnitsList .my-units-chip') || {}).textContent || ''
        };`);
        check('管理員看得到「我可以編輯的單元」', myUnits.visible === true && myUnits.chips >= 1, JSON.stringify(myUnits));
        check('我的單元每一項都寫出書名與單元', /Unit \d/.test(myUnits.first), myUnits.first);
        await browser.evaluate(`document.querySelector('#myUnitsList .my-units-chip').click(); return true;`);
        await browser.waitFor(`document.getElementById('unitSection').hidden === false`, { timeout: 8000 });
        const jumped = await browser.evaluate(`return {
            title: document.getElementById('unitTitle').textContent,
            entries: document.querySelectorAll('#vocabList .vocab-item').length
        };`);
        check('點「我的單元」會直接跳到那個單元', /Unit \d/.test(jumped.title) && jumped.entries >= 1, JSON.stringify(jumped));

        await browser.evaluate(`document.getElementById('guideBtn').click(); return true;`);
        await browser.waitFor(`document.querySelectorAll('#guideSections .guide-section').length > 0`, { timeout: 8000 });
        const adminGuide = await browser.evaluate(`return {
            sections: document.querySelectorAll('#guideSections .guide-section').length,
            text: document.getElementById('guideSections').textContent,
            ids: Array.from(document.querySelectorAll('#guideSections .guide-section')).map((node) => node.dataset.section).join(',')
        };`);
        check('管理員看到比較多節（老師 + 管理員 + 網站管理員）', adminGuide.sections >= 6, JSON.stringify([adminGuide.sections, adminGuide.ids]));
        check('管理員的說明包含帳號管理與稽核', /New account|新增帳號/.test(adminGuide.text) && /Audit log|稽核紀錄/.test(adminGuide.text));

        /* 切中文：說明內容要跟著換（中英都要有） */
        await browser.evaluate(`document.querySelector('#langSwitch button[data-lang="zh"]').click(); return true;`);
        await browser.waitFor(`document.getElementById('guideSections').textContent.indexOf('新增帳號') >= 0`, { timeout: 8000 });
        check('切到中文之後說明頁也變中文', (await browser.evaluate(`return document.getElementById('guideSections').textContent.indexOf('新增帳號') >= 0;`)) === true);
        await browser.evaluate(`document.querySelector('#langSwitch button[data-lang="en"]').click(); return true;`);
        await browser.evaluate(`document.getElementById('guideCloseBtn').click(); return true;`);

        const downloads = await browser.evaluate(`return window.__downloads || [];`);
        check('檢查過程沒有觸發任何下載', downloads.length === 0, JSON.stringify(downloads));
        const shot = await browser.screenshot(path.join(dir, 'should-not-exist.png'));
        check('截圖預設不寫檔（回傳 null）', shot === null, String(shot));
        check('磁碟上真的沒有截圖檔', !fs.existsSync(path.join(dir, 'should-not-exist.png')));
    } catch (err) {
        failed += 1;
        failures.push(`執行錯誤：${err.message}`);
        console.error('\n✖ 檢查中斷：', err.message);
        exitCode = 1;
    } finally {
        await browser.close();
        try { server.close(); } catch (err) { /* 已關閉 */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* 忽略 */ }
    }

    console.log(`\n===== 瀏覽器驗收：${passed} 通過 / ${failed} 失敗 =====`);
    if (failures.length) {
        console.log('失敗項目：');
        for (const item of failures) console.log(` - ${item}`);
    }
    if (failed || exitCode) process.exit(1);
}

main();
