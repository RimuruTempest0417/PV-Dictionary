/* PV_Dictionary 伺服器（v0.0.1 Demo）
 *
 * 架構：Express 5 + 模組化 lib/（角色、認證、稽核、資料層）。
 * 前端一律走自家的 /api；資料庫金鑰只存在伺服器端，前端永不直連資料庫。
 *
 * 匯出：module.exports = app（Vercel 的 api/index.js 直接拿它當 handler）
 *       module.exports.createApp = createApp（測試用，可指定獨立的資料檔）
 */
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');

const { createStore, normalizeHeadword, DATA_BACKEND_LABEL } = require('./lib/store');
const Roles = require('./lib/roles');
const Auth = require('./lib/auth');
const { logAudit, AUDIT_ACTION_LABELS, actionLabel } = require('./lib/audit');
const { verifyPassword, hashPassword, needsPasswordUpgrade } = require('./lib/passwords');

const PACKAGE = require('./package.json');

/* ---------------- 常數 ---------------- */
/* 允許上傳的音檔格式。
 * ★ 注意 video/webm：Chrome 依副檔名推斷型別時會把 .webm 標成 video/webm
 *   （同一種容器，只是裡面是音軌），老師用錄音工具存出來的檔案就是這樣，
 *   擋掉它等於讓「上傳現成音檔」這條路走不通。
 * ★ 型別比較一律先去掉參數（例如 audio/webm;codecs=opus），否則瀏覽器多帶一段就對不上。 */
const AUDIO_MIME_WHITELIST = [
    'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/m4a',
    'audio/webm', 'video/webm', 'audio/wav', 'audio/x-wav', 'audio/ogg',
    'audio/opus', 'audio/aac'
];

function normalizeAudioMime(value) {
    return String(value || '').toLowerCase().split(';')[0].trim();
}
const AUDIO_MAX_BYTES = 1024 * 1024;          // 單筆錄音上限 1MB（Vercel body 上限約 4.5MB）
const AUDIO_MAX_DURATION_MS = 60 * 1000;

const LIMITS = {
    headword: 80,
    ipa: 80,
    pos: 40,
    zh: 300,
    en: 600,
    example: 600,
    title: 120,
    note: 240,
    display_name: 60,
    username: 32,
    book_name: 80,
    book_code: 20
};

const ENTRY_STATUSES = ['published', 'pending', 'draft', 'rejected'];
const PUBLISHED_ONLY = ['published'];

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

/* ---------------- 小工具 ---------------- */
function str(value, max) {
    if (value === null || value === undefined) return '';
    return String(value).trim().slice(0, max);
}

function num(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function boolish(value, fallback = true) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return !['0', 'false', 'no', ''].includes(String(value).toLowerCase());
}

/* 批次貼上的解析（純函式，module 層級 → 測試可以直接拿 __test__.parseImportText 驗）
 * 每行：生字 ⇥ 讀音 ⇥ 詞性 ⇥ 中文解釋 ⇥ 英文解釋
 * 也接受「兩個以上空白」或「逗號後接非空白」當分隔（老師從 Word／Excel 貼過來常見） */
function parseImportText(text) {
    const rows = [];
    const errors = [];
    const lines = String(text || '').split(/\r?\n/);
    lines.forEach((rawLine, index) => {
        const line = rawLine.trim();
        if (!line) return;
        const cells = line.split(/\t|,(?=\S)|\s{2,}/).map((c) => c.trim()).filter((c) => c !== '');
        if (cells.length < 2) {
            errors.push({ line: index + 1, reason: '欄位不足（至少要有生字與解釋，用 Tab 分隔）', text: line.slice(0, 80) });
            return;
        }
        const [headword, ipa, pos, zh, en] = cells;
        rows.push({
            headword: str(headword, LIMITS.headword),
            ipa_us: str(ipa || '', LIMITS.ipa),
            ipa_uk: '',
            part_of_speech: str(pos || '', LIMITS.pos),
            zh_meaning: str(zh || '', LIMITS.zh),
            en_definition: str(en || '', LIMITS.en),
            example_en: '',
            example_zh: '',
            line: index + 1
        });
    });
    return { rows, errors };
}

/* 生字列的對外格式：永遠不含音檔 base64（只在 GET /api/audio/:id 才給） */
function publicEntry(entry, store, { includeStatus = false } = {}) {
    const audio = store.findTeacherAudio(entry.id);
    const row = {
        id: entry.id,
        unit_id: entry.unit_id,
        headword: entry.headword,
        ipa_us: entry.ipa_us || '',
        ipa_uk: entry.ipa_uk || '',
        part_of_speech: entry.part_of_speech || '',
        zh_meaning: entry.zh_meaning || '',
        en_definition: entry.en_definition || '',
        example_en: entry.example_en || '',
        example_zh: entry.example_zh || '',
        sort_order: entry.sort_order || 0,
        has_audio: Boolean(audio),
        audio_id: audio ? audio.id : null,
        created_at: entry.created_at,
        updated_at: entry.updated_at || null
    };
    if (includeStatus) {
        row.status = entry.status;
        row.review_note = entry.review_note || '';
        row.reviewed_at = entry.reviewed_at || null;
        row.reviewed_by = entry.reviewed_by || null;
        // 待審核清單要顯示「由誰新增」，所以只有可編輯者才拿得到這幾個欄位
        row.created_by = entry.created_by || '';
        row.updated_by = entry.updated_by || '';
    }
    return row;
}

function publicUser(user) {
    return {
        id: user.id,
        username: user.username,
        display_name: user.display_name || '',
        role: user.role,
        role_label: Roles.roleLabel(user.role),
        is_active: user.is_active !== false,
        last_login_at: user.last_login_at || null,
        created_at: user.created_at || null
    };
}

/* ---------------- 應用程式工廠 ---------------- */
function createApp(options = {}) {
    const store = options.store || createStore({
        backend: options.backend,
        dataFile: options.dataFile
    });

    const app = express();
    app.disable('x-powered-by');
    app.use(Auth.securityHeaders);
    app.use(Auth.corsMiddleware);
    app.use(express.json({ limit: '4mb' }));

    /* ---- 登入失敗計數（行程內；Demo 單機足夠，正式上線再改資料庫） ---- */
    const ipFailures = new Map();
    const userFailures = new Map();

    function failureKey(map, key) {
        const now = Date.now();
        let row = map.get(key);
        if (!row || now - row.firstAt > LOGIN_WINDOW_MS) {
            row = { count: 0, firstAt: now, ips: new Set() };
            map.set(key, row);
        }
        return row;
    }

    function noteFailure(ip, username) {
        const byIp = failureKey(ipFailures, ip || 'unknown');
        byIp.count += 1;
        byIp.ips.add(ip || 'unknown');
        if (username) {
            const byUser = failureKey(userFailures, username.toLowerCase());
            byUser.count += 1;
            byUser.ips.add(ip || 'unknown');
        }
    }

    function clearFailures(ip, username) {
        ipFailures.delete(ip || 'unknown');
        if (username) userFailures.delete(username.toLowerCase());
    }

    /* 單一 IP 10 次即鎖 IP；帳號要 10 次且來自 ≥2 個 IP 才鎖（避免被人用來鎖死他人帳號） */
    function lockedReason(ip, username) {
        const now = Date.now();
        const byIp = ipFailures.get(ip || 'unknown');
        if (byIp && now - byIp.firstAt <= LOGIN_WINDOW_MS && byIp.count >= LOGIN_MAX_FAILURES) {
            return '來自這個網路的登入失敗次數過多，請 15 分鐘後再試';
        }
        if (username) {
            const byUser = userFailures.get(username.toLowerCase());
            if (byUser && now - byUser.firstAt <= LOGIN_WINDOW_MS
                && byUser.count >= LOGIN_MAX_FAILURES && byUser.ips.size >= 2) {
                return '這個帳號的登入失敗次數過多，請 15 分鐘後再試';
            }
        }
        return null;
    }

    /* ---- 來源檢查（帶著 cookie 的寫入請求必須來自自家網站） ---- */
    app.use('/api', (req, res, next) => {
        if (Auth.csrfViolation(req)) return res.status(403).json({ error: '來源不被允許' });
        return next();
    });

    /* ---- 身分：每次請求都用 sub 重新讀取角色（不信任權杖裡的任何授權資訊） ---- */
    app.use('/api', (req, res, next) => {
        req.user = null;
        const token = Auth.tokenFromRequest(req);
        if (token) {
            const payload = Auth.verifyToken(token);
            if (payload) {
                const user = store.getUser(payload.sub);
                if (user && user.is_active !== false) req.user = user;
            }
        }
        next();
    });

    function requireAuth(req, res, next) {
        if (!req.user) return res.status(401).json({ error: '請先登入' });
        return next();
    }

    function requireRole(minRole) {
        return (req, res, next) => {
            if (!req.user) return res.status(401).json({ error: '請先登入' });
            if (!Roles.atLeast(req.user.role, minRole)) {
                return res.status(403).json({ error: '權限不足' });
            }
            return next();
        };
    }

    const canSeeUnpublished = (req) => Boolean(req.user && Roles.atLeast(req.user.role, 'teacher'));
    const grants = () => store.listGrants({});

    /* ================= 公開：版本、健康檢查 ================= */
    app.get('/api/version', (req, res) => {
        res.json({ name: PACKAGE.name, version: PACKAGE.version });
    });

    app.get('/api/health', (req, res) => {
        res.json({
            version: PACKAGE.version,
            backend: store.backend,
            backend_label: DATA_BACKEND_LABEL[store.backend] || store.backend,
            data_file: store.backend === 'json' ? store.dataFile : null,
            schema_ready: true,
            jwt_secret_configured: Boolean(process.env.JWT_SECRET),
            counts: store.tableCounts()
        });
    });

    /* ================= 公開：書本／單元／生字 ================= */
    app.get('/api/books', (req, res) => {
        const includeHidden = canSeeUnpublished(req) && boolish(req.query.include_unpublished, false);
        const books = store.listBooks({ includeUnpublished: includeHidden }).map((book) => {
            const units = store.listUnits({ bookId: book.id, includeUnpublished: includeHidden });
            const counts = units.map((u) => store.countEntries(u.id, PUBLISHED_ONLY));
            return Object.assign({}, book, {
                unit_count: units.length,
                entry_count: counts.reduce((sum, n) => sum + n, 0),
                pending_count: units.reduce((sum, u) => sum + store.countEntries(u.id, ['pending']), 0)
            });
        });
        res.json({ books });
    });

    app.get('/api/books/:id/units', (req, res) => {
        const book = store.getBook(req.params.id);
        if (!book) return res.status(404).json({ error: '找不到這本書' });
        const includeHidden = canSeeUnpublished(req);
        const units = store.listUnits({ bookId: book.id, includeUnpublished: includeHidden }).map((unit) => ({
            id: unit.id,
            book_id: unit.book_id,
            unit_no: unit.unit_no,
            title: unit.title || '',
            is_published: unit.is_published !== false,
            entry_count: includeHidden
                ? store.countEntries(unit.id, null)
                : store.countEntries(unit.id, PUBLISHED_ONLY),
            published_count: store.countEntries(unit.id, PUBLISHED_ONLY),
            pending_count: includeHidden ? store.countEntries(unit.id, ['pending']) : 0
        }));
        res.json({ book, units });
    });

    app.get('/api/units/:id', (req, res) => {
        const unit = store.getUnit(req.params.id);
        if (!unit) return res.status(404).json({ error: '找不到這個單元' });
        const includeHidden = canSeeUnpublished(req);
        if (unit.is_published === false && !includeHidden) {
            return res.status(404).json({ error: '這個單元尚未發佈' });
        }
        const scoped = grants();
        const viewerCanEdit = Boolean(req.user && Roles.canEditUnit(req.user, unit, scoped));
        /* 誰看得到哪些狀態：
         *   老師以上（includeHidden）→ 全部
         *   科代表等可編輯者        → 已發佈 + 待審核（否則他們送出的字自己看不到，介面等於在騙人）
         *   其他人（含未登入）      → 只有已發佈 */
        const statuses = includeHidden ? null : (viewerCanEdit ? ['published', 'pending'] : PUBLISHED_ONLY);
        const book = store.getBook(unit.book_id);
        const entries = store.listEntries({ unitId: unit.id, statuses })
            .map((entry) => publicEntry(entry, store, { includeStatus: includeHidden || viewerCanEdit }));
        res.json({
            unit: {
                id: unit.id,
                book_id: unit.book_id,
                unit_no: unit.unit_no,
                title: unit.title || '',
                is_published: unit.is_published !== false,
                book_name: book ? book.name : ''
            },
            entries,
            can_edit: viewerCanEdit,
            can_publish: Boolean(req.user && Roles.canPublishUnit(req.user, unit, scoped)),
            can_review: Boolean(req.user && Roles.atLeast(req.user.role, 'teacher')),
            can_upload_audio: Boolean(req.user && Roles.canUploadAudio(req.user))
        });
    });

    app.get('/api/audio/:id', (req, res) => {
        const audio = store.getAudio(req.params.id);
        if (!audio) return res.status(404).json({ error: '找不到音檔' });
        res.setHeader('Content-Type', audio.mime || 'audio/mpeg');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.send(Buffer.from(audio.data, 'base64'));
    });

    /* ================= 認證 ================= */
    app.post('/api/auth/login', (req, res) => {
        const username = str(req.body && req.body.username, LIMITS.username);
        const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
        const ip = req.ip || 'unknown';
        if (!username || !password) return res.status(400).json({ error: '請輸入帳號與密碼' });

        const locked = lockedReason(ip, username);
        if (locked) return res.status(429).json({ error: locked });

        const user = store.findUserByUsername(username);
        if (!user || user.is_active === false || !verifyPassword(user.password_hash, password)) {
            noteFailure(ip, username);
            return res.status(401).json({ error: '帳號或密碼錯誤' });
        }

        // 舊格式（明碼）登入成功時順手升級成 scrypt
        if (needsPasswordUpgrade(user.password_hash)) {
            store.updateUser(user.id, { password_hash: hashPassword(password) });
        }
        store.updateUser(user.id, { last_login_at: new Date().toISOString() });
        clearFailures(ip, username);
        Auth.setAuthCookie(res, Auth.signToken(user));
        logAudit(store, { user, action: 'LOGIN', details: '登入成功', ip });
        const fresh = store.getUser(user.id);
        return res.json({ user: publicUser(fresh), token_type: 'cookie' });
    });

    app.post('/api/auth/logout', (req, res) => {
        Auth.clearAuthCookie(res);
        if (req.user) logAudit(store, { user: req.user, action: 'LOGOUT', details: '登出', ip: req.ip });
        return res.json({ ok: true });
    });

    app.get('/api/auth/me', (req, res) => {
        if (!req.user) return res.status(401).json({ error: '尚未登入' });
        const scoped = Roles.grantsFor(req.user, grants());
        return res.json({
            user: publicUser(req.user),
            permissions: {
                can_manage_users: Roles.canManageUsers(req.user),
                can_view_audit: Roles.canViewAudit(req.user),
                can_upload_audio: Roles.canUploadAudio(req.user),
                can_publish: Roles.atLeast(req.user.role, 'teacher'),
                can_edit: Roles.atLeast(req.user.role, 'class_rep')
            },
            grants: scoped
        });
    });

    /* ================= 生字：新增／修改／刪除 ================= */
    function resolveUnit(req, res) {
        const unit = store.getUnit(req.params.id || req.params.unitId);
        if (!unit) {
            res.status(404).json({ error: '找不到這個單元' });
            return null;
        }
        return unit;
    }

    function applyEntryInput(body) {
        return {
            headword: str(body.headword, LIMITS.headword),
            ipa_us: str(body.ipa_us, LIMITS.ipa),
            ipa_uk: str(body.ipa_uk, LIMITS.ipa),
            part_of_speech: str(body.part_of_speech, LIMITS.pos),
            zh_meaning: str(body.zh_meaning, LIMITS.zh),
            en_definition: str(body.en_definition, LIMITS.en),
            example_en: str(body.example_en, LIMITS.example),
            example_zh: str(body.example_zh, LIMITS.example)
        };
    }

    app.post('/api/units/:id/entries', requireAuth, (req, res) => {
        const unit = resolveUnit(req, res);
        if (!unit) return undefined;
        const scoped = grants();
        if (!Roles.canEditUnit(req.user, unit, scoped)) {
            return res.status(403).json({ error: '你沒有編輯這個單元的權限' });
        }
        const input = applyEntryInput(req.body || {});
        if (!input.headword) return res.status(400).json({ error: '請輸入生字' });
        if (!input.zh_meaning && !input.en_definition) {
            return res.status(400).json({ error: '中文解釋與英文解釋至少要填一個' });
        }
        const norm = normalizeHeadword(input.headword);
        const existing = store.findEntryByHeadword(unit.id, norm);
        if (existing) {
            return res.status(409).json({ error: `這個單元已經有「${existing.headword}」了`, entry_id: existing.id });
        }
        const status = Roles.needsReview(req.user, unit, scoped) ? 'pending' : 'published';
        const entry = store.createEntry(Object.assign({}, input, {
            unit_id: unit.id,
            headword_norm: norm,
            status,
            sort_order: store.listEntries({ unitId: unit.id }).length + 1,
            created_by: req.user.username,
            updated_by: req.user.username
        }));
        logAudit(store, {
            user: req.user,
            action: 'ENTRY_CREATE',
            targetId: entry.id,
            details: `${unit.title || `Unit ${unit.unit_no}`}：${entry.headword}${status === 'pending' ? '（待審核）' : ''}`,
            ip: req.ip
        });
        return res.status(201).json({ entry: publicEntry(entry, store, { includeStatus: true }), status });
    });

    app.patch('/api/entries/:id', requireAuth, (req, res) => {
        const entry = store.getEntry(req.params.id);
        if (!entry) return res.status(404).json({ error: '找不到這個生字' });
        const unit = store.getUnit(entry.unit_id);
        const scoped = grants();
        if (!Roles.canEditUnit(req.user, unit, scoped)) {
            return res.status(403).json({ error: '你沒有編輯這個單元的權限' });
        }
        if (entry.status === 'published' && !Roles.canPublishUnit(req.user, unit, scoped)) {
            return res.status(403).json({ error: '已發佈的生字需要老師以上才能修改' });
        }
        const body = req.body || {};
        const patch = applyEntryInput(Object.assign({}, entry, body));
        if (!patch.headword) return res.status(400).json({ error: '請輸入生字' });
        const norm = normalizeHeadword(patch.headword);
        const clash = store.findEntryByHeadword(unit.id, norm);
        if (clash && String(clash.id) !== String(entry.id)) {
            return res.status(409).json({ error: `這個單元已經有「${clash.headword}」了` });
        }
        const updated = store.updateEntry(entry.id, Object.assign({}, patch, {
            headword_norm: norm,
            updated_by: req.user.username,
            // 老師改了科代表待審核的內容 → 內容已被人看過，退回待審核狀態
            status: entry.status === 'pending' ? 'pending' : entry.status
        }));
        logAudit(store, {
            user: req.user,
            action: 'ENTRY_UPDATE',
            targetId: updated.id,
            details: `${unit ? (unit.title || `Unit ${unit.unit_no}`) : ''}：${updated.headword}`,
            ip: req.ip
        });
        return res.json({ entry: publicEntry(updated, store, { includeStatus: true }) });
    });

    app.delete('/api/entries/:id', requireAuth, (req, res) => {
        const entry = store.getEntry(req.params.id);
        if (!entry) return res.status(404).json({ error: '找不到這個生字' });
        const unit = store.getUnit(entry.unit_id);
        const scoped = grants();
        if (!Roles.canEditUnit(req.user, unit, scoped)) {
            return res.status(403).json({ error: '你沒有編輯這個單元的權限' });
        }
        if (entry.status === 'published' && !Roles.canPublishUnit(req.user, unit, scoped)) {
            return res.status(403).json({ error: '已發佈的生字需要老師以上才能刪除' });
        }
        store.deleteEntry(entry.id);
        logAudit(store, {
            user: req.user,
            action: 'ENTRY_DELETE',
            targetId: entry.id,
            details: `${unit ? (unit.title || `Unit ${unit.unit_no}`) : ''}：${entry.headword}`,
            ip: req.ip
        });
        return res.json({ ok: true, id: entry.id });
    });

    /* ================= 生字：審核（老師以上） ================= */
    app.post('/api/entries/:id/review', requireRole('teacher'), (req, res) => {
        const entry = store.getEntry(req.params.id);
        if (!entry) return res.status(404).json({ error: '找不到這個生字' });
        if (entry.status !== 'pending') {
            return res.status(400).json({ error: '這個生字不是待審核狀態' });
        }
        const action = str(req.body && req.body.action, 20);
        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ error: 'action 必須是 approve 或 reject' });
        }
        const note = str(req.body && req.body.note, LIMITS.note);
        const updated = store.updateEntry(entry.id, {
            status: action === 'approve' ? 'published' : 'rejected',
            review_note: note,
            reviewed_by: req.user.username,
            reviewed_at: new Date().toISOString(),
            updated_by: req.user.username
        });
        logAudit(store, {
            user: req.user,
            action: action === 'approve' ? 'ENTRY_APPROVE' : 'ENTRY_REJECT',
            targetId: updated.id,
            details: `${updated.headword}${note ? `（${note}）` : ''}`,
            ip: req.ip
        });
        return res.json({ entry: publicEntry(updated, store, { includeStatus: true }) });
    });

    /* ================= 生字：批次貼上匯入 ================= */

    app.post('/api/units/:id/entries/import', requireAuth, (req, res) => {
        const unit = resolveUnit(req, res);
        if (!unit) return undefined;
        const scoped = grants();
        if (!Roles.canEditUnit(req.user, unit, scoped)) {
            return res.status(403).json({ error: '你沒有編輯這個單元的權限' });
        }
        const parsed = parseImportText(req.body && req.body.text);
        if (parsed.rows.length === 0) {
            return res.status(400).json({ error: '沒有可以匯入的內容', errors: parsed.errors });
        }
        const status = Roles.needsReview(req.user, unit, scoped) ? 'pending' : 'published';
        const created = [];
        const skipped = [];
        let order = store.listEntries({ unitId: unit.id }).length;
        for (const row of parsed.rows) {
            const norm = normalizeHeadword(row.headword);
            if (!row.headword) {
                skipped.push({ headword: row.headword, reason: '生字空白', line: row.line });
                continue;
            }
            const existing = store.findEntryByHeadword(unit.id, norm);
            if (existing) {
                skipped.push({ headword: row.headword, reason: '這個單元已經有這個生字', line: row.line });
                continue;
            }
            order += 1;
            created.push(store.createEntry(Object.assign({}, row, {
                unit_id: unit.id,
                headword_norm: norm,
                status,
                sort_order: order,
                created_by: req.user.username,
                updated_by: req.user.username
            })));
        }
        if (created.length) {
            logAudit(store, {
                user: req.user,
                action: 'ENTRY_IMPORT',
                targetId: unit.id,
                details: `${unit.title || `Unit ${unit.unit_no}`}：新增 ${created.length} 筆、略過 ${skipped.length} 筆${status === 'pending' ? '（待審核）' : ''}`,
                ip: req.ip
            });
        }
        return res.json({
            created: created.length,
            skipped: skipped.length,
            status,
            entries: created.map((e) => publicEntry(e, store, { includeStatus: true })),
            skipped_detail: skipped,
            errors: parsed.errors
        });
    });

    /* ================= 老師錄音 ================= */
    app.post('/api/entries/:id/audio', requireRole('teacher'), (req, res) => {
        const entry = store.getEntry(req.params.id);
        if (!entry) return res.status(404).json({ error: '找不到這個生字' });
        const body = req.body || {};
        const raw = String(body.data || '');
        /* 接受三種寫法：純 base64、data:audio/webm;base64,…、
         * （Chrome 的 MediaRecorder 常見）data:audio/webm;codecs=opus;base64,…
         * ★ 用 [^;,] 抓型別、[^,]* 吃掉中間的參數，否則帶 codecs 的資料 URL 會完全對不上。 */
        const match = /^data:([^;,]+)[^,]*;base64,([\s\S]*)$/.exec(raw);
        const mime = normalizeAudioMime((match ? match[1] : body.mime) || '');
        const base64 = match ? match[2] : raw;
        if (!AUDIO_MIME_WHITELIST.includes(mime)) {
            return res.status(400).json({
                error: `不接受的音檔格式（${mime || '未知'}）`,
                allowed: AUDIO_MIME_WHITELIST
            });
        }
        if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) {
            return res.status(400).json({ error: '音檔內容不是合法的 base64' });
        }
        const bytes = Buffer.from(base64, 'base64');
        if (bytes.length === 0) return res.status(400).json({ error: '音檔是空的' });
        if (bytes.length > AUDIO_MAX_BYTES) {
            return res.status(413).json({ error: `錄音檔太大（${Math.round(bytes.length / 1024)}KB），上限 1MB` });
        }
        const duration = num(body.duration_ms, 0);
        if (duration > AUDIO_MAX_DURATION_MS) {
            return res.status(400).json({ error: '錄音太長（上限 60 秒）' });
        }
        // 一個生字只保留一段老師錄音：換新的就把舊的刪掉
        const old = store.findTeacherAudio(entry.id);
        if (old) store.deleteAudio(old.id);
        const audio = store.createAudio({
            entry_id: entry.id,
            source: 'teacher',
            accent: str(body.accent, 10) || 'en-GB',
            mime,
            bytes: bytes.length,
            duration_ms: duration,
            data: base64.replace(/\s+/g, ''),
            uploaded_by: req.user.username
        });
        logAudit(store, {
            user: req.user,
            action: 'AUDIO_UPLOAD',
            targetId: entry.id,
            details: `${entry.headword}（${Math.round(bytes.length / 1024)}KB${old ? '，已取代舊錄音' : ''}）`,
            ip: req.ip
        });
        return res.status(201).json({
            ok: true,
            audio: { id: audio.id, mime: audio.mime, bytes: audio.bytes, duration_ms: audio.duration_ms }
        });
    });

    app.delete('/api/audio/:id', requireRole('teacher'), (req, res) => {
        const audio = store.getAudio(req.params.id);
        if (!audio) return res.status(404).json({ error: '找不到音檔' });
        const entry = store.getEntry(audio.entry_id);
        store.deleteAudio(audio.id);
        logAudit(store, {
            user: req.user,
            action: 'AUDIO_DELETE',
            targetId: audio.entry_id,
            details: entry ? entry.headword : `音檔 #${audio.id}`,
            ip: req.ip
        });
        return res.json({ ok: true });
    });

    /* ================= 書本／單元維護（老師以上） ================= */
    app.post('/api/books', requireRole('teacher'), (req, res) => {
        const body = req.body || {};
        const name = str(body.name, LIMITS.book_name);
        const code = str(body.code, LIMITS.book_code) || name;
        if (!name) return res.status(400).json({ error: '請輸入書本名稱' });
        if (store.listBooks({ includeUnpublished: true }).some((b) => b.code === code)) {
            return res.status(409).json({ error: `代號「${code}」已經有人用了` });
        }
        const book = store.createBook({
            code,
            name,
            grade: str(body.grade, 20),
            publisher: str(body.publisher, 60),
            sort_order: num(body.sort_order, store.listBooks({ includeUnpublished: true }).length + 1),
            is_published: boolish(body.is_published, true)
        });
        logAudit(store, { user: req.user, action: 'BOOK_CREATE', targetId: book.id, details: book.name, ip: req.ip });
        return res.status(201).json({ book });
    });

    app.patch('/api/books/:id', requireRole('teacher'), (req, res) => {
        const book = store.getBook(req.params.id);
        if (!book) return res.status(404).json({ error: '找不到這本書' });
        const body = req.body || {};
        const patch = {};
        if (body.name !== undefined) patch.name = str(body.name, LIMITS.book_name) || book.name;
        if (body.grade !== undefined) patch.grade = str(body.grade, 20);
        if (body.publisher !== undefined) patch.publisher = str(body.publisher, 60);
        if (body.sort_order !== undefined) patch.sort_order = num(body.sort_order, book.sort_order);
        if (body.is_published !== undefined) patch.is_published = boolish(body.is_published, true);
        const updated = store.updateBook(book.id, patch);
        logAudit(store, { user: req.user, action: 'BOOK_UPDATE', targetId: book.id, details: updated.name, ip: req.ip });
        return res.json({ book: updated });
    });

    app.post('/api/books/:id/units', requireRole('teacher'), (req, res) => {
        const book = store.getBook(req.params.id);
        if (!book) return res.status(404).json({ error: '找不到這本書' });
        const body = req.body || {};
        const unitNo = Number(body.unit_no);
        if (!Number.isFinite(unitNo) || unitNo < 1 || unitNo > 99) {
            return res.status(400).json({ error: '單元編號必須是 1–99 的數字' });
        }
        if (store.findUnitByNo(book.id, unitNo)) {
            return res.status(409).json({ error: `${book.name} 已經有 Unit ${unitNo} 了` });
        }
        const unit = store.createUnit({
            book_id: book.id,
            unit_no: unitNo,
            title: str(body.title, LIMITS.title),
            sort_order: num(body.sort_order, unitNo),
            is_published: boolish(body.is_published, true)
        });
        logAudit(store, {
            user: req.user,
            action: 'UNIT_CREATE',
            targetId: unit.id,
            details: `${book.name} Unit ${unitNo}${unit.title ? ` ${unit.title}` : ''}`,
            ip: req.ip
        });
        return res.status(201).json({ unit });
    });

    app.patch('/api/units/:id', requireRole('teacher'), (req, res) => {
        const unit = store.getUnit(req.params.id);
        if (!unit) return res.status(404).json({ error: '找不到這個單元' });
        const body = req.body || {};
        const patch = {};
        if (body.title !== undefined) patch.title = str(body.title, LIMITS.title);
        if (body.unit_no !== undefined) patch.unit_no = num(body.unit_no, unit.unit_no);
        if (body.sort_order !== undefined) patch.sort_order = num(body.sort_order, unit.sort_order);
        if (body.is_published !== undefined) patch.is_published = boolish(body.is_published, true);
        const updated = store.updateUnit(unit.id, patch);
        logAudit(store, { user: req.user, action: 'UNIT_UPDATE', targetId: unit.id, details: `Unit ${updated.unit_no}`, ip: req.ip });
        return res.json({ unit: updated });
    });

    function setUnitPublished(req, res, published) {
        const unit = store.getUnit(req.params.id);
        if (!unit) return res.status(404).json({ error: '找不到這個單元' });
        const updated = store.updateUnit(unit.id, { is_published: published });
        logAudit(store, {
            user: req.user,
            action: published ? 'UNIT_PUBLISH' : 'UNIT_UNPUBLISH',
            targetId: unit.id,
            details: `Unit ${unit.unit_no}${unit.title ? ` ${unit.title}` : ''}`,
            ip: req.ip
        });
        return res.json({ unit: updated });
    }

    app.post('/api/units/:id/publish', requireRole('teacher'), (req, res) => setUnitPublished(req, res, true));
    app.post('/api/units/:id/unpublish', requireRole('teacher'), (req, res) => setUnitPublished(req, res, false));

    /* ================= 管理：使用者、授權、稽核 ================= */
    app.get('/api/admin/users', requireRole('admin'), (req, res) => {
        const users = store.listUsers().map((user) => Object.assign(publicUser(user), {
            can_manage: Roles.canManageUser(req.user, user),
            is_self: String(user.id) === String(req.user.id)
        }));
        res.json({
            users,
            assignable_roles: Roles.ASSIGNABLE_ROLES.map((role) => ({ value: role, label: Roles.roleLabel(role) })),
            role_levels: Roles.ROLE_LEVELS
        });
    });

    app.post('/api/admin/users', requireRole('admin'), (req, res) => {
        const body = req.body || {};
        const username = str(body.username, LIMITS.username);
        const password = typeof body.password === 'string' ? body.password : '';
        const role = str(body.role, 20) || 'student';
        if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) {
            return res.status(400).json({ error: '帳號只能是 3–32 個英文字母、數字或底線' });
        }
        if (password.length < 6 || password.length > 64) {
            return res.status(400).json({ error: '密碼長度必須是 6–64 個字元' });
        }
        if (!Roles.canCreateRole(req.user, role)) {
            return res.status(403).json({ error: '你不能建立這個角色' });
        }
        if (store.findUserByUsername(username)) {
            return res.status(409).json({ error: '這個帳號已經存在' });
        }
        const user = store.createUser({
            username,
            display_name: str(body.display_name, LIMITS.display_name) || username,
            password_hash: hashPassword(password),
            role,
            is_active: boolish(body.is_active, true)
        });
        logAudit(store, { user: req.user, action: 'USER_CREATE', targetId: user.id, details: `${username}（${Roles.roleLabel(role)}）`, ip: req.ip });
        return res.status(201).json({ user: publicUser(user) });
    });

    app.patch('/api/admin/users/:id', requireRole('admin'), (req, res) => {
        const target = store.getUser(req.params.id);
        if (!target) return res.status(404).json({ error: '找不到這個使用者' });
        if (!Roles.canManageUser(req.user, target)) {
            return res.status(403).json({ error: '你不能管理這個使用者' });
        }
        const body = req.body || {};
        const patch = {};
        if (body.display_name !== undefined) patch.display_name = str(body.display_name, LIMITS.display_name);
        if (body.is_active !== undefined) {
            const next = boolish(body.is_active, true);
            if (!next && store.countUsersByRole('web_manager') <= (target.role === 'web_manager' ? 1 : 0)) {
                return res.status(400).json({ error: '至少要保留一位網站管理員' });
            }
            patch.is_active = next;
        }
        if (body.password !== undefined) {
            const password = String(body.password);
            if (password.length < 6 || password.length > 64) {
                return res.status(400).json({ error: '密碼長度必須是 6–64 個字元' });
            }
            patch.password_hash = hashPassword(password);
        }
        if (body.role !== undefined) {
            if (!Roles.canCreateRole(req.user, body.role)) {
                return res.status(403).json({ error: '你不能指派這個角色' });
            }
            patch.role = body.role;
        }
        const updated = store.updateUser(target.id, patch);
        logAudit(store, {
            user: req.user,
            action: 'USER_UPDATE',
            targetId: target.id,
            details: `${target.username}：${Object.keys(patch).map((k) => ({ display_name: '顯示名稱', is_active: '啟用狀態', password_hash: '密碼', role: '角色' }[k])).join('、')}`,
            ip: req.ip
        });
        return res.json({ user: publicUser(updated) });
    });

    app.get('/api/admin/grants', requireRole('admin'), (req, res) => {
        const users = store.listUsers();
        const rows = store.listGrants({}).map((grant) => {
            const user = users.find((u) => String(u.id) === String(grant.user_id));
            const book = grant.book_id ? store.getBook(grant.book_id) : null;
            const unit = grant.unit_id ? store.getUnit(grant.unit_id) : null;
            return Object.assign({}, grant, {
                username: user ? user.username : '(已刪除)',
                book_name: book ? book.name : '',
                unit_label: unit ? `Unit ${unit.unit_no}${unit.title ? ` ${unit.title}` : ''}` : ''
            });
        });
        return res.json({ grants: rows });
    });

    app.post('/api/admin/grants', requireRole('admin'), (req, res) => {
        const body = req.body || {};
        const user = store.getUser(body.user_id);
        if (!user) return res.status(404).json({ error: '找不到這個使用者' });
        const bookId = body.book_id === undefined || body.book_id === null || body.book_id === '' ? null : Number(body.book_id);
        const unitId = body.unit_id === undefined || body.unit_id === null || body.unit_id === '' ? null : Number(body.unit_id);
        if ((bookId && !store.getBook(bookId)) || (unitId && !store.getUnit(unitId))) {
            return res.status(400).json({ error: '書本或單元不存在' });
        }
        if (!bookId && !unitId) return res.status(400).json({ error: '請指定書本或單元' });
        const grant = store.createGrant({
            user_id: user.id,
            book_id: bookId,
            unit_id: unitId,
            can_edit: boolish(body.can_edit, true),
            can_publish: boolish(body.can_publish, false),
            granted_by: req.user.username
        });
        logAudit(store, {
            user: req.user,
            action: 'USER_UPDATE',
            targetId: user.id,
            details: `授權 ${user.username} 編輯 ${unitId ? `單元 #${unitId}` : `書本 #${bookId}`}`,
            ip: req.ip
        });
        return res.status(201).json({ grant });
    });

    app.delete('/api/admin/grants/:id', requireRole('admin'), (req, res) => {
        const ok = store.deleteGrant(req.params.id);
        if (!ok) return res.status(404).json({ error: '找不到這筆授權' });
        return res.json({ ok: true });
    });

    app.get('/api/admin/audit-logs', requireRole('admin'), (req, res) => {
        const limit = Math.min(200, Math.max(1, num(req.query.limit, 50)));
        const offset = Math.max(0, num(req.query.offset, 0));
        const result = store.listAuditLogs({ limit, offset, q: str(req.query.q, 80) });
        res.json({
            logs: result.items.map((row) => Object.assign({}, row, { action_label: actionLabel(row.action) })),
            total: result.total,
            limit,
            offset,
            has_more: result.has_more,
            actions: Object.keys(AUDIT_ACTION_LABELS).map((action) => ({ value: action, label: AUDIT_ACTION_LABELS[action] }))
        });
    });

    /* ================= 靜態檔與錯誤處理 ================= */
    app.use(express.static(path.join(__dirname, 'public'), {
        index: 'index.html',
        etag: true,
        setHeaders(res, filePath) {
            if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
    }));

    app.use('/api', (req, res) => {
        res.status(404).json({ error: `沒有這個 API：${req.method} ${req.path}` });
    });

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
            return res.status(400).json({ error: '送出的資料不是合法的 JSON' });
        }
        if (err && err.type === 'entity.too.large') {
            return res.status(413).json({ error: '送出的內容太大' });
        }
        console.error('[pv-dictionary] 未預期錯誤：', err);
        return res.status(500).json({ error: '伺服器發生錯誤' });
    });

    app.locals.store = store;
    return app;
}

const app = createApp();
module.exports = app;
module.exports.createApp = createApp;
module.exports.__test__ = {
    parseImportText,
    AUDIO_MIME_WHITELIST,
    AUDIO_MAX_BYTES,
    LIMITS,
    AUDIT_ACTION_LABELS
};

/* 直接執行（node server.js）才監聽；被 require（Vercel／測試）時不佔用連接埠 */
if (require.main === module) {
    const port = Number(process.env.PORT || 3000);
    const dataFile = process.env.DATA_FILE || 'data/store.json';
    if (!fs.existsSync(path.resolve(dataFile))) {
        console.warn(`⚠️  找不到資料檔 ${dataFile}，請先執行：npm run seed`);
    }
    app.listen(port, () => {
        console.log(`PV_Dictionary v${PACKAGE.version} 已啟動：http://localhost:${port}`);
        console.log(`資料來源：${process.env.DATA_BACKEND || 'json'} → ${path.resolve(dataFile)}`);
    });
}
