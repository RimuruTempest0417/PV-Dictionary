/* 密碼雜湊模組
 * - 格式：scrypt$<salt(hex, 16B)>$<hash(hex, 64B)>
 * - 非 scrypt$ 開頭者視為明碼（舊資料相容），登入成功時由伺服器自動升級。
 * - server.js 與 scripts/*.js 共用同一份實作，避免兩份演算法不一致把使用者鎖在門外。
 */
const crypto = require('crypto');

function hashPassword(plain) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
    return `scrypt$${salt}$${hash}`;
}

function needsPasswordUpgrade(stored) {
    return typeof stored === 'string' && stored !== '' && !stored.startsWith('scrypt$');
}

function verifyPassword(stored, input) {
    if (typeof stored !== 'string' || stored === '') return false;
    if (!stored.startsWith('scrypt$')) {
        const a = Buffer.from(stored);
        const b = Buffer.from(String(input));
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    const parts = stored.split('$');
    if (parts.length !== 3) return false;
    const expected = Buffer.from(parts[2], 'hex');
    const candidate = crypto.scryptSync(String(input), parts[1], 64);
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}


/* ---------------- 密碼政策（A-8，2026-10-08 使用者指定：最少 10 碼不會麻煩） ----------------
 * 為什麼是 10：校內帳號是由管理員建立的，8 碼在字典攻擊下太薄；10 碼是好記與夠強的折衷。
 * 回傳 'PASSWORD_LENGTH' 代表不合格，空字串代表可以。 */
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 64;

function passwordProblem(value) {
    const text = String(value === undefined || value === null ? '' : value);
    if (text.length < PASSWORD_MIN || text.length > PASSWORD_MAX) return 'PASSWORD_LENGTH';
    return '';
}

/* 產生一次性臨時密碼（C-3：管理員幫老師重設，畫面顯示一次就不要再存） */
function generateTempPassword() {
    const crypto = require('crypto');
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    let out = '';
    const bytes = crypto.randomBytes(14);
    for (let i = 0; i < 14; i += 1) out += alphabet[bytes[i] % alphabet.length];
    return out;
}

module.exports = {
    PASSWORD_MIN,
    PASSWORD_MAX,
    passwordProblem,
    generateTempPassword, hashPassword, verifyPassword, needsPasswordUpgrade };
