/* 認證與來源檢查
 *
 * 設計（比照 competition-manager v3.5.0 之後的作法）：
 * - 憑證放 HttpOnly cookie（pd_token），前端不存 token、不碰 token。
 * - JWT 只放 { sub, username }；**不放 password、不把 role 當授權依據** ——
 *   每個請求都用 sub 去資料庫重新讀取角色（角色被改／被停用立即生效）。
 * - CSRF：帶著 cookie 的寫入請求，來源主機必須是自家（比主機名，不比 scheme ——
 *   Vercel 是反代，req.protocol 會是 http，比 scheme 會把所有線上寫入擋死）。
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'pd_token';
const TOKEN_TTL_SECONDS = 12 * 60 * 60;   // 12 小時

function resolveJwtSecret() {
    const secret = process.env.JWT_SECRET;
    /* 還沒填真的值就不要開門：placeholder 是「猜得到」的字串，等於讓任何人都能偽造權杖 */
    if (secret && secret.length > 0 && !/^REPLACE_ME/.test(secret)) return secret;
    if (process.env.NODE_ENV === 'production') {
        throw new Error(secret
            ? 'JWT_SECRET 還是 REPLACE_ME 佔位值：請在部署環境填入真正的密鑰（可用 `openssl rand -hex 32` 產生）'
            : '缺少 JWT_SECRET 環境變數：production 不接受預設密鑰（避免權杖可被偽造）');
    }
    return 'pv-dictionary-dev-secret';
}

function signToken(user) {
    return jwt.sign({ sub: String(user.id), username: user.username }, resolveJwtSecret(), {
        expiresIn: TOKEN_TTL_SECONDS
    });
}

function verifyToken(token) {
    try {
        const payload = jwt.verify(token, resolveJwtSecret());
        if (!payload || !payload.sub) return null;
        return payload;
    } catch (err) {
        return null;
    }
}

/* 沒裝 cookie-parser：自己解析（Express 5 沒有 req.cookies） */
function parseCookies(req) {
    const header = req.headers && req.headers.cookie;
    const out = {};
    if (!header) return out;
    for (const part of String(header).split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const key = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (key) out[key] = decodeURIComponent(value);
    }
    return out;
}

function tokenFromRequest(req) {
    const cookies = parseCookies(req);
    if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];
    const auth = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    return match ? match[1] : null;
}

function cookieAttributes(maxAge) {
    const parts = [`Path=/`, `HttpOnly`, `SameSite=Strict`, `Max-Age=${maxAge}`];
    if (process.env.NODE_ENV === 'production') parts.push('Secure');
    return parts.join('; ');
}

function setAuthCookie(res, token) {
    res.append('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieAttributes(TOKEN_TTL_SECONDS)}`);
}

function clearAuthCookie(res) {
    res.append('Set-Cookie', `${COOKIE_NAME}=; ${cookieAttributes(0)}`);
}

/* 自家來源清單：只收主機名（scheme 一律不比） */
function allowedRequestHosts(req) {
    const hosts = new Set();
    const host = req.headers.host;
    if (host) hosts.add(String(host).toLowerCase());
    for (const raw of [process.env.SITE_URL, process.env.CORS_ALLOWED_ORIGINS]) {
        if (!raw) continue;
        for (const item of String(raw).split(',')) {
            const value = item.trim();
            if (!value) continue;
            try {
                hosts.add(new URL(value).host.toLowerCase());
            } catch (err) {
                hosts.add(value.toLowerCase());
            }
        }
    }
    const forwarded = req.headers['x-forwarded-host'];
    if (forwarded) hosts.add(String(forwarded).split(',')[0].trim().toLowerCase());
    return hosts;
}

function hostOf(value) {
    if (!value) return null;
    try {
        return new URL(value).host.toLowerCase();
    } catch (err) {
        return null;
    }
}

/* 判斷一個請求是否來自自家網站：
 * - 沒有 Origin 也沒有 Referer（curl／腳本／cron）→ 放行（這種請求不會自動帶 cookie）
 * - 有來源時只比主機名 */
function isTrustedOrigin(req) {
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    if (!origin && !referer) return true;
    const hosts = allowedRequestHosts(req);
    const originHost = hostOf(origin);
    if (originHost) return hosts.has(originHost);
    const refererHost = hostOf(referer);
    if (refererHost) return hosts.has(refererHost);
    return false;
}

/* 只有在「帶著 cookie」的寫入請求上才需要驗來源：
 * 未帶 cookie 的請求沒有可以被借用的身分，驗來源沒有意義。 */
function csrfViolation(req) {
    const method = req.method.toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false;
    if (!parseCookies(req)[COOKIE_NAME] && !/^Bearer\s+/i.test(req.headers.authorization || '')) return false;
    return !isTrustedOrigin(req);
}

/* CORS：只反射白名單來源（自家 host + SITE_URL + CORS_ALLOWED_ORIGINS），其餘完全不設標頭 */
function corsMiddleware(req, res, next) {
    const origin = req.headers.origin;
    if (origin) {
        const hosts = allowedRequestHosts(req);
        const originHost = hostOf(origin);
        if (originHost && hosts.has(originHost)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Credentials', 'true');
            res.setHeader('Vary', 'Origin');
            res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        }
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
}

const SECURITY_HEADERS = buildSecurityHeaders(process.env.NODE_ENV === 'production');

/* 安全標頭（每次請求都套用）。
 * ★ upgrade-insecure-requests 只在 production 加：本機是 http://127.0.0.1，
 *   加了會讓瀏覽器把所有子資源升級成 https → 本機整站掛掉（而且看起來像別的問題）。 */
function buildSecurityHeaders(isProduction) {
    const csp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob: data:",
        "font-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "frame-src 'none'",
        "worker-src 'self'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "base-uri 'self'"
    ];
    if (isProduction) csp.push('upgrade-insecure-requests');
    return {
        'Content-Security-Policy': csp.join('; '),
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        /* 老師錄音需要麥克風、未來若加拍照上傳需要相機 → 只給自家；其餘一律關閉 */
        'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'X-Permitted-Cross-Domain-Policies': 'none'
    };
}

function securityHeaders(req, res, next) {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
    next();
}

module.exports = {
    COOKIE_NAME,
    TOKEN_TTL_SECONDS,
    resolveJwtSecret,
    signToken,
    verifyToken,
    parseCookies,
    tokenFromRequest,
    setAuthCookie,
    clearAuthCookie,
    allowedRequestHosts,
    isTrustedOrigin,
    csrfViolation,
    corsMiddleware,
    securityHeaders,
    buildSecurityHeaders,
    SECURITY_HEADERS
};
