#!/usr/bin/env node
/* 錯誤日誌巡檢（A-5）：讀線上（或本機）的錯誤日誌，整理成「可以先看那幾筆」的摘要。
 *
 * 為什麼要有（而不只看後台畫面）：後台適合「看最近的」，這支適合「定期掃一遍」——
 * 同樣的錯誤被回報 40 次時，畫面要你自己數，這裡直接幫你按 code 分組。
 *
 * 用法：
 *   npm run triage                 # 只列未處理的（依出現次數排序）
 *   npm run triage -- --all         # 連已處理的一起看
 *   npm run triage -- --json        # 機器可讀
 *   npm run triage -- --days=7      # 只看最近 7 天
 *
 * ★ 唯讀：只讀取，不會改任何資料、不會標記已處理。
 */
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const ROOT = path.resolve(__dirname, '..');
const BACKEND = String(process.env.DATA_BACKEND || 'json').toLowerCase();
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'store.json');

const arg = (name, fallback) => {
    const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const ALL = process.argv.includes('--all');
const AS_JSON = process.argv.includes('--json');
const DAYS = Number(arg('days', 30)) || 30;

function summarize(rows) {
    const groups = new Map();
    for (const row of rows) {
        const key = `${row.level}|${row.source}|${row.code || '(no code)'}|${String(row.message || '').slice(0, 80)}`;
        const group = groups.get(key) || {
            level: row.level, source: row.source, code: row.code || '', message: row.message,
            count: 0, open: 0, first: row.created_at, last: row.created_at, paths: new Set()
        };
        group.count += 1;
        if (!row.resolved) group.open += 1;
        if (String(row.created_at) < String(group.first)) group.first = row.created_at;
        if (String(row.created_at) > String(group.last)) group.last = row.created_at;
        if (row.path) group.paths.add(row.path);
        groups.set(key, group);
    }
    return [...groups.values()]
        .map((group) => Object.assign({}, group, { paths: [...group.paths].slice(0, 3) }))
        .sort((a, b) => b.open - a.open || b.count - a.count);
}

async function fetchRows() {
    const { createErrorLog } = require('../lib/errorlog');
    const log = createErrorLog({
        backend: BACKEND,
        dataDir: path.dirname(DATA_FILE),
        url: process.env.SUPABASE_URL,
        key: process.env.SUPABASE_SERVICE_ROLE_KEY
    });
    const from = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const list = await log.list({ limit: 200, from, resolved: ALL ? '' : 'false' });
    return list;
}

async function main() {
    const list = await fetchRows();
    const groups = summarize(list.rows || []);
    if (AS_JSON) {
        console.log(JSON.stringify({ backend: BACKEND, days: DAYS, total: list.total, open: list.open_count, groups }, null, 2));
        return;
    }
    console.log(`錯誤日誌巡檢（${BACKEND}）：最近 ${DAYS} 天${ALL ? '（含已處理）' : '、只看未處理'}\n`);
    console.log(`總筆數 ${list.total}｜未處理 ${list.open_count}｜這次列出 ${(list.rows || []).length} 筆\n`);
    if (!groups.length) {
        console.log('✔ 沒有需要處理的錯誤');
        return;
    }
    groups.forEach((group, index) => {
        console.log(`${index + 1}. [${group.level}/${group.source}${group.code ? `/${group.code}` : ''}] 出現 ${group.count} 次（未處理 ${group.open}）`);
        console.log(`   ${group.message}`);
        if (group.paths.length) console.log(`   路徑：${group.paths.join('、')}`);
        console.log(`   最近：${group.last}\n`);
    });
    console.log('處理建議：先看「未處理次數最多」的那一組；修好之後在後台按「標記已處理」。');
}

main().catch((err) => {
    console.error(`✖ ${err.message}`);
    process.exit(1);
});
