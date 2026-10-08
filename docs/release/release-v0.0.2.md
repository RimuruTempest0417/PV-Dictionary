## PV_Dictionary v0.0.2（Demo）— 實測回報修正

使用者實測回報三件事，這一版全部處理完：

### 1. 「沒有辦法關閉錄音」＋「開始頁面不是學生」是同一個 bug（已修）

`.modal { display: flex }`、`.panel { display: flex }` 這些作者樣式會蓋掉瀏覽器對 `[hidden]` 的 `display: none`，
所以**設了 `hidden` 的登入視窗、錄音視窗與整個管理面板，開站時就蓋在頁面上，按「關閉」也關不掉**
（程式其實把 `hidden` 設對了）。

- 修法：`public/css/app.css` 全域加 `[hidden] { display: none !important; }`（唯一守門，註解寫明不要移除）。
- 教訓：**驗「有沒有顯示」一定要看算出來的樣式（`getComputedStyle`），只看 `hidden` 屬性是騙自己**。
  新增的 `tests/browser/empty-start-check.js` 就是這樣驗的（開站時掃描所有彈窗與管理面板，必須真的是 `display: none`）。

### 2. 角色 `web_owner` → `web_manager`（`admin` 不變）

- 角色階梯：`guest < student < class_rep < teacher < admin < web_manager`（標籤「網站管理員」）。
- `normalizeRole()` 保留 `web_owner → web_manager` 的相容對照：舊資料若還有這個值，
  會被當成 `web_manager`，**不會被降成訪客**。
- 種子帳號 `owner` → `webmanager`（密碼在 `.env` 的 `SEED_WEB_MANAGER_PASSWORD`）。

### 3. 預設不預填任何生字，內容完全由使用者手動加入

- `npm run seed` **只建立帳號**，書本／單元／生字全部是空的。
- 要看示範效果才加 `--with-sample`（示範課本 2 本 × 3 單元 × 6 生字）。
- 同時補齊「空白起步」的可用性：
  - 起始畫面直接寫出建立順序（新增書本 → 新增單元 → 新增生字 → 錄音），學生視角一眼看懂。
  - 「✏️ 管理」移到右上角：**完全沒有書本時也進得去**（否則第一次使用永遠建立不了第一本書）。
  - 沒有書本／單元時按鈕直接停用並說明原因（而不是按下去才報錯）。

### 測試（實跑）

| 項目 | 指令 | 結果 |
|---|---|---|
| 語法 + 模組載入 | `npm run check:syntax` | 25/25 通過 |
| 單元／API 測試 | `npm test` | **36 通過 / 0 失敗** |
| 真實瀏覽器驗收 | `npm run check:browser` | **69 通過 / 0 失敗** |

- `demo-check.js` 39 項：12 步 Demo 劇本（含錄音上傳、科代表審核、版面、CSP、不下載不截圖）。
- `empty-start-check.js` 30 項（新增）：**資料全空**時開站就是學生視角、登入／錄音視窗開得起來也關得掉、
  管理員按「✏️ 管理」→ 新增書本 → 新增單元 → 新增生字／批次貼上 → 登出後學生看得到。

### 怎麼跑

```bash
npm install
npm run seed        # 只建立帳號（內容由你自己填）
node server.js      # http://localhost:3000
grep SEED_ .env     # manager / webmanager / teacher / classrep 的密碼
```

登入後按右上角「✏️ 管理」→ 📗 新增書本 → 🏗 新增單元 → ➕ 新增生字。

### 仍然是 Demo 的限制

**JSON 資料層不能上 Vercel**（serverless 沒有持久磁碟），線上版要等 v0.1.0 的 Supabase adapter
（schema 已在 `migrations/2026-10-08-v0.0.1-init.sql`）；授權管理與使用者管理目前只有 API，介面排在 v0.1.0。
