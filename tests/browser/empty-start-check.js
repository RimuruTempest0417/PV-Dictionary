/* 「第一次使用（資料全空）」的真實瀏覽器驗收
 *
 * 這一支是為了重現並守住使用者實測遇到的兩個問題：
 *   1. 開站時登入／錄音視窗自己跑出來蓋住頁面，「關閉」也關不掉
 *      （原因：.modal{display:flex} 蓋掉了瀏覽器對 [hidden] 的 display:none）
 *   2. 一開始看到的不是學生視角（而是管理表單），而且資料全空時根本進不去管理區塊
 *
 * 判定一律用「算出來的樣式」（getComputedStyle），不是只看 hidden 屬性——
 * 屬性對、畫面還是看得見，就是這次的 bug。檔案與下載規則同 demo-check.js。
 */
const fs = require('node:fs');
const path = require('node:path');

const { Browser, sleep } = require('./lib/cdp');
const { STUBS, startApp, loginViaUi, logoutViaUi, visibleIds } = require('./lib/harness');

const OVERLAY_IDS = ['loginModal', 'audioModal', 'adminSection', 'pendingBlock', 'auditBlock',
    'entryForm', 'importForm', 'unitForm', 'bookForm', 'coverPanel', 'usersBlock', 'grantsBlock'];
/* 開站時「不該出現」的其他畫面（書架以外的兩層）。登出後留在生字表是正常的，所以只在開站檢查。 */
const VIEW_IDS = ['unitsView', 'unitSection'];

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
    const app = startApp({ prefix: 'pv-empty-' });
    const browser = await Browser.launch({ width: 1280, height: 950 });
    let exitCode = 0;
    try {
        await browser.goto(`${app.base}/`);
        await browser.evaluate(STUBS);
        await browser.waitFor(`document.getElementById('emptyState').hidden === false
            || document.getElementById('bookShelf').children.length > 0`);

        console.log('\n【1】開站（未登入、資料全空）：學生視角');
        const overlaysAtLoad = await visibleIds(browser, OVERLAY_IDS.concat(VIEW_IDS));
        check('開站時沒有任何彈窗或管理面板蓋在畫面上', overlaysAtLoad.length === 0, overlaysAtLoad.join('、'));
        check('開站停在書架（首頁），目錄與生字表都還沒出現',
            (await browser.evaluate(`return document.getElementById('shelfView').hidden === false
                && document.getElementById('unitsView').hidden === true
                && document.getElementById('unitSection').hidden === true;`)) === true);
        const emptyText = await browser.evaluate(`return document.getElementById('emptyState').textContent;`);
        check('顯示「還沒有可以查的生字」的起始畫面', emptyText.includes('No words to look up yet'), emptyText.slice(0, 40));
        check('起始畫面告訴老師建立順序（書本→單元→生字）',
            emptyText.includes('New book') && emptyText.includes('New unit') && emptyText.includes('New word'));
        check('未登入看不到「✏️ 管理」按鈕',
            (await browser.evaluate(`return document.getElementById('adminToggleBtn') === null;`)) === true);
        check('未登入看得到「登入」按鈕',
            (await browser.evaluate(`return document.getElementById('loginBtn') !== null;`)) === true);
        const overflow = await browser.evaluate(`return document.documentElement.scrollWidth - window.innerWidth;`);
        check('畫面沒有橫向溢出', overflow <= 1, `溢出 ${overflow}px`);

        console.log('\n【2】登入視窗可以開也可以關（使用者：關不掉）');
        await loginViaUi(browser, { username: 'manager', expectText: 'Web administrator' });
        check('登入成功，標題列顯示角色', true);
        let shown = await visibleIds(browser, ['loginModal']);
        check('登入完成後登入視窗真的消失（算出來的 display 是 none）', shown.length === 0, shown.join('、'));

        // 再開一次登入視窗、這次按「取消」關掉（使用者回報「關不掉」的就是這個情境）
        await browser.evaluate(`document.getElementById('loginModal').hidden = false; return true;`);
        await browser.waitFor(`getComputedStyle(document.getElementById('loginModal')).display !== 'none'`);
        check('再次開啟登入視窗時它真的出現', true);
        await browser.evaluate(`document.getElementById('loginCancelBtn').click(); return true;`);
        await sleep(150);
        shown = await visibleIds(browser, ['loginModal']);
        check('按「取消」後登入視窗真的關掉', shown.length === 0, shown.join('、'));

        console.log('\n【3】資料全空時，管理員建立第一本書與第一個單元');
        await browser.evaluate(`document.getElementById('adminToggleBtn').click(); return true;`);
        await browser.waitFor(`getComputedStyle(document.getElementById('adminSection')).display !== 'none'`);
        check('按「✏️ 管理」後管理區塊真的出現', true);
        const hint = await browser.evaluate(`return document.getElementById('adminHint').textContent;`);
        check('管理區塊說明「還沒有任何書本」', hint.includes('no books yet'), hint);
        const state0 = await browser.evaluate(`return {
            unit: document.getElementById('newUnitBtn').disabled,
            entry: document.getElementById('newEntryBtn').disabled,
            book: document.getElementById('newBookBtn').disabled
        };`);
        check('沒有書本時「新增單元」與「新增生字」是停用的（而不是按了才報錯）',
            state0.unit === true && state0.entry === true && state0.book === false, JSON.stringify(state0));

        await browser.evaluate(`document.getElementById('newBookBtn').click(); return true;`);
        await browser.waitFor(`getComputedStyle(document.getElementById('bookForm')).display !== 'none'`);
        await browser.evaluate(`
            document.getElementById('fBookCode').value = 'B5A';
            document.getElementById('fBookName').value = 'Book 5A';
            document.getElementById('fBookGrade').value = 'S1';
            document.forms.bookForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`document.getElementById('unitsTitle').textContent.includes('Book 5A')`, { timeout: 8000 });
        check('新增書本後直接進到它的目錄', true);
        const hint2 = await browser.evaluate(`return document.getElementById('adminHint').textContent;`);
        check('說明改成「這本書還沒有單元」', hint2.includes('has no units yet'), hint2);

        await browser.evaluate(`document.getElementById('newUnitBtn').click(); return true;`);
        await browser.waitFor(`getComputedStyle(document.getElementById('unitForm')).display !== 'none'`);
        await browser.evaluate(`
            document.getElementById('fUnitNo').value = '1';
            document.getElementById('fUnitTitle').value = 'My New School';
            document.forms.unitForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`document.getElementById('unitTitle').textContent.includes('My New School')`, { timeout: 8000 });
        check('新增單元後直接進到該單元的生字表', true);
        check('有單元後「新增生字」變成可用',
            (await browser.evaluate(`return document.getElementById('newEntryBtn').disabled;`)) === false);
        check('管理提示消失',
            (await browser.evaluate(`return document.getElementById('adminHint').hidden;`)) === true);

        console.log('\n【5】新增生字（單筆與批次貼上）');
        await browser.evaluate(`document.getElementById('newEntryBtn').click(); return true;`);
        await browser.waitFor(`getComputedStyle(document.getElementById('entryForm')).display !== 'none'`);
        await browser.evaluate(`
            document.getElementById('fHeadword').value = 'atmosphere';
            document.getElementById('fPos').value = 'n.';
            document.getElementById('fIpaUs').value = '/\\u02c8\\u00e6t.m\\u0259.sf\\u026a\\u0259r/';
            document.getElementById('fZh').value = '氣氛；大氣';
            document.getElementById('fEn').value = 'the feeling of a place';
            document.forms.entryForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`Array.from(document.querySelectorAll('.headword')).some(n => n.textContent === 'atmosphere')`, { timeout: 8000 });
        check('單筆新增生字後清單立即出現', true);

        await browser.evaluate(`document.getElementById('importToggleBtn').click(); return true;`);
        await browser.waitFor(`getComputedStyle(document.getElementById('importForm')).display !== 'none'`);
        await browser.evaluate(`
            document.getElementById('importText').value = [
                'librarian\\t/la\\u026a\\u02c8bre\\u0259.ri.\\u0259n/\\tn.\\t圖書館員\\ta person who works in a library',
                'timetable\\t/\\u02c8ta\\u026am\\u02ccte\\u026a.b\\u0259l/\\tn.\\t時間表\\ta list of class times'
            ].join('\\n');
            document.forms.importForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
        `);
        await browser.waitFor(`document.querySelectorAll('.vocab-item').length === 3`, { timeout: 8000 });
        check('批次貼上後共 3 個生字', true);

        console.log('\n【6】錄音視窗可以開也可以關（使用者：關不掉）');
        await browser.evaluate(`
            document.querySelector('.vocab-item [data-action="upload-audio"]').click();
            return true;
        `);
        await browser.waitFor(`getComputedStyle(document.getElementById('audioModal')).display !== 'none'`);
        const audioTitle = await browser.evaluate(`return document.getElementById('audioModalHeadword').textContent;`);
        check('錄音視窗開啟時真的出現，並顯示要錄的生字', audioTitle.length > 0, audioTitle);
        await browser.evaluate(`document.getElementById('audioCancelBtn').click(); return true;`);
        await sleep(150);
        shown = await visibleIds(browser, ['audioModal']);
        check('按「關閉」後錄音視窗真的關掉', shown.length === 0, shown.join('、'));

        console.log('\n【7】學生視角（登出後）與收尾');
        await browser.evaluate(`document.getElementById('adminToggleBtn').click(); return true;`);   // 收起管理
        await logoutViaUi(browser);
        await browser.waitFor(`document.querySelectorAll('.vocab-item').length === 3`, { timeout: 8000 });
        check('登出後（學生）仍可看到 3 個生字', true);
        const overlaysAfter = await visibleIds(browser, OVERLAY_IDS);
        check('登出後畫面上沒有殘留的彈窗或管理面板', overlaysAfter.length === 0, overlaysAfter.join('、'));
        check('登出後看不到「✏️ 管理」按鈕',
            (await browser.evaluate(`return document.getElementById('adminToggleBtn') === null;`)) === true);

        const cspViolations = await browser.evaluate(`return window.__cspViolations || [];`);
        check('沒有任何 CSP 違規', cspViolations.length === 0, JSON.stringify(cspViolations));
        check('沒有前端例外', browser.pageErrors.length === 0, browser.pageErrors.join(' | '));

        await browser.setViewport(402, 874, true);
        await sleep(300);
        const mobileOverflow = await browser.evaluate(`return document.documentElement.scrollWidth - window.innerWidth;`);
        check('手機版（402px）沒有橫向溢出', mobileOverflow <= 1, `溢出 ${mobileOverflow}px`);
        await browser.setViewport(1280, 950, false);

        const downloads = await browser.evaluate(`return window.__downloads || [];`);
        check('沒有觸發任何下載', downloads.length === 0, JSON.stringify(downloads));
        const shot = await browser.screenshot(path.join(app.dir, 'should-not-exist.png'));
        check('截圖預設不寫檔', shot === null && !fs.existsSync(path.join(app.dir, 'should-not-exist.png')));
    } catch (err) {
        failed += 1;
        failures.push(`執行錯誤：${err.message}`);
        console.error('\n✖ 檢查中斷：', err.message);
        exitCode = 1;
    } finally {
        await browser.close();
        app.cleanup();
    }

    console.log(`\n===== 空白起步驗收：${passed} 通過 / ${failed} 失敗 =====`);
    if (failures.length) {
        console.log('失敗項目：');
        for (const item of failures) console.log(` - ${item}`);
    }
    if (failed || exitCode) process.exit(1);
}

main();
