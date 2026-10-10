#!/usr/bin/env node
/* 備援推送：當 `git push` 被 GitHub 回 500（git-receive-pack 掛掉，但 REST API 正常）時，
 * 改用 REST API 把本地 HEAD 推上去：blob → tree（帶 base_tree）→ commit → 更新 ref。
 *
 * 用法：
 *   node scripts/gh-api-push.js                # 推 HEAD 到遠端 main
 *   node scripts/gh-api-push.js --dry-run      # 只列出會改哪些檔案
 *   node scripts/gh-api-push.js --tag v0.1.0 --tag-message "..."   # 順便建 annotated tag
 *
 * 安全原則：ref 一律 force:false —— 遠端若已經前進就停下來，不覆蓋別人的提交。
 * 憑證：從 git credential helper 取得（macOS 是 osxkeychain），不印出。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OWNER = 'RimuruTempest0417';
const REPO = 'Gary-Dictionary';
const BRANCH = 'main';
const ROOT = path.resolve(__dirname, '..');

function git(args, options = {}) {
    return execFileSync('git', args, Object.assign({ cwd: ROOT, encoding: 'utf8' }, options)).trim();
}

function token() {
    const out = execFileSync('git', ['credential', 'fill'], {
        input: 'protocol=https\nhost=github.com\n\n',
        encoding: 'utf8'
    });
    const match = /^password=(.+)$/m.exec(out);
    if (!match) throw new Error('拿不到 GitHub 憑證（git credential fill 沒有 password）');
    return match[1].trim();
}

const AUTH = 'Bearer ' + token();

async function gh(method, apiPath, body) {
    const res = await fetch(`https://api.github.com${apiPath}`, {
        method,
        headers: {
            Authorization: AUTH,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'pv-dictionary-api-push'
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
    if (res.status >= 300) {
        throw new Error(`${method} ${apiPath} → HTTP ${res.status}：${text.slice(0, 300)}`);
    }
    return data;
}

/* 檔案 → GitHub 的 tree entry（mode 要對，否則可執行檔／symlink 會走味） */
function blobPayload(relPath) {
    const full = path.join(ROOT, relPath);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) {
        return { mode: '120000', content: fs.readlinkSync(full) };
    }
    const buffer = fs.readFileSync(full);
    return {
        mode: stat.mode & 0o111 ? '100755' : '100644',
        base64: buffer.toString('base64')
    };
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const tagIndex = args.indexOf('--tag');
    const tagName = tagIndex >= 0 ? args[tagIndex + 1] : null;
    const tagMessageIndex = args.indexOf('--tag-message');
    const tagMessage = tagMessageIndex >= 0 ? args[tagMessageIndex + 1] : `Release ${tagName}`;

    const localHead = git(['rev-parse', 'HEAD']);
    const localTree = git(['rev-parse', 'HEAD^{tree}']);
    const remoteRef = await gh('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
    const remoteHead = remoteRef.object.sha;
    if (remoteHead === localHead) {
        console.log(`ℹ️  遠端 ${BRANCH} 已經是本地的 ${localHead.slice(0, 8)}，沒有東西要推。`);
        return;
    }
    const remoteCommit = await gh('GET', `/repos/${OWNER}/${REPO}/git/commits/${remoteHead}`);
    const baseTree = remoteCommit.tree.sha;

    const meta = git(['log', '-1', '--format=%an%x00%ae%x00%aI%x00%B']);
    const [authorName, authorEmail, authorDate, ...messageParts] = meta.split('\x00');
    const message = messageParts.join('\x00');

    const status = git(['diff', '--name-status', `${remoteHead}`, 'HEAD']).split('\n').filter(Boolean);
    console.log(`本地 ${localHead.slice(0, 8)} → 遠端 ${remoteHead.slice(0, 8)}：${status.length} 個檔案有差異`);
    for (const line of status) console.log(`  ${line}`);
    if (dryRun) {
        console.log('（--dry-run：沒有真的推送）');
        return;
    }
    if (!status.length) {
        throw new Error('檔案內容一樣但 commit 不同（例如只有訊息不同）——請用 git push 或 --force-with-lease');
    }

    const tree = [];
    for (const line of status) {
        const [code, ...rest] = line.split('\t');
        const relPath = rest[rest.length - 1];
        if (code === 'D') {
            tree.push({ path: relPath, mode: '100644', type: 'blob', sha: null });
            continue;
        }
        const payload = blobPayload(relPath);
        const blob = await gh('POST', `/repos/${OWNER}/${REPO}/git/blobs`, payload.content !== undefined
            ? { content: payload.content, encoding: 'utf-8' }
            : { content: payload.base64, encoding: 'base64' });
        tree.push({ path: relPath, mode: payload.mode, type: 'blob', sha: blob.sha });
    }

    const newTree = await gh('POST', `/repos/${OWNER}/${REPO}/git/trees`, { base_tree: baseTree, tree });
    if (newTree.sha !== localTree) {
        throw new Error(`產生的 tree（${newTree.sha}）與本地 commit 的 tree（${localTree}）不同 —— 停下來，不要推！`);
    }
    console.log(`✔ tree 一致：${newTree.sha}`);

    const commit = await gh('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
        message,
        tree: newTree.sha,
        parents: [remoteHead],
        author: { name: authorName, email: authorEmail, date: authorDate },
        committer: { name: authorName, email: authorEmail, date: authorDate }
    });
    console.log(`✔ 建立 commit：${commit.sha}`);

    await gh('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
    console.log(`✔ 已更新 refs/heads/${BRANCH}`);

    if (tagName) {
        const tagObject = await gh('POST', `/repos/${OWNER}/${REPO}/git/tags`, {
            tag: tagName,
            message: tagMessage,
            object: commit.sha,
            type: 'commit',
            tagger: { name: authorName, email: authorEmail, date: authorDate }
        });
        await gh('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/tags/${tagName}`, sha: tagObject.sha });
        console.log(`✔ 已建立 tag ${tagName}（${tagObject.sha.slice(0, 8)}）`);
    }

    /* 讀回確認：不要只看自己 POST 的回應 */
    const readBack = await gh('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
    const remoteCommitAfter = await gh('GET', `/repos/${OWNER}/${REPO}/git/commits/${readBack.object.sha}`);
    console.log(`讀回確認：remote ${BRANCH} = ${readBack.object.sha.slice(0, 8)}｜tree 相同 = ${remoteCommitAfter.tree.sha === localTree}`
        + `｜訊息首行 = ${(remoteCommitAfter.message || '').split('\n')[0]}`);
}

main().catch((err) => {
    console.error('備援推送失敗：', err.message);
    process.exit(1);
});
