#!/usr/bin/env node
/* 線上健康檢查（D-4）
 *
 * 用途：讓「網站掛掉」這件事在別人發現之前先通知你。
 *   - 手動：`npm run uptime`（或 node scripts/uptime-check.js）
 *   - 排程：放進 Hermes 的 cron 或任何排程器，失敗時 exit code 1（監控服務據此發警報）
 *   - 免費外部監控：把服務指向 https://gary-dictionary-mylearning.vercel.app/api/health
 *     （見 docs/監控與錯誤追查.md 的設定步驟），它會每 5 分鐘打一次
 *
 * 檢查項目（全部都要通過才算健康）：
 *   1. GET /api/version       → 200 且 version 與 package.json 相同（部署有沒有真的生效）
 *   2. GET /api/health        → 200 且 schema_ready=true、db.ok（不是只有網站活著、資料庫死掉）
 *   3. GET /api/books         → 200 且回傳 JSON（公開讀取真的能走完資料層）
 *   4. GET /                 → 200 且 HTML 帶著標題（首頁不是白畫面）
 */
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const PACKAGE = require('../package.json');

const arg = (name, fallback) => {
    const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const SITE = String(arg('site', process.env.SITE_URL || 'https://gary-dictionary-mylearning.vercel.app')).replace(/\/+$/, '');
const AS_JSON = process.argv.includes('--json');
const TIMEOUT_MS = Number(arg('timeout', 15000));

async function timed(url, options = {}) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, Object.assign({ signal: controller.signal }, options));
        const text = await res.text();
        return { status: res.status, ms: Date.now() - started, text, headers: res.headers };
    } finally {
        clearTimeout(timer);
    }
}

async function main() {
    const checks = [];
    const record = (name, ok, detail) => {
        checks.push({ name, ok, detail });
        if (!AS_JSON) console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? ` → ${detail}` : ''}`);
    };

    if (!AS_JSON) console.log(`檢查 ${SITE}（逾時 ${TIMEOUT_MS}ms）\n`);

    try {
        const version = await timed(`${SITE}/api/version`);
        let body = null;
        try { body = JSON.parse(version.text); } catch (err) { body = null; }
        record('版本端點', version.status === 200 && body && body.version === PACKAGE.version,
            `${version.status}｜${version.ms}ms｜${body ? body.version : version.text.slice(0, 40)}`);
    } catch (err) {
        record('版本端點', false, err.name === 'AbortError' ? '逾時' : err.message);
    }

    try {
        const health = await timed(`${SITE}/api/health`);
        let body = null;
        try { body = JSON.parse(health.text); } catch (err) { body = null; }
        const dbOk = body && body.db ? body.db.ok !== false : true;
        record('健康端點（含資料庫）', health.status === 200 && body && body.schema_ready === true && dbOk,
            `${health.status}｜${health.ms}ms｜schema_ready=${body ? body.schema_ready : '?'}｜db=${body && body.db ? (body.db.ok === false ? 'fail' : 'ok') : 'n/a'}`);
    } catch (err) {
        record('健康端點（含資料庫）', false, err.name === 'AbortError' ? '逾時' : err.message);
    }

    try {
        const books = await timed(`${SITE}/api/books`);
        let body = null;
        try { body = JSON.parse(books.text); } catch (err) { body = null; }
        record('公開讀取（書本清單）', books.status === 200 && body && Array.isArray(body.books),
            `${books.status}｜${books.ms}ms｜${body && body.books ? `${body.books.length} 本` : '非 JSON'}`);
    } catch (err) {
        record('公開讀取（書本清單）', false, err.name === 'AbortError' ? '逾時' : err.message);
    }

    try {
        const home = await timed(`${SITE}/`);
        record('首頁 HTML', home.status === 200 && /<title>Gary-Dictionary/.test(home.text), `${home.status}｜${home.ms}ms`);
    } catch (err) {
        record('首頁 HTML', false, err.name === 'AbortError' ? '逾時' : err.message);
    }

    const failed = checks.filter((check) => !check.ok);
    if (AS_JSON) {
        console.log(JSON.stringify({ site: SITE, checked_at: new Date().toISOString(), ok: failed.length === 0, checks }, null, 2));
    } else {
        console.log(failed.length ? `\n✖ ${failed.length} 項失敗（這就是要通知你的訊號）` : '\n✔ 全部正常');
    }
    process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
    console.error(`✖ ${err.message}`);
    process.exit(1);
});
