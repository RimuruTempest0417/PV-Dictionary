/* 登入／登出與身分顯示
 * - 憑證在 HttpOnly cookie，前端只記「伺服器說我是誰」（實際權限每次都問伺服器）。
 * - 學生不需要登入；訪客只能瀏覽與聽讀音。
 */
(function () {
    const state = {
        user: null,
        permissions: {},
        grants: []
    };

    function isLoggedIn() {
        return Boolean(state.user);
    }

    function can(permission) {
        return Boolean(state.permissions && state.permissions[permission]);
    }

    function atLeast(role) {
        const levels = { guest: 0, student: 1, class_rep: 2, teacher: 3, admin: 4, web_manager: 5 };
        const mine = state.user ? (levels[state.user.role] || 0) : 0;
        return mine >= (levels[role] || 0);
    }

    async function loadMe() {
        try {
            const data = await window.PDApi.get('/api/auth/me');
            state.user = data.user;
            state.permissions = data.permissions || {};
            state.grants = data.grants || [];
        } catch (err) {
            if (err.status !== 401) throw err;
            state.user = null;
            state.permissions = {};
            state.grants = [];
        }
        return state.user;
    }

    async function login(username, password) {
        const data = await window.PDApi.post('/api/auth/login', { username, password });
        /* 兩步驟驗證（A-1）：密碼對了但還沒完成第二步 —— 中間權杖只留在記憶體，不寫任何儲存。
         * 它不能拿來呼叫 API（後端會拒），所以外洩的風險僅限這 5 分鐘且什麼都不能做。 */
        if (data && data.two_factor_required) {
            state.challenge = data.challenge_token || '';
            state.challengeName = username;
            return { two_factor_required: true };
        }
        state.user = data.user;
        state.newDevice = Boolean(data.new_device);
        await loadMe();
        return state.user;
    }

    /* 第二步：6 位驗證碼或一組備援碼（後端兩種都收，這裡依格式決定送哪一種） */
    async function loginTwoFactor(code) {
        const value = String(code || '').trim();
        const body = { challenge_token: state.challenge || '' };
        if (/^\d{6}$/.test(value)) body.code = value;
        else body.backup_code = value;
        const data = await window.PDApi.post('/api/auth/login/2fa', body);
        state.challenge = '';
        state.challengeName = '';
        state.user = data.user;
        state.newDevice = Boolean(data.new_device);
        await loadMe();
        return state.user;
    }

    async function logout() {
        try {
            await window.PDApi.post('/api/auth/logout', {});
        } finally {
            state.user = null;
            state.permissions = {};
            state.grants = [];
        }
    }

    window.PDAuth = {
        state,
        isLoggedIn,
        can,
        atLeast,
        loadMe,
        login,
        loginTwoFactor,
        logout,
        get user() {
            return state.user;
        }
    };
})();
