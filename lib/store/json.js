/* 本機 JSON 資料層（Demo 階段使用）
 *
 * 為什麼是 JSON 而不是 SQLite：使用者指定「不使用 SQLite」；Demo 只需要單機單一實例，
 * 一個檔案就能開機即用、也能直接複製備份。欄位名稱與 migrations/*.sql **完全一致**，
 * 之後切 Supabase 時只是換 adapter，不動任何呼叫端。
 *
 * 限制（誠實揭露，README 也有寫）：
 * - 單一行程記憶體內操作，寫入用「讀-改-寫 + 原子替換 + 序列化佇列」；多實例同時寫會互相覆蓋。
 * - 音檔以 base64 存在同一個檔案內，檔案會隨錄音增加而變大。
 */
const fs = require('fs');
const path = require('path');

const { normalizeAuditFilters, matchesAuditFilters } = require('../audit');

const EMPTY = {
    meta: { version: 1 },
    seq: {},
    books: [],
    units: [],
    entries: [],
    audio: [],
    users: [],
    grants: [],
    audit_logs: []
};

function nowIso() {
    return new Date().toISOString();
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createJsonStore(options = {}) {
    const dataFile = path.resolve(options.dataFile
        || process.env.DATA_FILE
        || path.join(__dirname, '..', '..', 'data', 'store.json'));

    let state = load();

    function load() {
        try {
            if (!fs.existsSync(dataFile)) return clone(EMPTY);
            const raw = fs.readFileSync(dataFile, 'utf8');
            if (!raw.trim()) return clone(EMPTY);
            const parsed = JSON.parse(raw);
            return Object.assign(clone(EMPTY), parsed, {
                meta: Object.assign({ version: 1 }, parsed.meta || {}),
                seq: parsed.seq || {}
            });
        } catch (err) {
            throw new Error(`讀取資料檔失敗（${dataFile}）：${err.message}`);
        }
    }

    /* 寫入：同步 + 原子替換（先寫 .tmp 再 rename，避免寫到一半被讀到）。
     * 為什麼用同步：Demo 是單機單一實例、Node 單執行緒，同步寫入讓「建立後立刻讀檔」一定看得到
     * （非同步佇列會讓測試、備份腳本或下一個請求讀到舊內容）。
     * 資料量真的變大時才需要改成佇列 + 等待寫入完成。 */
    function persist() {
        const payload = JSON.stringify(
            Object.assign({}, state, { meta: Object.assign({}, state.meta, { saved_at: nowIso() }) }),
            null,
            2
        );
        fs.mkdirSync(path.dirname(dataFile), { recursive: true });
        const tmp = `${dataFile}.tmp`;
        fs.writeFileSync(tmp, payload, 'utf8');
        fs.renameSync(tmp, dataFile);
        return true;
    }

    function nextId(table) {
        const current = Number(state.seq[table] || 0) + 1;
        state.seq[table] = current;
        return current;
    }

    function insert(table, row, { persistAfter = true } = {}) {
        const record = Object.assign({}, row);
        record.id = nextId(table);
        if (!record.created_at) record.created_at = nowIso();
        state[table].push(record);
        if (persistAfter) persist();
        return clone(record);
    }

    function update(table, id, patch) {
        const row = state[table].find((r) => String(r.id) === String(id));
        if (!row) return null;
        Object.assign(row, patch, { updated_at: nowIso() });
        persist();
        return clone(row);
    }

    function remove(table, id) {
        const idx = state[table].findIndex((r) => String(r.id) === String(id));
        if (idx === -1) return false;
        state[table].splice(idx, 1);
        persist();
        return true;
    }

    function deleteUser(id) { return remove('users', id); }

    /* ---------- 書本 ---------- */
    function listBooks({ includeUnpublished = false } = {}) {
        return state.books
            .filter((b) => includeUnpublished || b.is_published !== false)
            .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id))
            .map(clone);
    }
    function getBook(id) { return clone(state.books.find((b) => String(b.id) === String(id))) || null; }
    function createBook(data) { return insert('books', data); }
    function updateBook(id, patch) { return update('books', id, patch); }

    /* ---------- 單元 ---------- */
    function listUnits({ bookId = null, includeUnpublished = false } = {}) {
        return state.units
            .filter((u) => (bookId === null || String(u.book_id) === String(bookId)))
            .filter((u) => includeUnpublished || u.is_published !== false)
            .sort((a, b) => (a.unit_no - b.unit_no) || (a.id - b.id))
            .map(clone);
    }
    function getUnit(id) { return clone(state.units.find((u) => String(u.id) === String(id))) || null; }
    function findUnitByNo(bookId, unitNo) {
        return clone(state.units.find((u) => String(u.book_id) === String(bookId) && Number(u.unit_no) === Number(unitNo))) || null;
    }
    function createUnit(data) { return insert('units', data); }
    function updateUnit(id, patch) { return update('units', id, patch); }

    /* ---------- 生字 ---------- */
    function listEntries({ unitId = null, statuses = null } = {}) {
        return state.entries
            .filter((e) => (unitId === null || String(e.unit_id) === String(unitId)))
            .filter((e) => !statuses || statuses.includes(e.status))
            .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id))
            .map(clone);
    }
    function getEntry(id) { return clone(state.entries.find((e) => String(e.id) === String(id))) || null; }
    function findEntryByHeadword(unitId, headwordNorm) {
        return clone(state.entries.find((e) => String(e.unit_id) === String(unitId) && e.headword_norm === headwordNorm)) || null;
    }
    function createEntry(data) { return insert('entries', data); }
    function updateEntry(id, patch) { return update('entries', id, patch); }
    function deleteEntry(id) {
        const ok = remove('entries', id);
        if (ok) {
            const orphans = state.audio.filter((a) => String(a.entry_id) === String(id));
            if (orphans.length) {
                state.audio = state.audio.filter((a) => String(a.entry_id) !== String(id));
                persist();
            }
        }
        return ok;
    }
    function countEntries(unitId, statuses) {
        return state.entries
            .filter((e) => String(e.unit_id) === String(unitId))
            .filter((e) => !statuses || statuses.includes(e.status)).length;
    }

    /* ---------- 音檔 ---------- */
    function listAudio({ entryId = null } = {}) {
        return state.audio
            .filter((a) => (entryId === null || String(a.entry_id) === String(entryId)))
            .map(clone);
    }
    function getAudio(id) { return clone(state.audio.find((a) => String(a.id) === String(id))) || null; }
    /* 與 supabase adapter 同一組介面：JSON 版全部都在檔案裡，直接回同一筆（含 data） */
    function getAudioData(id) { return getAudio(id); }
    function getBookCoverData(id) { return getBook(id); }
    function createAudio(data) { return insert('audio', data); }
    function deleteAudio(id) { return remove('audio', id); }
    function findTeacherAudio(entryId) {
        return clone(state.audio.find((a) => String(a.entry_id) === String(entryId) && a.source === 'teacher')) || null;
    }

    /* ---------- 使用者 ---------- */
    function findUserByUsername(username) {
        const key = String(username || '').trim().toLowerCase();
        return clone(state.users.find((u) => String(u.username || '').toLowerCase() === key)) || null;
    }
    function getUser(id) { return clone(state.users.find((u) => String(u.id) === String(id))) || null; }
    function listUsers() {
        return state.users.slice().sort((a, b) => a.id - b.id).map(clone);
    }
    function createUser(data) { return insert('users', data); }
    function updateUser(id, patch) { return update('users', id, patch); }
    function countUsersByRole(role) {
        return state.users.filter((u) => u.role === role && u.is_active !== false).length;
    }

    /* ---------- 授權範圍 ---------- */
    function listGrants({ userId = null } = {}) {
        return state.grants
            .filter((g) => (userId === null || String(g.user_id) === String(userId)))
            .map(clone);
    }
    function createGrant(data) { return insert('grants', data); }
    function deleteGrant(id) { return remove('grants', id); }

    /* ---------- 稽核 ---------- */
    function insertAuditLog(row) {
        return insert('audit_logs', row);
    }
    /* 刪除單筆稽核紀錄（A-3 的保留期清理用；一般不會用到，所以單獨一支而不是通用的 remove） */
    function deleteAuditLog(id) {
        const before = state.audit_logs.length;
        state.audit_logs = state.audit_logs.filter((row) => String(row.id) !== String(id));
        if (state.audit_logs.length === before) return false;
        persist();
        return true;
    }

    function listAuditLogs(options = {}) {
        const filters = normalizeAuditFilters(options);
        const limit = options.limit || 50;
        const offset = options.offset || 0;
        const matched = state.audit_logs
            .filter((row) => matchesAuditFilters(row, filters))
            .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id));
        const page = matched.slice(offset, offset + limit).map(clone);
        return { items: page, total: matched.length, limit, offset, has_more: matched.length > offset + limit };
    }

    function tableCounts() {
        const counts = {};
        for (const name of ['books', 'units', 'entries', 'audio', 'users', 'grants', 'audit_logs']) {
            counts[name] = (state[name] || []).length;
        }
        return counts;
    }

    return {
        backend: 'json',
        dataFile,
        normalizeHeadword: require('./index').normalizeHeadword,
        listBooks, getBook, createBook, updateBook,
        listUnits, getUnit, findUnitByNo, createUnit, updateUnit,
        listEntries, getEntry, findEntryByHeadword, createEntry, updateEntry, deleteEntry, countEntries,
        listAudio, getAudio, getAudioData, createAudio, deleteAudio, findTeacherAudio,
        getBookCoverData,
        findUserByUsername, getUser, listUsers, createUser, updateUser, deleteUser, countUsersByRole,
        listGrants, createGrant, deleteGrant,
        insertAuditLog, listAuditLogs, deleteAuditLog,
        tableCounts,
        reload: () => { state = load(); },
        _raw: () => clone(state)
    };
}

module.exports = { createJsonStore, EMPTY };
