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
    return (i > -1 && process.argv[i + 1]) || process.env.LIVE_BASE || 'https://gary-dictionary-mylearning.vercel.app';
})();
const HOST = new URL(BASE).origin;

/* 自動化檢查的簽章標頭（E-4）：這一輪跑出來的稽核紀錄會被標成 is_self_test，
 * 你在後台看稽核紀錄時預設不會看到這十幾筆假動作（想看可以取消勾選）。 */
const SelfTest = require('../lib/selftest');
const SELF_TEST_HEADER = process.env.JWT_SECRET ? SelfTest.makeHeader(process.env.JWT_SECRET) : '';
const selfTestCount = { sent: 0 };
async function pvFetch(url, options = {}) {
    const headers = Object.assign({}, options.headers);
    if (SELF_TEST_HEADER && String(url).startsWith(HOST)) {
        headers['X-PV-Self-Test'] = SELF_TEST_HEADER;
        selfTestCount.sent += 1;
    }
    return fetch(url, Object.assign({}, options, { headers }));
}
const TEST_CODE = '__live_verify__';
const NO_AUTH = process.argv.includes('--no-auth');
const EPHEMERAL = process.argv.includes('--ephemeral-teacher') || process.env.VERIFY_EPHEMERAL_TEACHER === '1';
const TEMP_USER = '__live_verify_teacher__';

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
    const res = await pvFetch(`${url}/rest/v1/${path}`, {
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
    const res = await pvFetch(`${url}/rest/v1/`, {
        headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/openapi+json' }
    });
    if (!res.ok) return null;
    return res.json();
}

async function counts() {
    const health = await (await pvFetch(`${BASE}/api/health`)).json();
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
    const home = await pvFetch(`${BASE}/`);
    const html = await home.text();
    const version = (await (await pvFetch(`${BASE}/api/version`)).json()).version;
    check('首頁 HTTP 200', home.status === 200);
    check(`頁面標的是 v${version}`, html.includes(`v${version}`), `v${version}`);
    const csp = home.headers.get('content-security-policy') || '';
    check("CSP 有 script-src 'self'", /script-src 'self'/.test(csp));
    check('CSP 沒有 unsafe-inline', !/unsafe-inline/.test(csp), csp.slice(0, 120));
    check('HTML 沒有行內 script', !/<script(?![^>]*\bsrc=)[^>]*>/.test(html));
    const analytics = await pvFetch(`${BASE}/js/analytics.js`);
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

    console.log('\n3. 資料庫直連往返：書本（v0.5.0：只有年級，沒有封面）');
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
                grade: 'ZZ',
                publisher: '',
                sort_order: 999,
                is_published: true,
            }
        });
        const directId = inserted && inserted[0] && inserted[0].id;
        createdIds.push(directId);
        check('資料庫寫得進去（INSERT 成功）', Boolean(directId), `id=${directId}`);
        /* 等 App 的快取過期（3 秒）再讀，驗的是「真的寫進資料庫」，不是快取行為 */
        await sleep(3500);
        const books = await (await pvFetch(`${BASE}/api/books`)).json();
        const row = (books.books || []).find((b) => b.grade === 'ZZ');
        check('書本清單讀得到剛寫進去的年級', Boolean(row), JSON.stringify((books.books || []).slice(-2)));
        check('書本清單只回年級（沒有 name／code／封面欄位）',
            Boolean(row) && row.name === undefined && row.code === undefined && row.has_cover === undefined && row.cover_url === undefined,
            JSON.stringify(row || {}));
    } catch (err) {
        check('資料庫寫得進去（INSERT 成功）', false, err.message);
    }

    console.log('\n3b. 臨時教師帳號：走一次「建立年級 → 建立單元」（v0.5.0：只需年級，封面已移除）');
    if (!EPHEMERAL) {
        skip('臨時年級驗收', '加 --ephemeral-teacher 就會跑（會建立並刪除一個臨時老師帳號）');
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
            let login = await pvFetch(`${BASE}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Origin: HOST },
                body: JSON.stringify({ username: TEMP_USER, password: tempPassword })
            });
            if (login.status !== 200) {
                /* 帳號是直接寫進資料庫的：等一下讓 App 的快取過期再試一次 */
                await sleep(3500);
                login = await pvFetch(`${BASE}/api/auth/login`, {
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

            /* ★ 年級用時間戳：第 3 段已經用掉 'ZZ'，再用一次會回 409 DUPLICATE_GRADE（踩過） */
            const verifyGrade = 'V' + String(Date.now()).slice(-4);
            const created = await authed('/api/books', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ grade: verifyGrade })
            });
            const createdBody = await created.json();
            check('臨時教師可以建立年級（HTTP 201）', created.status === 201 && createdBody.book && createdBody.book.grade === verifyGrade, JSON.stringify(createdBody).slice(0, 140));
            /* 建完就刪（不留在使用者的教材裡）。
             * ★ 沒有 DELETE /api/books/:id 這條路由（介面上也還不能刪年級）→ 用 REST 直接刪。 */
            if (createdBody.book && createdBody.book.id && typeof supabase === 'function') {
                await supabase(`dict_books?id=eq.${createdBody.book.id}`, { method: 'DELETE', body: null }).catch(() => null);
            }
            /* ★ 生字完整流程：這是「視窗化資料層」在線上最直接的實證
             *   （本機真瀏覽器檢查用的是 JSON 資料層，只有這一段真的走 Supabase）。 */
            if (createdBody.book && createdBody.book.id) {
                const unitRes = await authed(`/api/books/${createdBody.book.id}/units`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ unit_no: 1, title: 'Live verify unit' })
                });
                const unitBody = await unitRes.json();
                const unitId = unitBody.unit && unitBody.unit.id;
                check('臨時教師可以建立單元（HTTP 201）', unitRes.status === 201 && Boolean(unitId), JSON.stringify(unitBody).slice(0, 120));

                if (unitId) {
                    const word = 'verify' + String(Date.now()).slice(-5);
                    const entryRes = await authed(`/api/units/${unitId}/entries`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ headword: word, zh_meaning: '驗收', en_definition: 'live verify', part_of_speech: 'n.' })
                    });
                    const entryBody = await entryRes.json();
                    const entryId = entryBody.entry && entryBody.entry.id;
                    check('建立生字（HTTP 201）', entryRes.status === 201 && Boolean(entryId), JSON.stringify(entryBody).slice(0, 140));

                    if (entryId) {
                        /* 讀單元詳情：生字要在（＝真的寫進 Supabase 而且讀得回來） */
                        const detail = await (await pvFetch(`${BASE}/api/units/${unitId}?per_page=200`)).json();
                        const found = (detail.entries || []).find((entry) => entry.headword === word);
                        check('單元詳情讀得到剛建立的生字（＝真的寫進資料庫）', Boolean(found), JSON.stringify(detail.entries || []).slice(0, 120));
                        check('單元詳情只回這一頁需要的資料（有 total／has_more）',
                            typeof detail.total === 'number' && typeof detail.has_more === 'boolean', `total=${detail.total}`);
                        check('單元用量（D-3）回報了錄音數與上限',
                            typeof detail.unit.audio_count === 'number' && detail.unit.audio_limit > 0,
                            JSON.stringify({ count: detail.unit.audio_count, limit: detail.unit.audio_limit }));

                        /* 改生字（樂觀鎖：帶版本才會被檢查） */
                        const patched = await authed(`/api/entries/${entryId}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ zh_meaning: '驗收（改）', version: found && found.updated_at })
                        });
                        check('改生字（HTTP 200）', patched.status === 200, (await patched.text()).slice(0, 120));

                        /* 舊版本再送一次 → 409 STALE_WRITE（樂觀鎖在線上真的有效） */
                        const stale = await authed(`/api/entries/${entryId}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ zh_meaning: '不該寫進去', version: found && found.updated_at })
                        });
                        const staleBody = await stale.json();
                        check('用舊版本改生字會被擋（409 STALE_WRITE）', stale.status === 409 && staleBody.code === 'STALE_WRITE', `HTTP ${stale.status}`);

                        /* 刪生字（連音檔一起） */
                        const removed = await authed(`/api/entries/${entryId}`, { method: 'DELETE' });
                        check('刪生字（HTTP 200）', removed.status === 200, (await removed.text()).slice(0, 120));
                    }
                }
            }
            check('年級物件沒有書名與封面欄位',
                createdBody.book && createdBody.book.name === undefined && createdBody.book.code === undefined && createdBody.book.has_cover === undefined,
                JSON.stringify(createdBody.book || {}));
            const bookId = createdBody.book && createdBody.book.id;
            if (bookId) createdIds.push(bookId);

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
        const login = await pvFetch(`${BASE}/api/auth/login`, {
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
                body: JSON.stringify({ grade: 'ZZ' })
            });
            const createdBody = await created.json();
            check('建立年級 HTTP 201', created.status === 201 && createdBody.book && createdBody.book.grade === 'ZZ', JSON.stringify(createdBody).slice(0, 140));
            const apiId = createdBody.book && createdBody.book.id;
            if (apiId) createdIds.push(apiId);

            if (apiId) {
                const books = await (await pvFetch(`${BASE}/api/books`)).json();
                const mine = (books.books || []).find((b) => b.grade === 'ZZ');
                check('年級清單看得到它（＝真的寫進 Supabase）', Boolean(mine), JSON.stringify((books.books || []).slice(-2)));
                check('清單不含書名、代號與封面欄位（v0.5.0）',
                    Boolean(mine) && mine.name === undefined && mine.code === undefined && mine.has_cover === undefined && mine.cover_url === undefined,
                    JSON.stringify(mine || {}));
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

    console.log(`\n自動化檢查簽章：${SELF_TEST_HEADER ? `已送出 ${selfTestCount.sent} 個請求` : '未啟用（沒有 JWT_SECRET）'}`);
console.log(`\n===== 線上驗收：${pass} 通過 / ${fail} 失敗${skipped ? ` / ${skipped} 略過` : ''} =====`);
    process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
    console.error('✖ 驗收中斷：', err.message);
    process.exitCode = 1;
});
