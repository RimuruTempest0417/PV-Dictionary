/* 生字字串正規化：同一單元內用這個值比對是否重複
 * （例：'  Apple ' 與 'apple' 視為同一個生字）
 */
function normalizeHeadword(word) {
    return String(word == null ? '' : word).trim().toLowerCase().replace(/\s+/g, ' ');
}

const TABLE_NAMES = ['books', 'units', 'entries', 'audio', 'users', 'grants', 'audit_logs'];

const DATA_BACKEND_LABEL = {
    json: '本機 JSON 檔（Demo）',
    supabase: 'Supabase（PostgreSQL）',
    /* v0.10.0：Data API 相容層指到 Neon 時顯示這個（見 server.js 的 backend_kind） */
    neon: 'Neon（PostgreSQL）'
};

function createStore(options = {}) {
    const backend = String(options.backend || process.env.DATA_BACKEND || 'json').toLowerCase();
    if (backend === 'supabase') {
        const { createSupabaseStore } = require('./supabase');
        return createSupabaseStore(options);
    }
    if (backend !== 'json') {
        const err = new Error(`未知的 DATA_BACKEND：${backend}（可用：json / supabase）`);
        err.code = 'UNKNOWN_BACKEND';
        throw err;
    }
    const { createJsonStore } = require('./json');
    return createJsonStore(options);
}

module.exports = { createStore, normalizeHeadword, TABLE_NAMES, DATA_BACKEND_LABEL };
