/* B-3：.xlsx／CSV 讀取的測試
 *
 * 這個測試會**自己組一個真的 .xlsx**（ZIP + 共用字串表 + 工作表 XML，
 * 一份用未壓縮、一份用 deflate），再把 public/js/xlsx.js 當成模組載入來解析。
 * 這樣就不需要把測試檔放進 repo，也不會依賴任何套件。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const Xlsx = require('../public/js/xlsx.js');

/* ---------------- 迷你 ZIP 產生器 ---------------- */

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c;
    }
    return table;
})();

function crc32(buffer) {
    let crc = -1;
    for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xFF];
    return (crc ^ -1) >>> 0;
}

/* files: [{ name, content }]，deflate=true 時用真正的壓縮（Excel 就是這樣存的） */
function makeZip(files, { deflate = false } = {}) {
    const locals = [];
    const central = [];
    let offset = 0;
    for (const file of files) {
        const raw = Buffer.from(file.content, 'utf8');
        const stored = deflate ? zlib.deflateRawSync(raw) : raw;
        const method = deflate ? 8 : 0;
        const nameBytes = Buffer.from(file.name, 'utf8');
        const crc = crc32(raw);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(stored.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        locals.push(local, nameBytes, stored);

        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt16LE(0, 8);
        entry.writeUInt16LE(method, 10);
        entry.writeUInt32LE(crc, 16);
        entry.writeUInt32LE(stored.length, 20);
        entry.writeUInt32LE(raw.length, 24);
        entry.writeUInt16LE(nameBytes.length, 28);
        entry.writeUInt32LE(offset, 42);
        central.push(entry, nameBytes);

        offset += 30 + nameBytes.length + stored.length;
    }
    const centralBuffer = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralBuffer.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBuffer, eocd]);
}

function workbookXml() {
    const shared = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="9" uniqueCount="9">
<si><t>生字</t></si><si><t>音標</t></si><si><t>詞性</t></si><si><t>中文解釋</t></si><si><t>英文解釋</t></si>
<si><t>campus</t></si><si><t>library</t></si><si><t>/ˈkæm.pəs/</t></si><si><t>校園</t></si>
</sst>`;
    const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>
<row r="2"><c r="A2" t="s"><v>5</v></c><c r="B2" t="s"><v>7</v></c><c r="C2" t="inlineStr"><is><t>n.</t></is></c><c r="D2" t="s"><v>8</v></c><c r="E2" t="inlineStr"><is><t>the land of a school &amp; its buildings</t></is></c></row>
<row r="3"><c r="A3" t="s"><v>6</v></c><c r="C3" t="inlineStr"><is><t>n.</t></is></c><c r="D3" t="inlineStr"><is><t>圖書館</t></is></c></row>
</sheetData></worksheet>`;
    return { shared, sheet };
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`;

/* ---------------- 測試 ---------------- */

for (const deflate of [false, true]) {
    const label = deflate ? 'deflate 壓縮（Excel 實際的存法）' : '未壓縮';
    test(`.xlsx 讀取（${label}）：共用字串、行內字串、中文與跳脫字元都要對`, async () => {
        const { shared, sheet } = workbookXml();
        const zip = makeZip([
            { name: '[Content_Types].xml', content: CONTENT_TYPES },
            { name: 'xl/sharedStrings.xml', content: shared },
            { name: 'xl/worksheets/sheet1.xml', content: sheet }
        ], { deflate });

        const result = await Xlsx.parseXlsx(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength));
        assert.equal(result.rows.length, 3);
        assert.deepEqual(result.rows[0], ['生字', '音標', '詞性', '中文解釋', '英文解釋']);
        assert.deepEqual(result.rows[1], ['campus', '/ˈkæm.pəs/', 'n.', '校園', 'the land of a school & its buildings'], '共用字串與 &amp; 都要正確');
        assert.deepEqual(result.rows[2], ['library', '', 'n.', '圖書館'], '中間空欄要補成空字串（欄位才不會錯位）');
    });
}

test('.xlsx 讀取：欄位對應會認得表頭，並轉成每一筆資料', async () => {
    const { shared, sheet } = workbookXml();
    const zip = makeZip([
        { name: 'xl/sharedStrings.xml', content: shared },
        { name: 'xl/worksheets/sheet1.xml', content: sheet }
    ], { deflate: true });
    const { rows } = await Xlsx.parseXlsx(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength));

    assert.equal(Xlsx.looksLikeHeader(rows[0]), true);
    const mapping = Xlsx.guessMapping(rows[0]);
    assert.deepEqual(mapping, ['headword', 'ipa_us', 'part_of_speech', 'zh_meaning', 'en_definition']);
    const entries = Xlsx.toEntries(rows.slice(1), mapping);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
        headword: 'campus', ipa_us: '/ˈkæm.pəs/', part_of_speech: 'n.', zh_meaning: '校園',
        en_definition: 'the land of a school & its buildings'
    });
    assert.equal(entries[1].headword, 'library');
    assert.equal(entries[1].ipa_us, undefined, '空的欄位不要塞空字串');
});

test('.xlsx 讀取：壞檔要給人看得懂的錯誤，不是拋出英文字', async () => {
    await assert.rejects(() => Xlsx.parseXlsx(new TextEncoder().encode('not a zip at all').buffer), /有效的 .xlsx/);
    const zip = makeZip([{ name: 'xl/workbook.xml', content: '<workbook/>' }]);
    await assert.rejects(() => Xlsx.parseXlsx(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength)), /找不到工作表/);
});

test('CSV／TSV 讀取：引號、逗號、換行、BOM、分隔符自動判斷', () => {
    const csv = '\ufeff生字,音標,詞性,中文解釋\n"campus, main",/ˈkæm.pəs/,n.,"校園，主要校區"\nlibrary,,n.,"圖書館\n（含換行）"\n';
    const parsed = Xlsx.parseDelimited(csv);
    assert.equal(parsed.delimiter, ',');
    assert.equal(parsed.rows.length, 3);
    assert.equal(parsed.rows[1][0], 'campus, main', '引號裡的逗號不能被切開');
    assert.equal(parsed.rows[2][3], '圖書館\n（含換行）', '引號裡的換行要保留');
    assert.equal(parsed.rows[0][0], '生字', 'BOM 要去掉');

    const tsv = 'campus\t/ˈkæm.pəs/\tn.\t校園\nlibrary\t\t n. \t圖書館';
    const tsvParsed = Xlsx.parseDelimited(tsv);
    assert.equal(tsvParsed.delimiter, '\t');
    assert.equal(tsvParsed.rows[1][0], 'library');
    assert.equal(tsvParsed.rows[1][1], '');

    const semi = 'headword;ipa;pos;chinese\ncampus;/kæmpəs/;n.;校園';
    assert.equal(Xlsx.parseDelimited(semi).delimiter, ';');

    /* 整列空白要忽略、每格的空白要修剪 */
    const messy = 'a,b\n\n  ,  \n1, 2 \n';
    assert.deepEqual(Xlsx.parseDelimited(messy).rows, [['a', 'b'], ['1', '2']]);
});

test('CSV／TSV：沒有表頭時用順序推測，並在同一批裡去重', () => {
    const rows = [['campus', '/kæmpəs/', 'n.', '校園'], ['CAMPUS', '', '', '重複的要拿掉'], ['library', '', 'n.', '圖書館']];
    const mapping = Xlsx.guessMapping(rows[0]);
    assert.equal(mapping.every((field) => field === ''), true, '這不是表頭，不該猜出欄位');
    assert.deepEqual(Xlsx.defaultMapping(4), ['headword', 'ipa_us', 'part_of_speech', 'zh_meaning']);
    const entries = Xlsx.toEntries(rows, Xlsx.defaultMapping(4));
    assert.equal(entries.length, 2, '同一批裡同一個生字只留第一筆（大小寫視為相同）');
    assert.equal(entries[0].headword, 'campus');
    assert.equal(entries[1].headword, 'library');
});

test('前端檔案存在且沒有引入任何依賴（零建置原則）', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'xlsx.js'), 'utf8');
    assert.equal(/require\(['"][^.]/.test(source), false, '不可以 require 外部套件');
    assert.equal(/import\s+.*from/.test(source), false, '不可以用 ESM 匯入');
    assert.match(source, /DecompressionStream/, '用瀏覽器內建的解壓縮，不引入套件');
});
