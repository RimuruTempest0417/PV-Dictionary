## Gary-Dictionary v0.6.1 — 修線上寫入錯誤、資料層視窗化、字級鈕、網址收尾

這一版兩件事：**修掉一個讓線上「所有寫入都失敗」的嚴重錯誤**（你先看到的登入錯誤訊息），
以及把規劃書的 **D-1b 資料層視窗化**做完（生字／音檔／稽核不再整表進記憶體）。

### 1. 修線上嚴重錯誤：dict_audit_logs 沒有 updated_at（你截圖那一則）

- 現象：登入時出現「這次的修改沒有存進資料庫（Supabase POST dict_audit_logs → Could not find the
  'updated_at' column of 'dict_audit_logs' in the schema cache）」。因為**每一次寫入都會留一筆稽核**，
  所以登入、新增生字、審核…全部都會失敗。
- 根因：v0.6.0 為了讓樂觀鎖（D-2）對「新建立的資料」也有效，在**所有表**的新增都補上 `updated_at`；
  但 `dict_audit_logs`（還有 `dict_audio`、`dict_grants`）**沒有這個欄位** → Supabase 直接拒絕（42703）。
- 修法（不只修表面，補上防線讓它不會再發生）：
  1. `lib/schema.js` 新增 `HAS_UPDATED_AT`（哪幾張表真的有這個欄位）→ 兩個資料層都只對這些表寫 `updated_at`。
  2. **假 PostgREST（`tests/supabase.test.js`）現在會比照真實的 PostgREST 拒絕未知欄位**（回一樣的 42703）——
     這就是本機測試當時全綠、線上卻爆掉的原因；現在這種錯在本機就會紅燈。
  3. 新增兩支回歸測試：稽核寫入不可以帶 `updated_at`；`HAS_UPDATED_AT` 必須與欄位清單一致。
  4. 線上已驗證：臨時帳號**登入成功**（登入會寫稽核），生字流程完整走通。

### 2. 資料層視窗化（規劃書 D-1b，這一版的主要工作）

以前：每個請求（快取過期時）都要把 **7 張表整份**抓進記憶體，生字累積到幾千、幾萬筆時就是天花板。

現在：
- **小表**（books／units／users／grants）維持每次請求抓一份（幾十列，變動慢）。
- **生字／音檔／稽核**改成**「這一條請求需要哪一塊才抓哪一塊」**：
  - 看某個單元 → 只抓那個單元的生字（`unit_id=in.(…)`）＋那些生字的音檔。
  - 改／刪某一顆生字 → 只抓那一顆＋它所屬單元的生字。
  - 稽核頁／匯出 → 只抓「畫面上那組篩選」對應的那一頁（含 `count=exact` 的總數）。
  - 書架／目錄／統計 → **只抓 `unit_id,status` 兩個小欄位來算數字**，不搬整列資料。
  - 寫入才需要配 id（`order=id.desc&limit=1` 三個極小查詢）。
- ★ **安全設計（最重要）**：存取「沒有被 prefetch 到的範圍」會直接拋 `STORE_WINDOW_MISSING`，
  **不會靜默回空資料**。這代表萬一我漏了哪條路由，你會看到明確的 500 與錯誤訊息，而不是「畫面空白但沒人知道」。
- 用 `AsyncLocalStorage` 保存「這個請求的視窗」：兩個請求在 await 交錯時不會互相污染
  （用模組變數就會發生 A 請求讀到 B 請求的資料）。
- 沒有請求上下文時（`npm run seed`、腳本、測試）走 **full 模式**：照舊整表抓，行為與以前相同。
- **還沒做**：數字目前是抓 `unit_id,status` 兩個小欄位自己算（不需要資料庫函式）。
  要做到「連一列都不搬」，可以在資料庫加一個聚合函式（RPC）—— 那需要你自己跑一段 SQL（我沒有 DDL 權限），
  已寫在規劃書裡當後續優化。

### 3. 字級鈕排成階梯（你指定：A− 要比 A 小）

- `#fontSwitch` 三顆鈕現在是 0.72rem < 0.85rem < 1rem，光看按鈕就知道按下去會變大還是變小；
  真瀏覽器檢查會驗「A− 比 A 小、A+ 比 A 大」以及「按下去根字級真的變小→中→大」。

### 4. 網址收尾（你指定：舊網址接回、短網址登記）

- Vercel 專案 `gary-dictionary` 現在同時掛四個網域：**`gary-dictionary.vercel.app`（新的短網址）**、
  `gary-dictionary-mylearning.vercel.app`、`pv-dictionary.vercel.app`、`pv-dictionary-mylearning.vercel.app`。
  舊網址以前被釘在 v0.5.0，現在會**跟著新版一起更新**（學生的舊書籤不會再看到舊版）。
- 新增 `scripts/vercel-domains.js`（`--list`／`--add`／`--remove`）與 `scripts/vercel-redeploy.js`
  （用 GitHub 整合建立部署；舊的 redeploy API 現在一律 404）、`scripts/cleanup-test-data.js`
  （清掉驗收腳本萬一留下的測試年級）。

### 5. 規劃書重新整理（你指定）

`docs/規劃書-待完成.md` 從 272 行縮到只放**還沒做的事**（D-1b、D-6 容量月檢、A-2 備份、B-8 刪除年級／單元、
B-9 列印學習單加強、F-1 手機實測、F-2 PWA、F-5 學生端小功能），完成的部分改成簡表連到各版 release 說明。

### 測試（實跑）

| 項目 | 指令 | 結果 |
|---|---|---|
| 語法 | `npm run check:syntax` | 71/71 通過 |
| 單元／API／守門 | `npm test` | **159 通過 / 0 失敗**（新增：欄位回歸 2 支、視窗化 2 支） |
| 真 Chrome（本機） | `npm run check:browser` | **307 項全綠**：demo 106（＋3：字級鈕階梯）＋ empty-start 33 ＋ lang 40 ＋ users 128 |
| 線上（含生字完整流程） | `node scripts/live-verify.js --no-auth --ephemeral-teacher` | **26 通過 / 0 失敗 / 1 略過**（含生字完整流程：建立年級→單元→生字→讀回→改→舊版本被擋→刪除→清理） |
| 線上健康檢查 | `npm run uptime` | 4 項全綠（版本 0.6.1、資料庫 ok、公開讀取、首頁） |
| 正式站真瀏覽器 | `npm run check:live-browser` | **16 通過 / 0 失敗** |
