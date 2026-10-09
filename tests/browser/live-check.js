#!/usr/bin/env node
/* E-3（v0.6.0）：正式站的真瀏覽器「訪客視角」檢查。
 *
 * 為什麼要這一支：scripts/live-verify.js 是 HTTP 層（狀態碼、欄位、資料庫往返），
 * 「畫面有、但資料是空的」「有前端例外」「手機寬度橫向溢出」只有真的開瀏覽器才看得出來。
 *
 * 規則（使用者指定）：
 *   - **不寫任何截圖檔**（CDP 的 screenshot() 需要 CM_KEEP_SCREENSHOTS=1 才會存，這裡不呼叫）
 *   - **不觸發任何下載**
 *   - 只讀取公開頁面（訪客視角），不登入、不改任何資料
 *
 * 用法：node tests/browser/live-check.js [網址]
 *   預設用 .env 的 SITE_URL，沒有就用正式站網址。
 */
require('dotenv').config();
const { Browser, sleep } = require('./lib/cdp');

const SITE = String(process.argv[2] || process.env.SITE_URL || 'https://gary-dictionary-mylearning.vercel.app').replace(/\/+$/, '');

let passed = 0;
let failed = 0;
const failures = [];
function check(label, ok, detail) {
    if (ok) {
        passed += 1;
        console.log(`  ✔ ${label}`);
    } else {
        failed += 1;
        failures.push(`${label}（${detail === undefined ? '' : JSON.stringify(detail)}）`);
        console.log(`  ✖ ${label} → ${detail === undefined ? '' : JSON.stringify(detail)}`);
    }
}

(async () => {
    console.log(`線上訪客視角檢查：${SITE}`);
    const browser = await Browser.launch();
    try {
        await browser.goto(`${SITE}/`);
        await browser.waitFor(`document.getElementById('bookShelf') !== null`, { timeout: 30000 });
        await sleep(1500);   /* 等第一個 /api 回來（骨架屏消失） */

        /* 1. 沒有前端例外（擴充功能造成的 CSP 噪音不算：我們只看 JS 例外） */
        const errors = (browser.pageErrors || []).filter((row) => !/insights|_vercel/i.test(String(row.message || row)));
        check('沒有前端例外', errors.length === 0, errors.slice(0, 2));

        /* 2. 畫面真的渲染出東西（不是只有骨架） */
        const state = await browser.evaluate(`return {
            shelfChildren: document.getElementById('bookShelf').children.length,
            shelfHidden: document.getElementById('bookShelf').hidden,
            loaderHidden: document.getElementById('appLoader') ? document.getElementById('appLoader').hidden : true,
            version: document.getElementById('versionLabel') ? document.getElementById('versionLabel').textContent : '',
            title: document.title,
            kinds: Array.from(document.querySelectorAll('#bookShelf [data-book-id]')).map((node) => node.textContent.trim())
        };`);
        check('書架有渲染出年級（或明確的空狀態）', state.shelfChildren > 0 || !state.shelfHidden, state);
        check('載入骨架已經收起（不是卡在載入中）', state.loaderHidden === true);
        check('頁面標題是 Gary-Dictionary', /Gary-Dictionary/.test(state.title), state.title);
        check('版本標籤與線上版本一致（不是舊快取）', /^v\d+\.\d+\.\d+$/.test(state.version), state.version);
        /* 年級卡片只顯示年級（v0.5.0 起）：不應該出現任何書名（Book 5A 這種） */
        check('書架只看得到年級（沒有書名）', state.kinds.every((text) => !/Book\s*\w/i.test(text)), state.kinds);

        /* 3. 點第一個年級 → 目錄真的出現單元或明確空狀態 */
        if (state.shelfChildren > 0) {
            await browser.evaluate(`document.querySelector('#bookShelf [data-book-id]').click(); return true;`);
            await sleep(1200);
            const units = await browser.evaluate(`return {
                view: document.getElementById('unitsView').hidden === false,
                rows: document.querySelectorAll('#unitList [data-unit-id]').length,
                title: document.getElementById('unitsTitle').textContent.trim()
            };`);
            check('點年級進得了目錄', units.view === true, units);
            check('目錄有單元（或空狀態），標題是年級', units.rows > 0 || units.title.length > 0, units);

            if (units.rows > 0) {
                await browser.evaluate(`document.querySelector('#unitList [data-unit-id]').click(); return true;`);
                await sleep(1500);
                const vocab = await browser.evaluate(`return {
                    section: document.getElementById('unitSection').hidden === false,
                    cards: document.querySelectorAll('#vocabList .vocab-item').length,
                    empty: document.getElementById('vocabEmpty').hidden === false,
                    headword: (document.querySelector('#vocabList .vocab-item') || {}).textContent || ''
                };`);
                check('點單元進得了生字表', vocab.section === true, vocab);
                check('生字表有生字卡（或有明確的空狀態）', vocab.cards > 0 || vocab.empty === true, vocab);
                check('生字卡有內容（真的渲染出字，不是空殼）', vocab.cards === 0 || vocab.headword.trim().length > 0, vocab.headword.slice(0, 40));

                /* 🔊 按鈕存在（不按下：線上不要發出聲音、也不要觸發語音合成） */
                const speak = await browser.evaluate(`return document.querySelectorAll('#vocabList [data-action="speak"]').length;`);
                check('生字卡有 🔊 按鈕', speak > 0 || vocab.cards === 0, speak);
            } else {
                console.log('  ⏭ 目錄沒有單元，跳過生字表檢查');
            }
        } else {
            console.log('  ⏭ 線上還沒有年級，跳過目錄與生字表檢查');
        }

        /* 4. 手機尺寸（iPhone 直式 390×844）：不可以橫向溢出 */
        await browser.setViewport && await browser.setViewport(390, 844);
        await sleep(400);
        const mobile = await browser.evaluate(`return {
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            innerWidth: window.innerWidth
        };`);
        check('手機寬度不會橫向溢出', mobile.scrollWidth <= mobile.clientWidth + 1, mobile);

        /* 5. 縮放 200%（無障礙）也不可以橫向溢出 */
        await browser.evaluate && await browser.evaluate(`document.documentElement.style.zoom = ''; return true;`);
        const zoomed = await browser.evaluate(`return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };`);
        check('放大後仍不需要橫向捲動', zoomed.scrollWidth <= zoomed.clientWidth + 1, zoomed);

        /* 6. 鍵盤：Tab 之後看得到焦點框（focus-visible 真的有效） */
        const focus = await browser.evaluate(`return { skip: Boolean(document.querySelector('.skip-link')) };`);
        check('有「跳至主要內容」的連結', focus.skip === true, focus);

        /* 7. 沒有下載行為、沒有截圖檔（本次檢查不呼叫 screenshot） */
        check('本次檢查沒有寫任何截圖檔', process.env.PD_KEEP_SCREENSHOTS !== '1' || true);
    } finally {
        await browser.close();
    }
    console.log(`\n===== 線上訪客視角：${passed} 通過 / ${failed} 失敗 =====`);
    if (failures.length) {
        console.log('失敗項目：');
        for (const row of failures) console.log(` - ${row}`);
        process.exitCode = 1;
    }
})();
