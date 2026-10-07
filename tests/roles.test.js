/* 角色與權限的守門測試
 * ★ 這一支是「誰能做什麼」的規格書：改 lib/roles.js 的規則時，這裡一定要同步改。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Roles = require('../lib/roles');

const admin = { id: 1, username: 'manager', role: 'admin' };
const owner = { id: 2, username: 'owner', role: 'web_owner' };
const teacher = { id: 3, username: 'teacher', role: 'teacher' };
const rep = { id: 4, username: 'classrep', role: 'class_rep' };
const student = { id: 5, username: 'student', role: 'student' };
const guest = null;

const unit = { id: 10, book_id: 1, unit_no: 1 };

test('角色階梯順序固定', () => {
    assert.deepEqual(Object.keys(Roles.ROLE_LEVELS), ['guest', 'student', 'class_rep', 'teacher', 'admin', 'web_owner']);
    assert.ok(Roles.atLeast('teacher', 'class_rep'));
    assert.ok(!Roles.atLeast('student', 'class_rep'));
    assert.equal(Roles.normalizeRole('不存在'), 'guest');
    assert.equal(Roles.roleLabel('class_rep'), '科代表');
});

test('瀏覽權限：任何人都可以看生字（學生免登入）', () => {
    for (const actor of [guest, student, rep, teacher, admin, owner]) {
        assert.ok(Roles.levelOf(Roles.roleOf(actor)) >= 0);
    }
    assert.equal(Roles.roleOf(guest), 'guest');
});

test('編輯生字：學生與訪客不行，科代表以上可以', () => {
    assert.equal(Roles.canEditUnit(guest, unit, []), false);
    assert.equal(Roles.canEditUnit(student, unit, []), false);
    assert.equal(Roles.canEditUnit(rep, unit, []), true);
    assert.equal(Roles.canEditUnit(teacher, unit, []), true);
    assert.equal(Roles.canEditUnit(admin, unit, []), true);
});

test('科代表的新增要進待審核，老師以上直接發佈', () => {
    assert.equal(Roles.needsReview(rep, unit, []), true);
    assert.equal(Roles.needsReview(teacher, unit, []), false);
    assert.equal(Roles.needsReview(admin, unit, []), false);
    assert.equal(Roles.canPublishUnit(rep, unit, []), false);
    assert.equal(Roles.canPublishUnit(teacher, unit, []), true);
});

test('單元級授權：只給某本書或某個單元也能編輯', () => {
    const otherUnit = { id: 11, book_id: 2, unit_no: 1 };
    const scopedStudent = { id: 6, username: 'helper', role: 'student' };
    const grants = [{ user_id: 6, book_id: null, unit_id: 10, can_edit: true, can_publish: false }];
    assert.equal(Roles.canEditUnit(scopedStudent, unit, grants), true);
    assert.equal(Roles.canEditUnit(scopedStudent, otherUnit, grants), false);
    assert.equal(Roles.canPublishUnit(scopedStudent, unit, grants), false);

    const bookGrant = [{ user_id: 6, book_id: 1, unit_id: null, can_edit: true, can_publish: true }];
    assert.equal(Roles.canEditUnit(scopedStudent, unit, bookGrant), true);
    assert.equal(Roles.canEditUnit(scopedStudent, otherUnit, bookGrant), false);
    assert.equal(Roles.canPublishUnit(scopedStudent, unit, bookGrant), true);
});

test('科代表若被限縮授權，只能編輯被授權的單元', () => {
    const grants = [{ user_id: 4, book_id: 2, unit_id: null, can_edit: true }];
    const inScope = { id: 20, book_id: 2, unit_no: 1 };
    assert.equal(Roles.canEditUnit(rep, inScope, grants), true);
    // 授權清單不為空 → 沒被授權的單元就不能編
    assert.equal(Roles.canEditUnit(rep, unit, grants), false);
});

test('上傳老師錄音：只有老師以上', () => {
    assert.equal(Roles.canUploadAudio(guest), false);
    assert.equal(Roles.canUploadAudio(student), false);
    assert.equal(Roles.canUploadAudio(rep), false);
    assert.equal(Roles.canUploadAudio(teacher), true);
    assert.equal(Roles.canUploadAudio(admin), true);
});

test('使用者管理：admin 以上，且不能管理自己或同級以上', () => {
    assert.equal(Roles.canManageUsers(teacher), false);
    assert.equal(Roles.canManageUsers(admin), true);
    assert.equal(Roles.canManageUsers(owner), true);

    assert.equal(Roles.canManageUser(admin, student), true);
    assert.equal(Roles.canManageUser(admin, admin), false, '不能管理同級');
    assert.equal(Roles.canManageUser(admin, { id: 1, role: 'admin' }), false, '也不能管理自己');
    assert.equal(Roles.canManageUser(owner, admin), true, 'web_owner 可以管理 admin');
    assert.equal(Roles.canManageUser(admin, owner), false, 'admin 不能動 web_owner');
    assert.equal(Roles.canManageUser(owner, { id: 2, role: 'web_owner' }), false, 'web_owner 也是不能改自己');
});

test('建立角色：必須高於目標；web_owner 只能由 web_owner 建立', () => {
    assert.equal(Roles.canCreateRole(admin, 'student'), true);
    assert.equal(Roles.canCreateRole(admin, 'teacher'), true);
    assert.equal(Roles.canCreateRole(admin, 'admin'), false, 'admin 不能建立同級 admin');
    assert.equal(Roles.canCreateRole(admin, 'web_owner'), false);
    assert.equal(Roles.canCreateRole(owner, 'admin'), true);
    assert.equal(Roles.canCreateRole(owner, 'web_owner'), true);
    assert.equal(Roles.canCreateRole(teacher, 'class_rep'), true);
});

test('稽核日誌只有 admin 以上看得到', () => {
    assert.equal(Roles.canViewAudit(teacher), false);
    assert.equal(Roles.canViewAudit(admin), true);
});
