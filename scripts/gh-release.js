#!/usr/bin/env node
/* 發 GitHub Release（可重複使用，不必每次寫一份臨時腳本）
 *
 * 用法：
 *   node scripts/gh-release.js <tag> <說明檔.md> "<標題後半>" [--update]
 *
 * --update：Release 已存在時改成「改寫內文」（PATCH 只吃 release id，/releases/tags/:tag 只有 GET）。
 *
 * 憑證：從 git 的 credential helper（macOS 是 osxkeychain）取得，**不印出**。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OWNER = 'RimuruTempest0417';
const REPO = 'Gary-Dictionary';

function token() {
    const out = execFileSync('git', ['credential', 'fill'], {
        input: 'protocol=https\nhost=github.com\n\n',
        encoding: 'utf8'
    });
    const match = /^password=(.+)$/m.exec(out);
    if (!match) throw new Error('拿不到 GitHub 憑證（git credential fill 沒有 password）');
    return match[1].trim();
}

async function gh(method, apiPath, body) {
    const res = await fetch(`https://api.github.com${apiPath}`, {
        method,
        headers: {
            Authorization: `token ${token()}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'pv-dictionary-release'
        },
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch (err) {
        data = null;
    }
    return { status: res.status, data, text };
}

async function main() {
    const [tag, notesFile, titleSuffix, ...flags] = process.argv.slice(2);
    const update = flags.includes('--update');
    if (!tag || !notesFile) {
        console.error('用法：node scripts/gh-release.js <tag> <說明檔.md> "<標題後半>" [--update]');
        process.exit(1);
    }
    const notesPath = path.resolve(notesFile);
    if (!fs.existsSync(notesPath)) {
        console.error(`找不到說明檔：${notesPath}`);
        process.exit(1);
    }
    const body = fs.readFileSync(notesPath, 'utf8');
    const name = titleSuffix ? `${tag} - ${titleSuffix}` : tag;

    const ref = await gh('GET', `/repos/${OWNER}/${REPO}/git/ref/tags/${encodeURIComponent(tag)}`);
    if (ref.status !== 200) {
        console.error(`✖ 遠端找不到 tag ${tag}（HTTP ${ref.status}）——請先 git push origin ${tag}`);
        process.exit(1);
    }

    const existing = await gh('GET', `/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag)}`);
    let result;
    if (existing.status === 200 && update) {
        result = await gh('PATCH', `/repos/${OWNER}/${REPO}/releases/${existing.data.id}`, { name, body });
    } else if (existing.status === 200) {
        console.log(`ℹ️  ${tag} 的 Release 已存在（${existing.data.html_url}），要改寫內文請加 --update`);
        result = { status: 200, data: existing.data };
    } else {
        result = await gh('POST', `/repos/${OWNER}/${REPO}/releases`, {
            tag_name: tag, name, body, draft: false, prerelease: false
        });
    }
    if (result.status >= 300) {
        console.error(`✖ 建立 Release 失敗（HTTP ${result.status}）：${result.text.slice(0, 300)}`);
        process.exit(1);
    }
    console.log(`✔ Release ${tag}：${result.data.html_url}`);

    // 讀回確認（不要只看 POST 的回應）
    const readBack = await gh('GET', `/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag)}`);
    const list = await gh('GET', `/repos/${OWNER}/${REPO}/releases?per_page=100`);
    console.log(`讀回確認：name=${readBack.data && readBack.data.name}｜published=${readBack.data && readBack.data.published_at}`
        + `｜body ${(readBack.data && readBack.data.body || '').length} 字`);
    console.log(`目前共 ${Array.isArray(list.data) ? list.data.length : '?'} 個 Release`);
}

main().catch((err) => {
    console.error('發版失敗：', err.message);
    process.exit(1);
});
