/* 語言切換的真實瀏覽器驗收
 *
 * 要守住的行為：
 *   1. 第一次開站是**英文**（使用者指定），連 <html lang> 都對
 *   2. 按「中文」→ 整個介面（靜態文字、動態產生的清單與按鈕、角色標籤、後端錯誤訊息）都變中文
 *   3. 重新載入後記得選擇（localStorage），英文同理
 *   4. 換語言不會把畫面弄壞（彈窗、清單還在，沒有 CSP 違規與前端例外）
 */
const fs = require('node:fs');
const path = require('node:path');

const { Browser, sleep } = require('./lib/cdp');
const { STUBS, startApp, loginViaUi, visibleIds } = require('./lib/harness');

const OVERLAY_IDS = ['loginModal', 'audioModal', 'adminSection'];

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

async function main() {
    const app = startApp({ prefix: 'pv-lang-' });
    const store = app.store;
    const book = store.createBook({ code: 'B5A', name: 'Book 5A', sort_order: 1, is_published: true });
    const unit = store.createUnit({ book_id: book.id, unit_no: 1, title: 'My New School', sort_order: 1, is_published: true });
    const entry = store.createEntry({
        unit_id: unit.id, headword: 'campus', headword_norm: 'campus', ipa_us: '/ˈkæm.pəs/',
        part_of_speech: 'n.', zh_meaning: '校園', en_definition: 'the land and buildings of a school',
        status: 'pending', sort_order: 1, created_by: 'classrep'
    });

    const browser = await Browser.launch({ width: 1280, height: 950 });
    let exitCode = 0;
    try {
        await browser.goto(`${app.base}/`);
        await browser.evaluate(STUBS);
        await browser.waitFor(`document.getElementById('bookTabs').children.length > 0`);

        console.log('\n【1】第一次開站：英文');
        const initial = await browser.evaluate(`return {
            lang: document.documentElement.lang,
            stored: window.localStorage.getItem('pd-lang'),
            subtitle: document.getElementById('appSubtitle').textContent,
            searchPlaceholder: document.getElementById('searchInput').placeholder,
            loginBtn: document.getElementById('loginBtn').textContent,
            bookLabel: document.querySelector('.picker-label').textContent,
            printBtn: document.getElementById('printBtn').textContent,
            emptyMsg: document.getElementById('vocabEmpty').textContent,
            footerNote: document.querySelector('.footer .footer-muted:last-child').textContent
        };`);
        check('<html lang> 是 en', initial.lang === 'en', initial.lang);
        check('標題副標是英文', initial.subtitle.includes('English'), initial.subtitle);
        check('搜尋框提示文字是英文', initial.searchPlaceholder.includes('Search'), initial.searchPlaceholder);
        check('按鈕是英文（Sign in / Book / Print）',
            initial.loginBtn.includes('Sign in') && initial.bookLabel === 'Book' && initial.printBtn.includes('Print'),
            JSON.stringify([initial.loginBtn, initial.bookLabel, initial.printBtn]));
        check('單元空訊息是英文', initial.emptyMsg.includes('No vocabulary'), initial.emptyMsg);
        check('頁腳說明是英文', initial.footerNote.includes('Pronunciations'), initial.footerNote);
        check('還沒有選擇語言時不寫 localStorage（預設就是英文）', initial.stored === null || initial.stored === 'en', String(initial.stored));

        console.log('\n【2】按「中文」：整個介面切換');
        await browser.evaluate(`document.querySelector('#langSwitch [data-lang="zh"]').click(); return true;`);
        await sleep(300);
        const zhState = await browser.evaluate(`return {
            lang: document.documentElement.lang,
            stored: window.localStorage.getItem('pd-lang'),
            pressed: document.querySelector('#langSwitch [data-lang="zh"]').getAttribute('aria-pressed'),
            subtitle: document.getElementById('appSubtitle').textContent,
            loginBtn: document.getElementById('loginBtn').textContent,
            bookLabel: document.querySelector('.picker-label').textContent,
            printBtn: document.getElementById('printBtn').textContent,
            emptyMsg: document.getElementById('vocabEmpty').textContent,
            unitMeta: document.getElementById('unitMeta').textContent
        };`);
        check('<html lang> 變成 zh-Hant', zhState.lang === 'zh-Hant', zhState.lang);
        check('語言選擇寫進 localStorage', zhState.stored === 'zh', String(zhState.stored));
        check('中文按鈕標記為已選取', zhState.pressed === 'true');
        check('靜態文字切成中文', zhState.subtitle.includes('英文生字字典') && zhState.bookLabel === '書本'
            && zhState.printBtn.includes('列印'), JSON.stringify([zhState.subtitle, zhState.bookLabel, zhState.printBtn]));
        check('動態文字（單元生字數、空訊息）切成中文',
            zhState.unitMeta.includes('個生字') && zhState.emptyMsg.includes('還沒有生字'), JSON.stringify([zhState.unitMeta, zhState.emptyMsg]));

        console.log('\n【3】中文介面下的動態內容（登入狀態）');
        await loginViaUi(browser, { username: 'classrep', expectText: '科代表' });
        const zhAuth = await browser.evaluate(`return {
            area: document.getElementById('authArea').textContent,
            logout: document.getElementById('logoutBtn').textContent,
            manage: document.getElementById('adminToggleBtn') ? document.getElementById('adminToggleBtn').textContent : null
        };`);
        check('角色標籤是中文', zhAuth.area.includes('科代表'), zhAuth.area);
        check('登出／管理按鈕是中文', zhAuth.logout === '登出' && (zhAuth.manage || '').includes('管理'), JSON.stringify(zhAuth));

        console.log('\n【4】重新載入後記得選擇');
        await browser.goto(`${app.base}/`);
        await browser.waitFor(`document.getElementById('bookTabs').children.length > 0`);
        const afterReload = await browser.evaluate(`return {
            lang: document.documentElement.lang,
            subtitle: document.getElementById('appSubtitle').textContent,
            stored: window.localStorage.getItem('pd-lang')
        };`);
        check('重新載入後仍是中文', afterReload.lang === 'zh-Hant' && afterReload.subtitle.includes('英文生字字典'), JSON.stringify(afterReload));

        console.log('\n【5】切回英文並確認後端錯誤訊息跟著語言走');
        await browser.evaluate(STUBS);
        await browser.evaluate(`document.querySelector('#langSwitch [data-lang="en"]').click(); return true;`);
        await sleep(300);
        const backToEn = await browser.evaluate(`return {
            lang: document.documentElement.lang,
            stored: window.localStorage.getItem('pd-lang'),
            subtitle: document.getElementById('appSubtitle').textContent
        };`);
        check('切回英文並記住', backToEn.lang === 'en' && backToEn.stored === 'en' && backToEn.subtitle.includes('English'), JSON.stringify(backToEn));

        // 先登出：未登入才能得到 401（同一個錯誤在兩種語言下都測）
        await browser.evaluate(`document.getElementById('logoutBtn').click(); return true;`);
        await browser.waitFor(`document.getElementById('loginBtn') !== null`, { timeout: 8000 });

        const errEn = await browser.evaluate(`
            return (async () => {
                try {
                    await window.PDApi.post('/api/units/${unit.id}/entries', { headword: 'x', zh_meaning: 'y' });
                    return 'NO_ERROR';
                } catch (err) {
                    return window.PDI18n.errorMessage(err);
                }
            })();
        `);
        check('英文模式下錯誤訊息是英文', errEn === 'Please sign in first', errEn);
        await browser.evaluate(`document.querySelector('#langSwitch [data-lang="zh"]').click(); return true;`);
        await sleep(200);
        const errZh = await browser.evaluate(`
            return (async () => {
                try {
                    await window.PDApi.post('/api/units/${unit.id}/entries', { headword: 'x', zh_meaning: 'y' });
                    return 'NO_ERROR';
                } catch (err) {
                    return window.PDI18n.errorMessage(err);
                }
            })();
        `);
        check('中文模式下同一個錯誤變中文（後端只回 code）', errZh === '請先登入', errZh);

        console.log('\n【6】切換語言不會弄壞畫面');
        await browser.evaluate(`document.querySelector('#langSwitch [data-lang="en"]').click(); return true;`);
        await sleep(250);
        const overlays = await visibleIds(browser, OVERLAY_IDS);
        check('切換後沒有莫名的彈窗或面板跑出來', overlays.length === 0, overlays.join('、'));
        const vocabCount = await browser.evaluate(`return document.querySelectorAll('.vocab-item').length;`);
        check('生字清單沒有消失（未登入只看得到已發佈，所以是 0 筆）', vocabCount === 0, String(vocabCount));
        const csp = await browser.evaluate(`return window.__cspViolations || [];`);
        check('沒有 CSP 違規', csp.length === 0, JSON.stringify(csp));
        check('沒有前端例外', browser.pageErrors.length === 0, browser.pageErrors.join(' | '));

        await browser.setViewport(402, 874, true);
        await sleep(300);
        const overflow = await browser.evaluate(`return document.documentElement.scrollWidth - window.innerWidth;`);
        check('手機版（402px）切換語言後也沒有橫向溢出', overflow <= 1, `溢出 ${overflow}px`);
        await browser.setViewport(1280, 950, false);

        const shot = await browser.screenshot(path.join(app.dir, 'should-not-exist.png'));
        check('截圖預設不寫檔', shot === null && !fs.existsSync(path.join(app.dir, 'should-not-exist.png')));
        check('檢查過程沒有觸發任何下載',
            (await browser.evaluate(`return (window.__downloads || []).length;`)) === 0);
    } catch (err) {
        failed += 1;
        failures.push(`執行錯誤：${err.message}`);
        console.error('\n✖ 檢查中斷：', err.message);
        exitCode = 1;
    } finally {
        await browser.close();
        app.cleanup();
    }

    console.log(`\n===== 語言切換驗收：${passed} 通過 / ${failed} 失敗 =====`);
    if (failures.length) {
        console.log('失敗項目：');
        for (const item of failures) console.log(` - ${item}`);
    }
    if (failed || exitCode) process.exit(1);
}

main();
