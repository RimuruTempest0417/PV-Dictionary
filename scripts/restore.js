#!/usr/bin/env node
/* A-2：從備份還原資料庫（破壞性操作，必須明確 --confirm）
 *
 * 用法：
 *   node scripts/restore.js --from=/tmp/pv-backup/backups/2026-10-10 --confirm
 *   node scripts/restore.js --from=<dir> --confirm --no-wipe   # 只補寫入，不清空
 *   node scripts/restore.js --from=<dir>                        # 只檢查（驗 sha256＋列筆數）
 *
 * 安全設計：
 *   - 沒有 --confirm 一律只做「檢查」並印出提示，不會寫任何資料。
 *   - 還原前先核對每個檔案與 manifest.json 的 sha256；對不上就中止。
 *   - 預設先清空目標（相反順序避開外鍵）再寫回；目標是哪個資料庫由 .env 的 SUPABASE_URL 決定，
 *     所以還原到 Neon 就是把 .env 指到 Neon（配合 scripts/neon-jwt.js 簽的 token）。
 *   - 還原後會重新數一次筆數，跟備份的 manifest 對比。
 */
const fs = require('node:fs');
const path = require('node:path');

const BACKUP = require('../lib/backup');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const arg = (name, fallback) => {
    const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const FROM = arg('from', '');
const CONFIRM = process.argv.includes('--confirm');
const NO_WIPE = process.argv.includes('--no-wipe');

async function countRows({ base, key, table }) {
    const res = await fetch(`${base}/rest/v1/${BACKUP.TABLE_PREFIX}${table}?select=id&limit=1`, {
        headers: BACKUP.headersFor(key, { Prefer: 'count=exact' })
    });
    const range = res.headers.get('content-range') || '';
    const total = Number(String(range).split('/')[1]);
    return Number.isFinite(total) ? total : null;
}

async function main() {
    if (!FROM) {
        console.error('用法：node scripts/restore.js --from=<備份資料夾> [--confirm] [--no-wipe]');
        process.exit(1);
    }
    const dir = path.resolve(FROM);
    const { manifest, rows, problems } = BACKUP.readBackup(dir);
    console.log(`備份：${manifest.created_at}（來源 ${manifest.source_host}，app ${manifest.app_version}）`);
    console.log(`筆數：${JSON.stringify(manifest.tables)}｜總計 ${manifest.total_rows}`);
    if (problems.length) {
        console.error(`✖ 備份檔有問題，中止：\n  - ${problems.join('\n  - ')}`);
        process.exit(1);
    }
    console.log('✔ 每個檔案都與 manifest.json 的 sha256 相符');

    if (!CONFIRM) {
        console.log('\n（這是檢查模式：沒有寫任何資料。）');
        console.log('要真的還原，請加上 --confirm，且確認 .env 的 SUPABASE_URL 指向**正確的目標**：');
        console.log(`  目前 .env 指向：${BACKUP.safeHost(process.env.SUPABASE_URL)}`);
        console.log(`  node scripts/restore.js --from=${FROM} --confirm`);
        return;
    }

    const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!base || !key) {
        console.error('✖ 缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY（看 .env）');
        process.exit(1);
    }
    console.log(`\n→ 還原到 ${BACKUP.safeHost(base)}${NO_WIPE ? '（不清空，只補寫入）' : '（先清空目標）'}`);
    const written = await BACKUP.restoreAll({
        base, key, rows, wipe: !NO_WIPE,
        log: (line) => console.log(line)
    });

    console.log('\n→ 核對筆數');
    let bad = 0;
    for (const table of BACKUP.TABLES) {
        const want = manifest.tables[table] ?? 0;
        const got = await countRows({ base, key, table });
        const ok = got === want;
        if (!ok) bad += 1;
        console.log(`  ${ok ? '✔' : '✖'} ${table}：備份 ${want}／還原後 ${got}`);
    }
    console.log(bad ? `\n✖ 有 ${bad} 張表筆數不符，請人工檢查` : '\n✔ 全部吻合');
    if (bad) process.exit(1);
    console.log('建議接著跑：npm run check:schema:live 與 node scripts/live-verify.js --no-auth --ephemeral-teacher');
}

main().catch((error) => {
    console.error(`✖ 還原失敗：${error.message}`);
    process.exit(1);
});
