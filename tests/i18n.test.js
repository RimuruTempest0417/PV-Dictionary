/* 介面語言的守門測試
 *
 * 這些問題都不會有任何錯誤訊息，只會在某個語言下「少一句話」或「顯示成 {word}」：
 *   1. 兩種語言的鍵不一致（翻譯漏了 → 那個語言會顯示英文）
 *   2. 程式用了不存在的鍵（畫面上直接出現 key 本身）
 *   3. 兩邊的插值變數不一致（中文顯示「已經有「{word}」」）
 *   4. 後端新的 error code 沒有對應翻譯
 * 所以用測試把它們擋住。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadDict() {
    const code = fs.readFileSync(path.join(ROOT, 'public/js/i18n.js'), 'utf8');
    const context = { window: {}, document: undefined, console };
    vm.createContext(context);
    vm.runInContext(code, context, { filename: 'i18n.js' });
    return context.window.PDI18n.DICT;
}

function placeholders(text) {
    return [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

const DICT = loadDict();
const LANGS = Object.keys(DICT);

test('i18n：預設語言是英文，且支援 EN 與中文', () => {
    const code = fs.readFileSync(path.join(ROOT, 'public/js/i18n.js'), 'utf8');
    assert.match(code, /const DEFAULT_LANG = 'en';/);
    assert.deepEqual(LANGS.sort(), ['en', 'zh']);
});

test('i18n：兩種語言的鍵完全相同（翻譯沒有漏）', () => {
    const en = Object.keys(DICT.en).sort();
    const zh = Object.keys(DICT.zh).sort();
    const missingInZh = en.filter((key) => !zh.includes(key));
    const missingInEn = zh.filter((key) => !en.includes(key));
    assert.deepEqual(missingInZh, [], `中文缺這些鍵：${missingInZh.join('、')}`);
    assert.deepEqual(missingInEn, [], `英文缺這些鍵：${missingInEn.join('、')}`);
});

test('i18n：沒有空字串的翻譯，插值變數兩邊一致', () => {
    for (const lang of LANGS) {
        for (const [key, value] of Object.entries(DICT[lang])) {
            assert.equal(String(value).trim().length > 0, true, `${lang}.${key} 是空的`);
        }
    }
    for (const key of Object.keys(DICT.en)) {
        assert.deepEqual(placeholders(DICT.zh[key]), placeholders(DICT.en[key]),
            `${key} 的插值變數不一致（en: ${DICT.en[key]} / zh: ${DICT.zh[key]}）`);
    }
});

test('i18n：index.html 用到的鍵都存在', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const used = new Set();
    for (const match of html.matchAll(/data-i18n(?:-html|-placeholder|-title|-aria)?="([^"]+)"/g)) {
        used.add(match[1]);
    }
    assert.equal(used.size > 20, true, 'index.html 應該有大量 data-i18n 標記');
    const missing = [...used].filter((key) => !DICT.en[key]);
    assert.deepEqual(missing, [], `index.html 用到但沒有翻譯的鍵：${missing.join('、')}`);
});

test('i18n：前端 JS 用到的 t(\'…\') 鍵都存在', () => {
    const files = fs.readdirSync(path.join(ROOT, 'public/js'))
        .filter((name) => name.endsWith('.js') && name !== 'i18n.js')
        .map((name) => path.join(ROOT, 'public/js', name));
    const used = new Set();
    for (const file of files) {
        const code = fs.readFileSync(file, 'utf8');
        for (const match of code.matchAll(/\bt\('([a-zA-Z][\w.]*)'/g)) used.add(match[1]);
    }
    assert.equal(used.size > 40, true, '應該抓到不少翻譯鍵');
    const missing = [...used].filter((key) => !DICT.en[key]);
    assert.deepEqual(missing, [], `JS 用到但沒有翻譯的鍵：${missing.join('、')}`);
});

test('i18n：後端每一個 error code 都有對應翻譯', () => {
    const { MESSAGES } = require('../lib/messages');
    const codes = Object.keys(MESSAGES);
    const missing = codes.filter((code) => !DICT.en[`errors.${code}`] || !DICT.zh[`errors.${code}`]);
    assert.deepEqual(missing, [], `這些 error code 沒有翻譯：${missing.join('、')}`);
    // 反過來：翻譯裡的 errors.* 也要有對應的 code 才不會變成死鍵
    const orphan = Object.keys(DICT.en)
        .filter((key) => key.startsWith('errors.'))
        .map((key) => key.replace('errors.', ''))
        .filter((code) => !MESSAGES[code]);
    assert.deepEqual(orphan, [], `這些翻譯沒有對應的 error code：${orphan.join('、')}`);
});

test('i18n：稽核動作與角色名稱都有翻譯（中文標籤不能只留在後端）', () => {
    const { AUDIT_ACTION_LABELS } = require('../lib/audit');
    const { ROLE_LEVELS } = require('../lib/roles');
    const missingActions = Object.keys(AUDIT_ACTION_LABELS).filter((action) => !DICT.zh[`auditAction.${action}`]);
    const missingRoles = Object.keys(ROLE_LEVELS).filter((role) => !DICT.zh[`role.${role}`] || !DICT.en[`role.${role}`]);
    assert.deepEqual(missingActions, [], `缺少中文的稽核動作：${missingActions.join('、')}`);
    assert.deepEqual(missingRoles, [], `缺少翻譯的角色：${missingRoles.join('、')}`);
});

test('i18n：每個稽核動作都有顏色分類（沒有沒顏色的孤兒動作）', () => {
    const { AUDIT_ACTION_LABELS } = require('../lib/audit');
    const store = {};
    const code = fs.readFileSync(path.join(ROOT, 'public/js/i18n.js'), 'utf8');
    const context = {
        window: { dispatchEvent() {} },
        console,
        CustomEvent: class CustomEvent {
            constructor(type, init) { this.type = type; this.detail = init && init.detail; }
        },
        localStorage: {
            getItem: (key) => (key in store ? store[key] : null),
            setItem: (key, value) => { store[key] = String(value); },
            removeItem: (key) => { delete store[key]; }
        },
        document: {
            documentElement: { setAttribute() {} },
            querySelectorAll: () => [],
            dispatchEvent() {}
        }
    };
    vm.createContext(context);
    vm.runInContext(code, context, { filename: 'i18n.js' });
    const api = context.window.PDI18n;
    const known = Object.keys(api.AUDIT_TONES);

    for (const action of Object.keys(AUDIT_ACTION_LABELS)) {
        const tone = api.auditTone(action);
        assert.ok(known.includes(tone), `${action} 的顏色分類是「${tone}」，請加進 AUDIT_TONES`);
    }
    /* 以後才加的新動作：用字尾推斷也要合理（至少不能全灰） */
    assert.equal(api.auditTone('FOO_DELETE'), 'remove');
    assert.equal(api.auditTone('FOO_CREATE'), 'create');
    assert.equal(api.auditTone('FOO_APPROVE'), 'review');
    assert.equal(api.auditTone('SOMETHING_ELSE'), 'other');
});

test('i18n：後端回應一律是英文（預設語言）＋ code', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const chineseErrors = [...server.matchAll(/error: [^,}\n]*[\u4e00-\u9fff][^,}\n]*/g)].map((m) => m[0]);
    assert.deepEqual(chineseErrors, [], '後端的錯誤訊息應該用 msg(code)（英文），不要在 server.js 寫中文');
    assert.match(server, /require\('\.\/lib\/messages'\)/);
});

/* 使用者實際看到的 bug：錯誤訊息裡的值沒帶到，畫面就印出「（{message}）」。
 * 現在規矩是：**沒給值的佔位符整段拿掉**，連空括號也不能留。 */
test('i18n：沒帶到值的佔位符不會原樣印出來（{message} 事件）', () => {
    const store = {};
    const code = fs.readFileSync(path.join(ROOT, 'public/js/i18n.js'), 'utf8');
    const context = {
        window: { dispatchEvent() {} },
        console,
        CustomEvent: class CustomEvent {
            constructor(type, init) { this.type = type; this.detail = init && init.detail; }
        },
        localStorage: {
            getItem: (key) => (key in store ? store[key] : null),
            setItem: (key, value) => { store[key] = String(value); },
            removeItem: (key) => { delete store[key]; }
        },
        document: {
            documentElement: { setAttribute() {} },
            querySelectorAll: () => [],
            dispatchEvent() {}
        }
    };
    vm.createContext(context);
    vm.runInContext(code, context, { filename: 'i18n.js' });
    const api = context.window.PDI18n;

    for (const lang of ['en', 'zh']) {
        api.setLang(lang);
        const bare = api.t('errors.DB_WRITE_FAILED');
        assert.equal(/\{|\}/.test(bare), false, `${lang}：不該出現 {…}（${bare}）`);
        assert.equal(/[（(]\s*[)）]/.test(bare), false, `${lang}：不該留空括號（${bare}）`);
        assert.equal(/\s{2,}/.test(bare), false, `${lang}：不該有多餘空白（${bare}）`);

        const withValue = api.t('errors.DB_WRITE_FAILED', { message: 'column "x" does not exist' });
        assert.match(withValue, /column "x" does not exist/, `${lang}：有值時要插進去`);
    }

    api.setLang('zh');
    assert.equal(api.errorMessage({ code: 'DB_WRITE_FAILED' }), api.t('errors.DB_WRITE_FAILED'));
    assert.match(api.errorMessage({ code: 'DB_WRITE_FAILED', details: { message: 'boom' } }), /boom/);
});
