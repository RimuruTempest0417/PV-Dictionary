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
/* ★ v0.6.1：假 PostgREST 要拿這份清單擋「不存在的欄位」——真實的 PostgREST 就是這樣（42703） */
const { EXPECTED_COLUMNS } = require('../lib/schema');
const { hashPassword } = require('../lib/passwords');

const TABLES = ['dict_books', 'dict_units', 'dict_entries', 'dict_audio', 'dict_users', 'dict_grants', 'dict_audit_logs'];

/* 極簡假 PostgREST：只支援本專案用到的查詢形狀（select=*、id=eq.<n>） */
function fakeSupabase() {
    const db = {};
    for (const name of TABLES) db[name] = [];
    const calls = [];
    const flags = { failWrites: false, failMessage: '', failRpc: false, dbSize: 12345678 };
    const originalFetch = global.fetch;

    function tableOf(pathname) {
        return pathname.split('/').pop();
    }


    /* ★ v0.6.1：真實 PostgREST 對「不存在的欄位」會回 42703：
     *   Could not find the '<欄位>' column of '<表>' in the schema cache
     *   假的不擋 → 本機全綠、線上直接 500（v0.6.0 的 dict_audit_logs.updated_at 就是這樣爆的）。
     *   這裡照樣擋，而且是回一樣的形狀。 */
    function unknownColumn(table, body) {
        if (!body || typeof body !== 'object') return null;
        const allowed = EXPECTED_COLUMNS[String(table).replace(/^dict_/, '')];
        if (!allowed) return null;
        for (const key of Object.keys(body)) {
            if (!allowed.includes(key)) return key;
        }
        return null;
    }

    function schemaError(table, column) {
        return {
            ok: false,
            status: 400,
            text: async () => JSON.stringify({
                message: `Could not find the '${column}' column of '${table}' in the schema cache`,
                code: '42703'
            })
        };
    }

    global.fetch = async (url, init = {}) => {
        const parsed = new URL(url);
        /* 只攔 Supabase 的請求；測試自己打本機 server 的 fetch 要放行 */
        if (parsed.hostname !== 'example.supabase.co') return originalFetch(url, init);
        const method = init.method || 'GET';
        /* ★ v0.7.0（D-1c／D-6）：PostgREST 的函式呼叫 —— POST /rest/v1/rpc/<函式名>。
         *   真實 PostgREST 找不到函式時回 404 + PGRST202（schema cache 裡沒有），這裡照樣模擬，
         *   否則「函式沒建好」這種線上才會爆的錯在本機永遠看不到。 */
        const rpcHit = /\/rest\/v1\/rpc\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(parsed.pathname);
        if (rpcHit) {
            const fn = rpcHit[1];
            const args = init.body ? JSON.parse(init.body) : null;
            calls.push({ method, table: `rpc:${fn}`, rpc: fn, body: args, headers: init.headers });
            if (flags.failRpc) {
                return {
                    ok: false,
                    status: 404,
                    text: async () => JSON.stringify({
                        message: `Could not find the function public.${fn} in the schema cache`,
                        code: 'PGRST202'
                    })
                };
            }
            if (fn === 'dict_entry_counts') {
                const bucket = new Map();
                for (const row of db.dict_entries) {
                    const key = `${row.unit_id}|${row.status}`;
                    bucket.set(key, (bucket.get(key) || 0) + 1);
                }
                const rows = Array.from(bucket.entries()).map(([key, n]) => {
                    const [unit_id, status] = key.split('|');
                    return { unit_id: Number(unit_id), status, n };
                });
                return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(rows) };
            }
            if (fn === 'dict_db_size') {
                return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(flags.dbSize) };
            }
            return { ok: false, status: 404, text: async () => JSON.stringify({ message: `unknown rpc ${fn}`, code: 'PGRST202' }) };
        }
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
            /* v0.6.1：視窗化資料層會用 in.(1,2,3) 這種篩選、也會要 count */
            const inFilters = [];
            for (const [key, value] of parsed.searchParams.entries()) {
                if (!value.startsWith('in.(')) continue;
                const ids = value.slice(4, -1).split(',').map((item) => item.trim());
                inFilters.push({ key, ids });
            }
            const limit = Number(parsed.searchParams.get('limit')) || null;
            const offset = Number(parsed.searchParams.get('offset')) || 0;
            let matched = wanted ? db[table].filter((r) => String(r.id) === String(wanted)) : db[table].slice();
            for (const filter of inFilters) {
                matched = matched.filter((row) => filter.ids.includes(String(row[filter.key])));
            }
            /* Ordering matters: the windowed store picks the next id with order=id.desc&limit=1,
             * and the real PostgREST sorts. Without sorting here the fake returns row #1 and the
             * store hands out duplicate ids (this is exactly what broke the app-level test). */
            const order = parsed.searchParams.get('order');
            if (order) {
                for (const clause of order.split(',').reverse()) {
                    const [column, dirRaw] = clause.split('.');
                    const dir = String(dirRaw || 'asc').toLowerCase().startsWith('desc') ? -1 : 1;
                    matched = matched.slice().sort((a, b) => {
                        const av = a[column];
                        const bv = b[column];
                        if (av === bv) return 0;
                        if (av === undefined || av === null) return 1;
                        if (bv === undefined || bv === null) return -1;
                        return (av < bv ? -1 : 1) * dir;
                    });
                }
            }
            const total = matched.length;
            const rows = matched.slice(offset, limit === null ? undefined : offset + limit).map(picked);
            const headers = { get: (name) => (String(name).toLowerCase() === 'content-range' ? `0-${Math.max(0, rows.length - 1)}/${total}` : null) };
            return { ok: true, status: 200, headers, text: async () => JSON.stringify(rows) };
        }
        if (method === 'POST') {
            const badColumn = unknownColumn(table, body);
            if (badColumn) return schemaError(table, badColumn);
            const row = Object.assign({}, body);
            if (row.id === undefined || row.id === null) {
                row.id = db[table].reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1;
            }
            if (db[table].some((r) => String(r.id) === String(row.id))) {
                return { ok: false, status: 409, text: async () => JSON.stringify({ message: 'duplicate key value violates unique constraint' }) };
            }
            db[table].push(row);
            return { ok: true, status: 201, headers: { get: () => null }, text: async () => JSON.stringify([row]) };
        }
        if (method === 'PATCH') {
            const badColumn = unknownColumn(table, body);
            if (badColumn) return schemaError(table, badColumn);
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
    if (created.status !== 201) console.log('DEBUG book body:', JSON.stringify(await created.clone().text()));
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


test('v0.6.1 回歸：沒有 updated_at 欄位的表，寫入時不可以帶 updated_at（線上 42703 的元凶）', async () => {
    const fake = fakeSupabase();
    const store = createSupabaseStore({ url: 'https://example.supabase.co', key: 'test-key', hydrateTtlMs: 0 });
    await store.hydrate();

    /* 寫一筆稽核（登入時就會產生）→ 假 PostgREST 會比照真實的 PostgREST 擋未知欄位 */
    store.insertAuditLog({
        user_id: 1, display_name: 'T', role: 'admin', action: 'LOGIN', target_id: null,
        details: '測試', ip: '127.0.0.1', created_at: new Date().toISOString(), is_self_test: false
    });
    await store.flush();

    const posts = fake.calls.filter((call) => call.method === 'POST' && call.table === 'dict_audit_logs');
    assert.equal(posts.length, 1);
    assert.equal('updated_at' in posts[0].body, false, '稽核紀錄沒有 updated_at 欄位，寫了線上會 42703');

    /* 有 updated_at 的表（生字）反過來要帶，否則樂觀鎖對新資料失效 */
    const book = store.createBook({ code: 'X', name: 'X', grade: 'X', sort_order: 1, is_published: true });
    const unit = store.createUnit({ book_id: book.id, unit_no: 1, title: 'U', sort_order: 1, is_published: true });
    store.createEntry({ unit_id: unit.id, headword: 'apple', headword_norm: 'apple', status: 'published', sort_order: 1, created_by: 't' });
    await store.flush();
    const entryPost = fake.calls.filter((call) => call.method === 'POST' && call.table === 'dict_entries').pop();
    assert.ok(entryPost.body.updated_at, '生字要帶 updated_at（樂觀鎖要用）');

    fake.restore();
    assert.equal(store.backend, 'supabase');
});

test('v0.6.1：HAS_UPDATED_AT 與 schema 清單一致（欄位有無的唯一來源）', () => {
    const { HAS_UPDATED_AT, EXPECTED_COLUMNS } = require('../lib/schema');
    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
        assert.equal(HAS_UPDATED_AT.has(table), columns.includes('updated_at'), `${table} 的判斷與清單不一致`);
    }
    /* 稽核／音檔／授權三張表確實沒有這個欄位（有測試盯著，未來若要加就要寫遷移檔） */
    for (const table of ['audit_logs', 'audio', 'grants']) {
        assert.equal(HAS_UPDATED_AT.has(table), false, `${table} 不應該被當成有 updated_at`);
    }
});


/* ============================================================
 * v0.6.1（D-1b）視窗化資料層
 * ============================================================ */

test('視窗化資料層：看一個單元不會把整張生字表抓下來，而且沒載入的範圍會大聲失敗', async () => {
    const fake = fakeSupabase();
    /* 先用 full 模式把資料準備好（模擬資料庫已經有兩本、兩個單元、各 3 個生字） */
    const seedStore = createSupabaseStore({ url: 'https://example.supabase.co', key: 'k', hydrateTtlMs: 0 });
    await seedStore.hydrate({ full: true });
    const book = seedStore.createBook({ code: 'B', name: 'B', grade: 'S1', sort_order: 1, is_published: true });
    const unitA = seedStore.createUnit({ book_id: book.id, unit_no: 1, title: 'A', sort_order: 1, is_published: true });
    const unitB = seedStore.createUnit({ book_id: book.id, unit_no: 2, title: 'B', sort_order: 2, is_published: true });
    for (const [unit, tag] of [[unitA, 'a'], [unitB, 'b']]) {
        for (let i = 1; i <= 3; i += 1) {
            seedStore.createEntry({
                unit_id: unit.id, headword: `${tag}${i}`, headword_norm: `${tag}${i}`,
                status: 'published', sort_order: i, created_by: 'seed'
            });
        }
    }
    await seedStore.flush();

    /* 接著用「請求模式」跑一次：只看單元 A */
    const store = createSupabaseStore({ url: 'https://example.supabase.co', key: 'k', hydrateTtlMs: 0 });
    const context = store.attach();
    await store.hydrate({ full: false });
    await store.runWithContext(context, async () => {
        await store.prefetch({ method: 'GET', path: `/units/${unitA.id}`, query: {}, body: {} });
    });

    const callsBefore = fake.calls.length;
    let rows = [];
    let missing = null;
    store.runWithContext(context, () => {
        rows = store.listEntries({ unitId: unitA.id });
        try {
            store.listEntries({ unitId: unitB.id });          /* 沒有載入的單元 → 應該拋錯 */
        } catch (err) {
            missing = err;
        }
    });

    assert.equal(rows.length, 3, '單元 A 的 3 個生字要看得到');
    assert.equal(rows.every((row) => String(row.unit_id) === String(unitA.id)), true, '不可以混到別的單元');
    assert.ok(missing, '沒有載入的範圍要拋錯，不能靜默回空');
    assert.equal(missing.code, 'STORE_WINDOW_MISSING');

    /* 關鍵：這一段沒有再打任何資料庫（不含整表查詢），而且抓的是單元範圍 */
    const windowCalls = fake.calls.slice(callsBefore);
    assert.equal(windowCalls.filter((call) => call.table === 'dict_entries').length, 0, '讀取時不應該再打資料庫');
    assert.equal(store.planFor({ method: 'GET', path: `/units/${unitA.id}` }).entryUnits.has(String(unitA.id)), true);
    assert.equal(store.planFor({ method: 'GET', path: `/units/${unitA.id}` }).entryUnits.size, 1, '只抓被指定的那一個單元');
    assert.equal(store.planFor({ method: 'GET', path: '/admin/stats' }).counts, true, '統計頁只抓計數');

    fake.restore();
});

test('視窗化資料層：統計與書架用計數，不需要生字內容', async () => {
    const fake = fakeSupabase();
    const seedStore = createSupabaseStore({ url: 'https://example.supabase.co', key: 'k', hydrateTtlMs: 0 });
    await seedStore.hydrate({ full: true });
    const book = seedStore.createBook({ code: 'B', name: 'B', grade: 'S1', sort_order: 1, is_published: true });
    const unit = seedStore.createUnit({ book_id: book.id, unit_no: 1, title: 'A', sort_order: 1, is_published: true });
    for (let i = 1; i <= 5; i += 1) {
        seedStore.createEntry({
            unit_id: unit.id, headword: `w${i}`, headword_norm: `w${i}`,
            status: i <= 3 ? 'published' : 'pending', sort_order: i, created_by: 'seed'
        });
    }
    await seedStore.flush();
    const allRows = fake.calls.filter((call) => call.method === 'POST' && call.table === 'dict_entries').length;
    assert.equal(allRows, 5);

    const store = createSupabaseStore({ url: 'https://example.supabase.co', key: 'k', hydrateTtlMs: 0 });
    const context = store.attach();
    await store.hydrate({ full: false });
    await store.runWithContext(context, () => store.prefetch({ method: 'GET', path: '/books', query: {}, body: {} }));

    store.runWithContext(context, () => {
        assert.deepEqual(store.countAllEntries(), { total: 5, published: 3, pending: 2, rejected: 0 });
        assert.equal(store.countEntries(unit.id, ['published']), 3);
        assert.equal(store.countEntries(unit.id, null), 5);
    });

    /* 生字內容沒被搬進來：manifest 裡的生字工作集是空的 */
    assert.equal(context.entries.length, 0, '只看書架不應該把生字搬進記憶體');
    fake.restore();
});


/* ============================================================
 * v0.7.0：D-1c（資料庫聚合）與 D-6（容量月檢）
 * ============================================================ */

test('v0.7.0（D-1c）：生字數改走資料庫聚合，不再抓 unit_id,status 回來自己算', async (t) => {
    const fake = withFake(t);
    /* 先用 full 模式把資料準備好：一個單元、一個已發佈、一個待審核 */
    const seed = createSupabaseStore({ url: 'https://example.supabase.co', key: 'k', hydrateTtlMs: 0 });
    await seed.hydrate({ full: true });
    const book = seed.createBook({ grade: 'S1', sort_order: 1, is_published: true });
    const unit = seed.createUnit({ book_id: book.id, unit_no: 1, title: 'U1', sort_order: 1, is_published: true });
    seed.createEntry({ unit_id: unit.id, headword: 'apple', headword_norm: 'apple', status: 'published', sort_order: 1, created_by: 't' });
    seed.createEntry({ unit_id: unit.id, headword: 'banana', headword_norm: 'banana', status: 'pending', sort_order: 2, created_by: 't' });
    await seed.flush();

    const store = createSupabaseStore({ url: 'https://example.supabase.co', key: 'k', hydrateTtlMs: 0 });
    const context = store.attach();
    await store.hydrate({ full: false });
    fake.calls.length = 0;
    await store.runWithContext(context, () => store.prefetch({ method: 'GET', path: '/admin/stats', query: {}, body: {} }));

    const rpcCalls = fake.calls.filter((call) => call.rpc === 'dict_entry_counts');
    assert.equal(rpcCalls.length, 1, '生字數要用 rpc 呼叫 dict_entry_counts()');
    assert.equal(rpcCalls[0].method, 'POST', 'PostgREST 的函式呼叫是 POST /rest/v1/rpc/<函式>');
    /* ★ 這一條就是 D-1c 的目的：不再搬「每列兩個欄位」回來自己 bucket */
    const legacy = fake.calls.filter((call) => String(call.select || '').includes('unit_id,status'));
    assert.deepEqual(legacy, [], '不可以再抓 unit_id,status 回來自己算（那正是要省掉的搬運量）');

    /* 回傳形狀與以前一樣 → countEntries()／countAllEntries() 不用改 */
    store.runWithContext(context, () => {
        assert.equal(store.countAllEntries().total, 2);
        assert.equal(store.countEntries(unit.id, ['published']), 1);
        assert.equal(store.countEntries(unit.id, ['pending']), 1);
    });
});

test('v0.7.0（D-6）：/health 回真實資料庫大小與百分比；函式不存在時誠實說「不知道」', async (t) => {
    const fake = withFake(t);
    const store = createSupabaseStore({ url: 'https://example.supabase.co', key: 'k', hydrateTtlMs: 0 });
    const context = store.attach();
    await store.hydrate({ full: false });

    /* ① 正常：約 11.77MB → 2.4%，不警告 */
    fake.flags.dbSize = 12345678;
    await store.runWithContext(context, () => store.prefetch({ method: 'GET', path: '/health', query: {}, body: {} }));
    const ok = store.runWithContext(context, () => store.dbUsage());
    assert.equal(ok.available, true);
    assert.equal(ok.bytes, 12345678);
    assert.equal(ok.percent, 2.4);
    assert.equal(ok.warn, false);
    assert.equal(ok.warn_percent, 70, '門檻來自 lib/limits.js（使用者指定的 70%）');
    assert.match(String(ok.source), /dict_db_size/);

    /* ② 剛好 70%：要算超標（門檻是 ≥，留時間清資料） */
    fake.flags.dbSize = Math.round(500 * 1024 * 1024 * 0.7);
    await store.runWithContext(context, () => store.prefetch({ method: 'GET', path: '/health', query: {}, body: {} }));
    const hot = store.runWithContext(context, () => store.dbUsage());
    assert.equal(hot.percent, 70);
    assert.equal(hot.warn, true);

    /* ③ 函式還沒建立（PostgREST 回 PGRST202）：available:false＋原因，不可以回 0 */
    fake.flags.failRpc = true;
    await store.runWithContext(context, () => store.prefetch({ method: 'GET', path: '/health', query: {}, body: {} }));
    const unknown = store.runWithContext(context, () => store.dbUsage());
    assert.equal(unknown.available, false);
    assert.equal(unknown.bytes, null);
    assert.equal(unknown.percent, null);
    assert.match(String(unknown.reason), /PGRST202|schema cache/);
    fake.flags.failRpc = false;
});
