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
const { EXPECTED_COLUMNS, compareWithMigrations, compareWithLive } = require('../lib/schema');

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

    if (OFFLINE) {
        console.log(`\n===== schema 檢查（只看遷移檔）：${fail ? '失敗' : '通過'} =====`);
        process.exitCode = fail ? 1 : 0;
        return;
    }

    console.log('② 線上 Supabase 實際 schema vs 程式要用的欄位');
    const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
        console.log('   ⚠  .env 沒有 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，跳過（要只用本機就加 --offline）');
        process.exitCode = fail ? 1 : 0;
        return;
    }
    const res = await fetch(`${url}/rest/v1/`, {
        headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/openapi+json' }
    });
    if (!res.ok) {
        console.log(`   ✖ 讀不到線上 schema：HTTP ${res.status}`);
        process.exitCode = 1;
        return;
    }
    const spec = await res.json();
    const live = compareWithLive(spec.definitions || {});
    if (live.missing.length) {
        fail += 1;
        console.log('   ✖ 線上 schema 缺少這些欄位（把 migrations/ 的新遷移檔套用到線上）：');
        show(live.missing, '缺');
    } else {
        console.log(`   ✔ 線上 ${Object.keys(EXPECTED_COLUMNS).length} 張表的欄位都齊（${Object.keys(spec.definitions || {}).filter((t) => t.startsWith('dict_')).length} 張 dict_ 表）`);
    }

    console.log(`\n===== schema 檢查：${fail ? '失敗' : '通過'} =====`);
    process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
    console.error('✖ 檢查中斷：', err.message);
    process.exitCode = 1;
});
