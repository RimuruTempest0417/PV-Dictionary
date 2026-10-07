/* 與自家後端溝通的唯一入口
 *
 * 憑證在 HttpOnly cookie，前端不需要（也不能）碰權杖：
 * 同源請求會自動帶上 cookie，所以這裡刻意不設 Authorization。
 * 401 與 403 的語意不同，一定要分開處理：
 *   401 = 未登入／憑證失效 → 前端要重新登入
 *   403 = 已登入但權限不足 → 只顯示訊息，絕對不能把人登出
 */
(function () {
    class ApiError extends Error {
        constructor(message, status, data) {
            super(message);
            this.name = 'ApiError';
            this.status = status;
            this.data = data || null;
            /* code 是跨語言溝通用的（前端用 errors.<code> 翻譯）；
             * details 帶插值用的參數（例如重複生字的名稱）。 */
            this.code = (data && data.code) || null;
            this.details = (data && data.details) || null;
        }
    }

    async function request(path, options) {
        const opts = options || {};
        const init = {
            method: opts.method || 'GET',
            credentials: 'same-origin',
            headers: {}
        };
        if (opts.body !== undefined && opts.body !== null) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(opts.body);
        }
        let res;
        try {
            res = await fetch(path, init);
        } catch (err) {
            throw new ApiError('Could not reach the server', 0, { code: 'NETWORK' });
        }
        const type = res.headers.get('content-type') || '';
        const data = type.includes('application/json') ? await res.json().catch(() => null) : null;
        if (!res.ok) {
            const message = (data && data.error) || `HTTP ${res.status}`;
            throw new ApiError(message, res.status, data);
        }
        return data;
    }

    window.PDApi = {
        ApiError,
        request,
        get: (path) => request(path),
        post: (path, body) => request(path, { method: 'POST', body: body || {} }),
        patch: (path, body) => request(path, { method: 'PATCH', body: body || {} }),
        del: (path) => request(path, { method: 'DELETE' })
    };
})();
