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

const PASSWORD = 'pass123456';

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
    const book = store.createBook({ code: 'B5A', name: 'Book 5A', grade: 'S1', sort_order: 1, is_published: true });
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
    if (options.headers) Object.assign(headers, options.headers);
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
        body: { username: 'teacherchan', display_name: 'Miss Chan', password: 'chan123456', role: 'teacher' }
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.user.username, 'teacherchan');
    assert.equal(created.data.user.role, 'teacher');
    assert.equal(created.data.user.password_hash, undefined, '回應不得包含密碼雜湊');

    const newLogin = await login(base, 'teacherchan', 'chan123456');
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
    const blocked = await login(base, 'teacherchan', 'chan123456');
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
        method: 'POST', cookie: teacher.cookie, body: { username: 'x', password: 'xxxxxxxxxx', role: 'student' }
    });
    assert.equal(teacherTries.status, 403, '老師不能建立帳號');
});

test('刪除帳號：授權一併清掉，而且帳號真的消失', async (t) => {
    const { base, store, ids } = startServer(t);
    const manager = await login(base, 'manager');
    const created = await api(base, '/api/admin/users', {
        method: 'POST', cookie: manager.cookie,
        body: { username: 'helper', password: 'helper12345', role: 'student' }
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
        body: { username: 'helper', password: 'helper12345', role: 'teacher' }
    });
    const helperId = helper.data.user.id;
    const helperLogin = await login(base, 'helper', 'helper12345');

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

/* ================= v0.5.0：封面功能已移除（不再顯示封面，管理區也沒有上傳）
 * 原本的上傳／讀取／移除測試整段刪除；資料表的 cover_* 欄位保留為舊資料欄位。 ================= */

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
    /* ★ 改密碼會換掉工作階段版本（A-10）：回應會帶一張新權杖給自己，後續要用它 */
    const selfCookie = selfReset.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ');
    assert.match(selfCookie, /pd_token=/, '改自己的密碼要順手換新權杖，不然會把自己登出');
    assert.equal((await api(base, '/api/auth/me', { cookie: manager.cookie })).status, 401, '舊權杖要失效');
    assert.equal((await api(base, '/api/auth/me', { cookie: selfCookie })).status, 200, '新權杖要能用');

    /* 但不能改自己的角色或停用自己（提權／自鎖） */
    const selfRole = await api(base, `/api/admin/users/${me.id}`, {
        method: 'PATCH', cookie: selfCookie, body: { role: 'student' }
    });
    assert.equal(selfRole.status, 403);
    const selfOff = await api(base, `/api/admin/users/${me.id}`, {
        method: 'PATCH', cookie: selfCookie, body: { is_active: false }
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
    assert.match(audit.details, /S1 · Unit 7 Unit seven/, audit.details);

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
    assert.match(clash.data.error, /S1/);

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

/* ---- v0.4.2：錯誤日誌、節流、自動化檢查標記 ---- */

const SelfTest = require('../lib/selftest');

test('錯誤日誌：公開回報端點會記錄／空內容被擋／超過節流回 429', async (t) => {
    const { app, base } = startServer(t);

    const empty = await api(base, '/api/logs/error', { method: 'POST', body: {} });
    assert.equal(empty.status, 400);
    assert.equal(empty.data.code, 'ERROR_REPORT_EMPTY');

    const ok = await api(base, '/api/logs/error', {
        method: 'POST',
        body: { code: 'UNCAUGHT_ERROR', message: 'boom', path: '/index.html', version: '0.4.2', context: { line: 3, junk: 'x' } }
    });
    assert.equal(ok.status, 201);
    assert.ok(ok.data.id > 0);

    const rows = await app.locals.errorLog.list({ limit: 5 });
    assert.equal(rows.total, 1, '訪客也能回報（前端出錯時通常還沒登入）');
    assert.equal(rows.rows[0].source, 'client');
    assert.equal(rows.rows[0].resolved, false);
    assert.equal(rows.rows[0].context.line, '3', 'context 只留白名單欄位');

    /* 節流（A-4）：預設 20 次／分鐘，超過一定要擋 */
    let limited = 0;
    for (let i = 0; i < 25; i += 1) {
        const res = await api(base, '/api/logs/error', { method: 'POST', body: { code: 'NOISE', message: `noise ${i}` } });
        if (res.status === 429) limited += 1;
    }
    assert.ok(limited > 0, '被灌的時候一定要擋（429）');
    assert.equal((await app.locals.errorLog.list({ limit: 1 })).total > 0, true);
});

test('錯誤日誌：只有 admin 以上看得到、可以標記已處理（會留稽核）', async (t) => {
    const { app, base } = startServer(t);
    await api(base, '/api/logs/error', { method: 'POST', body: { code: 'BOOM', message: 'something broke' } });

    assert.equal((await api(base, '/api/admin/error-logs')).status, 401);
    const teacher = await login(base, 'teacher');
    assert.equal((await api(base, '/api/admin/error-logs', { cookie: teacher.cookie })).status, 403, '老師看不到錯誤紀錄');

    const manager = await login(base, 'manager');
    const list = await api(base, '/api/admin/error-logs', { cookie: manager.cookie });
    assert.equal(list.status, 200);
    assert.equal(list.data.rows.length, 1);
    assert.equal(list.data.open_count, 1);
    assert.equal(list.data.rows[0].code, 'BOOM');

    const id = list.data.rows[0].id;
    const done = await api(base, `/api/admin/error-logs/${id}`, {
        method: 'PATCH', cookie: manager.cookie, body: { resolved: true, note: '已修正' }
    });
    assert.equal(done.status, 200);
    assert.equal(done.data.entry.resolved, true);
    assert.equal(done.data.entry.resolved_note, '已修正');
    assert.equal(app.locals.store.listAuditLogs({ limit: 10 }).items.some((row) => row.action === 'ERROR_LOG_UPDATE'), true,
        '標記已處理要留稽核');

    assert.equal((await api(base, `/api/admin/error-logs/${id}`, { method: 'PATCH', cookie: manager.cookie, body: { resolved: false } })).data.entry.resolved, false);
    const missing = await api(base, '/api/admin/error-logs/99999', { method: 'PATCH', cookie: manager.cookie, body: { resolved: true } });
    assert.equal(missing.status, 404);
    assert.equal(missing.data.code, 'ERROR_LOG_NOT_FOUND');

    /* 篩選：狀態與等級 */
    assert.equal((await api(base, '/api/admin/error-logs?level=warn', { cookie: manager.cookie })).data.rows.length, 0);
    assert.equal((await api(base, '/api/admin/error-logs?source=server', { cookie: manager.cookie })).data.rows.length, 0);
    assert.equal((await api(base, '/api/admin/error-logs?resolved=true', { cookie: manager.cookie })).data.rows.length, 0);
});

test('伺服器 500：錯誤處理會寫進錯誤日誌（畫面只看到英文 code，後台看得到原因）', async (t) => {
    const { app, base } = startServer(t);
    const original = app.locals.store.listBooks;
    app.locals.store.listBooks = () => { throw new Error('boom from the store'); };
    const res = await api(base, '/api/books');
    assert.equal(res.status, 500);
    assert.equal(res.data.code, 'SERVER');
    assert.equal(String(res.data.error).includes('boom'), false, '回應不能把內部細節吐出去');
    app.locals.store.listBooks = original;

    const rows = await app.locals.errorLog.list({ limit: 10 });
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].source, 'server');
    assert.equal(rows.rows[0].code, 'SERVER');
    assert.match(rows.rows[0].message, /boom from the store/);
});

test('自動化檢查的流量（E-4）：稽核標成 is_self_test，預設檢視看不到', async (t) => {
    const { app, base, ids } = startServer(t);
    const teacher = await login(base, 'teacher');
    const secret = process.env.JWT_SECRET;

    /* 真人操作：改單元名稱（沒有帶簽章標頭） */
    await api(base, `/api/units/${ids.unit.id}`, { method: 'PATCH', cookie: teacher.cookie, body: { title: 'Real edit' } });

    /* 自動化檢查：同一件事，但帶了簽章標頭 */
    await api(base, `/api/units/${ids.unit.id}`, {
        method: 'PATCH',
        cookie: teacher.cookie,
        headers: { 'X-PV-Self-Test': SelfTest.makeHeader(secret) },
        body: { title: 'Automated edit' }
    });

    /* 簽錯的標頭 → 一律當成真人操作（不能因為標頭就放行或標記） */
    await api(base, `/api/units/${ids.unit.id}`, {
        method: 'PATCH',
        cookie: teacher.cookie,
        headers: { 'X-PV-Self-Test': '123.deadbeef' },
        body: { title: 'Fake automated edit' }
    });

    const rows = app.locals.store.listAuditLogs({ limit: 20 }).items.filter((row) => row.action === 'UNIT_UPDATE');
    assert.equal(rows.length, 3);
    assert.equal(rows.filter((row) => row.is_self_test === true).length, 1, '只有簽章正確的那一筆要被標記');

    const manager = await login(base, 'manager');
    const hidden = await api(base, '/api/admin/audit-logs', { cookie: manager.cookie });
    assert.equal(hidden.data.logs.some((row) => row.is_self_test === true), false, '預設要把自動化檢查濾掉');
    assert.equal(hidden.data.logs.filter((row) => row.action === 'UNIT_UPDATE').length, 2);
    assert.equal(hidden.data.filters.hide_self_test, true);

    const shown = await api(base, '/api/admin/audit-logs?hide_self_test=0', { cookie: manager.cookie });
    assert.equal(shown.data.logs.some((row) => row.is_self_test === true), true, '想看就看得到');
    assert.equal(shown.data.filters.hide_self_test, false);
});

/* ---- v0.4.3：兩步驟驗證（A-1）、工作階段版本（A-10）、密碼政策與新裝置（A-8）、帳號救援（C-3） ---- */

const Totp = require('../lib/totp');

function secretKeyOf() {
    return process.env.JWT_SECRET;
}

async function twoFactorLogin(base, username, password = PASSWORD) {
    const first = await login(base, username, password);
    if (first.status !== 200 || !first.body.two_factor_required) return { first, challenge: '' };
    const user = first.body;
    return { first, challenge: user.challenge_token };
}

test('兩步驟驗證（A-1）：設定 → 啟用 → 登入要兩步 → 中間權杖不能拿來用 → 備援碼只能用一次', async (t) => {
    const { app, base, store } = startServer(t);
    const manager = await login(base, 'manager');

    /* 未啟用前：登入只要密碼 */
    const before = await login(base, 'teacher');
    assert.equal(before.status, 200);
    assert.equal(Boolean(before.body.two_factor_required), false);

    /* 老師自己設定 2FA（可選，不強制） */
    const setup = await api(base, '/api/auth/2fa/setup', { method: 'POST', cookie: (await login(base, 'teacher')).cookie });
    assert.equal(setup.status, 200);
    assert.match(setup.data.secret, /^[A-Z2-7]+=*$/);
    assert.match(setup.data.otpauth_url, /^otpauth:\/\/totp\//);
    assert.equal(store.findUserByUsername('teacher').totp_enabled_at || null, null, '還沒驗碼不算啟用');

    /* 錯的碼不能啟用 */
    const wrongEnable = await api(base, '/api/auth/2fa/enable', { method: 'POST', cookie: before.cookie, body: { code: '000000' } });
    assert.equal(wrongEnable.status, 400);
    assert.equal(wrongEnable.data.code, 'TWO_FACTOR_INVALID');

    const secret = setup.data.secret;
    const enabled = await api(base, '/api/auth/2fa/enable', {
        method: 'POST', cookie: before.cookie, body: { code: Totp.codeAt(secret, Date.now() / 1000) }
    });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.data.backup_codes.length, 8, '備援碼只回這一次');
    assert.equal(Array.isArray(store.findUserByUsername('teacher').backup_codes), true);

    /* 密鑰在資料庫裡是密文 */
    const stored = store.findUserByUsername('teacher').totp_secret;
    assert.equal(stored.includes(secret), false, '資料庫不可以存明文密鑰');
    assert.equal(Totp.decryptSecret(stored, secretKeyOf()), secret);

    /* 登入第一步：只回中間權杖，不給 cookie */
    const step1 = await login(base, 'teacher');
    assert.equal(step1.status, 200);
    assert.equal(step1.body.two_factor_required, true);
    assert.equal(step1.cookie, '', '第一步不可以發登入 cookie');
    const challenge = step1.body.challenge_token;

    /* ★ 中間權杖不能當登入憑證用（拿它去呼叫需要登入的端點一律 401） */
    assert.equal((await api(base, '/api/auth/me', { cookie: `pd_token=${challenge}` })).status, 401);
    assert.equal((await api(base, '/api/admin/users', { cookie: `pd_token=${challenge}` })).status, 401);
    assert.equal((await api(base, '/api/auth/2fa/setup', { method: 'POST', cookie: `pd_token=${challenge}` })).status, 401);

    /* 第二步：錯的碼 401、對的碼登入成功 */
    const badCode = await api(base, '/api/auth/login/2fa', { method: 'POST', body: { challenge_token: challenge, code: '000000' } });
    assert.equal(badCode.status, 401);
    assert.equal(badCode.data.code, 'TWO_FACTOR_INVALID');
    const step2 = await api(base, '/api/auth/login/2fa', {
        method: 'POST', body: { challenge_token: challenge, code: Totp.codeAt(secret, Date.now() / 1000) }
    });
    assert.equal(step2.status, 200);
    assert.equal(step2.data.user.username, 'teacher');
    assert.match(step2.headers.getSetCookie().join('; '), /pd_token=/);

    /* 過期／亂改的中間權杖要擋 */
    const shortChallenge = await login(base, 'teacher');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const forged = `${challenge}x`;
    assert.equal((await api(base, '/api/auth/login/2fa', { method: 'POST', body: { challenge_token: forged, code: '123456' } })).status, 400);
    assert.equal((await api(base, '/api/auth/login/2fa', { method: 'POST', body: { challenge_token: 'garbage', code: '123456' } })).status, 400);
    assert.ok(shortChallenge.body.challenge_token);

    /* 備援碼：可以用一次，第二次就不行 */
    const backup = enabled.data.backup_codes[0];
    const byBackup = await api(base, '/api/auth/login/2fa', {
        method: 'POST', body: { challenge_token: challenge, backup_code: backup }
    });
    assert.equal(byBackup.status, 200, '備援碼可以登入');
    const again = await login(base, 'teacher');
    const reused = await api(base, '/api/auth/login/2fa', {
        method: 'POST', body: { challenge_token: again.body.challenge_token, backup_code: backup }
    });
    assert.equal(reused.status, 401, '同一組備援碼不能重複使用');

    /* 6 位碼只有一百萬種：錯太多次要被節流 */
    let limited = false;
    for (let i = 0; i < 12; i += 1) {
        const res = await api(base, '/api/auth/login/2fa', {
            method: 'POST', body: { challenge_token: again.body.challenge_token, code: '111111' }
        });
        if (res.status === 429) limited = true;
    }
    assert.equal(limited, true, '連續錯的驗證碼要被節流');

    /* 使用者自己可以關掉（要目前的密碼） */
    const teacherCookie = step2.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ');
    assert.equal((await api(base, '/api/auth/2fa/disable', { method: 'POST', cookie: teacherCookie, body: { password: 'wrong-pass' } })).status, 400);
    assert.equal((await api(base, '/api/auth/2fa/disable', { method: 'POST', cookie: teacherCookie, body: { password: PASSWORD } })).status, 200);
    assert.equal((await login(base, 'teacher')).body.two_factor_required || false, false, '關掉之後登入回到只要密碼');

    const actions = store.listAuditLogs({ limit: 30 }).items.map((row) => row.action);
    assert.ok(actions.includes('TWO_FA_ENABLE') && actions.includes('TWO_FA_DISABLE'), actions.join(','));
    assert.ok(manager.status === 200);
});

test('工作階段（A-10）：改密碼會登出其他裝置但自己這台還在；web_manager 可以讓某人所有裝置登出', async (t) => {
    const { base, ids, store } = startServer(t);

    /* 同一個老師在兩台裝置登入 */
    const deviceA = await login(base, 'teacher');
    const deviceB = await login(base, 'teacher');
    assert.equal((await api(base, '/api/auth/me', { cookie: deviceB.cookie })).status, 200);

    /* A 改密碼 → B 的權杖立刻失效、A 拿到新權杖繼續用 */
    const changed = await api(base, '/api/auth/change-password', {
        method: 'POST', cookie: deviceA.cookie, body: { current_password: PASSWORD, new_password: 'newteacher123' }
    });
    assert.equal(changed.status, 200);
    const freshCookie = changed.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ');
    assert.equal((await api(base, '/api/auth/me', { cookie: deviceB.cookie })).status, 401, '舊裝置要被登出');
    assert.equal((await api(base, '/api/auth/me', { cookie: freshCookie })).data.user.username, 'teacher', '自己這台換新權杖，不用重新登入');
    assert.equal((await login(base, 'teacher', PASSWORD)).status, 401, '舊密碼失效');
    assert.equal((await login(base, 'teacher', 'newteacher123')).status, 200);

    /* web_manager 一鍵登出某個人的所有裝置 */
    const teacherId = store.findUserByUsername('teacher').id;
    const teacherDevice = await login(base, 'teacher', 'newteacher123');
    const webmanager = await login(base, 'webmanager');
    const admin = await login(base, 'manager');

    /* admin 不行（使用者指定：只有 web_manager 可以） */
    const byAdmin = await api(base, `/api/admin/users/${teacherId}`, {
        method: 'PATCH', cookie: admin.cookie, body: { force_logout: true }
    });
    assert.equal(byAdmin.status, 403);
    assert.equal(byAdmin.data.code, 'FORCE_LOGOUT_FORBIDDEN');

    const byWebManager = await api(base, `/api/admin/users/${teacherId}`, {
        method: 'PATCH', cookie: webmanager.cookie, body: { force_logout: true }
    });
    assert.equal(byWebManager.status, 200);
    assert.equal(byWebManager.data.forced_logout, true);
    assert.equal((await api(base, '/api/auth/me', { cookie: teacherDevice.cookie })).status, 401, '被強制登出');

    /* 一般登出只登出自己那一台（使用者指定） */
    const other = await login(base, 'teacher', 'newteacher123');
    const thisOne = await login(base, 'teacher', 'newteacher123');
    await api(base, '/api/auth/logout', { method: 'POST', cookie: thisOne.cookie });
    assert.equal((await api(base, '/api/auth/me', { cookie: other.cookie })).status, 200, '另一台不受影響');

    const actions = store.listAuditLogs({ limit: 40 }).items.map((row) => row.action);
    assert.ok(actions.includes('USER_FORCE_LOGOUT'), actions.join(','));
    assert.ok(ids);
});

test('密碼政策（A-8）：新設定的密碼最少 10 碼（三個入口都要擋）', async (t) => {
    const { base, store } = startServer(t);
    const manager = await login(base, 'manager');

    const created = await api(base, '/api/admin/users', {
        method: 'POST', cookie: manager.cookie, body: { username: 'shortuser', password: 'ninechars', role: 'teacher' }
    });
    assert.equal(created.status, 400);
    assert.equal(created.data.code, 'PASSWORD_LENGTH');
    assert.equal(String(created.data.error).includes('10'), true, '訊息要說明最少幾碼');

    const teacherId = store.findUserByUsername('teacher').id;
    const patched = await api(base, `/api/admin/users/${teacherId}`, {
        method: 'PATCH', cookie: manager.cookie, body: { password: 'short' }
    });
    assert.equal(patched.status, 400);
    assert.equal(patched.data.code, 'PASSWORD_LENGTH');

    const teacher = await login(base, 'teacher');
    const selfChange = await api(base, '/api/auth/change-password', {
        method: 'POST', cookie: teacher.cookie, body: { current_password: PASSWORD, new_password: 'ninechars' }
    });
    assert.equal(selfChange.status, 400);
    assert.equal(selfChange.data.code, 'PASSWORD_LENGTH');

    /* 剛好 10 碼可以 */
    assert.equal((await api(base, '/api/auth/change-password', {
        method: 'POST', cookie: teacher.cookie, body: { current_password: PASSWORD, new_password: '0123456789' }
    })).status, 200);

    /* ★ 訊息要帶 {min} 的值：前端是用 details 當插值變數，
     *   少了它中文會變成「密碼長度必須是 –64 個字元」（使用者回報） */
    const missingMin = await api(base, '/api/admin/users', {
        method: 'POST', cookie: manager.cookie, body: { username: 'shortuser2', password: 'short', role: 'teacher' }
    });
    assert.equal(missingMin.data.details.min, 10, 'details 要帶 min 讓前端插值');
    assert.equal(missingMin.data.error.includes('10'), true);
});

test('新裝置登入（A-8）：來源不同會單獨留一筆稽核並在回應標記', async (t) => {
    const { app, base, store } = startServer(t);
    const first = await login(base, 'teacher');
    assert.equal(first.body.new_device || false, false, '第一次登入沒有「上次」可比，不算新裝置');

    /* 換一個瀏覽器字串 = 不同裝置 */
    const second = await api(base, '/api/auth/login', {
        method: 'POST',
        headers: { 'User-Agent': 'AnotherBrowser/1.0' },
        body: { username: 'teacher', password: PASSWORD }
    });
    assert.equal(second.status, 200);
    assert.equal(second.data.new_device, true);

    const rows = store.listAuditLogs({ limit: 20 }).items.filter((row) => row.action === 'LOGIN_NEW_DEVICE');
    assert.equal(rows.length, 1);
    assert.match(rows[0].details, /新裝置登入/);
    assert.equal(store.findUserByUsername('teacher').last_login_agent, 'AnotherBrowser/1.0');
});

test('錯誤日誌（同類一次處理）：同 code+message 的未處理紀錄一次清掉，會留稽核', async (t) => {
    const { app, base, store } = startServer(t);
    for (let i = 0; i < 3; i += 1) {
        await api(base, '/api/logs/error', { method: 'POST', body: { code: 'CSP_VIOLATION', message: 'style-src-elem blocked inline', path: '/' } });
    }
    await api(base, '/api/logs/error', { method: 'POST', body: { code: 'OTHER', message: 'something else' } });

    const manager = await login(base, 'manager');
    assert.equal((await api(base, '/api/admin/error-logs/resolve-similar', { method: 'POST' })).status, 401);
    const teacher = await login(base, 'teacher');
    assert.equal((await api(base, '/api/admin/error-logs/resolve-similar', {
        method: 'POST', cookie: teacher.cookie, body: { code: 'CSP_VIOLATION', message: 'x' }
    })).status, 403);

    const done = await api(base, '/api/admin/error-logs/resolve-similar', {
        method: 'POST', cookie: manager.cookie, body: { code: 'CSP_VIOLATION', message: 'style-src-elem blocked inline' }
    });
    assert.equal(done.status, 200);
    assert.equal(done.data.resolved, 3, '同類的三筆要一次處理掉');
    const left = await app.locals.errorLog.list({ resolved: 'false' });
    assert.equal(left.rows.length, 1, '不同類的那一筆要留著');
    assert.equal(left.rows[0].code, 'OTHER');
    assert.ok(store.listAuditLogs({ limit: 10 }).items.some((row) => row.action === 'ERROR_LOG_RESOLVE_SIMILAR'));
    const empty = await api(base, '/api/admin/error-logs/resolve-similar', { method: 'POST', cookie: manager.cookie, body: {} });
    assert.equal(empty.status, 400);
});

test('匯入（B-3）：前端解析好的列可以直接匯入（CSV／.xlsx 走這條）', async (t) => {
    const { base, ids, store } = startServer(t);
    const teacher = await login(base, 'teacher');
    const before = store.countEntries(ids.unit.id, null);

    const res = await api(base, `/api/units/${ids.unit.id}/entries/import`, {
        method: 'POST', cookie: teacher.cookie,
        body: {
            source: 'file',
            rows: [
                { headword: 'library', ipa_us: '/ˈlaɪ.brer.i/', part_of_speech: 'n.', zh_meaning: '圖書館', en_definition: 'a place with books' },
                { headword: 'playground', zh_meaning: '操場' },
                { headword: '', zh_meaning: '沒有生字，整列都要被忽略' },
                { headword: 'campus', zh_meaning: '這個單元已經有了' },
                { headword: 'x'.repeat(200), zh_meaning: '太長會被截斷' }
            ]
        }
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.created, 3, '三筆是新的（含超長被截斷的那一筆）');
    assert.equal(res.data.skipped, 1, '重複的那一筆要略過');
    assert.equal(store.countEntries(ids.unit.id, null), before + 3);

    const imported = store.findEntryByHeadword(ids.unit.id, 'library');
    assert.ok(imported, '要真的寫進資料庫');
    assert.equal(imported.status, 'published', '老師匯入＝直接發佈');
    assert.equal(imported.zh_meaning, '圖書館');
    const truncated = store.listEntries({ unitId: ids.unit.id }).find((entry) => entry.headword.length > 60);
    assert.ok(truncated && truncated.headword.length <= 100, '超長的生字要截斷，不能整串塞進來');

    /* 稽核要記「從檔案匯入」（跟貼上的動作分開，才知道老師是用哪一種） */
    const actions = store.listAuditLogs({ limit: 20 }).items.map((row) => row.action);
    assert.ok(actions.includes('ENTRY_IMPORT_FILE'), actions.join(','));

    /* 科代表用同一條路徑匯入 → 進待審核 */
    const rep = await login(base, 'classrep');
    const repRes = await api(base, `/api/units/${ids.unit.id}/entries/import`, {
        method: 'POST', cookie: rep.cookie,
        body: { source: 'file', rows: [{ headword: 'canteen', zh_meaning: '飯堂' }] }
    });
    assert.equal(repRes.data.status, 'pending');
    assert.equal(store.findEntryByHeadword(ids.unit.id, 'canteen').status, 'pending');

    /* 沒有編輯權的人（學生）不行 */
    const student = await login(base, 'student');
    assert.equal((await api(base, `/api/units/${ids.unit.id}/entries/import`, {
        method: 'POST', cookie: student.cookie, body: { rows: [{ headword: 'nope' }] }
    })).status, 403);
});

test('複製單元（B-4）：生字一起複製、不含錄音、新單元排在最後且預設不發佈', async (t) => {
    const { base, ids, store } = startServer(t);
    const teacher = await login(base, 'teacher');
    const student = await login(base, 'student');

    /* 先在原單元放一筆錄音，確認複製出來的單元不會帶錄音 */
    const entry = store.listEntries({ unitId: ids.unit.id })[0];
    store.createAudio({ entry_id: entry.id, source: 'teacher', mime: 'audio/webm', bytes: 4, data: 'AAAA' });

    assert.equal((await api(base, `/api/units/${ids.unit.id}/duplicate`, { method: 'POST', cookie: student.cookie, body: {} })).status, 403);

    const res = await api(base, `/api/units/${ids.unit.id}/duplicate`, { method: 'POST', cookie: teacher.cookie, body: { title: 'My New School (copy)' } });
    assert.equal(res.status, 200);
    assert.equal(res.data.entries, 1, '原本那一筆生字要被複製');
    const copy = store.getUnit(res.data.unit.id);
    assert.equal(copy.title, 'My New School (copy)');
    assert.equal(copy.is_published, false, '複製出來的單元預設不發佈（老師檢查過再發）');
    assert.ok(Number(copy.unit_no) > Number(store.getUnit(ids.unit.id).unit_no), '編號要排在最後');
    const copyEntries = store.listEntries({ unitId: copy.id });
    assert.equal(copyEntries.length, 1);
    assert.equal(copyEntries[0].status, 'pending', '複製出來的是待審核（避免沒檢查就上線）');
    assert.equal(store.findTeacherAudio(copyEntries[0].id), null, '不複製錄音');
    assert.ok(store.listAuditLogs({ limit: 10 }).items.some((row) => row.action === 'UNIT_DUPLICATE'));

    /* 標題留空時給一個預設值（不會出現沒有名字的單元） */
    const plain = await api(base, `/api/units/${ids.unit.id}/duplicate`, { method: 'POST', cookie: teacher.cookie, body: {} });
    assert.ok(store.getUnit(plain.data.unit.id).title.includes('My New School'));
});

test('調整順序（B-4）：單元與書本都能上下互換，最邊緣不會出錯', async (t) => {
    const { base, ids, store } = startServer(t);
    const teacher = await login(base, 'teacher');
    /* 再加一個單元，才有東西可以換 */
    const second = store.createUnit({ book_id: ids.book.id, unit_no: 5, title: 'Unit 5', sort_order: 5, is_published: true });

    const down = await api(base, `/api/units/${ids.unit.id}/move`, { method: 'POST', cookie: teacher.cookie, body: { direction: 'down' } });
    assert.equal(down.status, 200);
    assert.equal(down.data.moved, true);
    assert.equal(Number(store.getUnit(ids.unit.id).unit_no), 5, '原本 Unit 1 變成 5');
    assert.equal(Number(store.getUnit(second.id).unit_no), 1, '原本 Unit 5 變成 1');
    assert.ok(store.listAuditLogs({ limit: 10 }).items.some((row) => row.action === 'UNIT_MOVE'));

    /* 已經在最上面再按上 → 不動，但不能報錯 */
    const edge = await api(base, `/api/units/${second.id}/move`, { method: 'POST', cookie: teacher.cookie, body: { direction: 'up' } });
    assert.equal(edge.status, 200);
    assert.equal(edge.data.moved, false);
    assert.equal(Number(store.getUnit(second.id).unit_no), 1, '邊緣時編號不變');

    /* 方向亂寫要 400 */
    assert.equal((await api(base, `/api/units/${second.id}/move`, { method: 'POST', cookie: teacher.cookie, body: { direction: 'sideways' } })).status, 400);

    /* 書本排序 */
    const book2 = store.createBook({ code: 'B6B', name: 'Book 6B', grade: 'S2', sort_order: 9, is_published: true });
    const moved = await api(base, `/api/books/${book2.id}/move`, { method: 'POST', cookie: teacher.cookie, body: { direction: 'up' } });
    assert.equal(moved.status, 200);
    assert.equal(moved.data.moved, true);
    assert.ok(Number(store.getBook(book2.id).sort_order) < 9, '書本順序要往前');
    assert.ok(store.listAuditLogs({ limit: 10 }).items.some((row) => row.action === 'BOOK_MOVE'));

    const student = await login(base, 'student');
    assert.equal((await api(base, `/api/books/${book2.id}/move`, { method: 'POST', cookie: student.cookie, body: { direction: 'up' } })).status, 403);
});

test('批次審核（B-6）：一次核准或退回多筆、退回可附原因、非待審核的要回報', async (t) => {
    const { base, ids, store } = startServer(t);
    const teacher = await login(base, 'teacher');
    const rep = await login(base, 'classrep');
    const published = store.listEntries({ unitId: ids.unit.id })[0];

    /* 科代表新增三筆（進待審核） */
    const created = [];
    for (const word of ['locker', 'canteen', 'hall']) {
        const res = await api(base, `/api/units/${ids.unit.id}/entries`, {
            method: 'POST', cookie: rep.cookie, body: { headword: word, zh_meaning: '測試' }
        });
        created.push(res.data.entry.id);
    }

    assert.equal((await api(base, '/api/entries/review-batch', { method: 'POST', cookie: rep.cookie, body: { ids: created, action: 'approve' } })).status, 403);
    assert.equal((await api(base, '/api/entries/review-batch', { method: 'POST', cookie: teacher.cookie, body: { ids: [], action: 'approve' } })).status, 400);

    /* 核准兩筆、退回一筆（附原因） */
    const approved = await api(base, '/api/entries/review-batch', {
        method: 'POST', cookie: teacher.cookie, body: { ids: created.slice(0, 2), action: 'approve' }
    });
    assert.equal(approved.data.done, 2);
    const rejected = await api(base, '/api/entries/review-batch', {
        method: 'POST', cookie: teacher.cookie, body: { ids: created.slice(2), action: 'reject', note: '中文解釋要再完整一點' }
    });
    assert.equal(rejected.data.done, 1);
    assert.equal(store.getEntry(created[2]).status, 'rejected');
    assert.equal(store.getEntry(created[2]).review_note, '中文解釋要再完整一點', '退回原因要存起來（科代表看得到）');

    /* 已經不是待審核的（剛剛那筆已發佈的）→ 回報失敗但整批不中斷 */
    const mixed = await api(base, '/api/entries/review-batch', {
        method: 'POST', cookie: teacher.cookie, body: { ids: [published.id, created[0]], action: 'approve' }
    });
    assert.equal(mixed.data.done, 0);
    assert.equal(mixed.data.failed.length, 2);

    /* 稽核只留一筆批次紀錄（不是三筆） */
    const batchLogs = store.listAuditLogs({ limit: 30 }).items.filter((row) => row.action === 'ENTRY_REVIEW_BATCH');
    assert.equal(batchLogs.length, 2, '有實際動作的兩次才留稽核（全失敗的那次不留）');
    assert.match(batchLogs[0].details, /核准|退回/);

    /* 科代表看得到自己的生字被退回與原因（前端會顯示） */
    const listed = await api(base, `/api/units/${ids.unit.id}`, { cookie: rep.cookie });
    const mine = listed.data.entries.find((entry) => entry.id === created[2]);
    assert.equal(mine.status, 'rejected');
    assert.match(mine.review_note, /完整/);
});

test('角色與能力對照表（C-4）：公開、DB-free、六個角色與能力都在', async (t) => {
    const { base } = startServer(t);
    const res = await fetch(`${base}/api/roles`);
    assert.equal(res.status, 200, '沒登入也要看得到（說明頁用）');
    const data = await res.json();
    assert.equal(data.roles.length, 6);
    assert.equal(data.capabilities.length, 7);
    assert.deepEqual(data.roles.map((role) => role.level), [0, 1, 2, 3, 4, 5], '由低到高');
    for (const role of data.roles) {
        assert.ok(role.label_zh && role.label_en, `${role.key} 要有中英標籤`);
    }
    for (const item of data.capabilities) {
        assert.ok(item.label_zh && item.label_en && item.note_zh && item.note_en, `${item.key} 要有中英標籤與說明`);
        assert.ok(data.roles.some((role) => role.key === item.min_role), `${item.key} 的 min_role 要存在`);
    }
    /* 能力表不可以洩漏任何個資或內部欄位（說明的文字可以有「密碼」這個詞，但不能有真實欄位或值） */
    assert.equal(/password_hash|totp_secret|backup_codes|"secret"|jwt/i.test(JSON.stringify(data)), false);
});

test('權限物件由能力表產生（C-2 種子）：每個角色的 permissions 與 min_role 一致', async (t) => {
    const { base } = startServer(t);
    const table = (await (await fetch(`${base}/api/roles`)).json()).capabilities;
    const minRoleOf = {};
    for (const item of table) minRoleOf[item.key] = item.min_role;
    const levels = { guest: 0, student: 1, class_rep: 2, teacher: 3, admin: 4, web_manager: 5 };
    for (const name of ['teacher', 'manager', 'webmanager']) {
        const me = await api(base, '/api/auth/me', { cookie: (await login(base, name)).cookie });
        assert.equal(me.status, 200);
        const role = me.data.user.role;
        for (const [key, allowed] of Object.entries(me.data.permissions)) {
            const min = minRoleOf[key];
            assert.ok(min, `${key} 不在能力表裡（前端會拿到後端不認得的能力）`);
            const expected = key === 'can_force_logout' ? role === 'web_manager' : levels[role] >= levels[min];
            assert.equal(allowed, expected, `${name} 的 ${key} 應為 ${expected}`);
        }
    }
});

test('我的單元（C-1）：老師看到全部、科代表只看被授權的、訪客 401', async (t) => {
    const { base, store } = startServer(t);
    assert.equal((await api(base, '/api/my/units')).status, 401);

    const teacher = await login(base, 'teacher');
    const mine = await api(base, '/api/my/units', { cookie: teacher.cookie });
    assert.equal(mine.status, 200);
    assert.equal(mine.data.total, mine.data.all, '老師可以編輯全部單元');
    assert.equal(mine.data.units.length, 2);
    const first = mine.data.units[0];
    assert.equal(first.grade, 'S1', '要帶年級（畫面上只顯示年級，不出現書名）');
    assert.equal(first.book_name, undefined, '不可以再回書名');
    assert.equal(first.can_publish, true);
    assert.equal(typeof first.entries, 'number');
    assert.equal(typeof first.pending, 'number', '要能顯示有幾筆待審核');

    /* 科代表：沒有授權時預設可以編輯（但新增會進待審核） */
    const rep = await login(base, 'classrep');
    const repMine = await api(base, '/api/my/units', { cookie: rep.cookie });
    assert.equal(repMine.status, 200);
    assert.equal(repMine.data.units[0].can_publish, false, '科代表不能直接發佈');

    /* 給科代表只授權其中一個單元 → 清單只剩那一個（有限縮授權時以授權為準） */
    const hidden = store.listUnits({ includeUnpublished: true }).find((unit) => unit.is_published === false);
    const repUser = store.listUsers().find((user) => user.username === 'classrep');
    store.createGrant({ user_id: repUser.id, book_id: null, unit_id: hidden.id, can_edit: true, can_publish: false });
    const scoped = await api(base, '/api/my/units', { cookie: rep.cookie });
    assert.equal(scoped.data.total, 1, '有限縮授權時只看得到被授權的單元');
    assert.equal(scoped.data.units[0].id, hidden.id);
});

test('稽核匯出（A-3）：CSV 帶 BOM、公式注入被中和、篩選條件一起套用', async (t) => {
    const { base, store } = startServer(t);
    const manager = await login(base, 'manager');
    /* 造一筆「看起來像公式」的內容（帳號與生字都是使用者輸入，這是必要的防護） */
    store.insertAuditLog({
        user_id: 'evil', display_name: '=cmd|' + "'" + ' /C calc', role: 'teacher',
        action: 'ENTRY_UPDATE', target_id: '1', details: '=SUM(A1:A9) 中文', ip: '1.2.3.4',
        created_at: new Date().toISOString()
    });

    assert.equal((await api(base, '/api/admin/audit-logs/export')).status, 401);
    const teacher = await login(base, 'teacher');
    assert.equal((await api(base, '/api/admin/audit-logs/export', { cookie: teacher.cookie })).status, 403);

    const res = await fetch(`${base}/api/admin/audit-logs/export`, { headers: { Cookie: manager.cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/csv/);
    assert.match(res.headers.get('content-disposition') || '', /attachment; filename=/);
    const buffer = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...buffer.slice(0, 3)], [239, 187, 191], 'UTF-8 BOM（不然 Excel 開中文會亂碼）');
    const csv = buffer.toString('utf8').replace(/^\ufeff/, '');
    const lines = csv.trim().split('\r\n');
    assert.equal(lines[0], 'created_at,action,action_label,user_id,display_name,role,target_id,details,ip,is_self_test');
    const evil = lines.find((line) => line.includes('cmd')) || '';
    assert.equal(/^=/.test(evil.replace(/^[^,]*,[^,]*,[^,]*,[^,]*,/, '')), false, '每格都不能以 = 開頭');
    assert.match(evil, /'=cmd/, '公式前面要補單引號');
    assert.match(csv, /修改生字/, '動作要有中文標籤，Excel 才看得懂');

    /* 匯出本身要留稽核 */
    assert.ok(store.listAuditLogs({ limit: 10 }).items.some((row) => row.action === 'AUDIT_EXPORT'));
});

test('稽核清理（A-3）：預設只預覽、天數下限 30、真的刪除才動手', async (t) => {
    const { base, store } = startServer(t);
    const manager = await login(base, 'manager');
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    store.insertAuditLog({ user_id: 'old', display_name: 'Old', role: 'teacher', action: 'LOGIN', target_id: null, details: '很久以前', ip: '', created_at: old });
    const before = store.listAuditLogs({ limit: 1000, hide_self_test: false }).items.length;

    const preview = await api(base, '/api/admin/audit-logs/cleanup', { method: 'POST', cookie: manager.cookie, body: {} });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.dry_run, true, '沒指定就是預覽');
    assert.equal(preview.data.would_delete, 1);
    assert.equal(store.listAuditLogs({ limit: 1000, hide_self_test: false }).items.length, before, '預覽不能真的刪');

    /* 天數下限 30 天：這一輪只要確認下限（dry-run，別真的刪，否則下一段就沒東西可刪了） */
    const floored = await api(base, '/api/admin/audit-logs/cleanup', { method: 'POST', cookie: manager.cookie, body: { keep_days: 5, dry_run: true } });
    assert.equal(floored.data.keep_days, 30, '天數下限 30 天');

    const done = await api(base, '/api/admin/audit-logs/cleanup', { method: 'POST', cookie: manager.cookie, body: { keep_days: 365, dry_run: false } });
    assert.equal(done.data.would_delete, 1);
    const after = store.listAuditLogs({ limit: 1000, hide_self_test: false }).items;
    assert.equal(after.some((row) => row.created_at === old), false, '舊紀錄要真的被刪掉');
    assert.ok(after.some((row) => row.action === 'AUDIT_CLEANUP'), '清理本身要留一筆稽核');
});

test('使用統計（B-7）：只回聚合數字、admin 以上才看得到', async (t) => {
    const { base } = startServer(t);
    assert.equal((await api(base, '/api/admin/stats')).status, 401);
    const teacher = await login(base, 'teacher');
    assert.equal((await api(base, '/api/admin/stats', { cookie: teacher.cookie })).status, 403);

    const manager = await login(base, 'manager');
    const stats = (await api(base, '/api/admin/stats', { cookie: manager.cookie })).data;
    assert.equal(stats.books.total, 1);
    assert.equal(stats.units.total, 2, '含未發佈的草稿單元');
    assert.equal(stats.units.published, 1);
    assert.equal(stats.entries.published, 1);
    assert.equal(stats.users.total, 5);
    assert.equal(stats.users.by_role.admin, 1);
    assert.equal(stats.audio.missing, 1, '已發佈 1 個生字、沒有錄音');
    assert.equal(Array.isArray(stats.per_unit), true);
    assert.equal(stats.per_unit.length, 2);
    assert.equal(stats.empty_units.length, 1, '草稿單元是空的');
    assert.equal(typeof stats.recent.total, 'number');
    /* 不可以回任何帳號或生字的明細 */
    const serialized = JSON.stringify(stats);
    assert.equal(serialized.includes('teacher@') || serialized.includes('password'), false);
});

test('全域登出（web_manager）：所有帳號的所有裝置一起登出，包括自己', async (t) => {
    const { base, store } = startServer(t);
    const teacherDevice = await login(base, 'teacher');
    const adminDevice = await login(base, 'manager');
    const webmanager = await login(base, 'webmanager');
    const versionsBefore = store.listUsers().map((user) => Number(user.token_version) || 1);

    assert.equal((await api(base, '/api/admin/users/logout-all', { method: 'POST' })).status, 401);
    const byAdmin = await api(base, '/api/admin/users/logout-all', { method: 'POST', cookie: adminDevice.cookie });
    assert.equal(byAdmin.status, 403, '只有網站管理員可以做');
    assert.equal(byAdmin.data.code, 'FORBIDDEN');

    const byWebManager = await api(base, '/api/admin/users/logout-all', { method: 'POST', cookie: webmanager.cookie });
    assert.equal(byWebManager.status, 200);
    assert.ok(byWebManager.data.users >= 5, String(byWebManager.data.users));

    const versionsAfter = store.listUsers().map((user) => Number(user.token_version) || 1);
    assert.equal(versionsAfter.every((value, index) => value === versionsBefore[index] + 1), true, '每個帳號的工作階段版本都要 +1');

    /* 所有人的舊權杖都失效：包含老師、管理員、以及按下按鈕的那一位 */
    assert.equal((await api(base, '/api/auth/me', { cookie: teacherDevice.cookie })).status, 401);
    assert.equal((await api(base, '/api/auth/me', { cookie: adminDevice.cookie })).status, 401);
    assert.equal((await api(base, '/api/auth/me', { cookie: webmanager.cookie })).status, 401, '自己那一台也要登出');

    assert.ok(store.listAuditLogs({ limit: 10 }).items.some((row) => row.action === 'ALL_USERS_FORCE_LOGOUT'));
    /* 但還是可以重新登入（只是舊權杖失效） */
    assert.equal((await login(base, 'teacher')).status, 200);
});

test('帳號救援（C-3）：管理員重設密碼（臨時密碼只回一次、舊工作階段失效）與重設兩步驟驗證', async (t) => {
    const { base, store } = startServer(t);
    const manager = await login(base, 'manager');
    const teacherId = store.findUserByUsername('teacher').id;
    const teacherDevice = await login(base, 'teacher');

    const reset = await api(base, `/api/admin/users/${teacherId}/reset-password`, { method: 'POST', cookie: manager.cookie });
    assert.equal(reset.status, 200);
    assert.equal(reset.data.username, 'teacher');
    assert.ok(reset.data.temp_password.length >= 10, '臨時密碼要符合政策');
    assert.equal((await login(base, 'teacher', reset.data.temp_password)).status, 200, '臨時密碼可以登入');
    assert.equal((await api(base, '/api/auth/me', { cookie: teacherDevice.cookie })).status, 401, '重設密碼後舊工作階段失效');

    /* 重設兩步驟驗證（先幫老師開起來） */
    const teacherLogin = await login(base, 'teacher', reset.data.temp_password);
    const setup = await api(base, '/api/auth/2fa/setup', { method: 'POST', cookie: teacherLogin.cookie });
    await api(base, '/api/auth/2fa/enable', {
        method: 'POST', cookie: teacherLogin.cookie, body: { code: Totp.codeAt(setup.data.secret, Date.now() / 1000) }
    });
    assert.equal(store.findUserByUsername('teacher').totp_enabled_at !== null, true);
    assert.equal((await login(base, 'teacher', reset.data.temp_password)).body.two_factor_required, true);

    const cleared = await api(base, `/api/admin/users/${teacherId}/reset-2fa`, { method: 'POST', cookie: manager.cookie });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.data.user.two_factor, false);
    assert.equal(store.findUserByUsername('teacher').totp_enabled_at, null);
    assert.equal((await login(base, 'teacher', reset.data.temp_password)).body.two_factor_required || false, false, '重設後回到只要密碼');

    /* 不能重設比自己高的角色（老師不能碰管理員） */
    const teacherOnManager = await api(base, `/api/admin/users/${store.findUserByUsername('manager').id}/reset-password`, {
        method: 'POST', cookie: teacherLogin.cookie
    });
    assert.equal(teacherOnManager.status, 403);

    const actions = store.listAuditLogs({ limit: 40 }).items.map((row) => row.action);
    assert.ok(actions.includes('USER_PASSWORD_RESET') && actions.includes('USER_2FA_RESET') && actions.includes('TWO_FA_ENABLE'), actions.join(','));
});


/* ============================================================
 * v0.6.0：修改年級、樂觀鎖（D-2）、每單元錄音上限（D-3）
 * ============================================================ */

test('v0.6.0 修改年級：只要年級就能改名，重複／空白／舊版本都會被擋', async (t) => {
    const { base, store, ids } = startServer(t);
    const teacher = await login(base, 'teacher');

    const before = await api(base, '/api/books');
    assert.equal(before.data.books[0].grade, 'S1');
    assert.ok(before.data.books[0].updated_at, '書本要回 updated_at（樂觀鎖要用）');

    /* 1. 改名成功（帶正確的版本） */
    const renamed = await api(base, `/api/books/${ids.book.id}`, {
        method: 'PATCH', cookie: teacher.cookie,
        body: { grade: 'S2', version: before.data.books[0].updated_at }
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.data.book.grade, 'S2');
    assert.equal(store.getBook(ids.book.id).grade, 'S2');
    assert.equal(store.getBook(ids.book.id).name, 'S2', 'name 是內部欄位，與年級同步');

    /* 2. 再建一個同年級的 → 409（學生會分不出要點哪一個） */
    const second = await api(base, '/api/books', { method: 'POST', cookie: teacher.cookie, body: { grade: 'S3' } });
    assert.equal(second.status, 201);
    const clash = await api(base, `/api/books/${second.data.book.id}`, {
        method: 'PATCH', cookie: teacher.cookie, body: { grade: 'S2' }
    });
    assert.equal(clash.status, 409);
    assert.equal(clash.data.code, 'DUPLICATE_GRADE');
    assert.equal(clash.data.details.grade, 'S2');

    /* 3. 空白年級 → 400 */
    const empty = await api(base, `/api/books/${second.data.book.id}`, {
        method: 'PATCH', cookie: teacher.cookie, body: { grade: '   ' }
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.data.code, 'BOOK_GRADE_REQUIRED');

    /* 4. 同樣是自己那筆（不算重複）→ 200 */
    const same = await api(base, `/api/books/${second.data.book.id}`, {
        method: 'PATCH', cookie: teacher.cookie, body: { grade: 'S3' }
    });
    assert.equal(same.status, 200);

    /* 5. 用舊版本送（別人先改過的情境）→ 409 STALE_WRITE */
    const stale = await api(base, `/api/books/${ids.book.id}`, {
        method: 'PATCH', cookie: teacher.cookie, body: { grade: 'S9', version: before.data.books[0].updated_at }
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.code, 'STALE_WRITE');
    assert.ok(stale.data.details.current, '要回最新版本讓前端重新整理');
    assert.equal(store.getBook(ids.book.id).grade, 'S2', '被擋下的請求不可以改到資料');

    /* 6. 稽核有紀錄 */
    const actions = store.listAuditLogs({ limit: 30 }).items.map((row) => row.action);
    assert.ok(actions.includes('BOOK_UPDATE'), actions.join(','));

    /* 7. 科代表不能改年級（只有老師以上） */
    const classrep = await login(base, 'classrep');
    const denied = await api(base, `/api/books/${ids.book.id}`, {
        method: 'PATCH', cookie: classrep.cookie, body: { grade: 'S4' }
    });
    assert.equal(denied.status, 403);
});

test('v0.6.0 樂觀鎖（D-2）：生字與單元被別人改過就回 409，不覆蓋別人的修改', async (t) => {
    const { base, store, ids } = startServer(t);
    const teacher = await login(base, 'teacher');

    /* 生字：兩次讀取之間有人改過 */
    const entryId = store.listEntries({ unitId: ids.unit.id })[0].id;
    const first = await api(base, `/api/units/${ids.unit.id}?status=all`, { cookie: teacher.cookie });
    const readVersion = first.data.entries.find((e) => e.id === entryId).updated_at;

    const okEdit = await api(base, `/api/entries/${entryId}`, {
        method: 'PATCH', cookie: teacher.cookie, body: { zh_meaning: '校園（改）', version: readVersion }
    });
    assert.equal(okEdit.status, 200);
    assert.equal(okEdit.data.entry.updated_at !== readVersion, true, '更新後版本要變');

    const conflict = await api(base, `/api/entries/${entryId}`, {
        method: 'PATCH', cookie: teacher.cookie, body: { zh_meaning: '別人的修改', version: readVersion }
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.code, 'STALE_WRITE');
    assert.equal(store.getEntry(entryId).zh_meaning, '校園（改）', '衝突的請求不可寫入');

    /* 帶最新版本就沒問題 */
    const retry = await api(base, `/api/entries/${entryId}`, {
        method: 'PATCH', cookie: teacher.cookie,
        body: { zh_meaning: '校園（再改）', version: store.getEntry(entryId).updated_at }
    });
    assert.equal(retry.status, 200);

    /* 沒有帶版本（舊前端、腳本）→ 照舊可以寫（不能把人擋在門外） */
    const noVersion = await api(base, `/api/entries/${entryId}`, {
        method: 'PATCH', cookie: teacher.cookie, body: { zh_meaning: '沒有版本' }
    });
    assert.equal(noVersion.status, 200);

    /* 單元也一樣 */
    const unitView = await api(base, `/api/units/${ids.unit.id}`, { cookie: teacher.cookie });
    const unitVersion = unitView.data.unit.updated_at;
    assert.ok(unitVersion, '單元要回 updated_at');
    const unitOk = await api(base, `/api/units/${ids.unit.id}`, {
        method: 'PATCH', cookie: teacher.cookie, body: { title: 'My New School 2', version: unitVersion }
    });
    assert.equal(unitOk.status, 200);
    const unitConflict = await api(base, `/api/units/${ids.unit.id}`, {
        method: 'PATCH', cookie: teacher.cookie, body: { title: '別人的標題', version: unitVersion }
    });
    assert.equal(unitConflict.status, 409);
    assert.equal(store.getUnit(ids.unit.id).title, 'My New School 2');
});

test('v0.6.0 每單元錄音上限（D-3）：到上限就擋、同一顆生字換錄音不算新增、用量看得見', async (t) => {
    const { base, store, ids } = startServer(t);
    const teacher = await login(base, 'teacher');
    const tiny = Buffer.from('OggS-not-really-audio-but-base64-is-all-we-check').toString('base64');

    /* 單元用量（0/60） */
    const empty = await api(base, `/api/units/${ids.unit.id}`, { cookie: teacher.cookie });
    assert.equal(empty.data.unit.audio_count, 0);
    assert.equal(empty.data.unit.audio_limit, 60);

    /* 錄一段 → 用量變 1 */
    const first = await api(base, `/api/entries/${store.listEntries({ unitId: ids.unit.id })[0].id}/audio`, {
        method: 'POST', cookie: teacher.cookie, body: { data: `data:audio/webm;base64,${tiny}`, duration_ms: 900 }
    });
    assert.equal(first.status, 201);
    const one = await api(base, `/api/units/${ids.unit.id}`, { cookie: teacher.cookie });
    assert.equal(one.data.unit.audio_count, 1);

    /* 把這個單元塞到上限（直接寫資料層，避免 60 次 HTTP） */
    const limit = one.data.unit.audio_limit;
    const existing = store.listEntries({ unitId: ids.unit.id });
    for (let i = existing.length; i < limit; i += 1) {
        const entry = store.createEntry({
            unit_id: ids.unit.id, headword: `filler${i}`, headword_norm: `filler${i}`,
            status: 'published', sort_order: 100 + i, created_by: 'test'
        });
        store.createAudio({ entry_id: entry.id, source: 'teacher', accent: 'en-GB', mime: 'audio/webm', bytes: 12, duration_ms: 500, data: tiny, uploaded_by: 'teacher' });
    }
    const full = await api(base, `/api/units/${ids.unit.id}`, { cookie: teacher.cookie });
    assert.equal(full.data.unit.audio_count, limit, '測試前置：單元已滿');

    /* 已滿 → 新的生字不能再錄（400，並回用量讓前端說明） */
    const extra = store.createEntry({
        unit_id: ids.unit.id, headword: 'overflow', headword_norm: 'overflow',
        status: 'published', sort_order: 900, created_by: 'test'
    });
    const blocked = await api(base, `/api/entries/${extra.id}/audio`, {
        method: 'POST', cookie: teacher.cookie, body: { data: `data:audio/webm;base64,${tiny}` }
    });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.data.code, 'AUDIO_LIMIT_REACHED');
    assert.equal(blocked.data.details.limit, limit);
    assert.equal(blocked.data.details.count, limit);
    assert.equal(store.findTeacherAudio(extra.id), null, '被擋下時不可以寫入');

    /* 但「換掉已有的那一顆」不算新增 → 還是可以錄 */
    const replaced = await api(base, `/api/entries/${existing[0].id}/audio`, {
        method: 'POST', cookie: teacher.cookie, body: { data: `data:audio/webm;base64,${tiny}`, duration_ms: 800 }
    });
    assert.equal(replaced.status, 201);

    /* 統計（📊 概況）要有容量資訊 */
    const manager = await login(base, 'manager');
    const stats = await api(base, '/api/admin/stats', { cookie: manager.cookie });
    assert.equal(stats.data.audio.per_unit_limit, limit);
    assert.ok(stats.data.audio.bytes > 0, '要回錄音總位元組數');
});


test('v0.6.0 生字表分頁（D-1）：一頁一頁送、搜尋在伺服器端、待審核另外抓', async (t) => {
    const { base, store, ids } = startServer(t);
    const teacher = await login(base, 'teacher');

    /* 這個單元塞 130 個生字（第一頁 60、第二頁 60、第三頁 10） */
    for (let i = 2; i <= 130; i += 1) {
        store.createEntry({
            unit_id: ids.unit.id, headword: `word${String(i).padStart(3, '0')}`, headword_norm: `word${String(i).padStart(3, '0')}`,
            zh_meaning: i % 2 ? '測試' : '', en_definition: i % 5 === 0 ? 'a searchable definition' : '',
            status: 'published', sort_order: i, created_by: 'test'
        });
    }

    const first = await api(base, `/api/units/${ids.unit.id}`, { cookie: teacher.cookie });
    assert.equal(first.status, 200);
    assert.equal(first.data.entries.length, 60, '預設一頁 60 筆');
    assert.equal(first.data.total, 130);
    assert.equal(first.data.page, 1);
    assert.equal(first.data.has_more, true);

    const second = await api(base, `/api/units/${ids.unit.id}?page=2`, { cookie: teacher.cookie });
    assert.equal(second.data.entries.length, 60);
    assert.equal(second.data.page, 2);
    assert.equal(second.data.has_more, true);
    assert.notEqual(second.data.entries[0].id, first.data.entries[0].id, '第二頁不可以跟第一頁重複');

    const third = await api(base, `/api/units/${ids.unit.id}?page=3`, { cookie: teacher.cookie });
    assert.equal(third.data.entries.length, 10);
    assert.equal(third.data.has_more, false);

    const capped = await api(base, `/api/units/${ids.unit.id}?per_page=9999`, { cookie: teacher.cookie });
    assert.equal(capped.data.entries.length, 130, 'per_page 有上限，超過就回全部（不會爆）');
    assert.equal(capped.data.per_page, 200, 'per_page 上限是 200');

    /* 搜尋：伺服器端比對生字／中文／英文解釋 */
    const byWord = await api(base, `/api/units/${ids.unit.id}?q=word007`, { cookie: teacher.cookie });
    assert.equal(byWord.data.total, 1);
    assert.equal(byWord.data.entries[0].headword, 'word007');

    const byChinese = await api(base, `/api/units/${ids.unit.id}?q=${encodeURIComponent('校園')}`, { cookie: teacher.cookie });
    assert.equal(byChinese.data.total, 1, '中文解釋也要搜得到');

    const byEnglish = await api(base, `/api/units/${ids.unit.id}?q=searchable`, { cookie: teacher.cookie });
    assert.equal(byEnglish.data.total, 26, '130 筆裡每 5 筆一個（含原本的 campus 不算）');

    const none = await api(base, `/api/units/${ids.unit.id}?q=zzz-nothing`, { cookie: teacher.cookie });
    assert.equal(none.data.total, 0);
    assert.equal(none.data.entries.length, 0);
    assert.equal(none.data.has_more, false);

    /* 不認識的 status 要忽略（不要回空的，那會變成「這個單元沒有生字」的鬼故事） */
    const weird = await api(base, `/api/units/${ids.unit.id}?status=all`, { cookie: teacher.cookie });
    assert.equal(weird.data.total, 130);

    /* 訪客看不到待審核（teacher 先把一筆改成待審核） */
    const pendingEntry = store.listEntries({ unitId: ids.unit.id })[1];
    store.updateEntry(pendingEntry.id, { status: 'pending' });
    const asGuest = await api(base, `/api/units/${ids.unit.id}?status=pending&per_page=200`);
    assert.equal(asGuest.data.entries.length, 0, '訪客問 pending 也拿不到別人的草稿');
    const asTeacher = await api(base, `/api/units/${ids.unit.id}?status=pending&per_page=200`, { cookie: teacher.cookie });
    assert.equal(asTeacher.data.entries.length, 1);
    assert.equal(asTeacher.data.entries[0].id, pendingEntry.id);
});
