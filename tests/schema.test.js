/* schema 守門測試：程式要用的欄位，遷移檔裡一定要有。
 *
 * 由來：書本封面是 v0.2.0 的功能，但遷移檔漏了 cover_* 欄位。
 * 本機 JSON 檔不在乎欄位（測試全綠、Demo 正常），一上線 Supabase 就 500。
 * 這支測試就是為了在「還沒上線」的時候就把這種漏抓出來。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { EXPECTED_COLUMNS, compareWithMigrations, parseMigrations } = require('../lib/schema');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

test('schema：程式要用的欄位，遷移檔裡都有（忘了寫遷移檔會在這裡失敗）', () => {
    const result = compareWithMigrations(MIGRATIONS_DIR);
    const pretty = result.missing.map((item) => `${item.table}.${item.column}${item.note ? `（${item.note}）` : ''}`);
    assert.deepEqual(pretty, [], `遷移檔缺少欄位：${pretty.join('、')}`);
});

test('schema：遷移檔解析得到 7 張表，且欄位與程式清單一致', () => {
    const { tables } = parseMigrations(MIGRATIONS_DIR);
    assert.deepEqual(Object.keys(tables).sort(), Object.keys(EXPECTED_COLUMNS).sort());
});

test('schema：書本封面欄位一定在遷移檔裡（v0.3.2 補的那五個）', () => {
    const { tables } = parseMigrations(MIGRATIONS_DIR);
    for (const column of ['cover_mime', 'cover_data', 'cover_bytes', 'cover_updated_at', 'cover_by']) {
        assert.ok(tables.books.includes(column), `遷移檔缺 dict_books.${column}`);
    }
});

test('schema：封面欄位真的有被程式用到（遷移檔不是寫心酸的）', () => {
    const fs = require('fs');
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
    for (const column of ['cover_mime', 'cover_data', 'cover_bytes', 'cover_updated_at', 'cover_by']) {
        assert.ok(source.includes(column), `server.js 沒有用到 ${column}`);
    }
});
