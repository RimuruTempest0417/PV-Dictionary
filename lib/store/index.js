/* 生字字串正規化：同一單元內用這個值比對是否重複
 * （例：'  Apple ' 與 'apple' 視為同一個生字）
 */
function normalizeHeadword(word) {
    return String(word == null ? '' : word).trim().toLowerCase().replace(/\s+/g, ' ');
}

const TABLE_NAMES = ['books', 'units', 'entries', 'audio', 'users', 'grants', 'audit_logs'];

const DATA_BACKEND_LABEL = {
    json: '本機 JSON 檔（Demo）',
    supabase: 'Supabase（PostgreSQL）'
};

function createStore(options = {}) {
    const backend = String(options.backend || process.env.DATA_BACKEND || 'json').toLowerCase();
    if (backend === 'supabase') {
        // v0.1.0 才實作：現在明確拒絕，不要讓「看起來可用」的降級路徑靜默產生錯誤資料。
        const err = new Error(
            'DATA_BACKEND=supabase 尚未實作（規劃於 v0.1.0：migrations/2026-10-08-v0.0.1-init.sql 已在 repo 內）。'
            + ' Demo 階段請使用 DATA_BACKEND=json。'
        );
        err.code = 'SUPABASE_BACKEND_NOT_IMPLEMENTED';
        throw err;
    }
    const { createJsonStore } = require('./json');
    return createJsonStore(options);
}

module.exports = { createStore, normalizeHeadword, TABLE_NAMES, DATA_BACKEND_LABEL };
