# 部署到 Vercel（線上版）

線上版跟本機 Demo 的差別只有一個：資料放在 **Supabase**（本機是 `data/store.json`）。
程式碼本身不用改 —— `DATA_BACKEND=supabase` 就會換過去。

- Vercel 專案：`pv-dictionary`（team `mylearning`）
- Production 網址：https://pv-dictionary-mylearning.vercel.app
- 已連結 GitHub：`RimuruTempest0417/PV-Dictionary`（**push 到 `main` 就會自動部署**）
- 資料庫：Supabase 專案 `pv-dictionary`（ref `hckozqluooeobvyltcyf`，region ap-southeast-1）

## 一、Vercel 上的環境變數（Settings → Environment Variables）

| 名稱 | 值 | 狀態 |
|---|---|---|
| `DATA_BACKEND` | `supabase` | 已設好 |
| `SUPABASE_URL` | `https://hckozqluooeobvyltcyf.supabase.co` | 已設好 |
| `SITE_URL` | `https://pv-dictionary-mylearning.vercel.app` | 已設好（production） |
| `JWT_SECRET` | `.env` 的 `JWT_SECRET` | ✅ 已推上去（用 `node scripts/vercel-env.js --push --deploy`） |
| `SUPABASE_SERVICE_ROLE_KEY` | `.env` 的 `SUPABASE_SERVICE_ROLE_KEY` | ✅ 已推上去 |

> 這兩個機密值是寫成 Vercel 的 `sensitive` 類型（介面上看不到、也讀不回來，只能覆寫）。
> 要換值就改 `.env` 再跑一次 `node scripts/vercel-env.js --push --deploy`：
> 值只在「.env → Vercel API」之間流動，不會出現在對話或任何文件裡。
> 程式有守門：看到 `REPLACE_ME` 開頭的值會**當場拒絕啟動**（回 500），不會用猜得到的密鑰跑起來。

**這兩個值是機密**：不要貼在對話、訊息或任何文件裡。用腳本推（值不會經過對話）：

```bash
node scripts/vercel-env.js --push --deploy   # 從 .env 推到 Vercel，順便重新部署並驗證
node scripts/vercel-env.js --check           # 只看看哪些變數設好了（不印值）
```

## 二、部署

Git 連結建立後，`main` 每次 push 都會自動部署（production）。
手動重部署：Vercel → pv-dictionary → Deployments → 最新那筆 → ⋯ → Redeploy（記得勾選使用最新的環境變數）。

## 三、上線後要驗的三件事

```bash
# 1. 後端活著、資料層是 supabase（不是 json）
curl -s https://pv-dictionary-mylearning.vercel.app/api/health

# 2. 書本清單讀得到（空的也要回 {"books":[]}，不是 500）
curl -s https://pv-dictionary-mylearning.vercel.app/api/books

# 3. 登入頁打得開（回 200 HTML）
curl -s -o /dev/null -w "%{http_code}\n" https://pv-dictionary-mylearning.vercel.app/
```

`/api/health` 的 `backend` 要是 `supabase`、`data_file` 要是 `null`、`jwt_secret_configured` 要是 `true`。

## 四、Supabase 那側的注意事項

- 7 張表 `dict_*` 的 schema 在 `migrations/2026-10-08-v0.0.1-init.sql`（已套用到線上專案）。
- **RLS 全開、沒有任何 policy**，並撤銷了 `anon` / `authenticated` 的權限：
  只有 `service_role`（後端）進得去，瀏覽器拿不到資料庫金鑰（前端只跟自家 API 講話）。
- 老師錄音與書本封面以 base64 存在資料庫（錄音 1MB、封面 2MB 上限），
  由自家端點 `GET /api/audio/:id`、`GET /api/covers/:id` 提供，不需要外部儲存。
- 資料層是「每個請求先抓下來、回應前寫回去」（見 `lib/store/supabase.js` 開頭說明）：
  讀取一定是最新的，但**同一瞬間的兩個寫入請求可能互相覆蓋** —— 學校規模的老師編輯可以接受；
  要更嚴格就得改成資料庫交易。

## 五、本機也要連線上資料庫時（可選）

```bash
# .env
DATA_BACKEND=supabase
SUPABASE_URL=https://hckozqluooeobvyltcyf.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...      # 填好後
node server.js                     # 本機跑的就是線上資料庫（小心操作）
node scripts/supabase-smoke.js --write   # 寫入 → 讀回 → 清理 的烟霧測試
```
