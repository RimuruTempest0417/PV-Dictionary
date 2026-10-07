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
        state.user = data.user;
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
        logout,
        get user() {
            return state.user;
        }
    };
})();
