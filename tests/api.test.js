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
        ['owner', 'web_owner', '網站擁有者'],
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
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
});
