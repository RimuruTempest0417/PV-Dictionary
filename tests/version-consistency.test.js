/* 版本一致性守門（E-2）
 *
 * 版本號現在有四處：package.json、index.html 的 <title>、index.html 的 #versionLabel、
 * 以及每個資產的 ?v=<版本>。手動改最容易漏（已經踩過：改了 package.json 忘了改 index.html，
 * 線上就出現「同一個版本兩個寫法」）。
 *
 * 這支測試把「版本只有一處真相」變成可驗證的事實，並且確認 /api/version 回的就是它。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'version-consistency-test';

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('package.json 與 index.html 的版本一致（含資產 ?v=）', () => {
    const version = pkg.version;
    assert.match(version, /^\d+\.\d+\.\d+$/, `版本格式不像語意化版本：${version}`);
    assert.ok(html.includes(`<title>PV_Dictionary v${version}</title>`),
        `index.html 的 title 不是 v${version}`);
    assert.ok(html.includes(`<span id="versionLabel">v${version}</span>`),
        `index.html 的 #versionLabel 不是 v${version}`);

    const assetVersions = [...html.matchAll(/\?v=([0-9]+\.[0-9]+\.[0-9]+)/g)].map((match) => match[1]);
    assert.ok(assetVersions.length >= 5, `index.html 的資產 ?v= 數量太少（${assetVersions.length}）`);
    const mismatched = [...new Set(assetVersions.filter((value) => value !== version))];
    assert.deepEqual(mismatched, [], `資產 ?v= 與版本不一致：${mismatched.join('、')}`);
});

test('/api/version 回的就是 package.json 的版本，且不碰資料庫', async (t) => {
    const { createApp } = require('../server');
    const http = require('node:http');
    const os = require('node:os');
    const app = createApp({ backend: 'json', dataFile: path.join(os.tmpdir(), `pv-version-${process.pid}.json`) });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/version`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.version, pkg.version);
    assert.equal(body.name, 'pv-dictionary');
});

test('README 標示的版本與程式一致', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.ok(readme.includes(`v${pkg.version}`), `README.md 沒有提到目前版本 v${pkg.version}`);
});
