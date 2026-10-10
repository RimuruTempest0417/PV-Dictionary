/* v0.13.0（B-9／F-5）學生端兩個篩選的端到端測試：
 *   ?missing_zh=1  → 只回沒有中文解釋的生字
 *   ?ids=1,2,3     → 只回這些生字（「我的清單」）
 * 這一組測試守的是「誠實」：篩選一定要在**伺服器端**做（生字表是分頁的，
 * 畫面只看得到已載入的那一頁），而且帶了不合法的 ids 要回空清單、不能變成「整個單元」。
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
    store.createUser({
        username: 'teacher', display_name: '英文老師', role: 'teacher',
        password_hash: hashPassword(PASSWORD), is_active: true
    });
    const book = store.createBook({ code: 'B5A', name: 'Book 5A', grade: 'S1', sort_order: 1, is_published: true });
    const unit = store.createUnit({ book_id: book.id, unit_no: 1, title: 'My New School', sort_order: 1, is_published: true });
    const make = (headword, zh, order) => store.createEntry({
        unit_id: unit.id, headword, headword_norm: headword.toLowerCase(), ipa_us: '/x/',
        part_of_speech: 'n.', zh_meaning: zh, en_definition: `${headword} definition`,
        status: 'published', sort_order: order, created_by: 'seed'
    });
    /* 四個生字：兩個有中文、一個空字串、一個 null（兩種「沒有中文」的寫法都要抓到） */
    const campus = make('campus', '校園', 1);
    const library = make('library', '圖書館', 2);
    const blank = make('blankzh', '', 3);
    const nul = make('nullzh', null, 4);
    return { book, unit, campus, library, blank, nul };
}

function startServer(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-filters-'));
    const app = createApp({ backend: 'json', dataFile: path.join(dir, 'store.json') });
    const ids = seedStore(app.locals.store);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => {
        try { server.close(); } catch (err) { /* 已關閉 */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* 忽略 */ }
    });
    return { app, base, ids };
}

async function api(base, url, options = {}) {
    const headers = {};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.cookie) headers.Cookie = options.cookie;
    const res = await fetch(`${base}${url}`, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json().catch(() => null) : null;
    return { status: res.status, data, headers: res.headers };
}

async function login(base, username, password = PASSWORD) {
    const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    return { cookie: setCookies.map((line) => line.split(';')[0]).join('; ') };
}

test('F-5：?missing_zh=1 只回沒有中文解釋的生字（空字串與 null 都算）', async (t) => {
    const { base, ids } = startServer(t);
    const all = await api(base, `/api/units/${ids.unit.id}`);
    assert.equal(all.data.entries.length, 4, '不帶篩選時四個生字都在');
    assert.equal(all.data.total, 4);

    const missing = await api(base, `/api/units/${ids.unit.id}?missing_zh=1`);
    assert.equal(missing.status, 200);
    assert.deepEqual(missing.data.entries.map((e) => e.headword).sort(), ['blankzh', 'nullzh']);
    assert.equal(missing.data.total, 2, 'total 要反映篩選後的筆數（不是單元總數）');

    /* 有中文的那兩個一定不在 */
    const heads = missing.data.entries.map((e) => e.headword);
    assert.ok(!heads.includes('campus') && !heads.includes('library'));
});

test('F-5：missing_zh 可以和搜尋疊加（兩者都要成立）', async (t) => {
    const { base, ids } = startServer(t);
    const hit = await api(base, `/api/units/${ids.unit.id}?missing_zh=1&q=nullzh`);
    assert.equal(hit.data.entries.length, 1);
    assert.equal(hit.data.entries[0].headword, 'nullzh');

    const miss = await api(base, `/api/units/${ids.unit.id}?missing_zh=1&q=campus`);
    assert.equal(miss.data.entries.length, 0, 'campus 有中文，兩個條件不能變成「或」');
});

test('F-5：?ids=… 只回清單裡的字（我的清單）', async (t) => {
    const { base, ids } = startServer(t);
    const two = await api(base, `/api/units/${ids.unit.id}?ids=${ids.campus.id},${ids.library.id}`);
    assert.equal(two.status, 200);
    assert.deepEqual(two.data.entries.map((e) => e.headword).sort(), ['campus', 'library']);
    assert.equal(two.data.total, 2);

    /* 別的單元的 id（或根本不存在）不會被帶進來 */
    const stray = await api(base, `/api/units/${ids.unit.id}?ids=${ids.campus.id},999999`);
    assert.deepEqual(stray.data.entries.map((e) => e.headword), ['campus']);
});

test('F-5：ids 不合法時回空清單，不是「整個單元」', async (t) => {
    const { base, ids } = startServer(t);
    const bad = await api(base, `/api/units/${ids.unit.id}?ids=abc,xyz`);
    assert.equal(bad.status, 200);
    assert.equal(bad.data.entries.length, 0, '看不懂的 ids 不可以退化成不篩選');
    assert.equal(bad.data.total, 0);

    /* 空字串（前端沒帶值）＝ 不篩選，維持原本行為 */
    const empty = await api(base, `/api/units/${ids.unit.id}?ids=`);
    assert.equal(empty.data.entries.length, 4);
});

test('F-5：ids 與分頁一起用時 total 是清單的筆數', async (t) => {
    const { base, ids } = startServer(t);
    const paged = await api(base, `/api/units/${ids.unit.id}?ids=${ids.campus.id},${ids.library.id},${ids.blank.id}&per_page=2&page=1`);
    assert.equal(paged.data.entries.length, 2);
    assert.equal(paged.data.total, 3);
    assert.equal(paged.data.has_more, true, '清單有 3 筆、這頁 2 筆 → 還有下一頁');
    const paged2 = await api(base, `/api/units/${ids.unit.id}?ids=${ids.campus.id},${ids.library.id},${ids.blank.id}&per_page=2&page=2`);
    assert.equal(paged2.data.entries.length, 1);
    assert.equal(paged2.data.has_more, false);
});

test('F-5：新增生字時沒填中文 → 存成 NULL，但 API 一樣回空字串（前端不受影響）', async (t) => {
    const { base, ids } = startServer(t);
    const { cookie } = await login(base, 'teacher');
    const created = await api(base, `/api/units/${ids.unit.id}/entries`, {
        method: 'POST', cookie,
        body: { headword: 'nozh', en_definition: 'a word without a Chinese meaning', status: 'published' }
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.entry.zh_meaning, '');
    /* 只有 NULL 才過濾得出來（PostgREST 不吃 or= 裡的空字串條件）→ 這裡守著「存成 NULL」這個約定 */
    const stored = created.data.entry.id;
    /* 用登入身分查（老師看得到自己剛建立、可能還在待審核的生字） */
    const found = await api(base, `/api/units/${ids.unit.id}?missing_zh=1`, { cookie });
    assert.ok(found.data.entries.some((entry) => String(entry.id) === String(stored)), '剛新增、沒有中文的生字要出現在「只看沒有中文」裡');
});
