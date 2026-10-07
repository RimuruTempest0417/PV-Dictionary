#!/usr/bin/env node
/* Supabase 連線／寫入／讀回 的實機烟霧測試（用自己的專案，跑完會清掉自己建的資料）
 *
 * 用法：
 *   node scripts/supabase-smoke.js            # 只讀：檢查連線、schema、各表筆數
 *   node scripts/supabase-smoke.js --write    # 額外測：寫入 → 新連線讀回 → 刪除 → 確認乾淨
 *
 * 憑證：從 .env 讀 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，**不印出內容**。
 * 安全性：會先確認 anon（publishable）金鑰讀不到資料（RLS 有開且沒有 policy）。
 */
require('dotenv').config();

const path = require('path');
const { createSupabaseStore } = require('../lib/store/supabase');
const { hashPassword, verifyPassword } = require('../lib/passwords');

const WRITE = process.argv.includes('--write');
const SMOKE_CODE = '__SMOKE__';

function fail(message) {
    console.error(`✖ ${message}`);
    process.exitCode = 1;
}

async function main() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
        fail('缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY（請放在 .env）');
        return;
    }
    console.log(`專案：${url}`);
    console.log(`service_role 金鑰：已設定（長度 ${key.length}，不印出）`);

    const store = createSupabaseStore({});
    await store.hydrate();
    const counts = store.tableCounts();
    console.log('讀取（hydrate）成功，目前筆數：', JSON.stringify(counts));

    /* RLS 檢查：anon 金鑰不應該讀到任何東西 */
    const publishable = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (publishable) {
        const res = await fetch(`${url}/rest/v1/dict_users?select=username`, {
            headers: { apikey: publishable, Authorization: `Bearer ${publishable}` }
        });
        console.log(`anon 金鑰讀 dict_users → HTTP ${res.status}（401/403 或空陣列才算正確）`);
        const body = await res.text();
        const leaked = /username/.test(body) && !/\[\]/.test(body);
        if (leaked) fail('anon 金鑰居然讀得到使用者資料：RLS 沒生效！');
        else console.log('✔ anon 讀不到使用者資料（RLS 有開且沒有 policy）');
    } else {
        console.log('（沒有 SUPABASE_PUBLISHABLE_KEY，跳過 anon 檢查）');
    }

    if (!WRITE) {
        console.log('\n只做了讀取檢查。要測寫入請加 --write。');
        return;
    }

    console.log('\n--- 寫入測試（會建立 __SMOKE__ 書本／單元／生字／帳號，最後全部刪掉）---');
    const book = store.createBook({ code: SMOKE_CODE, name: '__SMOKE__ Book', grade: 'S9', sort_order: 999, is_published: true });
    const unit = store.createUnit({ book_id: book.id, unit_no: 99, title: '__SMOKE__ Unit', sort_order: 99, is_published: true });
    store.createEntry({
        unit_id: unit.id, headword: '__smoke__', headword_norm: '__smoke__',
        ipa_us: '/sməʊk/', part_of_speech: 'n.', zh_meaning: '烟霧測試', en_definition: 'a smoke test row',
        status: 'published', sort_order: 1, created_by: 'smoke'
    });
    const user = store.createUser({
        username: '__smoke__', display_name: '__SMOKE__', password_hash: hashPassword('smokepass123'),
        role: 'teacher', is_active: true
    });
    store.createGrant({ user_id: user.id, book_id: book.id, can_edit: true, can_publish: false, granted_by: 'smoke' });
    store.insertAuditLog({ user_id: 'smoke', display_name: 'SMOKE', role: 'web_manager', action: 'SMOKE_TEST', target_id: String(book.id), details: '煙霧測試' });
    await store.flush();
    console.log(`✔ 已寫入（book #${book.id}／unit #${unit.id}／user #${user.id}）`);

    /* 用「全新的連線」讀回：確定資料真的在資料庫，而不是只在記憶體 */
    const second = createSupabaseStore({});
    await second.hydrate();
    const readBook = second.listBooks({ includeUnpublished: true }).find((b) => b.code === SMOKE_CODE);
    const readUser = second.findUserByUsername('__smoke__');
    const readEntries = readBook ? second.listEntries({ unitId: second.listUnits({ bookId: readBook.id, includeUnpublished: true })[0].id }) : [];
    if (!readBook || readBook.id !== book.id) return fail('新連線讀不到剛寫入的書本（或 id 不一致）');
    console.log(`✔ 新連線讀回書本 #${readBook.id}（id 與寫入時一致）`);
    if (!readUser || !verifyPassword(readUser.password_hash, 'smokepass123')) return fail('新連線讀不到帳號，或密碼雜湊驗證失敗');
    console.log('✔ 新連線讀回帳號，密碼雜湊可以驗證通過');
    if (readEntries.length !== 1 || readEntries[0].zh_meaning !== '烟霧測試') return fail('生字沒有正確寫入');
    console.log('✔ 新連線讀回生字（含中文解釋）');
    if (second.listGrants({ userId: readUser.id }).length !== 1) return fail('授權沒有寫入');
    console.log('✔ 新連線讀回授權');
    if (!second.listAuditLogs({ limit: 5 }).items.some((row) => row.action === 'SMOKE_TEST')) return fail('稽核沒有寫入');
    console.log('✔ 新連線讀回稽核紀錄');

    console.log('\n--- 清理 ---');
    /* 資料層介面沒有 deleteBook / deleteUnit（正式程式不需要），所以那兩張表直接用 REST 刪 */
    const rest = async (path, method = 'DELETE') => {
        const res = await fetch(`${url}/rest/v1/${path}`, {
            method,
            headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'return=minimal' }
        });
        if (!res.ok && res.status !== 404) throw new Error(`${method} ${path} → HTTP ${res.status}`);
    };
    const units = second.listUnits({ bookId: readBook.id, includeUnpublished: true });
    for (const grant of second.listGrants({ userId: readUser.id })) second.deleteGrant(grant.id);
    second.deleteEntry(readEntries[0].id);      // 會連音檔一起刪
    second.deleteUser(readUser.id);
    await second.flush();                       // 把 grant / entry / user 的刪除寫回去
    for (const row of units) await rest(`dict_units?id=eq.${row.id}`);
    await rest(`dict_books?id=eq.${readBook.id}`);
    await rest('dict_audit_logs?action=eq.SMOKE_TEST');

    const third = createSupabaseStore({});
    await third.hydrate();
    const leftovers = {
        books: third.listBooks({ includeUnpublished: true }).filter((b) => b.code === SMOKE_CODE).length,
        users: third.listUsers().filter((u) => u.username === '__smoke__').length,
        audit: third.listAuditLogs({ limit: 50 }).items.filter((row) => row.action === 'SMOKE_TEST').length
    };
    console.log('清理後殘留：', JSON.stringify(leftovers), '（全部要是 0）');
    if (leftovers.books || leftovers.users || leftovers.audit) fail('測試資料沒有清乾淨');
    else console.log('✔ 測試資料已全部清除，資料庫回到測試前的狀態');
}

main().catch((err) => {
    console.error('✖ 烟霧測試失敗：', err.message);
    process.exitCode = 1;
});
