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
    PASSWORD_CHANGE: '修改自己的密碼'
};

function actionLabel(action) {
    return AUDIT_ACTION_LABELS[action] || action;
}

/* user：登入者（可為 null＝系統）；details 一律存成字串，列表顯示不會壞掉 */
function logAudit(store, { user, action, targetId = null, details = '', ip = '' }) {
    if (!store || !AUDIT_ACTION_LABELS[action]) return null;
    const row = {
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

module.exports = { AUDIT_ACTION_LABELS, actionLabel, logAudit };
