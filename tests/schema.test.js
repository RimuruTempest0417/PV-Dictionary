/* schema 守門測試：程式要用的欄位，遷移檔裡一定要有。
 *
 * 由來：書本封面是 v0.2.0 的功能，但遷移檔漏了 cover_* 欄位。
 * 本機 JSON 檔不在乎欄位（測試全綠、Demo 正常），一上線 Supabase 就 500。
 * 這支測試就是為了在「還沒上線」的時候就把這種漏抓出來。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { EXPECTED_COLUMNS, compareWithMigrations, parseMigrations } = require('../lib/schema');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

test('schema：程式要用的欄位，遷移檔裡都有（忘了寫遷移檔會在這裡失敗）', () => {
    const result = compareWithMigrations(MIGRATIONS_DIR);
    const pretty = result.missing.map((item) => `${item.table}.${item.column}${item.note ? `（${item.note}）` : ''}`);
    assert.deepEqual(pretty, [], `遷移檔缺少欄位：${pretty.join('、')}`);
});

test('schema：遷移檔解析得到 8 張表，且欄位與程式清單一致', () => {
    const { tables } = parseMigrations(MIGRATIONS_DIR);
    assert.deepEqual(Object.keys(tables).sort(), Object.keys(EXPECTED_COLUMNS).sort());
});

test('schema：書本封面欄位一定在遷移檔裡（v0.3.2 補的那五個）', () => {
    const { tables } = parseMigrations(MIGRATIONS_DIR);
    for (const column of ['cover_mime', 'cover_data', 'cover_bytes', 'cover_updated_at', 'cover_by']) {
        assert.ok(tables.books.includes(column), `遷移檔缺 dict_books.${column}`);
    }
});

test('schema：封面欄位是舊資料欄位（v0.5.0 起沒有任何端點讀寫它們）', () => {
    /* 欄位留在資料表裡（不刪欄位以免動到既有資料），但程式不該再碰它們 ——
     * 所以就連「有沒有人用到」這件事也要反過來守：出現任何讀寫就紅燈。 */
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    for (const column of ['cover_mime', 'cover_data', 'cover_bytes', 'cover_updated_at', 'cover_by']) {
        assert.equal(source.includes(column), false, `server.js 不該再用 ${column}（封面功能已移除）`);
    }
    assert.equal(/\/api\/covers/.test(source), false, '不該再有封面端點');
});

