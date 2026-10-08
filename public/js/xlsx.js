/* .xlsx／CSV 讀取（B-3）
 *
 * 為什麼自己寫、不引入套件：
 *   1. 前端零建置、零依賴是這個專案的原則（供應鏈風險也是一種風險：xlsx 這類套件過去有過
 *      原型污染與 DoS 的公告）。
 *   2. .xlsx 其實就是一個 ZIP，裡面是幾份 XML：我們只需要「第一張工作表的格子文字」，
 *      用瀏覽器內建的 DecompressionStream('deflate-raw') 解壓 + 自己掃 XML 就夠了。
 *   3. 需要在 Node 也能跑（測試要能驗）：所以只用 TextDecoder / DecompressionStream（Node 18+ 都有），
 *      不用 DOMParser。
 *
 * 對外的兩個函式：
 *   parseXlsx(arrayBuffer) → { rows: [[...]], sheetName }   ← 失敗丟 Error（訊息直接給使用者看）
 *   parseDelimited(text, { delimiter }) → { rows, delimiter }  ← CSV／TSV／分號都吃
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;   /* Node（測試用） */
    if (root) root.PDXlsx = api;                                              /* 瀏覽器 */
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const decoder = new TextDecoder('utf-8');

    /* ---------------- ZIP ---------------- */

    /* 從 ZIP 尾端找 EOCD（可能有註解，所以要往回找簽章 0x06054b50） */
    function findEndOfCentralDirectory(view) {
        const max = Math.min(view.byteLength, 66000);
        for (let offset = view.byteLength - 22; offset >= view.byteLength - max && offset >= 0; offset -= 1) {
            if (view.getUint32(offset, true) === 0x06054b50) return offset;
        }
        return -1;
    }

    function readCentralDirectory(view) {
        const eocd = findEndOfCentralDirectory(view);
        if (eocd < 0) throw new Error('這不是有效的 .xlsx（找不到 ZIP 結尾）');
        const count = view.getUint16(eocd + 10, true);
        let offset = view.getUint32(eocd + 16, true);
        const entries = [];
        for (let i = 0; i < count; i += 1) {
            if (view.getUint32(offset, true) !== 0x02014b50) break;
            const method = view.getUint16(offset + 10, true);
            const compressedSize = view.getUint32(offset + 20, true);
            const nameLength = view.getUint16(offset + 28, true);
            const extraLength = view.getUint16(offset + 30, true);
            const commentLength = view.getUint16(offset + 32, true);
            const localOffset = view.getUint32(offset + 42, true);
            const name = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + offset + 46, nameLength));
            entries.push({ name, method, compressedSize, localOffset });
            offset += 46 + nameLength + extraLength + commentLength;
        }
        return entries;
    }

    function rawBytesOf(view, entry) {
        /* 區域檔頭長度不固定 → 用它的檔名與額外欄位長度算資料起點 */
        const local = entry.localOffset;
        if (view.getUint32(local, true) !== 0x04034b50) throw new Error('ZIP 內容損毀');
        const nameLength = view.getUint16(local + 26, true);
        const extraLength = view.getUint16(local + 28, true);
        const start = local + 30 + nameLength + extraLength;
        return new Uint8Array(view.buffer, view.byteOffset + start, entry.compressedSize);
    }

    async function inflateRaw(bytes) {
        if (typeof DecompressionStream !== 'function') {
            throw new Error('這個瀏覽器不支援解壓縮（請改用 CSV，或更新瀏覽器）');
        }
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    async function readEntry(view, entry) {
        const raw = rawBytesOf(view, entry);
        if (entry.method === 0) return raw;                 /* 未壓縮 */
        if (entry.method !== 8) throw new Error('不支援的壓縮方式（請另存為 .xlsx 或 CSV）');
        return inflateRaw(raw);
    }

    /* ---------------- 工作表 XML ---------------- */

    function decodeXml(text) {
        return text
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&#(\d+);/g, (match, code) => String.fromCharCode(Number(code)))
            .replace(/&#x([0-9a-fA-F]+);/g, (match, code) => String.fromCharCode(parseInt(code, 16)))
            .replace(/&amp;/g, '&');
    }

    function columnIndex(ref) {
        const letters = String(ref || '').replace(/[^A-Z]/gi, '').toUpperCase();
        let index = 0;
        for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
        return index - 1;
    }

    /* 共用的字串表：<si><t>文字</t></si>（可能被拆成多個 <r><t>） */
    function parseSharedStrings(xml) {
        if (!xml) return [];
        const out = [];
        for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
            const inner = match[1];
            const parts = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((item) => decodeXml(item[1]));
            out.push(parts.join(''));
        }
        return out;
    }

    /* 第一張工作表：只取 <v>／inlineStr 的文字，其他（樣式、公式結果）不影響 */
    function parseSheet(xml, shared) {
        const rows = [];
        for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
            const cells = [];
            for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
                const attrs = cellMatch[1] || cellMatch[3] || '';
                const inner = cellMatch[2] || '';
                const refMatch = attrs.match(/\br="([A-Z]+\d+)"/i);
                const typeMatch = attrs.match(/\bt="([^"]+)"/);
                const type = typeMatch ? typeMatch[1] : 'n';
                let value = '';
                if (type === 'inlineStr') {
                    const parts = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((item) => decodeXml(item[1]));
                    value = parts.join('');
                } else {
                    const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
                    if (vMatch) {
                        value = decodeXml(vMatch[1]);
                        if (type === 's') value = shared[Number(value)] === undefined ? '' : shared[Number(value)];
                    }
                }
                const index = refMatch ? columnIndex(refMatch[1]) : cells.length;
                while (cells.length < index) cells.push('');
                cells[index] = String(value == null ? '' : value).trim();
            }
            rows.push(cells);
        }
        return rows;
    }

    async function parseXlsx(buffer) {
        const view = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
        const entries = readCentralDirectory(view);
        const find = (pattern) => entries.find((entry) => pattern.test(entry.name));
        const sheet = find(/^xl\/worksheets\/sheet1\.xml$/) || find(/^xl\/worksheets\/.*\.xml$/);
        if (!sheet) throw new Error('這個檔案裡找不到工作表（請確認是 .xlsx，不是 .xls）');
        const sharedEntry = find(/^xl\/sharedStrings\.xml$/);
        const sheetXml = decoder.decode(await readEntry(view, sheet));
        const shared = sharedEntry ? parseSharedStrings(decoder.decode(await readEntry(view, sharedEntry))) : [];
        const rows = parseSheet(sheetXml, shared);
        return { rows, sheetName: sheet.name };
    }

    /* ---------------- CSV／TSV ---------------- */

    function detectDelimiter(text) {
        const firstLine = String(text).split(/\r?\n/).find((line) => line.trim().length) || '';
        const counts = {
            '\t': (firstLine.match(/\t/g) || []).length,
            ',': (firstLine.match(/,/g) || []).length,
            ';': (firstLine.match(/;/g) || []).length
        };
        let best = ',';
        for (const key of ['\t', ',', ';']) if (counts[key] > counts[best]) best = key;
        return best;
    }

    /* 支援 "用雙引號包起來、裡面有逗號或換行" 的標準 CSV */
    function parseDelimited(text, options) {
        const source = String(text == null ? '' : text).replace(/^\ufeff/, '');
        const delimiter = (options && options.delimiter) || detectDelimiter(source);
        const rows = [];
        let row = [];
        let field = '';
        let quoted = false;
        for (let i = 0; i < source.length; i += 1) {
            const char = source[i];
            if (quoted) {
                if (char === '"' && source[i + 1] === '"') { field += '"'; i += 1; } else if (char === '"') quoted = false;
                else field += char;
                continue;
            }
            if (char === '"') { quoted = true; continue; }
            if (char === delimiter) { row.push(field.trim()); field = ''; continue; }
            if (char === '\n') { row.push(field.trim()); rows.push(row); row = []; field = ''; continue; }
            if (char === '\r') continue;
            field += char;
        }
        if (field.length || row.length) { row.push(field.trim()); rows.push(row); }
        return { rows: rows.filter((item) => item.some((cell) => cell !== '')), delimiter };
    }

    /* ---------------- 欄位對應 ---------------- */

    /* 生字表的欄位順序（老師最常見的寫法）：生字、音標、詞性、中文、英文、例句 */
    const FIELD_ORDER = ['headword', 'ipa_us', 'part_of_speech', 'zh_meaning', 'en_definition', 'example_en'];
    const FIELD_HINTS = {
        headword: ['生字', '單字', 'word', 'headword', '英文', 'vocabulary'],
        ipa_us: ['音標', 'ipa', '發音', 'phonetic'],
        part_of_speech: ['詞性', 'pos', 'part of speech', '詞類'],
        zh_meaning: ['中文', '解釋', '意思', 'chinese', 'meaning', '定義'],
        en_definition: ['英文解釋', '英文定義', 'english', 'definition'],
        example_en: ['例句', 'example', '句子']
    };

    function guessMapping(headerRow) {
        const mapping = [];
        const used = new Set();
        for (let index = 0; index < (headerRow || []).length; index += 1) {
            const cell = String(headerRow[index] || '').toLowerCase().replace(/\s/g, '');
            let field = '';
            for (const key of FIELD_ORDER) {
                if (used.has(key)) continue;
                if (FIELD_HINTS[key].some((hint) => cell.includes(hint.toLowerCase().replace(/\s/g, '')))) { field = key; break; }
            }
            if (field) used.add(field);
            mapping.push(field);
        }
        return mapping;
    }

    /* 沒有表頭時：依「欄位數」推測順序（生字在前，解釋在後） */
    function defaultMapping(width) {
        return FIELD_ORDER.slice(0, Math.max(0, width));
    }

    /* 看起來像表頭嗎？（每一格都不是生字本身：包含「生字／word」或有兩個以上已知欄位名） */
    function looksLikeHeader(row) {
        const cells = (row || []).map((cell) => String(cell || '').toLowerCase().replace(/\s/g, ''));
        if (!cells.length) return false;
        let hits = 0;
        for (const cell of cells) {
            for (const key of FIELD_ORDER) {
                if (FIELD_HINTS[key].some((hint) => cell === hint.toLowerCase().replace(/\s/g, '') || cell.includes(hint.toLowerCase().replace(/\s/g, '')))) { hits += 1; break; }
            }
        }
        return hits >= 2;
    }

    /* 把「列 + 欄位對應」轉成伺服器要的每一筆資料；跳過整列空白 */
    function toEntries(rows, mapping, options) {
        const out = [];
        for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index] || [];
            if (!row.some((cell) => String(cell || '').trim())) continue;
            const entry = {};
            mapping.forEach((field, column) => {
                if (!field) return;
                const value = String(row[column] == null ? '' : row[column]).trim();
                if (value) entry[field] = value;
            });
            if (!entry.headword) continue;
            out.push(entry);
        }
        /* 同一批裡重複的生字只留第一筆（不然整批都會因為重複被略過） */
        const seen = new Set();
        return out.filter((entry) => {
            const key = entry.headword.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    return { parseXlsx, parseDelimited, detectDelimiter, guessMapping, defaultMapping, looksLikeHeader, toEntries, FIELD_ORDER, FIELD_HINTS };
}));
