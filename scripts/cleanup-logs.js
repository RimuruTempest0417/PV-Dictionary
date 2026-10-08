#!/usr/bin/env node
/* 清理舊的日誌（D-5）
 *
 * 為什麼要一支專門的：
 *   - 稽核紀錄與錯誤日誌是唯二會「一直長大」的表；Supabase 免費方案有容量上限，
 *     沒有保留政策的話總有一天會滿，而且是滿在沒人在看的舊資料上。
 *   - 這種事一定要有 dry-run，而且預設就是 dry-run（按下去就刪的指令太危險）。
 *
 * 規則（刻意保守）：
 *   - 錯誤日誌：只刪「已標記處理」且超過 N 天（預設 90）的；未處理的永遠留著。
 *   - 稽核紀錄：超過 N 天（預設 365）就刪 —— 稽核是「誰做了什麼」，要留得比錯誤日誌久。
 *   - 天數下限 30 天，避免手滑把一個月的紀錄清掉。
 *
 * 用法：
 *   node scripts/cleanup-logs.js                     # 只預覽，不刪
 *   node scripts/cleanup-logs.js --apply             # 真的刪
 *   node scripts/cleanup-logs.js --error-days=60 --audit-days=180
 *   node scripts/cleanup-logs.js --only=error        # 只處理錯誤日誌
 */
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const ROOT = path.resolve(__dirname, '..');
const BACKEND = String(process.env.DATA_BACKEND || 'json').toLowerCase();
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'store.json');

const arg = (name, fallback) => {
    const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const days = (name, fallback) => Math.max(30, Number(arg(name, fallback)) || fallback);

const APPLY = process.argv.includes('--apply');
const ERROR_DAYS = days('error-days', 90);
const AUDIT_DAYS = days('audit-days', 365);
const ONLY = String(arg('only', '')).toLowerCase();

function cutoff(daysAgo) {
    return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

/* ---------------- 稽核紀錄 ---------------- */
function purgeAuditJson() {
    if (!fs.existsSync(DATA_FILE)) return { deleted: 0, total: 0 };
    const state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const rows = Array.isArray(state.audit_logs) ? state.audit_logs : [];
    const limit = cutoff(AUDIT_DAYS);
    const kept = rows.filter((row) => String(row.created_at || '') >= limit);
    const deleted = rows.length - kept.length;
    if (APPLY && deleted) {
        state.audit_logs = kept;
        fs.writeFileSync(DATA_FILE, `${JSON.stringify(state, null, 2)}\n`);
    }
    return { deleted, total: rows.length };
}

async function purgeAuditSupabase() {
    const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
    if (!url || !key) throw new Error('需要 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY');
    const headers = { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' };
    const limit = cutoff(AUDIT_DAYS);
    const countRes = await fetch(`${url}/rest/v1/dict_audit_logs?select=id&created_at=lt.${limit}`, { headers });
    const ids = await countRes.json();
    const deleted = Array.isArray(ids) ? ids.length : 0;
    if (APPLY && deleted) {
        const res = await fetch(`${url}/rest/v1/dict_audit_logs?created_at=lt.${limit}`, { method: 'DELETE', headers });
        if (!res.ok) throw new Error(`刪除失敗：HTTP ${res.status} ${await res.text()}`);
    }
    return { deleted };
}

/* ---------------- 主流程 ---------------- */
async function main() {
    const { createErrorLog } = require('../lib/errorlog');
    console.log(`後端：${BACKEND}｜模式：${APPLY ? '★ 真的刪除' : '預覽（加 --apply 才會刪）'}`);
    console.log(`保留政策：錯誤日誌 ${ERROR_DAYS} 天（僅限已處理）、稽核紀錄 ${AUDIT_DAYS} 天\n`);

    if (ONLY !== 'audit') {
        const log = createErrorLog({
            backend: BACKEND,
            dataDir: path.dirname(DATA_FILE),
            url: process.env.SUPABASE_URL,
            key: process.env.SUPABASE_SERVICE_ROLE_KEY
        });
        const result = await log.purge({ olderThanDays: ERROR_DAYS, dryRun: !APPLY });
        console.log(`錯誤日誌：${APPLY ? '刪除' : '可刪除'} ${result.deleted} 筆（已處理且超過 ${ERROR_DAYS} 天）`);
    }

    if (ONLY !== 'error') {
        const result = BACKEND === 'supabase' ? await purgeAuditSupabase() : purgeAuditJson();
        console.log(`稽核紀錄：${APPLY ? '刪除' : '可刪除'} ${result.deleted} 筆（超過 ${AUDIT_DAYS} 天）`);
    }

    console.log(APPLY ? '\n✔ 完成' : '\n（預覽結束，沒有刪除任何東西）');
}

main().catch((err) => {
    console.error(`✖ ${err.message}`);
    process.exit(1);
});
