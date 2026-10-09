/* Supabase 資料層測試
 *
 * 不打真的 Supabase（那要密鑰、也會污染正式資料）：這裡用「假的 PostgREST」攔 fetch，
 * 驗證的是我們自己的邏輯 —— 抓下來的樣子、id 配發、寫回的 URL／方法／順序、失敗時的行為。
 *
 * ★ 這支測試的重點：整個 app 用 supabase 後端跑起來（hydrate → 同步路由 → 回應前 flush），
 *   確認「資料真的進了資料庫」而不是只在記憶體裡。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createSupabaseStore } = require('../lib/store/supabase');
const { hashPassword } = require('../lib/passwords');

const TABLES = ['dict_books', 'dict_units', 'dict_entries', 'dict_audio', 'dict_users', 'dict_grants', 'dict_audit_logs'];

/* 極簡假 PostgREST：只支援本專案用到的查詢形狀（select=*、id=eq.<n>） */
function fakeSupabase() {
    const db = {};
    for (const name of TABLES) db[name] = [];
    const calls = [];
    const flags = { failWrites: false, failMessage: '' };
    const originalFetch = global.fetch;

    function tableOf(pathname) {
        return pathname.split('/').pop();
    }

    global.fetch = async (url, init = {}) => {
        const parsed = new URL(url);
        /* 只攔 Supabase 的請求；測試自己打本機 server 的 fetch 要放行 */
        if (parsed.hostname !== 'example.supabase.co') return originalFetch(url, init);
        const method = init.method || 'GET';
        const table = tableOf(parsed.pathname);
        const idFilter = parsed.searchParams.get('id');
        const wanted = idFilter && idFilter.startsWith('eq.') ? idFilter.slice(3) : null;
        const select = parsed.searchParams.get('select');
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ method, table, wanted, body, headers: init.headers, select });

        if (!db[table]) throw new Error(`假 PostgREST 沒有這張表：${table}`);
        if (flags.failWrites && method !== 'GET') {
            const message = flags.failMessage || 'simulated write failure';
            return { ok: false, status: 400, text: async () => JSON.stringify({ message, code: '42703' }) };
        }
        if (method === 'GET') {
            const picked = (row) => {
                if (!select || select === '*') return Object.assign({}, row);
                const out = {};
                for (const column of select.split(',')) {
                    const name = column.trim();
                    if (name in row) out[name] = row[name];
                }
                return out;
            };
            const rows = (wanted ? db[table].filter((r) => String(r.id) === String(wanted)) : db[table].slice()).map(picked);
            return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
        }
        if (method === 'POST') {
            const row = Object.assign({}, body);
            if (row.id === undefined || row.id === null) {
                row.id = db[table].reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1;
            }
            if (db[table].some((r) => String(r.id) === String(row.id))) {
                return { ok: false, status: 409, text: async () => JSON.stringify({ message: 'duplicate key value violates unique constraint' }) };
            }
            db[table].push(row);
            return { ok: true, status: 201, text: async () => JSON.stringify([row]) };
        }
        if (method === 'PATCH') {
            let touched = 0;
            for (const row of db[table]) {
                if (wanted && String(row.id) !== String(wanted)) continue;
                Object.assign(row, body);
                touched += 1;
            }
            return { ok: true, status: 200, text: async () => JSON.stringify(touched ? [{}] : []) };
        }
        if (method === 'DELETE') {
            const before = db[table].length;
            db[table] = db[table].filter((r) => !(wanted && String(r.id) === String(wanted)));
            return { ok: true, status: 200, text: async () => JSON.stringify(before === db[table].length ? [] : [{ id: wanted }]) };
        }
        throw new Error(`假 PostgREST 不支援 ${method}`);
    };

    return {
        db,
        calls,
        flags,
        restore() { global.fetch = originalFetch; },
        seedUsers(rows) { db.dict_users.push(...rows); }
    };
}

function withFake(t) {
    const fake = fakeSupabase();
    t.after(() => fake.restore());
    return fake;
}

test('Supabase 資料層：hydrate 會抓 7 張表，並用最大 id 決定下一個 id', async (t) => {
    const fake = withFake(t);
    fake.db.dict_books.push({ id: 7, code: 'B7', name: 'Book 7', sort_order: 1, is_published: true });
    fake.db.dict_units.push({ id: 3, book_id: 7, unit_no: 1, title: 'U1', sort_order: 1, is_published: true });

    const store = createSupabaseStore({ url: 'https://example.supabase.co', key: 'service-key' });
    await store.hydrate();

    const reads = fake.calls.filter((c) => c.method === 'GET').map((c) => c.table);
    assert.deepEqual(reads.sort(), TABLES.slice().sort(), '七張表都要抓到');
    assert.equal(fake.calls[0].headers.apikey, 'service-key');
    assert.match(String(fake.calls[0].headers.Authorization), /^Bearer /, '要用 service_role 帶 Bearer');
    assert.equal(store.getBook(7).name, 'Book 7');

    const created = store.createBook({ code: 'B8', name: 'Book 8', sort_order: 2, is_published: true });
    assert.equal(created.id, 8, '下一個 id 是 8（不是 1，否則會撞到既有資料）');
});

test('Supabase 資料層：flush 依外鍵順序寫回，而且只寫一次', async (t) => {
    const fake = withFake(t);
    const store = createSupabaseStore({ url: 'https://example.supabase.co', key: 'k' });
    await store.hydrate();
    fake.calls.length = 0;

    const book = store.createBook({ code: 'B1', name: 'Book 1', sort_order: 1, is_published: true });
    const unit = store.createUnit({ book_id: book.id, unit_no: 1, title: 'U1', sort_order: 1, is_published: true });
    store.createEntry({ unit_id: unit.id, headword: 'campus', headword_norm: 'campus', status: 'published', sort_order: 1 });
    store.createGrant({ user_id: 1, book_id: book.id, can_edit: true, can_publish: false });
    store.deleteGrant(999);   // 記憶體裡沒有這一筆 → 不應該產生任何請求

    const result = await store.flush();
    assert.equal(result.written, 4, '只有真的異動才會寫回');
    const writes = fake.calls.map((c) => `${c.method} ${c.table}`);
    assert.deepEqual(writes, [
        'POST dict_books',
        'POST dict_units',
        'POST dict_entries',
        'POST dict_grants'
    ]);
    assert.equal(fake.db.dict_books.length, 1);
    assert.equal(fake.db.dict_units[0].book_id, book.id, '寫進資料庫的 book_id 與回給前端的 id 一致');
    assert.equal(fake.db.dict_entries[0].unit_id, unit.id);

    fake.calls.length = 0;
    await store.flush();
    assert.equal(fake.calls.length, 0, '沒有異動時不要再打任何請求');
});

test('Supabase 資料層：更新與刪除用 id=eq. 過濾，刪生字會連音檔一起刪', async (t) => {
    const fake = withFake(t);
    fake.db.dict_entries.push({ id: 5, unit_id: 1, headword: 'campus', headword_norm: 'campus', status: 'published', sort_order: 1 });
    fake.db.dict_audio.push({ id: 9, entry_id: 5, source: 'teacher', mime: 'audio/webm', data: 'AAA' });

    const store = createSupabaseStore({ url: 'https://example.supabase.co', key: 'k' });
    await store.hydrate();
    fake.calls.length = 0;

    store.updateEntry(5, { zh_meaning: '校園' });
    await store.flush();
    assert.equal(fake.calls[0].method, 'PATCH');
    assert.equal(fake.calls[0].wanted, '5');
    assert.equal(fake.db.dict_entries[0].zh_meaning, '校園');
    assert.ok(fake.db.dict_entries[0].updated_at, 'update 要自己補 updated_at');

    fake.calls.length = 0;
    store.deleteEntry(5);
    await store.flush();
    const deletes = fake.calls.filter((c) => c.method === 'DELETE').map((c) => c.table);
    assert.deepEqual(deletes, ['dict_audio', 'dict_entries'], '先刪音檔再刪生字');
    assert.equal(fake.db.dict_entries.length, 0);
    assert.equal(fake.db.dict_audio.length, 0);
});

test('Supabase 資料層：寫回失敗要 throw（而且不會偷偷把異動吞掉）', async (t) => {
    const fake = withFake(t);
    const store = createSupabaseStore({ url: 'https://example.supabase.co', key: 'k' });
    await store.hydrate();
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ message: 'boom' }) });

    store.createBook({ code: 'BX', name: 'Boom', sort_order: 1, is_published: true });
    await assert.rejects(() => store.flush(), /boom/);
    global.fetch = originalFetch;

    /* 失敗後重新 hydrate：記憶體要回到資料庫的真實狀態（不要留著沒寫進去的假資料） */
    await store.hydrate();
    assert.equal(store.listBooks({ includeUnpublished: true }).length, fake.db.dict_books.length);
    assert.equal(store.listBooks({ includeUnpublished: true }).some((b) => b.name === 'Boom'), false);
});

test('Supabase 資料層：ttl 設 0 時每個請求都重新抓（別人剛寫進去的東西下一個請求就看得到）', async (t) => {
    const fake = withFake(t);
    const store = createSupabaseStore({ url: 'https://example.supabase.co', key: 'k', hydrateTtlMs: 0 });
    await store.hydrate();
    assert.equal(store.listBooks().length, 0);

    /* 模擬「另一個實例（另一個 Vercel lambda）剛寫了一本書」 */
    fake.db.dict_books.push({ id: 1, code: 'B1', name: '別的實例寫的', sort_order: 1, is_published: true });

    await store.hydrate();
    assert.equal(store.listBooks().length, 1, 'ttl=0：下一個請求就要看到資料庫的最新狀態');
});

test('Supabase 資料層：還有沒寫回的異動時不重抓（避免把寫入弄丟）', async (t) => {
    const fake = withFake(t);
    const store = createSupabaseStore({ url: 'https://example.supabase.co', key: 'k' });
    await store.hydrate();
    store.createBook({ code: 'B1', name: 'Book 1', sort_order: 1, is_published: true });
    assert.equal(store.pendingOps(), 1);

    await store.hydrate();
    assert.equal(store.pendingOps(), 1, '重抓會把還沒寫回的異動丟掉，所以寧可先不重抓');
    assert.equal(store.listBooks().length, 1, '剛建立的書還在');
});

test('Supabase 資料層：大欄位（舊封面／錄音 base64）不會進快取，要檔案時才單筆抓', async (t) => {
    const fake = withFake(t);
    fake.db.dict_books.push({
        id: 1, code: 'B1', name: 'Book 1', sort_order: 1, is_published: true,
        cover_mime: 'image/png', cover_bytes: 1234, cover_data: 'AAAA'
    });
    fake.db.dict_audio.push({ id: 1, entry_id: 9, source: 'teacher', mime: 'audio/webm', bytes: 10, data: 'BBBB' });

    const store = createSupabaseStore({ url: 'https://example.supabase.co', key: 'k' });
    await store.hydrate();

    const reads = fake.calls.filter((c) => c.method === 'GET');
    for (const call of reads) {
        assert.ok(call.select, `${call.table} 應該帶 select 參數`);
    }
    /* 只有放大檔案的兩張表需要欄位白名單；其餘表 select=* 沒關係（都是純文字欄位） */
    assert.equal(reads.find((c) => c.table === 'dict_books').select.includes('cover_data'), false, 'hydrate 不該抓封面 base64');
    assert.equal(reads.find((c) => c.table === 'dict_audio').select.includes('data'), false, 'hydrate 不該抓錄音 base64');

    const book = store.getBook(1);
    assert.equal(book.cover_data, null, '快取裡的 cover_data 一律是 null（有沒有封面看 cover_bytes）');
    assert.equal(book.cover_bytes, 1234);
    assert.equal(store.getAudio(1).data, null);

    /* 真的要檔案時：單筆、只抓需要的那個欄位 */
    const cover = await store.getBookCoverData(1);
    assert.equal(cover.cover_data, 'AAAA');
    const audio = await store.getAudioData(1);
    assert.equal(audio.data, 'BBBB');
    const single = fake.calls.filter((c) => c.method === 'GET' && c.wanted === '1');
    assert.equal(single.length, 2, '兩次單筆抓取，不重新 hydrate 整張表');
});

test('Supabase 資料層：同一個實例在 ttl 內只抓一次（一次頁面載入打好幾支 API 不會每次都打資料庫）', async (t) => {
    const fake = withFake(t);
    const store = createSupabaseStore({ url: 'https://example.supabase.co', key: 'k' });
    await store.hydrate();
    const afterFirst = fake.calls.filter((c) => c.method === 'GET').length;

    await store.hydrate();   /* 第二個請求：ttl 內 → 用快取，不再查 */
    assert.equal(fake.calls.filter((c) => c.method === 'GET').length, afterFirst, 'ttl 內不該再查資料庫');

    /* 自己寫入成功後也算「剛更新」，不該馬上去重抓 */
    store.createBook({ code: 'B9', name: 'Book 9', sort_order: 9, is_published: true });
    await store.flush();
    const afterWrite = fake.calls.filter((c) => c.method === 'GET').length;
    await store.hydrate();
    assert.equal(fake.calls.filter((c) => c.method === 'GET').length, afterWrite, '寫入後仍不該重抓');
});

test('Supabase 資料層：ttl 設 0 就每個請求都重抓（要即時性時用）', async (t) => {
    const fake = withFake(t);
    const store = createSupabaseStore({ url: 'https://example.supabase.co', key: 'k', hydrateTtlMs: 0 });
    await store.hydrate();
    const afterFirst = fake.calls.filter((c) => c.method === 'GET').length;
    await store.hydrate();
    assert.ok(fake.calls.filter((c) => c.method === 'GET').length > afterFirst, 'ttl=0 應該重新抓');
});

test('Supabase 後端：/api/version 不碰資料庫（原本要等 7 個查詢，一次 2～5 秒）', async (t) => {
    const fake = withFake(t);
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'supabase-test-secret';
    const { createApp } = require('../server');
    const app = createApp({ backend: 'supabase', url: 'https://example.supabase.co', key: 'k' });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => { try { server.close(); } catch (err) { /* 已關閉 */ } });

    const before = fake.calls.length;
    const res = await fetch(`${base}/api/version`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).version, require('../package.json').version);
    assert.equal(fake.calls.length, before, '/api/version 不該有任何資料庫查詢');
});

test('Supabase 後端跑起整個 app：API 寫入的資料真的進資料庫（hydrate → 同步路由 → flush）', async (t) => {
    const fake = withFake(t);
    fake.seedUsers([
        { id: 1, username: 'manager', display_name: '網頁管理員', role: 'admin', is_active: true, password_hash: hashPassword('pass1234') },
        { id: 2, username: 'teacher', display_name: '英文老師', role: 'teacher', is_active: true, password_hash: hashPassword('pass1234') }
    ]);

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'supabase-test-secret';
    const { createApp } = require('../server');
    const app = createApp({ backend: 'supabase', url: 'https://example.supabase.co', key: 'k' });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => { try { server.close(); } catch (err) { /* 已關閉 */ } });

    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.backend, 'supabase');
    assert.equal(health.data_file, null);

    const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'manager', password: 'pass1234' })
    });
    if (login.status !== 200) console.log('DEBUG login body:', JSON.stringify(await login.clone().text()));
    assert.equal(login.status, 200);
    const cookie = (typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [])
        .map((line) => line.split(';')[0]).join('; ');

    const created = await fetch(`${base}/api/books`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ grade: 'S1' })
    });
    assert.equal(created.status, 201);
    const book = (await created.json()).book;
    assert.ok(book.id > 0, '回給前端的 id 要是真的 id');
    assert.equal(book.grade, 'S1', '對外只給年級');
    assert.equal(book.name, undefined, '書名不可以出現在 API 回應裡');

    assert.equal(fake.db.dict_books.length, 1, '書本要真的寫進（假）資料庫');
    assert.equal(fake.db.dict_books[0].grade, 'S1');
    assert.equal(fake.db.dict_books[0].name, 'S1', '內部 name 與年級同步（但不對外）');
    assert.equal(fake.db.dict_books[0].id, book.id);
    assert.equal(fake.db.dict_audit_logs.filter((r) => r.action === 'BOOK_CREATE').length, 1, '稽核也要一起寫進去');

    const unit = await fetch(`${base}/api/books/${book.id}/units`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ unit_no: 1, title: 'Finding the Ideal Job' })
    });
    assert.equal(unit.status, 201);
    assert.equal(fake.db.dict_units[0].book_id, book.id, '單元的外鍵指向正確的書本');

    /* 每個請求都重新 hydrate：第二個請求看得到第一個請求寫進去的東西 */
    const list = await (await fetch(`${base}/api/books/${book.id}/units`)).json();
    assert.equal(list.units.length, 1);
    assert.equal(list.book.grade, 'S1', '書本資訊只回年級');
    assert.equal(list.book.name, undefined, '書名不出現在任何 API 回應裡');
});

test('Supabase 後端：寫回失敗時回 500，並帶上真正的原因（details.message）', async (t) => {
    /* 這段是回歸測試：使用者上傳書本封面時，線上 500，但畫面只顯示「{message}」——
     * 兩個問題各自都要被擋住：① 後端要把原因放進 details ② 前端不能把佔位符原樣印出來 */
    const fake = withFake(t);
    fake.seedUsers([
        { id: 1, username: 'manager', display_name: '網頁管理員', role: 'admin', is_active: true, password_hash: hashPassword('pass1234') }
    ]);

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'supabase-test-secret';
    const { createApp } = require('../server');
    const app = createApp({ backend: 'supabase', url: 'https://example.supabase.co', key: 'k' });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => { try { server.close(); } catch (err) { /* 已關閉 */ } });

    const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'manager', password: 'pass1234' })
    });
    assert.equal(login.status, 200);
    const cookie = (typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [])
        .map((line) => line.split(';')[0]).join('; ');

    fake.flags.failWrites = true;
    fake.flags.failMessage = 'column "cover_data" of relation "dict_books" does not exist';

    const res = await fetch(`${base}/api/books`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ grade: 'S9' })          /* v0.5.0：建書只需要年級 */
    });
    assert.equal(res.status, 500, '寫回失敗不能假裝成功');
    const body = await res.json();
    assert.equal(body.code, 'DB_WRITE_FAILED');
    assert.ok(body.details && body.details.message, '要帶上真正的原因，否則使用者只會看到 {message}');
    assert.match(body.details.message, /cover_data/);

    /* 失敗後記憶體不可以留著假資料：下一個請求要看到資料庫的真實狀態 */
    fake.flags.failWrites = false;
    const after = await (await fetch(`${base}/api/books`)).json();
    assert.deepEqual(after.books, [], '失敗的寫入不能留在記憶體裡');
});
