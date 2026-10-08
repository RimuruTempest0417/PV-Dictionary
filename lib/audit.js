/* 稽核日誌
 * 每筆寫入／刪除／發佈／核准／登入登出都要留一筆，並附中文標籤。
 * tests/audit-actions.test.js 會比對「這裡宣告的動作」＝「程式實際會寫的動作」，
 * 不一致時不會有任何錯誤訊息（選單查不到、或永遠查不到紀錄），只能靠測試守。
 */
const AUDIT_ACTION_LABELS = {
    LOGIN: '登入',
    LOGOUT: '登出',
    ENTRY_CREATE: '新增生字',
    ENTRY_UPDATE: '修改生字',
    ENTRY_DELETE: '刪除生字',
    ENTRY_IMPORT: '批次匯入生字',
    ENTRY_APPROVE: '核准生字',
    ENTRY_REJECT: '退回生字',
    AUDIO_UPLOAD: '上傳老師錄音',
    AUDIO_DELETE: '刪除老師錄音',
    BOOK_CREATE: '新增書本',
    BOOK_UPDATE: '修改書本',
    UNIT_CREATE: '新增單元',
    UNIT_UPDATE: '修改單元',
    UNIT_PUBLISH: '發佈單元',
    UNIT_UNPUBLISH: '下架單元',
    USER_CREATE: '新增使用者',
    USER_UPDATE: '修改使用者',
    USER_DELETE: '刪除使用者',
    GRANT_CREATE: '新增授權',
    GRANT_DELETE: '移除授權',
    COVER_UPLOAD: '上傳書本封面',
    COVER_DELETE: '移除書本封面',
    PASSWORD_CHANGE: '修改自己的密碼',
    ERROR_LOG_UPDATE: '處理錯誤紀錄'
};

function actionLabel(action) {
    return AUDIT_ACTION_LABELS[action] || action;
}

/* user：登入者（可為 null＝系統）；details 一律存成字串，列表顯示不會壞掉
 *
 * is_self_test：這一筆是否來自自動化檢查（帶簽章的 X-PV-Self-Test，見 lib/selftest.js）。
 * 從 AsyncLocalStorage 讀（不是參數）：寫入點有三十幾處，一個一個加參數遲早會漏；
 * 而且驗收腳本跑的每一筆都要標到，漏一筆就會在稽核紀錄裡留下像真人操作的痕跡。 */
function logAudit(store, { user, action, targetId = null, details = '', ip = '' }) {
    if (!store || !AUDIT_ACTION_LABELS[action]) return null;
    const row = {
        is_self_test: require('./requestcontext').isSelfTest(),
        user_id: user ? String(user.username || user.id) : 'system',
        display_name: user ? (user.display_name || '') : '',
        role: user ? (user.role || '') : '',
        action,
        target_id: targetId === null || targetId === undefined ? null : String(targetId),
        details: typeof details === 'string' ? details : JSON.stringify(details),
        ip,
        created_at: new Date().toISOString()
    };
    return store.insertAuditLog(row);
}

/* 稽核紀錄的篩選規則（JSON 與 Supabase 兩個資料層共用同一份，避免規則不一致）。
 * 為什麼要共用：篩選條件分散在兩個 adapter 各寫一次，遲早一邊改、一邊忘
 * （畫面顯示「查到 3 筆」但另一邊查到 12 筆，使用者只會覺得系統在騙人）。 */
function normalizeAuditFilters({ q = '', action = '', user = '', from = '', to = '', hide_self_test: hideSelfTest = false } = {}) {
    const clean = (value) => String(value === undefined || value === null ? '' : value).trim();
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
    const fromDate = clean(from);
    const toDate = clean(to);
    return {
        q: clean(q).toLowerCase().slice(0, 80),
        action: clean(action).toUpperCase().slice(0, 40),
        user: clean(user).toLowerCase().slice(0, 40),
        /* 日期用「當天 00:00:00.000Z ~ 23:59:59.999Z」；ISO 字串比大小即為比時間 */
        fromDate: dateOnly.test(fromDate) ? fromDate : '',
        toDate: dateOnly.test(toDate) ? toDate : '',
        from: dateOnly.test(fromDate) ? `${fromDate}T00:00:00.000Z` : '',
        to: dateOnly.test(toDate) ? `${toDate}T23:59:59.999Z` : '',
        /* 預設濾掉自動化檢查（否則每次驗收都在你的稽核紀錄裡多十幾筆假動作） */
        hide_self_test: hideSelfTest === true || hideSelfTest === 'true' || hideSelfTest === '1'
    };
}

function matchesAuditFilters(row, filters) {
    if (!filters) return true;
    if (filters.hide_self_test && row.is_self_test) return false;
    if (filters.action && String(row.action || '').toUpperCase() !== filters.action) return false;
    if (filters.user) {
        const who = `${row.user_id || ''} ${row.display_name || ''}`.toLowerCase();
        if (!who.includes(filters.user)) return false;
    }
    if (filters.from && String(row.created_at || '') < filters.from) return false;
    if (filters.to && String(row.created_at || '') > filters.to) return false;
    if (filters.q) {
        const hay = [row.action, row.user_id, row.display_name, row.details, row.target_id]
            .map((value) => String(value || '').toLowerCase());
        if (!hay.some((value) => value.includes(filters.q))) return false;
    }
    return true;
}

module.exports = { AUDIT_ACTION_LABELS, actionLabel, logAudit, normalizeAuditFilters, matchesAuditFilters };
