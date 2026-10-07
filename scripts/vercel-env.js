#!/usr/bin/env node
/* 把 .env 裡的機密同步到 Vercel 專案的環境變數，然後重新部署並驗證。
 *
 * 為什麼要有這支：`SUPABASE_SERVICE_ROLE_KEY` 與 `JWT_SECRET` 是機密，
 * **不可以經過對話或文件**。這支腳本讓值只在「.env → Vercel API」之間流動，全程不印出內容。
 *
 * 用法：
 *   node scripts/vercel-env.js --check     # 只列出「哪些變數在 Vercel 上已經有值／還是佔位」（不印值）
 *   node scripts/vercel-env.js --push      # 把 .env 的值推上去（upsert）
 *   node scripts/vercel-env.js --push --deploy   # 推完順便重新部署並等它 READY
 *
 * 需要 .env 有：VERCEL_TOKEN（vercel.com/account/tokens）、JWT_SECRET、SUPABASE_SERVICE_ROLE_KEY
 */
require('dotenv').config();

const TEAM_ID = 'team_m7zLQ66u3WWs3qY1908y01uu';
const PROJECT_ID = 'prj_3BytnR5a2EpXnGzyDAF2mHJdcvyx';
const PROJECT_NAME = 'pv-dictionary';
const PRODUCTION_URL = 'https://pv-dictionary-mylearning.vercel.app';
const SECRET_KEYS = ['JWT_SECRET', 'SUPABASE_SERVICE_ROLE_KEY'];

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const PUSH = args.includes('--push');
const DEPLOY = args.includes('--deploy');

function token() {
    const value = process.env.VERCEL_TOKEN;
    if (!value) {
        console.error('✖ .env 裡沒有 VERCEL_TOKEN（vercel.com/account/tokens 建立後貼進 .env）');
        process.exit(1);
    }
    return value.trim();
}

async function vercel(method, path, body) {
    const res = await fetch(`https://api.vercel.com${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${token()}`,
            'Content-Type': 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (err) { data = text; }
    if (!res.ok) {
        throw new Error(`${method} ${path} → HTTP ${res.status}：${String(text).slice(0, 300)}`);
    }
    return data;
}

function describe(value) {
    if (!value) return '（空）';
    if (/^REPLACE_ME/.test(value)) return '佔位值（要換）';
    return `已設定（長度 ${value.length}）`;
}

async function main() {
    if (!CHECK && !PUSH) {
        console.error('用法：node scripts/vercel-env.js --check | --push [--deploy]');
        process.exit(1);
    }

    console.log(`專案：${PROJECT_NAME}（${PROJECT_ID}）`);
    const existing = await vercel('GET', `/v9/projects/${PROJECT_ID}/env?teamId=${TEAM_ID}&decrypt=false`);
    const list = Array.isArray(existing) ? existing : (existing.envs || []);
    for (const key of ['DATA_BACKEND', 'SUPABASE_URL', 'SITE_URL', ...SECRET_KEYS]) {
        const rows = list.filter((row) => row.key === key);
        if (!rows.length) {
            console.log(`  ${key}: （Vercel 上還沒有這個變數）`);
            continue;
        }
        const row = rows[0];
        const hint = row.type === 'sensitive' || row.type === 'encrypted'
            ? `type=${row.type}（值在介面上看不到，只能覆寫）`
            : describe(row.value);
        console.log(`  ${key}: ${hint}`);
    }
    if (CHECK) {
        const localCheck = SECRET_KEYS.map((key) => `${key}=${describe(process.env[key])}`).join('、');
        console.log(`本機 .env：${localCheck}`);
        return;
    }

    for (const key of SECRET_KEYS) {
        const value = process.env[key];
        if (!value || /^REPLACE_ME/.test(value)) {
            console.error(`✖ .env 的 ${key} 沒有有效值（${describe(value)}）`);
            process.exit(1);
        }
    }

    const payload = SECRET_KEYS.map((key) => ({
        key,
        value: process.env[key],
        type: 'sensitive',
        target: ['production', 'preview', 'development']
    }));
    await vercel('POST', `/v10/projects/${PROJECT_ID}/env?upsert=true&teamId=${TEAM_ID}`, payload);
    console.log(`✔ 已把 ${SECRET_KEYS.join('、')} 推上 Vercel（values 沒有顯示、也沒有離開這個行程）`);

    if (!DEPLOY) {
        console.log('（要順便重新部署請加 --deploy，或在 Vercel 介面按 Redeploy）');
        return;
    }

    const deployments = await vercel('GET', `/v6/deployments?projectId=${PROJECT_ID}&target=production&limit=1&teamId=${TEAM_ID}`);
    const latest = (deployments.deployments || [])[0];
    if (!latest) throw new Error('找不到 production 部署可以重新部署');
    const redeploy = await vercel('POST', `/v13/deployments?teamId=${TEAM_ID}&forceNew=1`, {
        name: PROJECT_NAME,
        deploymentId: latest.id,
        target: 'production'
    });
    console.log(`✔ 已觸發重新部署：${redeploy.id}`);

    for (let i = 0; i < 40; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 6000));
        const state = await vercel('GET', `/v13/deployments/${redeploy.id}?teamId=${TEAM_ID}`);
        process.stdout.write(`   狀態：${state.readyState}\n`);
        if (state.readyState === 'READY') break;
        if (state.readyState === 'ERROR' || state.readyState === 'CANCELED') throw new Error(`部署失敗：${state.readyState}`);
    }

    console.log('\n--- 上線驗證 ---');
    for (const path of ['/api/health', '/api/books', '/']) {
        const res = await fetch(`${PRODUCTION_URL}${path}`);
        const body = await res.text();
        console.log(`${path} → HTTP ${res.status}｜${body.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
}

main().catch((err) => {
    console.error('✖ 失敗：', err.message);
    process.exitCode = 1;
});
