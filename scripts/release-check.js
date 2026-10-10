#!/usr/bin/env node
/* 發版前檢查（使用者 2026-10-10 指定：「每次更新時都要檢查有沒有錯誤記錄需要處理」）
 *
 * 這支把「發版前該做的事」串成一個指令，省掉靠記憶：
 *   1. 語法 → 單元測試 → schema（本機，不用網路）
 *   2. **錯誤記錄檢查**（使用者特別指定）：讀線上資料庫的 dict_error_logs，
 *      把「還沒標記處理」的錯誤分組列出來；**最近 24 小時內**出現的未處理錯誤會讓這裡失敗
 *      （例外：使用者端造成的 ASSET_LOAD／CSP_VIOLATION，那不是我方能修的，只提醒）。
 *   3. 線上驗收：`uptime`、`live-verify`（真的寫入→讀回→清掉）、訪客視角瀏覽器檢查。
 *
 * 用法：
 *   npm run release:check              # 全部跑（發版前）
 *   npm run release:check -- --fast     # 只跑本機 + 錯誤記錄（不跑線上瀏覽器）
 *   npm run release:check -- --errors   # 只看錯誤記錄
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const LIMITS = require(path.join(ROOT, 'lib', 'limits'));

const ONLY_ERRORS = process.argv.includes('--errors');
const FAST = process.argv.includes('--fast');
const NEW_WINDOW_MS = 24 * 60 * 60 * 1000;
/* 使用者端（瀏覽器擴充功能、網路）造成的，不是我們的程式碼要修的 → 只提醒不擋 */
const CLIENT_SIDE_CODES = ['ASSET_LOAD', 'CSP_VIOLATION'];

const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';

let failures = 0;

function run(label, args, options = {}) {
    process.stdout.write(`\n=== ${label} ===\n`);
    try {
        const out = execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        const tail = out.trim().split('\n').slice(-4).join('\n');
        if (tail) console.log(tail);
        return out;
    } catch (error) {
        const out = `${error.stdout || ''}${error.stderr || ''}`.trim();
        console.log(out.split('\n').slice(-12).join('\n'));
        if (!options.optional) failures += 1;
        console.log(`✖ ${label} 失敗（exit ${error.status}）`);
        return out;
    }
}

function runNpm(label, args, options = {}) {
    process.stdout.write(`\n=== ${label} ===\n`);
    try {
        const out = execFileSync('npm', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        console.log(out.trim().split('\n').slice(-5).join('\n'));
        return out;
    } catch (error) {
        const out = `${error.stdout || ''}${error.stderr || ''}`.trim();
        console.log(out.split('\n').slice(-14).join('\n'));
        if (!options.optional) failures += 1;
        console.log(`✖ ${label} 失敗（exit ${error.status}）`);
        return out;
    }
}

/* 錯誤記錄：直接讀資料庫（唯讀），不經過應用程式 */
async function checkErrorLogs() {
    process.stdout.write('\n=== 錯誤記錄檢查（未處理的要不要先處理？）===\n');
    if (!base || !key) {
        console.log('  （沒有 SUPABASE_URL／金鑰 → 跳過）');
        return;
    }
    const url = `${base}/rest/v1/dict_error_logs?select=id,created_at,code,level,path,message,resolved,is_self_test&resolved=eq.false&order=id.desc&limit=200`;
    let rows = [];
    try {
        const res = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' } });
        const text = await res.text();
        if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 120)}`);
        rows = JSON.parse(text);
    } catch (error) {
        failures += 1;
        console.log(`  ✖ 讀不到錯誤記錄：${error.message}`);
        return;
    }

    const human = rows.filter((row) => row.is_self_test !== true);
    if (!human.length) {
        console.log('  ✔ 沒有未處理的錯誤紀錄');
        return;
    }

    const groups = new Map();
    for (const row of human) {
        const key = `${row.code || '(no code)'} → ${row.path || '/'}`;
        const item = groups.get(key) || { n: 0, newest: row.created_at, sample: (row.message || '').slice(0, 100), newestId: row.id };
        item.n += 1;
        if (String(row.created_at) > String(item.newest)) {
            item.newest = row.created_at;
            item.sample = (row.message || '').slice(0, 100);
            item.newestId = row.id;
        }
        groups.set(key, item);
    }
    /* 新的排前面 */
    const sorted = [...groups.entries()].sort((a, b) => String(b[1].newest).localeCompare(String(a[1].newest)));
    console.log(`  未處理 ${human.length} 筆，分成 ${sorted.length} 組（新的排前面）：`);
    for (const [name, item] of sorted) {
        const fresh = Date.now() - new Date(item.newest).getTime() < NEW_WINDOW_MS;
        const clientSide = CLIENT_SIDE_CODES.some((code) => name.startsWith(code));
        const mark = fresh ? (clientSide ? '⚠ 24 小時內（使用者端，只提醒）' : '✖ 24 小時內（要先處理）') : '　';
        console.log(`   ${mark} ${name}｜${item.n} 筆｜最新 ${String(item.newest).slice(0, 19)}｜${item.sample}`);
        if (fresh && !clientSide) failures += 1;
    }
    if (sorted.some(([, item]) => Date.now() - new Date(item.newest).getTime() < NEW_WINDOW_MS)) {
        console.log('\n  → 怎麼處理：開後台「🐞 錯誤紀錄」看細節（或 `npm run triage` 分組），');
        console.log('    修好之後把那幾筆標成「已處理」，再跑一次這支。');
    }
}

async function main() {
    console.log('Gary-Dictionary 發版前檢查'
        + (ONLY_ERRORS ? '（只看錯誤記錄）' : FAST ? '（本機 + 錯誤記錄）' : '（全部）'));

    if (!ONLY_ERRORS) {
        run('語法檢查', [path.join(ROOT, 'scripts', 'check-syntax.js')]);
        run('schema 檢查（本機）', [path.join(ROOT, 'scripts', 'schema-check.js'), '--offline']);
        runNpm('單元測試（npm test）', ['test']);
    }

    await checkErrorLogs();

    if (!ONLY_ERRORS && !FAST) {
        run('線上健康檢查（npm run uptime）', [path.join(ROOT, 'scripts', 'uptime-check.js')]);
        run('線上端到端（live-verify）', [path.join(ROOT, 'scripts', 'live-verify.js'), '--ephemeral-teacher']);
        run('正式站訪客視角（真瀏覽器）', [path.join(ROOT, 'tests', 'browser', 'live-check.js')]);
    }

    console.log(failures
        ? `\n✖ 發版前檢查有 ${failures} 項要處理（先解決再發版）`
        : '\n✔ 發版前檢查全部通過（別忘了發版後獨立讀回版本與 Release）');
    process.exit(failures ? 1 : 0);
}

main().catch((error) => {
    console.error(`✖ 發版前檢查失敗：${error.message}`);
    process.exit(1);
});
