#!/usr/bin/env node
/* A-2：把資料庫備份到**私有** GitHub repo（gary-dictionary-backup）
 *
 * 用法：
 *   npm run backup                 # 匯出 → commit → push（保留最近 30 份）
 *   npm run backup -- --dry-run    # 只匯出到暫存資料夾，不 push（看內容用）
 *   npm run backup -- --keep=14    # 只保留最近 14 份
 *
 * 設計重點：
 *   - **不留下檔案在使用者的電腦上**：全程在系統暫存資料夾做，跑完（含失敗）一定刪掉；
 *     不會有任何東西跑到 ~/Downloads 或專案裡。
 *   - **不碰正式站**：只讀（GET／RPC），不會刪或改任何資料。
 *   - 憑證：git 走 macOS keychain 的憑證（跟專案 push 同一組），程式不接觸 token。
 *   - 備份內含帳號密碼雜湊與 2FA 密鑰 → 只能進私有 repo。
 */
const { execFileSync } = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BACKUP = require('../lib/backup');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const OWNER = 'RimuruTempest0417';
const REPO = 'gary-dictionary-backup';
const arg = (name, fallback) => {
    const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const DRY = process.argv.includes('--dry-run');
const KEEP = Number(arg('keep', 30));
const APP_VERSION = require(path.join(ROOT, 'package.json')).version;

/* 逐字記錄到**專案內**的 logs/backup.log（使用者 2026-10-10 指定）。
 * ★ 為什麼不是讓 launchd 直接寫：launchd 在 ~/Documents 開檔會被 macOS TCC 擋掉，
 *   整個 job 連啟動都失敗（實測 last exit code = 78: EX_CONFIG、job state = spawn failed）；
 *   只有拿到「完全取硬碟存取權」的 node 寫得進去 → 所以由這裡自己寫。
 *   plist 的 StandardOutPath 就只是技術後備（放在 ~/Library/Logs），正常情況用不到。
 * logs/*.log 已被 .gitignore 的 *.log 排除，不會進版控。
 * 寫不進去（例如唯讀環境）也不能讓備份失敗：只把 tee 關掉。 */
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'backup.log');
const LOG_MAX = 512 * 1024;
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
let logReady = false;
try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX) {
        fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);   /* 太大就輪替一份，避免無限長大 */
    }
    logReady = true;
} catch (error) {
    process.stderr.write(`（寫不了 ${LOG_FILE}：${error.message}；改為只印在標準輸出）\n`);
}
function tee(stream, parts) {
    const line = parts.map((p) => (typeof p === 'string' ? p : String(p))).join(' ');
    stream.write(`${line}\n`);
    if (!logReady) return;
    try {
        fs.appendFileSync(LOG_FILE, `[${stamp()}] ${line}\n`);
    } catch (error) {
        logReady = false;
    }
}
console.log = (...parts) => tee(process.stdout, parts);
console.error = (...parts) => tee(process.stderr, parts);
console.log(`===== 備份開始 ${stamp()}（app ${APP_VERSION}${DRY ? '，--dry-run' : ''}）=====`);

function git(args, options = {}) {
    return execFileSync('git', args, Object.assign({ encoding: 'utf8', cwd: options.cwd || ROOT, stdio: options.stdio || 'pipe' }, options.extra || {}));
}

/* 把重建資料庫需要的 DDL 一起備份（Supabase 版 ＋ Neon 版）。 */
function copySchema(dir) {
    const out = path.join(dir, 'schema');
    fs.mkdirSync(out, { recursive: true });
    const sources = [
        ['migrations', (name) => name.endsWith('.sql') && fs.statSync(path.join(ROOT, 'migrations', name)).isFile()],
        ['migrations/neon', (name) => name.endsWith('.sql')]
    ];
    let copied = 0;
    for (const [rel, match] of sources) {
        const from = path.join(ROOT, rel);
        if (!fs.existsSync(from)) continue;
        for (const name of fs.readdirSync(from)) {
            if (!match(name)) continue;
            fs.copyFileSync(path.join(from, name), path.join(out, name));
            copied += 1;
        }
    }
    return copied;
}

function writeReadme(dir, manifest) {
    const lines = [
        `# gary-dictionary-backup`,
        ``,
        `這是 **Gary-Dictionary**（線上英文生字字典）的資料庫備份，由 \`scripts/backup.js\` 自動產生。`,
        `**私有 repo —— 內含帳號的密碼雜湊與 2FA 密鑰，不可公開、不可外流。**`,
        ``,
        `## 這一份（\`backups/${manifest.created_at.slice(0, 10)}/\`）`,
        ``,
        `- 建立時間：${manifest.created_at}`,
        `- 來源：${manifest.source_host}（應用版本 ${manifest.app_version}）`,
        `- 資料庫大小：${manifest.db_size_bytes ?? '（讀不到）'} bytes`,
        `- 總筆數：${manifest.total_rows}`,
        ``,
        `| 資料表 | 筆數 | 檔案 |`,
        `|---|---|---|`,
        ...BACKUP.TABLES.map((table) => `| ${table} | ${manifest.tables[table] ?? 0} | \`${table}.jsonl\` |`),
        ``,
        `- \`manifest.json\`：每個檔案的 sha256，還原前會核對。`,
        `- \`schema/\`：重建資料庫用的 DDL（Supabase 版與 Neon 版）。`,
        ``,
        `## 還原`,
        ``,
        '```bash',
        `# 在 GD-English-Dictionary 專案裡（會先清空目標資料庫，需明確確認）`,
        `git clone https://github.com/${OWNER}/${REPO}.git /tmp/pv-backup`,
        `node scripts/restore.js --from=/tmp/pv-backup/backups/<日期> --confirm`,
        '```',
        ``,
        `還原後務必跑 \`npm run check:schema:live\` 與 \`node scripts/live-verify.js --no-auth --ephemeral-teacher\`。`,
        ``,
        `## 保留策略`,
        ``,
        `只保留最近 ${KEEP} 份（\`scripts/backup.js --keep=N\` 可調）；更舊的會在這個 repo 被刪除。`,
        ``
    ];
    fs.writeFileSync(path.join(dir, 'README.md'), lines.join('\n'), 'utf8');
}

function cloneRepo(dir) {
    git(['clone', '--depth', '1', `https://github.com/${OWNER}/${REPO}.git`, dir]);
}

async function main() {
    const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!base || !key) {
        console.error('✖ 缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY（看 .env）');
        process.exit(1);
    }

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-backup-'));
    const day = BACKUP.isoDay();
    const dir = path.join(work, 'backups', day);
    let repoDir = null;
    try {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`→ 匯出 ${BACKUP.safeHost(base)} 的資料（只讀，不動正式站）`);
        const manifest = await BACKUP.exportAll({
            base, key, dir, appVersion: APP_VERSION,
            log: (line) => console.log(line)
        });
        const schemaCount = copySchema(dir);
        writeReadme(dir, manifest);
        console.log(`  schema/：${schemaCount} 個 SQL｜manifest：${Object.keys(manifest.files).length} 個檔案｜總計 ${manifest.total_rows} 筆`);

        if (DRY) {
            console.log(`\n✔ --dry-run：已匯出到 ${dir}（沒有 push，跑完會刪掉）`);
            return;
        }

        repoDir = path.join(work, 'repo');
        console.log(`→ 取回私有備份 repo（${OWNER}/${REPO}）`);
        cloneRepo(repoDir);

        const target = path.join(repoDir, 'backups', day);
        fs.rmSync(target, { recursive: true, force: true });   /* 同一天重跑＝覆蓋 */
        fs.cpSync(dir, target, { recursive: true });

        /* 保留策略 */
        const backupsDir = path.join(repoDir, 'backups');
        const existing = fs.readdirSync(backupsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
        const drop = BACKUP.pruneList(existing, KEEP);
        for (const name of drop) {
            fs.rmSync(path.join(backupsDir, name), { recursive: true, force: true });
            console.log(`  移除舊備份 ${name}（只留最近 ${KEEP} 份）`);
        }

        git(['add', '-A'], { cwd: repoDir });
        const message = `backup ${day}：${manifest.total_rows} 筆（app ${manifest.app_version}）`;
        try {
            git(['commit', '-q', '-m', message], { cwd: repoDir });
        } catch (error) {
            console.log('  （沒有變更，略過 commit）');
        }
        let pushed = false;
        for (let attempt = 1; attempt <= 3 && !pushed; attempt += 1) {
            try {
                git(['push', 'origin', 'HEAD:main'], { cwd: repoDir });
                pushed = true;
            } catch (error) {
                console.log(`  第 ${attempt} 次 push 失敗（${String(error.stderr || error.message).split('\n')[0].slice(0, 120)}），重試…`);
            }
        }
        if (!pushed) throw new Error('push 連續失敗，備份沒有上傳（暫存檔已保留在 log 裡的路徑）');
        console.log(`✔ 備份已推上 https://github.com/${OWNER}/${REPO}/tree/main/backups/${day}`);
        console.log(`  commit：${message}`);
    } finally {
        if (process.env.PV_KEEP_TEMP === '1') {
            console.log(`（PV_KEEP_TEMP=1：暫存資料夾保留在 ${work}）`);
        } else {
            fs.rmSync(work, { recursive: true, force: true });
            console.log('（暫存資料夾已刪除，你的電腦不留檔案）');
        }
    }
}

main().catch((error) => {
    console.error(`✖ 備份失敗：${error.message}`);
    process.exit(1);
});
