/* D-6（v0.7.0）：容量門檻與用量狀態的單元測試
 *
 * 這一組數字（500MB 配額、70% 警告）現在只存在 `lib/limits.js` 一處；
 * 這裡驗的是「算得對」與「不知道時誠實說不知道」這兩件事。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DB_QUOTA_BYTES, DB_QUOTA_MB, DB_USAGE_WARN_PERCENT, usagePercent, usageState, humanBytes } = require('../lib/limits');
const { createJsonStore } = require('../lib/store/json');

test('D-6：配額與門檻是使用者指定的數字（1GB／70%；v0.10.0 搬到 Neon 後從 500MB 改成 1GB）', () => {
    assert.equal(DB_QUOTA_MB, 1024);
    assert.equal(DB_QUOTA_BYTES, 1024 * 1024 * 1024);
    assert.equal(DB_USAGE_WARN_PERCENT, 70);
});

test('D-6：百分比換算（含四捨五入到一位小數）', () => {
    assert.equal(usagePercent(0), 0);
    assert.equal(usagePercent(DB_QUOTA_BYTES / 2), 50);
    assert.equal(usagePercent(DB_QUOTA_BYTES * 0.7), 70);
    /* 350MB + 1 byte → 70.0%（一位小數） */
    assert.equal(usagePercent(DB_QUOTA_BYTES * 0.7 + 1), 70);
    /* 0.1MB 的顆粒度：250.05MB / 500MB */
    assert.equal(usagePercent(Math.round(DB_QUOTA_BYTES * 0.5001)), 50);
    /* 不知道的數字 → null（不是 0） */
    assert.equal(usagePercent(NaN), null);
    assert.equal(usagePercent(undefined), null);
    assert.equal(usagePercent(123, 0), null);
    assert.equal(usagePercent(123, NaN), null);
});

test('D-6：剛好 70% 就要警告（門檻是「≥」）', () => {
    const at = usageState(DB_QUOTA_BYTES * 0.7, { source: 'test' });
    assert.equal(at.percent, 70);
    assert.equal(at.warn, true, '剛好 70% 必須算超標（留時間清資料）');
    const justUnder = usageState(Math.round(DB_QUOTA_BYTES * 0.699), { source: 'test' });
    assert.equal(justUnder.warn, false);
    const over = usageState(Math.round(DB_QUOTA_BYTES * 0.95), { source: 'test' });
    assert.equal(over.warn, true);
    assert.equal(over.available, true);
});

test('D-6：沒有配額或拿不到大小時，要誠實說「不知道」而不是 0', () => {
    const unknown = usageState(null, { source: 'test' });
    assert.equal(unknown.available, false);
    assert.equal(unknown.bytes, null);
    assert.equal(unknown.percent, null);
    assert.equal(unknown.warn, false);
    assert.ok(typeof unknown.reason === 'string' && unknown.reason.length > 0);
});

test('D-6：本機 JSON 後端回的是資料檔大小，沒有配額、不算百分比', () => {
    const file = path.join(os.tmpdir(), `pd-usage-${process.pid}-${Date.now()}.json`);
    const store = createJsonStore({ dataFile: file });
    store.createBook({ grade: 'S1', is_published: true, sort_order: 1 });
    const usage = store.dbUsage();
    assert.equal(usage.available, true);
    assert.equal(usage.source, 'json-file');
    assert.ok(usage.bytes > 0, `應該量到資料檔大小，得到 ${usage.bytes}`);
    assert.equal(usage.quota_bytes, null, '本機 Demo 沒有 500MB 配額');
    assert.equal(usage.percent, null);
    assert.equal(usage.warn, false);
    fs.rmSync(file, { force: true });
});

test('D-6：humanBytes 給人看的字串', () => {
    assert.equal(humanBytes(512), '512 B');
    assert.equal(humanBytes(2048), '2.0 KB');
    assert.equal(humanBytes(5 * 1024 * 1024), '5.00 MB');
    assert.equal(humanBytes(null), null);
});

test('D-6：/api/health 會回 usage（本機 JSON：量得到大小、沒有配額、不會誤報警告）', async (t) => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'usage-api-test';
    const { createApp } = require('../server');
    const http = require('node:http');
    const file = path.join(os.tmpdir(), `pd-usage-api-${process.pid}-${Date.now()}.json`);
    const app = createApp({ backend: 'json', dataFile: file });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.close();
        fs.rmSync(file, { force: true });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.ok(health.usage, '/api/health 一定要有 usage（監控要靠它看容量）');
    assert.equal(health.usage.source, 'json-file');
    assert.equal(health.usage.available, true);
    assert.equal(health.usage.quota_bytes, null, '本機 Demo 沒有配額，不可以拿 JSON 檔大小去跟 500MB 比');
    assert.equal(health.usage.percent, null);
    assert.equal(health.usage.warn, false);
    assert.equal(health.usage.warn_percent, 70);
});
