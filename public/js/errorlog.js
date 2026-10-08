/* 前端錯誤回報（A-5）
 *
 * 目的：老師遇到白畫面或按鈕沒反應時，管理員在後台「🐞 錯誤紀錄」看得到原因，
 * 而不是只能靠對方描述。前端只送「摘要」：不送截圖（使用者指定）、不送任何個資，
 * 網址只送 pathname（不帶 query，避免把權杖或參數外流）。
 *
 * 節制原則（很重要，否則會把日誌灌爆、也拖慢前端）：
 *   1. 同一個錯誤訊息 30 秒內只送一次（去重）
 *   2. 每次載入最多送 10 筆
 *   3. 已知的無害噪音不送（TTS 被中斷、ResizeObserver、跨來源 Script error…）
 *   4. 401／403／404 這種「使用者做了不該做的事」不送（那要記在稽核，不是錯誤日誌）；
 *      5xx 要送 —— 那是伺服器真的壞了
 */
(function () {
    const MAX_PER_LOAD = 10;
    const DEDUPE_WINDOW_MS = 30 * 1000;
    const IGNORE = [
        /ResizeObserver loop/i,
        /^Script error\.?$/i,
        /AbortError/i,
        /play\(\) request was interrupted/i,
        /The operation was aborted/i,
        /Load failed|Failed to fetch|NetworkError/i
    ];
    const seen = new Map();
    let sent = 0;
    let reporting = false;

    function version() {
        const label = document.getElementById('versionLabel');
        return label ? String(label.textContent || '').replace(/^v/, '').trim() : '';
    }

    function short(value, max) {
        return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
    }

    function shouldSkip(code, message) {
        if (sent >= MAX_PER_LOAD) return true;
        if (IGNORE.some((pattern) => pattern.test(message))) return true;
        const key = `${code}|${message}`;
        const now = Date.now();
        const last = seen.get(key) || 0;
        if (now - last < DEDUPE_WINDOW_MS) return true;
        seen.set(key, now);
        return false;
    }

    async function send(payload) {
        try {
            await fetch('/api/logs/error', {
                method: 'POST',
                credentials: 'same-origin',
                cache: 'no-store',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } catch (err) {
            /* 回報錯誤時又出錯 → 靜靜放棄（絕不能因此讓畫面更糟） */
        }
    }

    function report(code, message, context) {
        if (reporting) return;                       /* 自己引起的錯誤不要再回報自己 */
        if (shouldSkip(code, message)) return;
        reporting = true;
        sent += 1;
        const payload = {
            code: short(code, 60),
            message: short(message, 500),
            path: window.location.pathname,
            version: version(),
            level: code === 'ASSET_LOAD' ? 'warn' : 'error',
            context: context || null
        };
        Promise.resolve(send(payload)).finally(() => { reporting = false; });
    }

    function install() {
        window.addEventListener('error', (event) => {
            /* 資源載入失敗（<script>/<link> 壞掉）沒有 error 物件，用 target 判斷 */
            const target = event.target;
            if (target && target !== window && target.tagName) {
                const url = String(target.src || target.href || '');
                report('ASSET_LOAD', `${target.tagName} failed to load: ${url.split('?')[0]}`, {
                    tags: target.tagName
                });
                return;
            }
            const err = event.error || {};
            report('UNCAUGHT_ERROR', err.message || event.message || 'uncaught error', {
                line: event.lineno,
                column: event.colno,
                stack: err.stack ? String(err.stack).split('\n').slice(0, 4).join(' | ') : ''
            });
        }, true);

        window.addEventListener('unhandledrejection', (event) => {
            const reason = event.reason || {};
            /* API 的預期錯誤（401／403／404…）交給畫面處理就好，不要當成系統錯誤 */
            if (reason.name === 'ApiError') {
                const status = Number(reason.status) || 0;
                if (status < 500) return;
                report('API_5XX', `${reason.code || 'SERVER'}: ${reason.message || 'server error'}`, { status });
                return;
            }
            report('UNHANDLED_REJECTION', (reason && reason.message) || String(reason), {
                stack: reason && reason.stack ? String(reason.stack).split('\n').slice(0, 4).join(' | ') : ''
            });
        });

        /* CSP 違規是「有東西被擋掉了」的直接證據（畫面通常看起來只是壞掉而已）。
         * ★ 例外：擴充功能（Google 翻譯、深色模式、閱讀模式…）會往頁面注入行內樣式，
         *   這會產生 style-src-elem／style-src-attr 的 'inline' 違規 —— 那不是我們的問題。
         *   可以安全忽略的理由：我們的 CSP 沒有 unsafe-inline，而且 tests/guards.test.js
         *   會擋掉任何行內 style 與 style 屬性，所以這種違規不可能來自本專案的程式碼。
         *   真的自己寫了行內樣式時，守門測試會先紅燈，不會被這裡默默吃掉。 */
        const EXTENSION_INLINE_STYLE = /^style-src-(elem|attr)$/;
        document.addEventListener('securitypolicyviolation', (event) => {
            const directive = event.effectiveDirective || event.violatedDirective || '';
            const blocked = event.blockedURI || '';
            if (EXTENSION_INLINE_STYLE.test(directive) && blocked === 'inline') return;
            report('CSP_VIOLATION', `${directive} blocked ${blocked}`, { directive, blocked });
        });
    }

    window.PDErrorLog = { install, report, stats: () => ({ sent, seen: seen.size }) };
})();
