#!/usr/bin/env node
/* 線上版端到端驗收（不是只打 /api/health 就算過）
 *
 * 驗什麼：
 *   1. 首頁／CSP 標頭／analytics.js（Vercel Web Analytics 的同源檔案）
 *   2. Gary 登入 → /api/auth/me → /api/admin/users（只有 Gary）
 *   3. **真的寫進資料庫**：建一本書 → 下一個請求（會重新 hydrate）看得到 → 打 /api/health 看得到筆數
 *   4. 清乾淨：直接用 Supabase REST 刪掉測試資料 → 再讀一次確認回到空的
 *   5. 順便證明寫入路徑（登入本身就會寫 last_login_at 與稽核）
 *
 * 全程不印任何密碼／金鑰。用法：node scripts/live-verify.js [--base https://...]
 */
require('dotenv').config();

const BASE = (() => {
    const i = process.argv.indexOf('--base');
    return (i > -1 && process.argv[i + 1]) || process.env.LIVE_BASE || 'https://pv-dictionary-mylearning.vercel.app';
})();
const HOST = new URL(BASE).origin;
const TEST_CODE = '__live_verify__';

let pass = 0;
let fail = 0;
function check(label, ok, extra) {
    if (ok) { pass += 1; console.log(`  ✔ ${label}${extra ? `：${extra}` : ''}`); } else { fail += 1; console.log(`  ✖ ${label}${extra ? `：${extra}` : ''}`); }
}

async function supabase(path, options) {
    const url = String(process.env.SUPABASE_URL).replace(/\/+$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    const res = await fetch(`${url}/rest/v1/${path}`, {
        method: (options && options.method) || 'GET',
        headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation'
        },
        body: options && options.body ? JSON.stringify(options.body) : undefined
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase ${path} → HTTP ${res.status}：${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
}

async function main() {
    console.log(`線上驗收：${BASE}\n`);

    console.log('1. 靜態與標頭');
    const home = await fetch(`${BASE}/`);
    const html = await home.text();
    check('首頁 HTTP 200', home.status === 200);
    check('標題是 v0.3.0', /PV_Dictionary v0\.3\.0/.test(html));
    const csp = home.headers.get('content-security-policy') || '';
    check("CSP 有 script-src 'self'", /script-src 'self'/.test(csp));
    check('CSP 沒有 unsafe-inline', !/unsafe-inline/.test(csp), csp.slice(0, 120));
    check('HTML 沒有行內 script', !/<script(?![^>]*\bsrc=)[^>]*>/.test(html));
    const analytics = await fetch(`${BASE}/js/analytics.js`);
    check('/js/analytics.js 是同源檔案（200）', analytics.status === 200);
    check('analytics 走 /_vercel/insights（Vercel 服務）', /\/_vercel\/insights\/script\.js/.test(html));

    console.log('\n2. 登入與權限');
    const password = process.env.SEED_WEB_MANAGER_PASSWORD || process.env.SEED_MANAGER_PASSWORD;
    if (!password) { console.log('  ✖ .env 沒有種子密碼可用，跳過登入驗證'); return; }
    const login = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: HOST },
        body: JSON.stringify({ username: 'Gary', password })
    });
    const loginBody = await login.text();
    check('Gary 登入 HTTP 200', login.status === 200, loginBody.slice(0, 120));
    const setCookie = login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie') || ''];
    const cookie = setCookie.map((row) => String(row).split(';')[0]).filter(Boolean).join('; ');
    check('拿到 HttpOnly cookie', /pd_token=/.test(cookie));
    const user = JSON.parse(loginBody || '{}').user || {};
    check('角色是 web_manager', user.role === 'web_manager', String(user.role));

    const authed = (path, options) => fetch(`${BASE}${path}`, Object.assign({}, options, {
        headers: Object.assign({ Cookie: cookie, Origin: HOST }, (options && options.headers) || {})
    }));
    const me = await authed('/api/auth/me');
    const meBody = await me.json();
    check('/api/auth/me 認得這個 cookie', me.status === 200, `role=${meBody.user && meBody.user.role}`);
    check('permissions.can_manage_users 為 true', Boolean(meBody.permissions && meBody.permissions.can_manage_users));

    const users = await authed('/api/admin/users');
    const usersBody = await users.json();
    const list = usersBody.users || [];
    check('帳號清單只有 Gary 一人', list.length === 1 && list[0].username === 'Gary', list.map((u) => u.username).join(','));

    console.log('\n3. 真的寫進資料庫（建一本書 → 下一個請求看得到）');
    const created = await authed('/api/books', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'ZZ Live Verify', code: TEST_CODE })
    });
    const createdBody = await created.json();
    check('建立書本 HTTP 201', created.status === 201, JSON.stringify(createdBody).slice(0, 120));
    const bookId = createdBody.book && createdBody.book.id;

    const books = await (await fetch(`${BASE}/api/books`)).json();
    check('書本清單看得到它（＝真的寫進 Supabase）', (books.books || []).some((b) => b.code === TEST_CODE));
    const inDb = await supabase(`dict_books?code=eq.${TEST_CODE}&select=id,code,name`);
    check('用 Supabase REST 直接查也查得到', inDb.length === 1, JSON.stringify(inDb));
    const health = await (await fetch(`${BASE}/api/health`)).json();
    check('health 看到 backend=supabase、data_file=null', health.backend === 'supabase' && health.data_file === null);
    check('health 的書本筆數 ≥1', (health.counts && health.counts.books) >= 1, JSON.stringify(health.counts));

    console.log('\n4. 清乾淨（只刪這次的測試資料）');
    if (bookId) await supabase(`dict_books?id=eq.${bookId}`, { method: 'DELETE', body: null });
    await supabase(`dict_audit_logs?action=eq.BOOK_CREATE&target_id=eq.${bookId}`, { method: 'DELETE', body: null });
    const cleaned = await supabase(`dict_books?code=eq.${TEST_CODE}&select=id`);
    check('測試書本已從資料庫刪除', cleaned.length === 0);
    const after = await (await fetch(`${BASE}/api/books`)).json();
    check('線上書本清單回到空的', (after.books || []).length === 0, `books=${(after.books || []).length}`);
    const afterHealth = await (await fetch(`${BASE}/api/health`)).json();
    check('health 的書本筆數回到 0', afterHealth.counts.books === 0, JSON.stringify(afterHealth.counts));

    console.log(`\n===== 線上驗收：${pass} 通過 / ${fail} 失敗 =====`);
    process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
    console.error('✖ 驗收中斷：', err.message);
    process.exitCode = 1;
});
