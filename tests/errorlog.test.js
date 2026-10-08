/* 錯誤日誌與節流的單元測試（v0.4.2 / A-5、A-4、E-4）
 *
 * 這一層測的是「公開端點收到的東西一律不可信」：
 *   - 超長訊息、奇怪欄位、把整包物件塞進 context → 都要被削乾淨
 *   - 節流要真的擋得住（而不是「理論上會擋」）
 *   - 自動化檢查的簽章：簽錯、過期、亂改時間戳 → 一律當成真人操作
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createErrorLog, normalizeEntry, normalizeFilters, matchesFilters, cleanContext, MAX_MESSAGE, JSON_KEEP } = require('../lib/errorlog');
const { createThrottle } = require('../lib/throttle');
const SelfTest = require('../lib/selftest');

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pv-errorlog-'));
}

test('錯誤日誌：欄位會被削乾淨，多餘的欄位與超長內容都進不來', () => {
    const entry = normalizeEntry({
        source: 'hacker',
        level: 'fatal',
        code: 'x'.repeat(200),
        message: `line1\nline2 ${'y'.repeat(900)}`,
        path: '/p'.repeat(500),
        version: 'v1',
        user_id: 'abc',
        user_agent: 'z'.repeat(500),
        is_self_test: 'yes',          /* 只有真正的 true 才算（字串不算） */
        context: { line: 12, hacked: 'nope', stack: 'a'.repeat(500) },
        secret: 'must not be stored'
    });
    assert.equal(entry.source, 'client');
    assert.equal(entry.level, 'error');
    assert.equal(entry.code.length, 60);
    assert.equal(entry.message.length, MAX_MESSAGE);
    assert.equal(entry.message.includes('\n'), false, '換行會被壓成空白');
    assert.ok(entry.path.length <= 200);
    assert.equal(entry.user_id, null, '不是數字的使用者 id 一律當成沒有');
    assert.equal(entry.is_self_test, false, '字串 "yes" 不算自動化檢查');
    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'secret'), false, '白名單以外的欄位不會被存');
    assert.deepEqual(Object.keys(entry.context).sort(), ['line', 'stack'], 'context 只留白名單');
});

test('錯誤日誌：cleanContext 擋掉陣列與非物件', () => {
    assert.equal(cleanContext(null), null);
    assert.equal(cleanContext('hello'), null);
    assert.equal(cleanContext([1, 2, 3]), null);
    assert.equal(cleanContext({ nothing: 'useful' }), null);
    assert.deepEqual(cleanContext({ directive: "script-src 'self'", blocked: 'inline' }),
        { directive: "script-src 'self'", blocked: 'inline' });
});

test('錯誤日誌：篩選規則（等級／來源／狀態／日期／自動化）', () => {
    const filters = normalizeFilters({ level: 'WARN', source: 'browser', resolved: 'false', from: '2026-10-08', to: 'bad-date' });
    assert.equal(filters.level, 'warn');
    assert.equal(filters.source, '');
    assert.equal(filters.resolved, 'false');
    assert.equal(filters.from, '2026-10-08');
    assert.equal(filters.to, '', '格式不對的日期要忽略，不能變成「查不到任何東西」');

    const row = { level: 'warn', source: 'client', resolved: false, created_at: '2026-10-08T10:00:00.000Z', is_self_test: false };
    assert.equal(matchesFilters(row, filters), true);
    assert.equal(matchesFilters(row, normalizeFilters({ level: 'error' })), false);
    assert.equal(matchesFilters(row, normalizeFilters({ from: '2026-10-09' })), false);
    assert.equal(matchesFilters(Object.assign({}, row, { is_self_test: true }), normalizeFilters({ hide_self_test: '1' })), false);
});

test('錯誤日誌（本機 JSON）：寫入、列表（新到舊）、標記、清理', () => {
    const dir = tempDir();
    const log = createErrorLog({ backend: 'json', dataDir: dir });

    const first = log.append({ code: 'A', message: 'first' });
    const second = log.append({ code: 'B', message: 'second' });
    assert.ok(first.id < second.id, 'id 要遞增');

    const listed = log.list({ limit: 10 });
    assert.equal(listed.total, 2);
    assert.equal(listed.open_count, 2);
    assert.equal(listed.rows[0].code, 'B', '最新的在最前面');

    const resolved = log.resolve(second.id, { by: 7, note: '修好了' });
    assert.equal(resolved.resolved, true);
    assert.equal(resolved.resolved_by, 7);
    assert.equal(log.list({}).open_count, 1);
    assert.equal(log.resolve(99999, {}), null, '不存在的 id 回 null');

    /* 清理只刪「已處理且過期」的：未處理的永遠留著 */
    fs.writeFileSync(path.join(dir, 'error-logs.json'), JSON.stringify([
        Object.assign({}, first, { created_at: '2020-01-01T00:00:00.000Z', resolved: false }),
        Object.assign({}, second, { created_at: '2020-01-01T00:00:00.000Z', resolved: true })
    ]));
    const dry = log.purge({ olderThanDays: 30, dryRun: true });
    assert.equal(dry.deleted, 1, 'dry-run 也要算得出會刪幾筆');
    assert.equal(log.counts().total, 2, 'dry-run 不能真的刪');
    const real = log.purge({ olderThanDays: 30 });
    assert.equal(real.deleted, 1);
    assert.equal(log.counts().total, 1);
    assert.equal(log.counts().open, 1, '未處理的留著');

    fs.rmSync(dir, { recursive: true, force: true });
});

test('錯誤日誌：本機檔案不會無限長大（保留最新 N 筆）', () => {
    const dir = tempDir();
    const log = createErrorLog({ backend: 'json', dataDir: dir });
    for (let i = 0; i < JSON_KEEP + 25; i += 1) log.append({ code: 'NOISE', message: `n${i}` });
    const listed = log.list({ limit: 1 });
    assert.equal(listed.total, JSON_KEEP, `超過 ${JSON_KEEP} 筆要丟掉最舊的`);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('節流：超過上限就擋，時間到就重新計算', () => {
    let now = 1_000_000;
    const throttle = createThrottle({ now: () => now });
    for (let i = 0; i < 3; i += 1) {
        assert.equal(throttle.allow('ip|bucket', 3, 1000).allowed, true, `第 ${i + 1} 次應該可以`);
    }
    const blocked = throttle.allow('ip|bucket', 3, 1000);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterMs > 0);
    assert.equal(throttle.allow('other-ip|bucket', 3, 1000).allowed, true, '不同來源互不影響');
    now += 1001;
    assert.equal(throttle.allow('ip|bucket', 3, 1000).allowed, true, '時間過了要重新計算');
});

test('自動化檢查的簽章：簽對才通過，亂改或過期一律不通過', () => {
    const secret = 'test-secret';
    const now = 1_700_000_000_000;
    const header = SelfTest.makeHeader(secret, now);
    assert.equal(SelfTest.verifyHeader(secret, header, now), true);
    assert.equal(SelfTest.verifyHeader(secret, header, now + 60_000), true, '5 分鐘內都算有效');
    assert.equal(SelfTest.verifyHeader(secret, header, now + 10 * 60_000), false, '過期就不算');
    assert.equal(SelfTest.verifyHeader('wrong-secret', header, now), false);
    assert.equal(SelfTest.verifyHeader(secret, `${now}.deadbeef`, now), false);
    assert.equal(SelfTest.verifyHeader(secret, 'garbage', now), false);
    assert.equal(SelfTest.verifyHeader(secret, '', now), false);
    assert.equal(SelfTest.verifyHeader('', header, now), false, '沒有密鑰時一律不通過');
    /* 改時間戳但沿用舊簽章 → 也必須失敗 */
    const parts = header.split('.');
    assert.equal(SelfTest.verifyHeader(secret, `${Number(parts[0]) + 1}.${parts[1]}`, now), false);
});
