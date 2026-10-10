/* C-2：前後端權限一致性守門
 *
 * 這支測試只做一件事：**讓「誰能做什麼」在文件、前端、後端三邊不可能對不起來**。
 *   1. 逐條拿 tests/fixtures/permissions.json 去打真實端點：低於 min_role 要 401／403，達到就要放行。
 *   2. 能力表（lib/capabilities.js）與 /api/roles 必須一致（前端拿到的能力不能是後端不認得的）。
 *   3. public/js 不得出現硬寫的角色判斷（一律用 PDAuth.can('能力')）—— 這是「看得到按鈕卻按不下去」
 *      與「看不到卻其實能做」的根因。
 *   4. 每一列的能力都必須在能力表裡；每一項能力也都至少要有一列端點，否則新能力會變成沒人守的空殼。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { hashPassword } = require('../lib/passwords');
const Capabilities = require('../lib/capabilities');
const Routes = require('../lib/roles');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'teacher-pass-123';
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'permissions.json'), 'utf8'));
const LEVELS = Routes.ROLE_LEVELS;
const ROLES_IN_ORDER = ['guest', 'student', 'class_rep', 'teacher', 'admin', 'web_manager'];
const LOGIN_AS = { student: 'student', class_rep: 'classrep', teacher: 'teacher', admin: 'manager', web_manager: 'webmanager' };

function startServer(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-perm-'));
    const app = createApp({ backend: 'json', dataFile: path.join(dir, 'store.json') });
    const store = app.locals.store;
    /* LOGIN_AS 的鍵是「角色」、值是「帳號名稱」（別反過來：反了會建出 username=class_rep, role=classrep 的怪帳號） */
    for (const [role, username] of Object.entries(LOGIN_AS)) {
        store.createUser({ username, display_name: username, role, password_hash: hashPassword(PASSWORD), is_active: true });
    }
    /* 專門用來被刪除的臨時帳號（刪除測試放在最後，才不會影響其他列） */
    const victim = store.createUser({ username: 'victim', display_name: 'Victim', role: 'student', password_hash: hashPassword(PASSWORD), is_active: true });
    const book = store.createBook({ code: 'B1', name: 'Book 1', sort_order: 1, is_published: true });
    const unit = store.createUnit({ book_id: book.id, unit_no: 1, title: 'Unit 1', sort_order: 1, is_published: true });
    const entry = store.createEntry({
        unit_id: unit.id, headword: 'campus', headword_norm: 'campus', status: 'published', sort_order: 1, created_by: 'seed'
    });
    /* 兩筆科代表新增、還在待審核的生字（驗證「科代表可以改／刪自己的待審核內容」） */
    const pending = store.createEntry({
        unit_id: unit.id, headword: 'locker', headword_norm: 'locker', status: 'pending', sort_order: 2, created_by: 'classrep'
    });
    const pending2 = store.createEntry({
        unit_id: unit.id, headword: 'canteen', headword_norm: 'canteen', status: 'pending', sort_order: 3, created_by: 'classrep'
    });
    store.createAudio({ entry_id: entry.id, source: 'teacher', mime: 'audio/webm', bytes: 10, data: 'AA' });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => {
        try { server.close(); } catch (err) { /* 已關閉 */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* 忽略 */ }
    });
    return { app, store, base, ids: { book, unit, entry, pending, pending2, victim, audio: store.listAudio({ entryId: entry.id })[0] } };
}

async function cookieFor(base, role) {
    if (role === 'guest') return null;
    const username = LOGIN_AS[role];
    const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: PASSWORD })
    });
    assert.equal(res.status, 200, `${username} 要能登入（權限測試的前提）`);
    return res.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ');
}

/* :user 一律指向「別人」—— 管理別人時不能是自己（測自己會拿到 403，那是正確行為）。
 * 這裡用學生帳號當目標：admin／web_manager 管得動，其他人管不動（剛好也是要驗的界線）。 */
function fillPath(template, ids) {
    return template
        .replace(':pending2', ids.pending2.id)
        .replace(':pending', ids.pending.id)
        .replace(':unit', ids.unit.id)
        .replace(':entry', ids.entry.id)
        .replace(':audio', ids.audio ? ids.audio.id : 1)
        .replace(':book', ids.book.id)
        .replace(':victim', ids.victim.id)
        .replace(':user', ids.targetUserId);
}

test('權限對照表（C-2）：逐條打真實端點，低於門檻要拒絕、達到門檻要放行', async (t) => {
    const app = startServer(t);
    const byUsername = {};
    for (const [role, username] of Object.entries(LOGIN_AS)) {
        const user = app.store.listUsers().find((item) => item.username === username);
        byUsername[role] = user;
    }
    app.ids.targetUserId = byUsername.student.id;    /* 被管理的對象（見 fillPath 的說明） */
    const cookies = {};
    for (const role of ROLES_IN_ORDER) {
        cookies[role] = await cookieFor(app.base, role);
    }
    const failures = [];
    for (const row of FIXTURE.rows) {
        for (const role of ROLES_IN_ORDER) {
            const allowed = LEVELS[role] >= LEVELS[row.min_role];
            const headers = { 'Content-Type': 'application/json' };
            if (cookies[role]) headers.Cookie = cookies[role];
            const res = await fetch(`${app.base}${fillPath(row.path, app.ids)}`, {
                method: row.method,
                headers,
                body: row.method === 'GET' || row.method === 'DELETE' ? undefined : JSON.stringify(row.body || {})
            });
            const denied = res.status === 401 || res.status === 403;
            if (allowed && denied) failures.push(`${row.id}（${row.method} ${row.path}）：${role} 應該可以，卻被拒 ${res.status}`);
            if (!allowed && !denied) failures.push(`${row.id}（${row.method} ${row.path}）：${role} 應該被拒，卻通過了 ${res.status}`);
        }
    }
    assert.deepEqual(failures, [], failures.join('\n'));
});

test('權限對照表（C-2）：每一列的 min_role 等於能力表說的角色', async () => {
    const table = {};
    for (const item of Capabilities.CAPABILITIES) table[item.key] = item.min_role;
    for (const row of FIXTURE.rows) {
        if (!row.capability) continue;
        assert.ok(table[row.capability], `${row.id} 用了不存在的能力 ${row.capability}`);
        assert.equal(row.min_role, table[row.capability], `${row.id} 的 min_role 要跟能力表一致（${table[row.capability]}）`);
    }
});

test('權限對照表（C-2）：能力表沒有孤兒、端點也沒有漏', async () => {
    const used = new Set(FIXTURE.rows.map((row) => row.capability).filter(Boolean));
    for (const item of Capabilities.CAPABILITIES) {
        assert.ok(used.has(item.key), `能力 ${item.key} 沒有任何端點在守（請在 permissions.json 補一列）`);
    }
    /* /api/auth/me 回的能力要跟能力表完全一樣（前端不會拿到後端不認得的能力） */
    const me = Capabilities.permissionsFor({ role: 'web_manager' });
    assert.deepEqual(Object.keys(me).sort(), Capabilities.capabilityKeys().sort());
});

test('權限對照表（C-2）：前端不得硬寫角色，一律用能力（且要真的存在）', async () => {
    const files = fs.readdirSync(path.join(ROOT, 'public', 'js')).filter((name) => name.endsWith('.js') && name !== 'auth.js');
    const hardcoded = [];
    const unknownCapabilities = new Set();
    const known = new Set(Capabilities.capabilityKeys());
    for (const name of files) {
        const source = fs.readFileSync(path.join(ROOT, 'public', 'js', name), 'utf8');
        source.split('\n').forEach((line, index) => {
            if (/PDAuth\.atLeast\(/.test(line)) hardcoded.push(`${name}:${index + 1} ${line.trim()}`);
            for (const match of line.matchAll(/PDAuth\.can\('([^']+)'\)/g)) {
                if (!known.has(match[1])) unknownCapabilities.add(`${name}:${index + 1} → ${match[1]}`);
            }
        });
    }
    assert.deepEqual(hardcoded, [], `前端出現硬寫的角色判斷（請改用 PDAuth.can('能力')，並在 lib/capabilities.js 定義）：\n${hardcoded.join('\n')}`);
    assert.deepEqual([...unknownCapabilities], [], `前端用了能力表沒有的能力（後端永遠不會給）：\n${[...unknownCapabilities].join('\n')}`);
});

test('權限對照表（C-2）：說明頁的角色表就是後端那一份（不是前端自己寫的）', async (t) => {
    const app = startServer(t);
    const data = await (await fetch(`${app.base}/api/roles`)).json();
    assert.equal(data.capabilities.length, Capabilities.CAPABILITIES.length, '能力數量要一致');
    const guide = fs.readFileSync(path.join(ROOT, 'public', 'js', 'guide.js'), 'utf8');
    /* guide.js 可以提到能力「名稱」（那是它要說明的主題），但不可以自己寫角色 → 能力 的對照表 */
    assert.equal(/min_role\s*:/.test(guide), false, 'guide.js 不可以自己寫 min_role 對照表，要讀 /api/roles');
    assert.equal(/CAPABILITIES\s*=/.test(guide), false, 'guide.js 不可以自己定義能力表');
    assert.match(guide, /\/api\/roles/, 'guide.js 要從 /api/roles 取得角色與能力');
});

test('權限對照表（C-2）：每一列指的 UI 元素與能力判斷都真的存在', async () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const files = fs.readdirSync(path.join(ROOT, 'public', 'js')).filter((name) => name.endsWith('.js'));
    const allJs = files.map((name) => fs.readFileSync(path.join(ROOT, 'public', 'js', name), 'utf8')).join('\n');
    const missing = [];
    for (const row of FIXTURE.rows) {
        if (row.ui.element && !html.includes(`id="${row.ui.element}"`)) missing.push(`${row.id}: index.html 少了 #${row.ui.element}`);
        if (row.ui.gate && !allJs.includes(`PDAuth.${row.ui.gate}`)) missing.push(`${row.id}: 前端找不到 PDAuth.${row.ui.gate}`);
    }
    assert.deepEqual(missing, [], missing.join('\n'));
});

/* ★ D-10（v0.11.0）：把「被授權的人」也算進能力，前後端不再各說一套。
 *
 * 修之前：後端 Roles.canEditUnit 認授權（被授權的學生編得動），但 Capabilities.check 只看角色
 *   → /api/auth/me 回 can_edit:false → 前端把新增／修改按鈕藏起來（README 寫的卻是「被授權的人可以加入生字」）。
 * 這裡從頭到尾走一遍真實流程：沒授權 → 有授權 → 打 API 真的編得動，確認三邊一致。 */
test('權限對照表（C-2）／D-10：被授權的學生，能力說可以、後端也真的編得動', async (t) => {
    const app = startServer(t);
    const student = app.store.listUsers().find((user) => user.username === LOGIN_AS.student);
    const adminCookie = await cookieFor(app.base, 'admin');
    const studentCookie = await cookieFor(app.base, 'student');
    const me = async () => (await fetch(`${app.base}/api/auth/me`, { headers: { Cookie: studentCookie } })).json();

    /* (1) 還沒有授權：能力是 false（前端不顯示按鈕） */
    const before = await me();
    assert.equal(before.permissions.can_edit, false, '沒被授權的學生不該有 can_edit');
    assert.equal(before.grants.length, 0, '不該有授權列');

    /* (2) 管理員建立「這個單元可編輯」的授權（走真實 API，預設 can_edit=true） */
    const created = await fetch(`${app.base}/api/admin/grants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ user_id: student.id, unit_id: app.ids.unit.id })
    });
    assert.equal(created.status, 201, '管理員要能建立授權');

    /* (3) 有了授權：能力要變成 true（這就是 D-10 修的點） */
    const after = await me();
    assert.equal(after.permissions.can_edit, true, '被授權的學生要有 can_edit（前端才會顯示按鈕）');
    assert.equal(after.grants.length, 1, '/api/auth/me 要同時回授權內容');

    /* (4) 而且真的編得動（後端本來就允許；現在能力與 UI 也一致了） */
    const post = await fetch(`${app.base}/api/units/${app.ids.unit.id}/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
        body: JSON.stringify({ headword: 'granted-word', zh_meaning: '被授權新增的字' })
    });
    assert.equal(post.status, 201, '被授權的學生要能新增生字');
    const body = await post.json();
    assert.equal(body.entry.status, 'pending', '不能直接發佈的人，新增一律先進待審核');

    /* (5) 單元頁也要回 can_edit:true（前端據此顯示編輯 UI） */
    const unitRes = await (await fetch(`${app.base}/api/units/${app.ids.unit.id}?per_page=50`, { headers: { Cookie: studentCookie } })).json();
    assert.equal(unitRes.can_edit, true, '單元頁的 can_edit 要跟 /api/auth/me 說的一致');
    assert.ok(unitRes.entries.some((entry) => entry.headword === 'granted-word' && entry.status === 'pending'),
        '被授權者要能看到自己送出的待審核生字');

    /* (6) 相對地：can_publish 不會因為「有授權列」就變 true（它要明確 true 才算，與 canPublishUnit 同規則） */
    const publishCheck = Capabilities.permissionsFor(
        { id: student.id, role: 'student' },
        { grants: [{ user_id: student.id, unit_id: app.ids.unit.id, can_edit: true, can_publish: false }] }
    );
    assert.equal(publishCheck.can_publish, false, 'can_edit 授權不該順便給 can_publish');
});

/* ★ B-8（v0.12.0）：刪除年級／單元 —— 兩段式確認，而且「裡面還有東西」時只有網站管理員刪得掉。
 * 這是刻意設計的保護：生字與錄音是老師的心血，不能讓任何一個老師隨手清掉。 */
test('權限對照表（C-2）／B-8：刪除單元／年級 —— 兩段式確認、有內容只有網站管理員', async (t) => {
    const app = startServer(t);
    const teacher = await cookieFor(app.base, 'teacher');
    const owner = await cookieFor(app.base, 'web_manager');
    const unitId = app.ids.unit.id;        /* 這個單元裡有生字（campus 等）與一筆老師錄音 */

    /* (1) 預覽：看得見「會連帶刪掉多少」，並明講需不需要網站管理員 */
    const preview = await (await fetch(`${app.base}/api/units/${unitId}/delete-preview`, { headers: { Cookie: teacher } })).json();
    assert.ok(preview.counts.entries >= 3, '預覽要回報連帶刪掉的生字數');
    assert.equal(preview.counts.audio, 1, '預覽要回報連帶刪掉的錄音數');
    assert.equal(preview.requires_site_manager, true, '裡面有東西 → 需要網站管理員');

    /* (2) 老師（有 can_manage_content）想直接刪掉有內容的單元 → 403，連帶 confirm 也不行 */
    const denied = await fetch(`${app.base}/api/units/${unitId}?confirm=1`, { method: 'DELETE', headers: { Cookie: teacher } });
    assert.equal(denied.status, 403, '有生字的單元老師不能刪');
    assert.ok(app.store.getUnit(unitId), '被拒絕時不可以刪掉任何東西');

    /* (3) 網站管理員但沒有帶 confirm → 409（兩段式），資料還在 */
    const needsConfirm = await fetch(`${app.base}/api/units/${unitId}`, { method: 'DELETE', headers: { Cookie: owner } });
    assert.equal(needsConfirm.status, 409, '沒有確認過就不能刪');
    assert.ok(app.store.getUnit(unitId), '沒確認之前不可以刪');

    /* (4) 網站管理員帶 confirm → 真的刪掉（生字與錄音一起） */
    const done = await fetch(`${app.base}/api/units/${unitId}?confirm=1`, { method: 'DELETE', headers: { Cookie: owner } });
    assert.equal(done.status, 200, '網站管理員要能刪掉有內容的單元');
    assert.equal(app.store.getUnit(unitId), null, '單元要真的消失');
    assert.deepEqual(app.store.listEntries({ unitId }), [], '生字要一起刪掉');
    assert.deepEqual(app.store.listAudio({ entryId: app.ids.entry.id }), [], '錄音要一起刪掉');

    /* (5) 稽核要留一筆（誰在什麼時候刪了什麼、連帶刪掉多少） */
    const logsRaw = app.store.listAuditLogs({});
    const logs = Array.isArray(logsRaw) ? logsRaw : (logsRaw.items || logsRaw.rows || []);
    const audit = logs.filter((row) => row.action === 'UNIT_DELETE');
    assert.equal(audit.length, 1, '刪除要留稽核紀錄');
    assert.match(audit[0].details, /生字 \d+/, '稽核要寫出連帶刪掉幾個生字');

    /* (6) 空年級：老師就能刪（不需要網站管理員） */
    const emptyBook = app.store.createBook({ code: 'EMPTY9', name: 'Empty 9', grade: 'S9', sort_order: 9, is_published: true });
    const emptyPreview = await (await fetch(`${app.base}/api/books/${emptyBook.id}/delete-preview`, { headers: { Cookie: teacher } })).json();
    assert.equal(emptyPreview.requires_site_manager, false, '空的年級老師就能刪');
    const emptyDelete = await fetch(`${app.base}/api/books/${emptyBook.id}?confirm=1`, { method: 'DELETE', headers: { Cookie: teacher } });
    assert.equal(emptyDelete.status, 200, '空的年級老師要刪得掉');
    assert.equal(app.store.getBook(emptyBook.id), null, '年級要真的消失');
});
