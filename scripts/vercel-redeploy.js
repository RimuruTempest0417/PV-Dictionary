#!/usr/bin/env node
/* 重新部署現在的 production 版本，並讀回「專案現在有哪些網域」。
 * 用途：專案改名後，要有一個新的 production 部署，新的 *.vercel.app 網域才會被指派。
 */
require('dotenv').config();
const TEAM_ID = 'team_m7zLQ66u3WWs3qY1908y01uu';
const PROJECT_ID = 'prj_3BytnR5a2EpXnGzyDAF2mHJdcvyx';

async function vercel(method, path, body) {
    const res = await fetch(`https://api.vercel.com${path}`, {
        method,
        headers: { Authorization: `Bearer ${String(process.env.VERCEL_TOKEN).trim()}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (err) { data = text; }
    if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}：${String(text).slice(0, 300)}`);
    return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const list = await vercel('GET', `/v6/deployments?projectId=${PROJECT_ID}&target=production&limit=1&teamId=${TEAM_ID}`);
    const latest = list.deployments && list.deployments[0];
    if (!latest) throw new Error('找不到 production 部署');
    console.log('最新 production 部署：', latest.url, latest.state);
    /* ★ 清單回的是 uid（不是 id）—— 用 id 會變成 /deployments/undefined/redeploy 404 */
    const redeploy = await vercel('POST', `/v13/deployments/${latest.uid || latest.id}/redeploy?teamId=${TEAM_ID}&forceNew=1`, { name: 'gary-dictionary' });
    console.log('已觸發重新部署：', redeploy.id);
    for (let i = 0; i < 60; i += 1) {
        await sleep(10000);
        const state = await vercel('GET', `/v13/deployments/${redeploy.id}?teamId=${TEAM_ID}`);
        process.stdout.write(`\r狀態：${state.readyState}（第 ${i + 1} 次）   `);
        if (state.readyState === 'READY' || state.readyState === 'ERROR') {
            console.log('\n最終狀態：', state.readyState, '｜url:', state.url);
            break;
        }
    }
    const domains = await vercel('GET', `/v9/projects/${PROJECT_ID}/domains?teamId=${TEAM_ID}`);
    console.log('專案網域：', (domains.domains || []).map((d) => d.name).join('、'));
    const project = await vercel('GET', `/v9/projects/${PROJECT_ID}?teamId=${TEAM_ID}`);
    console.log('專案名稱：', project.name);
})();
