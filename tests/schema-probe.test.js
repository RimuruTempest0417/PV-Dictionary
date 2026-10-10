/* v0.10.0（搬到 Neon）：線上 schema 檢查的「探測法」單元測試
 *
 * 為什麼要有：Supabase 有 OpenAPI 規格可以比對，Neon 的 Data API **沒有**（回 404），
 * 所以改成對每張表下 `select=<欄位>&limit=0`，欄位不存在時 PostgREST 回 400／42703，
 * 訊息裡指出是哪一個欄位。這裡驗的就是「挑掉壞欄位、最後回傳的形狀」是對的。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { EXPECTED_COLUMNS, probeLiveColumns, compareWithLive } = require('../lib/schema');

/* 假 PostgREST：只認得 known 裡的欄位；遇到不認得的回 42703（跟實測的錯誤格式一樣）。 */
function fakeLive(known, seen = []) {
    return async (url) => {
        seen.push(url);
        const table = url.match(/rest\/v1\/([a-z_]+)\?/)[1];
        const wanted = decodeURIComponent(url.match(/select=([^&]+)/)[1]).split(',');
        const columns = known[table] || [];
        const bad = wanted.find((column) => !columns.includes(column));
        if (bad) {
            return new Response(JSON.stringify({
                code: '42703',
                message: `column ${table}.${bad} does not exist`,
                details: null,
                hint: null
            }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    };
}

const fullSchema = () => {
    const known = {};
    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) known[`dict_${table}`] = columns.slice();
    return known;
};

test('v0.10.0：schema 探測法 —— 全部欄位都在時，不會回報缺任何欄位', async () => {
    const definitions = await probeLiveColumns({
        url: 'https://x.example/neondb', key: 'k', fetchImpl: fakeLive(fullSchema())
    });
    assert.equal(Object.keys(definitions).length, Object.keys(EXPECTED_COLUMNS).length);
    assert.deepEqual(compareWithLive(definitions).missing, []);
});

test('v0.10.0：schema 探測法 —— 少一個欄位時，會正確指出是哪一個', async () => {
    const known = fullSchema();
    known.dict_books = known.dict_books.filter((column) => column !== 'cover_mime');
    const definitions = await probeLiveColumns({
        url: 'https://x.example/neondb', key: 'k', fetchImpl: fakeLive(known)
    });
    const missing = compareWithLive(definitions).missing;
    assert.equal(missing.length, 1);
    assert.equal(missing[0].table, 'books');
    assert.equal(missing[0].column, 'cover_mime');
});

test('v0.10.0：schema 探測法 —— 整張表不存在時，回報「線上沒有這張表」', async () => {
    const known = fullSchema();
    delete known.dict_audio;
    const fetchImpl = async (url) => {
        if (url.includes('dict_audio')) {
            return new Response(JSON.stringify({ code: '42P01', message: 'relation "public.dict_audio" does not exist' }),
                { status: 404, headers: { 'content-type': 'application/json' } });
        }
        return fakeLive(known)(url);
    };
    const definitions = await probeLiveColumns({ url: 'https://x.example/neondb', key: 'k', fetchImpl });
    const missing = compareWithLive(definitions).missing;
    assert.equal(missing.length, 1);
    assert.equal(missing[0].table, 'audio');
    assert.equal(missing[0].column, '*');
});

test('v0.10.0：schema 探測法 —— 每張表最多問「欄位數 + 1」次（不會無限迴圈）', async () => {
    const known = {};
    for (const table of Object.keys(EXPECTED_COLUMNS)) known[`dict_${table}`] = [];   /* 全部欄位都不存在 */
    const seen = [];
    await probeLiveColumns({ url: 'https://x.example/neondb', key: 'k', fetchImpl: fakeLive(known, seen) });
    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
        const calls = seen.filter((url) => url.includes(`dict_${table}?`)).length;
        assert.ok(calls <= columns.length + 1, `${table} 問了 ${calls} 次（上限 ${columns.length + 1}）`);
    }
});
