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
            this.data = data;
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
        const res = await fetch(path, init);
        const type = res.headers.get('content-type') || '';
        const data = type.includes('application/json') ? await res.json().catch(() => null) : null;
        if (!res.ok) {
            const message = (data && data.error) || `請求失敗（HTTP ${res.status}）`;
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
