/* 守門：前端各檔案用的「裸函式」必須在**同一個檔案內**定義，或是從 window.PD* 解構來的。
 *
 * 為什麼要這個（v0.11.0 前的真實 bug）：
 *   public/js/admin.js 用了 6 次 `errText()`，但 errText 只定義在 **app.js 的 IIFE 裡**（不是全域），
 *   所以 admin.js 的每一條錯誤路徑都丟 `ReferenceError: errText is not defined` ——
 *   正式站的錯誤日誌留下 UNHANDLED_REJECTION，使用者看到的是「錯誤處理自己壞掉」而不是原始錯誤。
 *   這種「跨 IIFE 誤用」用一般單元測試抓不到（要真的在瀏覽器裡觸發錯誤路徑），所以在原始碼層守門。
 *
 * 規則：對每個 public/js/*.js 檢查下面這些常用小工具名稱 ——
 *   只要檔案裡「有呼叫」，就必須「有定義（const/let/var/function）」或「從 window.PD* 解構」。
 *   新增共用工具時把它加進 HELPERS 即可；刻意不想守的（例如 window.xxx 直接呼叫）不會誤判。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const JS_DIR = path.join(__dirname, '..', 'public', 'js');
const HELPERS = [
    'errText', 't', 'el', 'clear', 'toast', 'setFormMessage', 'formatDateTime',
    'renderInto', 'api', 'state'
];

const files = fs.readdirSync(JS_DIR).filter((name) => name.endsWith('.js')).sort();

function analyze(source, name) {
    const used = new RegExp(`(^|[^.\\w$])${name}\\s*\\(`);
    if (!used.test(source)) return null;                         /* 沒用到 → 不管 */
    const defined = new RegExp(`(const|let|var|function)\\s+${name}\\b`).test(source);
    /* const { el, clear } = window.PDUI; ／ const api = window.PDApi; */
    const destructured = new RegExp(`\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=\\s*window\\.PD`).test(source);
    const fromWindow = new RegExp(`(const|let|var)\\s+${name}\\s*=\\s*window\\.PD`).test(source);
    return { defined, ok: defined || destructured || fromWindow };
}

test('前端：用到的共用小工具必須在檔案內有定義或來自 window.PD*', () => {
    const problems = [];
    for (const file of files) {
        const source = fs.readFileSync(path.join(JS_DIR, file), 'utf8');
        for (const name of HELPERS) {
            const hit = analyze(source, name);
            if (hit && !hit.ok) problems.push(`${file} 用了 ${name}() 但檔案內沒有定義、也不是從 window.PD* 取`);
        }
    }
    assert.deepEqual(problems, [], `跨檔案誤用（執行時會 ReferenceError）：\n  ${problems.join('\n  ')}`);
});

test('前端：admin.js 自己定義 errText（曾經漏掉的那一個）', () => {
    const source = fs.readFileSync(path.join(JS_DIR, 'admin.js'), 'utf8');
    assert.match(source, /const errText = \(err\) => window\.PDI18n\.errorMessage\(err\)/);
});
