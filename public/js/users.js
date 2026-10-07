/* 帳號管理與授權管理（v0.1.0）
 *
 * ★ 前端只負責「顯示」：把按鈕藏起來不等於有權限，所有判斷都在 /api/admin/* 重新做一次。
 * ★ 這裡完全沒有 innerHTML：帳號、顯示名稱都是使用者輸入，一律走 textContent（見 ui.js 的 el）。
 */
(function () {
    const { el, clear, toast, setFormMessage, formatDateTime } = window.PDUI;
    const t = (key, vars) => window.PDI18n.t(key, vars);
    const errText = (err) => window.PDI18n.errorMessage(err);

    const state = {
        users: [],
        grants: [],
        assignable: [],
        roleLevels: {},
        loaded: false
    };
    /* 兩段式確認（刪除）與行內重設密碼：都放在模組狀態，
     * 因為每次重畫都會重建 DOM，狀態不能存在 DOM 上。 */
    let armed = null;            // 'user:3' | 'grant:7'
    let resetting = null;        // 正在重設密碼的使用者 id
    let formMode = null;         // 'create' | 'edit'

    function canSee() {
        return Boolean(window.PDAuth.user) && window.PDAuth.can('can_manage_users');
    }

    /* ---------------- 資料 ---------------- */

    async function load() {
        const [users, grants] = await Promise.all([
            window.PDApi.get('/api/admin/users'),
            window.PDApi.get('/api/admin/grants')
        ]);
        state.users = users.users || [];
        state.assignable = users.assignable_roles || [];
        state.roleLevels = users.role_levels || {};
        state.canAssignAdmin = Boolean(users.can_assign_admin);
        state.grants = grants.grants || [];
        state.loaded = true;
    }

    /* 角色選項：可指派的角色 + 該帳號目前的角色（免得選單看不到自己現在的職位） */
    function roleOptions(selected) {
        const values = state.assignable.map((r) => r.value);
        if (selected && !values.includes(selected)) values.push(selected);
        return values.map((role) => el('option', {
            text: window.PDI18n.roleLabel(role),
            attrs: { value: role, selected: role === selected ? true : null }
        }));
    }

    /* ---------------- 帳號列表 ---------------- */

    function actionButtons(user) {
        const buttons = [];
        const armKey = `user:${user.id}`;
        const isArmed = armed === armKey;
        if (user.can_manage) {
            buttons.push(el('button', {
                class: 'btn btn-ghost btn-small',
                text: t('users.editName'),
                attrs: { type: 'button', 'data-action': 'edit-user' },
                on: { click: () => openUserForm('edit', user) }
            }));
        }
        if (user.can_manage || user.is_self) {
            buttons.push(el('button', {
                class: 'btn btn-ghost btn-small',
                text: t('users.resetPassword'),
                attrs: { type: 'button', 'data-action': 'reset-password' },
                on: { click: () => { armed = null; resetting = resetting === user.id ? null : user.id; render(); } }
            }));
        }
        if (user.can_manage) {
            buttons.push(el('button', {
                class: 'btn btn-ghost btn-small',
                text: user.is_active ? t('users.disable') : t('users.enable'),
                attrs: { type: 'button', 'data-action': 'toggle-active' },
                on: { click: () => toggleActive(user) }
            }));
            buttons.push(el('button', {
                class: isArmed ? 'btn btn-danger btn-small' : 'btn btn-ghost btn-small',
                text: isArmed ? t('users.deleteConfirm') : t('users.delete'),
                attrs: { type: 'button', 'data-action': 'delete-user' },
                on: { click: () => deleteUser(user, isArmed) }
            }));
        }
        return buttons;
    }

    function resetRow(user) {
        const input = el('input', {
            class: 'inline-input',
            attrs: { type: 'password', maxlength: '64', autocomplete: 'new-password', 'data-field': 'new-password', placeholder: t('users.newPassword') }
        });
        return el('tr', { class: 'row-sub' }, [
            el('td', { attrs: { colspan: '6' } }, [
                el('div', { class: 'row-sub-inner' }, [
                    el('span', { class: 'cell-hint', text: `${user.username} · ${t('users.newPassword')}` }),
                    input,
                    el('button', {
                        class: 'btn btn-primary btn-small',
                        text: t('entry.save'),
                        attrs: { type: 'button', 'data-action': 'save-password' },
                        on: { click: () => savePassword(user, input) }
                    }),
                    el('button', {
                        class: 'btn btn-ghost btn-small',
                        text: t('entry.cancel'),
                        attrs: { type: 'button', 'data-action': 'cancel-password' },
                        on: { click: () => { resetting = null; render(); } }
                    }),
                    el('span', { class: 'form-msg', attrs: { id: 'rowPasswordMsg', role: 'status' } })
                ])
            ])
        ]);
    }

    function renderUsers() {
        const body = document.getElementById('usersTableBody');
        clear(body);
        for (const user of state.users) {
            body.appendChild(el('tr', {}, [
                el('td', {}, [
                    el('strong', { text: user.username }),
                    user.is_self ? el('span', { class: 'badge', text: t('users.self') }) : null,
                    el('div', { class: 'cell-hint', text: t('users.grantHint', { n: user.grant_count || 0 }) })
                ]),
                el('td', { text: user.display_name || '—' }),
                el('td', {}, [roleCell(user)]),
                el('td', {}, [el('span', {
                    class: user.is_active ? 'badge is-ok' : 'badge is-off',
                    text: user.is_active ? t('users.active') : t('users.inactive')
                })]),
                el('td', { text: user.last_login_at ? formatDateTime(user.last_login_at) : t('users.never') }),
                el('td', { class: 'cell-actions' }, actionButtons(user))
            ]));
            if (resetting === user.id) body.appendChild(resetRow(user));
        }
        if (!state.users.length) {
            body.appendChild(el('tr', {}, [el('td', { attrs: { colspan: '6' }, text: t('users.empty') })]));
        }
    }

    function roleCell(user) {
        if (!user.can_change_role) {
            return el('span', { class: 'cell-hint', text: window.PDI18n.roleLabel(user.role), attrs: { title: t('users.roleLocked') } });
        }
        const select = el('select', {
            class: 'inline-select',
            attrs: { 'data-action': 'role', 'data-user-id': user.id, 'aria-label': t('users.colRole') }
        }, roleOptions(user.role));
        select.value = user.role;
        select.addEventListener('change', async () => {
            try {
                await window.PDApi.patch(`/api/admin/users/${user.id}`, { role: select.value });
                toast(t('users.roleChanged'));
                await load();
                render();
            } catch (err) {
                toast(errText(err), 'error');
                select.value = user.role;
            }
        });
        return select;
    }

    /* ---------------- 帳號操作 ---------------- */

    async function toggleActive(user) {
        try {
            await window.PDApi.patch(`/api/admin/users/${user.id}`, { is_active: !user.is_active });
            toast(t('users.updated'));
            await load();
            render();
        } catch (err) {
            toast(errText(err), 'error');
        }
    }

    async function savePassword(user, input) {
        const message = document.getElementById('rowPasswordMsg');
        try {
            await window.PDApi.patch(`/api/admin/users/${user.id}`, { password: input.value });
            /* 成功就收起來：留在畫面上會讓人以為沒送出去（而且訊息節點會跟著重畫消失） */
            resetting = null;
            render();
            toast(t('users.updated'));
        } catch (err) {
            setFormMessage(message, errText(err), 'error');
        }
    }

    async function deleteUser(user, confirmed) {
        if (!confirmed) {
            armed = `user:${user.id}`;
            render();
            return;
        }
        try {
            await window.PDApi.del(`/api/admin/users/${user.id}`);
            armed = null;
            resetting = null;
            toast(t('users.deleted'));
            await load();
            render();
        } catch (err) {
            toast(errText(err), 'error');
            armed = null;
            render();
        }
    }

    /* ---------------- 建立／改名表單 ---------------- */

    function openUserForm(mode, user) {
        formMode = mode;
        const isCreate = mode === 'create';
        document.getElementById('userFormTitle').textContent = isCreate ? t('users.create') : t('users.editName');
        document.getElementById('fUserId').value = user ? user.id : '';
        document.getElementById('fUsername').value = user ? user.username : '';
        document.getElementById('fUsername').disabled = !isCreate;
        document.getElementById('fDisplayName').value = user ? (user.display_name || '') : '';
        document.getElementById('fPassword').value = '';
        document.getElementById('userUsernameField').hidden = !isCreate;
        document.getElementById('userPasswordField').hidden = !isCreate;
        document.getElementById('userRoleField').hidden = !isCreate;
        const roleSelect = document.getElementById('fUserRole');
        clear(roleSelect);
        if (isCreate) {
            for (const option of roleOptions('')) roleSelect.appendChild(option);
            roleSelect.value = state.assignable.some((r) => r.value === 'class_rep') ? 'class_rep' : (state.assignable[0] || {}).value || 'student';
        }
        setFormMessage(document.getElementById('userFormMsg'), '');
        document.getElementById('userForm').hidden = false;
        (isCreate ? document.getElementById('fUsername') : document.getElementById('fDisplayName')).focus();
    }

    function closeUserForm() {
        formMode = null;
        document.getElementById('userForm').hidden = true;
        setFormMessage(document.getElementById('userFormMsg'), '');
    }

    async function submitUserForm(event) {
        event.preventDefault();
        const message = document.getElementById('userFormMsg');
        const id = document.getElementById('fUserId').value;
        try {
            if (formMode === 'create') {
                await window.PDApi.post('/api/admin/users', {
                    username: document.getElementById('fUsername').value.trim(),
                    display_name: document.getElementById('fDisplayName').value.trim(),
                    password: document.getElementById('fPassword').value,
                    role: document.getElementById('fUserRole').value
                });
                toast(t('users.created'));
            } else {
                await window.PDApi.patch(`/api/admin/users/${id}`, {
                    display_name: document.getElementById('fDisplayName').value.trim()
                });
                toast(t('users.updated'));
            }
            closeUserForm();
            await load();
            render();
        } catch (err) {
            setFormMessage(message, errText(err), 'error');
        }
    }

    /* ---------------- 授權 ---------------- */

    function scopeLabel(grant) {
        if (grant.unit_label) return grant.unit_label;
        if (grant.book_name) return grant.book_name;
        return '—';
    }

    function renderGrants() {
        const list = document.getElementById('grantsList');
        clear(list);
        if (!state.grants.length) {
            list.appendChild(el('li', { class: 'grant-empty', text: t('grants.empty') }));
            return;
        }
        for (const grant of state.grants) {
            const armKey = `grant:${grant.id}`;
            const isArmed = armed === armKey;
            list.appendChild(el('li', { class: 'grant-item' }, [
                el('div', { class: 'grant-main' }, [
                    el('strong', { text: grant.username }),
                    el('span', { class: 'grant-scope', text: `${grant.book_name || ''}${grant.unit_label ? ` · ${grant.unit_label}` : ''}` }),
                    el('span', {
                        class: grant.can_publish ? 'badge is-ok' : 'badge',
                        text: grant.can_publish ? t('grants.editPublish') : t('grants.editOnly')
                    }),
                    el('span', { class: 'cell-hint', text: `${t('grants.colGrantedBy')}: ${grant.granted_by || '—'}` })
                ]),
                el('button', {
                    class: isArmed ? 'btn btn-danger btn-small' : 'btn btn-ghost btn-small',
                    text: isArmed ? t('users.deleteConfirm') : t('grants.remove'),
                    attrs: { type: 'button', 'data-action': 'delete-grant', 'data-grant-id': grant.id },
                    on: { click: () => deleteGrant(grant, isArmed) }
                })
            ]));
        }
    }

    async function deleteGrant(grant, confirmed) {
        if (!confirmed) {
            armed = `grant:${grant.id}`;
            render();
            return;
        }
        try {
            await window.PDApi.del(`/api/admin/grants/${grant.id}`);
            armed = null;
            toast(t('grants.removed'));
            await load();
            render();
        } catch (err) {
            toast(errText(err), 'error');
            armed = null;
            render();
        }
    }

    function fillGrantSelects() {
        const userSelect = document.getElementById('fGrantUser');
        clear(userSelect);
        for (const user of state.users) {
            userSelect.appendChild(el('option', {
                text: `${user.username}${user.display_name ? ` (${user.display_name})` : ''}`,
                attrs: { value: user.id }
            }));
        }
        const bookSelect = document.getElementById('fGrantBook');
        const books = window.PDState.books || [];
        clear(bookSelect);
        for (const book of books) {
            bookSelect.appendChild(el('option', { text: `${book.name}${book.grade ? ` · ${book.grade}` : ''}`, attrs: { value: book.id } }));
        }
        if (!books.length) bookSelect.appendChild(el('option', { text: t('grants.selectBook'), attrs: { value: '' } }));
        fillUnitSelect();
    }

    async function fillUnitSelect() {
        const unitSelect = document.getElementById('fGrantUnit');
        clear(unitSelect);
        const bookId = document.getElementById('fGrantBook').value;
        if (!bookId) return;
        try {
            const data = await window.PDApi.get(`/api/books/${bookId}/units`);
            const units = (data.units || []);
            for (const unit of units) {
                unitSelect.appendChild(el('option', {
                    text: `Unit ${unit.unit_no}${unit.title ? ` ${unit.title}` : ''}`,
                    attrs: { value: unit.id }
                }));
            }
            if (!units.length) unitSelect.appendChild(el('option', { text: t('grants.selectUnit'), attrs: { value: '' } }));
        } catch (err) {
            unitSelect.appendChild(el('option', { text: errText(err), attrs: { value: '' } }));
        }
    }

    function syncScopeFields() {
        const isUnit = document.getElementById('fGrantScope').value === 'unit';
        document.getElementById('grantUnitField').hidden = !isUnit;
        document.getElementById('grantBookField').hidden = false;
    }

    async function submitGrant(event) {
        event.preventDefault();
        const message = document.getElementById('grantMsg');
        const isUnit = document.getElementById('fGrantScope').value === 'unit';
        const bookId = document.getElementById('fGrantBook').value || null;
        try {
            await window.PDApi.post('/api/admin/grants', {
                user_id: document.getElementById('fGrantUser').value,
                book_id: isUnit ? null : bookId,
                unit_id: isUnit ? (document.getElementById('fGrantUnit').value || null) : null,
                can_edit: true,
                can_publish: document.getElementById('fGrantPublish').checked
            });
            toast(t('grants.created'));
            document.getElementById('grantForm').hidden = true;
            setFormMessage(message, '');
            await load();
            render();
        } catch (err) {
            setFormMessage(message, errText(err), 'error');
        }
    }

    /* ---------------- 畫面 ---------------- */

    function render() {
        renderUsers();
        renderGrants();
    }

    async function refresh() {
        if (!canSee()) return false;
        try {
            await load();
            fillGrantSelects();
            render();
            return true;
        } catch (err) {
            toast(errText(err), 'error');
            return false;
        }
    }

    function init() {
        document.getElementById('usersRefreshBtn').addEventListener('click', () => refresh());
        document.getElementById('grantsRefreshBtn').addEventListener('click', () => refresh());
        document.getElementById('newUserBtn').addEventListener('click', () => openUserForm('create', null));
        document.getElementById('userCancelBtn').addEventListener('click', closeUserForm);
        document.getElementById('userForm').addEventListener('submit', submitUserForm);
        document.getElementById('newGrantBtn').addEventListener('click', () => {
            document.getElementById('grantForm').hidden = false;
            fillGrantSelects();
            syncScopeFields();
        });
        document.getElementById('grantCancelBtn').addEventListener('click', () => {
            document.getElementById('grantForm').hidden = true;
            setFormMessage(document.getElementById('grantMsg'), '');
        });
        document.getElementById('grantForm').addEventListener('submit', submitGrant);
        document.getElementById('fGrantScope').addEventListener('change', syncScopeFields);
        document.getElementById('fGrantBook').addEventListener('change', fillUnitSelect);
        syncScopeFields();
    }

    window.PDUsers = { init, refresh, render, state, canSee };
})();
