/* 兩步驟驗證的單元測試（A-1）
 *
 * 最重要的一條：**照 RFC 6238 的官方測試向量驗**（附錄 B 的 SHA1 那組）。
 * 只要這一條通過，就代表我們的 TOTP 與 Google Authenticator／Microsoft Authenticator 算出來的碼一致 ——
 * 這種東西不能靠「看起來有在動」來判斷對不對。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Totp = require('../lib/totp');

/* RFC 6238 附錄 B：SHA1 的種子 = ASCII "12345678901234567890" */
const RFC_SECRET = Totp.base32Encode(Buffer.from('12345678901234567890', 'ascii'));

test('RFC 6238 官方向量（SHA1，8 位碼）', () => {
    const vectors = [
        [59, '94287082'],
        [1111111109, '07081804'],
        [1111111111, '14050471'],
        [1234567890, '89005924'],
        [2000000000, '69279037'],
        [20000000000, '65353130']
    ];
    for (const [unixSeconds, expected] of vectors) {
        assert.equal(Totp.codeAt(RFC_SECRET, unixSeconds, 8), expected, `t=${unixSeconds} 應該算出 ${expected}`);
    }
});

test('base32 來回轉換（含補齊的 = 與小寫輸入）', () => {
    const raw = Buffer.from('hello world, 生字');
    const encoded = Totp.base32Encode(raw);
    assert.equal(Totp.base32Decode(encoded).toString('utf8'), raw.toString('utf8'));
    assert.equal(Totp.base32Decode(encoded.toLowerCase()).toString('utf8'), raw.toString('utf8'));
    assert.equal(Totp.base32Decode(encoded.replace(/=+$/, '')).toString('utf8'), raw.toString('utf8'));
    assert.throws(() => Totp.base32Decode('0189'), /base32/);
});

test('驗碼：現在可以、前後 30 秒可以、超過就不行', () => {
    const secret = Totp.generateSecret();
    const now = 1_700_000_000_000;                     /* 毫秒 */
    const step = Totp.STEP_SECONDS * 1000;
    const current = Totp.codeAt(secret, now / 1000);
    assert.equal(Totp.verifyCode(secret, current, { now }), true);
    assert.equal(Totp.verifyCode(secret, Totp.codeAt(secret, (now + step) / 1000), { now }), true, '快 30 秒也算（容忍時鐘偏差）');
    assert.equal(Totp.verifyCode(secret, Totp.codeAt(secret, (now - step) / 1000), { now }), true);
    assert.equal(Totp.verifyCode(secret, Totp.codeAt(secret, (now + 3 * step) / 1000), { now }), false, '差 90 秒就不行');
    assert.equal(Totp.verifyCode(secret, Totp.codeAt(secret, (now - 3 * step) / 1000), { now }), false);
});

test('驗碼：格式不對一律拒絕（不會因為例外就放行）', () => {
    const secret = Totp.generateSecret();
    for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, '00000a', ' 12 34 5 ']) {
        assert.equal(Totp.verifyCode(secret, bad), false, `${JSON.stringify(bad)} 應該被拒絕`);
    }
    /* 空白會被清掉，所以 '123 456' 這種可以接受 */
    const now = Date.now();
    const spaced = Totp.codeAt(secret, now / 1000).split('').join(' ');
    assert.equal(Totp.verifyCode(secret, spaced, { now }), true);
});

test('不同密鑰算出來的碼不同（不是永遠回同一個值）', () => {
    const a = Totp.generateSecret();
    const b = Totp.generateSecret();
    const now = Date.now();
    assert.notEqual(Totp.codeAt(a, now / 1000), Totp.codeAt(b, now / 1000));
});

test('密鑰加密：存進資料庫的是密文，金鑰不對就解不開', () => {
    const secret = Totp.generateSecret();
    const blob = Totp.encryptSecret(secret, 'jwt-secret-1');
    assert.equal(blob.includes(secret), false, '密文不可以包含明文密鑰');
    assert.match(blob, /^v1\./);
    assert.equal(Totp.decryptSecret(blob, 'jwt-secret-1'), secret);
    assert.equal(Totp.decryptSecret(blob, '另一個金鑰'), '', '金鑰不對要當成沒有綁定');
    assert.equal(Totp.decryptSecret('壞掉的資料', 'jwt-secret-1'), '');
    assert.equal(Totp.decryptSecret('', 'jwt-secret-1'), '');
    /* 同樣的明文加密兩次會不一樣（有隨機 iv） */
    assert.notEqual(Totp.encryptSecret(secret, 'jwt-secret-1'), blob);
});

test('備援碼：只存雜湊、用過就消失', () => {
    const key = 'jwt-secret-1';
    const codes = Totp.generateBackupCodes();
    assert.equal(codes.length, Totp.BACKUP_CODE_COUNT);
    assert.equal(new Set(codes).size, codes.length, '不可以重複');
    for (const code of codes) assert.match(code, /^[A-Z2-9]{10}$/);

    const hashes = codes.map((code) => Totp.hashBackupCode(code, key));
    assert.equal(hashes.some((hash) => codes.includes(hash)), false, '不可以存明文');

    const first = Totp.consumeBackupCode(hashes, codes[0], key);
    assert.equal(first.ok, true);
    assert.equal(first.remaining.length, hashes.length - 1);
    const again = Totp.consumeBackupCode(first.remaining, codes[0], key);
    assert.equal(again.ok, false, '同一個備援碼不能重複使用');
    assert.equal(Totp.consumeBackupCode(first.remaining, 'WRONGCODE1', key).ok, false);
    assert.equal(Totp.consumeBackupCode(null, codes[1], key).ok, false);
    /* 使用者可能輸入小寫或帶空白／連字號 */
    assert.equal(Totp.consumeBackupCode(hashes, codes[1].toLowerCase(), key).ok, true);
});

test('otpauth 網址：手機 App 需要的欄位都在', () => {
    const url = Totp.otpauthURL('ABCDEFGH', 'gary@example.com');
    assert.match(url, /^otpauth:\/\/totp\//);
    assert.match(url, /secret=ABCDEFGH/);
    assert.match(url, /issuer=PV_Dictionary/);
    assert.match(url, /digits=6/);
    assert.match(url, /period=30/);
    assert.match(url, /algorithm=SHA1/);
});
