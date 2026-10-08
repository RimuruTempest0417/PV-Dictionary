#!/usr/bin/env node
/* 線上版端到端驗收（不是只打 /api/health 就算過）
 *
 * 驗什麼：
 *   1. 首頁／CSP 標頭／analytics.js（Vercel Web Analytics 的同源檔案）
 *   2. schema 漂移：線上資料庫的欄位 vs lib/schema.js 的清單（封面欄位漏了就是 500）
 *   3. 資料庫直連往返（不需登入）：插入帶封面的測試書 → App 讀得到 → 刪除
 *   4. 登入後的驗收：登入 → /api/auth/me → 帳號清單 → 建書 → 上傳封面 → 刪封面
 *   5. 清乾淨：只刪這次的測試資料，並確認筆數回到開始前的水準
 *
 * 登入帳號：預設 Gary，密碼用 .env 的 VERIFY_PASSWORD（沒有就退回 SEED_WEB_MANAGER_PASSWORD）；
 * 若你自己改過密碼，登入段會被略過並提示怎麼補。
 * 全程不印任何密碼／金鑰。用法：node scripts/live-verify.js [--base https://...] [--no-auth]
 */
require('dotenv').config();

const crypto = require('crypto');

const BASE = (() => {
    const i = process.argv.indexOf('--base');
    return (i > -1 && process.argv[i + 1]) || process.env.LIVE_BASE || 'https://pv-dictionary-mylearning.vercel.app';
})();
const HOST = new URL(BASE).origin;
const TEST_CODE = '__live_verify__';
const NO_AUTH = process.argv.includes('--no-auth');
const EPHEMERAL = process.argv.includes('--ephemeral-teacher') || process.env.VERIFY_EPHEMERAL_TEACHER === '1';
const TEMP_USER = '__live_verify_teacher__';
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AARAAI/wH+AB0AAAAASUVORK5CYII=';

let pass = 0;
let fail = 0;
let skipped = 0;
function check(label, ok, extra) {
    if (ok) { pass += 1; console.log(`  ✔ ${label}${extra ? `：${extra}` : ''}`); } else { fail += 1; console.log(`  ✖ ${label}${extra ? `：${extra}` : ''}`); }
}
function skip(label, why) {
    skipped += 1;
    console.log(`  － 略過 ${label}（${why}）`);
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

async function supabaseOpenApi() {
    const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return null;
    const res = await fetch(`${url}/rest/v1/`, {
        headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/openapi+json' }
    });
    if (!res.ok) return null;
    return res.json();
}

async function counts() {
    const health = await (await fetch(`${BASE}/api/health`)).json();
    return health.counts || {};
}

/* 稽核紀錄目前的最大 id：清理時只刪「這次驗收之後才產生的」，
 * 不要用 target_id 去刪（使用者的單元／生字 id 可能剛好等於我建立的書本 id，會誤刪他的紀錄）。 */
async function maxAuditId() {
    const rows = await supabase('dict_audit_logs?select=id&order=id.desc&limit=1');
    return rows[0] ? Number(rows[0].id) : 0;
}

/* 資料層快取 3 秒：直接用 REST 從「外面」寫進去的資料，最多 3 秒後 App 才看得到（這是刻意設計）。
 * 驗收時要等它過期，否則會誤判成「寫進去了但讀不到」。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cleanup(bookIds, auditWatermark = 0) {
    for (const id of bookIds.filter((value) => value)) {
        await supabase(`dict_books?id=eq.${id}`, { method: 'DELETE', body: null });
    }
    await supabase(`dict_books?code=eq.${TEST_CODE}`, { method: 'DELETE', body: null });
    /* 只刪這次驗收之後新增的稽核列（水線以上的），使用者的舊紀錄一律不動 */
    if (auditWatermark) {
        await supabase(`dict_audit_logs?id=gt.${auditWatermark}`, { method: 'DELETE', body: null });
    }
    /* 臨時帳號（--ephemeral-teacher 用的） */
    const temp = await supabase(`dict_users?username=eq.${TEMP_USER}&select=id`);
    await supabase(`dict_users?username=eq.${TEMP_USER}`, { method: 'DELETE', body: null });
    return temp.length;
}

async function main() {
    console.log(`線上驗收：${BASE}\n`);
    const createdIds = [];

    console.log('1. 靜態與標頭');
    const home = await fetch(`${BASE}/`);
    const html = await home.text();
    const version = (await (await fetch(`${BASE}/api/version`)).json()).version;
    check('首頁 HTTP 200', home.status === 200);
    check(`頁面標的是 v${version}`, html.includes(`v${version}`), `v${version}`);
    const csp = home.headers.get('content-security-policy') || '';
    check("CSP 有 script-src 'self'", /script-src 'self'/.test(csp));
    check('CSP 沒有 unsafe-inline', !/unsafe-inline/.test(csp), csp.slice(0, 120));
    check('HTML 沒有行內 script', !/<script(?![^>]*\bsrc=)[^>]*>/.test(html));
    const analytics = await fetch(`${BASE}/js/analytics.js`);
    check('/js/analytics.js 是同源檔案（200）', analytics.status === 200);
    check('analytics 走 /_vercel/insights（Vercel 服務）', /\/_vercel\/insights\/script\.js/.test(html));

    /* schema 漂移：線上資料庫的欄位要跟 lib/schema.js 的清單一致。
     * （書本封面的 cover_* 欄位就是漏了這一步，上線後上傳封面直接 500。） */
    const spec = await supabaseOpenApi();
    if (spec) {
        const { compareWithLive } = require('../lib/schema');
        const live = compareWithLive(spec.definitions || {});
        const pretty = live.missing.map((item) => `${item.table}.${item.column}`);
        check('線上 schema 沒有缺少程式要用的欄位', pretty.length === 0, pretty.join('、'));
    } else {
        console.log('  （略過 schema 檢查：.env 沒有 Supabase 憑證）');
    }

    const baseline = await counts();
    const auditWatermark = await maxAuditId();
    console.log(`   （開始前的筆數：${JSON.stringify(baseline)}；稽核水線 id=${auditWatermark}）`);

    console.log('\n3. 資料庫直連往返：帶封面的書（不需要登入）');
    try {
        /* id 自己配（跟 App 一樣用 max(id)+1）：identity sequence 只有在「不給 id」時才會遞增，
         * 而本專案的資料一律帶 id 寫入，所以不能靠 sequence。 */
        const maxRows = await supabase('dict_books?select=id&order=id.desc&limit=1');
        const nextBookId = (maxRows[0] ? Number(maxRows[0].id) : 0) + 1;
        const inserted = await supabase('dict_books', {
            method: 'POST',
            body: {
                id: nextBookId,
                code: TEST_CODE,
                name: 'ZZ Live Verify',
                grade: '',
                publisher: '',
                sort_order: 999,
                is_published: true,
                cover_mime: 'image/png',
                cover_data: PNG_1PX,
                cover_bytes: Buffer.from(PNG_1PX, 'base64').length
            }
        });
        const directId = inserted && inserted[0] && inserted[0].id;
        createdIds.push(directId);
        check('資料庫收得下封面欄位（INSERT 成功）', Boolean(directId), `id=${directId}`);
        /* 等 App 的快取過期（3 秒）再讀，驗的是「真的寫進資料庫」，不是快取行為 */
        await sleep(3500);
        const cover = await fetch(`${BASE}/api/covers/${directId}`);
        check('GET /api/covers/<id> 回圖片', cover.status === 200 && /image\/png/.test(cover.headers.get('content-type') || ''), `HTTP ${cover.status}`);
        const books = await (await fetch(`${BASE}/api/books`)).json();
        const row = (books.books || []).find((b) => b.code === TEST_CODE);
        check('書本清單看得到它有封面（has_cover）', Boolean(row && row.has_cover));
        check('清單沒有把 base64 一起回傳', JSON.stringify(row || {}).indexOf(PNG_1PX.slice(0, 40)) === -1);
    } catch (err) {
        check('資料庫收得下封面欄位（INSERT 成功）', false, err.message);
    }

    console.log('\n3b. 臨時教師帳號：走一次「建書 → 上傳封面」（不碰你的帳號，結束後刪掉）');
    if (!EPHEMERAL) {
        skip('臨時帳號上傳驗收', '加 --ephemeral-teacher 就會跑（會建立並刪除一個臨時老師帳號）');
    } else {
        try {
            const { hashPassword } = require('../lib/passwords');
            const tempPassword = crypto.randomBytes(24).toString('base64url');
            const maxUsers = await supabase('dict_users?select=id&order=id.desc&limit=1');
            await supabase('dict_users', {
                method: 'POST',
                body: {
                    id: (maxUsers[0] ? Number(maxUsers[0].id) : 0) + 1,
                    username: TEMP_USER,
                    display_name: 'Live verify (temp)',
                    role: 'teacher',
                    is_active: true,
                    password_hash: hashPassword(tempPassword)
                }
            });
            let login = await fetch(`${BASE}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Origin: HOST },
                body: JSON.stringify({ username: TEMP_USER, password: tempPassword })
            });
            if (login.status !== 200) {
                /* 帳號是直接寫進資料庫的：等一下讓 App 的快取過期再試一次 */
                await sleep(3500);
                login = await fetch(`${BASE}/api/auth/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Origin: HOST },
                    body: JSON.stringify({ username: TEMP_USER, password: tempPassword })
                });
            }
            check('臨時教師帳號可以登入', login.status === 200, `HTTP ${login.status}`);
            const setCookie = login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie') || ''];
            const cookie = setCookie.map((row) => String(row).split(';')[0]).filter(Boolean).join('; ');
            const authed = (path, options) => fetch(`${BASE}${path}`, Object.assign({}, options, {
                headers: Object.assign({ Cookie: cookie, Origin: HOST }, (options && options.headers) || {})
            }));

            const created = await authed('/api/books', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'ZZ Live Verify', code: `${TEST_CODE}_api`, is_published: false })
            });
            const createdBody = await created.json();
            check('臨時教師可以建立書本（HTTP 201）', created.status === 201, JSON.stringify(createdBody).slice(0, 140));
            const bookId = createdBody.book && createdBody.book.id;
            if (bookId) createdIds.push(bookId);

            if (bookId) {
                const upload = await authed(`/api/books/${bookId}/cover`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: `data:image/png;base64,${PNG_1PX}`, mime: 'image/png' })
                });
                const uploadText = await upload.text();
                check('上傳書本封面 HTTP 201（＝你回報的那個 500）', upload.status === 201, uploadText.slice(0, 200));
                const cover = await fetch(`${BASE}/api/covers/${bookId}`);
                check('封面讀得回來（圖片）', cover.status === 200 && /image\/png/.test(cover.headers.get('content-type') || ''), `HTTP ${cover.status}`);
                const removed = await authed(`/api/books/${bookId}/cover`, { method: 'DELETE' });
                check('刪除封面 HTTP 200', removed.status === 200);
            }
        } catch (err) {
            check('臨時帳號上傳驗收', false, err.message);
        }
    }

    console.log('\n4. 登入後的驗收');
    const username = process.env.VERIFY_USERNAME || 'Gary';
    const password = process.env.VERIFY_PASSWORD || process.env.SEED_WEB_MANAGER_PASSWORD || process.env.SEED_MANAGER_PASSWORD;
    if (NO_AUTH || !password) {
        skip('登入相關檢查', NO_AUTH ? '--no-auth' : '沒有可用的密碼（.env 的 VERIFY_PASSWORD 或 SEED_WEB_MANAGER_PASSWORD）');
    } else {
        const login = await fetch(`${BASE}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: HOST },
            body: JSON.stringify({ username, password })
        });
        const loginText = await login.text();
        if (login.status !== 200) {
            skip('登入相關檢查', `登入失敗 HTTP ${login.status}（若你改過密碼，可在 .env 加 VERIFY_PASSWORD=<${username} 目前密碼> 後重跑）`);
        } else {
            const loginBody = JSON.parse(loginText);
            check(`登入 ${username} HTTP 200`, true, `role=${loginBody.user && loginBody.user.role}`);
            const setCookie = login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie') || ''];
            const cookie = setCookie.map((row) => String(row).split(';')[0]).filter(Boolean).join('; ');
            check('拿到 HttpOnly cookie', /pd_token=/.test(cookie));

            const authed = (path, options) => fetch(`${BASE}${path}`, Object.assign({}, options, {
                headers: Object.assign({ Cookie: cookie, Origin: HOST }, (options && options.headers) || {})
            }));

            const me = await authed('/api/auth/me');
            const meBody = await me.json();
            check('/api/auth/me 認得這個 cookie', me.status === 200, `role=${meBody.user && meBody.user.role}`);
            const users = await (await authed('/api/admin/users')).json();
            const list = users.users || [];
            check('帳號清單讀得到', list.length >= 1, list.map((u) => u.username).join(','));

            const created = await authed('/api/books', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'ZZ Live Verify', code: TEST_CODE, is_published: false })
            });
            const createdBody = await created.json();
            check('建立書本 HTTP 201', created.status === 201, JSON.stringify(createdBody).slice(0, 140));
            const apiId = createdBody.book && createdBody.book.id;
            if (apiId) createdIds.push(apiId);

            if (apiId) {
                const books = await (await fetch(`${BASE}/api/books`)).json();
                check('書本清單看得到它（＝真的寫進 Supabase）', (books.books || []).some((b) => b.code === TEST_CODE));
                const upload = await authed(`/api/books/${apiId}/cover`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: `data:image/png;base64,${PNG_1PX}`, mime: 'image/png' })
                });
                const uploadText = await upload.text();
                check('上傳書本封面 HTTP 201（你回報的那個 500）', upload.status === 201, uploadText.slice(0, 160));
                const covered = (await (await fetch(`${BASE}/api/books`)).json()).books || [];
                check('上傳後清單顯示 has_cover', Boolean((covered.find((b) => b.code === TEST_CODE) || {}).has_cover));
                const removed = await authed(`/api/books/${apiId}/cover`, { method: 'DELETE' });
                check('刪除封面 HTTP 200', removed.status === 200, (await removed.text()).slice(0, 120));
            }
        }
    }

    console.log('\n5. 清乾淨（只刪這次的測試資料）');
    await cleanup(createdIds, auditWatermark);
    const left = await supabase(`dict_books?code=eq.${TEST_CODE}&select=id`);
    check('測試資料已從資料庫刪除', left.length === 0);
    const tempLeft = await supabase(`dict_users?username=eq.${TEMP_USER}&select=id`);
    check('臨時帳號已刪除', tempLeft.length === 0);
    /* App 的筆數是快取來的：等它過期（3 秒）再比對，才不會拿到清理前的舊數字 */
    await sleep(3500);
    const after = await counts();
    check('筆數回到開始前的水準', JSON.stringify(after) === JSON.stringify(baseline), `before=${JSON.stringify(baseline)} after=${JSON.stringify(after)}`);

    console.log(`\n===== 線上驗收：${pass} 通過 / ${fail} 失敗${skipped ? ` / ${skipped} 略過` : ''} =====`);
    process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
    console.error('✖ 驗收中斷：', err.message);
    process.exitCode = 1;
});
