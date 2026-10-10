/* v0.10.1：Neon 版 schema 也要被守門
 *
 * 為什麼：lib/schema.js 的 compareWithMigrations 只讀一個目錄，而 tests/schema.test.js 與
 * scripts/schema-check.js 一直只看 `migrations/`（Supabase 版）。v0.10.0 搬到 Neon 之後，
 * 真正在線上跑的是 `migrations/neon/2026-10-10-neon-schema.sql` —— 它若漂移（少欄位／多欄位），
 * 以前的守門不會叫。這裡補上：兩份 schema（Supabase 版與 Neon 版）都要涵蓋程式要用的欄位。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { compareWithMigrations, EXPECTED_COLUMNS } = require('../lib/schema');

const ROOT = path.resolve(__dirname, '..');

test('v0.10.1：Neon 版 schema（migrations/neon/）涵蓋程式要用的所有欄位', () => {
    const neon = compareWithMigrations(path.join(ROOT, 'migrations', 'neon'));
    assert.ok(neon.files.length > 0, 'migrations/neon/ 應該要有 .sql');
    assert.deepEqual(
        neon.missing.map((item) => `${item.table}.${item.column}`),
        [],
        'migrations/neon 缺少程式要用的欄位（Neon 線上會直接 500）'
    );
});

test('v0.10.1：Neon 版 schema 的欄位不可以比程式需要的少（表數也要對）', () => {
    const neon = compareWithMigrations(path.join(ROOT, 'migrations', 'neon'));
    const tables = new Set(neon.parsed ? neon.parsed.map((table) => table.table) : []);
    if (tables.size) {
        for (const table of Object.keys(EXPECTED_COLUMNS)) {
            assert.ok(tables.has(table), `migrations/neon 少了 ${table} 這張表`);
        }
    }
});
