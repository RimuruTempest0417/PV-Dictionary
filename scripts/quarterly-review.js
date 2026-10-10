#!/usr/bin/env node
/* D-9（v0.12.0）：Neon 的「規模與風險」每季追蹤。
 *
 * 使用者 2026-10-10 指定要每季追蹤。為什麼要有這一支：
 *   免費方案的條款會變（Neon Data API 還在 Open Beta）、資料量會長，
 *   但「每季去看一次」這種事沒有人會記得 → 做成一支可以隨時跑、也會被排程提醒的檢查。
 *
 * 檢查四件事：
 *   1. 資料現況：各表筆數、資料庫大小與用量百分比（= 規模那一半）。
 *   2. 待辦：生字超過 LOAD_TEST_AT 就值得重跑壓測（`npm run load:test`）；
 *      用量超過門檻一半就該先清理（`npm run cleanup:logs`）再觀察。
 *   3. 上一次真的做過季度檢查是什麼時候（記在 logs/quarterly-review.json）。
 *   4. **要人工去看的**：Neon 官網的免費方案條款與公告（這一半沒辦法自動化，只能提醒）。
 *
 * 用法：
 *   npm run quarterly              # 看現況與待辦（唯讀）
 *   npm run quarterly -- --record   # 人工檢查完之後記錄下來（寫 logs/quarterly-review.json）
 *   npm run quarterly -- --notify   # 該做的時候用 macOS 通知提醒（launchd 排程用）
 *   npm run quarterly -- --json     # 給排程／其他工具讀
 *
 * ★ 刻意直接打資料庫（不經過 server 的 store）：這支是「維運視角」，
 *   就算應用程式那邊有問題，也要能單獨看出資料庫的規模。
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const LIMITS = require(path.join(ROOT, 'lib', 'limits'));

const AS_JSON = process.argv.includes('--json');
const RECORD = process.argv.includes('--record');
const NOTIFY = process.argv.includes('--notify');
const QUARTER_DAYS = 92;
const LOAD_TEST_AT = 5000;      /* 生字超過這個量就值得重跑一次壓測（10,000 筆的規模已驗證過） */

const TABLES = ['books', 'units', 'entries', 'audio', 'users', 'grants', 'audit_logs', 'error_logs'];
const QUOTA_MB = Number(LIMITS.DB_QUOTA_MB || LIMITS.QUOTA_MB || 1024);
const WARN_PERCENT = Number(LIMITS.DB_USAGE_WARN_PERCENT || LIMITS.USAGE_WARN_PERCENT || 70);

const LOG_DIR = path.join(ROOT, 'logs');
const STATE_FILE = path.join(LOG_DIR, 'quarterly-review.json');
const LOG_FILE = path.join(LOG_DIR, 'quarterly.log');

const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function humanBytes(bytes) {
    if (!Number.isFinite(bytes)) return '（未知）';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function readState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (error) {
        return { last_reviewed_at: null, history: [] };
    }
}

function logLine(line) {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.appendFileSync(LOG_FILE, `[${stamp()}] ${line}\n`);
    } catch (error) { /* 寫不進去不影響檢查本身 */ }
}

function notify(title, message) {
    if (!NOTIFY) return;
    try {
        execFileSync('osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Basso"`]);
    } catch (error) { /* 通知失敗不影響檢查 */ }
}

async function countTable(table) {
    const res = await fetch(`${base}/rest/v1/dict_${table}?select=id&limit=0`, {
        headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json', Prefer: 'count=exact' }
    });
    const range = String(res.headers.get('content-range') || '');
    const total = Number(range.split('/')[1]);
    return Number.isFinite(total) ? total : null;
}

async function dbSize() {
    const res = await fetch(`${base}/rest/v1/rpc/dict_db_size`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: '{}'
    });
    const text = await res.text();
    if (!res.ok) return { available: false, reason: text.slice(0, 120) };
    let value = Number(text);
    if (!Number.isFinite(value)) {
        try {
            const parsed = JSON.parse(text);
            const first = Array.isArray(parsed) ? parsed[0] : parsed;
            value = first && typeof first === 'object' ? Number(Object.values(first)[0]) : Number(first);
        } catch (error) { value = NaN; }
    }
    if (!Number.isFinite(value)) return { available: false, reason: `dict_db_size() 回了 ${text.slice(0, 80)}` };
    const quotaBytes = QUOTA_MB * 1024 * 1024;
    return {
        available: true,
        bytes: value,
        human: humanBytes(value),
        quota_human: `${QUOTA_MB}.00 MB`,
        percent: Number(((value / quotaBytes) * 100).toFixed(2)),
        warn_percent: WARN_PERCENT
    };
}

async function main() {
    if (!base || !key) {
        console.error('✖ 需要 .env 的 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY（線上資料庫）才能做季度追蹤');
        process.exit(1);
    }

    const counts = {};
    for (const table of TABLES) {
        try {
            counts[table] = await countTable(table);
        } catch (error) {
            counts[table] = null;
        }
    }
    const usage = await dbSize().catch((error) => ({ available: false, reason: error.message }));

    const entries = Number(counts.entries || 0);
    const state = readState();
    const lastReviewed = state.last_reviewed_at ? new Date(state.last_reviewed_at) : null;
    const daysSince = lastReviewed ? Math.floor((Date.now() - lastReviewed.getTime()) / 86400000) : null;
    const overdue = daysSince === null || daysSince >= QUARTER_DAYS;

    const todos = [];
    if (overdue) {
        todos.push(`做一次季度檢查${daysSince === null ? '（從來沒有記錄過）' : `（上次是 ${daysSince} 天前）`}：`
            + '① 到 Neon 官網看免費方案條款與公告有沒有變 ② 看下面的待辦 ③ 做完用 `npm run quarterly -- --record` 記錄下來');
    }
    if (entries >= LOAD_TEST_AT) {
        todos.push(`生字已經 ${entries} 筆（≥ ${LOAD_TEST_AT}）→ 值得重跑壓測：\`npm run load:test\`（跑完自動清乾淨）`);
    }
    if (usage.available && usage.percent >= Math.round(WARN_PERCENT / 2)) {
        todos.push(`資料庫用量 ${usage.percent}%（門檻 ${WARN_PERCENT}%）→ 先 \`npm run cleanup:logs\`，再決定要不要搬家`);
    }
    if (Number(counts.error_logs || 0) >= 500) {
        todos.push(`錯誤日誌 ${counts.error_logs} 筆 → 開後台「🐞 錯誤紀錄」或 \`npm run triage\` 清一清`);
    }

    const report = {
        checked_at: new Date().toISOString(),
        host: (() => { try { return new URL(base).host; } catch (error) { return base.slice(0, 40); } })(),
        counts,
        usage,
        last_reviewed_at: state.last_reviewed_at,
        days_since_review: daysSince,
        review_overdue: overdue,
        todos
    };

    if (RECORD) {
        const next = {
            last_reviewed_at: new Date().toISOString(),
            history: (state.history || []).concat([{
                at: new Date().toISOString(), entries, usage_percent: usage.available ? usage.percent : null
            }]).slice(-20)
        };
        fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
        logLine(`=== 季度檢查已記錄（生字 ${entries} 筆、用量 ${usage.available ? `${usage.percent}%` : '未知'}）===`);
        console.log(`✔ 已記錄這次季度檢查（${next.last_reviewed_at}）→ ${path.relative(ROOT, STATE_FILE)}`);
        return;
    }

    if (AS_JSON) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }

    console.log(`Neon 季度追蹤（${report.host}）\n`);
    console.log(`  各表筆數：${TABLES.map((table) => `${table} ${counts[table] === null ? '?' : counts[table]}`).join('｜')}`);
    console.log(usage.available
        ? `  資料庫用量：${usage.human} / ${usage.quota_human}（${usage.percent}%，門檻 ${WARN_PERCENT}%）`
        : `  資料庫用量：量不到（${usage.reason || 'unknown'}）`);
    console.log(`  上次季度檢查：${state.last_reviewed_at || '（沒有記錄）'}${daysSince === null ? '' : `（${daysSince} 天前）`}`);
    console.log(todos.length
        ? `\n待辦：\n${todos.map((item) => `  □ ${item}`).join('\n')}`
        : '\n✔ 目前沒有待辦（每季還是要人工看一次 Neon 的條款與公告）');

    logLine(`季度追蹤：生字 ${entries} 筆、用量 ${usage.available ? `${usage.percent}%` : '未知'}、`
        + `待辦 ${todos.length} 項${overdue ? '、季度檢查已逾期' : ''}`);
    if (todos.length) notify('Gary-Dictionary 季度追蹤', todos[0]);
}

main().catch((error) => {
    console.error(`✖ 季度追蹤失敗：${error.message}`);
    process.exit(1);
});
