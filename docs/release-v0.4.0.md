## PV_Dictionary v0.4.0 — 安全與工程守門（第一輪）

這一版是「零功能變動、全部是安全與守門」的一版：處理規劃書裡 A-6／A-7／A-9／A-11／A-12／E-1／E-2 七項。
選它當第一版的原因：全部都不需要新的資料表、不動資料，改壞了也最容易發現（回應標頭與測試都在本機就能驗）。

### A-6 靜態檔的跨域標頭：不再讓 CDN 的 `*` 生效

實測線上 `/js/app.js` 會回 `Access-Control-Allow-Origin: *`（Vercel 對靜態檔的預設值），
那等於任何網站都能用 `fetch` 讀我們的 JS；自家 API 一直是乾淨的（實測 0），只有 CDN 這條漏。

`vercel.json` 新增 `headers` 規則：`/js/*`、`/css/*`、`/img/*`、`/favicon.ico`、`/manifest.json`、`/robots.txt`
明確指定 `Access-Control-Allow-Origin: https://pv-dictionary-mylearning.vercel.app` 與
`Cross-Origin-Resource-Policy: same-origin`；靜態資產同時給 `Cache-Control: public, max-age=604800`
（網址本來就帶 `?v=<版本>`，長快取是安全的，改版一定換網址）。

### A-7 CSP 收緊 ＋ Permissions-Policy

`lib/auth.js` 的 `SECURITY_HEADERS` 改由 `buildSecurityHeaders(isProduction)` 產生：

- 新增 `object-src 'none'`（不能載入外掛／舊式嵌入物件）、`frame-src 'none'`（不能內嵌別的頁面）、
  `worker-src 'self'`；原有的 `frame-ancestors`／`form-action`／`base-uri` 保留。
- 新增 `Permissions-Policy: camera=(self), microphone=(self), geolocation=(), payment=(), usb=()`：
  老師錄音用的麥克風、以及只給自家；其餘全部關閉。
- 新增 `Cross-Origin-Opener-Policy: same-origin`、`X-Permitted-Cross-Domain-Policies: none`。
- `upgrade-insecure-requests` **只在 production 加**（`NODE_ENV=production`）。
  本機是 `http://127.0.0.1`，加了會讓瀏覽器把子資源全升級成 https → 本機整站掛掉，
  而且症狀看起來像別的問題；測試有一條專門守這個差異。

### A-11 公開讀取端點的快取標頭（含安全判斷）

`GET /api/books`、`GET /api/units/:id` 依身分回不同的快取標頭：

- **未登入** → `Cache-Control: public, max-age=15, stale-while-revalidate=60`（省函式與資料庫的往返）。
- **已登入** → `Cache-Control: private, no-store`。

★ 這是重點：登入者看得到未發佈的草稿與待審核生字，那份回應**絕對不能**進 CDN 或瀏覽器快取，
否則別人有機會拿到還沒公開的內容。測試同時驗兩邊（含「登入者讀草稿單元」的情境）。

### A-9 金鑰輪替文件

新增 `docs/金鑰輪替.md`：`JWT_SECRET`／`SUPABASE_SERVICE_ROLE_KEY`／`VERCEL_TOKEN` 各放在哪、
外流的後果、輪替步驟（產新值 → 改 `.env` → `scripts/vercel-env.js --push --deploy` → **讀回 `/api/health` 確認**）、
輪替後必查的三件事、以及一張紀錄表（誰、何時、為什麼）。

### A-12 依賴套件弱點掃描

新增 `npm run check:deps`（`scripts/check-deps.js`）：`npm audit --omit=dev --audit-level=high`，
失敗時直接印出處理原則。**刻意不塞進 `npm run check`**：`npm audit` 需要連外，
離線也要能跑完的檢查不該被它弄壞（schema 檢查踩過同一個坑）。

### E-1 路由清單快照 ＋ 路由覆蓋守門

- `scripts/route-inventory.js`（`npm run routes`）列出目前 34 條路由與註冊順序；
  `npm run routes:snapshot` 更新 `tests/fixtures/route-inventory.json`。
- `tests/route-inventory.test.js`：路由清單、順序、層數與快照一致（**重構時必須不變**）＋ 沒有重複註冊。
- `tests/route-coverage.test.js`：**每一條路由都要被至少一支測試打過**。
  這支一寫出來就抓到三條從來沒被測過的路由 —— `POST /api/auth/logout`、
  `POST /api/units/:id/publish`、`POST /api/units/:id/unpublish` —— 已經補上真實測試
  （含「科代表不能發佈」「下架後訪客看不到」「登出清 cookie」）。

### E-2 版本一致性守門

新 `tests/version-consistency.test.js`：`package.json` = `index.html` 的 `<title>` = `#versionLabel`
= 所有資產的 `?v=` = `/api/version` 回的版本，且 README 有提到目前版本。
（之前手動改版踩過「改了一處忘了另一處」。）

### 測試（實跑）

| 項目 | 指令 | 結果 |
|---|---|---|
| 語法 | `npm run check:syntax` | 41/41 通過 |
| 單元／API／守門 | `npm test` | **83 通過 / 0 失敗**（+12：路由快照、路由覆蓋、版本一致、CSP／Permissions-Policy、快取標頭、登出、發佈／下架） |
| 依賴弱點 | `npm run check:deps` | 0 vulnerabilities |
| 真 Chrome | `npm run check:browser` | 見 README 的最新數字（本版 CSP 收緊後必須全綠） |
