## Gary-Dictionary v0.7.0 — 生字數改由資料庫聚合、容量月檢、說明頁手機表格修正

這一版做三件事：**D-1c（資料庫聚合）**、**D-6（容量月檢與 70% 提醒）**，
以及你回報的**「英語版 Help 最下方表格是不是突出」**（查下去發現不只是突出，是把整頁撐出橫向捲軸）。

### 1. D-1c：生字數不再把資料搬回來自己算

- 以前每次快取過期，都要抓 `unit_id,status` 兩個欄位回來自己 bucket 計數（一萬個生字約 200KB 的搬運量）。
- 現在改呼叫資料庫的 `dict_entry_counts()`：`group by` 在資料庫裡做完，只回「每單元每狀態幾筆」。
- 回傳形狀**刻意與以前完全相同**（`{unit_id, status, n}`）→ `countEntries()`／`countAllEntries()` 一行都不用改。
- 線上讀回：`dict_entry_counts()` → `[{"unit_id":1,"status":"published","n":1}]`（與你站上 1 個生字相符）。
- 假 PostgREST（`tests/supabase.test.js`）也長出 `/rest/v1/rpc/*`，並加一條回歸測試
  「**不可以再抓 `select=unit_id,status`**」——否則改壞了本機也看不出來。

### 2. D-6：容量月檢與提醒（門檻 70%）

- 新增 `lib/limits.js`：配額 **500MB**、警告門檻 **70%** 的**唯一來源**（server 與腳本共用，不再各寫一份）。
- `/api/health` 與 `/api/admin/stats` 都回 `usage`：**真實資料庫大小**（來自 `dict_db_size()`）、百分比、門檻。
- 後台「📊 概況」多一列「資料庫用量」，到門檻會變警告色，並寫清楚「先清稽核／錯誤日誌，再刪沒用到的錄音」。
- `npm run usage` 與 `npm run uptime` 超過門檻**回非 0** —— 以前它們有警告卻回 0，
  等於排程與監控**永遠看不到**（那正是這一項要解的問題）。
- ★ **量不到就明說量不到**：`dict_db_size()` 還沒建立時，`usage.available` 是 `false` 並附原因，**不會假裝 0%**。
- 目前的真實用量：**13,072,051 位元組 ≈ 12.47 MB（500MB 的 2.5%）**。

### 3. 說明頁最下方的表格在手機上不再撐破畫面（你回報的）

- 我用 iPhone 直式（390×844）實測：**英文版**的角色權限表（8 列 × 7 欄）
  最小寬度約 **500.6px**，而說明面板只有 **332px** → 表格不只突出，還把**整頁**撐出 **140px 的橫向捲軸**。
  中文版因為可以逐字斷行，剛好塞得下（332px 已經是緊繃的）。
- 修法：表格外面包一層可橫向捲動的框（`.guide-table-wrap`）。表格本身不變，手指左右滑就看得到後面的欄。

| 量測（390px 寬，英文版） | 修正前 | 修正後 |
|---|---|---|
| 整頁橫向溢出 | **140px** | **0** |
| 表格寬 / 面板寬 | 500.6 / 332 | 500.6 / 332（在框內捲動） |

- 守門（**這次漏掉的地方**）：以前的手機檢查只在**書架畫面**量寬度，從沒打開 Help 面板。
  現在 `lang-check`（402px）與 `live-check`（390px）都會**打開 Help**、斷言
  「整頁不溢出 ＋ 表格待在可橫向捲動的框裡」。

### 測試（實跑）

| 項目 | 指令 | 結果 |
|---|---|---|
| 語法 | `npm run check:syntax` | 74/74 通過 |
| 單元／API／守門 | `npm test` | 168 通過 / 0 失敗 |
| 真 Chrome（本機） | `npm run check:browser` | **329 項全綠**（demo 118 ＋ empty 33 ＋ lang 42 ＋ users 136） |
| 線上 schema／函式 | `npm run check:schema:live` | 通過（含 v0.7.0 兩個函式都存在） |
| 線上驗收 | `live-verify --ephemeral-teacher` | **26 通過 / 0 失敗 / 1 略過**（資料筆數回到開始前） |
| 正式站真瀏覽器 | `npm run check:live-browser` | **22 通過 / 0 失敗**（含新增的「Help 面板手機不溢出」兩項） |

**上線後讀回（實測）**

- 四個網址的 `/api/version` 都是 `0.7.0`。
- `/api/health` 的 `usage`：`{"available":true,"bytes":13072051,"human":"12.47 MB","quota_human":"500.00 MB","percent":2.5,"warn_percent":70,"warn":false,"source":"dict_db_size()"}`。
- `npm run uptime` 多了一行：**`✔ 資料庫容量 → 12.47 MB / 500.00 MB｜2.5%｜門檻 70%`**。
- 書架 API（D-1c 實際走的路徑）在正式站回 `unit_count:1, entry_count:1` —— 聚合函式在 production 正常運作。

### 需要你在 Supabase 做的那一步（已完成）

`dict_entry_counts(unit_ids bigint[])` 與 `dict_db_size()` 兩個函式**只能在你的 SQL Editor 建立**
（我的金鑰只能讀寫資料、不能改 schema）。你已執行，我也讀回確認兩支都存在並回正確的值。
`scripts/schema-check.js` 現在會自動檢查這兩支函式在不在（不在就紅燈並告訴你要貼哪一段）。
