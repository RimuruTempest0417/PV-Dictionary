/* B-1 使用說明的守門測試
 *
 * 說明文件最怕的是「寫了不存在的功能」—— 學生照著按卻找不到按鈕，比沒有說明更糟。
 * 這支測試做四件事：
 *   1. 每一節提到的介面元素都真的存在於 public/index.html。
 *   2. 每一節提到的能力都真的存在於 lib/capabilities.js（且該節的對象真的擁有它）。
 *   3. 每一句說明文字都有中文與英文，而且不是同一句（複製貼上會被抓到）。
 *   4. 說明頁的內容不可以自己寫死一份權限表（要讀 /api/roles）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Capabilities = require('../lib/capabilities');
const Routes = require('../lib/roles');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const GUIDE_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'guide.js'), 'utf8');
const I18N_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'i18n.js'), 'utf8');

/* 從 guide.js 抓出 SECTIONS 的內容（不執行前端程式碼，用文字解析就夠） */
function guideSections() {
    const ids = [...GUIDE_SOURCE.matchAll(/ids: \[([^\]]+)\]/g)].map((match) => match[1].split(',').map((item) => item.trim().replace(/'/g, '')).filter(Boolean));
    const steps = [...GUIDE_SOURCE.matchAll(/steps: \[([^\]]+)\]/g)].map((match) => match[1].split(',').map((item) => item.trim().replace(/'/g, '')).filter(Boolean));
    const titles = [...GUIDE_SOURCE.matchAll(/title: '([^']+)'/g)].map((match) => match[1]);
    const capabilities = [...GUIDE_SOURCE.matchAll(/capability: '([^']+)'/g)].map((match) => match[1]);
    const audiences = [...GUIDE_SOURCE.matchAll(/audience: '([^']+)'/g)].map((match) => match[1]);
    return { ids, steps, titles, capabilities, audiences };
}

test('說明頁（B-1）：每一節提到的介面元素都真的存在', () => {
    const { ids } = guideSections();
    assert.ok(ids.length >= 5, '至少要抓到幾節的 ids');
    const missing = [];
    for (const list of ids) {
        for (const id of list) {
            if (!HTML.includes(`id="${id}"`)) missing.push(id);
        }
    }
    assert.deepEqual(missing, [], `說明提到的元素不存在（別讓老師照著做卻找不到按鈕）：${missing.join(', ')}`);
});

test('說明頁（B-1）：每一節提到的能力都存在，而且那一節的對象真的擁有它', () => {
    const { capabilities } = guideSections();
    assert.ok(capabilities.length >= 3, '說明頁應該說明多種能力');
    for (const key of capabilities) {
        assert.ok(Capabilities.capabilityKeys().includes(key), `說明頁提到不存在的能力 ${key}`);
    }
    /* 每一節的對象至少要有那一節講到的能力（否則會教一個他做不到的事） */
    const pairs = [...GUIDE_SOURCE.matchAll(/audience: '([^']+)'[\s\S]{0,400}?capability: '([^']+)'/g)]
        .map((match) => ({ audience: match[1], capability: match[2] }));
    assert.ok(pairs.length >= 3, '要有幾個「對象 + 能力」的配對');
    for (const pair of pairs) {
        assert.equal(Capabilities.check(pair.capability, { role: pair.audience }), true,
            `${pair.audience} 不具備 ${pair.capability}，那一節不該給他看`);
    }
});

test('說明頁（B-1）：每一句都有中英兩種語言，而且不是複製貼上', () => {
    const { titles, steps } = guideSections();
    const keys = [...titles, ...steps.flat()];
    assert.ok(keys.length >= 15, `說明文字太少（${keys.length}）`);
    const missing = [];
    for (const key of keys) {
        if (!I18N_SOURCE.includes(`'${key}':`)) missing.push(key);
    }
    assert.deepEqual(missing, [], `說明文字缺少 i18n 鍵：${missing.join(', ')}`);

    /* 抓出每個鍵的英文與中文句子，比對是否「完全一樣」（複製貼上會被抓到） */
    const same = [];
    for (const key of keys) {
        const hits = [...I18N_SOURCE.matchAll(new RegExp(`'${key.replace(/[.]/g, '\\.')}': '([^']*)'`, 'g'))].map((match) => match[1]);
        if (hits.length < 2) { same.push(`${key}（只有 ${hits.length} 種語言）`); continue; }
        if (hits[0] === hits[1]) same.push(`${key}（中英一模一樣）`);
    }
    assert.deepEqual(same, [], same.join('\n'));
});

test('說明頁（B-1）：說明只給看得到的人（訪客不會看到管理員的步驟）', () => {
    const { audiences } = guideSections();
    assert.ok(audiences.includes('guest'), '訪客也要有「怎麼查生字」');
    assert.ok(audiences.includes('teacher') || audiences.includes('class_rep'), '要有老師／科代表的步驟');
    const levels = Routes.ROLE_LEVELS;
    for (const audience of audiences) {
        assert.ok(Object.prototype.hasOwnProperty.call(levels, audience), `說明頁寫了不存在的角色 ${audience}`);
    }
});

test('說明頁（B-1）：角色對照表是讀 /api/roles，不是前端自己寫一份', () => {
    assert.match(GUIDE_SOURCE, /\/api\/roles/, '角色對照表要讀 /api/roles');
    assert.equal(/min_role\s*:/.test(GUIDE_SOURCE), false, 'guide.js 不可以自己寫一份權限資料');
});

test('說明頁（B-1）：列印版只印說明（body[data-print-view] 規則要在 print.css 裡）', () => {
    const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'print.css'), 'utf8');
    assert.match(css, /body\[data-print-view="guide"\]/, 'print.css 要有列印說明頁的規則');
    assert.match(GUIDE_SOURCE, /dataset\.printView\s*=\s*'guide'/, '列印時要標記現在印的是說明頁（body.dataset.printView）');
});
