# v0.10.0 — 資料庫從 Supabase 搬到 Neon

> 這一版的目的是**換掉資料庫**（Supabase 免費方案的限制與不確定性），**不是**改功能。
> 使用者看得到的東西原則上都一樣，只有頁尾的資料庫名稱從「Supabase（PostgreSQL）」變成「Neon（PostgreSQL）」。

## 為什麼搬

- Neon 免費方案：**100 個專案**、每個專案 **1 GB**（實測 branch storage 上限）、合計約 20 GB、
  閒置自動休眠（喚醒約 1 秒）、6 小時 instant restore、**PostgREST 相容的 Data API**、
  新加坡同區（`aws-ap-southeast-1`）。
- Supabase 免費方案只有 500 MB 且閒置會暫停；搬過去後容量門檻從 500MB 改成 1GB，
  而且我們手上有一份自己的備份（v0.9.0）。

## 搬家怎麼做的（重點：程式碼沒有改）

1. **v0.8.0 已經證明相容**：同一套程式指向 Neon 跑完整驗收 25/0/1（`docs/研究-Neon搬家評估.md`）。
2. **v0.9.0 已經證明資料搬得動**：備份還原到 Neon 空庫、8 張表筆數全對（`docs/備份與還原.md`）。
3. 這一版：Neon 端建 schema ＋ GRANT／RLS ＋ Data API 授權（自簽 JWT ＋ JWKS ＋ `aud`），
   資料用備份還原過去，然後改 `.env` 的兩個變數並推上 Vercel。
4. **切換與回滾都是一條指令**：`node scripts/switch-backend.js --to=neon｜--to=supabase｜--rollback｜--status`
   （切換前會把 `.env` 備份成 `.env.bak-<時間>`）。

## 改了什麼

| 檔案 | 變更 |
|---|---|
| `scripts/switch-backend.js`（新） | Supabase ↔ Neon 切換、狀態查詢、一鍵回滾（金鑰全程不印出） |
| `lib/schema.js` | 新增 `probeLiveColumns()`：Neon 的 Data API **沒有 OpenAPI 規格**（回 404），改用它逐表探測欄位 |
| `scripts/schema-check.js` | 線上 schema 檢查自動選 OpenAPI（Supabase）或探測法（Neon） |
| `lib/limits.js` | `DB_QUOTA_MB` **500 → 1024**（Neon 是 1 GB；門檻仍是使用者指定的 70%） |
| `server.js`＋`lib/store/index.js`＋`public/js/app.js`＋`public/js/i18n.js` | `/api/health` 多回 `backend_kind`，頁尾顯示真正的資料庫名稱（新增 i18n `backend.neon`） |
| `scripts/uptime-check.js` | 新增「資料庫金鑰效期」：JWT 剩不到 30 天就回非 0 提醒（過期會讓整個網站讀不到資料） |
| `tests/schema-probe.test.js`（新） | 探測法的 4 個單元測試（挑掉壞欄位、整表不存在、不會無限迴圈、回報形狀） |
| `tests/browser/live-check.js` | 新增守門：**頁尾的資料庫名稱必須與 `/api/health` 一致**（就是這次差點漏掉的標籤） |
| `docs/搬家到Neon.md`（新） | 做法、驗證、**回滾步驟**、JWT 輪替 |

## 驗證（2026-10-10，實測）

- 資料：Neon 8 張表筆數與備份完全一致（93 筆）；正式站書架顯示真實內容（`S2`：1 單元／1 生字）。
- 本機：`npm test` **180 / 0**、`npm run check:syntax` 81/81。
- 線上：四個網址跟版；`live-verify --ephemeral-teacher`、`check:live-browser`、`check:schema:live`、
  `npm run uptime` 全綠；頁尾顯示 **Neon（PostgreSQL）**。
- 容量：`9.80 MB / 1024.00 MB（1%）`。
- 延遲（暖機 0.14–0.22 秒；閒置 7 分鐘後第一個請求 1.29 秒）——與原本 Vercel 函式的冷啟動同量級。

## 風險與未驗證

- **Neon Data API 目前是 Open Beta**（形狀可能變動）——最大的外部風險，但資料都有備份。
- 併發與真實資料量還沒驗證（目前資料量極小）。
- **JWT 一年到期**：`npm run uptime` 會在剩 30 天內提醒；重簽指令寫在 `docs/搬家到Neon.md`。
- Supabase 專案**保留**當退路（沒有刪資料），回滾指令見文件；但切換後在 Neon 上的新資料不會自動回同步。
