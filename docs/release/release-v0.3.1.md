## PV_Dictionary v0.3.1 — 正式上線，並修好上線後才看得見的三個問題

這版把 v0.3.0 的線上版**真的連起來了**，並且修掉三個「只有上了線才會踩到」的問題。

### 1. 線上版上線成功

- 專案：https://pv-dictionary-mylearning.vercel.app （Vercel `pv-dictionary`，連結 GitHub `main`，push 就自動部署）
- 資料：Supabase `hckozqluooeobvyltcyf`（7 張 `dict_*` 表，RLS 全開、只有後端拿 service_role 進得去）
- 部署保護改成「只保護預覽」：原本連正式網址都被 Vercel 驗證擋住（學生會進不去）。

### 2. 修好：線上資料庫一個帳號都沒有

`npm run seed` 原本**只寫本機 JSON 檔**（`data/store.json`），所以線上 Supabase 是空的、沒人能登入。
現在 `seed` 會跟著 `DATA_BACKEND` 走：

```bash
DATA_BACKEND=supabase npm run seed -- --prune-accounts   # 在正式資料庫建立 Gary（網站管理員）
```

（`--reset` 在 supabase 模式會被拒絕：清空線上資料庫太危險，要清請在 Supabase 介面自己來。）

### 3. 修好：別的實例剛寫進去的東西看不到

`hydrate()` 原本是「每個實例只抓一次資料庫」，在 serverless 上等於**很多個快取副本**：
老師在 A 實例加了生字，學生的請求落到 B 實例就可能看不到。上線驗收時真的踩到了
（我直接刪掉測試資料後，還有一個實例堅持回報那本書存在）。

現在預設**每個請求都重新抓一次**（7 個並行查詢，學校規模完全無感）；
要省查詢量可以設 `SUPABASE_HYDRATE_TTL_MS=2000`。另外加了一個保護：
**還有沒寫回的異動時不重抓**，否則重抓會把 pending 的寫入憑空丟掉。

### 4. `/api/health` 變成真的能診斷

原本 `schema_ready` 寫死 `true`（等於沒在檢查），現在回一段 `db` 診斷：

```json
"db": { "host": "hckozqluooeobvyltcyf", "key_role": "service_role",
        "key_ref": "hckozqluooeobvyltcyf", "key_format": "jwt",
        "hydrate_ok": true, "last_error": null }
```

只放金鑰的 `role`／`ref` 宣告（不含金鑰本身），所以看得出來是「連錯專案」「金鑰種類不對」
還是「資料庫真的空的」——這正是這次上線時卡住的三種可能。

### 5. 新增 `scripts/live-verify.js`：線上端到端驗收

不只打 health，而是真的走一遍：首頁／CSP／analytics → Gary 登入 → 讀帳號清單 →
**建一本書（下一請求看得到＝真的寫進 Supabase）→ 用 REST 確認 → 清掉 → 確認回到空的**。
全程不印密碼、不留下測試資料。

```bash
node scripts/live-verify.js            # 21 項：全部通過
```

### 6. Vercel Web Analytics 的行內 script 改成同源檔案

Vercel 整合塞的是行內 `<script>`，會違反本專案的嚴格 CSP（`script-src 'self'`）→ 被瀏覽器擋掉。
改成 `public/js/analytics.js`（同源），功能一樣、CSP 不放寬。

### 測試（實跑）

| 項目 | 指令 | 結果 |
|---|---|---|
| 語法＋模組載入 | `npm run check:syntax` | 38/38 通過 |
| 單元／API／i18n／資料層 | `npm test` | **58 通過 / 0 失敗**（新增 2 項：每次請求重抓、有 pending 異動時不重抓） |
| 真 Chrome 驗收 | `npm run check:browser` | **163 通過 / 0 失敗** |
| 線上端到端 | `node scripts/live-verify.js` | **21 通過 / 0 失敗** |
