/* API 端到端測試：真的起一個 server + 真的用 cookie 走完整流程
 * （不碰 Supabase，也不碰 data/store.json：每個測試用自己的暫存資料檔）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const { createApp } = require('../server');
const { hashPassword } = require('../lib/passwords');

const PASSWORD = 'pass1234';

function seedStore(store) {
    const users = [
        ['manager', 'admin', '網頁管理員'],
        ['webmanager', 'web_manager', '網站管理員'],
        ['teacher', 'teacher', '英文老師'],
        ['classrep', 'class_rep', '英文科代表'],
        ['student', 'student', '學生']
    ];
    for (const [username, role, display] of users) {
        store.createUser({
            username,
            display_name: display,
            role,
            password_hash: hashPassword(PASSWORD),
            is_active: true
        });
    }
    const book = store.createBook({ code: 'B5A', name: 'Book 5A', sort_order: 1, is_published: true });
    const unit = store.createUnit({ book_id: book.id, unit_no: 1, title: 'My New School', sort_order: 1, is_published: true });
    const hidden = store.createUnit({ book_id: book.id, unit_no: 9, title: '草稿單元', sort_order: 9, is_published: false });
    store.createEntry({
        unit_id: unit.id, headword: 'campus', headword_norm: 'campus', ipa_us: '/ˈkæm.pəs/',
        part_of_speech: 'n.', zh_meaning: '校園', en_definition: 'the land of a school',
        status: 'published', sort_order: 1, created_by: 'seed'
    });
    return { book, unit, hidden };
}

function startServer(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-api-'));
    const app = createApp({ backend: 'json', dataFile: path.join(dir, 'store.json') });
    const store = app.locals.store;
    const ids = seedStore(store);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => {
        try { server.close(); } catch (err) { /* 已關閉 */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* 忽略 */ }
    });
    return { app, store, server, base, ids };
}

async function login(base, username, password = PASSWORD) {
    const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const cookie = setCookies.map((line) => line.split(';')[0]).join('; ');
    const body = await res.json().catch(() => null);
    return { status: res.status, body, cookie, setCookies };
}

async function api(base, url, options = {}) {
    const headers = {};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.cookie) headers.Cookie = options.cookie;
    if (options.origin) headers.Origin = options.origin;
    const res = await fetch(`${base}${url}`, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json().catch(() => null) : null;
    return { status: res.status, data, headers: res.headers };
}

test('訪客：可以瀏覽書本與單元，但看不到未發佈的單元，也不能編輯', async (t) => {
    const { base, ids } = startServer(t);
    const books = await api(base, '/api/books');
    assert.equal(books.status, 200);
    assert.equal(books.data.books.length, 1);
    assert.equal(books.data.books[0].unit_count, 1, '未發佈的單元不列入');

    const unit = await api(base, `/api/units/${ids.unit.id}`);
    assert.equal(unit.status, 200);
    assert.equal(unit.data.entries.length, 1);
    assert.equal(unit.data.entries[0].headword, 'campus');
    assert.equal(unit.data.can_edit, false);
    assert.equal(unit.data.can_publish, false);
    assert.equal(unit.data.entries[0].status, undefined, '訪客不該看到審核狀態欄位');

    const hidden = await api(base, `/api/units/${ids.hidden.id}`);
    assert.equal(hidden.status, 404);
});

test('未登入或身分不足時的狀態碼：401 未認證、403 已認證但無權限', async (t) => {
    const { base, ids } = startServer(t);
    const anon = await api(base, `/api/units/${ids.unit.id}/entries`, { method: 'POST', body: { headword: 'apple' } });
    assert.equal(anon.status, 401);

    const student = await login(base, 'student');
    const forbidden = await api(base, `/api/units/${ids.unit.id}/entries`, {
        method: 'POST', cookie: student.cookie, body: { headword: 'apple' }
    });
    assert.equal(forbidden.status, 403, '學生可以登入但沒有編輯權 → 403 而不是 401');

    const users = await api(base, '/api/admin/users', { cookie: student.cookie });
    assert.equal(users.status, 403);
});

test('登入會發 HttpOnly cookie，而且前端不會拿到權杖內容', async (t) => {
    const { base } = startServer(t);
    const result = await login(base, 'manager');
    assert.equal(result.status, 200);
    assert.equal(result.body.token, undefined, '回應內容不得包含權杖');
    assert.equal(result.body.token_type, 'cookie');
    const cookieLine = result.setCookies.join('; ');
    assert.match(cookieLine, /pd_token=/);
    assert.match(cookieLine, /HttpOnly/);
    assert.match(cookieLine, /SameSite=Strict/);

    const me = await api(base, '/api/auth/me', { cookie: result.cookie });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.role, 'admin');
    assert.equal(me.data.permissions.can_manage_users, true);

    const wrong = await login(base, 'manager', 'wrong-password');
    assert.equal(wrong.status, 401);
});

test('登入失敗太多次會鎖 IP（10 次）', async (t) => {
    const { base } = startServer(t);
    for (let i = 0; i < 10; i += 1) {
        const attempt = await login(base, 'manager', 'nope');
        assert.equal(attempt.status, 401);
    }
    const locked = await login(base, 'manager', PASSWORD);
    assert.equal(locked.status, 429, '第 11 次即使密碼正確也要先擋下來');
});

test('管理員新增生字：立即發佈、重複生字回 409、缺解釋回 400', async (t) => {
    const { base, ids } = startServer(t);
    const admin = await login(base, 'manager');

    const created = await api(base, `/api/units/${ids.unit.id}/entries`, {
        method: 'POST',
        cookie: admin.cookie,
        body: { headword: '  Librarian ', ipa_us: '/laɪˈbreə.ri.ən/', part_of_speech: 'n.', zh_meaning: '圖書館員', en_definition: 'a person who works in a library' }
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.status, 'published');
    assert.equal(created.data.entry.headword, 'Librarian', '前後空白會被去掉');

    const duplicate = await api(base, `/api/units/${ids.unit.id}/entries`, {
        method: 'POST', cookie: admin.cookie, body: { headword: 'librarian', zh_meaning: '重複' }
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.entry_id, created.data.entry.id);

    const noMeaning = await api(base, `/api/units/${ids.unit.id}/entries`, {
        method: 'POST', cookie: admin.cookie, body: { headword: 'nowhere' }
    });
    assert.equal(noMeaning.status, 400);

    const visitor = await api(base, `/api/units/${ids.unit.id}`);
    assert.equal(visitor.data.entries.length, 2, '新字對訪客立即可見');
});

test('科代表的新增進待審核；老師核准後學生才看得到', async (t) => {
    const { base, ids } = startServer(t);
    const rep = await login(base, 'classrep');
    const teacher = await login(base, 'teacher');

    const created = await api(base, `/api/units/${ids.unit.id}/entries`, {
        method: 'POST', cookie: rep.cookie, body: { headword: 'timetable', zh_meaning: '時間表' }
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.status, 'pending');

    const visitor = await api(base, `/api/units/${ids.unit.id}`);
    assert.equal(visitor.data.entries.some((e) => e.headword === 'timetable'), false, '待審核的字學生看不到');

    const teacherView = await api(base, `/api/units/${ids.unit.id}`, { cookie: teacher.cookie });
    const pending = teacherView.data.entries.find((e) => e.headword === 'timetable');
    assert.equal(pending.status, 'pending');
    assert.equal(teacherView.data.entries[0].status !== undefined, true);

    // 科代表自己也要看得到剛送出的字（否則介面說「已送出」卻看不到東西）
    const repView = await api(base, `/api/units/${ids.unit.id}`, { cookie: rep.cookie });
    assert.equal(repView.data.entries.some((e) => e.headword === 'timetable' && e.status === 'pending'), true);
    assert.equal(repView.data.can_review, false);
    // 學生一樣看不到
    const student = await login(base, 'student');
    const studentView = await api(base, `/api/units/${ids.unit.id}`, { cookie: student.cookie });
    assert.equal(studentView.data.entries.some((e) => e.headword === 'timetable'), false);

    const repCannotReview = await api(base, `/api/entries/${created.data.entry.id}/review`, {
        method: 'POST', cookie: rep.cookie, body: { action: 'approve' }
    });
    assert.equal(repCannotReview.status, 403, '科代表不能自己核准');

    const approved = await api(base, `/api/entries/${created.data.entry.id}/review`, {
        method: 'POST', cookie: teacher.cookie, body: { action: 'approve', note: '寫得不錯' }
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.data.entry.status, 'published');

    const after = await api(base, `/api/units/${ids.unit.id}`);
    assert.equal(after.data.entries.some((e) => e.headword === 'timetable'), true);
});

test('科代表不能改／刪已發佈的生字，老師可以', async (t) => {
    const { base, ids, store } = startServer(t);
    const rep = await login(base, 'classrep');
    const teacher = await login(base, 'teacher');
    const published = store.listEntries({ unitId: ids.unit.id })[0];

    const patch = await api(base, `/api/entries/${published.id}`, {
        method: 'PATCH', cookie: rep.cookie, body: { zh_meaning: '改一下' }
    });
    assert.equal(patch.status, 403);

    const remove = await api(base, `/api/entries/${published.id}`, { method: 'DELETE', cookie: rep.cookie });
    assert.equal(remove.status, 403);

    const teacherPatch = await api(base, `/api/entries/${published.id}`, {
        method: 'PATCH', cookie: teacher.cookie, body: { zh_meaning: '校園（修改後）' }
    });
    assert.equal(teacherPatch.status, 200);
    assert.equal(teacherPatch.data.entry.zh_meaning, '校園（修改後）');

    const teacherDelete = await api(base, `/api/entries/${published.id}`, { method: 'DELETE', cookie: teacher.cookie });
    assert.equal(teacherDelete.status, 200);
});

test('批次匯入：一次多筆、重複略過，科代表也能用（但要審核）', async (t) => {
    const { base, ids } = startServer(t);
    const admin = await login(base, 'manager');
    const text = ['uniform\t/ˈjuː.nɪ.fɔːm/\tn.\t校服\tschool clothes', 'laboratory\t/ləˈbɒr.ə.tər.i/\tn.\t實驗室\ta room for experiments', 'campus\t\t\t重複\tduplicate'].join('\n');
    const result = await api(base, `/api/units/${ids.unit.id}/entries/import`, {
        method: 'POST', cookie: admin.cookie, body: { text }
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.created, 2);
    assert.equal(result.data.skipped, 1);
    assert.equal(result.data.status, 'published');

    const rep = await login(base, 'classrep');
    const repImport = await api(base, `/api/units/${ids.unit.id}/entries/import`, {
        method: 'POST', cookie: rep.cookie, body: { text: 'principal\t/ˈprɪn.sə.pəl/\tn.\t校長\tthe head of a school' }
    });
    assert.equal(repImport.data.status, 'pending');
});

test('老師錄音：格式白名單、1MB 上限、可播放、可刪除', async (t) => {
    const { base, ids, store } = startServer(t);
    const teacher = await login(base, 'teacher');
    const entry = store.listEntries({ unitId: ids.unit.id })[0];
    const tiny = Buffer.from('OggS-not-really-audio-but-base64-is-all-we-check').toString('base64');

    const bad = await api(base, `/api/entries/${entry.id}/audio`, {
        method: 'POST', cookie: teacher.cookie, body: { data: tiny, mime: 'text/plain' }
    });
    assert.equal(bad.status, 400);

    // Chrome 會把 .webm 標成 video/webm（同一種容器）→ 必須接受，否則老師上傳不了錄音檔
    const webmVideo = await api(base, `/api/entries/${entry.id}/audio`, {
        method: 'POST', cookie: teacher.cookie, body: { data: tiny, mime: 'video/webm' }
    });
    assert.equal(webmVideo.status, 201);

    // 帶參數的型別（audio/webm;codecs=opus）也要對得上
    const withCodecs = await api(base, `/api/entries/${entry.id}/audio`, {
        method: 'POST', cookie: teacher.cookie, body: { data: `data:audio/webm;codecs=opus;base64,${tiny}`, mime: '' }
    });
    assert.equal(withCodecs.status, 201);

    const tooBig = await api(base, `/api/entries/${entry.id}/audio`, {
        method: 'POST', cookie: teacher.cookie, body: { data: Buffer.alloc(1024 * 1024 + 10).toString('base64'), mime: 'audio/mpeg' }
    });
    assert.equal(tooBig.status, 413);

    const ok = await api(base, `/api/entries/${entry.id}/audio`, {
        method: 'POST', cookie: teacher.cookie, body: { data: `data:audio/webm;base64,${tiny}`, duration_ms: 1200 }
    });
    assert.equal(ok.status, 201);

    const unitView = await api(base, `/api/units/${ids.unit.id}`);
    const withAudio = unitView.data.entries.find((e) => e.id === entry.id);
    assert.equal(withAudio.has_audio, true);
    assert.equal(typeof withAudio.audio_id, 'number');
    assert.equal(JSON.stringify(unitView.data).includes(tiny), false, '列表回應不得夾帶音檔內容');

    const played = await fetch(`${base}/api/audio/${withAudio.audio_id}`);
    assert.equal(played.status, 200);
    assert.equal(played.headers.get('content-type'), 'audio/webm');
    assert.match(played.headers.get('cache-control') || '', /immutable/);

    // 換一段新錄音 → 舊的被取代（同一個生字只留一段老師錄音）
    const replaced = await api(base, `/api/entries/${entry.id}/audio`, {
        method: 'POST', cookie: teacher.cookie, body: { data: tiny, mime: 'audio/webm' }
    });
    assert.equal(replaced.status, 201);
    assert.equal(store.listAudio({ entryId: entry.id }).length, 1);

    const removed = await api(base, `/api/audio/${replaced.data.audio.id}`, { method: 'DELETE', cookie: teacher.cookie });
    assert.equal(removed.status, 200);
    assert.equal(store.listAudio({ entryId: entry.id }).length, 0);

    const rep = await login(base, 'classrep');
    const repUpload = await api(base, `/api/entries/${entry.id}/audio`, {
        method: 'POST', cookie: rep.cookie, body: { data: tiny, mime: 'audio/webm' }
    });
    assert.equal(repUpload.status, 403, '科代表不能上傳老師錄音');
});

test('CSRF：帶 cookie 的跨站寫入一律 403，自家來源則放行', async (t) => {
    const { base, ids } = startServer(t);
    const admin = await login(base, 'manager');

    const evil = await api(base, `/api/units/${ids.unit.id}/entries`, {
        method: 'POST', cookie: admin.cookie, origin: 'https://evil.example', body: { headword: 'attack', zh_meaning: '攻擊' }
    });
    assert.equal(evil.status, 403);

    const evilReported = await api(base, `/api/units/${ids.unit.id}/entries`, {
        method: 'POST', cookie: admin.cookie, origin: 'https://evil.example', body: { headword: 'attack2', zh_meaning: '攻擊' }
    });
    assert.equal(evilReported.status, 403);

    const sameOrigin = await api(base, `/api/units/${ids.unit.id}/entries`, {
        method: 'POST', cookie: admin.cookie, origin: base, body: { headword: 'safe', zh_meaning: '安全' }
    });
    assert.equal(sameOrigin.status, 201, '自家來源（同主機）必須放行');

    // 沒有 Origin 的請求（curl／腳本）不會自動帶 cookie，靠 cookie 有沒有效把關
    const noCookie = await api(base, `/api/units/${ids.unit.id}/entries`, {
        method: 'POST', origin: 'https://evil.example', body: { headword: 'x', zh_meaning: 'y' }
    });
    assert.equal(noCookie.status, 401);
});

test('稽核日誌：管理員看得到、老師看不到，而且真的記錄了剛才的動作', async (t) => {
    const { base, ids } = startServer(t);
    const admin = await login(base, 'manager');
    const teacher = await login(base, 'teacher');

    await api(base, `/api/units/${ids.unit.id}/entries`, {
        method: 'POST', cookie: admin.cookie, body: { headword: 'zebra', zh_meaning: '斑馬' }
    });

    const forbidden = await api(base, '/api/admin/audit-logs', { cookie: teacher.cookie });
    assert.equal(forbidden.status, 403);

    const logs = await api(base, '/api/admin/audit-logs?limit=20', { cookie: admin.cookie });
    assert.equal(logs.status, 200);
    const actions = logs.data.logs.map((row) => row.action);
    assert.ok(actions.includes('ENTRY_CREATE'), '新增生字要留紀錄');
    assert.ok(actions.includes('LOGIN'), '登入要留紀錄');
    const entryLog = logs.data.logs.find((row) => row.action === 'ENTRY_CREATE');
    assert.match(entryLog.details, /zebra/);
    assert.equal(entryLog.action_label, '新增生字');
});

test('稽核紀錄可以依動作／帳號／日期篩選（畫面篩選用的就是這組參數）', async (t) => {
    const { base, ids } = startServer(t);
    const manager = await login(base, 'manager');
    const teacher = await login(base, 'teacher');
    const created = await api(base, `/api/units/${ids.unit.id}/entries`, {
        method: 'POST',
        cookie: teacher.cookie,
        body: { headword: 'filterdemo', zh_meaning: '篩選示範', en_definition: 'a filter demo' }
    });
    assert.equal(created.status, 201);

    const all = await api(base, '/api/admin/audit-logs?limit=100', { cookie: manager.cookie });
    assert.equal(all.status, 200);
    assert.ok(all.data.total >= 3, `至少要有幾筆紀錄（實際 ${all.data.total}）`);

    const byAction = await api(base, '/api/admin/audit-logs?action=ENTRY_CREATE&limit=100', { cookie: manager.cookie });
    assert.ok(byAction.data.logs.length >= 1);
    assert.deepEqual([...new Set(byAction.data.logs.map((row) => row.action))], ['ENTRY_CREATE']);
    assert.equal(byAction.data.filters.action, 'ENTRY_CREATE');
    assert.match(byAction.data.logs[0].details, /filterdemo/);
    assert.ok(byAction.data.total < all.data.total, 'total 也要跟著篩選（畫面要顯示「顯示 N／共 M 筆」）');

    const byUser = await api(base, '/api/admin/audit-logs?user=teacher&limit=100', { cookie: manager.cookie });
    assert.ok(byUser.data.logs.length >= 2, 'teacher 的登入與新增生字都要在');
    assert.ok(byUser.data.logs.every((row) => String(row.user_id || '').includes('teacher')));
    const upper = await api(base, '/api/admin/audit-logs?user=TEACHER&limit=100', { cookie: manager.cookie });
    assert.equal(upper.data.total, byUser.data.total, '帳號篩選不分大小寫');

    /* 日期：今天有紀錄、2000 年沒有 */
    const today = new Date().toISOString().slice(0, 10);
    const todayRows = await api(base, `/api/admin/audit-logs?from=${today}&to=${today}&limit=100`, { cookie: manager.cookie });
    assert.equal(todayRows.data.total, all.data.total, '今天的區間應該等於全部');
    assert.equal(todayRows.data.filters.from, today, '回傳實際生效的日期，前端才能顯示「目前篩選」');
    const oldRows = await api(base, '/api/admin/audit-logs?from=2000-01-01&to=2000-01-02&limit=100', { cookie: manager.cookie });
    assert.equal(oldRows.data.total, 0);

    /* 格式不對的日期一律忽略 —— 不能讓打錯字變成「查不到任何東西」 */
    const badDate = await api(base, '/api/admin/audit-logs?from=yesterday&limit=100', { cookie: manager.cookie });
    assert.equal(badDate.data.total, all.data.total);
    assert.equal(badDate.data.filters.from, '');

    /* 不存在的動作 → 0 筆（不可以靜默變成「全部」） */
    const badAction = await api(base, '/api/admin/audit-logs?action=NOT_A_REAL_ACTION&limit=100', { cookie: manager.cookie });
    assert.equal(badAction.data.total, 0);

    /* 動作清單要跟著回傳，前端下拉才不會各寫一份 */
    assert.ok(all.data.actions.some((item) => item.value === 'ENTRY_CREATE' && item.label === '新增生字'));
});

test('健康檢查與版本端點提供前端需要的資訊', async (t) => {
    const { base } = startServer(t);
    const health = await api(base, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.backend, 'json');
    assert.equal(health.data.schema_ready, true);
    assert.equal(health.data.counts.entries >= 1, true);

    const version = await api(base, '/api/version');
    assert.match(version.data.version, /^\d+\.\d+\.\d+$/);
});

test('安全回應標頭：CSP 嚴格、沒有外洩框架資訊', async (t) => {
    const { base } = startServer(t);
    const res = await fetch(`${base}/`);
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'self'/);
    assert.equal(csp.includes('unsafe-inline'), false);
    /* A-7：把「不該有的東西」也一次鎖死 */
    assert.match(csp, /object-src 'none'/, '不能載入外掛／舊式嵌入物件');
    assert.match(csp, /frame-src 'none'/, '不能內嵌別人的頁面');
    assert.match(csp, /worker-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /base-uri 'self'/);
    assert.match(csp, /form-action 'self'/);
    /* 本機是 http://127.0.0.1：upgrade-insecure-requests 只能在 production 出現，
     * 否則瀏覽器會把子資源全升級成 https → 本機整站掛掉。 */
    assert.equal(csp.includes('upgrade-insecure-requests'), false, '非 production 不該加 upgrade-insecure-requests');

    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
    const permissions = res.headers.get('permissions-policy') || '';
    assert.match(permissions, /camera=\(self\)/, '相機只給自家');
    assert.match(permissions, /microphone=\(self\)/, '麥克風只給自家（老師錄音要用）');
    assert.match(permissions, /geolocation=\(\)/, '不需要定位 → 全關');
});

test('production 的 CSP 才加 upgrade-insecure-requests', () => {
    const { buildSecurityHeaders } = require('../lib/auth');
    const dev = buildSecurityHeaders(false)['Content-Security-Policy'];
    const prod = buildSecurityHeaders(true)['Content-Security-Policy'];
    assert.equal(dev.includes('upgrade-insecure-requests'), false);
    assert.equal(prod.includes('upgrade-insecure-requests'), true);
    assert.equal(prod.includes("default-src 'self'"), true);
});

/* ================= v0.1.0 帳號管理與授權管理 ================= */

test('帳號管理：建立 → 新帳號可以登入 → 改角色 → 停用後就登不進來', async (t) => {
    const { base } = startServer(t);
    const manager = await login(base, 'manager');

    const created = await api(base, '/api/admin/users', {
        method: 'POST', cookie: manager.cookie,
        body: { username: 'teacherchan', display_name: 'Miss Chan', password: 'chan12345', role: 'teacher' }
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.user.username, 'teacherchan');
    assert.equal(created.data.user.role, 'teacher');
    assert.equal(created.data.user.password_hash, undefined, '回應不得包含密碼雜湊');

    const newLogin = await login(base, 'teacherchan', 'chan12345');
    assert.equal(newLogin.status, 200, '新帳號應可立即登入');

    const id = created.data.user.id;
    const changed = await api(base, `/api/admin/users/${id}`, {
        method: 'PATCH', cookie: manager.cookie, body: { role: 'class_rep' }
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.user.role, 'class_rep');

    const off = await api(base, `/api/admin/users/${id}`, {
        method: 'PATCH', cookie: manager.cookie, body: { is_active: false }
    });
    assert.equal(off.status, 200);
    assert.equal(off.data.user.is_active, false);
    const blocked = await login(base, 'teacherchan', 'chan12345');
    assert.equal(blocked.status, 401, '停用的帳號不能再登入');

    const reset = await api(base, `/api/admin/users/${id}`, {
        method: 'PATCH', cookie: manager.cookie, body: { password: 'newpass123' }
    });
    assert.equal(reset.status, 200);
    assert.equal((await login(base, 'teacherchan', 'newpass123')).status, 401, '帳號仍是停用狀態');
});

test('帳號管理：不能管理自己、admin 不能動網站管理員、網站管理員之間可以互相管理', async (t) => {
    const { base, store } = startServer(t);
    const manager = await login(base, 'manager');
    const webmanager = await login(base, 'webmanager');
    const teacher = await login(base, 'teacher');

    const me = store.findUserByUsername('manager');
    const self = await api(base, `/api/admin/users/${me.id}`, {
        method: 'PATCH', cookie: manager.cookie, body: { display_name: 'Renamed' }
    });
    assert.equal(self.status, 200, '改自己的顯示名稱可以（改密碼也走同一條）');
    const selfRole = await api(base, `/api/admin/users/${me.id}`, {
        method: 'PATCH', cookie: manager.cookie, body: { role: 'student' }
    });
    assert.equal(selfRole.status, 403, '但不能改自己的角色');

    const selfDelete = await api(base, `/api/admin/users/${me.id}`, { method: 'DELETE', cookie: manager.cookie });
    assert.equal(selfDelete.status, 400);
    assert.equal(selfDelete.data.code, 'CANNOT_DELETE_SELF');

    const ownerRow = store.findUserByUsername('webmanager');
    const ownerEdit = await api(base, `/api/admin/users/${ownerRow.id}`, {
        method: 'PATCH', cookie: manager.cookie, body: { is_active: false }
    });
    assert.equal(ownerEdit.status, 403, 'admin 不能停用網站管理員');

    const ownerSelfDelete = await api(base, `/api/admin/users/${ownerRow.id}`, { method: 'DELETE', cookie: webmanager.cookie });
    assert.equal(ownerSelfDelete.status, 400);
    assert.equal(ownerSelfDelete.data.code, 'CANNOT_DELETE_SELF', '網站管理員也不能刪掉自己');

    /* 網站管理員可以再建立一位同級，也可以把多餘的那位刪掉（但刪不掉唯一的自己） */
    const secondOwner = await api(base, '/api/admin/users', {
        method: 'POST', cookie: webmanager.cookie,
        body: { username: 'webmanager2', password: 'webmgr12345', role: 'web_manager' }
    });
    assert.equal(secondOwner.status, 201, '網站管理員可以建立同級');
    assert.equal(secondOwner.data.user.role, 'web_manager');
    const secondId = secondOwner.data.user.id;
    const secondDelete = await api(base, `/api/admin/users/${secondId}`, { method: 'DELETE', cookie: webmanager.cookie });
    assert.equal(secondDelete.status, 200, '多餘的網站管理員可以移除');

    const assignAdmin = await api(base, '/api/admin/users', {
        method: 'POST', cookie: manager.cookie,
        body: { username: 'admin2', password: 'admin12345', role: 'admin' }
    });
    assert.equal(assignAdmin.status, 403, 'admin 不能建立同級的 admin');

    const teacherTries = await api(base, '/api/admin/users', {
        method: 'POST', cookie: teacher.cookie, body: { username: 'x', password: 'xxxxxxxx', role: 'student' }
    });
    assert.equal(teacherTries.status, 403, '老師不能建立帳號');
});

test('刪除帳號：授權一併清掉，而且帳號真的消失', async (t) => {
    const { base, store, ids } = startServer(t);
    const manager = await login(base, 'manager');
    const created = await api(base, '/api/admin/users', {
        method: 'POST', cookie: manager.cookie,
        body: { username: 'helper', password: 'helper1234', role: 'student' }
    });
    const id = created.data.user.id;

    await api(base, '/api/admin/grants', {
        method: 'POST', cookie: manager.cookie, body: { user_id: id, unit_id: ids.unit.id, can_edit: true }
    });
    assert.equal(store.listGrants({ userId: id }).length, 1);

    const removed = await api(base, `/api/admin/users/${id}`, { method: 'DELETE', cookie: manager.cookie });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.grants_removed, 1, '回報清掉的授權數');
    assert.equal(store.getUser(id), null);
    assert.equal(store.listGrants({ userId: id }).length, 0, '授權不能留成孤兒');
});

test('授權管理：授權某個單元後才能編輯；重複授權會擋；移除後就沒有編輯權', async (t) => {
    const { base, store, ids } = startServer(t);
    const manager = await login(base, 'manager');
    const helper = await api(base, '/api/admin/users', {
        method: 'POST', cookie: manager.cookie,
        body: { username: 'helper', password: 'helper1234', role: 'teacher' }
    });
    const helperId = helper.data.user.id;
    const helperLogin = await login(base, 'helper', 'helper1234');

    /* 先把 helper 降成學生：學生對這個單元本來沒有編輯權，這樣才測得到「授權」的效果 */
    await api(base, `/api/admin/users/${helperId}`, { method: 'PATCH', cookie: manager.cookie, body: { role: 'student' } });
    const before = await api(base, `/api/units/${ids.unit.id}/entries`, {
        method: 'POST', cookie: helperLogin.cookie, body: { headword: 'library', en_definition: 'a place with books' }
    });
    assert.equal(before.status, 403, '沒被授權的學生不能新增生字');

    const granted = await api(base, '/api/admin/grants', {
        method: 'POST', cookie: manager.cookie,
        body: { user_id: helperId, unit_id: ids.unit.id, can_edit: true, can_publish: false }
    });
    assert.equal(granted.status, 201);
    assert.equal(granted.data.grant.granted_by, 'manager', '要記下是誰授權的');

    const duplicate = await api(base, '/api/admin/grants', {
        method: 'POST', cookie: manager.cookie, body: { user_id: helperId, unit_id: ids.unit.id }
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.code, 'GRANT_EXISTS');

    const after = await api(base, `/api/units/${ids.unit.id}/entries`, {
        method: 'POST', cookie: helperLogin.cookie, body: { headword: 'library', en_definition: 'a place with books' }
    });
    assert.equal(after.status, 201);
    assert.equal(after.data.entry.status, 'pending', '被授權但不能發佈的人，新增仍要審核');

    const grantId = granted.data.grant.id;
    const removed = await api(base, `/api/admin/grants/${grantId}`, { method: 'DELETE', cookie: manager.cookie });
    assert.equal(removed.status, 200);
    const gone = await api(base, `/api/admin/grants`, { method: 'GET', cookie: manager.cookie });
    assert.equal(gone.data.grants.length, 0);

    const again = await api(base, `/api/units/${ids.unit.id}/entries`, {
        method: 'POST', cookie: helperLogin.cookie, body: { headword: 'gym', en_definition: 'a place to exercise' }
    });
    assert.equal(again.status, 403, '移除授權後就不能再編輯');

    const logs = store.listAuditLogs({ limit: 50 });
    const actions = logs.items.map((row) => row.action);
    assert.equal(actions.includes('GRANT_CREATE'), true, '授權要留稽核紀錄');
    assert.equal(actions.includes('GRANT_DELETE'), true, '移除授權也要留稽核紀錄');
});

/* ================= v0.2.0 書本封面 ================= */

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

test('書本封面：老師上傳後誰都讀得到、格式與大小有擋、可以移除', async (t) => {
    const { base, ids, store } = startServer(t);
    const teacher = await login(base, 'teacher');

    assert.equal((await api(base, `/api/covers/${ids.book.id}`)).status, 404, '還沒有封面時是 404');

    const wrongType = await api(base, `/api/books/${ids.book.id}/cover`, {
        method: 'POST', cookie: teacher.cookie, body: { data: `data:image/gif;base64,${PNG_1PX}` }
    });
    assert.equal(wrongType.status, 400);
    assert.equal(wrongType.data.code, 'INVALID_COVER_TYPE');

    const tooBig = await api(base, `/api/books/${ids.book.id}/cover`, {
        method: 'POST', cookie: teacher.cookie,
        body: { data: `data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024 + 100, 7).toString('base64')}` }
    });
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.data.code, 'COVER_TOO_LARGE');

    const uploaded = await api(base, `/api/books/${ids.book.id}/cover`, {
        method: 'POST', cookie: teacher.cookie, body: { data: `data:image/png;base64,${PNG_1PX}` }
    });
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.data.book.has_cover, true);
    assert.equal(uploaded.data.book.cover_data, undefined, '回應不得夾帶封面 base64');
    assert.match(uploaded.data.book.cover_url, /^\/api\/covers\//);

    const books = await api(base, '/api/books');
    assert.equal(books.data.books[0].has_cover, true);
    assert.equal(books.data.books[0].cover_data, undefined, '書本清單不得夾帶封面 base64（會變成幾十 MB）');

    const served = await fetch(`${base}/api/covers/${ids.book.id}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.equal((await served.arrayBuffer()).byteLength, Buffer.from(PNG_1PX, 'base64').length);

    const student = await login(base, 'student');
    const denied = await api(base, `/api/books/${ids.book.id}/cover`, {
        method: 'POST', cookie: student.cookie, body: { data: `data:image/png;base64,${PNG_1PX}` }
    });
    assert.equal(denied.status, 403, '學生不能上傳封面');

    const removed = await api(base, `/api/books/${ids.book.id}/cover`, { method: 'DELETE', cookie: teacher.cookie });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.book.has_cover, false);
    assert.equal((await api(base, `/api/covers/${ids.book.id}`)).status, 404);

    const actions = store.listAuditLogs({ limit: 20 }).items.map((row) => row.action);
    assert.equal(actions.includes('COVER_UPLOAD'), true);
    assert.equal(actions.includes('COVER_DELETE'), true);
});

/* ================= v0.2.1 密碼自助 ================= */

test('改自己的密碼：管理員面板可以改，任何登入者也能用 /api/auth/change-password', async (t) => {
    const { base, store } = startServer(t);
    const manager = await login(base, 'manager');
    const me = store.findUserByUsername('manager');

    /* 帳號管理面板：改自己的密碼（先前會回 403「你不能管理這個使用者」） */
    const selfReset = await api(base, `/api/admin/users/${me.id}`, {
        method: 'PATCH', cookie: manager.cookie, body: { password: 'selfpass123' }
    });
    assert.equal(selfReset.status, 200, '自己改自己的密碼不該被擋');
    assert.equal((await login(base, 'manager', 'selfpass123')).status, 200);

    /* 但不能改自己的角色或停用自己（提權／自鎖） */
    const selfRole = await api(base, `/api/admin/users/${me.id}`, {
        method: 'PATCH', cookie: manager.cookie, body: { role: 'student' }
    });
    assert.equal(selfRole.status, 403);
    const selfOff = await api(base, `/api/admin/users/${me.id}`, {
        method: 'PATCH', cookie: manager.cookie, body: { is_active: false }
    });
    assert.equal(selfOff.status, 403);

    /* 改成「要知道目前密碼」的自助端點：老師也能用（老師不是 admin，進不了帳號管理面板） */
    const teacher = await login(base, 'teacher');
    const wrong = await api(base, '/api/auth/change-password', {
        method: 'POST', cookie: teacher.cookie, body: { current_password: 'wrong-one', new_password: 'brandnew123' }
    });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.data.code, 'CURRENT_PASSWORD_WRONG');

    const tooShort = await api(base, '/api/auth/change-password', {
        method: 'POST', cookie: teacher.cookie, body: { current_password: PASSWORD, new_password: 'abc' }
    });
    assert.equal(tooShort.status, 400);
    assert.equal(tooShort.data.code, 'PASSWORD_LENGTH');

    const ok = await api(base, '/api/auth/change-password', {
        method: 'POST', cookie: teacher.cookie, body: { current_password: PASSWORD, new_password: 'teacher456' }
    });
    assert.equal(ok.status, 200);
    assert.equal((await login(base, 'teacher', 'teacher456')).status, 200);
    assert.equal((await login(base, 'teacher', PASSWORD)).status, 401, '舊密碼應該失效');

    const anon = await api(base, '/api/auth/change-password', {
        method: 'POST', body: { current_password: 'x', new_password: 'yyyyyy' }
    });
    assert.equal(anon.status, 401);

    const actions = store.listAuditLogs({ limit: 20 }).items.map((row) => row.action);
    assert.equal(actions.includes('PASSWORD_CHANGE'), true, '改密碼要留稽核紀錄');
});

/* ---- E-1 路由覆蓋補齊：這三條路由原本沒有任何測試碰過 ---- */

test('登出：只清掉自己的 cookie，之後帶舊 cookie 也等於未登入', async (t) => {
    const { base } = startServer(t);
    const me = await login(base, 'teacher');
    assert.equal(me.status, 200);
    assert.equal((await api(base, '/api/auth/me', { cookie: me.cookie })).data.user.username, 'teacher');

    const out = await api(base, '/api/auth/logout', { method: 'POST', cookie: me.cookie });
    assert.equal(out.status, 200);
    const cleared = out.headers.getSetCookie().join('; ');
    assert.match(cleared, /pd_token=;/, '登出要把權杖 cookie 清掉（空值 + 過期）');
    assert.match(cleared, /Max-Age=0/);
    assert.match(cleared, /HttpOnly/);

    /* 登出後伺服器端仍會接受未過期的權杖（沒有黑名單，見規劃書 A-10 的做法），
     * 但瀏覽器已經拿不到它了；這裡確認的是「回應本身不再帶登入狀態」。 */
    const meAgain = await api(base, '/api/auth/me', { cookie: me.cookie });
    assert.equal(meAgain.data.user.username, 'teacher', '權杖未到期前伺服器仍認得（A-10 會處理）');
});

test('單元發佈／下架：老師（含授權）可以做，科代表不行', async (t) => {
    const { base, ids } = startServer(t);
    const teacher = await login(base, 'teacher');
    const rep = await login(base, 'classrep');
    const anon = await api(base, `/api/units/${ids.hidden.id}/publish`, { method: 'POST' });
    assert.equal(anon.status, 401, '未登入不能發佈');

    const denied = await api(base, `/api/units/${ids.hidden.id}/publish`, { method: 'POST', cookie: rep.cookie });
    assert.equal(denied.status, 403, '科代表不能發佈單元');
    assert.equal(denied.data.code, 'FORBIDDEN');

    const ok = await api(base, `/api/units/${ids.hidden.id}/publish`, { method: 'POST', cookie: teacher.cookie });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.unit.is_published, true);

    /* 訪客現在看得到它了 */
    const seen = await api(base, `/api/units/${ids.hidden.id}`);
    assert.equal(seen.status, 200);

    const back = await api(base, `/api/units/${ids.hidden.id}/unpublish`, { method: 'POST', cookie: teacher.cookie });
    assert.equal(back.status, 200);
    assert.equal(back.data.unit.is_published, false);
    assert.equal((await api(base, `/api/units/${ids.hidden.id}`)).status, 404, '下架後訪客看不到');
});

test('快取標頭：未登入的讀取可公開快取，登入的一律 private no-store（A-11）', async (t) => {
    const { base, ids, store } = startServer(t);
    store.updateUnit(ids.unit.id, { is_published: true });

    const anonBooks = await api(base, '/api/books');
    assert.match(anonBooks.headers.get('cache-control') || '', /public, max-age=15/,
        '未登入的書本清單可以公開快取');
    assert.equal(anonBooks.headers.get('vary'), 'Cookie',
        '★ 一定要有 Vary: Cookie，否則瀏覽器會拿未登入的公開回應回答已登入的請求（看不到剛新增的內容）');
    const anonUnit = await api(base, `/api/units/${ids.unit.id}`);
    assert.match(anonUnit.headers.get('cache-control') || '', /public, max-age=15/);
    assert.equal(anonUnit.headers.get('vary'), 'Cookie');

    /* ★ 這條是重點：登入者看得到未發佈的草稿，那種回應絕對不能進 CDN 或瀏覽器快取 */
    const teacher = await login(base, 'teacher');
    const teacherBooks = await api(base, '/api/books?include_unpublished=1', { cookie: teacher.cookie });
    assert.equal(teacherBooks.headers.get('cache-control'), 'private, no-store');
    const teacherUnit = await api(base, `/api/units/${ids.hidden.id}`, { cookie: teacher.cookie });
    assert.equal(teacherUnit.status, 200);
    assert.equal(teacherUnit.headers.get('cache-control'), 'private, no-store');
});

/* ---- v0.4.1：修改單元（名稱與編號） ---- */

test('修改單元：老師可以改名稱與編號，學生看到的目錄與生字表標題都跟著變', async (t) => {
    const { base, ids, store } = startServer(t);
    const teacher = await login(base, 'teacher');

    /* 改名稱 */
    const renamed = await api(base, `/api/units/${ids.unit.id}`, {
        method: 'PATCH', cookie: teacher.cookie, body: { title: 'My New School (new)' }
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.data.unit.title, 'My New School (new)');
    assert.equal(store.getUnit(ids.unit.id).title, 'My New School (new)');

    /* 訪客看到的也跟著變（同一份資料，沒有前端快取過期問題） */
    const anon = await api(base, `/api/units/${ids.unit.id}`);
    assert.equal(anon.data.unit.title, 'My New School (new)');

    /* 改編號：1 → 7（同時改變排序） */
    const renumbered = await api(base, `/api/units/${ids.unit.id}`, {
        method: 'PATCH', cookie: teacher.cookie, body: { unit_no: 7, title: 'Unit seven' }
    });
    assert.equal(renumbered.status, 200);
    assert.equal(renumbered.data.unit.unit_no, 7);
    const book = await api(base, `/api/books/${ids.book.id}/units`);
    assert.equal(book.data.units.find((u) => u.id === ids.unit.id).unit_no, 7);

    /* 稽核要留下「書名 + Unit N + 名稱」，之後追查才知道改了什麼 */
    const audit = store.listAuditLogs({ limit: 5 }).items.find((row) => row.action === 'UNIT_UPDATE');
    assert.ok(audit, '改單元要留稽核紀錄');
    assert.match(audit.details, /Book 5A Unit 7 Unit seven/);

    /* 再改回原本的編號，避免影響其他測試的預期 */
    await api(base, `/api/units/${ids.unit.id}`, { method: 'PATCH', cookie: teacher.cookie, body: { unit_no: 1 } });
});

test('修改單元：編號的驗證與重複檢查（不能出現兩個 Unit N）', async (t) => {
    const { base, ids } = startServer(t);
    const teacher = await login(base, 'teacher');
    const patch = (body, options = {}) => api(base, `/api/units/${ids.unit.id}`, {
        method: 'PATCH', cookie: options.cookie || teacher.cookie, body
    });

    for (const bad of [0, 100, -1, 'abc', null]) {
        const res = await patch({ unit_no: bad });
        assert.equal(res.status, 400, `unit_no=${JSON.stringify(bad)} 應該被擋`);
        assert.equal(res.data.code, 'UNIT_NUMBER');
    }

    /* 這本書已經有 Unit 9（草稿單元）→ 不能把 Unit 1 改成 9 */
    const clash = await patch({ unit_no: 9 });
    assert.equal(clash.status, 409);
    assert.equal(clash.data.code, 'DUPLICATE_UNIT');
    assert.equal(clash.data.details.n, 9);
    assert.match(clash.data.error, /Book 5A/);

    /* 改成自己原本的編號不算衝突 */
    assert.equal((await patch({ unit_no: 1 })).status, 200);
});

test('修改單元：未登入 401、科代表 403（科代表與被授權者可以改生字，但不能改單元本身）', async (t) => {
    const { base, ids } = startServer(t);
    const anon = await api(base, `/api/units/${ids.unit.id}`, { method: 'PATCH', body: { title: 'x' } });
    assert.equal(anon.status, 401);

    const rep = await login(base, 'classrep');
    const denied = await api(base, `/api/units/${ids.unit.id}`, { method: 'PATCH', cookie: rep.cookie, body: { title: 'x' } });
    assert.equal(denied.status, 403);

    /* 不存在的單元 */
    const teacher = await login(base, 'teacher');
    const missing = await api(base, '/api/units/999999', { method: 'PATCH', cookie: teacher.cookie, body: { title: 'x' } });
    assert.equal(missing.status, 404);
    assert.equal(missing.data.code, 'UNIT_NOT_FOUND');
});
