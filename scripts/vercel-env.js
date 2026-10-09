#!/usr/bin/env node
/* 把 .env 裡的機密同步到 Vercel 專案的環境變數，然後重新部署並驗證。
 *
 * 為什麼要有這支：`SUPABASE_SERVICE_ROLE_KEY` 與 `JWT_SECRET` 是機密，
 * **不可以經過對話或文件**。這支腳本讓值只在「.env → Vercel API」之間流動，全程不印出內容。
 *
 * 用法：
 *   node scripts/vercel-env.js --check     # 只列出「哪些變數在 Vercel 上已經有值／還是佔位」（不印值）
 *   node scripts/vercel-env.js --push      # 把 .env 的「機密」值推上去（upsert）
 *   node scripts/vercel-env.js --push-all  # 連一般變數（DATA_BACKEND／SUPABASE_URL／SITE_URL）一起推
 *   node scripts/vercel-env.js --push --deploy   # 推完順便重新部署並等它 READY
 *
 * 需要 .env 有：VERCEL_TOKEN（vercel.com/account/tokens）、JWT_SECRET、SUPABASE_SERVICE_ROLE_KEY
 */
require('dotenv').config();

const TEAM_ID = 'team_m7zLQ66u3WWs3qY1908y01uu';
const PROJECT_ID = 'prj_3BytnR5a2EpXnGzyDAF2mHJdcvyx';
const PROJECT_NAME = 'gary-dictionary';
const PRODUCTION_URL = 'https://gary-dictionary-mylearning.vercel.app';
const SECRET_KEYS = ['JWT_SECRET', 'SUPABASE_SERVICE_ROLE_KEY'];
/* 一般（非機密）變數：只有 --push-all 時才一起更新 */
const PLAIN_KEYS = ['DATA_BACKEND', 'SUPABASE_URL', 'SITE_URL'];

/* ★ 本機的 .env 為了跑 Demo 會是 DATA_BACKEND=json；
 *   這個值**絕對不可以**推上 production（推上去線上就變成讀本機檔案、所有資料消失、查不到任何書）。
 *   所以一般變數有「上線版的值」對照表：--push-all 時用這裡的值，不是 .env 的值。 */
const PRODUCTION_OVERRIDES = { DATA_BACKEND: 'supabase' };

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const PUSH = args.includes('--push') || args.includes('--push-all');
const DEPLOY = args.includes('--deploy');
/* ★ --push-all：連「一般（非機密）變數」也一起覆寫。
 *   預設只覆寫機密（JWT_SECRET／SUPABASE_SERVICE_ROLE_KEY），因為一般變數平常不需要動；
 *   但改網址（SITE_URL）這一類就是一般變數，不帶 --push-all 會以為推上去了其實沒有。 */
const PUSH_ALL = args.includes('--push-all');

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
        console.error('用法：node scripts/vercel-env.js --check | --push [--push-all] [--deploy]');
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

    const pushKeys = PUSH_ALL ? [...SECRET_KEYS, ...PLAIN_KEYS] : [...SECRET_KEYS];
    for (const key of pushKeys) {
        const value = PRODUCTION_OVERRIDES[key] !== undefined ? PRODUCTION_OVERRIDES[key] : process.env[key];
        if (!value || /^REPLACE_ME/.test(value)) {
            console.error(`✖ .env 的 ${key} 沒有有效值（${describe(value)}）`);
            process.exit(1);
        }
    }

    /* 機密用 sensitive（推上去之後介面讀不回來）；一般變數用 plain（SITE_URL 這種要能自己看得到） */
    const payload = [
        ...SECRET_KEYS.map((key) => ({
            key,
            value: process.env[key],
            type: 'sensitive',
            target: ['production', 'preview', 'development']
        })),
        ...(PUSH_ALL ? PLAIN_KEYS.map((key) => ({
            key,
            value: PRODUCTION_OVERRIDES[key] !== undefined ? PRODUCTION_OVERRIDES[key] : process.env[key],
            type: 'plain',
            target: ['production', 'preview', 'development']
        })) : [])
    ];
    await vercel('POST', `/v10/projects/${PROJECT_ID}/env?upsert=true&teamId=${TEAM_ID}`, payload);
    console.log(`✔ 已把 ${pushKeys.join('、')} 推上 Vercel（機密值沒有顯示、也沒有離開這個行程）`);
    if (PUSH_ALL) {
        for (const key of PLAIN_KEYS) {
            console.log(`   ${key} = ${PRODUCTION_OVERRIDES[key] !== undefined ? PRODUCTION_OVERRIDES[key] : describe(process.env[key])}`);
        }
    }

    if (!DEPLOY) {
        console.log('（要順便重新部署請加 --deploy，或在 Vercel 介面按 Redeploy）');
        return;
    }

    const deployments = await vercel('GET', `/v6/deployments?projectId=${PROJECT_ID}&target=production&limit=1&teamId=${TEAM_ID}`);
    const latest = (deployments.deployments || [])[0];
    if (!latest) throw new Error('找不到 production 部署可以重新部署');
    let redeploy;
    try {
        redeploy = await vercel('POST', `/v13/deployments/${latest.id}/redeploy?teamId=${TEAM_ID}&forceNew=1`, {});
    } catch (err) {
        /* 舊版 API：用 git source 直接再建一次（repoId 從專案的 git 連結拿） */
        const project = await vercel('GET', `/v9/projects/${PROJECT_ID}?teamId=${TEAM_ID}`);
        const repoId = project.link && project.link.repoId;
        if (!repoId) throw new Error(`無法重新部署：${err.message}`);
        redeploy = await vercel('POST', `/v13/deployments?teamId=${TEAM_ID}&forceNew=1`, {
            name: PROJECT_NAME,
            gitSource: {
                type: 'github',
                ref: (project.link && project.link.productionBranch) || 'main',
                repoId
            },
            target: 'production'
        });
    }
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
