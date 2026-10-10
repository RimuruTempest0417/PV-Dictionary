#!/usr/bin/env node
/* v0.8.0（Neon 影子驗證／搬家預備）：簽一張給 Neon Data API 用的 JWT
 *
 * 為什麼需要這支：Neon Data API 的授權模型是「JWT ＋ Postgres GRANT／RLS」——
 *   **沒有 JWT 一律 400**（實測：`missing authentication credentials: required authorization bearer
 *   token in JWT format`）。Supabase 那種「service_role key 直接繞過 RLS」在 Neon 不適用，
 *   所以我們自己簽 JWT，並把對應的公鑰（JWKS）註冊到 Neon 專案。
 *
 * 用法：
 *   node scripts/neon-jwt.js --make-keys        # 產生金鑰組：公鑰寫 keys/jwks.json、私鑰寫進 .env（不印出內容）
 *   node scripts/neon-jwt.js                    # 印出 JWT（預設 365 天，role=authenticated）
 *   node scripts/neon-jwt.js --quiet            # 只印 token（給 shell 的 $(…) 用，不會顯示在輸出裡）
 *   node scripts/neon-jwt.js --days=30 --role=authenticated
 *
 * 金鑰存放規則（沿用專案規矩）：
 *   - **私鑰永不進版控**：放 `.env` 的 `NEON_JWT_PRIVATE_KEY_B64`（PKCS#8 PEM 的 base64）。
 *   - 公鑰（`keys/jwks.json`）是公開資訊，要能被 Neon 抓到：用 repo 的 raw URL 或自家網域皆可。
 *   - 換金鑰＝重新 --make-keys，然後到 Neon Console → Data API → Settings 換掉 JWKS URL 的內容
 *     （URL 不變的話 Neon 會重新抓取）。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const arg = (name, fallback) => {
    const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const QUIET = process.argv.includes('--quiet');

function base64url(buffer) {
    return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* 公鑰（PEM → JWK）：只留 RSA 需要的欄位，並算一個穩定的 kid */
function jwkFromPublicKey(publicPem) {
    const jwk = crypto.createPublicKey(publicPem).export({ format: 'jwk' });
    const kid = base64url(crypto.createHash('sha256').update(JSON.stringify({ n: jwk.n, e: jwk.e })).digest()).slice(0, 16);
    return Object.assign({ kty: 'RSA', use: 'sig', alg: 'RS256', kid }, { n: jwk.n, e: jwk.e });
}

function makeKeys() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    const jwk = jwkFromPublicKey(publicKey);
    /* 公鑰放在 `public/keys/`：由我們自己的網站提供（同源、不依賴第三方 CDN 的 content-type），
     * 例如 https://gary-dictionary.vercel.app/keys/jwks.json。
     * ★ 只放公鑰；私鑰在 .env（永不進版控、永不進 public）。 */
    const keysDir = path.join(ROOT, 'public', 'keys');
    fs.mkdirSync(keysDir, { recursive: true });
    const jwksPath = path.join(keysDir, 'jwks.json');
    fs.writeFileSync(jwksPath, `${JSON.stringify({ keys: [jwk] }, null, 2)}\n`, 'utf8');

    /* 私鑰寫進 .env（單行 base64，方便放進 Vercel 環境變數；**不印出**） */
    const envPath = path.join(ROOT, '.env');
    const line = `NEON_JWT_PRIVATE_KEY_B64=${Buffer.from(privateKey, 'utf8').toString('base64')}`;
    const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const stripped = current.split('\n').filter((row) => !row.startsWith('NEON_JWT_PRIVATE_KEY_B64=')).join('\n').replace(/\n+$/, '');
    fs.writeFileSync(envPath, `${stripped}\n${line}\n`, 'utf8');

    console.log('✔ 金鑰組已產生');
    console.log(`  kid：${jwk.kid}`);
    console.log(`  公鑰（JWKS）：keys/jwks.json（可以進版控，Neon 要抓到它）`);
    console.log(`  私鑰：已寫入 .env 的 NEON_JWT_PRIVATE_KEY_B64（未顯示、未進版控）`);
    console.log('  → 接著把 JWKS 的 HTTPS URL 註冊到 Neon：Console → Data API → Settings → Add provider');
}

function sign() {
    const raw = process.env.NEON_JWT_PRIVATE_KEY_B64;
    if (!raw) {
        console.error('✖ .env 沒有 NEON_JWT_PRIVATE_KEY_B64（先跑 node scripts/neon-jwt.js --make-keys）');
        process.exit(1);
    }
    const privatePem = Buffer.from(raw, 'base64').toString('utf8');
    const publicPem = crypto.createPublicKey(privatePem).export({ type: 'spki', format: 'pem' });
    const kid = jwkFromPublicKey(publicPem).kid;
    const days = Number(arg('days', 365));
    const role = arg('role', 'authenticated');
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT', kid };
    const payload = {
        role,                                   /* Neon 依這個 claim 決定切到哪個 Postgres 角色 */
        sub: 'gary-dictionary-server',          /* 我們是唯一的客戶端（伺服器自己） */
        iss: 'gary-dictionary',
        iat: now,
        exp: now + days * 24 * 60 * 60
    };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privatePem);
    const token = `${signingInput}.${base64url(signature)}`;
    console.log(QUIET ? token : `${token}\n\n（role=${role}｜exp=${new Date((now + days * 86400) * 1000).toISOString()}｜kid=${kid}）`);
}

if (process.argv.includes('--make-keys')) makeKeys();
else sign();
