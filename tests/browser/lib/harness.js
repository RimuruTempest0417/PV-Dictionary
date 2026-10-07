/* 瀏覽器檢查的共用工具
 * - STUBS：把語音合成、Audio、原生對話框、下載守衛換成記錄器（判定一律來自記錄到的呼叫）
 * - loginViaUi()：真的在登入視窗填帳密、送出，並等畫面變成該角色
 * - visibleIds()：用「算出來的樣式」判斷哪些元素真的在畫面上（不是只看 hidden 屬性）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../../../server');
const { hashPassword } = require('../../../lib/passwords');

const PASSWORD = 'pass1234';

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

/* 建立一個獨立的 app：每個檢查自己的暫存資料檔，絕不動 data/store.json */
function startApp(options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix || 'pv-browser-'));
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'browser-check-secret';
    const app = createApp({ backend: 'json', dataFile: path.join(dir, 'store.json') });
    const store = app.locals.store;
    if (options.users !== false) {
        for (const [username, role, display] of [
            ['manager', 'admin', '網頁管理員'],
            ['webmanager', 'web_manager', '網站管理員'],
            ['teacher', 'teacher', '英文老師'],
            ['classrep', 'class_rep', '英文科代表'],
            ['student', 'student', '學生']
        ]) {
            store.createUser({
                username, role, display_name: display,
                password_hash: hashPassword(PASSWORD), is_active: true
            });
        }
    }
    const server = app.listen(0);
    return {
        dir,
        store,
        server,
        base: `http://127.0.0.1:${server.address().port}`,
        cleanup() {
            try { server.close(); } catch (err) { /* 已關閉 */ }
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* 忽略 */ }
        }
    };
}

async function openLoginModal(browser) {
    await browser.evaluate(`document.getElementById('loginBtn').click(); return true;`);
    await browser.waitFor(`getComputedStyle(document.getElementById('loginModal')).display !== 'none'`);
}

/* 真的在畫面上填帳密並送出，然後等「登出」按鈕出現（語言無關的登入完成訊號） */
async function loginViaUi(browser, { username, password = PASSWORD, expectText }) {
    await openLoginModal(browser);
    await browser.evaluate(`
        document.getElementById('loginUsername').value = ${JSON.stringify(username)};
        document.getElementById('loginPassword').value = ${JSON.stringify(password)};
        document.forms.loginForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return true;
    `);
    await browser.waitFor(`document.getElementById('logoutBtn') !== null`, { timeout: 8000 });
    if (expectText) {
        await browser.waitFor(`document.getElementById('authArea').textContent.includes(${JSON.stringify(expectText)})`, { timeout: 8000 });
    }
    return true;
}

async function logoutViaUi(browser) {
    await browser.evaluate(`document.getElementById('logoutBtn').click(); return true;`);
    await browser.waitFor(`document.getElementById('loginBtn') !== null`, { timeout: 8000 });
}

/* 回傳「真的在畫面上」的元素 id（用算出來的 display／visibility／高度判斷） */
function visibleIds(browser, ids) {
    return browser.evaluate(`
        return ${JSON.stringify(ids)}.filter((id) => {
            const node = document.getElementById(id);
            if (!node) return false;
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            return node.getBoundingClientRect().height > 0;
        });
    `);
}

module.exports = {
    PASSWORD,
    STUBS,
    startApp,
    openLoginModal,
    loginViaUi,
    logoutViaUi,
    visibleIds
};
