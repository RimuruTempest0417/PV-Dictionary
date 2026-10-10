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
const Capabilities = require('./lib/capabilities');
const Auth = require('./lib/auth');
const { logAudit, AUDIT_ACTION_LABELS, actionLabel, normalizeAuditFilters, toCsv } = require('./lib/audit');
const { msg } = require('./lib/messages');
const { createErrorLog } = require('./lib/errorlog');
const { createThrottle } = require('./lib/throttle');
const SelfTest = require('./lib/selftest');
const RequestContext = require('./lib/requestcontext');
const { verifyPassword, hashPassword, needsPasswordUpgrade, passwordProblem, generateTempPassword, PASSWORD_MIN } = require('./lib/passwords');
const Totp = require('./lib/totp');

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
/* D-3（v0.6.0）：每個單元的錄音段數上限。
 * 為什麼要有：錄音以 base64 存在資料庫（免費方案 500MB），一個單元幾十段就是幾十 MB；
 * 沒有上限時「某個單元被錄滿」只會表現在月底的容量爆掉，老師卻完全看不到原因。
 * 這裡選擇「維持存在資料庫」（不導入 Storage，避免為了容量付費升級），
 * 但把上限與用量明確顯示給老師看（錄音視窗與單元統計）。 */
const AUDIO_MAX_PER_UNIT = 60;
/* D-6（v0.7.0）：容量與警告門檻的**唯一來源**在 lib/limits.js（server 與腳本共用同一組數字）。 */
const { usageState } = require('./lib/limits');

/* D-1（v0.6.0）：生字表的伺服器端分頁。
 * 為什麼：一個單元有幾百個生字時，整包一次送出去會讓手機忙很久（而且大部分用不到）。
 * 一頁 60 筆（手機一屏約 5～8 張卡，60 筆足夠捲很久），上限 200 筆避免有人自己放大。 */
const ENTRY_PAGE_SIZE = 60;
/* 生字的三種狀態（搜尋參數 status= 只認這三個） */
const ENTRY_PAGE_MAX = 200;

/* 生字搜尋：一個字串比對生字、中文解釋、英文解釋與詞性（全部轉小寫） */
function matchesEntryQuery(entry, query) {
    if (!query) return true;
    const haystack = [entry.headword, entry.zh_meaning, entry.en_definition, entry.part_of_speech, entry.ipa_us]
        .map((value) => String(value || '').toLowerCase())
        .join(' ');
    return haystack.includes(query);
}

/* 書本封面（老師用手機拍封面後上傳）：只收圖片，2MB 以內 */
const COVER_MIME_WHITELIST = ['image/jpeg', 'image/png', 'image/webp'];
const COVER_MAX_BYTES = 2 * 1024 * 1024;

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

/* D-2（樂觀鎖）：前端送出它「讀到的那一筆」的 updated_at。
 * 沒帶（舊前端、腳本）→ 不檢查（維持原本行為）；帶了又不一樣 → 代表別人先改過，
 * 這時寧可回 409 請他重新載入，也不要無聲蓋掉別人的修改。 */
function staleWrite(current, body) {
    const provided = body && (body.version || body.base_updated_at);
    if (!provided || !current || !current.updated_at) return null;
    return String(provided) === String(current.updated_at) ? null : current.updated_at;
}

function boolish(value, fallback = true) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return !['0', 'false', 'no', ''].includes(String(value).toLowerCase());
}

/* 批次貼上的解析（純函式，module 層級 → 測試可以直接拿 __test__.parseImportText 驗）
 * 每行：生字 ⇥ 讀音 ⇥ 詞性 ⇥ 中文解釋 ⇥ 英文解釋
 * 也接受「兩個以上空白」或「逗號後接非空白」當分隔（老師從 Word／Excel 貼過來常見） */
/* 前端解析好的列（CSV／.xlsx）：每一筆是 {headword, ipa_us, part_of_speech, zh_meaning, en_definition, example_en, example_zh} */
function parseImportRows(input) {
    const rows = [];
    for (const raw of input.slice(0, 500)) {
        if (!raw || typeof raw !== 'object') continue;
        const headword = str(raw.headword, LIMITS.headword);
        if (!headword) continue;
        rows.push({
            headword,
            ipa_us: str(raw.ipa_us, LIMITS.ipa),
            ipa_uk: str(raw.ipa_uk, LIMITS.ipa),
            part_of_speech: str(raw.part_of_speech, LIMITS.pos),
            zh_meaning: str(raw.zh_meaning, LIMITS.zh),
            en_definition: str(raw.en_definition, LIMITS.en),
            example_en: str(raw.example_en, LIMITS.en),
            example_zh: str(raw.example_zh, LIMITS.zh),
            line: Number(raw.line) || rows.length + 2
        });
    }
    return rows;
}

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

/* 單元的對外格式（複製／排序／我的單元都用這一個，欄位才不會各寫一份） */
function unitView(unit, store, { includeHidden = true } = {}) {
    return {
        id: unit.id,
        book_id: unit.book_id,
        unit_no: unit.unit_no,
        title: unit.title || '',
        is_published: unit.is_published !== false,
        updated_at: unit.updated_at || null,
        /* D-3：這個單元已有幾段老師錄音（上限見 AUDIO_MAX_PER_UNIT） */
        audio_count: store.listEntries({ unitId: unit.id }).filter((e) => store.findTeacherAudio(e.id)).length,
        audio_limit: AUDIO_MAX_PER_UNIT,
        entry_count: store.countEntries(unit.id, includeHidden ? null : PUBLISHED_ONLY),
        published_count: store.countEntries(unit.id, PUBLISHED_ONLY),
        pending_count: includeHidden ? store.countEntries(unit.id, ['pending']) : 0
    };
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
        created_at: user.created_at || null,
        /* 只回「有沒有開兩步驟驗證」，永遠不回密鑰或備援碼 */
        two_factor: Boolean(user.totp_secret && user.totp_enabled_at)
    };
}

/* ---------------- 應用程式工廠 ---------------- */
function createApp(options = {}) {
    const store = options.store || createStore({
        backend: options.backend,
        dataFile: options.dataFile,
        /* 讓測試可以指定假 Supabase（沒帶就會落到 .env 的真實專案 —— 測試會變成打正式環境） */
        url: options.url,
        key: options.key
    });

    /* 錯誤日誌（A-5）：獨立於 7 張表之外，不進 hydrate 快取（它會一直長大，見 lib/errorlog.js） */
    const errorLog = options.errorLog || createErrorLog({
        backend: options.backend,
        url: options.url,
        key: options.key,
        dataDir: options.dataFile ? path.dirname(options.dataFile) : undefined
    });
    /* 公開寫入端點的節流（A-4）：記憶體計數，只用於「未登入也能寫」的端點 */
    const throttle = createThrottle();

    const app = express();
    app.disable('x-powered-by');
    app.use(Auth.securityHeaders);
    app.use(Auth.corsMiddleware);
    app.use(express.json({ limit: '4mb' }));

    /* 自動化檢查的簽章標頭（E-4）：整條請求鏈都在這個上下文裡，
     * 稽核紀錄與錯誤日誌才知道要標成 is_self_test（預設檢視會濾掉）。
     * 驗簽失敗＝當成真人操作，絕不因此放行任何權限。 */
    app.use((req, res, next) => {
        let secret = '';
        try { secret = Auth.resolveJwtSecret(); } catch (err) { secret = ''; }
        const isSelfTest = secret ? SelfTest.verifyRequest(secret, req) : false;
        RequestContext.run({ isSelfTest }, next);
    });

    /* 寫一筆錯誤日誌（永遠不影響主要流程：失敗只印在伺服器日誌） */
    function writeErrorLog(entry, req) {
        const payload = Object.assign({
            source: 'server',
            version: PACKAGE.version,
            is_self_test: RequestContext.isSelfTest(),
            user_id: req && req.user ? req.user.id : null,
            display_name: req && req.user ? (req.user.display_name || '') : '',
            user_agent: req ? String(req.headers['user-agent'] || '') : ''
        }, entry || {});
        try {
            const result = errorLog.append(payload);
            if (result && typeof result.catch === 'function') {
                result.catch((err) => console.error('[errorlog] 寫入失敗：', err.message));
            }
        } catch (err) {
            console.error('[errorlog] 寫入失敗：', err.message);
        }
    }

    /* Supabase 版資料層：每個 /api 請求先 hydrate（抓下 7 張表）、回應送出「之前」flush（寫回異動）。
     * 為什麼要這樣做，見 lib/store/supabase.js 開頭的說明；json 版沒有 hydrate()，直接放行。 */
    if (typeof store.hydrate === 'function') {
        /* 不需要資料庫的路由直接放行（例如 /api/version）：這支原本也要等 7 個查詢才回，
         * 一次 2～5 秒。注意：app.use('/api') 裡的 req.path 是相對於掛載點的路徑（沒有 /api 前綴），
         * 所以拿 originalUrl 來比對才不會判斷錯。 */
        const DB_FREE = /^\/(api\/version|api\/logs\/error|api\/admin\/error-logs)\/?$/;
        app.use('/api', async (req, res, next) => {
            if (DB_FREE.test(String(req.originalUrl || '').split('?')[0])) return next();
            /* v0.6.1（D-1b）：視窗化資料層。
             *   hydrate() 只抓小表（books／units／users／grants）；
             *   prefetch() 依「這一條路由會用到什麼」抓生字／音檔／稽核的切片。
             *   沒有被 prefetch 到的範圍，存取時會直接拋 STORE_WINDOW_MISSING（大聲失敗，不靜默回空）。 */
            const storeContext = typeof store.attach === 'function' ? store.attach() : null;
            try {
                await store.hydrate({ full: !storeContext });
            } catch (err) {
                console.error('[store] 讀取 Supabase 失敗：', err.message);
                writeErrorLog({ source: 'server', code: 'DB_UNAVAILABLE', message: err.message, path: String(req.originalUrl || '').split('?')[0] }, req);
                return res.status(503).json({
                    error: msg('DB_UNAVAILABLE', { message: err.message }),
                    code: 'DB_UNAVAILABLE',
                    details: { message: err.message }
                });
            }
            if (storeContext) {
                try {
                    /* ★ 一定要在 runWithContext 裡面跑：prefetch 是往「這個請求的視窗」丟資料，
                     *   跑在外面會拿不到視窗（win() 是 null）→ 視窗永遠空的 → 路由存取時全部拋錯。 */
                    await store.runWithContext(storeContext, async () => {
                        await store.prefetch({
                            method: req.method,
                            path: String(req.path || ''),
                            query: req.query || {},
                            body: req.body || {}
                        });
                    });
                } catch (err) {
                    console.error('[store] prefetch 失敗：', err.message);
                    writeErrorLog({ source: 'server', code: 'DB_WINDOW_FAILED', message: err.message, path: String(req.originalUrl || '').split('?')[0] }, req);
                    return res.status(503).json({
                        error: msg('DB_UNAVAILABLE', { message: err.message }),
                        code: 'DB_UNAVAILABLE',
                        details: { message: err.message }
                    });
                }
            }
            const originalJson = res.json.bind(res);
            res.json = (body) => {
                store.flush()
                    .then(() => originalJson(body))
                    .catch((err) => {
                        /* 寫回失敗不能假裝成功：改成 500 並說明，讓使用者知道要重做一次 */
                        console.error('[store] 寫回 Supabase 失敗：', err.message);
                        if (res.headersSent) return res;
                        res.status(500);
                        return originalJson({
                            error: msg('DB_WRITE_FAILED', { message: err.message }),
                            code: 'DB_WRITE_FAILED',
                            details: { message: err.message }
                        });
                    });
                return res;
            };
            /* ★ 後續（同步的）路由一定要在同一個請求上下文裡跑，才讀得到剛才抓的視窗 */
            if (storeContext) return store.runWithContext(storeContext, next);
            return next();
        });
    }

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
            return 'LOGIN_LOCKED_IP';
        }
        if (username) {
            const byUser = userFailures.get(username.toLowerCase());
            if (byUser && now - byUser.firstAt <= LOGIN_WINDOW_MS
                && byUser.count >= LOGIN_MAX_FAILURES && byUser.ips.size >= 2) {
                return 'LOGIN_LOCKED_USER';
            }
        }
        return null;
    }

    /* ---- 來源檢查（帶著 cookie 的寫入請求必須來自自家網站） ---- */
    app.use('/api', (req, res, next) => {
        if (Auth.csrfViolation(req)) return res.status(403).json({ error: msg('ORIGIN_NOT_ALLOWED'), code: 'ORIGIN_NOT_ALLOWED' });
        return next();
    });

    /* ---- 身分：每次請求都用 sub 重新讀取角色（不信任權杖裡的任何授權資訊） ---- */
    app.use('/api', (req, res, next) => {
        req.user = null;
        const token = Auth.tokenFromRequest(req);
        if (token) {
            const payload = Auth.verifyToken(token);
            /* ★ 兩種權杖一律當成未登入：
             *   1. stage 存在 → 那是登入流程中間的權杖（兩步驟驗證第一步），不是登入憑證
             *   2. ver 與使用者目前的 token_version 不符 → 改過密碼／被強制登出，舊權杖失效 */
            if (payload && !payload.stage) {
                const user = store.getUser(payload.sub);
                const versionOk = Number(payload.ver || 1) === Number(user ? (user.token_version || 1) : 0);
                if (user && user.is_active !== false && versionOk) req.user = user;
            }
        }
        next();
    });

    function requireAuth(req, res, next) {
        if (!req.user) return res.status(401).json({ error: msg('AUTH_REQUIRED'), code: 'AUTH_REQUIRED' });
        return next();
    }

    function requireRole(minRole) {
        return (req, res, next) => {
            if (!req.user) return res.status(401).json({ error: msg('AUTH_REQUIRED'), code: 'AUTH_REQUIRED' });
            if (!Roles.atLeast(req.user.role, minRole)) {
                return res.status(403).json({ error: msg('FORBIDDEN'), code: 'FORBIDDEN' });
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
        /* 診斷資訊：只吐不含機密的東西（主機代號、金鑰角色／專案 ref、最後一次錯誤），
         * 用來分辨「連錯專案」「金鑰種類不對」「資料庫真的空的」這三種情況。 */
        const db = typeof store.diagnostics === 'function' ? store.diagnostics() : null;
        res.json({
            version: PACKAGE.version,
            backend: store.backend,
            backend_label: DATA_BACKEND_LABEL[store.backend] || store.backend,
            data_file: store.backend === 'json' ? store.dataFile : null,
            schema_ready: store.backend === 'supabase' ? Boolean(db && db.hydrate_ok) : true,
            jwt_secret_configured: Boolean(process.env.JWT_SECRET) && !/^REPLACE_ME/.test(String(process.env.JWT_SECRET)),
            counts: store.tableCounts(),
            db,
            /* D-6（v0.7.0）：資料庫用量百分比（門檻 70%）。
             * ★ 抓不到（dict_db_size() 還沒建立、權限沒開）時回 `available:false` ——
             *   誠實說「不知道」，不假裝是 0%（那會讓監控以為很空）。 */
            usage: typeof store.dbUsage === 'function'
                ? store.dbUsage()
                : usageState(null, { reason: '這個資料層沒有提供用量' })
        });
    });

    /* ================= 公開：書本／單元／生字 ================= */

    /* 年級（v0.5.0）：畫面上只顯示年級，書名與封面完全不對外 —— 連管理區也不出現。
     * 舊資料可能沒有 grade：退回用 code（代號本來就是給人看的短標籤，且不含書名），
     * 最後才用「未分類」；**絕不會**退回 name（那就是書名）。 */
    function gradeOf(book) {
        if (!book) return '';
        return String(book.grade || book.code || '').trim() || '—';
    }

    /* 書本對外的樣子：**白名單**（只回年級與統計需要的欄位）。
     * 之前是「複製全部再刪掉封面」，那種寫法很容易在不注意時洩漏欄位（name／publisher／code），
     * 現在改成只挑要的欄位出來。 */
    function publicBook(book) {
        if (!book) return book;
        return {
            id: book.id,
            grade: gradeOf(book),
            is_published: book.is_published !== false,
            sort_order: Number(book.sort_order || 0),
            updated_at: book.updated_at || null
        };
    }

    /* 公開讀取端點的快取標頭（A-11）。
     * ★ 只有「未登入」的回應可以公開快取：登入者會看到未發佈的草稿／待審核生字，
     *   那種回應一旦被 CDN 或瀏覽器快取，別人就可能拿到還沒公開的內容。
     *   所以有登入 → private, no-store；沒登入 → 15 秒公開快取（省函式與資料庫的往返）。 */
    function setReadCache(req, res) {
        /* ★ Vary: Cookie 是必要的（不是保險）：沒有它，瀏覽器會把「未登入時抓到的公開回應」
         *   直接拿去回答「已登入的請求」（網址一樣、15 秒內），老師就看不到剛新增的待審核生字。
         *   有 Vary: Cookie，帶 cookie 的請求不會命中那份公開快取，會真的打到伺服器。 */
        res.setHeader('Vary', 'Cookie');
        if (req.user) {
            res.setHeader('Cache-Control', 'private, no-store');
            return;
        }
        res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=60');
    }

    app.get('/api/books', (req, res) => {
        setReadCache(req, res);
        const includeHidden = canSeeUnpublished(req) && boolish(req.query.include_unpublished, false);
        const books = store.listBooks({ includeUnpublished: includeHidden }).map((book) => {
            const units = store.listUnits({ bookId: book.id, includeUnpublished: includeHidden });
            const counts = units.map((u) => store.countEntries(u.id, PUBLISHED_ONLY));
            return Object.assign(publicBook(book), {
                unit_count: units.length,
                entry_count: counts.reduce((sum, n) => sum + n, 0),
                pending_count: units.reduce((sum, u) => sum + store.countEntries(u.id, ['pending']), 0)
            });
        });
        res.json({ books });
    });

    app.get('/api/books/:id/units', (req, res) => {
        const book = store.getBook(req.params.id);
        if (!book) return res.status(404).json({ error: msg('BOOK_NOT_FOUND'), code: 'BOOK_NOT_FOUND' });
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
        res.json({ book: publicBook(book), units });
    });

    app.get('/api/units/:id', (req, res) => {
        setReadCache(req, res);
        const unit = store.getUnit(req.params.id);
        if (!unit) return res.status(404).json({ error: msg('UNIT_NOT_FOUND'), code: 'UNIT_NOT_FOUND' });
        const includeHidden = canSeeUnpublished(req);
        if (unit.is_published === false && !includeHidden) {
            return res.status(404).json({ error: msg('UNIT_NOT_PUBLISHED'), code: 'UNIT_NOT_PUBLISHED' });
        }
        const scoped = grants();
        const viewerCanEdit = Boolean(req.user && Roles.canEditUnit(req.user, unit, scoped));
        /* 誰看得到哪些狀態：
         *   老師以上（includeHidden）→ 全部
         *   科代表等可編輯者        → 已發佈 + 待審核 + 被退回（否則他們送出的字自己看不到、被退回也不知道為什麼，介面等於在騙人）
         *   其他人（含未登入）      → 只有已發佈 */
        const statuses = includeHidden ? null : (viewerCanEdit ? ['published', 'pending', 'rejected'] : PUBLISHED_ONLY);
        const book = store.getBook(unit.book_id);
        /* D-1：一頁一頁送（page／per_page），搜尋（q）與狀態（status）都在伺服器端過濾，
         * 這樣「幾千個生字」不會整包塞進瀏覽器，手機不用等全部下載完才看到第一張卡。 */
        const pageParam = Number(req.query.page);
        const perParam = Number(req.query.per_page);
        const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1;
        const perPage = Number.isFinite(perParam) && perParam > 0
            ? Math.min(ENTRY_PAGE_MAX, Math.floor(perParam))
            : ENTRY_PAGE_SIZE;
        const query = str(req.query.q || '', 60).trim().toLowerCase();
        const wantedStatus = str(req.query.status || '', 20);
        let rows = store.listEntries({ unitId: unit.id, statuses });
        if (wantedStatus && ENTRY_STATUSES.includes(wantedStatus)) {
            /* 認識的狀態就照它過濾：
             *   - 看得到這個狀態的身分 → 只回那些（例如老師抓 status=pending 的待審核佇列）
             *   - 看不到的身分（訪客問 pending）→ 回空清單，不透露別人的草稿
             * 不認識的值（例如 ?status=all）一律忽略，免得打錯字變成「這個單元沒有生字」的鬼故事。 */
            const canSeeStatus = statuses === null || statuses.includes(wantedStatus);
            rows = canSeeStatus ? rows.filter((entry) => entry.status === wantedStatus) : [];
        }
        if (query) rows = rows.filter((entry) => matchesEntryQuery(entry, query));
        const total = rows.length;
        const start = (page - 1) * perPage;
        const entries = rows.slice(start, start + perPage)
            .map((entry) => publicEntry(entry, store, { includeStatus: includeHidden || viewerCanEdit }));
        res.json({
            /* ★ 用 unitView（單一來源）才不會漏欄位：updated_at（樂觀鎖）與 audio_count／audio_limit（D-3） */
            unit: Object.assign(unitView(unit, store, { includeHidden }), { grade: gradeOf(book) }),
            entries,
            /* D-1：前端靠這幾個欄位做「載入更多」與「還有幾筆沒顯示」 */
            total,
            page,
            per_page: perPage,
            has_more: start + entries.length < total,
            can_edit: viewerCanEdit,
            can_publish: Boolean(req.user && Roles.canPublishUnit(req.user, unit, scoped)),
            can_review: Boolean(req.user && Roles.atLeast(req.user.role, 'teacher')),
            can_upload_audio: Boolean(req.user && Roles.canUploadAudio(req.user))
        });
    });

    app.get('/api/audio/:id', async (req, res) => {
        /* 錄音 base64 不在記憶體快取裡（見 lib/store/supabase.js）：真的要檔案時才單筆抓 */
        const audio = store.getAudio(req.params.id);
        if (!audio) return res.status(404).json({ error: msg('AUDIO_NOT_FOUND'), code: 'AUDIO_NOT_FOUND' });
        const full = typeof store.getAudioData === 'function' ? await store.getAudioData(audio.id) : audio;
        if (!full || !full.data) return res.status(404).json({ error: msg('AUDIO_NOT_FOUND'), code: 'AUDIO_NOT_FOUND' });
        res.setHeader('Content-Type', full.mime || audio.mime || 'audio/mpeg');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.send(Buffer.from(full.data, 'base64'));
    });

    /* ================= 認證 ================= */
    app.post('/api/auth/login', (req, res) => {
        const username = str(req.body && req.body.username, LIMITS.username);
        const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
        const ip = req.ip || 'unknown';
        if (!username || !password) return res.status(400).json({ error: msg('LOGIN_REQUIRED_FIELDS'), code: 'LOGIN_REQUIRED_FIELDS' });

        const locked = lockedReason(ip, username);
        if (locked) return res.status(429).json({ error: msg(locked), code: locked });

        const user = store.findUserByUsername(username);
        if (!user || user.is_active === false || !verifyPassword(user.password_hash, password)) {
            noteFailure(ip, username);
            return res.status(401).json({ error: msg('LOGIN_FAILED'), code: 'LOGIN_FAILED' });
        }

        /* 兩步驟驗證（A-1）：密碼對了還不算登入 —— 這裡只發一張 5 分鐘的中間權杖，
         * 它不能拿來呼叫任何 API（中介層看到 stage 一律當成未登入）。 */
        if (hasTwoFactor(user)) {
            clearFailures(ip, username);
            return res.json({
                two_factor_required: true,
                challenge_token: Auth.signToken(user, { stage: '2fa', ttlSeconds: Auth.CHALLENGE_TTL_SECONDS })
            });
        }

        return finishLogin(req, res, user, password, ip);
    });

    /* 兩步驟驗證第二步：中間權杖 + 6 位碼（或一組備援碼）→ 真的登入 */
    app.post('/api/auth/login/2fa', (req, res) => {
        const body = req.body || {};
        const challenge = typeof body.challenge_token === 'string' ? body.challenge_token : '';
        const code = str(body.code, 10);
        const backupCode = str(body.backup_code, 20);
        const payload = challenge ? Auth.verifyToken(challenge) : null;
        if (!payload || payload.stage !== '2fa' || !payload.sub) {
            return res.status(400).json({ error: msg('TWO_FACTOR_SESSION'), code: 'TWO_FACTOR_SESSION' });
        }
        /* 6 位碼只有一百萬種組合：一定要節流（比密碼更需要） */
        const gate = throttle.allow(`2fa|${req.ip || ''}|${payload.sub}`, 10, 5 * 60 * 1000);
        if (!gate.allowed) {
            res.setHeader('Retry-After', String(Math.ceil(gate.retryAfterMs / 1000)));
            return res.status(429).json({ error: msg('RATE_LIMITED'), code: 'RATE_LIMITED' });
        }
        const target = store.getUser(payload.sub);
        if (!target || target.is_active === false || !hasTwoFactor(target)) {
            return res.status(400).json({ error: msg('TWO_FACTOR_NOT_ENABLED'), code: 'TWO_FACTOR_NOT_ENABLED' });
        }
        const secret = Totp.decryptSecret(target.totp_secret, secretKey());
        let verified = false;
        if (code && secret) verified = Totp.verifyCode(secret, code);
        if (!verified && backupCode) {
            const used = Totp.consumeBackupCode(target.backup_codes, backupCode, secretKey());
            if (used.ok) {
                store.updateUser(target.id, { backup_codes: used.remaining });
                verified = true;
            }
        }
        if (!verified) {
            return res.status(401).json({ error: msg('TWO_FACTOR_INVALID'), code: 'TWO_FACTOR_INVALID' });
        }
        return finishLogin(req, res, store.getUser(target.id), '', req.ip || 'unknown');
    });

    app.post('/api/auth/logout', (req, res) => {
        Auth.clearAuthCookie(res);
        if (req.user) logAudit(store, { user: req.user, action: 'LOGOUT', details: '登出', ip: req.ip });
        return res.json({ ok: true });
    });

    /* 角色與能力對照表（C-4）：公開、DB-free —— 說明頁與「角色與權限」表格都讀這一份，
     * 所以在任何登入狀態下都能看（訪客也需要知道「登入後能做什麼」）。 */
    app.get('/api/roles', (req, res) => {
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.json(Capabilities.describe());
    });

    /* 「我的單元」（C-1）：登入後一眼看到「我可以編輯的單元」+ 各單元待審核數量 */
    app.get('/api/my/units', requireAuth, (req, res) => {
        const allGrants = grants();
        const books = store.listBooks({ includeUnpublished: true });
        const gradeOfUnit = (unit) => {
            const book = books.find((item) => String(item.id) === String(unit.book_id));
            return gradeOf(book);
        };
        const units = store.listUnits({ includeUnpublished: true });
        /* v0.6.1（D-1b）：不要為了算數字把整表生字搬進記憶體 → 用資料層的計數 */
        const mine = units.filter((unit) => Roles.canEditUnit(req.user, unit, allGrants));
        return res.json({
            total: mine.length,
            all: units.length,
            units: mine.map((unit) => ({
                id: unit.id,
                book_id: unit.book_id,
                grade: gradeOfUnit(unit),
                unit_no: unit.unit_no,
                title: unit.title || '',
                is_published: unit.is_published !== false,
                entries: store.countEntries(unit.id, PUBLISHED_ONLY),
                pending: store.countEntries(unit.id, ['pending']),
                can_publish: Roles.canPublishUnit(req.user, unit, allGrants)
            }))
        });
    });

    app.get('/api/auth/me', (req, res) => {
        if (!req.user) return res.status(401).json({ error: msg('AUTH_REQUIRED'), code: 'AUTH_REQUIRED' });
        const scoped = Roles.grantsFor(req.user, grants());
        return res.json({
            user: publicUser(req.user),
            /* ★ 從 lib/capabilities.js 產生（唯一來源）：新增能力時不會再忘了補前端 */
            permissions: Capabilities.permissionsFor(req.user),
            grants: scoped
        });
    });

    /* 任何已登入的人都可以改「自己的」密碼（要知道目前的密碼）。
     * 管理員在帳號管理面板改別人的密碼走 /api/admin/users/:id。 */
    /* ---------------- 兩步驟驗證與帳號安全的共用工具（A-1／A-8／A-10／C-3） ---------------- */
    function hasTwoFactor(user) {
        return Boolean(user && user.totp_secret && user.totp_enabled_at);
    }

    /* TOTP 密鑰的加密金鑰由 JWT_SECRET 衍生（見 lib/totp.js）。
     * 換 JWT_SECRET 等於要重新綁定 2FA —— 這個代價寫在 docs/金鑰輪替.md 裡。 */
    function secretKey() {
        try {
            return Auth.resolveJwtSecret();
        } catch (err) {
            return '';
        }
    }

    function bumpTokenVersion(user) {
        return (Number(user && user.token_version) || 1) + 1;
    }

    /* 登入成功後的共同收尾（密碼登入與兩步驟驗證第二步都會走這裡） */
    function finishLogin(req, res, user, password, ip) {
        if (password && needsPasswordUpgrade(user.password_hash)) {
            store.updateUser(user.id, { password_hash: hashPassword(password) });
        }
        const agent = String(req.headers['user-agent'] || '').slice(0, 200);
        const previousIp = String(user.last_login_ip || '');
        const previousAgent = String(user.last_login_agent || '');
        const knownDevice = Boolean(previousIp) && previousIp === ip && previousAgent === agent;
        store.updateUser(user.id, {
            last_login_at: new Date().toISOString(),
            last_login_ip: ip,
            last_login_agent: agent
        });
        clearFailures(ip, user.username);
        const fresh = store.getUser(user.id);
        Auth.setAuthCookie(res, Auth.signToken(fresh));
        logAudit(store, { user: fresh, action: 'LOGIN', details: '登入成功', ip });
        /* A-8：來源（IP + 瀏覽器）與上次不同就單獨留一筆 —— 管理員追查異常登入時看得到 */
        const newDevice = !knownDevice && Boolean(previousIp || previousAgent);
        if (newDevice) {
            logAudit(store, {
                user: fresh,
                action: 'LOGIN_NEW_DEVICE',
                targetId: fresh.id,
                details: `新裝置登入：${ip}｜${agent.slice(0, 60)}`,
                ip
            });
        }
        const response = { user: publicUser(fresh), token_type: 'cookie' };
        if (newDevice) response.new_device = true;    /* 前端顯示一次提示（不是錯誤，只是提醒） */
        return res.json(response);
    }

    /* ---- 兩步驟驗證：可選、不強制（使用者指定） ---- */
    app.post('/api/auth/2fa/setup', requireAuth, (req, res) => {
        const key = secretKey();
        if (!key) return res.status(503).json({ error: msg('SERVER'), code: 'SERVER' });
        const secret = Totp.generateSecret();
        /* 先寫進使用者但**還不算啟用**（totp_enabled_at 仍是空的）→ 驗過一次碼才啟用 */
        store.updateUser(req.user.id, { totp_secret: Totp.encryptSecret(secret, key) });
        return res.json({
            secret,
            otpauth_url: Totp.otpauthURL(secret, req.user.username),
            digits: Totp.DIGITS,
            period: Totp.STEP_SECONDS
        });
    });

    app.post('/api/auth/2fa/enable', requireAuth, (req, res) => {
        const key = secretKey();
        const code = str((req.body || {}).code, 10);
        const secret = Totp.decryptSecret(req.user.totp_secret, key);
        if (!secret) return res.status(400).json({ error: msg('TWO_FACTOR_NOT_ENABLED'), code: 'TWO_FACTOR_NOT_ENABLED' });
        if (!Totp.verifyCode(secret, code)) {
            return res.status(400).json({ error: msg('TWO_FACTOR_INVALID'), code: 'TWO_FACTOR_INVALID' });
        }
        const codes = Totp.generateBackupCodes();
        store.updateUser(req.user.id, {
            totp_enabled_at: new Date().toISOString(),
            backup_codes: codes.map((code_) => Totp.hashBackupCode(code_, key))
        });
        logAudit(store, {
            user: req.user, action: 'TWO_FA_ENABLE', targetId: req.user.id,
            details: req.user.username, ip: req.ip
        });
        /* 備援碼只回這一次：畫面要提醒使用者抄下來，資料庫裡只有雜湊 */
        return res.json({ ok: true, backup_codes: codes });
    });

    app.post('/api/auth/2fa/disable', requireAuth, (req, res) => {
        if (!hasTwoFactor(req.user)) {
            return res.status(400).json({ error: msg('TWO_FACTOR_NOT_ENABLED'), code: 'TWO_FACTOR_NOT_ENABLED' });
        }
        const body = req.body || {};
        const password = typeof body.password === 'string' ? body.password : '';
        const code = str(body.code, 10);
        const secret = Totp.decryptSecret(req.user.totp_secret, secretKey());
        const byPassword = Boolean(password) && verifyPassword(req.user.password_hash, password);
        const byCode = Boolean(secret) && Totp.verifyCode(secret, code);
        if (!byPassword && !byCode) {
            return res.status(400).json({ error: msg('CURRENT_PASSWORD_WRONG'), code: 'CURRENT_PASSWORD_WRONG' });
        }
        store.updateUser(req.user.id, { totp_secret: '', totp_enabled_at: null, backup_codes: null });
        logAudit(store, {
            user: req.user, action: 'TWO_FA_DISABLE', targetId: req.user.id,
            details: req.user.username, ip: req.ip
        });
        return res.json({ ok: true });
    });

    /* ---- 帳號救援（C-3）：管理員幫老師重設密碼／重設兩步驟驗證 ---- */
    app.post('/api/admin/users/:id/reset-password', requireRole('admin'), (req, res) => {
        const target = store.getUser(req.params.id);
        if (!target) return res.status(404).json({ error: msg('USER_NOT_FOUND'), code: 'USER_NOT_FOUND' });
        if (!Roles.canManageUser(req.user, target)) {
            return res.status(403).json({ error: msg('USER_MANAGE_FORBIDDEN'), code: 'USER_MANAGE_FORBIDDEN' });
        }
        const temp = generateTempPassword();
        store.updateUser(target.id, {
            password_hash: hashPassword(temp),
            token_version: bumpTokenVersion(target)      /* 舊的工作階段全部失效 */
        });
        logAudit(store, {
            user: req.user, action: 'USER_PASSWORD_RESET', targetId: target.id,
            details: `${target.username}：重設為臨時密碼`, ip: req.ip
        });
        /* 臨時密碼只回這一次：不寫稽核、不寫日誌 */
        return res.json({ ok: true, username: target.username, temp_password: temp });
    });

    app.post('/api/admin/users/:id/reset-2fa', requireRole('admin'), (req, res) => {
        const target = store.getUser(req.params.id);
        if (!target) return res.status(404).json({ error: msg('USER_NOT_FOUND'), code: 'USER_NOT_FOUND' });
        if (!Roles.canManageUser(req.user, target)) {
            return res.status(403).json({ error: msg('USER_MANAGE_FORBIDDEN'), code: 'USER_MANAGE_FORBIDDEN' });
        }
        store.updateUser(target.id, { totp_secret: '', totp_enabled_at: null, backup_codes: null });
        logAudit(store, {
            user: req.user, action: 'USER_2FA_RESET', targetId: target.id,
            details: `${target.username}：重設兩步驟驗證`, ip: req.ip
        });
        return res.json({ ok: true, user: publicUser(store.getUser(target.id)) });
    });

    app.post('/api/auth/change-password', (req, res) => {
        if (!req.user) return res.status(401).json({ error: msg('AUTH_REQUIRED'), code: 'AUTH_REQUIRED' });
        const body = req.body || {};
        const current = typeof body.current_password === 'string' ? body.current_password : '';
        const next = typeof body.new_password === 'string' ? body.new_password : '';
        if (!verifyPassword(req.user.password_hash, current)) {
            return res.status(400).json({ error: msg('CURRENT_PASSWORD_WRONG'), code: 'CURRENT_PASSWORD_WRONG' });
        }
        if (passwordProblem(next)) {
            return res.status(400).json({
                error: msg('PASSWORD_LENGTH', { min: PASSWORD_MIN }),
                code: 'PASSWORD_LENGTH',
                details: { min: PASSWORD_MIN }
            });
        }
        /* 改密碼＝其他裝置的舊工作階段全部失效（A-10）；自己這一台換一張新權杖，不用重新登入 */
        store.updateUser(req.user.id, {
            password_hash: hashPassword(next),
            token_version: bumpTokenVersion(req.user)
        });
        Auth.setAuthCookie(res, Auth.signToken(store.getUser(req.user.id)));
        logAudit(store, {
            user: req.user, action: 'PASSWORD_CHANGE', targetId: req.user.id,
            details: `${req.user.username}（其他裝置已登出）`, ip: req.ip
        });
        return res.json({ ok: true });
    });

    /* ================= 生字：新增／修改／刪除 ================= */
    function resolveUnit(req, res) {
        const unit = store.getUnit(req.params.id || req.params.unitId);
        if (!unit) {
            res.status(404).json({ error: msg('UNIT_NOT_FOUND'), code: 'UNIT_NOT_FOUND' });
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
            return res.status(403).json({ error: msg('NO_EDIT_PERMISSION'), code: 'NO_EDIT_PERMISSION' });
        }
        const input = applyEntryInput(req.body || {});
        if (!input.headword) return res.status(400).json({ error: msg('HEADWORD_REQUIRED'), code: 'HEADWORD_REQUIRED' });
        if (!input.zh_meaning && !input.en_definition) {
            return res.status(400).json({ error: msg('MEANING_REQUIRED'), code: 'MEANING_REQUIRED' });
        }
        const norm = normalizeHeadword(input.headword);
        const existing = store.findEntryByHeadword(unit.id, norm);
        if (existing) {
            return res.status(409).json({ error: msg('DUPLICATE_ENTRY', { word: existing.headword }), code: 'DUPLICATE_ENTRY', details: { word: existing.headword }, entry_id: existing.id });
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
        if (!entry) return res.status(404).json({ error: msg('ENTRY_NOT_FOUND'), code: 'ENTRY_NOT_FOUND' });
        const unit = store.getUnit(entry.unit_id);
        const scoped = grants();
        if (!Roles.canEditUnit(req.user, unit, scoped)) {
            return res.status(403).json({ error: msg('NO_EDIT_PERMISSION'), code: 'NO_EDIT_PERMISSION' });
        }
        if (entry.status === 'published' && !Roles.canPublishUnit(req.user, unit, scoped)) {
            return res.status(403).json({ error: msg('PUBLISHED_NEEDS_TEACHER'), code: 'PUBLISHED_NEEDS_TEACHER' });
        }
        const body = req.body || {};
        const stale = staleWrite(entry, body);
        if (stale) {
            return res.status(409).json({
                error: msg('STALE_WRITE'),
                code: 'STALE_WRITE',
                details: { current: stale, headword: entry.headword }
            });
        }
        const patch = applyEntryInput(Object.assign({}, entry, body));
        if (!patch.headword) return res.status(400).json({ error: msg('HEADWORD_REQUIRED'), code: 'HEADWORD_REQUIRED' });
        const norm = normalizeHeadword(patch.headword);
        const clash = store.findEntryByHeadword(unit.id, norm);
        if (clash && String(clash.id) !== String(entry.id)) {
            return res.status(409).json({ error: msg('DUPLICATE_ENTRY', { word: clash.headword }), code: 'DUPLICATE_ENTRY', details: { word: clash.headword } });
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
        if (!entry) return res.status(404).json({ error: msg('ENTRY_NOT_FOUND'), code: 'ENTRY_NOT_FOUND' });
        const unit = store.getUnit(entry.unit_id);
        const scoped = grants();
        if (!Roles.canEditUnit(req.user, unit, scoped)) {
            return res.status(403).json({ error: msg('NO_EDIT_PERMISSION'), code: 'NO_EDIT_PERMISSION' });
        }
        if (entry.status === 'published' && !Roles.canPublishUnit(req.user, unit, scoped)) {
            return res.status(403).json({ error: msg('PUBLISHED_NEEDS_TEACHER'), code: 'PUBLISHED_NEEDS_TEACHER' });
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
    /* 複製單元（B-4）：把單元與它的生字複製一份（**不含錄音**，避免整本書重複佔空間）。
     * 新單元排在最後，名稱預設加「（複製）」—— 名稱由前端給，因為要跟著語言走。 */
    app.post('/api/units/:id/duplicate', requireRole('teacher'), (req, res) => {
        const unit = store.getUnit(req.params.id);
        if (!unit) return res.status(404).json({ error: msg('UNIT_NOT_FOUND'), code: 'UNIT_NOT_FOUND' });
        const book = store.getBook(unit.book_id);
        const siblings = store.listUnits({ bookId: unit.book_id, includeUnpublished: true });
        const nextNo = siblings.reduce((max, item) => Math.max(max, Number(item.unit_no) || 0), 0) + 1;
        if (nextNo > 99) {
            return res.status(400).json({ error: msg('UNIT_NUMBER', { min: 1, max: 99 }), code: 'UNIT_NUMBER', details: { min: 1, max: 99 } });
        }
        const title = str(req.body && req.body.title, LIMITS.title) || `${unit.title || `Unit ${unit.unit_no}`}（複製）`;
        const copy = store.createUnit({
            book_id: unit.book_id, unit_no: nextNo, title,
            description: unit.description || '',
            is_published: false,
            sort_order: nextNo,
            created_by: req.user.username
        });
        let order = 0;
        let copied = 0;
        for (const entry of store.listEntries({ unitId: unit.id })) {
            order += 1;
            /* 只複製內容欄位（不帶 id／時間／審核紀錄；錄音本來就沒有對應欄位，所以複製出來的單元沒有錄音） */
            store.createEntry({
                unit_id: copy.id,
                headword: entry.headword,
                headword_norm: entry.headword_norm,
                ipa_us: entry.ipa_us || '',
                ipa_uk: entry.ipa_uk || '',
                part_of_speech: entry.part_of_speech || '',
                zh_meaning: entry.zh_meaning || '',
                en_definition: entry.en_definition || '',
                example_en: entry.example_en || '',
                example_zh: entry.example_zh || '',
                status: 'pending',
                sort_order: order,
                created_by: req.user.username,
                updated_by: req.user.username
            });
            copied += 1;
        }
        logAudit(store, {
            user: req.user, action: 'UNIT_DUPLICATE', targetId: copy.id,
            details: `${gradeOf(book)} · Unit ${unit.unit_no} → Unit ${nextNo}（${title}）：複製 ${copied} 筆生字`, ip: req.ip
        });
        return res.json({ unit: unitView(copy, store), entries: copied });
    });

    /* 調整順序（B-4）：與上／下一個單元互換編號。
     * 為什麼不用「改編號」達成：連續兩個單元互換時會撞到「同書不重複編號」的檢查，
     * 所以由伺服器一次做完（先搬到暫存值再交換），前端只要按 ↑／↓。 */
    app.post('/api/units/:id/move', requireRole('teacher'), (req, res) => {
        const unit = store.getUnit(req.params.id);
        if (!unit) return res.status(404).json({ error: msg('UNIT_NOT_FOUND'), code: 'UNIT_NOT_FOUND' });
        const direction = str(req.body && req.body.direction, 4);
        if (!['up', 'down'].includes(direction)) {
            return res.status(400).json({ error: msg('MOVE_DIRECTION'), code: 'MOVE_DIRECTION' });
        }
        const siblings = store.listUnits({ bookId: unit.book_id, includeUnpublished: true })
            .sort((a, b) => (Number(a.unit_no) - Number(b.unit_no)) || (a.id - b.id));
        const index = siblings.findIndex((item) => String(item.id) === String(unit.id));
        const swapIndex = direction === 'up' ? index - 1 : index + 1;
        if (swapIndex < 0 || swapIndex >= siblings.length) {
            return res.json({ moved: false, unit: unitView(unit, store), reason: 'edge' });
        }
        const other = siblings[swapIndex];
        store.updateUnit(unit.id, { unit_no: 999 });                 /* 先讓開，避免撞號 */
        store.updateUnit(other.id, { unit_no: unit.unit_no });
        store.updateUnit(unit.id, { unit_no: other.unit_no });
        logAudit(store, {
            user: req.user, action: 'UNIT_MOVE', targetId: unit.id,
            details: `Unit ${unit.unit_no} ⇄ Unit ${other.unit_no}`, ip: req.ip
        });
        return res.json({ moved: true, unit: unitView(store.getUnit(unit.id), store), swapped_with: unitView(store.getUnit(other.id), store) });
    });

    /* 書本排序（B-4）：同一套互換邏輯 */
    app.post('/api/books/:id/move', requireRole('teacher'), (req, res) => {
        const book = store.getBook(req.params.id);
        if (!book) return res.status(404).json({ error: msg('BOOK_NOT_FOUND'), code: 'BOOK_NOT_FOUND' });
        const direction = str(req.body && req.body.direction, 4);
        if (!['up', 'down'].includes(direction)) {
            return res.status(400).json({ error: msg('MOVE_DIRECTION'), code: 'MOVE_DIRECTION' });
        }
        const all = store.listBooks({ includeUnpublished: true })
            .sort((a, b) => (Number(a.sort_order || 0) - Number(b.sort_order || 0)) || (a.id - b.id));
        const index = all.findIndex((item) => String(item.id) === String(book.id));
        const swapIndex = direction === 'up' ? index - 1 : index + 1;
        if (swapIndex < 0 || swapIndex >= all.length) {
            return res.json({ moved: false, book: publicBook(store.getBook(book.id)) });
        }
        const other = all[swapIndex];
        const mine = Number(book.sort_order || 0);
        const theirs = Number(other.sort_order || 0);
        store.updateBook(book.id, { sort_order: -999 });
        store.updateBook(other.id, { sort_order: mine });
        store.updateBook(book.id, { sort_order: theirs });
        logAudit(store, {
            user: req.user, action: 'BOOK_MOVE', targetId: book.id,
            details: `${gradeOf(book)} ⇄ ${gradeOf(other)}`, ip: req.ip
        });
        return res.json({ moved: true, book: publicBook(store.getBook(book.id)) });
    });

    /* 批次審核（B-6）：一次核准／退回多筆（老師以上）。
     * 每一筆都會留稽核，退回可以附原因（會顯示給科代表看）。 */
    app.post('/api/entries/review-batch', requireRole('teacher'), (req, res) => {
        const body = req.body || {};
        const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200) : [];
        const action = str(body.action, 20);
        if (!ids.length) return res.status(400).json({ error: msg('REVIEW_IDS_EMPTY'), code: 'REVIEW_IDS_EMPTY' });
        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ error: msg('REVIEW_ACTION'), code: 'REVIEW_ACTION' });
        }
        const note = str(body.note, LIMITS.note);
        const done = [];
        const failed = [];
        for (const id of ids) {
            const entry = store.getEntry(id);
            if (!entry || entry.status !== 'pending') {
                failed.push({ id, reason: '找不到或不是在待審核狀態' });
                continue;
            }
            store.updateEntry(entry.id, {
                status: action === 'approve' ? 'published' : 'rejected',
                review_note: note,
                reviewed_by: req.user.username,
                reviewed_at: new Date().toISOString(),
                updated_by: req.user.username
            });
            done.push(store.getEntry(entry.id));
        }
        if (done.length) {
            logAudit(store, {
                user: req.user, action: 'ENTRY_REVIEW_BATCH', targetId: null,
                details: `${action === 'approve' ? '核准' : '退回'} ${done.length} 筆${note ? `（${note}）` : ''}`, ip: req.ip
            });
        }
        return res.json({ done: done.length, failed, entries: done.map((entry) => publicEntry(entry, store, { includeStatus: true })) });
    });

    app.post('/api/entries/:id/review', requireRole('teacher'), (req, res) => {
        const entry = store.getEntry(req.params.id);
        if (!entry) return res.status(404).json({ error: msg('ENTRY_NOT_FOUND'), code: 'ENTRY_NOT_FOUND' });
        if (entry.status !== 'pending') {
            return res.status(400).json({ error: msg('NOT_PENDING'), code: 'NOT_PENDING' });
        }
        const action = str(req.body && req.body.action, 20);
        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ error: msg('REVIEW_ACTION'), code: 'REVIEW_ACTION' });
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
            return res.status(403).json({ error: msg('NO_EDIT_PERMISSION'), code: 'NO_EDIT_PERMISSION' });
        }
        /* 兩種來源：貼上的文字（text，伺服器解析）或前端已解析好的列（rows，CSV／.xlsx 走這條）。
         * .xlsx 在瀏覽器裡解（public/js/xlsx.js，零依賴），伺服器只負責收乾淨的欄位。 */
        const fromRows = Array.isArray(req.body && req.body.rows);
        const parsed = fromRows
            ? { rows: parseImportRows(req.body.rows), errors: [] }
            : parseImportText(req.body && req.body.text);
        if (parsed.rows.length === 0) {
            return res.status(400).json({ error: msg('IMPORT_EMPTY'), code: 'IMPORT_EMPTY', errors: parsed.errors });
        }
        const status = Roles.needsReview(req.user, unit, scoped) ? 'pending' : 'published';
        const created = [];
        const skipped = [];
        const source = fromRows ? (str(req.body.source, 20) === 'file' ? 'file' : 'rows') : 'paste';
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
                action: source === 'paste' ? 'ENTRY_IMPORT' : 'ENTRY_IMPORT_FILE',
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
        if (!entry) return res.status(404).json({ error: msg('ENTRY_NOT_FOUND'), code: 'ENTRY_NOT_FOUND' });
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
                error: msg('INVALID_AUDIO_TYPE', { mime: mime || '?' }), code: 'INVALID_AUDIO_TYPE', details: { mime: mime || '?' },
                allowed: AUDIO_MIME_WHITELIST
            });
        }
        if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) {
            return res.status(400).json({ error: msg('AUDIO_BAD_BASE64'), code: 'AUDIO_BAD_BASE64' });
        }
        const bytes = Buffer.from(base64, 'base64');
        if (bytes.length === 0) return res.status(400).json({ error: msg('AUDIO_EMPTY'), code: 'AUDIO_EMPTY' });
        if (bytes.length > AUDIO_MAX_BYTES) {
            return res.status(413).json({ error: msg('AUDIO_TOO_LARGE', { kb: Math.round(bytes.length / 1024) }), code: 'AUDIO_TOO_LARGE', details: { kb: Math.round(bytes.length / 1024) } });
        }
        const duration = num(body.duration_ms, 0);
        if (duration > AUDIO_MAX_DURATION_MS) {
            return res.status(400).json({ error: msg('AUDIO_TOO_LONG'), code: 'AUDIO_TOO_LONG' });
        }
        // 一個生字只保留一段老師錄音：換新的就把舊的刪掉
        const old = store.findTeacherAudio(entry.id);
        /* D-3：沒有舊錄音＝這個單元要多一段 → 先看有沒有超過上限 */
        if (!old) {
            const unitAudio = store.listEntries({ unitId: entry.unit_id })
                .filter((row) => store.findTeacherAudio(row.id)).length;
            if (unitAudio >= AUDIO_MAX_PER_UNIT) {
                return res.status(400).json({
                    error: msg('AUDIO_LIMIT_REACHED', { count: unitAudio, limit: AUDIO_MAX_PER_UNIT }),
                    code: 'AUDIO_LIMIT_REACHED',
                    details: { count: unitAudio, limit: AUDIO_MAX_PER_UNIT }
                });
            }
        }
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
        if (!audio) return res.status(404).json({ error: msg('AUDIO_NOT_FOUND'), code: 'AUDIO_NOT_FOUND' });
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
    /* 新增年級（v0.5.0）：老師只需要填年級。
     * code 由伺服器產生（唯一即可，用來滿足資料表欄位），name 與年級同步（內部用，不對外顯示）。 */
    app.post('/api/books', requireRole('teacher'), (req, res) => {
        const body = req.body || {};
        const grade = str(body.grade, 20);
        if (!grade) return res.status(400).json({ error: msg('BOOK_GRADE_REQUIRED'), code: 'BOOK_GRADE_REQUIRED' });
        const existing = store.listBooks({ includeUnpublished: true });
        if (existing.some((book) => gradeOf(book) === grade)) {
            return res.status(409).json({ error: msg('DUPLICATE_GRADE', { grade }), code: 'DUPLICATE_GRADE', details: { grade } });
        }
        let code = `G${existing.length + 1}`;
        let suffix = 1;
        while (existing.some((book) => book.code === code)) {
            suffix += 1;
            code = `G${existing.length + suffix}`;
        }
        const book = store.createBook({
            code,
            name: grade,
            grade,
            publisher: '',
            sort_order: num(body.sort_order, existing.length + 1),
            is_published: boolish(body.is_published, true)
        });
        logAudit(store, { user: req.user, action: 'BOOK_CREATE', targetId: book.id, details: grade, ip: req.ip });
        return res.status(201).json({ book: publicBook(book) });
    });

    app.patch('/api/books/:id', requireRole('teacher'), (req, res) => {
        const book = store.getBook(req.params.id);
        if (!book) return res.status(404).json({ error: msg('BOOK_NOT_FOUND'), code: 'BOOK_NOT_FOUND' });
        const body = req.body || {};
        const stale = staleWrite(book, body);
        if (stale) {
            return res.status(409).json({ error: msg('STALE_WRITE'), code: 'STALE_WRITE', details: { current: stale, grade: gradeOf(book) } });
        }
        const patch = {};
        /* 只開放年級／排序／發佈狀態：書名與代號都不再是使用者輸入（v0.5.0） */
        if (body.grade !== undefined) {
            const grade = str(body.grade, 20);
            if (!grade) return res.status(400).json({ error: msg('BOOK_GRADE_REQUIRED'), code: 'BOOK_GRADE_REQUIRED' });
            /* 年級是書架上的識別：兩個同年級的書會讓學生分不出要點哪一個 */
            const clash = store.listBooks({ includeUnpublished: true })
                .find((b) => String(b.id) !== String(book.id) && gradeOf(b).toLowerCase() === grade.toLowerCase());
            if (clash) {
                return res.status(409).json({
                    error: msg('DUPLICATE_GRADE', { grade }),
                    code: 'DUPLICATE_GRADE',
                    details: { grade }
                });
            }
            patch.grade = grade;
            patch.name = grade;                     /* name 是內部欄位，與年級同步 */
            patch.publisher = '';
        }
        if (body.sort_order !== undefined) patch.sort_order = num(body.sort_order, book.sort_order);
        if (body.is_published !== undefined) patch.is_published = boolish(body.is_published, true);
        const updated = store.updateBook(book.id, patch);
        logAudit(store, { user: req.user, action: 'BOOK_UPDATE', targetId: book.id, details: gradeOf(updated), ip: req.ip });
        return res.json({ book: publicBook(updated) });
    });

    /* 封面功能已移除（v0.5.0：畫面上不再顯示封面，管理區也不再提供上傳）。
     * 資料表的 cover_* 欄位保留（不刪欄位避免破壞既有資料），但沒有任何端點會讀寫它。 */

    app.post('/api/books/:id/units', requireRole('teacher'), (req, res) => {
        const book = store.getBook(req.params.id);
        if (!book) return res.status(404).json({ error: msg('BOOK_NOT_FOUND'), code: 'BOOK_NOT_FOUND' });
        const body = req.body || {};
        const unitNo = Number(body.unit_no);
        if (!Number.isFinite(unitNo) || unitNo < 1 || unitNo > 99) {
            return res.status(400).json({ error: msg('UNIT_NUMBER'), code: 'UNIT_NUMBER' });
        }
        if (store.findUnitByNo(book.id, unitNo)) {
            return res.status(409).json({ error: msg('DUPLICATE_UNIT', { book: gradeOf(book), n: unitNo }), code: 'DUPLICATE_UNIT', details: { book: gradeOf(book), n: unitNo } });
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
            details: `${gradeOf(book)} · Unit ${unitNo}${unit.title ? ` ${unit.title}` : ''}`,
            ip: req.ip
        });
        return res.status(201).json({ unit });
    });

    app.patch('/api/units/:id', requireRole('teacher'), (req, res) => {
        const unit = store.getUnit(req.params.id);
        if (!unit) return res.status(404).json({ error: msg('UNIT_NOT_FOUND'), code: 'UNIT_NOT_FOUND' });
        const body = req.body || {};
        const stale = staleWrite(unit, body);
        if (stale) {
            return res.status(409).json({ error: msg('STALE_WRITE'), code: 'STALE_WRITE', details: { current: stale, unit_no: unit.unit_no } });
        }
        const patch = {};
        if (body.title !== undefined) patch.title = str(body.title, LIMITS.title);
        if (body.unit_no !== undefined) {
            /* 改單元編號（老師可以改，例如把 Unit 3 換成 Unit 2）：
             * 規則與「新增單元」一致 —— 1~99 的整數，且同一本書不能有兩個同編號
             * （否則學生的目錄會出現兩個 Unit 3，而且排序會變成不確定的）。 */
            const unitNo = Number(body.unit_no);
            if (!Number.isFinite(unitNo) || unitNo < 1 || unitNo > 99) {
                return res.status(400).json({ error: msg('UNIT_NUMBER'), code: 'UNIT_NUMBER' });
            }
            const clash = store.findUnitByNo(unit.book_id, unitNo);
            if (clash && String(clash.id) !== String(unit.id)) {
                const book = store.getBook(unit.book_id);
                const bookName = gradeOf(book);
                return res.status(409).json({
                    error: msg('DUPLICATE_UNIT', { book: bookName, n: unitNo }),
                    code: 'DUPLICATE_UNIT',
                    details: { book: bookName, n: unitNo }
                });
            }
            patch.unit_no = unitNo;
        }
        if (body.sort_order !== undefined) patch.sort_order = num(body.sort_order, unit.sort_order);
        if (body.is_published !== undefined) patch.is_published = boolish(body.is_published, true);
        const updated = store.updateUnit(unit.id, patch);
        const book = store.getBook(unit.book_id);
        logAudit(store, {
            user: req.user,
            action: 'UNIT_UPDATE',
            targetId: unit.id,
            details: `${book ? `${gradeOf(book)} · ` : ''}Unit ${updated.unit_no}${updated.title ? ` ${updated.title}` : ''}`,
            ip: req.ip
        });
        return res.json({ unit: updated });
    });

    function setUnitPublished(req, res, published) {
        const unit = store.getUnit(req.params.id);
        if (!unit) return res.status(404).json({ error: msg('UNIT_NOT_FOUND'), code: 'UNIT_NOT_FOUND' });
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
            can_change_role: Roles.canManageUser(req.user, user),
            is_self: String(user.id) === String(req.user.id),
            grant_count: store.listGrants({ userId: user.id }).length
        }));
        res.json({
            users,
            /* web_manager 可以建立／指派同級，所以它的選單要包含 web_manager；其他角色不含。 */
            assignable_roles: (Roles.canCreateRole(req.user, 'web_manager')
                ? Roles.ASSIGNABLE_ROLES.concat(['web_manager'])
                : Roles.ASSIGNABLE_ROLES).map((role) => ({ value: role, label: Roles.roleLabel(role) })),
            /* 只有 web_manager 可以指派 admin／web_manager（比自己低的角色才在 assignable_roles 裡） */
            can_assign_admin: Roles.canCreateRole(req.user, 'admin'),
            can_assign_web_manager: Roles.canCreateRole(req.user, 'web_manager'),
            can_delete_users: true,
            role_levels: Roles.ROLE_LEVELS
        });
    });

    app.post('/api/admin/users', requireRole('admin'), (req, res) => {
        const body = req.body || {};
        const username = str(body.username, LIMITS.username);
        const password = typeof body.password === 'string' ? body.password : '';
        const role = str(body.role, 20) || 'student';
        if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) {
            return res.status(400).json({ error: msg('USERNAME_FORMAT'), code: 'USERNAME_FORMAT' });
        }
        if (passwordProblem(password)) {
            return res.status(400).json({
                error: msg('PASSWORD_LENGTH', { min: PASSWORD_MIN }),
                code: 'PASSWORD_LENGTH',
                details: { min: PASSWORD_MIN }
            });
        }
        if (!Roles.canCreateRole(req.user, role)) {
            return res.status(403).json({ error: msg('ROLE_CREATE_FORBIDDEN'), code: 'ROLE_CREATE_FORBIDDEN' });
        }
        if (store.findUserByUsername(username)) {
            return res.status(409).json({ error: msg('USERNAME_TAKEN'), code: 'USERNAME_TAKEN' });
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

    /* 所有帳號、所有裝置一起登出（使用者指定：只有 web_manager，而且要連自己都被登出）。
     * 做法是把每個使用者的 token_version +1 —— 之後所有舊權杖一律失效。 */
    app.post('/api/admin/users/logout-all', requireRole('web_manager'), (req, res) => {
        const all = store.listUsers ? store.listUsers() : [];
        let bumped = 0;
        for (const user of all) {
            store.updateUser(user.id, { token_version: (Number(user.token_version) || 1) + 1 });
            bumped += 1;
        }
        logAudit(store, {
            user: req.user,
            action: 'ALL_USERS_FORCE_LOGOUT',
            details: `所有帳號的所有裝置（${bumped} 個帳號）`,
            ip: req.ip
        });
        /* 呼叫者的權杖也已經失效：前端收到這個回應後要把自己登出 */
        return res.json({ ok: true, users: bumped });
    });

    app.patch('/api/admin/users/:id', requireRole('admin'), (req, res) => {
        const target = store.getUser(req.params.id);
        if (!target) return res.status(404).json({ error: msg('USER_NOT_FOUND'), code: 'USER_NOT_FOUND' });
        /* 自己可以改自己的密碼／顯示名稱（使用者回報：改自己的密碼卻說「你不能管理這個使用者」），
         * 但**不能改自己的角色或停用自己**（那是提權與自鎖）。 */
        const isSelf = String(target.id) === String(req.user.id);
        if (!isSelf && !Roles.canManageUser(req.user, target)) {
            return res.status(403).json({ error: msg('USER_MANAGE_FORBIDDEN'), code: 'USER_MANAGE_FORBIDDEN' });
        }
        const body = req.body || {};
        if (isSelf && (body.role !== undefined || body.is_active !== undefined)) {
            return res.status(403).json({ error: msg('USER_MANAGE_FORBIDDEN'), code: 'USER_MANAGE_FORBIDDEN' });
        }
        const forceLogout = body.force_logout !== undefined && boolish(body.force_logout, false);
        const patch = {};
        if (body.display_name !== undefined) patch.display_name = str(body.display_name, LIMITS.display_name);
        if (body.is_active !== undefined) {
            const next = boolish(body.is_active, true);
            if (!next && store.countUsersByRole('web_manager') <= (target.role === 'web_manager' ? 1 : 0)) {
                return res.status(400).json({ error: msg('LAST_WEB_MANAGER'), code: 'LAST_WEB_MANAGER' });
            }
            patch.is_active = next;
        }
        if (body.password !== undefined) {
            const password = String(body.password);
            if (passwordProblem(password)) {
                return res.status(400).json({
                    error: msg('PASSWORD_LENGTH', { min: PASSWORD_MIN }),
                    code: 'PASSWORD_LENGTH',
                    details: { min: PASSWORD_MIN }
                });
            }
            patch.password_hash = hashPassword(password);
            patch.token_version = bumpTokenVersion(target);      /* 改別人的密碼＝把對方登出（A-10） */
        }
        /* web_manager 可以叫某個人「所有裝置一起登出」（使用者指定：一般登出只登出自己那一台） */
        if (forceLogout) {
            if (!Roles.atLeast(req.user.role, 'web_manager')) {
                return res.status(403).json({ error: msg('FORCE_LOGOUT_FORBIDDEN'), code: 'FORCE_LOGOUT_FORBIDDEN' });
            }
            if (isSelf) return res.status(400).json({ error: msg('CANNOT_DELETE_SELF'), code: 'CANNOT_DELETE_SELF' });
            patch.token_version = bumpTokenVersion(target);
        }
        if (body.role !== undefined) {
            if (!Roles.canCreateRole(req.user, body.role)) {
                return res.status(403).json({ error: msg('ROLE_ASSIGN_FORBIDDEN'), code: 'ROLE_ASSIGN_FORBIDDEN' });
            }
            /* 不能把最後一位網站管理員降級（否則沒人能再管理帳號） */
            if (target.role === 'web_manager' && Roles.normalizeRole(body.role) !== 'web_manager' && store.countUsersByRole('web_manager') <= 1) {
                return res.status(400).json({ error: msg('LAST_WEB_MANAGER'), code: 'LAST_WEB_MANAGER' });
            }
            patch.role = Roles.normalizeRole(body.role);
        }
        const updated = store.updateUser(target.id, patch);
        /* 改的是自己的密碼（管理員在面板替自己改）：立刻換一張新權杖給自己，不然會把自己登出 */
        if (isSelf && patch.password_hash) {
            Auth.setAuthCookie(res, Auth.signToken(store.getUser(target.id)));
        }
        const labelOf = { display_name: '顯示名稱', is_active: '啟用狀態', password_hash: '密碼', role: '角色', token_version: '所有裝置登出' };
        const changed = Object.keys(patch)
            .filter((key) => key !== 'token_version' || forceLogout)
            .map((key) => labelOf[key])
            .filter(Boolean);
        logAudit(store, {
            user: req.user,
            action: forceLogout ? 'USER_FORCE_LOGOUT' : 'USER_UPDATE',
            targetId: target.id,
            details: `${target.username}：${changed.join('、')}`,
            ip: req.ip
        });
        return res.json({ user: publicUser(updated), forced_logout: forceLogout });
    });

    app.delete('/api/admin/users/:id', requireRole('admin'), (req, res) => {
        const target = store.getUser(req.params.id);
        if (!target) return res.status(404).json({ error: msg('USER_NOT_FOUND'), code: 'USER_NOT_FOUND' });
        if (String(target.id) === String(req.user.id)) {
            return res.status(400).json({ error: msg('CANNOT_DELETE_SELF'), code: 'CANNOT_DELETE_SELF' });
        }
        if (!Roles.canManageUser(req.user, target)) {
            return res.status(403).json({ error: msg('USER_MANAGE_FORBIDDEN'), code: 'USER_MANAGE_FORBIDDEN' });
        }
        if (target.role === 'web_manager' && store.countUsersByRole('web_manager') <= 1) {
            return res.status(400).json({ error: msg('LAST_WEB_MANAGER'), code: 'LAST_WEB_MANAGER' });
        }
        const grants = store.listGrants({ userId: target.id });
        for (const grant of grants) store.deleteGrant(grant.id);
        store.deleteUser(target.id);
        logAudit(store, {
            user: req.user,
            action: 'USER_DELETE',
            targetId: target.id,
            details: `${target.username}（${target.role}${grants.length ? `，${grants.length} 筆授權一併刪除` : ''}）`,
            ip: req.ip
        });
        return res.json({ ok: true, id: target.id, grants_removed: grants.length });
    });

    app.get('/api/admin/grants', requireRole('admin'), (req, res) => {
        const users = store.listUsers();
        const rows = store.listGrants({}).map((grant) => {
            const user = users.find((u) => String(u.id) === String(grant.user_id));
            const book = grant.book_id ? store.getBook(grant.book_id) : null;
            const unit = grant.unit_id ? store.getUnit(grant.unit_id) : null;
            return Object.assign({}, grant, {
                username: user ? user.username : '(已刪除)',
                grade: gradeOf(book),
                unit_label: unit ? `Unit ${unit.unit_no}${unit.title ? ` ${unit.title}` : ''}` : ''
            });
        });
        return res.json({ grants: rows });
    });

    app.post('/api/admin/grants', requireRole('admin'), (req, res) => {
        const body = req.body || {};
        const user = store.getUser(body.user_id);
        if (!user) return res.status(404).json({ error: msg('USER_NOT_FOUND'), code: 'USER_NOT_FOUND' });
        const bookId = body.book_id === undefined || body.book_id === null || body.book_id === '' ? null : Number(body.book_id);
        const unitId = body.unit_id === undefined || body.unit_id === null || body.unit_id === '' ? null : Number(body.unit_id);
        if ((bookId && !store.getBook(bookId)) || (unitId && !store.getUnit(unitId))) {
            return res.status(400).json({ error: msg('TARGET_NOT_FOUND'), code: 'TARGET_NOT_FOUND' });
        }
        if (!bookId && !unitId) return res.status(400).json({ error: msg('GRANT_TARGET_REQUIRED'), code: 'GRANT_TARGET_REQUIRED' });
        const duplicate = store.listGrants({}).find((grant) => String(grant.user_id) === String(user.id)
            && String(grant.book_id || '') === String(bookId || '')
            && String(grant.unit_id || '') === String(unitId || ''));
        if (duplicate) {
            return res.status(409).json({ error: msg('GRANT_EXISTS'), code: 'GRANT_EXISTS', details: { username: user.username } });
        }
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
            action: 'GRANT_CREATE',
            targetId: user.id,
            details: `授權 ${user.username} ${unitId ? `單元 #${unitId}` : `書本 #${bookId}`}（${grant.can_publish ? '可發佈' : '可編輯'}）`,
            ip: req.ip
        });
        return res.status(201).json({ grant });
    });

    app.delete('/api/admin/grants/:id', requireRole('admin'), (req, res) => {
        const existing = store.listGrants({}).find((grant) => String(grant.id) === String(req.params.id));
        if (!existing) return res.status(404).json({ error: msg('GRANT_NOT_FOUND'), code: 'GRANT_NOT_FOUND' });
        const owner = store.getUser(existing.user_id);
        store.deleteGrant(existing.id);
        logAudit(store, {
            user: req.user,
            action: 'GRANT_DELETE',
            targetId: existing.user_id,
            details: `移除 ${owner ? owner.username : `#${existing.user_id}`} 的授權（${existing.unit_id ? `單元 #${existing.unit_id}` : `書本 #${existing.book_id}`}）`,
            ip: req.ip
        });
        return res.json({ ok: true });
    });

    app.get('/api/admin/audit-logs', requireRole('admin'), (req, res) => {
        const limit = Math.min(200, Math.max(1, num(req.query.limit, 50)));
        const offset = Math.max(0, num(req.query.offset, 0));
        /* 篩選：q（全文）／action（動作）／user（帳號或顯示名稱）／from・to（日期 YYYY-MM-DD）。
         * 規則集中在 lib/audit.js，兩個資料層共用同一份。 */
        const filters = {
            q: str(req.query.q, 80),
            action: str(req.query.action, 40),
            user: str(req.query.user, 40),
            from: str(req.query.from, 10),
            to: str(req.query.to, 10),
            /* 自動化檢查（E-4）：預設濾掉，否則每次驗收都在你的稽核紀錄裡多十幾筆假動作。
             * 想看就帶 hide_self_test=0。 */
            hide_self_test: req.query.hide_self_test === undefined ? true : boolish(req.query.hide_self_test, true)
        };
        const result = store.listAuditLogs(Object.assign({ limit, offset }, filters));
        const normalized = normalizeAuditFilters(filters);
        res.json({
            logs: result.items.map((row) => Object.assign({}, row, { action_label: actionLabel(row.action) })),
            total: result.total,
            limit,
            offset,
            has_more: result.has_more,
            filters: {
                q: normalized.q, action: normalized.action, user: normalized.user,
                from: normalized.fromDate, to: normalized.toDate,
                hide_self_test: normalized.hide_self_test
            },
            actions: Object.keys(AUDIT_ACTION_LABELS).map((action) => ({ value: action, label: AUDIT_ACTION_LABELS[action] }))
        });
    });

    /* ---------------- 稽核紀錄的匯出與清理（A-3） ---------------- */

    /* CSV 匯出：吃跟列表一樣的篩選條件；有沒有帶 hide_self_test 都行（預設濾掉自動化檢查） */
    app.get('/api/admin/audit-logs/export', requireRole('admin'), (req, res) => {
        const filters = {
            q: str(req.query.q, 80),
            action: str(req.query.action, 40),
            user: str(req.query.user, 40),
            from: str(req.query.from, 10),
            to: str(req.query.to, 10),
            hide_self_test: req.query.hide_self_test === undefined ? true : boolish(req.query.hide_self_test, true)
        };
        /* 匯出上限：一次最多 5000 筆（再多請縮小日期範圍），避免拉爆記憶體與瀏覽器 */
        const result = store.listAuditLogs(Object.assign({ limit: 5000, offset: 0 }, filters));
        const rows = result.items.slice().reverse();      /* CSV 由舊到新，跟紙本紀錄的習慣一致 */
        const csv = toCsv(rows);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="gary-dictionary-audit.csv"');
        res.setHeader('Cache-Control', 'private, no-store');
        logAudit(store, {
            user: req.user, action: 'AUDIT_EXPORT', details: `匯出 ${rows.length} 筆稽核紀錄`, ip: req.ip
        });
        return res.send(csv);
    });

    /* 清理舊稽核紀錄：預設只預覽（dry_run），要真的刪必須明確帶 dry_run=0，天數下限 30 */
    app.post('/api/admin/audit-logs/cleanup', requireRole('admin'), (req, res) => {
        const body = req.body || {};
        const keepDays = Math.max(Number(body.keep_days) || 365, 30);
        const dryRun = body.dry_run === undefined ? true : boolish(body.dry_run, true);
        const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();
        /* ★ 不可以只用大 limit：store 對 limit 有上限（50~200），最舊的紀錄會被切掉，
         *   所以要**用日期篩選**讓資料層先把範圍縮小（這裡傳 YYYY-MM-DD，跟列表頁同一套規則）。 */
        const cutoffDate = cutoff.slice(0, 10);
        const candidate = store.listAuditLogs({ limit: 200, offset: 0, to: cutoffDate, hide_self_test: false }).items;
        const targets = candidate.filter((row) => String(row.created_at || '') < cutoff);
        if (!dryRun && targets.length) {
            for (const row of targets) {
                if (typeof store.deleteAuditLog === 'function') store.deleteAuditLog(row.id);
            }
            logAudit(store, {
                user: req.user, action: 'AUDIT_CLEANUP', targetId: null,
                details: `刪除 ${targets.length} 筆（保留 ${keepDays} 天）`, ip: req.ip
            });
        }
        return res.json({
            dry_run: dryRun,
            keep_days: keepDays,
            cutoff,
            would_delete: targets.length,
            total: store.listAuditLogs({ limit: 1, offset: 0, hide_self_test: false }).total
        });
    });

    /* 使用統計（B-7）：只回聚合數字，不含任何個資 */
    app.get('/api/admin/stats', requireRole('admin'), (req, res) => {
        const books = store.listBooks({ includeUnpublished: true });
        const units = store.listUnits({ includeUnpublished: true });
        const publishedUnits = units.filter((unit) => unit.is_published !== false);
        /* v0.6.1（D-1b）：統計只要數字 —— 用資料層的計數查詢，不把整表生字搬進記憶體 */
        const entryTotals = store.countAllEntries();
        const audioRows = store.listAudio ? store.listAudio({}) : [];
        const users = store.listUsers();
        const grants = store.listGrants({});
        const audio = audioRows.filter((row) => row.source === 'teacher').length;
        const byRole = {};
        for (const user of users) byRole[user.role] = (byRole[user.role] || 0) + 1;
        const last7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const recent = store.listAuditLogs({ limit: 100000, offset: 0, hide_self_test: true }).items
            .filter((row) => String(row.created_at || '') >= last7);
        const recentByAction = {};
        for (const row of recent) recentByAction[row.action] = (recentByAction[row.action] || 0) + 1;
        /* 每個單元的生字數：找出「空單元」與「最多生字」的單元，老師最需要這兩個數字 */
        const perUnit = units.map((unit) => ({
            id: unit.id,
            label: `Unit ${unit.unit_no}${unit.title ? ` · ${unit.title}` : ''}`,
            grade: (() => { const book = store.getBook(unit.book_id); return gradeOf(book); })(),
            published: store.countEntries(unit.id, PUBLISHED_ONLY),
            pending: store.countEntries(unit.id, ['pending'])
        }));
        const emptyUnits = perUnit.filter((unit) => unit.published === 0 && unit.pending === 0);
        return res.json({
            /* D-6（v0.7.0）：資料庫用量（bytes／百分比／門檻）—— 概況頁顯示「用了幾 %」，
             * 到了門檻（預設 70%）前端標紅並提示要清什麼。 */
            usage: typeof store.dbUsage === 'function'
                ? store.dbUsage()
                : usageState(null, { reason: '這個資料層沒有提供用量' }),
            books: { total: books.length, published: books.filter((book) => book.is_published !== false).length },
            units: { total: units.length, published: publishedUnits.length, empty: emptyUnits.length },
            entries: { total: entryTotals.total, published: entryTotals.published, pending: entryTotals.pending },
            audio: {
                total: audio,
                missing: Math.max(0, entryTotals.published - audio),
                /* D-3：容量意識 —— 錄音以 base64 存在資料庫，這裡回總位元組數（前端換算 MB） */
                bytes: audioRows.reduce((sum, row) => sum + (Number(row.bytes) || 0), 0),
                per_unit_limit: AUDIO_MAX_PER_UNIT
            },
            users: { total: users.length, active: users.filter((user) => user.is_active !== false).length, by_role: byRole, two_factor: users.filter((user) => user.totp_enabled_at).length },
            grants: { total: grants.length },
            recent: { days: 7, total: recent.length, by_action: recentByAction },
            per_unit: perUnit.slice().sort((a, b) => b.published - a.published),
            empty_units: emptyUnits.slice(0, 10)
        });
    });

    /* ---------------- 錯誤日誌（A-5） ----------------
     * 前端（還有未來的任何前端）遇到未預期例外時把一筆摘要送上來，後台「🐞 錯誤紀錄」看得到。
     * 設計重點：
     *   - 公開寫入端點 → 一定要節流（A-4）＋ 欄位白名單與長度上限（lib/errorlog.js）
     *   - 不收截圖、不收個資（使用者指定）；只留瀏覽器版本（user-agent）與頁面路徑
     *   - 寫入失敗不影響前端（回 201 但帶 ok:false 不是好主意 → 直接讓它失敗，前端本來就不等結果）
     */
    const ERROR_REPORT_LIMIT = 20;
    const ERROR_REPORT_WINDOW_MS = 60 * 1000;

    app.post('/api/logs/error', async (req, res) => {
        const gate = throttle.allow(`error-report|${req.ip || ''}`, ERROR_REPORT_LIMIT, ERROR_REPORT_WINDOW_MS);
        if (!gate.allowed) {
            res.setHeader('Retry-After', String(Math.ceil(gate.retryAfterMs / 1000)));
            return res.status(429).json({ error: msg('RATE_LIMITED'), code: 'RATE_LIMITED' });
        }
        const body = req.body || {};
        const code = str(body.code, 60);
        const message = str(body.message, 500);
        if (!code && !message) {
            return res.status(400).json({ error: msg('ERROR_REPORT_EMPTY'), code: 'ERROR_REPORT_EMPTY' });
        }
        const row = await errorLog.append({
            source: 'client',
            level: body.level === 'warn' ? 'warn' : 'error',
            code,
            message,
            path: str(body.path, 200),
            version: str(body.version, 20),
            context: body.context,
            user_agent: String(req.headers['user-agent'] || ''),
            user_id: req.user ? req.user.id : null,
            display_name: req.user ? (req.user.display_name || '') : '',
            is_self_test: RequestContext.isSelfTest()
        });
        return res.status(201).json({ ok: true, id: row && row.id !== undefined ? row.id : null });
    });

    app.get('/api/admin/error-logs', requireRole('admin'), async (req, res) => {
        const result = await errorLog.list({
            level: str(req.query.level, 10),
            source: str(req.query.source, 10),
            resolved: req.query.resolved,
            from: str(req.query.from, 10),
            to: str(req.query.to, 10),
            hide_self_test: req.query.hide_self_test === undefined ? true : boolish(req.query.hide_self_test, true),
            limit: req.query.limit,
            offset: req.query.offset
        });
        res.json(result);
    });

    /* 同一個錯誤常常一次來好幾筆（瀏覽器擴充功能、迴圈例外）：一次把同 code+message 的未處理清掉 */
    app.post('/api/admin/error-logs/resolve-similar', requireRole('admin'), async (req, res) => {
        const body = req.body || {};
        const code = str(body.code, 60);
        const message = str(body.message, 500);
        if (!code && !message) {
            return res.status(400).json({ error: msg('ERROR_REPORT_EMPTY'), code: 'ERROR_REPORT_EMPTY' });
        }
        const result = await errorLog.resolveSimilar({ code, message, by: req.user.id, note: '同類一次處理' });
        logAudit(store, {
            user: req.user,
            action: 'ERROR_LOG_RESOLVE_SIMILAR',
            details: `${code}${message ? `：${message.slice(0, 60)}` : ''}（${result.resolved} 筆）`,
            ip: req.ip
        });
        return res.json({ resolved: result.resolved });
    });

    app.patch('/api/admin/error-logs/:id', requireRole('admin'), async (req, res) => {
        const body = req.body || {};
        const updated = await errorLog.resolve(req.params.id, {
            resolved: body.resolved === undefined ? true : boolish(body.resolved, true),
            by: req.user.id,
            note: str(body.note, 200)
        });
        if (!updated) return res.status(404).json({ error: msg('ERROR_LOG_NOT_FOUND'), code: 'ERROR_LOG_NOT_FOUND' });
        logAudit(store, {
            user: req.user,
            action: 'ERROR_LOG_UPDATE',
            targetId: req.params.id,
            details: `錯誤紀錄 #${req.params.id} ${updated.resolved ? '標記已處理' : '標記未處理'}`,
            ip: req.ip
        });
        return res.json({ entry: updated });
    });

    /* ================= 靜態檔與錯誤處理 ================= */
    app.use(express.static(path.join(__dirname, 'public'), {
        index: 'index.html',
        etag: true,
        /* CSS／JS／圖示可以久放（index.html 用 ?v=<版本> 指名版本，改版就換網址）；
         * HTML 一律 no-cache，才不會拿到舊的版本標記。 */
        maxAge: '7d',
        setHeaders(res, filePath) {
            if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
    }));

    app.use('/api', (req, res) => {
        res.status(404).json({ error: msg('API_NOT_FOUND', { method: req.method, path: req.path }), code: 'API_NOT_FOUND', details: { method: req.method, path: req.path } });
    });

    // eslint-disable-next-line no-unused-vars
    app.use(async (err, req, res, next) => {
        if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
            return res.status(400).json({ error: msg('BAD_JSON'), code: 'BAD_JSON' });
        }
        if (err && err.type === 'entity.too.large') {
            return res.status(413).json({ error: msg('TOO_LARGE'), code: 'TOO_LARGE' });
        }
        console.error('[gary-dictionary] 未預期錯誤：', err);
        /* 先寫進錯誤日誌再回覆：serverless 在回應送出後會凍結實例，之後才寫就來不及了 */
        try {
            await errorLog.append(Object.assign({
                source: 'server',
                level: 'error',
                code: 'SERVER',
                message: (err && err.message) || 'unknown error',
                path: String(req.originalUrl || '').split('?')[0],
                version: PACKAGE.version,
                is_self_test: RequestContext.isSelfTest(),
                user_id: req.user ? req.user.id : null,
                display_name: req.user ? (req.user.display_name || '') : '',
                user_agent: String(req.headers['user-agent'] || ''),
                context: { stack: (err && err.stack) ? String(err.stack).split('\n').slice(0, 4).join(' | ') : '' }
            }));
        } catch (logErr) {
            console.error('[errorlog] 寫入失敗：', logErr.message);
        }
        return res.status(500).json({ error: msg('SERVER'), code: 'SERVER' });
    });

    app.locals.store = store;
    app.locals.errorLog = errorLog;
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
        console.log(`資料來源：${process.env.DATA_BACKEND || 'json'}${(process.env.DATA_BACKEND || 'json') === 'supabase' ? '（Supabase 線上資料庫）' : ` → ${path.resolve(dataFile)}`}`);
    });
}
