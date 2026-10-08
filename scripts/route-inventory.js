#!/usr/bin/env node
/* 路由清單快照（E-1 的一半；另一半是 tests/route-inventory.test.js 與 tests/route-coverage.test.js）
 *
 * 為什麼要有：Express 依「註冊順序」比對路由 —— 順序錯了不會報錯，會被前面的 catch-all 攔走。
 * 所以「有哪些路由、什麼順序、幾層中間件」就是最便宜的守門：重構時它必須保持不變。
 *
 * 用法：
 *   node scripts/route-inventory.js          只印出來
 *   node scripts/route-inventory.js --write  更新 tests/fixtures/route-inventory.json
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'route-inventory';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../server');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'route-inventory.json');

function collect() {
    const dataFile = path.join(os.tmpdir(), 'pv-route-inventory.json');
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

function main() {
    const snapshot = collect();
    if (process.argv.includes('--write')) {
        fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
        fs.writeFileSync(FIXTURE, `${JSON.stringify(snapshot, null, 4)}\n`);
        console.log(`已寫入 ${path.relative(ROOT, FIXTURE)}（${snapshot.routes.length} 條路由、${snapshot.counts.layers} 層）`);
        return;
    }
    console.log(`路由 ${snapshot.routes.length} 條｜層 ${snapshot.counts.layers}`);
    for (const route of snapshot.routes) console.log(`  ${route}`);
}

main();
