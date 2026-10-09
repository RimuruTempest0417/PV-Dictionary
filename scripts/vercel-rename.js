#!/usr/bin/env node
/* 把 Vercel 專案改名（＝換掉 production 網址用到的網域）。
 *
 * 為什麼要獨立一支：改名會讓舊網址失效（你把連結發給學生之後就有影響），
 * 所以要有一步可以「先看會變成什麼、確認沒被別人用走、再真的改」。
 *
 * 用法：
 *   node scripts/vercel-rename.js --check            # 只看現在的名字與網域
 *   node scripts/vercel-rename.js --to gary-dictionary           # 真的改
 *   node scripts/vercel-rename.js --to gary-dictionary --dry-run # 只驗證名字可用，不改
 *
 * 需要 .env 有 VERCEL_TOKEN。
 */
require('dotenv').config();

const TEAM_ID = 'team_m7zLQ66u3WWs3qY1908y01uu';
const PROJECT_ID = 'prj_3BytnR5a2EpXnGzyDAF2mHJdcvyx';

const args = process.argv.slice(2);
function arg(name, fallback = '') {
    const index = args.indexOf(`--${name}`);
    return index > -1 && args[index + 1] ? args[index + 1] : fallback;
}
const CHECK_ONLY = args.includes('--check');
const DRY_RUN = args.includes('--dry-run');
const TARGET = String(arg('to', '')).trim().toLowerCase();

function token() {
    const value = process.env.VERCEL_TOKEN;
    if (!value) {
        console.error('✖ .env 裡沒有 VERCEL_TOKEN');
        process.exit(1);
    }
    return value.trim();
}

async function vercel(method, path, body) {
    const res = await fetch(`https://api.vercel.com${path}`, {
        method,
        headers: {
            /* 值不印出、不進對話 */
            Authorization: `Bearer ${token()}`,
            'Content-Type': 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (err) { data = text; }
    if (!res.ok) {
        const message = (data && (data.error && (data.error.message || data.error.code))) || String(text).slice(0, 200);
        const err = new Error(`HTTP ${res.status}：${message}`);
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
}

function summarize(project) {
    return {
        id: project.id,
        name: project.name,
        aliases: (project.alias || []).map((a) => a.domain),
        targets: (project.targets || {}).production
            ? [].concat(project.targets.production).map((t) => t.alias || t.url || t)
            : []
    };
}

(async () => {
    const before = summarize(await vercel('GET', `/v9/projects/${PROJECT_ID}?teamId=${TEAM_ID}`));
    console.log('現在：', JSON.stringify(before, null, 1));
    if (CHECK_ONLY || !TARGET) {
        if (!TARGET) console.log('（沒有指定 --to <新名字>，只列出狀態）');
        return;
    }
    if (TARGET === before.name) {
        console.log('（名字已經是同一個，不需要改）');
        return;
    }

    /* 先驗證名字可用（別人的專案用走就不能用；dry-run 也在這裡停） */
    try {
        const check = await vercel('PATCH', `/v9/projects/${PROJECT_ID}?teamId=${TEAM_ID}`, { name: TARGET });
        const after = summarize(check);
        if (DRY_RUN) {
            console.log('名字可用（dry-run：已還原成原名字）');
            await vercel('PATCH', `/v9/projects/${PROJECT_ID}?teamId=${TEAM_ID}`, { name: before.name });
            console.log('已還原為：', before.name);
            return;
        }
        console.log('改名後：', JSON.stringify(after, null, 1));
    } catch (err) {
        console.error(`✖ 改名失敗：${err.message}`);
        process.exit(2);
    }

    const readBack = summarize(await vercel('GET', `/v9/projects/${PROJECT_ID}?teamId=${TEAM_ID}`));
    console.log('讀回確認：', JSON.stringify(readBack, null, 1));
    console.log(readBack.name === TARGET ? '✔ 名字已更新' : '✖ 讀回的名字與目標不同');
    const domains = await vercel('GET', `/v9/projects/${PROJECT_ID}/domains?teamId=${TEAM_ID}`);
    console.log('專案網域：', (domains.domains || []).map((d) => `${d.name}${d.verified ? '' : '（未驗證）'}`).join('、'));
})();
