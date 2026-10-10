# Gary-Dictionary

線上英文生字字典：學生**點年級 → 選單元 → 看生字表**（生字、讀音、詞性、中文解釋、英文解釋）→ 點 🔊 聽讀音。
生字由老師／科代表／網頁管理員／被授權的人加入；科代表的新增要老師核准。

- 目前版本：**v0.11.0（本機 Demo ＋ 線上版已上線；資料庫在 Neon）**
- 規劃書（**待完成的事都在這**）：`docs/規劃書-待完成.md`｜決策與各版結果：`docs/規劃書-v0.0.1.md`｜部署：`docs/deploy-vercel.md`
- 技術：Node.js + Express 5、原生 HTML/CSS/JS（無建置流程）、JWT 放 HttpOnly cookie、介面預設英文可切中文
- 資料層：**Neon（PostgreSQL）的 Data API**（PostgREST 相容）—— v0.10.0 從 Supabase 搬過去，**程式碼沒有改**
  （同一個 adapter 換端點與金鑰而已）。切換與回滾：`node scripts/switch-backend.js --status｜--to=neon｜--to=supabase｜--rollback`
- 線上：**已上線** https://gary-dictionary-mylearning.vercel.app （Vercel `gary-dictionary` ＋ Neon；環境變數已設好）

---

## 使用動線（學生看到的）

```
① 書架（首頁）        ② 目錄                    ③ 生字表
┌──────────┐         S2                       Unit 1 · My New School
│   年級   │  點一下  ┌────────────────────┐    campus /ˈkæm.pəs/ n. 校園 🔊
│    S2    │  ──────▶ │ Unit 1  My New…  3 │ ─▶  …
└──────────┘         │ Unit 2  School…  0 │
                     └────────────────────┘
                     ← Books（回首頁）        ← Units（回目錄）
```

- 書架上是**年級卡片**（例：S1／S2）；點一下進到該年級的單元列表。
- 本機預設**只有一個帳號 `Gary`**（網站管理員）；其他帳號由他登入後在介面上自己建立。

---

## 快速開始（本機）

```bash
npm install
npm run seed       # 只建立網站管理員帳號（**不會**預先填任何生字，內容由你自己加入）
node server.js     # 開 http://localhost:3000
```

`npm run seed` 會把帳號密碼**只寫進 `.env`**（終端機不會印出）。要看帳號密碼：

```bash
grep SEED_ .env
```

| 帳號 | 角色 | 可以做的事 |
|---|---|---|
| `Gary` | 網站管理員（`web_manager`） | 最高權限：全部功能（含帳號管理、授權、稽核紀錄） |
| （自己建立） | 網頁管理員（`admin`） | 全部功能（含使用者管理、稽核紀錄） |
| （自己建立） | 老師（`teacher`） | 新增／修改／刪除生字、核准科代表的生字、上傳錄音、維護書本與單元 |
| （自己建立） | 科代表（`class_rep`） | 新增生字（進「待審核」）、批次匯入 |
| （未登入） | 訪客／學生 | 瀏覽、搜尋、聽讀音——**學生不需要登入** |

第一次使用（資料全空）的順序：**Gary** 登入 → 右上角「✏️ 管理」→ 選單「📗 新增書本」→「🏗 新增單元」→「➕ 新增生字」。

種子帳號的參數：

| 指令 | 效果 |
|---|---|
| `npm run seed` | 只建立網站管理員（帳號名 `Gary`） |
| `npm run seed -- --with-admin` | 額外建立 `admin`（角色 admin；舊帳號名 `manager` 已改名為 `admin`） |
| `npm run seed -- --with-team` | 額外建立 `teacher`、`classrep`（示範用） |
| `npm run seed -- --with-sample` | 載入示範教材（2 本 × 3 單元 × 6 生字） |
| `npm run seed -- --prune-accounts` | **只留網站管理員**：刪掉其他帳號（連授權）、把網站管理員改名為 `Gary` 並重設密碼；**教材資料完全不動** |
| `npm run seed -- --reset` | 清空 `data/store.json` 之後重建帳號 |

---

## 介面語言

**預設是英文**（2026-10-07 使用者指定）。右上角的 `EN / 中文` 可以即時切換，選擇記在 `localStorage`（純 UI 偏好，
**不涉及任何授權判斷**），重新載入後仍保留。

- 所有介面文字的唯一來源是 `public/js/i18n.js`；靜態 HTML 用 `data-i18n` 標記，動態字串用 `t('key')`。
- 後端回應一律是**英文訊息 + `code`**（`lib/messages.js`），前端用 `errors.<code>` 對應成中文；
  所以「同一個錯誤」在兩種語言下都會是對的語言，而 API 對外（curl／腳本）也維持英文。
- `tests/i18n.test.js` 會擋住「翻譯漏了某個鍵」「程式用了不存在的鍵」「兩邊插值變數不一致」
  「新的 error code 沒有翻譯」這四種靜默錯誤。

---

## 資料庫與上線狀態

| 環境 | 資料層 | 狀態 |
|---|---|---|
| 本機 Demo | 本機 JSON（`data/store.json`，不進 Git） | 可用，內容由你手動加入 |
| 線上（Vercel） | **Neon（PostgreSQL）的 Data API**（PostgREST 相容） | **已上線運行中**（https://gary-dictionary-mylearning.vercel.app ） |

**Neon（v0.10.0 起）**：專案 `Gary-dictionary`（`aws-ap-southeast-1`，免費方案，branch storage 1 GB），
8 張表 `dict_*`（含 `dict_error_logs`）＋ 兩支函式（`dict_entry_counts`／`dict_db_size`）。
授權是**自簽 JWT ＋ GRANT／RLS**（沒有 JWT 一律 400）；簽章工具 `scripts/neon-jwt.js`、
公鑰在 `public/keys/jwks.json`（Neon 用這個 JWKS URL 驗簽）。切換／回滾用 `scripts/switch-backend.js`
（細節見 `docs/搬家到Neon.md`）。**Supabase 專案還在（一句指令可切回去），但已經不是線上資料庫。**

資料層怎麼運作（`lib/store/supabase.js` 開頭有完整說明）：**每個 /api 請求先抓「這一條請求要用的切片」
（v0.6.1 起只抓需要的生字／音檔／稽核，不再整表進記憶體）→ 路由照舊同步讀寫 →
回應送出「之前」把異動寫回**（寫回失敗回 500，不假裝成功）。這樣做是因為路由是同步風格，
而且 serverless 在回應送出後會凍結實例、不能之後才寫資料庫。

**每個請求都重新抓**（不是每個實例抓一次）：否則別的實例剛寫進去的東西你看不到
（老師加了生字、學生看不到就完了）。想省查詢量可以設 `SUPABASE_HYDRATE_TTL_MS`（毫秒）。
代價：同一瞬間的兩個寫入請求仍可能互相覆蓋（學校規模可接受）；兩個實例同時新增資料時
若配到同一個 id，後寫的那筆會回 500 `DB_WRITE_FAILED`（大聲失敗，不會假裝成功）。

`/api/health` 會回一段 `db` 診斷（主機代號、金鑰角色與專案 ref、最後一次資料庫錯誤）——
上線後連不上資料庫時，先看這個就知道是「連錯專案」「金鑰種類不對」還是「資料庫真的空的」。
（不含任何機密：只放金鑰的 `role`／`ref` 宣告，不放金鑰本身。）

上線步驟與驗證指令：`docs/deploy-vercel.md`。要準備的環境變數：
`DATA_BACKEND=supabase`、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`JWT_SECRET`、`SITE_URL`
（**後兩者請自己填，不要貼在對話裡**）。

---

## 安全（v0.4.0 起）

| 面向 | 做法 |
|---|---|
| 登入憑證 | JWT 放 HttpOnly + SameSite=Strict cookie（預設 12 小時）；也接受 `Authorization: Bearer`；權杖帶 `token_version`，改密碼／強制登出後舊權杖立即失效 |
| 兩步驟驗證 | **可選、不強制**（TOTP，RFC 6238）：任何人可在 🔑 彈窗自己開啟，8 組一次性備援碼，密鑰以 AES-256-GCM 加密後才存；開啟後登入分兩步，中間權杖不能呼叫 API |
| 密碼政策 | 新設定的密碼最少 10 碼（三個入口都擋）；新裝置登入會單獨留一筆稽核並提醒使用者 |
| CSRF | 不安全的方法一律檢查來源，且**只比對主機名**（反代後面 `req.protocol` 不可信，比 scheme 會誤擋自家請求） |
| CSP | `default-src 'self'`、`script-src 'self'`、`style-src 'self'`（零行內樣式與事件）、`object-src 'none'`、`frame-src 'none'`、`worker-src 'self'`、`frame-ancestors 'none'`；`upgrade-insecure-requests` **只在 production** |
| 其他標頭 | `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy`、HSTS、`Cross-Origin-Opener-Policy`、`Permissions-Policy`（相機與麥克風只給自家、其餘全關） |
| CORS | 只允許自家來源；**靜態檔也由 `vercel.json` 指定自家網域**，覆蓋 CDN 對靜態檔預設回傳的 `Access-Control-Allow-Origin: *` |
| 資料庫 | RLS 全開、不加 policy、撤銷 anon／authenticated；只有後端用 `service_role` 進得去 |
| 快取 | 未登入的讀取回 15 秒公開快取並帶 `Vary: Cookie`；登入者一律 `private, no-store`（登入者看得到未發佈草稿，那種回應不能進任何快取） |
| 登入防護 | IP 與帳號雙軌鎖定：同一帳號要來自 ≥2 個 IP 才會鎖（避免一位老師打錯密碼鎖住全校） |
| 權限 | `lib/roles.js` 是唯一權威；**每個請求都重新讀取使用者與角色**，所以停用帳號立即失效 |
| 機密 | `JWT_SECRET`／`SUPABASE_SERVICE_ROLE_KEY` 只在 `.env` ↔ Vercel 之間流動（Vercel 以 sensitive 存放）；輪替步驟見 `docs/金鑰輪替.md` |
| 依賴 | `npm run check:deps` 掃 production 依賴的 high／critical 弱點（發版前跑） |

## 功能（v0.0.1 起，v0.2.0 更新）

- **三層動線**：書架（年級）→ 目錄（單元列表）→ 生字表，各有返回按鈕；搜尋框只在生字表出現。
- **讀音**：有老師錄音 → 播錄音；沒有 → 用瀏覽器語音合成（TTS）。同一顆 🔊，使用者不必理解差異。
- **搜尋**：即時過濾生字、中文、英文解釋、音標、詞性。
- **管理選單（老師以上）**：管理區分成 `⏳ 待審核｜➕ 新增生字｜📋 批次貼上｜🏗 新增單元｜✏️ 修改單元｜📗 新增年級｜🧾 稽核紀錄｜🐞 錯誤紀錄｜📊 概況｜👥 帳號管理｜🔑 授權管理`（右上角另有 **❓ 使用說明**：依身分顯示，中英雙語，可列印），
  **按哪個才顯示哪一塊**；沒有權限的分頁不會出現，待審核數量顯示在按鈕上。
  從生字卡按「✏️ 編輯」時，管理區沒開會**自動打開並帶到那張表單**。
- **修改單元**（v0.4.1）：目錄每一列右邊的 ✏️（老師以上）→ 自動打開管理區並帶入該單元的編號與名稱，
  名稱與編號都可以改（改編號會改變學生看到的順序）；編號重複或不是 1–99 會被擋（409／400），不會變成兩個 Unit 3。
- **修改自己的密碼 與 兩步驟驗證**：標題列的 🔑（任何登入者都能用）：改密碼要輸入目前的密碼（最少 10 碼，
  改完其他裝置會登出、自己這台換新權杖）；同一個彈窗可以自己開啟／關閉兩步驟驗證。
- **帳號救援**：「👥 帳號管理」可以替下級**產生一次性臨時密碼**（畫面顯示一次）、**重設兩步驟驗證**，
  網站管理員還能按「登出所有裝置」（該帳號的所有裝置一起登出，兩段式確認），
  以及「➕ 新增帳號」旁邊的**「🚪 所有帳號、所有裝置一起登出」**（連自己這一台都會登出；只有網站管理員看得到）。
  自己**不能**改自己的角色或停用自己（那是提權／自鎖），後端會擋。
- **帳號管理**：建立帳號、改角色、重設密碼、停用／啟用、刪除（兩段式確認）。
- **單元級授權**：授權某人在某本書或某個單元編輯（可加「也可以發佈」）。
- **審核流程**：科代表新增 → 「待審核」（學生看不到）→ 老師核准 → 學生才看得到。
- **列印**：單元頁可列印成生字表（`public/css/print.css`）。
- **稽核**：登入／登出、生字與書本的每一次新增、修改、刪除、發佈、核准、帳號與授權都有紀錄。
  可以依動作／帳號／日期篩選，每個動作有顏色分類（新增綠、修改黃、刪除紅、審核藍、登入灰）；
  **自動化檢查的動作預設會濾掉**，不會混在你的操作紀錄裡。
- **錯誤紀錄**（v0.4.2）：前端例外與伺服器 500 會自動記到後台「🐞 錯誤紀錄」，可依等級／來源／狀態／日期篩選，
  修好後按「標記已處理」，或按「同類全部標為已處理」一次清掉同一種錯誤。不保存截圖與個資；
  瀏覽器擴充功能（翻譯／深色模式）注入行內樣式造成的 CSP 違規**不會**再回報（理由寫在 `public/js/errorlog.js`）。
  詳見 `docs/監控與錯誤追查.md`。
- **稽核匯出與清理**（v0.4.4）：「🧾 稽核紀錄」可以依目前篩選條件**匯出 CSV**（帶 UTF-8 BOM，Excel 直接開；
  以 `= + - @` 開頭的值會補單引號防公式注入），也可以**清理舊紀錄**（第一次按只預覽，第二次才真的刪；保留天數下限 30 天）。
- **備份與還原**（v0.9.0，A-2）：`npm run backup` 把整個資料庫匯出成 `.jsonl` ＋ `manifest.json`
  （含每個檔案的 sha256）推到**私有** GitHub repo（保留最近 30 份，只讀不動正式站）；
  `npm run restore` 可檢查或還原（沒有 `--confirm` 只檢查、不寫入）。
  演練過把正式站備份還原到 Neon 空庫、8 張表筆數全對；詳見 `docs/備份與還原.md`。
- **資料層視窗化**（v0.6.1，D-1b）：資料庫只抓「這一條請求需要的」生字／音檔／稽核切片；
  存取沒被載入的範圍會**大聲失敗**（STORE_WINDOW_MISSING），不會靜默回空資料。書架／統計只抓兩個小欄位算數字。
- **修改年級**（v0.6.0）：管理區「📗 新增年級」下方列出所有年級，每一列有 ✏️ 可以改名；
  改成已經有的年級會被擋（409），稽核紀錄會留一筆 `BOOK_UPDATE`。
- **編輯衝突保護**（v0.6.0，D-2）：生字／單元／年級存檔時帶著讀到的版本，別人先改過就回 409
  並重新載入（不再無聲蓋掉別人的修改）。
- **生字表分頁**（v0.6.0，D-1）：一頁 60 筆、底部「⬇ 載入更多生字」、搜尋由伺服器端過濾；
  一個單元 3,000 個生字時，第一頁的回應從 1,131 KB 降到 22 KB（省 98.1%，見 `npm run perf:entries`）。
- **每單元錄音上限**（v0.6.0，D-3）：上限 60 段，錄音視窗顯示用量，📊 概況回報錄音總容量。
- **資料庫容量月檢**（v0.7.0，D-6）：📊 概況、`npm run usage`、`npm run uptime` 都顯示資料庫的
  **真實大小與百分比**（來自資料庫的 `dict_db_size()` 函式）；超過 **70%** 會標紅並讓檢查回非 0，
  提示先跑 `npm run cleanup:logs`、再刪沒用到的錄音。
- **說明頁在手機上的表格**（v0.7.0）：角色權限對照表放在可橫向捲動的框裡，
  不再把整頁撐出橫向捲軸（英文版欄標題較長時最明顯；以前會在手機上出現約 140px 的橫向溢出）。
- **年級制**（v0.5.0，使用者指定）：書架只看得到**年級**（例：S1／S2），點年級直接看到它的單元；
  **書名與封面在整個流程裡都不再出現（包括管理區）**，管理區的「📗 新增年級」只要填年級。
  封面上傳／讀取端點與面板整個移除（資料表欄位保留為舊資料欄位）。
- **列印與外觀**（v0.4.7）：單元裡的 🖨 可以選擇先取消「中文解釋／例句」再印；標題列有
  **主題**（🖥 跟隨系統／☀️ 淺色／🌙 深色）與**字級**（A／A+；v0.6.5 起移除縮小的 A−），選擇會記在這台裝置上。
  深色票有兩份（跟隨系統、明確選擇），`tests/guards.test.js` 會逐條比對，不會只改一邊。
- **鍵盤操作**（v0.4.7）：`/` 或 `Ctrl/⌘+K` 跳到搜尋框、`Esc` 關閉最上層的東西（錄音／登入／說明／管理區）；
  有「跳到主要內容」連結與看得見的焦點外框。
- **匯入 Excel／CSV**（v0.4.6）：管理區「📋 批次貼上」可以選檔案（.xlsx／CSV／TSV）→ 預覽每一欄對應到哪個欄位
  （表頭會自動辨認）→ 確認後才送出。**.xlsx 在瀏覽器裡自己解、不引入任何套件**（用內建的 DecompressionStream）。
  單批上限 500 列，重複的生字會略過。
- **連續播放與發音來源**（v0.4.6）：單元標題列「▶ 播放全部」依序唸完（再按一次停止，會同時停掉錄音與語音）；
  沒有老師錄音的生字標示 **🤖 電腦語音**（老師一眼看出哪些還沒錄）。
- **複製單元與排序**（v0.4.6）：目錄每列 **⧉ 複製**（生字一起複製、不含錄音、預設不發佈且進待審核）、
  **↑ ↓** 調整單元順序；書架卡片上也能 ↑ ↓ 調整書本順序。
- **批次審核**（v0.4.6）：待審核可以勾選多筆一次「核准」或「退回」，退回可填原因，
  **原因會顯示給科代表看**（科代表也看得到自己被退回的生字）。
- **使用說明**（v0.4.5，v0.4.7 補齊）：右上角 ❓ 打開，依身分顯示（訪客／學生／科代表／老師／管理員／網站管理員）；
  中英雙語、可列印（只印說明）。內容由 public/js/guide.js 與 i18n 產生，
  並由 tests/guide.test.js 守著「不可以提到不存在的功能」。說明頁最下面是**角色與權限對照表**（讀 GET /api/roles）。
- **我的單元**（v0.4.5）：老師／科代表登入後，書架上方列出「我可以編輯的單元」（書名 + Unit N + 生字數 + 待審核數），
  點一下直接跳過去。後端 GET /api/my/units 依 lib/roles.js 的 canEditUnit 計算。
- **權限一致性守門**（v0.4.5）：lib/capabilities.js 是「誰能做什麼」的唯一來源；
  tests/fixtures/permissions.json（32 列）會被拿去打真實端點（6 種身分 × 32 列），
  前端不得再寫死角色（一律 PDAuth.can(能力)）。**已發佈的生字對科代表顯示「🔒 已發佈」而不是編輯／刪除按鈕**
  （前端顯示與後端判斷從此一致）。
- **概況**（v0.4.4）：管理選單「📊 概況」顯示教材與帳號的聚合數字、錄音覆蓋率、最近 7 天的動作統計、
  各單元生字數（含空單元）；只回數字，不含個資。

## 批次貼上格式

一行一個生字，欄位用 **Tab** 分隔（從 Excel／Word 貼過來也可以，兩個以上空白或逗號也吃得下）：

```
atmosphere	/ˈæt.mə.sfɪər/	n.	氣氛；大氣	the feeling of a place
librarian	/laɪˈbreə.ri.ən/	n.	圖書館員	a person who works in a library
```

中文解釋與英文解釋至少要填一個；同一單元已有的生字會自動略過並回報筆數。

---

## 權限模型

角色階梯（`lib/roles.js` 是唯一權威，後端每次都重新驗證）：

```
guest(訪客) < student(學生) < class_rep(科代表) < teacher(老師) < admin(網頁管理員) < web_manager(網站管理員)

（`web_owner` 是 v0.0.1 的舊名稱，`normalizeRole()` 會自動當成 `web_manager`，不會讓舊帳號被降權。）
```

| 動作 | 訪客/學生 | 科代表 | 老師 | 管理員 | 網站管理員 |
|---|---|---|---|---|---|
| 瀏覽生字、聽讀音、搜尋 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 新增／編輯生字 | ✗ | ✓（待審核） | ✓ | ✓ | ✓ |
| 核准／退回待審核 | ✗ | ✗ | ✓ | ✓ | ✓ |
| 上傳老師錄音 | ✗ | ✗ | ✓ | ✓ | ✓ |
| 維護書本與單元 | ✗ | ✗ | ✓ | ✓ | ✓ |
| 使用者管理、稽核紀錄 | ✗ | ✗ | ✗ | ✓ | ✓ |

另有**單元級授權**（`dict_grants` 表 + `/api/admin/grants`）：可以只授權某位老師編輯某本書，或只授權某位科代表編輯某個單元。
（授權的圖形介面在右上角「✏️ 管理 → 🔑 授權管理」。）

---

## 資料

`DATA_BACKEND=json`（Demo 預設）→ 資料存在 `data/store.json`（已列入 `.gitignore`），老師錄音以 base64 存在同一個檔案內。
`migrations/2026-10-08-v0.0.1-init.sql` 是 Supabase 的等價 schema（表名前綴 `dict_`）；`DATA_BACKEND=supabase`（PostgREST 相容 adapter）**已實作完成**，v0.10.0 起線上指向 Neon（見 `docs/搬家到Neon.md`）。

### 已知限制（誠實揭露）

- **JSON 資料層只適合本機單一實例**：多個實例同時寫入會互相覆蓋；**也無法部署到 Vercel**（serverless 沒有持久磁碟）。
  要上線給老師與學生用，用的是**已完成**的 PostgREST adapter（`DATA_BACKEND=supabase`；v0.10.0 起指向 Neon）。
- TTS 的聲音取決於裝置與瀏覽器，不是「字典的標準發音」；iOS Safari 必須在點擊（使用者手勢）中播放；
  瀏覽器不支援語音合成時，沒有老師錄音的生字無法播放（介面會提示）。
- 單筆錄音上限 1MB／60 秒；錯誤登入 10 次會在 15 分鐘內鎖定該網路。

### 環境變數（`.env`，不進版控）

`NODE_ENV`、`PORT`、`JWT_SECRET`、`DATA_BACKEND`、`DATA_FILE`、`SITE_URL`、`CORS_ALLOWED_ORIGINS`、
`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`（PostgREST 相容；現指向 Neon）、`SEED_*_PASSWORD`。範例見 `.env.example`。

---

## 測試

```bash
npm run check:syntax   # 所有 JS 語法檢查 + server.js 模組載入檢查
npm run check:schema   # 程式要用的欄位 vs migrations/*.sql（不用網路）
npm test               # 186 項：角色權限矩陣（含「被授權的人也算有能力」）＋資料層（JSON 與 PostgREST／Neon）、
                       #   schema 守門、路由快照與覆蓋、版本一致、i18n、前端跨檔誤用守門、視窗化資料層（含 D-11）、
                       #        說明頁分頁守門、權限對照表、.xlsx、連續播放、修改年級／樂觀鎖／錄音上限／生字表分頁、API 端到端
npm run check:browser  # 四支真 Chrome 檢查（劇本 118 ＋ 空白起步 33 ＋ 語言切換 42 ＋ 帳號管理 136 ＝ 329 項）
npm run check:live-browser  # 打正式站的真瀏覽器「訪客視角」檢查（16 項；不寫截圖、不下載、不登入）
npm run perf:entries   # D-1 效能實測：一個單元塞 3000 個生字，量分頁省下多少（預設 3000）
npm run check:deps     # 依賴套件弱點掃描（需要網路；--all 才含開發依賴）
npm run uptime         # 線上健康檢查（版本／資料庫／公開讀取／首頁），失敗 exit 1
npm run monitor        # 同上，但失敗會發 macOS 通知；launchd 每天 08:30 自動跑（D-8）
                       #   逐字紀錄：logs/uptime.log（備份的是 logs/backup.log）
npm run triage         # 巡檢錯誤日誌（唯讀，依出現次數分組）
npm run usage          # 各表筆數與用量提醒
npm run cleanup:logs   # 清理舊日誌（預設只預覽，--apply 才真的刪）
npm run routes         # 列出所有後端路由與註冊順序（路由快照的來源）
npm run routes:snapshot  # 更新 tests/fixtures/route-inventory.json（新增／移除路由後要跑）
npm run check:schema:live        # 同一份欄位清單 vs 線上（Neon）實際 schema
node scripts/supabase-smoke.js          # 線上資料庫：連線／schema／各表筆數
node scripts/supabase-smoke.js --write  # 線上資料庫：寫入 → 新連線讀回 → 清理 → 確認乾淨
node scripts/live-verify.js             # 線上版端到端：schema、建立年級／單元／生字往返（不留測試資料）
DATA_BACKEND=supabase npm run seed -- --prune-accounts   # 在正式資料庫建立／重設帳號
```

發版的完整順序（`npm run check` 是 `check:syntax + check:schema + test`；**線上版額外跑 `check:live-browser`**）：

```bash
npm run check && npm run check:browser && npm run check:deps
```

> `check:deps` 刻意**不在** `npm run check` 裡：`npm audit` 需要連外，而 `check` 要能離線跑完。

瀏覽器驗收涵蓋：**書架（年級）→ 目錄 → 生字表的三層動線**、
訪客瀏覽與 TTS 播放、搜尋、管理員新增／批次匯入／刪除（兩段式確認）、
老師錄音上傳與播放來源切換、新增單元與書本、科代表待審核 → 老師核准 → 訪客可見、
**帳號管理（建立／改角色／重設密碼／停用／刪除）與授權管理（授權單元後真的能編輯、移除後又不行）**、
**管理選單一次只顯示一塊、沒權限的分頁不出現**、
**資料全空時「開站就是學生視角、彈窗可以開也可以關、管理員能建立第一本書」**、
**預設英文／切換中文／重新載入記得選擇／後端錯誤訊息跟著語言走**、
版面不溢出（含 402px 手機）、無 CSP 違規、無前端例外、無下載、不寫截圖。

---

## 目錄結構

```
api/index.js                # Vercel serverless 入口（= require('../server')）
lib/roles.js                # 角色與權限（唯一權威）
lib/messages.js             # 後端錯誤訊息（英文，唯一來源）與 error code
lib/auth.js                 # JWT、cookie、CSRF 來源檢查、CORS、安全標頭
lib/audit.js                # 稽核動作與中文標籤
lib/store/{index,json}.js   # 資料層介面與本機 JSON 實作（PostgREST 相容的 adapter 在 lib/store/supabase.js）
public/index.html           # 版面（文字用 data-i18n 標記，不寫死語言）
public/js/i18n.js           # 所有介面文字的英中對照與 t()／語言切換
public/                     # 前端（index.html + css/ + js/，零行內樣式與行內事件）
scripts/seed.js             # 種子帳號（預設不填任何生字；--with-sample 才載入示範教材）
scripts/check-syntax.js     # 語法 + 模組載入檢查
tests/                      # node:test 單元／API 測試、tests/browser 真 Chrome 驗收
migrations/                 # schema 快照（Supabase 版；schema 守門會讀）＋ migrations/neon/（Neon 版）
docs/規劃書-待完成.md        # 待完成任務與版本計畫（只放還沒做的事）
docs/規劃書-v0.0.1.md        # 規劃書（決策與各版實作結果）
docs/金鑰輪替.md            # 金鑰輪替步驟與紀錄
docs/監控與錯誤追查.md      # 監控設定、錯誤追查、保留政策與清理
lib/schema.js               # 資料庫欄位唯一清單（schema 守門用）
lib/store/supabase.js       # Supabase adapter（hydrate → 路由 → 回應前 flush）
scripts/route-inventory.js  # 路由清單快照（npm run routes）
scripts/check-deps.js       # 依賴弱點掃描（npm run check:deps）
tests/fixtures/             # 路由快照等測試基準檔
```

## 發版慣例

版號同時出現在 `package.json`、`public/index.html` 的 `<title>`／`#versionLabel` 與所有資產的 `?v=`；
`tests/version-consistency.test.js` 會擋住任何一處忘了改（含 `/api/version` 與 `README.md`）。
發版流程：`npm run check:syntax && npm test && npm run check:browser && npm run check:live-browser` → commit → annotated tag → push → GitHub Release。

**版本說明檔一律放在 `docs/release/`**（`docs/release/release-vX.Y.Z.md`，使用者指定：集中放比較整齊），
發 Release 時用 `node scripts/gh-release.js <tag> docs/release/release-vX.Y.Z.md "<標題後半>"`。
