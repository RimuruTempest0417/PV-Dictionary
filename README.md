# PV_Dictionary

線上英文生字字典：學生點書本 → 點單元 → 看生字表（生字、讀音、詞性、中文解釋、英文解釋）→ 點 🔊 聽讀音。
生字由老師／科代表／網頁管理員／被授權的人加入；科代表的新增要老師核准。

- 目前版本：**v0.1.0（Demo）**
- 規劃書：`docs/規劃書-v0.0.1.md`
- 技術：Node.js + Express 5、原生 HTML/CSS/JS（無建置流程）、JWT 放 HttpOnly cookie、介面預設英文可切中文

---

## 快速開始（本機）

```bash
npm install
npm run seed       # 只建立帳號（**不會**預先填任何生字，內容由你自己加入）
node server.js     # 開 http://localhost:3000
```

`npm run seed` 會把帳號密碼**只寫進 `.env`**（終端機不會印出）。要看帳號密碼：

```bash
grep SEED_ .env
```

| 帳號 | 角色 | 可以做的事 |
|---|---|---|
| `manager` | 網頁管理員（`admin`） | 全部功能（含使用者管理、稽核紀錄） |
| `webmanager` | 網站管理員（`web_manager`） | 最高權限（可指派管理員） |
| `teacher` | 老師（`teacher`） | 新增／修改／刪除生字、核准科代表的生字、上傳錄音、維護書本與單元 |
| `classrep` | 科代表（`class_rep`） | 新增生字（進「待審核」）、批次匯入 |
| （未登入） | 訪客／學生 | 瀏覽、搜尋、聽讀音——**學生不需要登入** |

第一次使用（資料全空）的順序：登入 → 右上角「✏️ 管理」→「📗 新增書本」→「🏗 新增單元」→「➕ 新增生字」。
頁面上的起始畫面也會直接把這幾步寫出來。

- 只想看示範效果：`npm run seed -- --with-sample`（示範課本 2 本 × 3 單元 × 6 生字）
- 全部重新來過：`npm run seed -- --reset`（會清空 `data/store.json` 再建立帳號）

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
| 本機 Demo | 本機 JSON（`data/store.json`，不進 Git） | 可用，內容清空由你手動加入 |
| 線上（Vercel） | Supabase PostgreSQL | **專案已建好、schema 已套用**（見下），adapter 與部署待做 |

Supabase 專案：`pv-dictionary`（ref `hckozqluooeobvyltcyf`，region `ap-southeast-1`，免費方案），
7 張表 `dict_*` 已依 `migrations/2026-10-08-v0.0.1-init.sql` 建立，RLS 全開且不加 policy、
已撤銷 anon／authenticated 權限（只有 service_role 進得去）。

上線前要準備（**由你自己填，不要貼在對話裡**）：
`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`JWT_SECRET`、`DATA_BACKEND=supabase`、`SITE_URL`。

---

## 功能（v0.0.1）

- **瀏覽**：書本 / 單元切換、生字卡（生字、美式／英式 IPA、詞性、中文解釋、英文解釋、中英例句）。
- **讀音**：有老師錄音 → 播錄音；沒有 → 用瀏覽器語音合成（TTS）。同一顆 🔊，使用者不必理解差異。
- **搜尋**：即時過濾生字、中文、英文解釋、音標、詞性。
- **管理（老師以上）**：新增／修改／刪除生字、批次貼上匯入、新增單元／書本、上傳或**直接用麥克風錄**老師錄音、查看稽核紀錄。
- **審核流程**：科代表新增 → 「待審核」（學生看不到）→ 老師核准 → 學生才看得到。
- **列印**：單元頁可列印成生字表（`public/css/print.css`）。
- **稽核**：登入／登出、生字與書本的每一次新增、修改、刪除、發佈、核准都有紀錄。

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
（授權的圖形介面排在 v0.1.0；API 已完成。）

---

## 資料

`DATA_BACKEND=json`（Demo 預設）→ 資料存在 `data/store.json`（已列入 `.gitignore`），老師錄音以 base64 存在同一個檔案內。
`migrations/2026-10-08-v0.0.1-init.sql` 是 Supabase 的等價 schema（表名前綴 `dict_`），v0.1.0 會實作 `DATA_BACKEND=supabase`。

### 已知限制（誠實揭露）

- **JSON 資料層只適合本機單一實例**：多個實例同時寫入會互相覆蓋；**也無法部署到 Vercel**（serverless 沒有持久磁碟）。
  要上線給老師與學生用，必須先完成 v0.1.0 的 Supabase adapter。
- TTS 的聲音取決於裝置與瀏覽器，不是「字典的標準發音」；iOS Safari 必須在點擊（使用者手勢）中播放；
  瀏覽器不支援語音合成時，沒有老師錄音的生字無法播放（介面會提示）。
- 單筆錄音上限 1MB／60 秒；錯誤登入 10 次會在 15 分鐘內鎖定該網路。

### 環境變數（`.env`，不進版控）

`NODE_ENV`、`PORT`、`JWT_SECRET`、`DATA_BACKEND`、`DATA_FILE`、`SITE_URL`、`CORS_ALLOWED_ORIGINS`、
`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`（v0.1.0）、`SEED_*_PASSWORD`。範例見 `.env.example`。

---

## 測試

```bash
npm run check:syntax   # 所有 JS 語法檢查 + server.js 模組載入檢查
npm test               # 49 項：角色權限矩陣、資料層、匯入解析、i18n 完整性、API 端到端（含帳號與授權）、守門檢查
npm run check:browser  # 四支真 Chrome 檢查（劇本 39 ＋ 空白起步 30 ＋ 語言切換 25 ＋ 帳號管理 40）
```

瀏覽器驗收涵蓋：訪客瀏覽與 TTS 播放、搜尋、管理員新增／批次匯入／刪除（兩段式確認）、
老師錄音上傳與播放來源切換、新增單元與書本、科代表待審核 → 老師核准 → 訪客可見、
**帳號管理（建立／改角色／重設密碼／停用／刪除）與授權管理（授權單元後真的能編輯、移除後又不行）**、
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
lib/store/{index,json}.js   # 資料層介面與本機 JSON 實作（Supabase adapter 待實作）
public/index.html           # 版面（文字用 data-i18n 標記，不寫死語言）
public/js/i18n.js           # 所有介面文字的英中對照與 t()／語言切換
public/                     # 前端（index.html + css/ + js/，零行內樣式與行內事件）
scripts/seed.js             # 種子帳號（預設不填任何生字；--with-sample 才載入示範教材）
scripts/check-syntax.js     # 語法 + 模組載入檢查
tests/                      # node:test 單元／API 測試、tests/browser 真 Chrome 驗收
migrations/                 # Supabase schema（v0.1.0 使用）
docs/規劃書-v0.0.1.md        # 規劃書
```

## 發版慣例

版號同時出現在 `package.json` 與 `public/index.html` 的 `<title>`；每次發版更新 `README.md`。
發版流程：`npm run check:syntax && npm test && npm run check:browser` → commit → annotated tag → push → GitHub Release。
