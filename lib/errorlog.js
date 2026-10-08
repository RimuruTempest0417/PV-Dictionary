/* 錯誤日誌（A-5）
 *
 * 為什麼獨立一份、不進 lib/store：
 *   1. 它會一直長大，**不該**跟其他 7 張表一起被 hydrate 進記憶體（那會讓每個請求都變慢）。
 *   2. 它只需要「寫一筆、列出來、標記已處理、清舊的」四件事，不需要完整的 CRUD 與外鍵。
 *   3. 本機（JSON 檔）與線上（Supabase）兩份實作，介面一樣：append / list / resolve / purge / counts。
 *
 * ★ 不存截圖（使用者指定）：欄位刻意沒有圖片，context 只留白名單（行號、directive…），
 *   而且每一欄都有長度上限 —— 公開端點收到的東西一律當成不可信。
 */
const fs = require('fs');
const path = require('path');

const TABLE = 'dict_error_logs';
const JSON_KEEP = 2000;        /* 本機 JSON 檔最多留幾筆（超過就丟最舊的） */
const MAX_MESSAGE = 500;
const MAX_PATH = 200;
const MAX_UA = 200;
const CONTEXT_KEYS = ['line', 'column', 'type', 'directive', 'blocked', 'status', 'method', 'endpoint', 'stack', 'tags'];

function cleanText(value, max) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanContext(context) {
    if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
    const out = {};
    for (const key of CONTEXT_KEYS) {
        if (context[key] === undefined || context[key] === null || context[key] === '') continue;
        out[key] = cleanText(context[key], 300);
    }
    return Object.keys(out).length ? out : null;
}

/* 把任何輸入正規化成我們真正會存的形狀（多餘的欄位一律丟掉） */
function normalizeEntry(input = {}) {
    const userId = Number(input.user_id);
    return {
        source: input.source === 'server' ? 'server' : 'client',
        level: input.level === 'warn' ? 'warn' : 'error',
        code: cleanText(input.code, 60).toUpperCase(),
        message: cleanText(input.message, MAX_MESSAGE),
        path: cleanText(input.path, MAX_PATH),
        version: cleanText(input.version, 20),
        user_id: Number.isFinite(userId) && userId > 0 ? userId : null,
        display_name: cleanText(input.display_name, 40),
        user_agent: cleanText(input.user_agent, MAX_UA),
        is_self_test: input.is_self_test === true,
        context: cleanContext(input.context),
        resolved: false,
        resolved_by: null,
        resolved_at: null,
        resolved_note: ''
    };
}

/* 篩選：日期用 YYYY-MM-DD（格式不對就忽略，跟稽核紀錄同一套規則） */
function normalizeFilters(options = {}) {
    const level = String(options.level || '').toLowerCase();
    const source = String(options.source || '').toLowerCase();
    const day = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : '');
    const from = day(options.from);
    const to = day(options.to);
    let resolved = '';
    if (options.resolved === true || options.resolved === 'true' || options.resolved === '1') resolved = true;
    if (options.resolved === false || options.resolved === 'false' || options.resolved === '0') resolved = 'false';
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const offset = Math.max(Number(options.offset) || 0, 0);
    return {
        level: ['error', 'warn'].includes(level) ? level : '',
        source: ['client', 'server'].includes(source) ? source : '',
        resolved,
        from,
        to,
        hideSelfTest: options.hide_self_test === true || options.hide_self_test === 'true' || options.hide_self_test === '1',
        limit,
        offset
    };
}

function matchesFilters(row, filters) {
    if (filters.level && row.level !== filters.level) return false;
    if (filters.source && row.source !== filters.source) return false;
    if (filters.resolved !== '') {
        const wanted = filters.resolved === true || filters.resolved === 'true';
        if (Boolean(row.resolved) !== wanted) return false;
    }
    if (filters.hideSelfTest && row.is_self_test) return false;
    const at = String(row.created_at || '');
    if (filters.from && at < `${filters.from}T00:00:00.000Z`) return false;
    if (filters.to && at > `${filters.to}T23:59:59.999Z`) return false;
    return true;
}

/* ---------------- 本機 JSON 檔 ---------------- */
function createJsonErrorLog(options = {}) {
    const baseDir = options.dataDir || path.join(__dirname, '..', 'data');
    const file = options.file || path.join(baseDir, 'error-logs.json');

    function readAll() {
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            return Array.isArray(parsed) ? parsed : [];
        } catch (err) {
            return [];
        }
    }

    function writeAll(rows) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
    }

    function append(entry) {
        const rows = readAll();
        const maxId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0);
        const row = Object.assign({}, normalizeEntry(entry), {
            id: maxId + 1,
            created_at: new Date().toISOString()
        });
        rows.push(row);
        /* 只留最近 JSON_KEEP 筆：本機檔案不該無限長大 */
        const kept = rows.length > JSON_KEEP ? rows.slice(rows.length - JSON_KEEP) : rows;
        writeAll(kept);
        return row;
    }

    function list(options = {}) {
        const filters = normalizeFilters(options);
        const all = readAll().filter((row) => matchesFilters(row, filters));
        all.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || Number(b.id) - Number(a.id));
        return {
            filters: { level: filters.level, source: filters.source, resolved: filters.resolved, from: filters.from, to: filters.to, hide_self_test: filters.hideSelfTest },
            total: all.length,
            open_count: readAll().filter((row) => !row.resolved).length,
            rows: all.slice(filters.offset, filters.offset + filters.limit)
        };
    }

    function resolve(id, options = {}) {
        const rows = readAll();
        const index = rows.findIndex((row) => String(row.id) === String(id));
        if (index === -1) return null;
        rows[index] = Object.assign({}, rows[index], {
            resolved: options.resolved === false ? false : true,
            resolved_by: options.by === undefined ? rows[index].resolved_by : options.by,
            resolved_at: new Date().toISOString(),
            resolved_note: cleanText(options.note, 200)
        });
        writeAll(rows);
        return rows[index];
    }

    /* 同一個錯誤常常一次來好幾筆（擴充功能、迴圈例外）：一次把同 code+message 的未處理清掉 */
    function resolveSimilar(options = {}) {
        const rows = readAll();
        let changed = 0;
        const now = new Date().toISOString();
        for (let i = 0; i < rows.length; i += 1) {
            if (rows[i].resolved) continue;
            if (String(rows[i].code || '') !== String(options.code || '')) continue;
            if (String(rows[i].message || '') !== String(options.message || '')) continue;
            rows[i] = Object.assign({}, rows[i], {
                resolved: true,
                resolved_by: options.by === undefined ? rows[i].resolved_by : options.by,
                resolved_at: now,
                resolved_note: cleanText(options.note || '同類一次處理', 200)
            });
            changed += 1;
        }
        if (changed) writeAll(rows);
        return { resolved: changed };
    }

    function purge(options = {}) {
        const days = Math.max(Number(options.olderThanDays) || 0, 1);
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const rows = readAll();
        const kept = rows.filter((row) => String(row.created_at || '') >= cutoff || !row.resolved);
        if (!options.dryRun) writeAll(kept);
        return { before: rows.length, after: kept.length, deleted: rows.length - kept.length };
    }

    function counts() {
        const rows = readAll();
        return { total: rows.length, open: rows.filter((row) => !row.resolved).length, file };
    }

    return { append, list, resolve, resolveSimilar, purge, counts, file, backend: 'json' };
}

/* ---------------- Supabase ---------------- */
function createSupabaseErrorLog(options = {}) {
    const url = String(options.url || process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    const key = String(options.key || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '');
    if (!url || !key) {
        const err = new Error('錯誤日誌（supabase）需要 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY');
        err.code = 'SUPABASE_CONFIG_MISSING';
        throw err;
    }
    if (/^REPLACE_ME/.test(url) || /^REPLACE_ME/.test(key)) {
        const err = new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 還是 REPLACE_ME 佔位值');
        err.code = 'SUPABASE_CONFIG_PLACEHOLDER';
        throw err;
    }

    async function request(pathname, requestOptions = {}) {
        const headers = {
            apikey: key,
            Authorization: `Bearer ${key}`,
            Accept: 'application/json'
        };
        if (requestOptions.body !== undefined) headers['Content-Type'] = 'application/json';
        if (requestOptions.prefer) headers.Prefer = requestOptions.prefer;
        const res = await fetch(`${url}/rest/v1/${pathname}`, {
            method: requestOptions.method || 'GET',
            headers,
            body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body)
        });
        const text = await res.text();
        let data = null;
        if (text) {
            try { data = JSON.parse(text); } catch (err) { data = text; }
        }
        if (!res.ok) {
            const message = (data && (data.message || data.hint || data.error)) || `HTTP ${res.status}`;
            const err = new Error(`Supabase ${requestOptions.method || 'GET'} ${TABLE} → ${message}`);
            err.code = 'SUPABASE_REQUEST_FAILED';
            err.status = res.status;
            throw err;
        }
        return data;
    }

    async function append(entry) {
        const row = normalizeEntry(entry);
        const data = await request(TABLE, { method: 'POST', body: row, prefer: 'return=representation' });
        return Array.isArray(data) ? data[0] : row;
    }

    function where(filters) {
        const parts = [];
        if (filters.level) parts.push(`level=eq.${filters.level}`);
        if (filters.source) parts.push(`source=eq.${filters.source}`);
        if (filters.resolved === true || filters.resolved === 'true') parts.push('resolved=is.true');
        if (filters.resolved === 'false') parts.push('resolved=is.false');
        if (filters.hideSelfTest) parts.push('is_self_test=is.false');
        if (filters.from) parts.push(`created_at=gte.${filters.from}T00:00:00.000Z`);
        if (filters.to) parts.push(`created_at=lte.${filters.to}T23:59:59.999Z`);
        return parts.length ? `&${parts.join('&')}` : '';
    }

    async function list(options = {}) {
        const filters = normalizeFilters(options);
        const query = `select=*&order=created_at.desc,id.desc${where(filters)}&limit=${filters.limit}&offset=${filters.offset}`;
        const rows = await request(`${TABLE}?${query}`);
        /* 總數與未處理數用最便宜的查詢（只取 id）：日誌表可能很大，不要抓整列回來數 */
        const allIds = await request(`${TABLE}?select=id${where(filters)}`).catch(() => []);
        const openRows = await request(`${TABLE}?select=id&resolved=is.false`).catch(() => []);
        return {
            filters: {
                level: filters.level, source: filters.source, resolved: filters.resolved,
                from: filters.from, to: filters.to, hide_self_test: filters.hideSelfTest
            },
            total: Array.isArray(allIds) ? allIds.length : (Array.isArray(rows) ? rows.length : 0),
            open_count: Array.isArray(openRows) ? openRows.length : 0,
            rows: Array.isArray(rows) ? rows : []
        };
    }

    async function resolve(id, options = {}) {
        const body = {
            resolved: options.resolved === false ? false : true,
            resolved_at: new Date().toISOString(),
            resolved_note: cleanText(options.note, 200)
        };
        if (options.by !== undefined) body.resolved_by = options.by;
        const data = await request(`${TABLE}?id=eq.${encodeURIComponent(id)}`, {
            method: 'PATCH', body, prefer: 'return=representation'
        });
        return Array.isArray(data) ? (data[0] || null) : null;
    }

    async function resolveSimilar(options = {}) {
        const body = {
            resolved: true,
            resolved_at: new Date().toISOString(),
            resolved_note: cleanText(options.note || '同類一次處理', 200)
        };
        if (options.by !== undefined) body.resolved_by = options.by;
        const query = `code=eq.${encodeURIComponent(String(options.code || ''))}&message=eq.${encodeURIComponent(String(options.message || ''))}&resolved=is.false`;
        const data = await request(`${TABLE}?${query}`, { method: 'PATCH', body, prefer: 'return=representation' });
        return { resolved: Array.isArray(data) ? data.length : 0 };
    }

    async function purge(options = {}) {
        const days = Math.max(Number(options.olderThanDays) || 0, 1);
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const before = await request(`${TABLE}?select=id&created_at=lt.${cutoff}&resolved=is.true`).catch(() => []);
        const count = Array.isArray(before) ? before.length : 0;
        if (!options.dryRun && count) {
            await request(`${TABLE}?created_at=lt.${cutoff}&resolved=is.true`, { method: 'DELETE' });
        }
        return { deleted: count, dryRun: Boolean(options.dryRun) };
    }

    async function counts() {
        const all = await request(`${TABLE}?select=id`).catch(() => []);
        const open = await request(`${TABLE}?select=id&resolved=is.false`).catch(() => []);
        return { total: Array.isArray(all) ? all.length : 0, open: Array.isArray(open) ? open.length : 0, table: TABLE };
    }

    return { append, list, resolve, resolveSimilar, purge, counts, table: TABLE, backend: 'supabase' };
}

function createErrorLog(options = {}) {
    const backend = String(options.backend || process.env.DATA_BACKEND || 'json').toLowerCase();
    if (backend === 'supabase') return createSupabaseErrorLog(options);
    return createJsonErrorLog(options);
}

module.exports = {
    createErrorLog,
    normalizeEntry,
    normalizeFilters,
    matchesFilters,
    cleanContext,
    JSON_KEEP,
    MAX_MESSAGE,
    TABLE
};
