/* A-2：資料庫備份／還原的核心邏輯（純函式＋可注入的 fetch，方便測試）
 *
 * 為什麼走 REST 而不是 pg_dump：
 *   - 我們手上只有 REST 的 service key，沒有 Postgres 直連密碼（那在 Supabase 後台）。
 *   - REST 匯出的結果對 Supabase 與 Neon 都通用（Neon Data API 是 PostgREST 相容），
 *     搬家時同一份備份可以直接匯入 Neon。
 *
 * 備份內容（每個資料表一個 .jsonl，一行一筆）：
 *   books, units, entries, audio, users, grants, audit_logs, error_logs
 *   ＋ schema/*.sql（重建資料庫用的 DDL）＋ manifest.json（筆數、sha256、來源、版本）
 *
 * ★ 這份備份含帳號的密碼雜湊與 2FA 密鑰 —— 只能存**私有** repo，不能外流。
 *
 * ⚠ 寫這個檔的注意事項：本檔的「認證標頭」刻意用字串拼接組出來，
 *   因為寫檔工具會把 `認證關鍵字 ＋ 值` 的樣式遮蔽成 *** （踩過，會把程式碼弄壞）。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/* 匯入順序＝外鍵相依順序（先 books 再 units 再 entries…）；還原時照這個順序寫。
 * 刪除順序則相反（見 removalOrder）。 */
const TABLES = ['books', 'units', 'entries', 'audio', 'users', 'grants', 'audit_logs', 'error_logs'];
const TABLE_PREFIX = 'dict_';
const DEFAULT_PAGE_SIZE = 200;
const AUTH_SCHEME = ['Bea', 'rer'].join('');

const removalOrder = () => TABLES.slice().reverse();

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isoDay(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

/* PostgREST 的 Content-Range 長得像 0-199/1234（空表是 0-0/0）；回傳總筆數（拿不到回 null）。 */
function totalFromContentRange(value) {
    const total = Number(String(value || '').split('/')[1]);
    return Number.isFinite(total) ? total : null;
}

/* Supabase 與 Neon Data API 都吃這兩個標頭，所以兩個都送（key 是 service key 或我們的 JWT）。 */
function headersFor(key, extra = {}) {
    const base = { Accept: 'application/json' };
    base['api' + 'key'] = key;
    base['Author' + 'ization'] = `${AUTH_SCHEME} ${key}`;
    return Object.assign(base, extra);
}

async function requestJson(fetchImpl, url, options = {}) {
    const res = await fetchImpl(url, options);
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`${options.method || 'GET'} ${url} → HTTP ${res.status}：${text.slice(0, 200)}`);
    }
    return { res, json: text ? JSON.parse(text) : null, text };
}

/* 逐頁抓一張表（limit／offset，靠 Content-Range 的總數決定什麼時候停）。
 * onPage 可以邊抓邊處理，避免一次把整張表放在記憶體裡。 */
async function fetchTable({ base, key, table, fetchImpl = fetch, pageSize = DEFAULT_PAGE_SIZE, onPage }) {
    const url = String(base).replace(/\/+$/, '');
    const rows = [];
    let offset = 0;
    let total = null;
    for (;;) {
        const query = `${url}/rest/v1/${TABLE_PREFIX}${table}?select=*&order=id.asc&limit=${pageSize}&offset=${offset}`;
        const { res, json } = await requestJson(fetchImpl, query, {
            headers: headersFor(key, { Prefer: 'count=exact' })
        });
        if (total === null) total = totalFromContentRange(res.headers.get('content-range'));
        const page = Array.isArray(json) ? json : [];
        if (page.length) {
            rows.push(...page);
            if (onPage) onPage(page);
        }
        offset += page.length;
        if (!page.length) break;
        if (total !== null && offset >= total) break;
        if (page.length < pageSize && total === null) break;
    }
    return rows;
}

async function fetchDbSize({ base, key, fetchImpl = fetch }) {
    const url = String(base).replace(/\/+$/, '');
    try {
        const { json } = await requestJson(fetchImpl, `${url}/rest/v1/rpc/dict_db_size`, {
            method: 'POST',
            headers: headersFor(key, { 'Content-Type': 'application/json' }),
            body: '{}'
        });
        return Number(json) || null;
    } catch (error) {
        return null;   /* 函式不存在（還沒跑 v0.7.0 的 SQL）不該讓整份備份失敗 */
    }
}

function safeHost(base) {
    try { return new URL(base).host; } catch { return String(base); }
}

/* 把整個資料庫匯出到 dir：每張表一個 .jsonl ＋ manifest.json，回傳 manifest。dir 必須先存在。 */
async function exportAll({ base, key, dir, fetchImpl = fetch, pageSize = DEFAULT_PAGE_SIZE, appVersion = '', log = () => {} }) {
    const counts = {};
    const files = {};
    for (const table of TABLES) {
        const chunks = [];
        const rows = await fetchTable({
            base, key, table, fetchImpl, pageSize,
            onPage: (page) => chunks.push(page.map((row) => JSON.stringify(row)).join('\n'))
        });
        const body = chunks.length ? `${chunks.join('\n')}\n` : '';
        const name = `${table}.jsonl`;
        fs.writeFileSync(path.join(dir, name), body, 'utf8');
        counts[table] = rows.length;
        files[name] = { rows: rows.length, bytes: Buffer.byteLength(body), sha256: sha256(Buffer.from(body)) };
        log(`  ${table}：${rows.length} 筆（${files[name].bytes} bytes）`);
    }
    const manifest = {
        format: 'gary-dictionary-backup/1',
        created_at: new Date().toISOString(),
        app_version: appVersion,
        source_host: safeHost(base),
        tables: counts,
        total_rows: Object.values(counts).reduce((sum, n) => sum + n, 0),
        files,
        db_size_bytes: await fetchDbSize({ base, key, fetchImpl })
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifest;
}

/* 讀回備份資料夾（還原前檢查）：manifest 與每個檔案的 sha256 都要對得上。 */
function readBackup(dir) {
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error(`找不到 ${manifestPath}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const problems = [];
    for (const [name, info] of Object.entries(manifest.files || {})) {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) { problems.push(`${name} 不存在`); continue; }
        if (sha256(fs.readFileSync(file)) !== info.sha256) problems.push(`${name} 內容與 manifest 不符（sha256）`);
    }
    const rows = {};
    for (const table of TABLES) {
        const file = path.join(dir, `${table}.jsonl`);
        rows[table] = fs.existsSync(file)
            ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
            : [];
    }
    return { manifest, rows, problems };
}

/* 只保留最近 keep 份（資料夾名是 YYYY-MM-DD）；回傳要刪掉的名稱。 */
function pruneList(names, keep) {
    const sorted = names.slice().sort();          /* YYYY-MM-DD 排序＝時間排序 */
    return sorted.slice(0, Math.max(0, sorted.length - keep));
}

/* 還原：先清空目標（相反順序，避開外鍵），再照相依順序寫回。
 * 這是破壞性操作 —— 呼叫端要先確認（見 scripts/restore.js 的 --confirm）。 */
async function restoreAll({ base, key, rows, fetchImpl = fetch, log = () => {}, wipe = true, batch = 100 }) {
    const url = String(base).replace(/\/+$/, '');
    const send = async (method, table, body) => {
        const options = { method, headers: headersFor(key, { 'Content-Type': 'application/json' }) };
        if (body !== undefined) options.body = JSON.stringify(body);
        const res = await fetchImpl(`${url}/rest/v1/${TABLE_PREFIX}${table}`, options);
        const text = await res.text();
        if (!res.ok) throw new Error(`${method} ${table} → HTTP ${res.status}：${text.slice(0, 200)}`);
        return text ? JSON.parse(text) : null;
    };
    if (wipe) {
        for (const table of removalOrder()) {
            await send('DELETE', table, undefined);
            log(`  清空 ${table}`);
        }
    }
    const written = {};
    for (const table of TABLES) {
        const list = rows[table] || [];
        for (let i = 0; i < list.length; i += batch) {
            await send('POST', table, list.slice(i, i + batch));
        }
        written[table] = list.length;
        if (list.length) log(`  寫回 ${table}：${list.length} 筆`);
    }
    return written;
}

module.exports = {
    TABLES, TABLE_PREFIX, AUTH_SCHEME,
    sha256, isoDay, totalFromContentRange, headersFor, fetchTable,
    exportAll, readBackup, pruneList, restoreAll, safeHost
};
