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

test('外觀（F-3）：跟隨系統的深色票與明確選深色的色票必須完全一樣', () => {
    /* 兩段深色（@media prefers-color-scheme 與 [data-theme="dark"]）各自寫一份值，
     * 難免會只改一邊 —— 那會變成「選深色」與「系統深色」長得不同。這裡逐條比對。 */
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'tokens.css'), 'utf8');
    const mediaStart = css.indexOf('@media (prefers-color-scheme: dark)');
    const explicitStart = css.indexOf(':root[data-theme="dark"]');
    assert.ok(mediaStart > -1 && explicitStart > -1, '兩個深色區塊都要存在');
    const collect = (source) => {
        const out = {};
        for (const match of source.matchAll(/(--[a-z-]+):\s*([^;]+);/g)) out[match[1]] = match[2].trim();
        return out;
    };
    const media = collect(css.slice(mediaStart, explicitStart));
    const explicit = collect(css.slice(explicitStart));
    const names = Object.keys(media);
    assert.ok(names.length >= 15, `深色票太少（${names.length}）`);
    assert.deepEqual(Object.keys(explicit).sort(), names.sort(), '兩段的變數名稱要一樣');
    for (const name of names) {
        assert.equal(explicit[name], media[name], `${name} 在兩段深色裡的值不一樣`);
    }
});

test('外觀（F-3／F-5）：系統深色不會蓋掉使用者明確選的淺色', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'tokens.css'), 'utf8');
    assert.match(css, /:root:not\(\[data-theme="light"\]\)/, '跟隨系統那段要排除「明確選淺色」');
    assert.match(css, /:root\[data-theme="light"\]/, '要有明確的淺色選擇');
});

test('稽核動作：宣告的標籤與程式實際寫入的動作完全一致', () => {
    const files = ['server.js'].concat(
        walk(path.join(ROOT, 'routes')).filter((f) => f.endsWith('.js')).map((f) => path.relative(ROOT, f))
    );
    /* ★ 只掃「logAudit 呼叫裡面」的動作文；整檔掃引號大寫字串會被誤判——
     *   錯誤回應現在也帶 code（例如 code: 'ORIGIN_NOT_ALLOWED'），那些不是稽核動作。 */
    const used = new Set();
    for (const file of files) {
        const full = path.join(ROOT, file);
        if (!fs.existsSync(full)) continue;
        const text = fs.readFileSync(full, 'utf8');
        let index = text.indexOf('logAudit(store,');
        while (index !== -1) {
            const window = text.slice(index, index + 700);
            const end = window.search(/\n\s*\}\);|\}\);/);
            const call = end === -1 ? window : window.slice(0, end);
            for (const match of call.matchAll(/'([A-Z][A-Z0-9_]{2,})'/g)) used.add(match[1]);
            index = text.indexOf('logAudit(store,', index + 1);
        }
    }
    assert.equal(used.size > 5, true, '應該抓到多個稽核動作');
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

test('前端用到的元素 id 真的存在（getElementById 找不到就會靜默不做事）', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    /* 這幾個是 JS 動態產生的（標題列按鈕、行內重設密碼訊息），HTML 裡沒有是正常的 */
    const createdByJs = new Set(['loginBtn', 'logoutBtn', 'adminToggleBtn', 'rowPasswordMsg']);
    const files = fs.readdirSync(path.join(ROOT, 'public/js')).filter((f) => f.endsWith('.js'));
    const missing = [];
    for (const file of files) {
        const code = fs.readFileSync(path.join(ROOT, 'public/js', file), 'utf8');
        for (const match of code.matchAll(/getElementById\('([^']+)'\)/g)) {
            const id = match[1];
            if (htmlIds.has(id) || createdByJs.has(id)) continue;
            missing.push(`${file} → ${id}`);
        }
    }
    assert.deepEqual(missing, [], `index.html 裡找不到這些 id：${missing.join('、')}`);
});

test('vercel.json：靜態檔要指定自家 CORS，不能讓 CDN 預設的 `*` 生效（A-6）', () => {
    /* Vercel 對靜態檔預設回 Access-Control-Allow-Origin: *（實測 /js/app.js 就是這樣），
     * 那等於任何網站都能用 fetch 讀我們的 JS。vercel.json 的 headers 必須明確覆蓋它。 */
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    assert.ok(Array.isArray(config.headers) && config.headers.length > 0, 'vercel.json 要有 headers 規則');

    const staticRule = config.headers.find((rule) => String(rule.source).includes('js'));
    assert.ok(staticRule, '找不到 /js /css /img 的標頭規則');
    const byKey = Object.fromEntries(staticRule.headers.map((header) => [header.key, header.value]));
    assert.match(byKey['Access-Control-Allow-Origin'] || '', /^https:\/\/gary-dictionary-mylearning\.vercel\.app$/,
        'ACAO 必須是自家網域，不能是 *');
    assert.equal(byKey['Cross-Origin-Resource-Policy'], 'same-origin');
    assert.equal(byKey['Access-Control-Allow-Origin'].includes('*'), false);
});

test('前端把 data-* 或 option 的 value 交給 el() 時要用 attrs（直接給鍵會被靜默忽略）', () => {
    /* el() 只認 options.attrs / options.dataset；寫成 { 'data-tone': x } 或 { value: x } 都不會生效，
     * 而且畫面上完全看不出來（元素在、文字對，屬性就是不見了 → 選單選了卻篩不出東西）。 */
    const files = fs.readdirSync(path.join(ROOT, 'public/js')).filter((f) => f.endsWith('.js'));
    const wrong = [];
    for (const file of files) {
        const lines = fs.readFileSync(path.join(ROOT, 'public/js', file), 'utf8').split('\n');
        lines.forEach((line, index) => {
            if (!/\bel\(/.test(line)) return;
            const hasAttrs = /attrs\s*:/.test(line) || /dataset\s*:/.test(line);
            if (hasAttrs) return;
            if (/'data-[a-z-]+'\s*:/.test(line)) wrong.push(`${file}:${index + 1}（data-* 屬性）`);
            if (/el\('option'/.test(line) && /\bvalue\s*:/.test(line)) wrong.push(`${file}:${index + 1}（option 的 value）`);
        });
    }
    assert.deepEqual(wrong, [], `這些地方的屬性會被忽略：${wrong.join('、')}`);
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
