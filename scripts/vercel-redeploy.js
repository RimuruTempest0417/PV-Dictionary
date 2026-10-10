#!/usr/bin/env node
/* 重新部署現在的 main 到 production（Vercel），並讀回專案網域。
 *
 * ★ 為什麼不呼叫「redeploy」端點：`POST /v13|v12|v10/deployments/<id>/redeploy` 現在一律回
 *   404 `not_found`（2026-10 實測；改名後想用它觸發新部署才發現）。
 *   可用的做法是用 GitHub 整合建立新部署：`POST /v13/deployments` 帶 gitSource（repoId + ref），
 *   效果等於在 Vercel 介面按 Redeploy，而且會吃到**最新的環境變數**（換網址／改變數後就需要它）。
 *
 * 用法：node scripts/vercel-redeploy.js [--wait]
 *   需要 .env 有 VERCEL_TOKEN。
 */
require('dotenv').config();
const TEAM_ID = 'team_m7zLQ66u3WWs3qY1908y01uu';
const PROJECT_ID = 'prj_3BytnR5a2EpXnGzyDAF2mHJdcvyx';
const PROJECT_NAME = 'gary-dictionary';
const REPO_ID = 1408878666;          /* RimuruTempest0417/Gary-Dictionary（GET /v9/projects/<id>.link.repoId） */
const BRANCH = 'main';
const WAIT = process.argv.includes('--wait');

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
    const created = await vercel('POST', `/v13/deployments?teamId=${TEAM_ID}&forceNew=1`, {
        name: PROJECT_NAME,
        project: PROJECT_ID,
        target: 'production',
        gitSource: { type: 'github', repoId: REPO_ID, ref: BRANCH }
    });
    console.log(`已觸發 production 部署：${created.id}（${created.url || ''}）`);
    if (WAIT) {
        for (let i = 0; i < 60; i += 1) {
            await sleep(10000);
            const state = await vercel('GET', `/v13/deployments/${created.id}?teamId=${TEAM_ID}`);
            process.stdout.write(`\r狀態：${state.readyState}（第 ${i + 1} 次）   `);
            if (state.readyState === 'READY' || state.readyState === 'ERROR') {
                console.log(`\n最終狀態：${state.readyState}｜url：${state.url}`);
                break;
            }
        }
    }
    const domains = await vercel('GET', `/v9/projects/${PROJECT_ID}/domains?teamId=${TEAM_ID}`);
    console.log('專案網域：', (domains.domains || []).map((d) => d.name).join('、'));
    const project = await vercel('GET', `/v9/projects/${PROJECT_ID}?teamId=${TEAM_ID}`);
    console.log('專案名稱：', project.name);
})();
