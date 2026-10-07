/* 角色與權限（本專案的唯一權威）
 *
 * ★ 這一支是「誰能做什麼」的唯一真實來源：前端只負責顯示，後端一律用這裡的函式重新判斷。
 *   改規則時一定要同步改 tests/roles.test.js。
 */

const ROLE_LEVELS = {
    guest: 0,
    student: 1,
    class_rep: 2,
    teacher: 3,
    admin: 4,
    web_manager: 5
};

const ROLE_LABELS = {
    guest: '訪客',
    student: '學生',
    class_rep: '科代表',
    teacher: '老師',
    admin: '網頁管理員',
    web_manager: '網站管理員'
};

/* 舊名稱相容：v0.0.1 一開始叫 web_owner，資料庫／舊資料若還有這個值要自動看成 web_manager
 * （少了這一步，舊帳號的角色會被 normalizeRole 判成 guest，等於整個被降權）。 */
const ROLE_ALIASES = {
    web_owner: 'web_manager'
};

// 管理員可以建立／指派的角色（不含 web_manager：那只能由 web_manager 自己建立同級）
const ASSIGNABLE_ROLES = ['student', 'class_rep', 'teacher', 'admin'];

function isKnownRole(role) {
    return Object.prototype.hasOwnProperty.call(ROLE_LEVELS, role);
}

function normalizeRole(role) {
    if (typeof role === 'string' && Object.prototype.hasOwnProperty.call(ROLE_ALIASES, role)) {
        return ROLE_ALIASES[role];
    }
    return isKnownRole(role) ? role : 'guest';
}

function levelOf(role) {
    return ROLE_LEVELS[normalizeRole(role)];
}

function roleLabel(role) {
    return ROLE_LABELS[normalizeRole(role)] || ROLE_LABELS.guest;
}

function atLeast(actorRole, minRole) {
    return levelOf(actorRole) >= levelOf(minRole);
}

/* actor 可以是 null（訪客）、{ role } 或角色字串 */
function roleOf(actor) {
    if (!actor) return 'guest';
    if (typeof actor === 'string') return normalizeRole(actor);
    return normalizeRole(actor.role);
}

/* 建立／指派角色：必須高於目標角色；web_manager 可建立同級（與 competition-manager 同規則） */
function canCreateRole(actor, targetRole) {
    const a = roleOf(actor);
    const t = normalizeRole(targetRole);
    if (!isKnownRole(targetRole)) return false;
    return levelOf(a) > levelOf(t) || (a === 'web_manager' && t === 'web_manager');
}

/* 管理他人帳號（改密碼／改名／停用／刪除）：必須嚴格高於目標，且不能是自己 */
function canManageUser(actor, targetUser) {
    if (!actor || !targetUser) return false;
    if (String(actor.id) === String(targetUser.id)) return false;
    if (roleOf(targetUser) === 'web_manager') return false;
    return levelOf(roleOf(actor)) > levelOf(roleOf(targetUser));
}

/* 使用者被授權的範圍（dict_grants）：可授到整本書或單一單元 */
function grantsFor(actor, grants) {
    if (!actor || !Array.isArray(grants)) return [];
    return grants.filter((g) => String(g.user_id) === String(actor.id));
}

function grantCoversUnit(grant, unit) {
    if (!grant || !unit) return false;
    if (grant.unit_id !== null && grant.unit_id !== undefined) {
        return String(grant.unit_id) === String(unit.id);
    }
    if (grant.book_id !== null && grant.book_id !== undefined) {
        return String(grant.book_id) === String(unit.book_id);
    }
    return false;
}

/* 編輯生字（新增／修改／刪除）：teacher 以上；或被授權該單元（can_edit）的人 */
function canEditUnit(actor, unit, grants) {
    const role = roleOf(actor);
    if (atLeast(role, 'teacher')) return true;
    if (role === 'class_rep') {
        // 科代表預設可以編輯（新增後進待審核）；若有限縮授權則只限被授權的單元
        const scoped = grantsFor(actor, grants || []);
        if (scoped.length === 0) return true;
        return scoped.some((g) => g.can_edit !== false && grantCoversUnit(g, unit));
    }
    const scoped = grantsFor(actor, grants || []);
    return scoped.some((g) => g.can_edit !== false && grantCoversUnit(g, unit));
}

/* 直接發佈（略過審核）：teacher 以上；或被授權 can_publish 的人 */
function canPublishUnit(actor, unit, grants) {
    const role = roleOf(actor);
    if (atLeast(role, 'teacher')) return true;
    const scoped = grantsFor(actor, grants || []);
    return scoped.some((g) => g.can_publish === true && grantCoversUnit(g, unit));
}

/* 寫入時是否需要進「待審核」：不能直接發佈的人一律要審核 */
function needsReview(actor, unit, grants) {
    return !canPublishUnit(actor, unit, grants);
}

/* 使用者管理（建立帳號／改角色／停用／刪除） */
function canManageUsers(actor) {
    return atLeast(roleOf(actor), 'admin');
}

/* 看稽核日誌 */
function canViewAudit(actor) {
    return atLeast(roleOf(actor), 'admin');
}

/* 上傳老師錄音：teacher 以上 */
function canUploadAudio(actor) {
    return atLeast(roleOf(actor), 'teacher');
}

module.exports = {
    ROLE_LEVELS,
    ROLE_LABELS,
    ROLE_ALIASES,
    ASSIGNABLE_ROLES,
    isKnownRole,
    normalizeRole,
    levelOf,
    roleLabel,
    atLeast,
    roleOf,
    canCreateRole,
    canManageUser,
    grantsFor,
    grantCoversUnit,
    canEditUnit,
    canPublishUnit,
    needsReview,
    canManageUsers,
    canViewAudit,
    canUploadAudio
};
