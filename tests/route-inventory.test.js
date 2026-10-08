/* 路由清單快照守門（E-1）
 *
 * Express 依註冊順序比對路由：順序錯了不會有任何錯誤訊息，只會被前面的 catch-all 攔走。
 * 這支測試比對「現在的路由清單與順序」與 tests/fixtures/route-inventory.json：
 *   - 重構時它必須**保持不變**（不變才代表行為等價）
 *   - 真的新增／移除路由時，跑 `node scripts/route-inventory.js --write` 更新快照，並在 commit 說明原因
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'route-inventory-test';
const { createApp } = require('../server');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'route-inventory.json');

function current() {
    const dataFile = path.join(os.tmpdir(), 'pv-route-inventory-test.json');
    try { fs.rmSync(dataFile, { force: true }); } catch (err) { /* 沒有就算了 */ }
    const app = createApp({ backend: 'json', dataFile });
    const stack = (app.router && app.router.stack) || (app._router && app._router.stack) || [];
    const routes = [];
    let layers = 0;
    for (const layer of stack) {
        layers += 1;
        if (!layer.route) continue;
        const methods = Object.keys(layer.route.methods).map((name) => name.toUpperCase()).sort();
        routes.push(`${methods.join('|')} ${layer.route.path}`);
    }
    try { fs.rmSync(dataFile, { force: true }); } catch (err) { /* 沒有就算了 */ }
    return { routes, counts: { routes: routes.length, layers } };
}

test('路由清單與順序和快照一致（改動就要更新快照並說明原因）', () => {
    const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const actual = current();
    assert.deepEqual(actual.routes, expected.routes,
        '路由清單變了。若是刻意新增／移除：node scripts/route-inventory.js --write');
    assert.deepEqual(actual.counts, expected.counts, '路由數或中間件層數變了');
});

test('路由快照沒有重複項（同一條路由註冊兩次會讓前面的失效）', () => {
    const { routes } = current();
    const seen = new Set();
    const dupes = routes.filter((route) => (seen.has(route) ? true : (seen.add(route), false)));
    assert.deepEqual(dupes, [], `重複註冊：${dupes.join('、')}`);
});
