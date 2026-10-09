#!/usr/bin/env node
/* 清掉線上殘留的「驗收測試資料」（live-verify 跑失敗時留下的）。
 *
 * 為什麼要這支：驗收腳本會建立測試用的年級／單元／生字；正常情況它自己會刪掉，
 * 但如果中途失敗（或舊版本的腳本用的是固定代號）就會留下來，**混在使用者的真教材裡**。
 *
 * 安全規則：
 *   - 只刪「代號／年級」符合測試特徵的資料（預設 ZZ / __live_verify__ / V+數字 / Live Verify），
 *   - 一律先列出要刪什麼（--dry-run 是預設），要真的刪得加 --yes，
 *   - 絕不碰其他書本／單元／生字。
 *
 * 用法：
 *   node scripts/cleanup-test-data.js            # 只列出（dry-run）
 *   node scripts/cleanup-test-data.js --yes      # 真的刪
 */
require('dotenv').config();

const URL_BASE = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const YES = process.argv.includes('--yes');

if (!URL_BASE || !KEY) {
    console.error('✖ 需要 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY（.env）');
    process.exit(1);
}

async function rest(path, options = {}) {
    const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
        method: options.method || 'GET',
        headers: {
            apikey: KEY,
            Authorization: `Bearer ${KEY}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(options.prefer ? { Prefer: options.prefer } : {})
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${options.method || 'GET'} ${path} → HTTP ${res.status}：${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
}

/* 測試資料的特徵：代號或年級 */
function looksLikeTest(book) {
    const code = String(book.code || '');
    const grade = String(book.grade || '');
    const name = String(book.name || '');
    return /^(__live_verify__|ZZ|V\d+)$/i.test(code)
        || /^(ZZ|V\d+|__live_verify__)$/i.test(grade)
        || /Live Verify/i.test(name);
}

(async () => {
    const books = await rest('dict_books?select=id,code,name,grade&order=id.asc');
    const suspects = books.filter(looksLikeTest);
    console.log(`共 ${books.length} 本年級；其中看起來是測試資料的 ${suspects.length} 筆：`);
    for (const book of books) {
        console.log(`  ${suspects.includes(book) ? '✖ 要刪' : '✔ 保留'}｜id=${book.id}｜grade=${book.grade}｜code=${book.code}`);
    }
    if (!suspects.length) {
        console.log('（沒有測試資料要清）');
        return;
    }
    if (!YES) {
        console.log('\n（dry-run：加上 --yes 才會真的刪除）');
        return;
    }
    for (const book of suspects) {
        const units = await rest(`dict_units?select=id&book_id=eq.${book.id}`);
        for (const unit of units) {
            const entries = await rest(`dict_entries?select=id&unit_id=eq.${unit.id}`);
            for (const entry of entries) {
                await rest(`dict_audio?entry_id=eq.${entry.id}`, { method: 'DELETE', prefer: 'return=minimal' });
            }
            await rest(`dict_entries?unit_id=eq.${unit.id}`, { method: 'DELETE', prefer: 'return=minimal' });
        }
        await rest(`dict_units?book_id=eq.${book.id}`, { method: 'DELETE', prefer: 'return=minimal' });
        await rest(`dict_books?id=eq.${book.id}`, { method: 'DELETE', prefer: 'return=minimal' });
        console.log(`已刪除測試年級 id=${book.id}（grade=${book.grade}，含 ${units.length} 個單元）`);
    }
    const after = await rest('dict_books?select=id,grade&order=id.asc');
    console.log('清理後剩下：', after.map((book) => `${book.id}:${book.grade}`).join('、'));
})();
