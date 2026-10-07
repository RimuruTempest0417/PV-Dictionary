/* 建立示範資料與種子帳號
 *
 * 用法：
 *   npm run seed              建立缺少的書本／單元／生字與帳號（已存在的不動）
 *   npm run seed -- --reset   先把資料檔清空再建立
 *
 * 密碼：從 .env 的 SEED_*_PASSWORD 讀取；沒有就隨機產生一組並「只寫進 .env」，
 *       終端機不印出密碼（要看請自行開 .env）。
 */
require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { createStore, normalizeHeadword } = require('../lib/store');
const { hashPassword } = require('../lib/passwords');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const DATA_FILE = path.resolve(ROOT, process.env.DATA_FILE || 'data/store.json');
const RESET = process.argv.includes('--reset');
/* 預設「只建立帳號、不建立任何生字」：使用者要用自己的真實內容從零開始填。
 * 要載入示範教材（2 本 × 3 單元 × 6 生字）給人看效果時，才加 --with-sample。 */
const WITH_SAMPLE = process.argv.includes('--with-sample');
/* 只留下網站管理員帳號（連授權一起清掉），資料完全不動 */
const PRUNE_ACCOUNTS = process.argv.includes('--prune-accounts');
/* 預設只建網站管理員；要其他示範帳號才加這兩個 */
const WITH_ADMIN = process.argv.includes('--with-admin');
const WITH_TEAM = process.argv.includes('--with-team');

/* ---------------- .env 輔助 ---------------- */
function readEnvFile() {
    if (!fs.existsSync(ENV_FILE)) return {};
    const out = {};
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
        const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (match) out[match[1]] = match[2];
    }
    return out;
}

function appendEnv(key, value) {
    const line = `${key}=${value}\n`;
    fs.appendFileSync(ENV_FILE, line, 'utf8');
    process.env[key] = value;
}

function ensureEnv(key, generate) {
    const fileEnv = readEnvFile();
    if (process.env[key]) return process.env[key];
    if (fileEnv[key]) {
        process.env[key] = fileEnv[key];
        return fileEnv[key];
    }
    const value = generate();
    appendEnv(key, value);
    return value;
}

const randomPassword = () => crypto.randomBytes(9).toString('base64url');

/* ---------------- 示範課本 ---------------- */
const BOOKS = [
    {
        code: 'B5A',
        name: 'Book 5A',
        grade: 'S1',
        publisher: '示範教材',
        units: [
            {
                unit_no: 1,
                title: 'My New School',
                entries: [
                    ['campus', '/ˈkæm.pəs/', 'n.', '校園', 'the land and buildings of a school or university', 'Our campus is next to the park.', '我們的校園在公園旁邊。'],
                    ['librarian', '/laɪˈbreə.ri.ən/', 'n.', '圖書館員', 'a person who works in a library', 'The librarian helped me find the book.', '圖書館員幫我找到那本書。'],
                    ['timetable', '/ˈtaɪmˌteɪ.bəl/', 'n.', '時間表', 'a list of the times when classes happen', 'Check the timetable before Monday.', '星期一前先看一下時間表。'],
                    ['uniform', '/ˈjuː.nɪ.fɔːm/', 'n.', '校服', 'special clothes that students wear at school', 'We wear a uniform every day.', '我們每天都要穿校服。'],
                    ['laboratory', '/ləˈbɒr.ə.tər.i/', 'n.', '實驗室', 'a room used for science experiments', 'Do not run in the laboratory.', '不要在實驗室裡奔跑。'],
                    ['principal', '/ˈprɪn.sə.pəl/', 'n.', '校長', 'the person in charge of a school', 'The principal spoke at the assembly.', '校長在週會上講話。']
                ]
            },
            {
                unit_no: 2,
                title: 'School Life',
                entries: [
                    ['atmosphere', '/ˈæt.mə.sfɪər/', 'n.', '氣氛；大氣', 'the feeling of a place, or the air around the earth', 'The classroom has a friendly atmosphere.', '這間課室氣氛友善。'],
                    ['participate', '/pɑːˈtɪs.ɪ.peɪt/', 'v.', '參與', 'to take part in an activity', 'Everyone should participate in the club.', '每個人都應該參與這個學會。'],
                    ['assignment', '/əˈsaɪn.mənt/', 'n.', '作業；任務', 'work that a teacher gives you to do at home', 'I finished my assignment before dinner.', '我在晚飯前完成了作業。'],
                    ['confident', '/ˈkɒn.fɪ.dənt/', 'adj.', '有自信的', 'feeling sure about your ability', 'She feels confident about the test.', '她對測驗很有信心。'],
                    ['improve', '/ɪmˈpruːv/', 'v.', '改善；進步', 'to become better than before', 'Reading every day will improve your English.', '每天閱讀會讓你的英文進步。'],
                    ['diligent', '/ˈdɪl.ɪ.dʒənt/', 'adj.', '勤奮的', 'working hard and carefully', 'He is a diligent student.', '他是一位勤奮的學生。']
                ]
            },
            {
                unit_no: 3,
                title: 'Hobbies',
                entries: [
                    ['collect', '/kəˈlekt/', 'v.', '收集', 'to bring things together and keep them', 'I collect stamps from different countries.', '我收集不同國家的郵票。'],
                    ['instrument', '/ˈɪn.strə.mənt/', 'n.', '樂器；儀器', 'a thing used for making music or doing science', 'The piano is my favourite instrument.', '鋼琴是我最喜歡的樂器。'],
                    ['photography', '/fəˈtɒɡ.rə.fi/', 'n.', '攝影', 'the activity of taking photos', 'Photography is his weekend hobby.', '攝影是他週末的興趣。'],
                    ['energetic', '/ˌen.əˈdʒet.ɪk/', 'adj.', '精力充沛的', 'full of energy', 'The team looks energetic today.', '這支隊伍今天看起來精力充沛。'],
                    ['leisure', '/ˈleʒ.ər/', 'n.', '閒暇', 'free time when you are not working', 'What do you do in your leisure time?', '你閒暇時做什麼？'],
                    ['practise', '/ˈpræk.tɪs/', 'v.', '練習', 'to do something often so you get better at it', 'Practise the guitar for twenty minutes a day.', '每天練二十分鐘吉他。']
                ]
            }
        ]
    },
    {
        code: 'B5B',
        name: 'Book 5B',
        grade: 'S1',
        publisher: '示範教材',
        units: [
            {
                unit_no: 1,
                title: 'Food and Health',
                entries: [
                    ['nutrition', '/njuːˈtrɪʃ.ən/', 'n.', '營養', 'the food and drink that a body needs to stay healthy', 'Good nutrition helps you grow.', '好的營養幫助你成長。'],
                    ['digest', '/daɪˈdʒest/', 'v.', '消化', 'to break down food inside your body', 'It takes hours to digest a heavy meal.', '一頓豐盛的飯要幾小時才能消化。'],
                    ['vitamin', '/ˈvɪt.ə.mɪn/', 'n.', '維他命', 'a substance in food that your body needs in small amounts', 'Oranges are rich in vitamin C.', '橙含有豐富的維他命 C。'],
                    ['balanced', '/ˈbæl.ənst/', 'adj.', '均衡的', 'including the right amounts of different things', 'Try to eat a balanced meal.', '盡量吃一頓均衡的飯。'],
                    ['overweight', '/ˌəʊ.vəˈweɪt/', 'adj.', '過重的', 'heavier than is healthy', 'Sitting all day can make you overweight.', '整天坐著可能讓你過重。'],
                    ['ingredient', '/ɪnˈɡriː.di.ənt/', 'n.', '材料；成分', 'one of the things used to make a dish', 'Salt is the main ingredient here.', '鹽是這裡的主要材料。']
                ]
            },
            {
                unit_no: 2,
                title: 'Travel',
                entries: [
                    ['itinerary', '/aɪˈtɪn.ər.ər.i/', 'n.', '行程表', 'a plan of a journey', 'Our itinerary includes two days in Kyoto.', '我們的行程包括京都兩天。'],
                    ['departure', '/dɪˈpɑː.tʃər/', 'n.', '出發；離開', 'the act of leaving a place', 'Check the departure time again.', '再確認一次出發時間。'],
                    ['souvenir', '/ˌsuː.vəˈnɪər/', 'n.', '紀念品', 'something you buy to remember a place', 'I bought a small souvenir for my sister.', '我買了一個小紀念品給妹妹。'],
                    ['scenic', '/ˈsiː.nɪk/', 'adj.', '風景優美的', 'having beautiful views', 'The coastal road is very scenic.', '這條沿海公路風景很美。'],
                    ['explore', '/ɪkˈsplɔːr/', 'v.', '探索', 'to travel around a place to learn about it', 'Let us explore the old town on foot.', '我們徒步探索舊城區吧。'],
                    ['abroad', '/əˈbrɔːd/', 'adv.', '在國外', 'in or to a foreign country', 'She studied abroad for one year.', '她在國外讀了一年書。']
                ]
            },
            {
                unit_no: 3,
                title: 'Technology',
                entries: [
                    ['device', '/dɪˈvaɪs/', 'n.', '裝置；設備', 'a machine made for a particular purpose', 'This device measures your heart rate.', '這個裝置量測你的心率。'],
                    ['download', '/ˌdaʊnˈləʊd/', 'v.', '下載', 'to copy a file from the internet to your computer', 'Download the file before Friday.', '星期五前把檔案下載好。'],
                    ['artificial', '/ˌɑː.tɪˈfɪʃ.əl/', 'adj.', '人工的', 'made by people rather than nature', 'Artificial light is bad for your eyes.', '人工光源對眼睛不好。'],
                    ['network', '/ˈnet.wɜːk/', 'n.', '網絡', 'computers that are connected to each other', 'The school network is very fast.', '學校的網絡很快。'],
                    ['upgrade', '/ˌʌpˈɡreɪd/', 'v.', '升級', 'to make something better or more modern', 'We will upgrade the app next month.', '我們下個月會升級這個應用程式。'],
                    ['portable', '/ˈpɔː.tə.bəl/', 'adj.', '可攜帶的', 'easy to carry around', 'A portable speaker is useful outdoors.', '可攜式喇叭在戶外很有用。']
                ]
            }
        ]
    }
];

/* 種子帳號
 * ★ 2026-10-07 使用者指定：只保留「網站管理員」一個帳號，帳號名 Gary（密碼由他自己登入後再改）。
 *   其他帳號一律由他在「👥 帳號管理」介面上自己建立 —— 所以預設只建 Gary。
 *   --with-admin  額外建立 admin（角色 admin，舊名 manager 已改名）
 *   --with-team   額外建立 teacher / classrep（示範用）
 */
const WEB_MANAGER_USER = { key: 'SEED_WEB_MANAGER_PASSWORD', username: 'Gary', display_name: 'Gary', role: 'web_manager' };
const ADMIN_USER = { key: 'SEED_ADMIN_PASSWORD', username: 'admin', display_name: '管理員', role: 'admin' };
const TEAM_USERS = [
    { key: 'SEED_TEACHER_PASSWORD', username: 'teacher', display_name: '英文老師', role: 'teacher' },
    { key: 'SEED_CLASS_REP_PASSWORD', username: 'classrep', display_name: '英文科代表', role: 'class_rep' }
];

/* ---------------- 執行 ---------------- */
function main() {
    ensureEnv('DATA_BACKEND', () => 'json');
    ensureEnv('DATA_FILE', () => 'data/store.json');
    ensureEnv('PORT', () => '3000');
    ensureEnv('JWT_SECRET', () => crypto.randomBytes(32).toString('hex'));

    const store = createStore({ backend: 'json', dataFile: DATA_FILE });
    if (RESET && fs.existsSync(DATA_FILE)) {
        fs.rmSync(DATA_FILE);
        store.reload();
        console.log(`已清空資料檔：${DATA_FILE}`);
    }

    let createdBooks = 0;
    let createdUnits = 0;
    let createdEntries = 0;

    for (const bookSpec of (WITH_SAMPLE ? BOOKS : [])) {
        let book = store.listBooks({ includeUnpublished: true }).find((b) => b.code === bookSpec.code);
        if (!book) {
            book = store.createBook({
                code: bookSpec.code,
                name: bookSpec.name,
                grade: bookSpec.grade,
                publisher: bookSpec.publisher,
                sort_order: store.listBooks({ includeUnpublished: true }).length + 1,
                is_published: true
            });
            createdBooks += 1;
        }
        for (const unitSpec of bookSpec.units) {
            let unit = store.findUnitByNo(book.id, unitSpec.unit_no);
            if (!unit) {
                unit = store.createUnit({
                    book_id: book.id,
                    unit_no: unitSpec.unit_no,
                    title: unitSpec.title,
                    sort_order: unitSpec.unit_no,
                    is_published: true
                });
                createdUnits += 1;
            }
            let order = store.listEntries({ unitId: unit.id }).length;
            for (const row of unitSpec.entries) {
                const [headword, ipa, pos, zh, en, exampleEn, exampleZh] = row;
                const norm = normalizeHeadword(headword);
                if (store.findEntryByHeadword(unit.id, norm)) continue;
                order += 1;
                store.createEntry({
                    unit_id: unit.id,
                    headword,
                    headword_norm: norm,
                    ipa_us: ipa,
                    ipa_uk: '',
                    part_of_speech: pos,
                    zh_meaning: zh,
                    en_definition: en,
                    example_en: exampleEn || '',
                    example_zh: exampleZh || '',
                    status: 'published',
                    sort_order: order,
                    created_by: 'seed',
                    updated_by: 'seed'
                });
                createdEntries += 1;
            }
        }
    }

    const createdUsers = [];
    /* 只保留網站管理員：把其他帳號（連同授權）刪掉，並確保 Gary 這個帳號存在且是網站管理員。
     * 使用者的資料（書本／單元／生字）完全不會被動到。 */
    if (PRUNE_ACCOUNTS) {
        const removed = [];
        for (const user of store.listUsers()) {
            if (user.role === 'web_manager') continue;
            for (const grant of store.listGrants({ userId: user.id })) store.deleteGrant(grant.id);
            store.deleteUser(user.id);
            removed.push(`${user.username}（${user.role}）`);
        }
        const managers = store.listUsers().filter((user) => user.role === 'web_manager');
        /* 舊帳號名（webmanager）改名成 Gary：直接改 username，其他資料不動 */
        for (const user of managers) {
            if (user.username !== WEB_MANAGER_USER.username) {
                store.updateUser(user.id, {
                    username: WEB_MANAGER_USER.username,
                    display_name: WEB_MANAGER_USER.display_name
                });
                console.log(`已把網站管理員帳號 ${user.username} 改名為 ${WEB_MANAGER_USER.username}`);
            }
        }
        console.log(removed.length ? `已刪除帳號：${removed.join('、')}` : '沒有需要刪除的帳號');
        const keptManagers = store.listUsers().filter((user) => user.role === 'web_manager');
        if (keptManagers.length === 1) {
            const password = ensureEnv(WEB_MANAGER_USER.key, randomPassword);
            store.updateUser(keptManagers[0].id, { password_hash: hashPassword(password) });
            console.log(`已重設 ${keptManagers[0].username} 的密碼（在 .env 的 ${WEB_MANAGER_USER.key}）`);
        }
    }

    const userSpecs = [WEB_MANAGER_USER];
    if (WITH_ADMIN) userSpecs.push(ADMIN_USER);
    if (WITH_TEAM) userSpecs.push(...TEAM_USERS);
    for (const spec of userSpecs) {
        /* 舊名 manager 的帳號若還在，先改名成 admin（使用者指定：manager 改叫 admin） */
        if (spec === ADMIN_USER) {
            const legacy = store.findUserByUsername('manager');
            if (legacy && !store.findUserByUsername('admin')) {
                store.updateUser(legacy.id, { username: 'admin', display_name: ADMIN_USER.display_name });
                console.log('已把舊帳號 manager 改名為 admin');
            }
        }
        if (store.findUserByUsername(spec.username)) continue;
        const password = ensureEnv(spec.key, randomPassword);
        store.createUser({
            username: spec.username,
            display_name: spec.display_name,
            password_hash: hashPassword(password),
            role: spec.role,
            is_active: true
        });
        createdUsers.push(`${spec.username}（${spec.role}）`);
    }

    console.log('--- 示範資料 ---');
    if (WITH_SAMPLE) {
        console.log(`書本 ${createdBooks} 本、單元 ${createdUnits} 個、生字 ${createdEntries} 個（已存在的不重複建立）`);
    } else {
        console.log('未建立任何生字（預設就是空的，讓你自己填）。要載入示範教材請執行：npm run seed -- --with-sample');
    }
    console.log('--- 帳號 ---');
    console.log(createdUsers.length ? `新建立：${createdUsers.join('、')}` : '帳號已存在，未變更');
    console.log(`目前帳號：${store.listUsers().map((u) => `${u.username}（${u.role}${u.is_active === false ? '，已停用' : ''}）`).join('、')}`);
    console.log(`資料檔：${DATA_FILE}`);
    console.log('密碼：已寫入 .env 的 SEED_*_PASSWORD（本檔不印出密碼）');
    console.log('查詢方式：grep SEED_ .env');
    console.log('--- 接下來 ---');
    console.log('1. node server.js');
    console.log('2. 開 http://localhost:3000 → 右上角「登入」（manager 或 webmanager）');
    console.log('3. 登入後按右上角「✏️ 管理」→ 📗 新增書本 → 🏗 新增單元 → ➕ 新增生字');
}

main();
