# v0.8.0 — Neon 影子驗證（無產品功能變更）

> 這一版**沒有動到使用者看得到的任何功能**，是一批「基礎建設與驗證」的提交。
> 目的：回答「能不能把資料庫從 Supabase 搬到 Neon？」（規劃書 Roadmap 的 v0.8.0）

## 做了什麼

1. **Neon 版 schema**（`migrations/neon/2026-10-10-neon-schema.sql`）
   與 Supabase 版刻意一致；唯一差別是 Supabase 專屬的 `revoke … from anon, authenticated`
   在 Neon 會 `role "anon" does not exist`，改成對 `public` 撤銷。
2. **Neon Data API 的授權**：`authenticated` 角色的 GRANT ＋ 8 張表各一條 RLS 政策。
3. **自簽 JWT 的工具**（`scripts/neon-jwt.js`）
   - Neon Data API 的授權是「JWT ＋ GRANT／RLS」——**沒有 JWT 一律 400**，Supabase 的 service_role 硬闖不適用。
   - `--make-keys` 產生 RSA 金鑰組：**公鑰**放 `public/keys/jwks.json`（由本站提供，Neon 抓它來驗簽）、
     **私鑰**只進 `.env`（不進版控）。
   - 簽出的 token 帶 `role=authenticated`、`aud=gary-dictionary`（Neon 專案設定的 audience）、預設 365 天。
4. **影子驗證**（不碰正式站）：起本機 server 指向 Neon，用**同一套 v0.7.0 程式碼**跑
   `live-verify --no-auth --ephemeral-teacher` → **25 通過 / 0 失敗 / 1 略過**；
   `/api/health` 的容量走 Neon 的 `dict_db_size()`；測試資料全部清乾淨（8 張表回 0）。
5. **修掉兩個真的會咬人的問題**
   - `scripts/live-verify.js`：清理稽核紀錄時寫 `if (auditWatermark)`，**全新空資料庫的水線是 0（falsy）**
     → 整段被跳過，「筆數回到開始前」一定失敗（搬家後第一天就是這個情境）。改成有拿到數字（含 0）就清。
   - `scripts/neon-jwt.js`：支援 `--aud`（沒帶對 audience 會 `missing required audience`）。

## 結論

寫在 `docs/研究-Neon搬家評估.md`：**可以搬，產品程式碼幾乎不用改**
（adapter 是 PostgREST 通用層，Neon Data API 官方就是 PostgREST 相容），
工作量在一次性授權設定。冷啟動實測閒置 7 分鐘後第一個請求 1.29 秒（之後 0.14 秒），
約 +1 秒，與目前 Vercel 函式的冷啟動同量級。

**風險**：Neon Data API 目前是 Open Beta；驗證是在空庫上做的。

## 版本同步

這一版**不變更** `package.json`／網站版本號（仍是 `0.7.0`），因為使用者介面與 API 行為完全沒動；
tag `v0.8.0` 只作為「這個階段完成」的紀錄點。
