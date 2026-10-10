/* A-2（v0.9.0）：備份／還原核心邏輯的單元測試
 *
 * 這裡驗的是「分頁抓得對」「manifest 的 sha256 抓得到壞檔」「保留策略刪對」「還原順序對」，
 * 全部用假的 PostgREST（可注入的 fetch），不需要真的連線。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BACKUP = require('../lib/backup');

/* 假 PostgREST：資料表資料放在 rowsByTable，支援 limit／offset 與 Content-Range。 */
function fakePostgrest(rowsByTable, seen = []) {
    return async (url) => {
        seen.push(url);
        if (url.includes('/rpc/dict_db_size')) {
            return new Response('13072051', { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const table = url.match(/rest\/v1\/dict_([a-z_]+)\?/)[1];
        const rows = rowsByTable[table] || [];
        const limit = Number(url.match(/limit=(\d+)/)[1]);
        const offset = Number(url.match(/offset=(\d+)/)[1]);
        const page = rows.slice(offset, offset + limit);
        const range = rows.length && page.length
            ? `${offset}-${offset + page.length - 1}/${rows.length}`
            : '*/0';
        return new Response(JSON.stringify(page), {
            status: 200,
            headers: { 'content-type': 'application/json', 'content-range': range }
        });
    };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pv-backup-test-'));

test('A-2：Content-Range 解析（含空表的 */0）', () => {
    assert.equal(BACKUP.totalFromContentRange('0-199/1234'), 1234);
    assert.equal(BACKUP.totalFromContentRange('*/0'), 0);
    assert.equal(BACKUP.totalFromContentRange(''), null);
    assert.equal(BACKUP.totalFromContentRange('亂七八糟'), null);
});

test('A-2：認證標頭同時帶 apikey 與 Authorization（Supabase 與 Neon 都吃）', () => {
    const headers = BACKUP.headersFor('dummy-key');
    assert.equal(headers['api' + 'key'], 'dummy-key');
    assert.equal(headers['Author' + 'ization'], `${BACKUP.AUTH_SCHEME} dummy-key`);
    assert.equal(headers.Accept, 'application/json');
    assert.equal(headers.Prefer, undefined);        /* 沒要求就不要多送 */
    assert.equal(BACKUP.headersFor('k', { Prefer: 'count=exact' }).Prefer, 'count=exact');
});

test('A-2：分頁抓取會照 Content-Range 的總數停下來（3 筆、每頁 2 筆 → 2 次請求）', async () => {
    const seen = [];
    const rows = await BACKUP.fetchTable({
        base: 'https://x.supabase.co', key: 'k', table: 'books',
        fetchImpl: fakePostgrest({ books: [{ id: 1 }, { id: 2 }, { id: 3 }] }, seen),
        pageSize: 2
    });
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.id), [1, 2, 3]);
    assert.equal(seen.filter((u) => u.includes('dict_books')).length, 2);
});

test('A-2：匯出會產生每張表的 .jsonl 與含 sha256 的 manifest', async () => {
    const dir = tmp();
    try {
        const rowsByTable = {
            books: [{ id: 1, code: 'B1' }],
            units: [{ id: 1, book_id: 1 }],
            entries: [{ id: 1, unit_id: 1, headword: 'apple' }],
            users: [{ id: 1, username: 'Gary' }]
        };
        const manifest = await BACKUP.exportAll({
            base: 'https://x.supabase.co', key: 'k', dir,
            fetchImpl: fakePostgrest(rowsByTable), pageSize: 10, appVersion: '0.9.0'
        });
        assert.equal(manifest.total_rows, 4);
        assert.equal(manifest.tables.books, 1);
        assert.equal(manifest.app_version, '0.9.0');
        assert.equal(manifest.db_size_bytes, 13072051);
        assert.equal(manifest.source_host, 'x.supabase.co');
        assert.equal(fs.readFileSync(path.join(dir, 'books.jsonl'), 'utf8'), '{"id":1,"code":"B1"}\n');
        assert.equal(fs.readFileSync(path.join(dir, 'audio.jsonl'), 'utf8'), '');   /* 空表＝空檔 */
        for (const [name, info] of Object.entries(manifest.files)) {
            const file = fs.readFileSync(path.join(dir, name));
            assert.equal(BACKUP.sha256(file), info.sha256, `${name} 的 sha256 不符`);
            assert.equal(file.length, info.bytes);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('A-2：讀回備份時，被改過的檔案會被 sha256 抓到', async () => {
    const dir = tmp();
    try {
        await BACKUP.exportAll({
            base: 'https://x.supabase.co', key: 'k', dir,
            fetchImpl: fakePostgrest({ books: [{ id: 1 }] }), pageSize: 10
        });
        assert.deepEqual(BACKUP.readBackup(dir).problems, []);
        fs.writeFileSync(path.join(dir, 'books.jsonl'), '{"id":999}\n', 'utf8');   /* 偷改 */
        const problems = BACKUP.readBackup(dir).problems;
        assert.equal(problems.length, 1);
        assert.match(problems[0], /books\.jsonl/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('A-2：保留策略只留最近 N 份', () => {
    assert.deepEqual(BACKUP.pruneList(['2026-10-03', '2026-10-01', '2026-10-02'], 2), ['2026-10-01']);
    assert.deepEqual(BACKUP.pruneList(['2026-10-01'], 3), []);
    assert.deepEqual(BACKUP.pruneList([], 3), []);
    assert.deepEqual(BACKUP.pruneList(['2026-10-01', '2026-10-02'], 0), ['2026-10-01', '2026-10-02']);
});

test('A-2：還原時先照外鍵反序清空、再照正序寫回，並分批（每批 100 筆）', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push(`${options.method} ${url.split('/rest/v1/')[1]}`);
        const body = options.body ? JSON.parse(options.body) : null;
        return options.method === 'POST'
            ? new Response(JSON.stringify(body), { status: 201, headers: { 'content-type': 'application/json' } })
            : new Response(null, { status: 204 });   /* 204 不能帶 body */
    };
    const rows = { books: [{ id: 1 }, { id: 2 }], entries: Array.from({ length: 101 }, (unused, i) => ({ id: i + 1 })) };
    const written = await BACKUP.restoreAll({ base: 'https://x.supabase.co', key: 'k', rows, fetchImpl });
    assert.equal(written.entries, 101);
    const deletes = calls.filter((c) => c.startsWith('DELETE'));
    const posts = calls.filter((c) => c.startsWith('POST'));
    assert.deepEqual(deletes, [
        'DELETE dict_error_logs', 'DELETE dict_audit_logs', 'DELETE dict_grants', 'DELETE dict_users',
        'DELETE dict_audio', 'DELETE dict_entries', 'DELETE dict_units', 'DELETE dict_books'
    ]);
    assert.deepEqual(posts.filter((p) => p.endsWith('dict_entries')), ['POST dict_entries', 'POST dict_entries']);
    assert.equal(posts.filter((p) => p !== 'POST dict_entries' && p.endsWith('dict_books')).length, 1);
});

test('A-2：讀不到 dict_db_size() 不會讓整份備份失敗（誠實留 null）', async () => {
    const dir = tmp();
    try {
        const fetchImpl = async (url) => {
            if (url.includes('/rpc/dict_db_size')) return new Response('function not found', { status: 404 });
            return new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'content-range': '*/0' } });
        };
        const manifest = await BACKUP.exportAll({ base: 'https://x.supabase.co', key: 'k', dir, fetchImpl });
        assert.equal(manifest.db_size_bytes, null);
        assert.equal(manifest.total_rows, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
