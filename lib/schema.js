/* 資料庫 schema 的「程式碼會用到的欄位」清單，以及比對遷移檔的工具。
 *
 * 為什麼要有這個檔：
 *   書本封面是 v0.2.0 加的功能，但沒人補遷移檔 —— 本機 JSON 檔不在乎欄位，
 *   所以測試全綠、Demo 也正常；一上線 Supabase，`PATCH dict_books` 帶著不存在的
 *   `cover_data` 欄位就直接 500（使用者看到的就是「上傳封面失敗」）。
 *   現在這裡的 EXPECTED_COLUMNS 是唯一的一份清單：
 *     - tests/schema.test.js  → 比對「這份清單 vs migrations/*.sql」（本機就能抓漏）
 *     - scripts/schema-check.js → 比對「這份清單 vs 線上實際 schema」（上線後抓漂移）
 *
 * 加新欄位時的規矩：先寫一份 `alter table … add column if not exists …` 的遷移檔，
 * 再把欄位加進這裡 —— 兩邊不一致，測試會直接失敗。
 */

const fs = require('fs');
const path = require('path');

const TABLE_PREFIX = 'dict_';

/* 每個表「程式會寫入或讀取」的欄位（不含 dict_ 前綴） */
const EXPECTED_COLUMNS = {
    books: [
        'id', 'code', 'name', 'grade', 'publisher', 'sort_order', 'is_published', 'created_at', 'updated_at',
        /* ↓ 封面：v0.2.0 的功能，v0.3.2 才補進遷移檔 */
        'cover_mime', 'cover_data', 'cover_bytes', 'cover_updated_at', 'cover_by'
    ],
    units: ['id', 'book_id', 'unit_no', 'title', 'sort_order', 'is_published', 'created_at', 'updated_at'],
    entries: [
        'id', 'unit_id', 'headword', 'headword_norm', 'ipa_us', 'ipa_uk', 'part_of_speech', 'zh_meaning',
        'en_definition', 'example_en', 'example_zh', 'status', 'review_note', 'reviewed_by', 'reviewed_at',
        'sort_order', 'created_by', 'updated_by', 'created_at', 'updated_at'
    ],
    audio: ['id', 'entry_id', 'source', 'accent', 'mime', 'bytes', 'duration_ms', 'data', 'uploaded_by', 'created_at'],
    users: [
        'id', 'username', 'display_name', 'password_hash', 'role', 'is_active', 'last_login_at', 'created_at', 'updated_at',
        /* v0.4.3：工作階段版本、兩步驟驗證、上次登入來源 */
        'token_version', 'totp_secret', 'totp_enabled_at', 'backup_codes', 'last_login_ip', 'last_login_agent'
    ],
    grants: ['id', 'user_id', 'book_id', 'unit_id', 'can_edit', 'can_publish', 'granted_by', 'created_at'],
    audit_logs: ['id', 'user_id', 'display_name', 'role', 'action', 'target_id', 'details', 'ip', 'created_at', 'is_self_test'],
    /* v0.4.2：錯誤日誌（不進 hydrate 快取，見 lib/errorlog.js 的說明） */
    error_logs: [
        'id', 'created_at', 'source', 'level', 'code', 'message', 'path', 'version', 'user_id', 'display_name',
        'user_agent', 'is_self_test', 'context', 'resolved', 'resolved_by', 'resolved_at', 'resolved_note'
    ]
};

/* ★ v0.6.1：哪幾張表真的有 updated_at 欄位（＝樂觀鎖可以用的表）。
 *   為什麼要這一份：v0.6.0 為了讓樂觀鎖（D-2）對新資料也有效，在「所有表」的新增都補了 updated_at，
 *   結果 dict_audit_logs 沒有這個欄位 → Supabase 回 42703 → 連登入（會寫一筆稽核）都 500。
 *   之後任何「寫入某個欄位」的邏輯，都要先確認那張表真的有那個欄位。 */
const HAS_UPDATED_AT = new Set(
    Object.keys(EXPECTED_COLUMNS).filter((table) => EXPECTED_COLUMNS[table].includes('updated_at'))
);

const NOT_A_COLUMN = /^(unique|primary|foreign|constraint|check|exclude|like)\b/i;

function stripPrefix(table) {
    return String(table).replace(new RegExp(`^${TABLE_PREFIX}`), '');
}

/* 從 migrations/*.sql 取出「每個表定義了哪些欄位」（create table 與 alter table add column 都算） */
function parseMigrations(dir) {
    const out = {};
    let files = [];
    try {
        files = fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
    } catch (err) {
        return { tables: out, files: [] };
    }
    for (const file of files) {
        const sql = fs.readFileSync(path.join(dir, file), 'utf8');
        const createRe = /create\s+table(?:\s+if\s+not\s+exists)?\s+(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
        let match = createRe.exec(sql);
        while (match) {
            const table = stripPrefix(match[1]);
            const body = match[2];
            for (const rawLine of body.split('\n')) {
                const line = rawLine.replace(/--.*$/, '').trim();
                if (!line) continue;
                const column = /^([a-z_][a-z0-9_]*)\s+/i.exec(line);
                if (!column || NOT_A_COLUMN.test(line)) continue;
                (out[table] = out[table] || new Set()).add(column[1]);
            }
            match = createRe.exec(sql);
        }
        const alterRe = /alter\s+table\s+(?:public\.)?(\w+)\s+add\s+column(?:\s+if\s+not\s+exists)?\s+([a-z_][a-z0-9_]*)/gi;
        let alter = alterRe.exec(sql);
        while (alter) {
            (out[stripPrefix(alter[1])] = out[stripPrefix(alter[1])] || new Set()).add(alter[2]);
            alter = alterRe.exec(sql);
        }
    }
    const tables = {};
    for (const table of Object.keys(out)) tables[table] = Array.from(out[table]);
    return { tables, files };
}

/* 比對「遷移檔定義的欄位」與「程式要用的欄位」→ 回傳缺哪些、多哪些 */
function compareWithMigrations(migrationsDir) {
    const { tables, files } = parseMigrations(migrationsDir);
    const missing = [];
    const extra = [];
    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
        const defined = tables[table] || [];
        if (!defined.length) {
            missing.push({ table, column: '*', note: '遷移檔裡完全沒有這張表' });
            continue;
        }
        for (const column of columns) {
            if (!defined.includes(column)) missing.push({ table, column });
        }
        for (const column of defined) {
            if (!columns.includes(column)) extra.push({ table, column });
        }
    }
    return { files, missing, extra, tables };
}

/* 比對「線上實際 schema」（PostgREST 的 OpenAPI definitions）與程式要用的欄位 */
function compareWithLive(definitions) {
    const missing = [];
    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
        const live = (definitions || {})[`${TABLE_PREFIX}${table}`];
        if (!live || !live.properties) {
            missing.push({ table, column: '*', note: '線上沒有這張表' });
            continue;
        }
        const names = Object.keys(live.properties);
        for (const column of columns) {
            if (!names.includes(column)) missing.push({ table, column });
        }
    }
    return { missing };
}

module.exports = {
    HAS_UPDATED_AT, TABLE_PREFIX, EXPECTED_COLUMNS, parseMigrations, compareWithMigrations, compareWithLive };
