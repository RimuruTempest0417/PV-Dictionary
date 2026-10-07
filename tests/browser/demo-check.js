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
    const book = store.createBook({ code: 'B5A', name: 'Book 5A', sort_order: 1, is_published: true });
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
        check('書架顯示 Book 5A（含單元數與生字數）', shelf.some((t) => t.includes('Book 5A')), shelf.join('/'));
        const coverCards = await browser.evaluate(`return document.querySelectorAll('#bookShelf [data-book-id]').length;`);
        check('每個書本都是一個可點的封面卡片', coverCards >= 1, String(coverCards));
        const shelfFirst = await browser.evaluate(`return document.getElementById('shelfView').hidden === false;`);
        check('首頁是書架而不是生字表', shelfFirst === true);

        await browser.evaluate(`document.querySelector('#bookShelf [data-book-id]').click(); return true;`);
        await browser.waitFor(`document.getElementById('unitsView').hidden === false`);
        const chips = await browser.evaluate(`return Array.from(document.getElementById('unitList').children).map(b => b.textContent);`);
        check('目錄列出單元與生字數', chips.some((t) => t.includes('Unit 1')) && chips.some((t) => t.includes('words')), chips.join('/'));
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

        console.log('\n【5-7】管理員：新增生字 → 批次貼上 → 刪除（管理區在編輯後已收起）');
        await browser.evaluate(`document.getElementById('adminToggleBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('adminSection').hidden === false`);
        await browser.evaluate(`document.getElementById('newEntryBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('entryForm').hidden === false`);
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

        console.log('\n【9-10】批次與書本／單元維護');
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
            document.getElementById('fBookCode').value = 'B5B';
            document.getElementById('fBookName').value = 'Book 5B';
            document.forms.bookForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`document.getElementById('unitsView').hidden === false && document.getElementById('unitsTitle').textContent.includes('Book 5B')`, { timeout: 6000 });
        check('新增書本後直接進入它的目錄（接著就能新增單元）', true);
        check('書架上也出現新書本', (await browser.evaluate(`return document.getElementById('bookShelf').textContent.includes('Book 5B');`)) === true);

        console.log('\n【10b】書本封面：上傳照片 → 書架（首頁）用封面顯示');
        await browser.evaluate(`document.getElementById('navCoverBtn').click(); return true;`);
        await browser.waitFor(`getComputedStyle(document.getElementById('coverPanel')).display !== 'none'`);
        const coverBefore = await browser.evaluate(`return {
            none: document.getElementById('coverNone').hidden === false,
            imgHidden: document.getElementById('coverPreview').hidden === true,
            books: Array.from(document.getElementById('coverBook').options).map((o) => o.textContent)
        };`);
        check('封面面板列出所有書本，預設顯示「還沒有封面」',
            coverBefore.none === true && coverBefore.imgHidden === true && coverBefore.books.some((t) => t.includes('Book 5A')),
            JSON.stringify(coverBefore));

        await browser.evaluate(`
            const select = document.getElementById('coverBook');
            select.value = String((window.PDState.books.find((b) => b.name === 'Book 5A') || {}).id);
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        `);
        /* 真的用它自己的檔案路徑走一次（選檔 → FileReader → 上傳 API），不繞過 UI */
        const pngFile = path.join(dir, 'cover-sample.png');
        fs.writeFileSync(pngFile, Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'));
        const coverDoc = await browser.send('DOM.getDocument', { depth: -1 });
        const coverNode = await browser.send('DOM.querySelector', { nodeId: coverDoc.root.nodeId, selector: '#coverFileInput' });
        await browser.send('DOM.setFileInputFiles', { nodeId: coverNode.nodeId, files: [pngFile] });
        let coverSaved = false;
        try {
            await browser.waitFor(`document.getElementById('coverMsg').textContent.includes('Cover updated')`, { timeout: 2500 });
            coverSaved = true;
        } catch (err) {
            coverSaved = false;
        }
        if (!coverSaved) {
            await browser.evaluate(`document.getElementById('coverFileInput').dispatchEvent(new Event('change', { bubbles: true })); return true;`);
        }
        await browser.waitFor(`document.getElementById('coverMsg').textContent.includes('Cover updated')`, { timeout: 8000 });
        check('上傳封面成功', true);
        check('面板立刻顯示封面預覽',
            (await browser.evaluate(`return document.getElementById('coverPreview').hidden === false;`)) === true);

        const shelfCover = await browser.evaluate(`return Array.from(document.querySelectorAll('#bookShelf .shelf-cover-img')).map((img) => img.getAttribute('src'));`);
        check('書架卡片改用封面圖片（學生首頁看得到）',
            shelfCover.length >= 1 && shelfCover[0].includes('/api/covers/'), JSON.stringify(shelfCover));
        const coverFetch = await browser.evaluate(`return (async () => {
            const res = await fetch(${JSON.stringify(shelfCover[0] || '/api/covers/0')}, { cache: 'no-store' });
            const buf = await res.arrayBuffer();
            return { status: res.status, type: res.headers.get('content-type'), bytes: buf.byteLength };
        })();`);
        check('封面由自家同源端點提供（不開外部網域）',
            coverFetch.status === 200 && coverFetch.type === 'image/png' && coverFetch.bytes > 50, JSON.stringify(coverFetch));
        const coverAudit = await browser.evaluate(`return document.getElementById('coverBook').value;`);
        check('封面面板的書本選單仍可切換', Boolean(coverAudit), coverAudit);

        console.log('\n【11-12】科代表新增 → 老師核准');
        await browser.evaluate(`document.getElementById('logoutBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('loginBtn') !== null`, { timeout: 6000 });
        await browser.evaluate(STUBS);
        await openLogin(browser);
        await typeLogin(browser, 'classrep');
        /* 等書架真的有 Book 5A 再點（登入後書架是非同步重畫的） */
        await browser.waitFor(`Array.from(document.querySelectorAll('#bookShelf [data-book-id]')).some(b => b.textContent.includes('Book 5A'))`, { timeout: 8000 });
        await browser.evaluate(`
            Array.from(document.querySelectorAll('#bookShelf [data-book-id]'))
                .find(b => b.textContent.includes('Book 5A')).click();
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
        await browser.evaluate(`
            document.getElementById('adminToggleBtn').click();
            document.getElementById('newEntryBtn').click();
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
        check('訪客看不到審核狀態標記', visitorSees.badges.length === 0, JSON.stringify(visitorSees.badges));

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

        const consoleErrors = browser.consoleErrors.filter((line) => !/favicon|Failed to load resource/.test(line));
        const pageErrors = browser.pageErrors;
        check('沒有前端例外', pageErrors.length === 0, pageErrors.join(' | '));
        check('沒有主控台錯誤', consoleErrors.length === 0, consoleErrors.join(' | '));

        await browser.evaluate(STUBS);
        await openLogin(browser);
        await typeLogin(browser, 'manager');
        await browser.evaluate(`
            document.getElementById('adminToggleBtn').click();
            return true;
        `);
        /* 稽核紀錄現在是管理選單裡的一個分頁：要按「🧾」才會載入 */
        await browser.evaluate(`document.getElementById('navAuditBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('auditList').children.length > 0`, { timeout: 6000 });
        const audit = await browser.evaluate(`return document.getElementById('auditList').textContent;`);
        check('稽核紀錄看得到剛才的操作（英文動作標籤）', /Approve word|Add word|Import words/.test(audit), audit.slice(0, 120));

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
