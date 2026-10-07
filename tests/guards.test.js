/* 兩個「不會有任何錯誤訊息、只能靠測試守」的守門檢查
 * 1. 稽核動作：lib/audit.js 宣告的中文標籤 ＝ 程式實際會寫的動作
 *    （不一致時：下拉選單多一個永遠查不到的動作，或程式寫了一個選單裡找不到的動作）
 * 2. 前端不得出現行內事件與行內 style（CSP 是 script-src 'self' / style-src 'self'）
 *    這一類問題按鈕看起來完全正常、按下去卻什麼都不會發生，而且不會有例外。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { AUDIT_ACTION_LABELS } = require('../lib/audit');

function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

test('稽核動作：宣告的標籤與程式實際寫入的動作完全一致', () => {
    const sources = ['server.js'].concat(
        walk(path.join(ROOT, 'routes')).filter((f) => f.endsWith('.js')).map((f) => path.relative(ROOT, f))
    );
    const used = new Set();
    for (const file of sources) {
        const full = path.join(ROOT, file);
        if (!fs.existsSync(full)) continue;
        const text = fs.readFileSync(full, 'utf8');
        for (const match of text.matchAll(/'([A-Z][A-Z0-9_]{2,})'/g)) used.add(match[1]);
    }
    const declared = new Set(Object.keys(AUDIT_ACTION_LABELS));
    const missingLabel = [...used].filter((action) => !declared.has(action));
    const unusedLabel = [...declared].filter((action) => !used.has(action));
    assert.deepEqual(missingLabel, [], `程式寫了但沒有中文標籤的動作：${missingLabel.join('、')}`);
    assert.deepEqual(unusedLabel, [], `宣告了但程式從來不寫的動作：${unusedLabel.join('、')}`);
});

test('前端沒有行內事件屬性與行內 style（CSP 會把它們擋成啞的）', () => {
    const files = walk(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html'));
    const offenders = [];
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        for (const match of text.matchAll(/\son[a-z]+\s*=\s*["']/gi)) {
            offenders.push(`${path.relative(ROOT, file)}：${match[0].trim()}`);
        }
        for (const match of text.matchAll(/\sstyle\s*=\s*["']/gi)) {
            offenders.push(`${path.relative(ROOT, file)}：${match[0].trim()}`);
        }
    }
    assert.deepEqual(offenders, []);
});

test('伺服器端不含寫死的密碼或 Supabase 金鑰', () => {
    const files = ['server.js', path.join('lib', 'auth.js'), path.join('lib', 'store', 'index.js')];
    for (const file of files) {
        const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
        assert.equal(/SUPABASE_SERVICE_ROLE_KEY\s*=\s*['"][A-Za-z0-9._-]{20,}/.test(text), false, `${file} 疑似寫死金鑰`);
        assert.equal(/JWT_SECRET\s*=\s*['"][A-Za-z0-9._-]{12,}/.test(text), false, `${file} 疑似寫死 JWT_SECRET`);
    }
});

test('.env 沒有被版控追蹤（.gitignore 有涵蓋）', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    assert.match(ignore, /^\.env$/m);
    assert.match(ignore, /^data\/$/m);
});
