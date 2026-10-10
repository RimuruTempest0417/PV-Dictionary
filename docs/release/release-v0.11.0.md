# v0.11.0 — 把規模天花板拆掉（D-11）＋ 每日監控（D-8）＋ 權限一致（D-10）

> 這一版是使用者指定的三件事。**v0.11.1 是它的熱修**（分頁改動造成的線上 500，見
> `docs/release/release-v0.11.1.md`）—— 功能內容以本檔為準，數字是修好之後實測的。

## D-11（P1）單元頁改成「向資料庫要一頁」：拆掉已知的規模天花板

**為什麼**（2026-10-10 先量再改）：在**同一個單元塞 10,000 個生字**時，舊寫法
（把整個單元的生字搬進伺服器記憶體，再在 JS 分頁）的實測：

| 情境（10,000 筆的單元） | 修前 | **修後（v0.11.1 實測）** |
|---|---|---|
| 單元第一頁 | 2,575 ms | **122 ms** |
| 單元最後一頁 | 2,533 ms | **113 ms** |
| 搜尋（命中 1 筆） | 2,705 ms | **136 ms** |
| 搜尋（無命中） | 2,668 ms | **116 ms** |
| 24 條併發、15 秒 | 1,096 個請求有 **1,077 個回 503**（只有 19 個成功） | 524 個請求有 **4 個回 503**（520 個 200） |
| 刪除測試資料 | Neon 回 `53200 out of memory`，殘留 10,001 筆 | **✔ 筆數與開始前一致（1/1/1）** |
| 灌資料速度 | 4,927 筆/秒 | 4,052 筆/秒（同一個量級） |

**診斷的關鍵對照**：同時間用**輕查詢**測 30 條併發是 **100% 成功、零 503**
（Neon 直連 p50 66 ms、正式站 p50 93–260 ms）→ 瓶頸不是併發、不是 Vercel，
而是**每個單元請求都把整個單元的生字搬進記憶體**。

**怎麼改**：

- `GET /api/units/:id` 改走新的 `store.listEntriesPage()`：向 PostgREST 要一頁
  （`unit_id=eq.` ＋ `limit`／`offset` ＋ `Prefer: count=exact`；搜尋用 `or=(…ilike…*)`；
  狀態在資料庫端過濾）。`total` 直接來自資料庫的 `Content-Range`。
- 錄音數（D-3 的每單元上限）改用新的資料庫函式 **`dict_unit_audio_counts()`**
  （`migrations/neon/2026-10-11-unit-audio-counts.sql`，已套用到 Neon）。
- `/api/audio/:id` 改成**直接抓那一筆**，不再依賴「剛好被載入的視窗」。
- 需要整個單元的路由（新增生字要檢查重複與排序、複製單元、匯入）維持原行為 ——
  那些是低頻的寫入路徑，且「大聲失敗」的視窗機制照舊（沒載入就拋 `STORE_WINDOW_MISSING`，
  不靜默回空資料）。
- 本機 JSON 模式的 `listEntriesPage()` 用同一組欄位與比對方式（測得到的行為一致）。

**守門測試**（`tests/supabase.test.js`）：單元頁 prefetch **連一次生字都不抓**；
一頁只打一次資料庫且帶 `limit`／`offset`／`count=exact`／`unit_id=eq.`；
搜尋走 `or=…ilike…`；沒有老師錄音的生字查音檔要回 `null` 而不是拋錯（← 這條是 v0.11.1 補的）。

## D-8（P2）每日自動健康檢查 ＋ macOS 通知

- **`npm run monitor`**（`scripts/monitor.js`）：跑同一支 `scripts/uptime-check.js`
  （版本／健康／容量／**金鑰效期**／公開讀取／首頁），**失敗時發 macOS 通知**並回非 0；
  `--no-notify`（只檢查）、`--dry-run`（只印通知內容）、`--site=` （換對象）。
- **launchd agent** `com.garycheong.gary-dictionary-monitor`：**每天 08:30** 跑一次（已載入並實測 exit code 0）。
- **逐字紀錄寫進專案內 `logs/uptime.log`**（每行時間戳；512KB 輪替；`*.log` 已在 `.gitignore`）。
- 平常正常時**不發通知**，只有異常才彈（不吵人）。

## D-10（P2）權限模型的小矛盾：被授權的人「前端也說可以」

- 以前：後端 `Roles.canEditUnit()` 認授權（被授權的學生編得動），但
  `lib/capabilities.js` 只看角色 → `/api/auth/me` 回 `can_edit:false` → 前端把按鈕藏起來。
- 現在：`lib/roles.js` 新增 `hasGrant()`（判準與 `canEditUnit`／`canPublishUnit` 對齊：
  `can_edit` 不是明確 false 就算、`can_publish` 要明確 true），
  `capabilities.check()` 除了角色也認授權，`/api/auth/me` 帶入該使用者的授權列。
- **端到端守門測試**：沒授權 → `can_edit:false`；建立授權後 → `true`；而且**真的編得動**
  （新增成功、且因為不能直接發佈而進「待審核」）；單元頁的 `can_edit` 與 `/api/auth/me` 一致。

## 其他（含一個正式站的真 bug）

- **修好 `admin.js` 的 `errText` 未定義**：它用了 6 次 `errText()`，但函式只定義在 `app.js` 的
  IIFE 裡（不是全域）→ 管理區**每一條錯誤路徑都丟 `ReferenceError`**（正式站錯誤日誌的
  `UNHANDLED_REJECTION`），使用者看到的是「錯誤處理自己壞掉」。已補上定義，
  並加 `tests/frontend-scope.test.js` 守門（前端裸函式必須在檔案內定義或來自 `window.PD*`）。
- **日誌搬進專案**（使用者指定）：`scripts/backup.js` 與 `scripts/monitor.js` 自己把逐字紀錄
  寫進 `logs/backup.log`／`logs/uptime.log`。
  ★ 為什麼不是讓 launchd 寫：**launchd 在 `~/Documents` 開檔會被 macOS TCC 擋掉**，
  整個 job 連啟動都失敗（實測 `exit code 78: EX_CONFIG`、`job state = spawn failed`）——
  只有拿到「完全取硬碟存取權」的 node 寫得進去。launchd 的輸出退回 `~/Library/Logs/*.launchd.log` 當後備。
- 移除已無用途的 `matchesEntryQuery`（搜尋已下推資料庫）；`scripts/schema-check.js` 的線上守門
  涵蓋新函式。
- 線上 schema 守門、`uptime`、`live-verify`、`check:live-browser`、`monitor` 全部通過。

## 驗證（v0.11.1，2026-10-10）

| 項目 | 結果 |
|---|---|
| 語法／單元測試 | 84/84、`npm test` **186/0** |
| 線上 schema | 通過（8 張表＋3 個函式） |
| 線上端到端 | **25 通過 / 0 失敗 / 1 略過** |
| 正式站訪客視角 | **23/0** |
| 監控 | 6/6 通過 |
| 正式庫筆數 | **1 書／1 單元／1 生字**（與開始前一致） |
