/* 資料層與批次匯入解析的單元測試 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStore, normalizeHeadword } = require('../lib/store');
const { parseImportText } = require('../server').__test__;

function tempFile(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-store-'));
    return path.join(dir, name);
}

test('生字正規化：大小寫、前後空白、多個空白都視為同一個字', () => {
    assert.equal(normalizeHeadword('  Apple '), 'apple');
    assert.equal(normalizeHeadword('break   the   ice'), 'break the ice');
    assert.equal(normalizeHeadword(null), '');
});

test('JSON 資料層：建立書本／單元／生字，重新載入後仍在', () => {
    const file = tempFile('store.json');
    const store = createStore({ backend: 'json', dataFile: file });
    const book = store.createBook({ code: 'B1', name: 'Book 1', sort_order: 1, is_published: true });
    const unit = store.createUnit({ book_id: book.id, unit_no: 1, title: 'Hello', sort_order: 1, is_published: true });
    const entry = store.createEntry({
        unit_id: unit.id,
        headword: 'Apple',
        headword_norm: normalizeHeadword('Apple'),
        zh_meaning: '蘋果',
        status: 'published',
        sort_order: 1
    });
    assert.equal(entry.id, 1);
    assert.equal(store.countEntries(unit.id, ['published']), 1);

    const reloaded = createStore({ backend: 'json', dataFile: file });
    assert.equal(reloaded.listBooks().length, 1);
    assert.equal(reloaded.getEntry(entry.id).headword, 'Apple');
    assert.equal(reloaded.findEntryByHeadword(unit.id, 'apple').id, entry.id);
});

test('JSON 資料層：未發佈的書本／單元預設不出現在清單', () => {
    const file = tempFile('store.json');
    const store = createStore({ backend: 'json', dataFile: file });
    const hiddenBook = store.createBook({ code: 'X', name: '草稿書', sort_order: 2, is_published: false });
    const liveBook = store.createBook({ code: 'Y', name: '正式書', sort_order: 1, is_published: true });
    store.createUnit({ book_id: hiddenBook.id, unit_no: 1, is_published: true, sort_order: 1 });
    store.createUnit({ book_id: liveBook.id, unit_no: 1, is_published: false, sort_order: 1 });

    assert.deepEqual(store.listBooks().map((b) => b.code), ['Y']);
    assert.equal(store.listBooks({ includeUnpublished: true }).length, 2);
    assert.equal(store.listUnits({ bookId: liveBook.id }).length, 0);
    assert.equal(store.listUnits({ bookId: liveBook.id, includeUnpublished: true }).length, 1);
});

test('JSON 資料層：刪除生字會一併清掉它的錄音', () => {
    const file = tempFile('store.json');
    const store = createStore({ backend: 'json', dataFile: file });
    const entry = store.createEntry({ headword: 'test', headword_norm: 'test', status: 'published', sort_order: 1 });
    store.createAudio({ entry_id: entry.id, source: 'teacher', mime: 'audio/webm', bytes: 10, data: 'AAAA' });
    assert.equal(store.listAudio({ entryId: entry.id }).length, 1);
    store.deleteEntry(entry.id);
    assert.equal(store.listAudio({ entryId: entry.id }).length, 0);
});

test('JSON 資料層：稽核列表用「最新的在最前面」排序並支援關鍵字', () => {
    const file = tempFile('store.json');
    const store = createStore({ backend: 'json', dataFile: file });
    store.insertAuditLog({ user_id: 'a', action: 'ENTRY_CREATE', details: 'apple', created_at: '2026-10-01T00:00:00.000Z' });
    store.insertAuditLog({ user_id: 'b', action: 'ENTRY_DELETE', details: 'banana', created_at: '2026-10-02T00:00:00.000Z' });
    const all = store.listAuditLogs({ limit: 10 });
    assert.equal(all.total, 2);
    assert.equal(all.items[0].action, 'ENTRY_DELETE');
    const filtered = store.listAuditLogs({ limit: 10, q: 'apple' });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.items[0].action, 'ENTRY_CREATE');
});

test('批次匯入解析：Tab 分隔、兩個以上空白、逗號都吃得下', () => {
    const text = [
        'apple\t/ˈæp.əl/\tn.\t蘋果\ta round fruit',
        'banana  /bəˈnɑː.nə/  n.  香蕉  a long yellow fruit',
        'cherry,/ˈtʃer.i/,n.,櫻桃,a small red fruit',
        '只有生字'
    ].join('\n');
    const { rows, errors } = parseImportText(text);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].headword, 'apple');
    assert.equal(rows[0].ipa_us, '/ˈæp.əl/');
    assert.equal(rows[1].zh_meaning, '香蕉');
    assert.equal(rows[2].en_definition, 'a small red fruit');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].line, 4);
});

test('批次匯入解析：空行不算錯誤，全空回 0 筆', () => {
    assert.equal(parseImportText('\n\n   \n').rows.length, 0);
    assert.equal(parseImportText('').rows.length, 0);
});

test('未知的資料後端要明確報錯，不要靜默降級', () => {
    assert.throws(() => createStore({ backend: 'mysql' }), (err) => {
        assert.match(String(err.message), /未知的 DATA_BACKEND/);
        assert.equal(err.code, 'UNKNOWN_BACKEND');
        return true;
    });
    /* supabase 已經實作（不再「尚未實作」）：佔位值要當場拒絕，不要用猜得到的金鑰跑起來 */
    assert.throws(() => createStore({
        backend: 'supabase', url: 'https://example.supabase.co', key: 'REPLACE_ME_WITH_REAL_KEY'
    }), (err) => {
        assert.equal(err.code, 'SUPABASE_CONFIG_PLACEHOLDER');
        return true;
    });
});
