/* 能力（capability）對照表 —— 前後端共用的唯一來源（C-2／C-4）
 *
 * 為什麼要有這一支：
 *   1. /api/auth/me 的 permissions 以前是**手寫**的物件，加了新功能很容易忘了補 → 前端看不到按鈕（或更糟：
 *      看得到按鈕但後端拒絕）。現在改成從這張表產生，前端說明頁的角色對照表也讀同一份 → 不可能各寫一份。
 *   2. 說明頁（B-1）的角色與權限對照表直接讀這張表，所以「文件說得能做、實際不能做」的落差不會發生。
 *   3. tests/permissions.test.js（C-2）逐條拿這裡的 key 去打真實端點，確認前後端一致。
 *
 * ★ 新增能力時：在這裡加一列 + 在 tests/fixtures/permissions.json 加對應的端點，
 *   並在 lib/roles.js 加對應的判斷函式（若只是 atLeast 就不用）。
 */
const Roles = require('./roles');

/* min_role：誰「至少」要有這個角色才有這個能力（判斷一律走 lib/roles.js，不在這裡重寫規則） */
const CAPABILITIES = [
    {
        key: 'can_edit',
        min_role: 'class_rep',
        label_zh: '新增／修改生字',
        label_en: 'Add or edit words',
        note_zh: '科代表以上；被授權的單元也可編輯，且自己的新增會先進「待審核」。',
        note_en: 'Class reps and above; granted units can be edited too, and a class rep\'s changes wait for review.'
    },
    {
        key: 'can_publish',
        min_role: 'teacher',
        label_zh: '直接發佈（略過審核）',
        label_en: 'Publish without review',
        note_zh: '老師以上；或有 can_publish 授權的人。',
        note_en: 'Teachers and above, or someone granted can_publish.'
    },
    {
        key: 'can_manage_content',
        min_role: 'teacher',
        label_zh: '新增／修改書本與單元',
        label_en: 'Add or edit books and units',
        note_zh: '老師以上：建立書本與單元、改單元名稱與編號、上傳書本封面、發佈或下架單元。',
        note_en: 'Teachers and above: create books and units, rename or renumber units, upload covers, publish or unpublish units.'
    },
    {
        key: 'can_upload_audio',
        min_role: 'teacher',
        label_zh: '上傳老師錄音',
        label_en: 'Upload teacher recordings',
        note_zh: '老師以上（錄音是教材品質的關鍵，不開放給科代表）。',
        note_en: 'Teachers and above — recordings decide quality, so class reps cannot upload.'
    },
    {
        key: 'can_manage_users',
        min_role: 'admin',
        label_zh: '帳號管理',
        label_en: 'Manage accounts',
        note_zh: '網頁管理員以上：建立帳號、改角色、停用、重設密碼與兩步驟驗證。',
        note_en: 'Admins and above: create accounts, change roles, disable, reset passwords and 2FA.'
    },
    {
        key: 'can_view_audit',
        min_role: 'admin',
        label_zh: '看稽核紀錄、概況與錯誤紀錄',
        label_en: 'View audit log, overview and error log',
        note_zh: '網頁管理員以上。',
        note_en: 'Admins and above.'
    },
    {
        key: 'can_force_logout',
        min_role: 'web_manager',
        label_zh: '強制登出（單一帳號或全部裝置）',
        label_en: 'Force logout (one account or every device)',
        note_zh: '只有網站管理員：可讓某人的所有裝置登出，也可讓所有帳號的所有裝置一起登出。',
        note_en: 'Site manager only: log out one person\'s devices, or every account on every device.'
    }
];

function capabilityKeys() {
    return CAPABILITIES.map((item) => item.key);
}

function check(key, actor) {
    const item = CAPABILITIES.find((entry) => entry.key === key);
    if (!item) return false;
    if (key === 'can_force_logout') return Roles.roleOf(actor) === 'web_manager';
    return Roles.atLeast(Roles.roleOf(actor), item.min_role);
}

/* /api/auth/me 的 permissions 物件就從這裡產生（不要在 server.js 手寫） */
function permissionsFor(actor) {
    const result = {};
    for (const item of CAPABILITIES) result[item.key] = check(item.key, actor);
    return result;
}

/* 說明頁要用的資料（不含任何個資） */
function describe() {
    return {
        roles: Object.keys(Roles.ROLE_LEVELS).map((role) => ({
            key: role,
            label_zh: Roles.ROLE_LABELS[role],
            label_en: role.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace('Web Manager', 'Site manager').replace('Class Rep', 'Class rep'),
            level: Roles.ROLE_LEVELS[role]
        })),
        capabilities: CAPABILITIES.map((item) => ({
            key: item.key,
            min_role: item.min_role,
            label_zh: item.label_zh,
            label_en: item.label_en,
            note_zh: item.note_zh,
            note_en: item.note_en
        }))
    };
}

module.exports = { CAPABILITIES, capabilityKeys, check, permissionsFor, describe };
