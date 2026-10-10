#!/usr/bin/env node
/* 容量與併發驗證（正式站 ＋ Neon）
 *
 * 目的：回答「資料長大以後還行不行」——目前正式站只有 1 本書／1 單元／1 生字，
 * 這個腳本會灌進大量生字（預設 10,000 個），量測讀取延遲、回應大小、併發吞吐，
 * 跑完**一定**把自己建立的資料刪掉並核對筆數回到開始前。
 *
 * 用法：
 *   node scripts/load-test.js                                  # 10,000 生字、24 併發、15 秒
 *   node scripts/load-test.js --entries=3000 --concurrency=20 --duration=10
 *   node scripts/load-test.js --base=http://127.0.0.1:3000     # 量本機 server
 *   node scripts/load-test.js --keep                           # 保留測試資料（自己要記得清）
 *
 * 安全規則：
 *   ① 只碰自己建立的年級（`code = __loadtest__`）與它的單元／生字；不動其他資料。
 *   ② 結束（含中途失敗）一定執行清理，並核對 books／units／entries 筆數回到開始前。
 *   ③ id 由我們自己算（max+1 起算，跟伺服器端 store 的做法一致），避免與 identity 序列衝到。
 *   ④ 只讀取正式站的公開端點（GET），寫入一律走直連 REST。
 */
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const arg = (name, fallback) => {
    const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const ENTRIES = Number(arg('entries', 10000));
const CONCURRENCY = Number(arg('concurrency', 24));
const DURATION_S = Number(arg('duration', 15));
const BASE = String(arg('base', 'https://gary-dictionary.vercel.app')).replace(/\/+$/, '');
const KEEP = process.argv.includes('--keep');

const DB = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_CODE = '__loadtest__';
const BATCH = 500;

function headers(extra = {}) {
    return Object.assign({ apikey: KEY, Authorization: `Bearer ${KEY}` }, extra);
}

async function db(pathname, options = {}) {
    const opts = Object.assign({}, options, { headers: headers(options.headers || {}) });
    const res = await fetch(`${DB}/rest/v1/${pathname}`, opts);
    const text = await res.text();
    if (!res.ok) throw new Error(`${opts.method || 'GET'} ${pathname} → HTTP ${res.status}：${text.slice(0, 160)}`);
    return text ? JSON.parse(text) : null;
}

async function counts() {
    const out = {};
    for (const table of ['books', 'units', 'entries', 'audio', 'audit_logs']) {
        const res = await fetch(`${DB}/rest/v1/dict_${table}?select=id&limit=1`, { headers: headers({ Prefer: 'count=exact' }) });
        out[table] = Number(String(res.headers.get('content-range') || '').split('/')[1]) || 0;
    }
    return out;
}

const maxIdOf = async (table) => {
    const rows = await db(`dict_${table}?select=id&order=id.desc&limit=1`);
    return rows.length ? Number(rows[0].id) : 0;
};

const dbSize = async () => {
    try {
        const res = await fetch(`${DB}/rest/v1/rpc/dict_db_size`, { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: '{}' });
        return res.ok ? Number(await res.text()) : null;
    } catch (error) { return null; }
};

/* 輸出被關掉時（管線斷了、背景程序被回收）不要讓行程「寫不出東西就暴斃」——
 * 上次就是這樣：行程被中斷 → finally 還沒跑到 → 測試資料留在正式資料庫裡。
 * 這裡做三層保護：① EPIPE 忽略 ② 收到訊號／未預期例外時先清再退 ③ --cleanup-only 手動補清。 */
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

async function emergencyCleanup(why) {
    try {
        const rows = await db(`dict_books?code=eq.${TEST_CODE}&select=id`);
        for (const row of rows) {
            await db(`dict_books?id=eq.${row.id}`, { method: 'DELETE', headers: headers() });
        }
        const after = await counts();
        console.log(`（${why}）清理測試年級 ${rows.map((row) => row.id).join(', ') || '（沒有）'} → 筆數 ${JSON.stringify(after)}`);
    } catch (error) {
        console.error(`✖ 緊急清理失敗：${error.message}（請手動跑 node scripts/load-test.js --cleanup-only）`);
    }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, async () => { await emergencyCleanup(`收到 ${signal}`); process.exit(130); });
}
process.on('uncaughtException', async (error) => { await emergencyCleanup(`未預期例外：${error.message}`); process.exit(1); });
process.on('unhandledRejection', async (reason) => { await emergencyCleanup(`未處理的 Promise 拒絕：${reason}`); process.exit(1); });

async function readOnce(url) {
    const started = process.hrtime.bigint();
    const res = await fetch(url);
    const text = await res.text();
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    return { ms, status: res.status, bytes: Buffer.byteLength(text) };
}

async function medianOf(url, runs = 3) {
    const samples = [];
    let bytes = 0;
    let status = 0;
    for (let i = 0; i < runs; i += 1) {
        const one = await readOnce(url);
        samples.push(one.ms);
        bytes = one.bytes;
        status = one.status;
    }
    samples.sort((a, b) => a - b);
    return { ms: samples[Math.floor(samples.length / 2)], bytes, status };
}

const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;

async function main() {
    if (!DB || !KEY) {
        console.error('✖ 缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY（看 .env）');
        process.exit(1);
    }
    /* 只清理模式：上次被中斷而留下的測試資料，用這行補清 */
    if (process.argv.includes('--cleanup-only')) {
        const before = await counts();
        console.log(`清理前筆數 ${JSON.stringify(before)}`);
        await emergencyCleanup('--cleanup-only');
        return;
    }
    const baseline = await counts();
    const sizeBefore = await dbSize();
    console.log(`目標站台：${BASE}`);
    console.log(`資料庫：${new URL(DB).host}｜開始前筆數 ${JSON.stringify(baseline)}｜大小 ${sizeBefore} bytes`);
    console.log(`計畫：灌 ${ENTRIES} 個生字（每批 ${BATCH}）、${CONCURRENCY} 併發、讀取量測 ${DURATION_S} 秒\n`);

    let bookId = null;
    let unitId = null;
    try {
        /* ① 建立測試年級與單元（沿用既有的話就重用） */
        const existing = await db(`dict_books?code=eq.${TEST_CODE}&select=id,grade`);
        if (existing.length) {
            bookId = Number(existing[0].id);
            const units = await db(`dict_units?book_id=eq.${bookId}&select=id&order=id.asc&limit=1`);
            unitId = units.length ? Number(units[0].id) : null;
            console.log(`（沿用既有的測試年級 id=${bookId}、單元 id=${unitId}）`);
        } else {
            const maxBook = await maxIdOf('books');
            const maxUnit = await maxIdOf('units');
            bookId = maxBook + 1;
            unitId = maxUnit + 1;
            await db('dict_books', {
                method: 'POST',
                headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
                body: JSON.stringify({ id: bookId, code: TEST_CODE, name: TEST_CODE, grade: 'ZZ', sort_order: 9999, is_published: true })
            });
            await db('dict_units', {
                method: 'POST',
                headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
                body: JSON.stringify({ id: unitId, book_id: bookId, unit_no: 1, title: TEST_CODE, sort_order: 1, is_published: true })
            });
            console.log(`建立測試年級 id=${bookId}、單元 id=${unitId}`);
        }

        /* ② 灌生字（分批，用我們自己算的 id，跟 store 的做法一致） */
        const maxEntry = await maxIdOf('entries');
        const started = process.hrtime.bigint();
        for (let offset = 0; offset < ENTRIES; offset += BATCH) {
            const rows = [];
            for (let i = offset; i < Math.min(offset + BATCH, ENTRIES); i += 1) {
                const headword = `loadtest-${String(i + 1).padStart(6, '0')}`;
                rows.push({
                    id: maxEntry + i + 1,
                    unit_id: unitId,
                    headword,
                    headword_norm: headword,
                    ipa_us: '', ipa_uk: '', part_of_speech: 'n.',
                    zh_meaning: `負載測試 ${i + 1}`, en_definition: 'load test row',
                    example_en: '', example_zh: '',
                    status: 'published', sort_order: i + 1
                });
            }
            await db('dict_entries', {
                method: 'POST',
                headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
                body: JSON.stringify(rows)
            });
            if ((offset / BATCH) % 4 === 0) process.stdout.write(`  寫入 ${Math.min(offset + BATCH, ENTRIES)}/${ENTRIES}\r`);
        }
        const writeSec = Number(process.hrtime.bigint() - started) / 1e9;
        const sizeAfter = await dbSize();
        console.log(`\n灌資料完成：${ENTRIES} 筆／${writeSec.toFixed(1)} 秒（${Math.round(ENTRIES / writeSec)} 筆/秒）`);
        console.log(`資料庫大小 ${sizeBefore} → ${sizeAfter} bytes（增加 ${sizeAfter - sizeBefore} bytes）\n`);

        /* ③ 單次讀取（伺服器端分頁／搜尋） */
        const pages = Math.ceil(ENTRIES / 60);
        const targets = [
            ['書架 /api/books', `${BASE}/api/books`],
            ['單元第 1 頁', `${BASE}/api/units/${unitId}?page=1`],
            ['單元最後一頁', `${BASE}/api/units/${unitId}?page=${pages}`],
            ['搜尋（命中 1 筆）', `${BASE}/api/units/${unitId}?q=loadtest-${String(Math.floor(ENTRIES / 2)).padStart(6, '0')}`],
            ['搜尋（無命中）', `${BASE}/api/units/${unitId}?q=zzzznomatch`],
            ['/api/health', `${BASE}/api/health`]
        ];
        console.log('讀取延遲（各量 3 次取中位數）');
        const singles = {};
        for (const [label, url] of targets) {
            const one = await medianOf(url);
            singles[label] = one;
            console.log(`  ${label.padEnd(18)} ${one.status}｜${one.ms.toFixed(0)} ms｜${(one.bytes / 1024).toFixed(1)} KB`);
        }

        /* ④ 併發：連續打三種讀取，統計成功率與百分位 */
        const urls = targets.slice(0, 3).concat([targets[3]]).map((pair) => pair[1]);
        const latencies = [];
        const statuses = {};
        const stopAt = Date.now() + DURATION_S * 1000;
        let requests = 0;
        console.log(`\n併發 ${CONCURRENCY} 條連線打 ${DURATION_S} 秒…`);
        await Promise.all(Array.from({ length: CONCURRENCY }, async (unused, worker) => {
            let index = worker;
            while (Date.now() < stopAt) {
                const one = await readOnce(urls[index % urls.length]);
                index += 1;
                requests += 1;
                latencies.push(one.ms);
                statuses[one.status] = (statuses[one.status] || 0) + 1;
            }
        }));
        latencies.sort((a, b) => a - b);
        const errors = Object.entries(statuses).filter(([code]) => Number(code) >= 400).reduce((sum, [, n]) => sum + n, 0);
        console.log(`  總請求 ${requests}｜錯誤 ${errors}｜狀態 ${JSON.stringify(statuses)}`);
        console.log(`  延遲 p50 ${pct(latencies, 50).toFixed(0)} ms｜p95 ${pct(latencies, 95).toFixed(0)} ms｜p99 ${pct(latencies, 99).toFixed(0)} ms｜最大 ${latencies[latencies.length - 1].toFixed(0)} ms`);
        console.log(`  吞吐 ${(requests / DURATION_S).toFixed(1)} req/s`);

        console.log(`\n摘要：${JSON.stringify({ entries: ENTRIES, concurrency: CONCURRENCY, duration_s: DURATION_S, write_sec: Number(writeSec.toFixed(1)), singles, concurrency_stats: { requests, errors, rps: Number((requests / DURATION_S).toFixed(1)), p50: Math.round(pct(latencies, 50)), p95: Math.round(pct(latencies, 95)), p99: Math.round(pct(latencies, 99)) }, db_size_delta: sizeAfter - sizeBefore })}`);
    } finally {
        /* ⑤ 清理：刪掉測試年級（外鍵 cascade 會帶走單元與生字），並核對筆數 */
        if (KEEP) {
            console.log('\n（--keep：保留測試資料，沒有清理）');
        } else if (bookId) {
            await db(`dict_books?id=eq.${bookId}`, { method: 'DELETE', headers: headers() });
            const after = await counts();
            const same = Object.keys(baseline).every((table) => after[table] === baseline[table]);
            console.log(`\n清理：刪除測試年級 id=${bookId} → 筆數 ${JSON.stringify(after)}｜${same ? '✔ 與開始前一致' : '✖ 與開始前不一致，請檢查'}`);
        }
    }
}

main().catch((error) => {
    console.error(`✖ 壓測失敗：${error.message}`);
    process.exit(1);
});
