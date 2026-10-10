# v0.12.0 — 刪除年級／單元（B-8）＋ Neon 每季追蹤（D-9）＋ 發版前檢查

> 使用者 2026-10-10 指定的三件事：① 刪掉 Supabase 專案（並停用舊回滾變數）
> ② D-9 每季追蹤 ＋ B-8 刪除年級／單元 ③ **每次更新都要檢查有沒有錯誤記錄需要處理**。

## B-8（P2）刪除年級／單元

以前只能建立與改名，複製錯或單元開錯年級時只能留著。現在：

- **年級列**（✏️ 管理 → 📗 新增年級）與**單元列**（目錄）各多一顆 🗑。
- **兩段式確認**（不用原生 confirm）：第一次點 🗑 先打 `.../delete-preview`，
  在那一列下面長出確認列，寫明**會連帶刪掉幾個單元／生字／錄音**；按「確定刪除」才會真的刪。
  後端也要求 `?confirm=1`（前端忘了問也刪不掉，回 409 與同一份數字）。
- **裡面還有東西時只有網站管理員能刪**（回 403 `DELETE_NEEDS_SITE_MANAGER`）——
  生字與錄音是老師的心血，不能讓任何一位老師隨手清掉；空年級／空單元老師就能刪。
- **稽核**各留一筆（`BOOK_DELETE`／`UNIT_DELETE`），內容包含連帶刪掉的數量。
- **刪除是分批的**：`store.deleteUnitDeep()` 先抓 500 個 id、刪一批、再抓下一批。
  為什麼：實測「一次刪掉一個大單元（10,000 筆）」會讓 Neon 回 `53200 out of memory`
  （那個 DELETE 自己把 instance 的記憶體吃光），刪完還留下一堆殘留資料。
- 站內使用說明補了一節「老師：刪除年級與單元」（`guide.delete.*`），
  `tests/guide.test.js` 會守門（說明提到的元素要真的存在、對象要真的有那個能力）。

## D-9（P2）Neon 的規模與風險「每季追蹤」

- **`npm run quarterly`**（`scripts/quarterly-review.js`）：各表筆數、資料庫大小與用量百分比、
  **上次季度檢查是幾天前**，以及一份「現在該做什麼」的待辦（生字 ≥ 5000 就值得重跑壓測、
  用量接近一半就先清理、錯誤日誌 ≥ 500 筆就去看一看）。
- **`npm run quarterly -- --record`**：人工看完 Neon 官網的免費方案條款與公告後記錄下來
  （寫 `logs/quarterly-review.json`，保留最近 20 次歷史）。
- **launchd agent** `com.garycheong.gary-dictionary-quarterly`：**每季首日 08:40** 自動跑（帶 `--notify`），
  有代辦事項就用 macOS 通知提醒；紀錄寫在 `logs/quarterly.log`。
- 那「人工的一半」（Neon 條款與公告可能變動，Data API 還在 Open Beta）沒辦法自動化，
  所以設計成「自動算數字 ＋ 提醒你去看」。

## 發版前檢查：`npm run release:check`

使用者指定「每次更新都要檢查有沒有錯誤記錄需要處理」，所以做成一個指令（詳見 `docs/發版流程.md`）：

1. 本機：語法、schema、`npm test`。
2. **錯誤記錄檢查**：直接讀線上 `dict_error_logs`，把未處理的錯誤依 `code → path` 分組列出。
   **最近 24 小時內**出現的未處理錯誤會**擋住發版**；`ASSET_LOAD`／`CSP_VIOLATION`
   （使用者端瀏覽器或擴充功能造成）只提醒不擋。
3. 線上：`uptime`、`live-verify --ephemeral-teacher`、正式站訪客視角。

**這一版實際用它處理掉了 38 筆未處理的錯誤紀錄**（全部是已經修好的根因或使用者端造成）：
`DB_UNAVAILABLE out of memory`（D-11 已修）、`STORE_WINDOW_MISSING`（v0.11.1 音檔視窗、
audit 視窗已修）、`errText is not defined`（已修）、`updated_at` 欄位（v0.6.1 已修）、
`ASSET_LOAD`／`CSP_VIOLATION`（使用者端）。處理後 `npm run release:check -- --errors` 回
「✔ 沒有未處理的錯誤紀錄」。

## Supabase 停用（使用者決定）

- 使用者決定刪掉 Supabase 專案 → `.env` 的 `SUPABASE_URL_SUPABASE`／`SUPABASE_SERVICE_ROLE_KEY_SUPABASE`
  兩行**已註解**（保留紀錄、不再使用）；`.env` 備份一律只留最近 3 份。
- `node scripts/switch-backend.js --to=supabase` 若被按到，會直接說明「已停用、請改用備份還原
  （`npm run restore`，備份在私有 repo）」而不是丟一句看不懂的錯誤。
- 線上完全不受影響（四個網址、備份、還原、監控都指向 Neon）；會失去的只有「切回 Supabase」這個備案，
  資料本身在 Neon 與私有備份 repo 都有。

## 驗證（2026-10-10）

| 項目 | 結果 |
|---|---|
| 語法／單元測試 | 85/85、`npm test` **187/0**（新增 B-8 端到端測：預覽→403／409→真的刪→稽核） |
| schema／路由快照 | 通過（路由快照已更新：55 條） |
| 發版前檢查 | `npm run release:check -- --errors` → ✔ 沒有未處理的錯誤紀錄 |
| 線上驗收 | `live-verify` 25/0/1、訪客視角 23/0、`uptime` 6/6 |
| 本機真瀏覽器 | 329/0（B-8 說明節與 UI 元素守門） |
| D-9 實跑 | 各表筆數正確（books 1／units 2／entries 75／users 2）、用量 12.00 MB / 1024 MB（1.17%） |

★ 這一版**沒有動到資料層的視窗邏輯**，所以線上風險較低；但 B-8 的刪除是破壞性操作，
所以「有內容只有網站管理員能刪」＋兩段式 ＋ 稽核三重保護。
