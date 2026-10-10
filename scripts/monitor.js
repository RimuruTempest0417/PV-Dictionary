#!/usr/bin/env node
/* D-8（v0.11.0）：每天自動健康檢查，發現問題就用 macOS 通知叫人。
 *
 * 用法：
 *   npm run monitor                    # 檢查一次（失敗會發 macOS 通知；exit code 1）
 *   npm run monitor -- --no-notify     # 只檢查、不通知（自己在看輸出時用）
 *   npm run monitor -- --dry-run       # 連通知內容都只印出來（測試用，不會真的彈通知）
 *   npm run monitor -- --site=https://…  # 換檢查對象
 *
 * 設計：
 *   - **判準不重寫**：所有檢查都交給 `scripts/uptime-check.js`（同一支、同一套門檻），
 *     這裡只負責「記錄 + 判斷要不要叫人 + 叫人」。
 *   - **逐字記錄寫進專案內的 `logs/uptime.log`**（使用者 2026-10-10 指定日誌放專案裡）。
 *     ★ 由 node 自己寫、不是讓 launchd 寫：launchd 在 ~/Documents 開檔會被 TCC 擋
 *       （整個 job 連啟動都失敗，實測 exit code 78: EX_CONFIG）—— 詳見 docs/備份與還原.md。
 *   - 通知用 `osascript -e 'display notification …'`；不吵人：只有失敗才通知，成功只寫日誌。
 *   - launchd 每天 08:30 跑（見 ~/Library/LaunchAgents/com.garycheong.gary-dictionary-monitor.plist）。
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const arg = (name, fallback) => {
    const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const SITE = String(arg('site', process.env.SITE_URL || 'https://gary-dictionary-mylearning.vercel.app')).replace(/\/+$/, '');
const NO_NOTIFY = process.argv.includes('--no-notify');
const DRY = process.argv.includes('--dry-run');
const APP_VERSION = require(path.join(ROOT, 'package.json')).version;

/* ---- 記錄（與 scripts/backup.js 同一套：逐字寫進專案內的 logs/）---- */
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'uptime.log');
const LOG_MAX = 512 * 1024;
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
let logReady = false;
try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
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

/* ---- 通知 ---- */
function notify(title, message) {
    if (NO_NOTIFY) {
        console.log(`（--no-notify：不發通知）${title}：${message}`);
        return;
    }
    if (DRY) {
        console.log(`（--dry-run：原本會發這個通知）${title}：${message}`);
        return;
    }
    try {
        execFileSync('osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Basso"`]);
        console.log(`（已發出 macOS 通知）`);
    } catch (error) {
        /* 通知失敗不能蓋掉「檢查失敗」這件事本身 */
        console.error(`（通知發不出去：${error.message}——請確認「系統設定 → 通知」允許 Script Editor／osascript）`);
    }
}

function main() {
    console.log(`===== 健康檢查 ${stamp()}（app ${APP_VERSION}，${SITE}）=====`);
    let report = null;
    let raw = '';
    try {
        raw = execFileSync(process.execPath, [path.join(__dirname, 'uptime-check.js'), '--json', `--site=${SITE}`], {
            encoding: 'utf8', timeout: 120000
        });
    } catch (error) {
        /* uptime-check 失敗時 exit 1，stdout 仍然是完整的 JSON（它一定印） */
        raw = String(error.stdout || '');
        if (!raw) {
            console.error(`✖ 檢查跑不起來：${error.message}`);
            notify('Gary-Dictionary 監控失敗', `檢查程式跑不起來：${String(error.message).slice(0, 120)}`);
            process.exit(1);
        }
    }
    try {
        report = JSON.parse(raw);
    } catch (error) {
        console.error(`✖ 讀不懂檢查結果：${raw.slice(0, 200)}`);
        notify('Gary-Dictionary 監控失敗', '檢查結果不是預期的 JSON 格式');
        process.exit(1);
    }

    const failed = report.checks.filter((check) => !check.ok);
    for (const check of report.checks) console.log(`  ${check.ok ? '✔' : '✖'} ${check.name} → ${check.detail || ''}`);
    console.log(`  檢查時間 ${report.checked_at}｜${report.checks.length - failed.length}/${report.checks.length} 通過`);

    if (failed.length === 0) {
        console.log('✔ 全部正常（不發通知）');
        process.exit(0);
    }

    console.log(`✖ ${failed.length} 項失敗`);
    const lines = failed.map((check) => `・${check.name}：${String(check.detail || '').slice(0, 90)}`);
    notify(`Gary-Dictionary 有 ${failed.length} 項異常`, `${SITE}\n${lines.join('\n')}`);
    process.exit(1);
}

main();
