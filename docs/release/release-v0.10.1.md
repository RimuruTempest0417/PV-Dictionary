# v0.10.1 — 修好搬家後才浮現的 bug、清掉多餘的東西

> 這一版沒有新功能。內容是：① **修正式站真的壞掉的後台功能** ② 安全性小補強
> ③ 依照使用者的要求「整份專案仔細檢查、處理多餘的東西與漏洞」所做的清理
> ④ 文件與現況（Neon）對齊。

## 修好的正式站 bug（重要）

**症狀**：管理區的「📊 概況（使用統計）」、「🧾 稽核紀錄」的**匯出 CSV** 與**保留期清理**，
在 PostgREST 模式（也就是搬家後的 Neon，以及更早的 Supabase）**一律 500**。

**根因**：稽核紀錄是「視窗化」載入的（v0.6.1 的 D-1b 設計）——prefetch 用「路由的篩選條件字串」
當指紋，處理器若用不同的 `limit`／日期範圍呼叫就寧可拋錯（`STORE_WINDOW_MISSING`）也不要回錯資料。
但這三條路由各自用 50／200／5000／100000 不同的 limit，**指紋永遠對不上**。

**修法**：後台稽核相關路由（列表／匯出／清理／統計）改成「整批載入」（上限 5,000 筆，
由保留期清理政策讓筆數有界），不再做指紋比對；`total` 在整批模式用記憶體篩選後的筆數。
新增回歸測試（`tests/supabase.test.js`），並**對正式資料庫實測**：
統計 200、稽核列表 200、匯出 CSV 200（56 行）、清理預覽 200（`would_delete=0／total=55`）。

## 安全性（皆已實測）

- **批次貼上匯入沒有列數上限**（`server.js` 的 `parseImportText`）：CSV／.xlsx 那條路有 500 列上限，
  貼上文字卻沒有 → 認證使用者可以貼近 4MB 的文字產生數十萬列寫入（PostgREST 模式每列一次 INSERT）
  ＝寫入放大／阻斷服務。現在兩條路共用 `IMPORT_MAX_ROWS = 500`，超過會回一筆「一次最多 500 列」的說明。
- **`/api/health` 對外洩漏後端診斷資訊**：以前連未登入的人都能看到金鑰角色（`key_role`）、
  專案 ref、主機代號與最後一次資料庫錯誤訊息。現在對外只回 `{ hydrate_ok }`（監控需要的訊號），
  完整診斷只給 admin／web_manager（實測：未登入 `db={"hydrate_ok":true}`，無洩漏欄位）。
- **開發用 JWT 密鑰的保護多一層**：以前只在 `NODE_ENV=production` 時拒絕預設密鑰，
  現在連 `VERCEL`／`VERCEL_ENV` 也算部署環境（免得平台沒設 NODE_ENV 就退回公開的開發密鑰）。
- **`scripts/neon-jwt.js` 預設不再把 JWT 印出來**（等同資料庫憑證）：要用請明確加 `--print`，
  腳本照舊用 `--quiet` 取值（值不經過任何輸出）。`uptime` 仍會檢查有效期並在剩 30 天時叫。

## 清理（多餘的東西與死碼）

- **死掉的 CSS 規則 10 個類別**（`public/css/app.css`）：`.shelf-cover`／`.shelf-cover-img`／
  `.shelf-cover-fallback`／`.shelf-name`／`.cover-preview`／`.segmented`（含子選擇器）／
  `.picker-row`／`.picker-label`／`.chip-count`／`.admin-toolbar` —— 都是 v0.5.0 移除封面／舊選單後留下的，
  用獨立掃描（skills 的 dead-code-scan）＋全 repo 交叉比對確認**零引用**才刪。
- **用不到的匯出 8 個**：`TABLE_NAMES`（store/index）、`EMPTY`（json）、`TABLES`／`INSERT_ORDER`／`DELETE_ORDER`（supabase）、
  `DEFAULT_PAGE_SIZE`／`removalOrder`／`fetchDbSize`（backup）、`HEADER`／`MAX_SKEW_MS`／`signature`（selftest）——
  各自只在自己檔案內用到，外部引用 0（逐一 grep 驗過），改回內部常數／函式。
- **刪掉 `scripts/vercel-rename.js`**：Vercel 專案改名早已完成、後台即可操作，是沒有人引用的一次性工具。
- **`.env.bak-*` 只保留最近 3 份**（切換後端時會產生；含機密，不該一直堆）。
- **`npm run usage` 的後端標籤**不再硬寫 `supabase`：依主機判斷是 **Neon（PostgreSQL）** 還是 Supabase。
- **`scripts/schema-check.js` 與新測試同時守 `migrations/neon/`**：以前 schema 守門只看 `migrations/`，
  搬家後真正在跑的 Neon 版漂移不會被發現（新增 `tests/schema-neon.test.js`）。

## 新增工具

- **`scripts/load-test.js`（`npm run load:test`）**：容量與併發驗證。灌 N 筆生字 → 量單次讀取延遲／
  回應大小／併發 p50–p99 → **跑完自動清乾淨**（並有 `--cleanup-only` 與訊號處理，避免被中斷時留下測試資料）。
- **`scripts/switch-backend.js --rotate-jwt`**：重新簽 JWT 並寫回 `.env`（先自動備份）。
- 為手動執行的工具補上 npm script：`verify:live`／`smoke:supabase`／`backend`／`neon:keys`／`push:api`／`redeploy`。

## 文件

- **`docs/規劃書-待完成.md` 改寫**：只留還沒做的事（使用者指定「舊東西不用保留」）。
- **新增 `docs/研究-Oracle自架評估.md`**：查證後結論是「現在不要做」（官方 2026-06 把免費額度從 4 OCPU／24 GB
  砍成 2 OCPU／12 GB 且沒有公告、閒置 7 天可能被回收、維運全包），重啟條件寫在文件裡。
- **`docs/搬家到Neon.md` 新增「五、金鑰輪替」**：換 token（已實測、零停機）與換簽章金鑰
  （演練中發現 **Neon 會快取 JWKS**，所以必須到 Console 重加一次 provider）分開寫清楚。
- README／deploy 文件／金鑰輪替／備份與還原／監控文件的過時敘述（Supabase、封面、舊品牌、舊測試數字）對齊現況。

## 驗證（2026-10-10）

| 項目 | 結果 |
|---|---|
| 語法／單元測試 | 82/82、`npm test` **183 / 0** |
| schema（含 Neon 版守門） | 通過 |
| 本機真瀏覽器 | 見 release 內文（demo／empty／lang／users） |
| 後台功能實測（Neon 真實資料庫） | 統計／列表／匯出／清理 全部 **200**（修前是 500） |
| `/api/health` 資訊收斂 | 未登入只回 `hydrate_ok`，無 `key_role`／`host` 等欄位 |
| 金鑰輪替演練 | 換 token 零停機；過期 token → 400；未註冊金鑰 → 400 `jwk not found` |
| 容量與併發 | 見下方實測 |
| 增量寫入 | **10,000 筆／2.0 秒（4,927 筆/秒）** |
| 單元第一頁讀取（1 個生字 vs 10,000 個） | 105 ms → **2,575 ms** |
| 同一單元搜尋 | 100 ms → **2,705 ms** |
| 24 條併發（10,000 筆的單元） | 1,096 個請求中 **1,077 個回 503**（只有 19 個成功） |
| 30 條併發（**輕查詢**） | **100% 成功、零 503**：Neon 直連 p50 66 ms／正式站 p50 93–260 ms |
| 刪除測試資料 | Neon 回 `53200 out of memory`（0.25 CU 被前面的慢查詢吃光；稍後用 SQL 清理成功） |

★ **結論**：併發本身不是問題（輕查詢 30 條全過）；**問題是「每個單元請求都把整個單元的生字搬進記憶體」**——
資料量大時每個請求要 2.5 秒、又把免費方案的 0.25 CU 打爆。修法是把分頁與搜尋下推到資料庫，
已列為規劃書 **D-11（P1）**。現在的資料量（1 單元／1 生字）不受影響。

## 沒有做（留給下一版決定）

- **權限模型的小矛盾**（被授權的學生後端編得動、前端卻說不行）已寫進規劃書的 D-10，需要決定教學流程後再改。
- 監控自動化（D-8）與其他待辦見 `docs/規劃書-待完成.md`。
