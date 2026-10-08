#!/usr/bin/env node
/* 依賴套件弱點掃描（A-12）
 *
 * 為什麼要獨立一支：`npm audit` 需要連外，把它塞進 `npm run check` 會讓「離線也要能跑完的檢查」壞掉
 * （之前 schema 檢查就踩過同一個坑）。所以它是發版前手動跑的一步，不是每次 check 的一步。
 *
 * 用法：
 *   npm run check:deps            只看 production 依賴（部署到 Vercel 的就是這些）
 *   npm run check:deps -- --all   連開發依賴一起看
 */
const { spawnSync } = require('node:child_process');

const all = process.argv.includes('--all');
const args = ['audit', '--audit-level=high'];
if (!all) args.push('--omit=dev');

const result = spawnSync('npm', args, { stdio: 'inherit', cwd: require('node:path').resolve(__dirname, '..') });
if (result.error) {
    console.error(`✖ 跑不動 npm audit：${result.error.message}（需要網路）`);
    process.exit(1);
}
if (result.status !== 0) {
    console.error('');
    console.error('✖ 有 high／critical 等級的依賴弱點。處理原則：');
    console.error('  1. 先看是不是 production 依賴（是的話一定要處理）');
    console.error('  2. npm audit fix → 跑 npm test → 再發版');
    console.error('  3. 沒有修正版可用時：記錄在這裡並評估能不能移除那個依賴');
    process.exit(result.status);
}
console.log('✔ 依賴掃描通過（沒有 high／critical 弱點）');
