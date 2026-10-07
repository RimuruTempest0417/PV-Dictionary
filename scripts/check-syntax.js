/* 語法檢查：對所有會被執行到的 JS 檔跑 node --check
 * （本機測試與 node --check 都抓不到「模組載入時才炸」的問題，所以另外有 npm test 與 check:browser）
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = ['server.js', 'api/index.js'];

function collect(dir) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) out.push(...collect(full));
        else if (name.endsWith('.js')) out.push(full);
    }
    return out;
}

const files = [
    ...TARGETS.map((f) => path.join(ROOT, f)),
    ...collect(path.join(ROOT, 'lib')),
    ...collect(path.join(ROOT, 'public', 'js')),
    ...collect(path.join(ROOT, 'scripts')),
    ...collect(path.join(ROOT, 'tests'))
].filter((f) => fs.existsSync(f) && !f.endsWith('check-syntax.js'));

let failed = 0;
for (const file of files) {
    try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
        failed += 1;
        console.error(`❌ ${path.relative(ROOT, file)}`);
        console.error(String(err.stderr || err.message).trim());
    }
}
console.log(`語法檢查：${files.length - failed}/${files.length} 通過`);

/* 模組載入檢查：node --check 只驗語法，抓不到「載入時才炸」的問題
 * （例如在 createApp 裡面宣告函式、卻在 module 層級引用 → ReferenceError）。
 * 這一類問題 npm test 也不一定抓得到，所以在這裡先擋一次。 */
try {
    const app = require(path.join(ROOT, 'server.js'));
    if (typeof app !== 'function' || typeof app.createApp !== 'function') {
        throw new Error('server.js 必須匯出 Express app，並附帶 createApp');
    }
    const exposed = Object.keys(app.__test__ || {});
    if (!exposed.includes('parseImportText')) {
        throw new Error('server.js 沒有匯出 __test__.parseImportText（測試會拿不到）');
    }
    console.log('模組載入：server.js 載入成功，app 與測試用 export 都在');
} catch (err) {
    failed += 1;
    console.error('❌ server.js 載入失敗：', err.message);
}

process.exit(failed ? 1 : 0);
