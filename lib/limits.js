/* 用量上限與警告門檻 —— **唯一來源**（D-6）
 *
 * 為什麼集中在這裡：`server.js`（/api/health、/api/admin/stats）、`scripts/db-usage.js`、
 * `scripts/uptime-check.js` 都要用同一組數字。各寫一份遲早會不一致，而且「到幾 % 要處理」
 * 這種數字最怕兩邊不同（一邊說正常、一邊說該清了）。
 *
 * 環境變數可以覆寫（測試與未來換方案用）：
 *   DB_QUOTA_MB=500  DB_USAGE_WARN_PERCENT=70  AUDIO_MAX_PER_UNIT=60
 */
const DB_QUOTA_MB = Number(process.env.DB_QUOTA_MB || 500);          /* Supabase 免費方案：500MB */
const DB_QUOTA_BYTES = DB_QUOTA_MB * 1024 * 1024;
const DB_USAGE_WARN_PERCENT = Number(process.env.DB_USAGE_WARN_PERCENT || 70);
const AUDIO_MAX_PER_UNIT = Number(process.env.AUDIO_MAX_PER_UNIT || 60);

function humanBytes(bytes) {
    if (!Number.isFinite(bytes)) return null;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/* 位元組 → 百分比（一位小數）。沒有配額時回 null —— 不要假裝是 0%。 */
function usagePercent(bytes, quotaBytes = DB_QUOTA_BYTES) {
    if (!Number.isFinite(bytes) || !Number.isFinite(quotaBytes) || quotaBytes <= 0) return null;
    return Math.round((bytes / quotaBytes) * 1000) / 10;
}

/* 統一給人／程式看的用量狀態（server 與腳本共用同一組欄位名）。
 * ★ `available:false` 代表「不知道」——例如資料庫的 `dict_db_size()` 還沒建立時，
 *   要誠實說不知道，不可以回 0 假裝很空。 */
function usageState(bytes, options = {}) {
    const quotaBytes = Number.isFinite(options.quotaBytes) ? options.quotaBytes : DB_QUOTA_BYTES;
    const warnPercent = Number.isFinite(options.warnPercent) ? options.warnPercent : DB_USAGE_WARN_PERCENT;
    const known = Number.isFinite(bytes) && bytes >= 0;
    const percent = usagePercent(known ? bytes : NaN, quotaBytes);
    return {
        available: known,
        bytes: known ? bytes : null,
        human: known ? humanBytes(bytes) : null,
        quota_bytes: quotaBytes,
        quota_human: humanBytes(quotaBytes),
        percent,
        warn_percent: warnPercent,
        warn: percent !== null && percent >= warnPercent,
        source: options.source || 'unknown',
        reason: known ? null : (options.reason || 'unknown')
    };
}

module.exports = {
    DB_QUOTA_MB, DB_QUOTA_BYTES, DB_USAGE_WARN_PERCENT, AUDIO_MAX_PER_UNIT,
    usagePercent, usageState, humanBytes
};
