/* 自動化檢查的簽章標頭（E-4）
 *
 * 問題：驗收腳本（scripts/live-verify.js 等）在正式站跑一輪，就會在稽核紀錄裡留下十幾筆
 * 看起來像真人操作的動作（登入、新增、刪除…），而且每次驗收都會多一批，很難分辨。
 *
 * 做法：腳本帶 `X-PV-Self-Test: <時間戳>.<HMAC>`，HMAC 用 JWT_SECRET 簽
 * （只有拿得到密鑰的腳本簽得出來；一般使用者偽造不了）。伺服器驗簽通過、且時間戳在
 * ±5 分鐘內，就把這一輪的稽核與錯誤日誌標成 `is_self_test=true`，預設檢視可以濾掉。
 *
 * ★ 沒帶、簽錯、過期 → 一律當成真人操作（照常記錄）。絕不因為標頭就放行任何權限。
 */
const crypto = require('crypto');

const HEADER = 'x-pv-self-test';
const MAX_SKEW_MS = 5 * 60 * 1000;

function signature(secret, timestamp) {
    return crypto.createHmac('sha256', String(secret)).update(`pv-self-test:${timestamp}`).digest('hex');
}

/* 腳本端：組出要送出的標頭值 */
function makeHeader(secret, now = Date.now()) {
    const timestamp = String(now);
    return `${timestamp}.${signature(secret, timestamp)}`;
}

/* 伺服器端：驗證請求帶的標頭（回傳 true 才標成自動化檢查） */
function verifyHeader(secret, value, now = Date.now()) {
    if (!secret || !value) return false;
    const [timestamp, provided] = String(value).split('.');
    if (!timestamp || !provided) return false;
    const age = Math.abs(now - Number(timestamp));
    if (!Number.isFinite(age) || age > MAX_SKEW_MS) return false;
    const expected = signature(secret, timestamp);
    if (expected.length !== provided.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
    } catch (err) {
        return false;
    }
}

/* 從 express 的 req 取標頭並驗證 */
function verifyRequest(secret, req) {
    if (!req || !req.headers) return false;
    return verifyHeader(secret, req.headers[HEADER], Date.now());
}

module.exports = { HEADER, MAX_SKEW_MS, makeHeader, verifyHeader, verifyRequest, signature };
