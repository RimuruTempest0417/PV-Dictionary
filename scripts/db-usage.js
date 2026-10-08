#!/usr/bin/env node
/* 資料庫用量檢查（D-5）
 *
 * 目的：Supabase 免費方案有容量上限。這支腳本每個月跑一次，看得到「哪張表一直在長」，
 * 以及是不是該跑 scripts/cleanup-logs.js 了。
 *
 * 用法：
 *   node scripts/db-usage.js            # 本機（JSON）或線上（Supabase）都自動判斷
 *   node scripts/db-usage.js --json     # 給排程／監控用的機器可讀輸出
 *
 * 判斷門檻（超過就在最後提醒）：稽核紀錄 5000 筆、錯誤日誌 2000 筆。
 */
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const ROOT = path.resolve(__dirname, '..');
const BACKEND = String(process.env.DATA_BACKEND || 'json').toLowerCase();
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'store.json');
const AS_JSON = process.argv.includes('--json');

const TABLES = ['books', 'units', 'entries', 'audio', 'users', 'grants', 'audit_logs'];
const AUDIT_WARN = 5000;
const ERROR_WARN = 2000;

function humanBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function jsonUsage() {
    const counts = {};
    let bytes = 0;
    if (fs.existsSync(DATA_FILE)) {
        bytes = fs.statSync(DATA_FILE).size;
        try {
            const state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            for (const table of TABLES) counts[table] = Array.isArray(state[table]) ? state[table].length : 0;
        } catch (err) {
            counts.note = 'data/store.json 讀不起來（可能是空的或壞掉）';
        }
    }
    const errorFile = path.join(path.dirname(DATA_FILE), 'error-logs.json');
    let errorRows = 0;
    if (fs.existsSync(errorFile)) {
        try {
            errorRows = (JSON.parse(fs.readFileSync(errorFile, 'utf8')) || []).length;
        } catch (err) { errorRows = 0; }
    }
    return { backend: 'json', counts, error_log_rows: errorRows, store_bytes: bytes, store_human: humanBytes(bytes), error_human: humanBytes(fs.existsSync(errorFile) ? fs.statSync(errorFile).size : 0) };
}

async function supabaseUsage() {
    const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
    if (!url || !key) throw new Error('需要 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY');
    const headers = { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json', Prefer: 'count=exact', Range: '0-0' };

    async function countOf(table) {
        const res = await fetch(`${url}/rest/v1/${table}?select=id`, { headers });
        const range = res.headers.get('content-range') || '';
        const total = Number(range.split('/')[1]);
        return Number.isFinite(total) ? total : 0;
    }

    const counts = {};
    for (const table of TABLES) counts[table] = await countOf(`dict_${table}`);
    const errorRows = await countOf('dict_error_logs');
    return { backend: 'supabase', project: String(process.env.SUPABASE_URL || '').replace(/^https?:\/\//, '').split('.')[0], counts, error_log_rows: errorRows };
}

async function main() {
    const usage = BACKEND === 'supabase' ? await supabaseUsage() : jsonUsage();
    if (AS_JSON) {
        console.log(JSON.stringify(usage, null, 2));
    } else {
        console.log(`後端：${usage.backend}${usage.project ? `（${usage.project}）` : ''}\n`);
        console.log('表'.padEnd(14) + '筆數');
        for (const [table, count] of Object.entries(usage.counts)) {
            console.log(String(table).padEnd(16) + count);
        }
        console.log(`\n錯誤日誌：${usage.error_log_rows} 筆`);
        if (usage.store_human) console.log(`本機資料檔：${usage.store_human}（錯誤日誌檔 ${usage.error_human}）`);
    }
    const warns = [];
    if ((usage.counts.audit_logs || 0) > AUDIT_WARN) warns.push(`稽核紀錄 ${usage.counts.audit_logs} 筆（超過 ${AUDIT_WARN}）→ 建議跑 npm run cleanup:logs`);
    if (usage.error_log_rows > ERROR_WARN) warns.push(`錯誤日誌 ${usage.error_log_rows} 筆（超過 ${ERROR_WARN}）→ 建議跑 npm run cleanup:logs`);
    if (warns.length) {
        console.log('\n⚠ 要處理：');
        for (const warn of warns) console.log(`  - ${warn}`);
        process.exitCode = 0;
    } else {
        console.log('\n✔ 用量正常（沒有超過提醒門檻）');
    }
}

main().catch((err) => {
    console.error(`✖ ${err.message}`);
    process.exit(1);
});
