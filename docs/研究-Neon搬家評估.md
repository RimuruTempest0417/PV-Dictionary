# 研究：把資料庫從 Supabase 搬到 Neon（影子驗證結果）

> 寫於 2026-10-10（v0.8.0）。做法：**不碰正式站**，在 Neon 的獨立專案上套同一份 schema、
> 用**同一套 v0.7.0 程式碼**指向它跑完整驗收，再比對延遲與授權模型。
> 相關：`docs/研究-備份與資料庫替代方案.md`（方案比較）、`docs/規劃書-待完成.md`（Roadmap）。

## 0. 結論

**可以搬，而且產品程式碼幾乎不用改** —— store adapter 是照 PostgREST 寫的，Neon Data API **完全相容 PostgREST**
（官方原話：*fully compatible with PostgREST*），實測連 `Prefer: return=representation`、
`content-range` 計數、`in.(…)`、巢狀 count、以及 `POST /rest/v1/rpc/<fn>` 都一樣可用。

**但授權模型完全不同**，這是搬家真正的工作量（一次性設定，不是改程式邏輯）：

| | Supabase（現在） | Neon（Data API） |
|---|---|---|
| 身分 | `service_role` key（長字串）直接繞過 RLS | **必須是合法 JWT**（非 JWT 格式 → **HTTP 400**） |
| 驗簽 | 平台內建 | 專案要註冊 **JWKS URL**（我們自己簽、自己發公鑰） |
| 授權 | RLS 政策（service_role 例外） | **JWT → Postgres 角色 → GRANT ＋ RLS 政策**（兩層都要） |
| 額外要求 | — | JWT 必須帶對 **`aud`**（本專案＝`gary-dictionary`），否則 `missing required audience` |

## 1. 實測數據（2026-10-10）

**環境**：Neon 專案 `Gary-dictionary`（`still-dawn-90059323`，`aws-ap-southeast-1` 新加坡）；
分支 `production`（`br-small-field-b3o1q524`）；branch storage 上限實測 **1 GB**。

| 驗證項目 | 結果 |
|---|---|
| schema（8 張表＋2 函式） | ✅ 與 Supabase 版一致（`migrations/neon/2026-10-10-neon-schema.sql`） |
| 讀取 `dict_books` | ✅ HTTP 200 |
| RPC `dict_entry_counts()`／`dict_db_size()` | ✅ HTTP 200（8.7 MB） |
| 寫入（POST 建年級） | ✅ HTTP 201 |
| `/api/health`（本機 server 指向 Neon） | ✅ `backend: supabase`、`schema_ready: true`、容量走 `dict_db_size()` = 8.33 MB／1.7% |
| `/api/books` | ✅ |
| `live-verify --no-auth --ephemeral-teacher` | ✅ **25 通過 / 0 失敗 / 1 略過**（建年級→單元→生字→改→409 樂觀鎖→刪→清理，筆數回 0） |

**延遲**（同區：Mac ↔ 新加坡）

| 情境 | Supabase REST | Neon Data API |
|---|---|---|
| 暖機（連續請求） | 0.11–0.15 秒（久未使用後第一次 3.61 秒） | 0.14–0.22 秒 |
| 閒置 5.5 分鐘後第一個請求 | — | 0.24 秒（還沒真的休眠） |
| **閒置 7 分鐘後第一個請求（確認已休眠）** | — | **1.29 秒**（連線 0.18＋TLS 0.23，喚醒約 0.9 秒），第二個 0.14 秒 |

→ 冷啟動約 +1 秒，**與我們現在 Vercel 函式的冷啟動同一個量級**（實測正式站 `/api/version` 1.08 秒、`/api/books` 0.91 秒）。

**資料庫用量**：空庫 `logical_size` 32 MB（含 `neon_auth` schema）；我們的資料 8.7 MB。

## 2. 搬家要改的東西（清單）

1. **Neon 端（已完成，之後重建專案照抄）**
   - 套 `migrations/neon/2026-10-10-neon-schema.sql`（差異：Neon 沒有 `anon`／`authenticated` 內建角色，
     要把 Supabase 版的 `revoke … from anon, authenticated` 改成 `revoke … from public`）。
   - `grant usage on schema public to authenticated` ＋ 表／序列的 GRANT ＋ default privileges。
   - 8 張表各一條 `for all to authenticated using (true) with check (true)` 政策（語義等同 service_role；
     正式搬家後若要細分權限就在這裡加角色）。
   - Data API：Enable（Console）＋ 註冊 JWKS URL ＋ 設定 JWT Audience = `gary-dictionary`。
2. **我們這邊（一行環境變數）**
   - `SUPABASE_URL` → `https://<endpoint>.apirest.<region>.aws.neon.tech/<db>`（**不要**帶 `/rest/v1`）。
   - `SUPABASE_SERVICE_ROLE_KEY` → 我們自己簽的 JWT（`node scripts/neon-jwt.js`）。
   - `DATA_BACKEND=supabase` **不變**（adapter 是 PostgREST 通用層，實測不用改一行）。
3. **要定期做的事**：JWT 有到期日（預設簽 365 天）→ 到期前重簽並推新的 Vercel 環境變數。
   （金鑰本身沒有壞掉就不用換；要換就 `--make-keys` ＋ 更新 Neon 的 JWKS。）
4. **小地方要跟著改**
   - `lib/limits.js` 的 `DB_QUOTA_MB` 500 → **1024**（Neon 是 1 GB），門檻 70% 不變。
   - `scripts/schema-check.js` 的線上 schema 檢查用 Supabase 的 OpenAPI 位置；原本評估 Neon 在 `/rest/v1/openapi.json`，
     **但實測回 404 —— Neon 的 Data API 不提供 OpenAPI**，因此改用**逐表探測**（`lib/schema.js` 的 `probeLiveColumns`）。
     ★ 結論已被實作推翻：最後不是「加一個分支走 Neon 的 OpenAPI」，而是換成探測法（見 `docs/搬家到Neon.md`）。
   - `scripts/uptime-check.js`／`db-usage.js` 不用改（走我們的 `/api/health`）。
5. **正式切換（v0.10.0 的內容）**
   - 資料搬遷：Supabase 匯出 → Neon 匯入（`pg_dump`／CSV＋`psql \copy`），搬完比對每張表筆數與
     `dict_db_size()`；音檔是 base64 存在 `dict_audio.data`，一併帶過去。
   - 建議：`vercel-dev` 分支先切（Vercel 已自動建好這個 Neon 分支），確認後再切 `production`。
   - 保留 Supabase 一段時間當退路（免費方案閒置會被暫停，但資料還在）。

## 3. 風險與還沒驗證的事

- **沒測過有資料量的情況**：目前 Neon 是空庫（8.7 MB）。真實資料（音檔 base64）長大後要再測一次
  1 GB 上限與查詢延遲；參考 `lib/limits.js` 的 70% 門檻設計。
- **沒有測併發與多使用者**：免費方案是 0.25 CU 固定算力，尖峰（很多人同時上傳錄音）要觀察。
- **Data API 的「Maximum rows per request」預設是空的**（不限制）；我們最重的查詢是
  `dict_audio?select=…&limit=100000`，若日後資料多要改走分頁或設這個上限。
- **Neon Data API 目前是 Open Beta** —— API 形狀可能變動，這是目前最大的外部風險。
- **REST 之外的介面**：Neon 也提供 `@neondatabase/serverless` 直連 Postgres；若 Data API 出問題，
  還有直連 SQL 這條路（但我們就得自己寫 SQL 層）。
- **備份還原流程**：Neon 免費方案有 instant restore（6 小時內）＋ 手動建立 branch 當還原點，
  還沒演練過；這也是 A-2（備份到私有 GitHub repo）要補的。

## 4. 建議

技術上**已經證明可行**（同一套程式跑完整驗收全綠）。建議順序：

1. **v0.9.0：A-2 備份到私有 GitHub repo**（對現有的 Supabase 資料先有備份，這是搬家前該有的保險）。
2. **v0.10.0：正式搬家到 Neon**（含資料搬遷與切換步驟）。
3. 之後若資料長大到 1 GB 或需要更穩的算力，再評估 **Oracle Always Free 自架**（200 GB／2 OCPU）。

> ★ 誠實註記：上面的「可以搬」是**空庫**上的驗證。真實資料量的驗證要等搬遷當天一起做（匯入後跑同一套
> `check:schema:live` ＋ `live-verify` ＋ 延遲量測）。
