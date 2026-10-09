#!/usr/bin/env node
/* D-1 的效能實測：一個單元塞很多生字時，分頁到底省了多少。
 *
 * 做法（全部在本機、用暫存資料檔，不碰 data/store.json）：
 *   1. 建立 1 本書 → 1 個單元 → N 個生字
 *   2. 量 /api/units/:id 的預設回應（分頁 60 筆）
 *   3. 量同一支端點「一頁 200 筆」與「假裝要全部」（per_page 很大 → 上限 200）
 *   4. 直接算「整份生字清單的 JSON 大小」當作舊行為的對照
 *
 * 用法：node scripts/perf-entries.js [生字數，預設 3000]
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'perf-secret';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

const COUNT = Math.max(1, Number(process.argv[2]) || 3000);

function kb(bytes) { return (bytes / 1024).toFixed(1) + ' KB'; }

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-perf-'));
    const app = createApp({ backend: 'json', dataFile: path.join(dir, 'store.json') });
    const store = app.locals.store;
    const book = store.createBook({ code: 'PERF', name: 'PERF', grade: 'P1', sort_order: 1, is_published: true });
    const unit = store.createUnit({ book_id: book.id, unit_no: 1, title: 'Perf', sort_order: 1, is_published: true });
    const t0 = Date.now();
    for (let i = 1; i <= COUNT; i += 1) {
        store.createEntry({
            unit_id: unit.id,
            headword: 'performance' + String(i).padStart(5, '0'),
            headword_norm: 'performance' + String(i).padStart(5, '0'),
            ipa_us: '/pəˈfɔːməns/', part_of_speech: 'n.', zh_meaning: '效能',
            en_definition: 'how well something works', example_en: 'This is a performance test.',
            status: 'published', sort_order: i, created_by: 'perf'
        });
    }
    const seedMs = Date.now() - t0;
    const server = app.listen(0);
    const base = 'http://127.0.0.1:' + server.address().port;
    console.log('建立 ' + COUNT + ' 個生字：' + seedMs + 'ms（暫存資料檔，不影響真實資料）');

    async function measure(url, label) {
        const started = process.hrtime.bigint();
        const res = await fetch(base + url);
        const text = await res.text();
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        const body = JSON.parse(text);
        console.log(
            label.padEnd(28) +
            '回應 ' + kb(Buffer.byteLength(text)).padStart(10) +
            '｜生字 ' + String((body.entries || []).length).padStart(4) +
            '｜total ' + String(body.total).padStart(5) +
            '｜has_more ' + String(body.has_more) +
            '｜' + ms.toFixed(1) + 'ms'
        );
        return { bytes: Buffer.byteLength(text), count: (body.entries || []).length, ms };
    }

    const page1 = await measure('/api/units/' + unit.id, '分頁（預設 60 筆）');
    const page200 = await measure('/api/units/' + unit.id + '?per_page=200', '一頁 200 筆（上限）');
    const search = await measure('/api/units/' + unit.id + '?q=performance00007', '搜尋（1 筆命中）');

    /* 舊行為的對照：整份清單的 JSON 大小（以前就是一次送這麼多） */
    const allJson = JSON.stringify(store.listEntries({ unitId: unit.id }));
    console.log('—'.repeat(72));
    console.log('整份清單的 JSON：' + kb(Buffer.byteLength(allJson)));
    console.log('第一頁省下：' + (((1 - page1.bytes / Buffer.byteLength(allJson)) * 100).toFixed(1)) + '%');
    console.log('搜尋的回應（分頁之後）：' + kb(search.bytes));

    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
})();
