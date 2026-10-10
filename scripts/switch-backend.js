#!/usr/bin/env node
/* v0.10.0：在 Supabase ↔ Neon 之間切換後端（只改 .env 的兩個變數，程式碼不用動）
 *
 * 為什麼要有這支：搬家當天與**回滾**都必須是一條指令、而且可重複，
 * 不能靠人手改 .env（改錯就整個網站讀不到資料）。金鑰全程不印出。
 *
 * 用法：
 *   node scripts/switch-backend.js --status        # 目前 .env 指向哪個後端（只印網域，不印金鑰）
 *   node scripts/switch-backend.js --to=neon       # 切到 Neon（自動簽一張新的 JWT 放進 .env）
 *   node scripts/switch-backend.js --to=supabase   # 切回 Supabase（用 .env 的 SUPABASE_URL_SUPABASE / SUPABASE_KEY_SUPABASE）
 *   node scripts/switch-backend.js --rollback      # 還原最近一次切換前的 .env
 *
 * 需要 .env 有（都是非機密的設定值）：
 *   NEON_DATA_API_URL=https://<endpoint>.apirest.<region>.aws.neon.tech/<db>   ← 注意：不要帶 /rest/v1
 *   NEON_JWT_AUDIENCE=gary-dictionary
 * 而「Supabase 那一組」在第一次切換時會被存成：
 *   SUPABASE_URL_SUPABASE / SUPABASE_SERVICE_ROLE_KEY_SUPABASE（切回時用）
 */
const { execFileSync } = require('child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const KEY_URL = 'SUPABASE_URL';
const KEY_TOKEN = 'SUPABASE_SERVICE_ROLE_KEY';

function readEnv() {
    const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
    const map = new Map();
    lines.forEach((line, index) => {
        const hit = /^([A-Z0-9_]+)=(.*)$/.exec(line);
        if (hit) map.set(hit[1], hit[2]);
    });
    return { lines, map };
}

function setVar(lines, name, value) {
    const index = lines.findIndex((line) => line.startsWith(`${name}=`));
    if (index >= 0) lines[index] = `${name}=${value}`;
    else lines.push(`${name}=${value}`);
    return lines;
}

function upsertWithComment(lines, name, value, comment) {
    const index = lines.findIndex((line) => line.startsWith(`${name}=`));
    if (index >= 0) {
        lines[index] = `${name}=${value}`;
        if (comment && !lines[index - 1]?.startsWith('#')) lines.splice(index, 0, `# ${comment}`);
    } else {
        if (comment) lines.push(`# ${comment}`);
        lines.push(`${name}=${value}`);
    }
    return lines;
}

function writeEnv(lines) {
    fs.writeFileSync(ENV_PATH, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
}

function backupEnv() {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const target = path.join(ROOT, `.env.bak-${stamp}`);
    fs.copyFileSync(ENV_PATH, target);
    fs.chmodSync(target, 0o600);
    /* 只保留最近 3 份：這些備份含機密（跟 .env 一樣），沒必要一直堆 */
    const olds = fs.readdirSync(ROOT).filter((name) => name.startsWith('.env.bak-')).sort();
    for (const name of olds.slice(0, Math.max(0, olds.length - 3))) {
        fs.rmSync(path.join(ROOT, name), { force: true });
    }
    return path.basename(target);
}

function host(value) {
    try { return new URL(value).host; } catch { return value ? '（不是合法網址）' : '（空）'; }
}

function jwtInfo(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return { isJwt: false, days: null, exp: null };
    try {
        const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        const exp = Number(payload.exp) || null;
        return { isJwt: true, exp, days: exp ? Math.floor((exp * 1000 - Date.now()) / 86400000) : null, role: payload.role };
    } catch (error) {
        return { isJwt: false, days: null, exp: null };
    }
}

function status() {
    const { map } = readEnv();
    const url = map.get(KEY_URL) || '';
    const info = jwtInfo(map.get(KEY_TOKEN));
    const backend = /apirest\..*\.neon\.tech/.test(url) ? 'Neon（Data API）' : (url ? 'Supabase' : '（沒設定）');
    console.log(`目前 .env 指向：${backend}`);
    console.log(`  網域：${host(url)}`);
    console.log(`  金鑰：${info.isJwt ? `JWT（role=${info.role}，還有 ${info.days} 天到期）` : '不是 JWT（Supabase service key）'}`);
    if (map.get('NEON_DATA_API_URL')) console.log(`  Neon 端點（設定值）：${host(map.get('NEON_DATA_API_URL'))}`);
    if (map.get('SUPABASE_URL_SUPABASE')) console.log(`  Supabase 備份值：${host(map.get('SUPABASE_URL_SUPABASE'))}`);
}

function switchTo(target) {
    const { lines, map } = readEnv();
    const backup = backupEnv();
    if (target === 'neon') {
        const neonUrl = map.get('NEON_DATA_API_URL');
        if (!neonUrl) {
            console.error('✖ .env 沒有 NEON_DATA_API_URL（例如 https://ep-xxx.apirest.c-4.ap-southeast-1.aws.neon.tech/neondb）');
            process.exit(1);
        }
        if (/\/rest\/v1/.test(neonUrl)) {
            console.error('✖ NEON_DATA_API_URL 不可以帶 /rest/v1（store 會自己接上去）');
            process.exit(1);
        }
        /* 第一次切換時，把 Supabase 那一組留下來（切回用；程式不讀這兩個名字） */
        const currentUrl = map.get(KEY_URL);
        const currentToken = map.get(KEY_TOKEN);
        if (currentUrl && !map.get('SUPABASE_URL_SUPABASE')) setVar(lines, 'SUPABASE_URL_SUPABASE', currentUrl);
        if (currentToken && !map.get('SUPABASE_SERVICE_ROLE_KEY_SUPABASE')) setVar(lines, 'SUPABASE_SERVICE_ROLE_KEY_SUPABASE', currentToken);

        const audience = map.get('NEON_JWT_AUDIENCE') || 'gary-dictionary';
        /* 簽新 token：用子程序拿輸出，**不經過終端機**，所以不會出現在任何輸出裡 */
        const token = execFileSync('node', [path.join(ROOT, 'scripts', 'neon-jwt.js'), '--quiet', `--aud=${audience}`], {
            encoding: 'utf8', cwd: ROOT
        }).trim();
        if (!token || token.split('.').length !== 3) {
            console.error('✖ 簽不出 JWT（先跑 node scripts/neon-jwt.js --make-keys 產生金鑰）');
            process.exit(1);
        }
        upsertWithComment(lines, 'NEON_JWT_AUDIENCE', audience);
        setVar(lines, KEY_URL, neonUrl);
        setVar(lines, KEY_TOKEN, token);
        writeEnv(lines);
        const info = jwtInfo(token);
        console.log(`✔ 已切到 Neon：${host(neonUrl)}`);
        console.log(`  新 JWT：role=${info.role}、aud=${audience}、還有 ${info.days} 天到期`);
        console.log(`  切換前的 .env 已備份為 ${backup}`);
        console.log('  記得同步到 Vercel：node scripts/vercel-env.js --push-all --deploy');
        return;
    }
    if (target === 'supabase') {
        const url = map.get('SUPABASE_URL_SUPABASE');
        const token = map.get('SUPABASE_SERVICE_ROLE_KEY_SUPABASE');
        if (!url || !token) {
            console.error('✖ .env 沒有存下 Supabase 的那一組（SUPABASE_URL_SUPABASE／…_KEY_SUPABASE）');
            process.exit(1);
        }
        setVar(lines, KEY_URL, url);
        setVar(lines, KEY_TOKEN, token);
        writeEnv(lines);
        console.log(`✔ 已切回 Supabase：${host(url)}`);
        console.log(`  切換前的 .env 已備份為 ${backup}`);
        console.log('  記得同步到 Vercel：node scripts/vercel-env.js --push-all --deploy');
        return;
    }
    console.error(`✖ 不認識的目標：${target}（可用 neon／supabase）`);
    process.exit(1);
}

/* v0.10.0：JWT 輪替（演練或正式）—— 重新簽一張並寫回 .env。
 * ★ 重要：換 token ≠ 撤銷舊 token —— 同一個簽章金鑰簽出來的 token 在到期前都還有有效。
 *   要「立刻撤銷舊 token」必須換簽章金鑰並更新 Neon 的 JWKS（步驟見 docs/搬家到Neon.md）。 */
function rotateJwt() {
    const { lines, map } = readEnv();
    const url = map.get(KEY_URL) || '';
    if (!/neon\.tech/.test(url)) {
        console.error('✖ 目前 .env 不是指向 Neon，沒有 JWT 可以輪替（先 --status 看看）');
        process.exit(1);
    }
    const backup = backupEnv();
    const audience = map.get('NEON_JWT_AUDIENCE') || 'gary-dictionary';
    const token = execFileSync('node', [path.join(ROOT, 'scripts', 'neon-jwt.js'), '--quiet', `--aud=${audience}`], {
        encoding: 'utf8', cwd: ROOT
    }).trim();
    if (!token || token.split('.').length !== 3) {
        console.error('✖ 簽不出 JWT（先跑 node scripts/neon-jwt.js --make-keys 產生金鑰）');
        process.exit(1);
    }
    setVar(lines, KEY_TOKEN, token);
    writeEnv(lines);
    const info = jwtInfo(token);
    console.log(`✔ 已重新簽發 JWT：role=${info.role}、aud=${audience}、還有 ${info.days} 天到期`);
    console.log(`  更換前的 .env 已備份為 ${backup}`);
    console.log('  同步到 Vercel：node scripts/vercel-env.js --push-all --deploy');
    console.log('  ★ 舊 token 到期前仍然有效；要立刻撤銷得換簽章金鑰（docs/搬家到Neon.md）');
}

function rollback() {
    const dir = ROOT;
    const candidates = fs.readdirSync(dir).filter((name) => name.startsWith('.env.bak-')).sort();
    if (!candidates.length) {
        console.error('✖ 找不到 .env.bak-* 備份');
        process.exit(1);
    }
    const latest = candidates[candidates.length - 1];
    fs.copyFileSync(path.join(dir, latest), ENV_PATH);
    fs.chmodSync(ENV_PATH, 0o600);
    console.log(`✔ 已用 ${latest} 覆蓋 .env（請再跑：node scripts/vercel-env.js --push-all --deploy）`);
}

const arg = (name) => {
    const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : '';
};

if (process.argv.includes('--status')) status();
else if (process.argv.includes('--rotate-jwt')) rotateJwt();
else if (arg('to')) switchTo(arg('to'));
else if (process.argv.includes('--rollback')) rollback();
else {
    console.log('用法：node scripts/switch-backend.js [--status | --to=neon | --to=supabase | --rotate-jwt | --rollback]');
    process.exit(1);
}
