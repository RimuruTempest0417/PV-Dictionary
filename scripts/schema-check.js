#!/usr/bin/env node
/* schema 有沒有跟上程式？
 *
 * ① 本機：`lib/schema.js` 的 EXPECTED_COLUMNS（程式會用到的欄位）vs `migrations/*.sql`
 *    → 抓「加了功能卻忘了寫遷移檔」（書本封面就是這樣漏掉的，上線才 500）
 * ② 線上：同一份清單 vs Supabase 實際 schema（PostgREST 的 OpenAPI definitions）
 *    → 抓「遷移檔還沒套用到線上」
 *
 * 用法：
 *   node scripts/schema-check.js            兩項都檢查（需要 .env 的 SUPABASE_URL / SERVICE_ROLE_KEY）
 *   node scripts/schema-check.js --offline  只檢查遷移檔（不需要網路）
 */
require('dotenv').config();

const path = require('path');
const { EXPECTED_COLUMNS, compareWithMigrations, compareWithLive, probeLiveColumns } = require('../lib/schema');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');
const OFFLINE = process.argv.includes('--offline');

function show(list, label) {
    for (const item of list) {
        console.log(`    - ${label} ${item.table}.${item.column}${item.note ? `（${item.note}）` : ''}`);
    }
}

async function main() {
    let fail = 0;

    console.log('① 遷移檔 vs 程式要用的欄位');
    const local = compareWithMigrations(MIGRATIONS_DIR);
    console.log(`   遷移檔：${local.files.join('、') || '（沒有）'}`);
    if (local.missing.length) {
        fail += 1;
        console.log('   ✖ 遷移檔缺少這些欄位（程式會用到，線上會直接 500）：');
        show(local.missing, '缺');
    } else {
        console.log('   ✔ 程式要用的欄位，遷移檔都有');
    }
    if (local.extra.length) {
        console.log('   （提醒）遷移檔有、程式沒用到的欄位：');
        show(local.extra, '多');
    }

    /* ★ v0.10.1：Neon 版 schema 也要一起守 —— v0.10.0 起真正在線上跑的是 migrations/neon/，
     * 以前只看 migrations/，Neon 版漂移（少欄位）不會被發現。 */
    try {
        const neon = compareWithMigrations(path.join(MIGRATIONS_DIR, 'neon'));
        console.log(`   Neon 版${neon.files.length ? `（${neon.files.join('、')}）` : ''}：`);
        if (neon.missing.length) {
            fail += 1;
            console.log('   ✖ Neon 版 schema 缺少這些欄位（Neon 線上會直接 500）：');
            show(neon.missing, '缺');
        } else {
            console.log('   ✔ Neon 版 schema 也涵蓋程式要用的欄位');
        }
    } catch (error) {
        console.log(`   ⚠  沒有 migrations/neon/ 可檢查（${error.message}）`);
    }

    if (OFFLINE) {
        console.log(`\n===== schema 檢查（只看遷移檔）：${fail ? '失敗' : '通過'} =====`);
        process.exitCode = fail ? 1 : 0;
        return;
    }

    console.log('② 線上實際 schema vs 程式要用的欄位');
    const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
        console.log('   ⚠  .env 沒有 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，跳過（要只用本機就加 --offline）');
        process.exitCode = fail ? 1 : 0;
        return;
    }
    /* v0.10.0：Supabase 有 OpenAPI 規格（`/rest/v1/` ＋ Accept: application/openapi+json）；
     * Neon 的 Data API 沒有（回 404）→ 退回「實際查欄位」的探測法（見 lib/schema.js 的 probeLiveColumns）。 */
    let spec = null;
    let source = 'openapi';
    const openapi = await fetch(`${url}/rest/v1/`, {
        headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/openapi+json' }
    }).catch(() => null);
    if (openapi && openapi.ok) {
        const parsed = await openapi.json().catch(() => null);
        if (parsed && parsed.definitions && Object.keys(parsed.definitions).length) spec = parsed;
    }
    if (!spec) {
        source = 'probe';
        spec = { definitions: await probeLiveColumns({ url, key }) };
        console.log('   （這個後端沒有 OpenAPI 規格 → 改用探測法：逐表查程式要用的欄位）');
    }
    const live = compareWithLive(spec.definitions || {});
    if (live.missing.length) {
        fail += 1;
        console.log('   ✖ 線上 schema 缺少這些欄位（把 migrations/ 的新遷移檔套用到線上）：');
        show(live.missing, '缺');
    } else {
        console.log(`   ✔ 線上 ${Object.keys(EXPECTED_COLUMNS).length} 張表的欄位都齊（${Object.keys(spec.definitions || {}).filter((t) => t.startsWith('dict_')).length} 張 dict_ 表）`);
    }

    /* ③ v0.7.0（D-1c／D-6）：資料庫函式有沒有建立。
     * 為什麼要檢查：這兩個函式是 v0.7.0 新加的，而且**只能由使用者自己在 Supabase SQL Editor 執行**
     * （我們的 service role 金鑰只能讀寫資料，不能改 schema）。沒建立時 PostgREST 回 404 PGRST202，
     * 症狀是「生字數整條失敗」與「容量百分比變成不知道」—— 要在這裡一眼看出來。 */
    console.log('③ 線上資料庫函式（v0.7.0 新增）');
    for (const fn of ['dict_entry_counts', 'dict_db_size']) {
        const payload = fn === 'dict_entry_counts' ? '{"unit_ids": null}' : '{}';
        const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
            method: 'POST',
            headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: payload
        });
        const text = (await res.text()).slice(0, 140);
        if (res.ok) {
            console.log(`   ✔ ${fn}() 存在`);
        } else if (res.status === 404 || /PGRST202/.test(text)) {
            fail += 1;
            console.log(`   ✖ ${fn}() 不存在（PGRST202）→ 請到 Supabase SQL Editor 執行 v0.7.0 的建立語句（見 docs/規劃書-待完成.md 的 Roadmap）`);
        } else {
            fail += 1;
            console.log(`   ✖ ${fn}() 呼叫失敗：HTTP ${res.status}${text ? `：${text}` : ''}`);
        }
    }

    console.log(`\n===== schema 檢查：${fail ? '失敗' : '通過'} =====`);
    process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
    console.error('✖ 檢查中斷：', err.message);
    process.exitCode = 1;
});
