/* 兩步驟驗證（TOTP, RFC 6238）—— A-1
 *
 * 為什麼自己寫而不是裝套件：
 *   1. 只需要「產生密鑰、算 6 位碼、驗碼」三件事，一個檔案就寫完，比拉一個依賴安全（供應鏈風險）。
 *   2. RFC 有官方向量可以逐項驗（tests/totp.test.js 就是照官方測試向量跑的），正確性不必靠感覺。
 *
 * 安全設計：
 *   - 密鑰（base32）**加密後才存資料庫**：金鑰由 JWT_SECRET 衍生（AES-256-GCM）。
 *     資料庫外洩時，攻擊者拿不到可直接產生驗證碼的密鑰。金鑰換掉＝所有 2FA 要重新綁（可接受）。
 *   - 驗碼允許前後一個時間窗（±30 秒）以容忍裝置時鐘偏差；超出就拒絕。
 *   - 備援碼只存雜湊（sha256 + 密鑰），用過一次就從清單移除。
 *   - 驗證碼比對用 timingSafeEqual，且長度不同直接回 false（不洩漏資訊）。
 */
const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DIGITS = 6;
const STEP_SECONDS = 30;
const WINDOW = 1;                 /* 前後各一個時間窗 */
const BACKUP_CODE_COUNT = 8;
const BACKUP_CODE_LENGTH = 10;

/* ---------------- base32 ---------------- */
function base32Encode(buffer) {
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    while (output.length % 8 !== 0) output += '=';
    return output;
}

function base32Decode(input) {
    const clean = String(input || '').toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
    let bits = 0;
    let value = 0;
    const bytes = [];
    for (const char of clean) {
        const index = BASE32_ALPHABET.indexOf(char);
        if (index === -1) throw new Error(`不是合法的 base32：${char}`);
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

/* ---------------- 核心 ---------------- */
function generateSecret() {
    return base32Encode(crypto.randomBytes(20));
}

/* counter = floor(unixTime / 30)，HMAC-SHA1，動態截斷，取 digits 位 */
function hotp(secret, counter, digits = DIGITS) {
    const key = base32Decode(secret);
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    buffer.writeUInt32BE(counter % 0x100000000, 4);
    const digest = crypto.createHmac('sha1', key).update(buffer).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const binary = ((digest[offset] & 0x7f) << 24)
        | ((digest[offset + 1] & 0xff) << 16)
        | ((digest[offset + 2] & 0xff) << 8)
        | (digest[offset + 3] & 0xff);
    return String(binary % (10 ** digits)).padStart(digits, '0');
}

function codeAt(secret, unixSeconds, digits = DIGITS) {
    return hotp(secret, Math.floor(unixSeconds / STEP_SECONDS), digits);
}

/* 驗證使用者輸入的 6 位碼（允許前後一個時間窗） */
function verifyCode(secret, input, options = {}) {
    const digits = options.digits || DIGITS;
    const now = Math.floor((options.now === undefined ? Date.now() : options.now) / 1000);
    const cleaned = String(input || '').replace(/\s/g, '');
    if (!new RegExp(`^\\d{${digits}}$`).test(cleaned)) return false;
    for (let offset = -WINDOW; offset <= WINDOW; offset += 1) {
        const candidate = codeAt(secret, now + offset * STEP_SECONDS, digits);
        if (candidate.length === cleaned.length
            && crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(cleaned))) {
            return true;
        }
    }
    return false;
}

/* 手機 App 掃的 otpauth:// 網址（Google Authenticator／Microsoft Authenticator 都吃這個） */
function otpauthURL(secret, account, issuer = 'PV_Dictionary') {
    const label = encodeURIComponent(`${issuer}:${account}`);
    const params = new URLSearchParams({
        secret,
        issuer,
        algorithm: 'SHA1',
        digits: String(DIGITS),
        period: String(STEP_SECONDS)
    });
    return `otpauth://totp/${label}?${params.toString()}`;
}

/* ---------------- 加密（存進資料庫的密鑰） ---------------- */
function encryptionKey(secret) {
    if (!secret) throw new Error('缺少加密用的密鑰（JWT_SECRET）');
    return crypto.createHash('sha256').update(`pv-totp:${secret}`).digest();
}

function encryptSecret(plain, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(key), iv);
    const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptSecret(blob, key) {
    const parts = String(blob || '').split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return '';
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(key), Buffer.from(parts[1], 'base64url'));
        decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
    } catch (err) {
        /* 金鑰換了、或資料被改過 → 當成沒有綁定（呼叫端要讓使用者重新綁） */
        return '';
    }
}

/* ---------------- 備援碼 ---------------- */
function generateBackupCodes(count = BACKUP_CODE_COUNT) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   /* 去掉容易看錯的 0/O/1/I */
    const codes = [];
    for (let i = 0; i < count; i += 1) {
        let code = '';
        const bytes = crypto.randomBytes(BACKUP_CODE_LENGTH);
        for (let j = 0; j < BACKUP_CODE_LENGTH; j += 1) code += alphabet[bytes[j] % alphabet.length];
        codes.push(code);
    }
    return codes;
}

function hashBackupCode(code, key) {
    return crypto.createHash('sha256').update(`pv-backup:${String(code).toUpperCase().replace(/[\s-]/g, '')}:${key}`).digest('hex');
}

/* 檢查並「用掉」一個備援碼：回傳 { ok, remaining } */
function consumeBackupCode(codes, input, key) {
    const list = Array.isArray(codes) ? codes : [];
    const hash = hashBackupCode(input, key);
    const index = list.indexOf(hash);
    if (index === -1) return { ok: false, remaining: list };
    const remaining = list.slice(0, index).concat(list.slice(index + 1));
    return { ok: true, remaining };
}

module.exports = {
    DIGITS,
    STEP_SECONDS,
    WINDOW,
    BACKUP_CODE_COUNT,
    BASE32_ALPHABET,
    base32Encode,
    base32Decode,
    generateSecret,
    hotp,
    codeAt,
    verifyCode,
    otpauthURL,
    encryptSecret,
    decryptSecret,
    generateBackupCodes,
    hashBackupCode,
    consumeBackupCode
};
