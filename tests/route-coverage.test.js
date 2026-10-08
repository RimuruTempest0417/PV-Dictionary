/* 路由覆蓋守門（E-1 的另一半）
 *
 * 目的：**每一條後端路由至少要被一支測試提到過**。不是追求行覆蓋率，而是防止
 * 「新開了端點，卻沒有任何測試碰過它」——那條路由的權限、錯誤處理、輸入驗證全都是未驗證狀態。
 *
 * 判定方式：把路由路徑轉成正規式（`:id` → 任意一段），在 tests/**\/*.test.js 裡找有沒有實際打過。
 * 真的不需要測試的路由，寫進 ALLOWED 並註明原因（寧可有理由的例外，不要靜靜地漏掉）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'route-inventory.json');

/* 不用（或無法）由測試直接打的路由：每一條都要寫原因。目前是空的 ——
 * 也就是「每一條路由都有測試碰過」；真的需要例外時再加，並在 tests/route-coverage.test.js 的下一個測試會被檢查。 */
const ALLOWED = {};

function routePattern(route) {
    const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "[^/`'\"\\s]+");
    return new RegExp(escaped);
}

function testSources() {
    const dir = path.join(ROOT, 'tests');
    const files = [];
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (entry.name.endsWith('.test.js')) files.push(full);
        }
    };
    walk(dir);
    return files.map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
}

test('每條後端路由都被至少一支測試提到過', () => {
    const { routes } = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const sources = testSources();
    const uncovered = [];
    for (const route of routes) {
        const [, routePath] = route.split(' ');
        if (ALLOWED[route]) continue;
        const pattern = routePattern(routePath);
        const hit = sources.some((source) => pattern.test(source.text));
        if (!hit) uncovered.push(route);
    }
    assert.deepEqual(uncovered, [],
        `這些路由沒有任何測試碰過（要嘛補測試，要嘛寫進 ALLOWED 並說明原因）：\n  ${uncovered.join('\n  ')}`);
});

test('ALLOWED 裡的例外不會永遠留著（路由不存在了就要清掉）', () => {
    const { routes } = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const stale = Object.keys(ALLOWED).filter((route) => !routes.includes(route));
    assert.deepEqual(stale, [], `ALLOWED 有已不存在的路由：${stale.join('、')}`);
});
