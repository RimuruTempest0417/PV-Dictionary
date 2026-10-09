#!/usr/bin/env node
/* 管理 Vercel 專案的網域（把舊網址、短網址都接到專案上）。
 *
 * 為什麼要這支：
 *   - 專案改名（pv-dictionary → gary-dictionary）之後，**舊網址不會再跟著新部署走**（停在改名當時那一版）。
 *     學校發出去的連結／學生的書籤還在用它 → 要主動把它重新加到專案上。
 *   - `gary-dictionary.vercel.app` 這種短網址要明確登記才會生效。
 *
 * 用法：
 *   node scripts/vercel-domains.js --list
 *   node scripts/vercel-domains.js --add gary-dictionary.vercel.app pv-dictionary-mylearning.vercel.app
 *   node scripts/vercel-domains.js --remove <domain>
 */
require('dotenv').config();

const TEAM_ID = 'team_m7zLQ66u3WWs3qY1908y01uu';
const PROJECT_ID = 'prj_3BytnR5a2EpXnGzyDAF2mHJdcvyx';

const args = process.argv.slice(2);
function valuesAfter(flag) {
    const at = args.indexOf(flag);
    if (at === -1) return [];
    return args.slice(at + 1).filter((value) => !value.startsWith('--'));
}

async function vercel(method, path, body) {
    const res = await fetch(`https://api.vercel.com${path}`, {
        method,
        headers: { Authorization: `Bearer ${String(process.env.VERCEL_TOKEN).trim()}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (err) { data = text; }
    if (!res.ok) {
        const code = data && data.error && data.error.code;
        const err = new Error(`${method} ${path} → HTTP ${res.status}（${code || ''}）：${String(text).slice(0, 200)}`);
        err.status = res.status;
        err.code = code;
        throw err;
    }
    return data;
}

async function list() {
    const data = await vercel('GET', `/v9/projects/${PROJECT_ID}/domains?teamId=${TEAM_ID}&limit=100`);
    console.log('專案網域：');
    for (const domain of (data.domains || [])) {
        console.log(`  - ${domain.name}｜verified=${domain.verified}`);
    }
    if (!(data.domains || []).length) console.log('  （沒有）');
    return data.domains || [];
}

(async () => {
    if (args.includes('--list') || (!args.length)) {
        await list();
        return;
    }
    for (const name of valuesAfter('--remove')) {
        await vercel('DELETE', `/v9/projects/${PROJECT_ID}/domains/${name}?teamId=${TEAM_ID}`);
        console.log(`已移除：${name}`);
    }
    for (const name of valuesAfter('--add')) {
        try {
            const added = await vercel('POST', `/v10/projects/${PROJECT_ID}/domains?teamId=${TEAM_ID}`, { name });
            console.log(`已加入：${added.name}｜verified=${added.verified}`);
        } catch (err) {
            if (err.code === 'domain_already_in_use' || err.status === 409) {
                console.log(`（${name} 已經在專案上了）`);
            } else if (err.code === 'domain_taken' || /already exists/i.test(err.message)) {
                console.log(`✖ ${name} 被別的專案／帳號用走：${err.message}`);
            } else {
                console.log(`✖ ${name}：${err.message}`);
            }
        }
    }
    await list();
})();
