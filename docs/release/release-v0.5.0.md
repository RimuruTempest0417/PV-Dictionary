## Gary-Dictionary v0.5.0 — 改成「年級制」＋ 更名 Gary-Dictionary

這一版把「書本」這一層從畫面上拿掉：**只看得到年級**（例：S1／S2／S3），
書名與封面**在整個流程裡都不再出現 —— 包括管理區**，另外把網站名稱與標題改成 **Gary-Dictionary**。

### 1. 年級制：書名與封面完全消失

| 之前 | 現在 |
|---|---|
| 書架是一張張書本封面 + 書名 | 書架是一個個**年級**（大字顯示，例如 S1），下面寫單元數與生字數 |
| 點書本 → 該書的單元 | 點年級 → 該年級所有單元（Unit 1、Unit 2…） |
| 管理區有「📗 新增書本」（代號＋書名＋年級） | 管理區是「📗 新增年級」**只要填年級**（代號由系統自動產生、書名不再存在於畫面上） |
| 管理區有「🖼 書本封面」可以上傳照片 | **整個封面功能移除**（分頁、上傳、預覽、刪除都不見了） |
| 稽核紀錄寫「Book 5A Unit 3 …」 | 稽核紀錄寫「S1 · Unit 3 …」 |
| 「我的單元」與授權選單顯示書名 | 顯示年級 |

作法上的重點：

- **對外的書本資料改成白名單**：以前是「複製全部欄位再刪掉封面」，現在只挑 `id / grade / is_published / sort_order`
  出來 —— 這種寫法才不會在下一次改動時又不小心把書名或別的欄位洩漏出去。
- **年級一律走 `gradeOf(book)`**：優先 `grade`，舊資料沒有 grade 時退回 `code`（短代號，不含書名），
  最後才是「—」。**絕不會**退回 `name`（那就是書名）。
- **資料庫欄位不動**：`code`／`name`／`cover_*` 這些欄位保留（不刪欄位以免動到既有資料），
  但沒有任何端點會讀寫封面；`tests/schema.test.js` 反過來守著「程式不可以再碰到 cover_*」。
- 已移除的路由：`GET /api/covers/:id`、`POST/DELETE /api/books/:id/cover`；新增的錯誤碼：`BOOK_GRADE_REQUIRED`、`DUPLICATE_GRADE`。

### 2. 更名：Gary-Dictionary

- 瀏覽器分頁標題與頁面上的品牌字樣：`PV_Dictionary` → **`Gary-Dictionary`**（含中英文字串）
- `package.json` 名稱與 `/api/version` 的 `name`：`gary-dictionary`
- GitHub Release 的標題也用新名字
- **不動的**：GitHub repo 仍是 `PV-Dictionary`、Vercel 專案與網址仍是
  `pv-dictionary-mylearning.vercel.app`（改這兩個會換網址、影響你已經發出去給學生的連結）。
  要換網址的話跟我說，我再開一版處理。

### 3. 使用說明同步更新（新功能守門照舊）

說明頁的「年級與單元」段落改成新流程（新增年級只要填 S1），並移除封面相關的文字；
**管理分頁與說明頁的對照守門仍然有效**（新增分頁沒寫說明就紅燈），所以不會漏。

### 測試（實跑）

| 項目 | 指令 | 結果 |
|---|---|---|
| 語法 | `npm run check:syntax` | 66/66 通過 |
| 單元／API／守門 | `npm test` | **150 通過 / 0 失敗**（新增：書架只回年級、書名不可出現在任何 API 回應、封面欄位不再被程式用到；移除封面測試） |
| 真 Chrome | `npm run check:browser` | 四支共 **288** 項全綠：demo **95**（+3：書架只顯示年級、沒有書名與封面、新增年級流程、稽核用年級）＋ empty 33 ＋ lang 40 ＋ users 120 |
| 線上 | `npm run uptime`、`live-verify` | 部署後實跑（見 README 的發版紀錄） |
