# 搬到 Neon（v0.10.0）：做法、驗證、回滾

> 2026-10-10 完成。前置：v0.8.0（影子驗證，`docs/研究-Neon搬家評估.md`）、v0.9.0（備份與還原，`docs/備份與還原.md`）。
> **程式碼沒有改一行** —— 同一個 PostgREST 相容 adapter，只是把端點與金鑰換成 Neon 的。

## 一、搬家做了什麼（照順序）

1. **資料**：`npm run backup` 做一份最新備份 → 用 `scripts/restore.js` 還原進 Neon（Vercel 整合建的分支之外，
   我們用的是 Neon 專案的 `production` 分支）。8 張表筆數全部吻合才繼續。
   產出：**books 1／units 1／entries 1／users 2／audit_logs 54／error_logs 34（共 93 筆）**。
2. **程式**：`.env` 的 `SUPABASE_URL`／`SUPABASE_SERVICE_ROLE_KEY` 換成 Neon 的 Data API 端點與**自簽 JWT**，
   用 `node scripts/switch-backend.js --to=neon` 完成（會自動備份切換前的 `.env` 為 `.env.bak-<時間>`）。
3. **線上**：`node scripts/vercel-env.js --push-all --deploy` 把 `DATA_BACKEND=supabase`、`SUPABASE_URL`、
   `SUPABASE_SERVICE_ROLE_KEY`（＝JWT）推上 Vercel 並重新部署。
4. **一起改的設定**：`lib/limits.js` 的 `DB_QUOTA_MB` 500 → **1024**（Neon 的 branch storage 上限實測是 1 GB）。
5. **跟著改的程式**：`scripts/schema-check.js` 在沒有 OpenAPI 規格的後端（Neon）改用「探測法」
   （見 `lib/schema.js` 的 `probeLiveColumns`）；`/api/health` 多回 `backend_kind`，
   頁尾標籤才會顯示「Neon（PostgreSQL）」而不是舊的 Supabase。

## 二、Neon 端的設定（重建專案時照做）

- 套 schema：`migrations/neon/2026-10-10-neon-schema.sql`
  （與 Supabase 版的唯一差別：Neon 沒有 `anon`／`authenticated` 內建角色，
  `revoke ... from anon, authenticated` 要改成 `revoke ... from public`）。
- 授權：`grant usage on schema public to authenticated`、表／序列 GRANT、default privileges，
  以及 8 張表各一條 `for all to authenticated using (true) with check (true)` 政策。
- Data API：Console 開啟 → 註冊 **JWKS URL**（我們自己網站提供：`https://gary-dictionary.vercel.app/keys/jwks.json`）
  → 設定 **JWT Audience = `gary-dictionary`**。
- 我們的伺服器是唯一客戶端，用 `scripts/neon-jwt.js` 自簽 JWT（`role=authenticated`、365 天）。
  **沒有 JWT 或不是 JWT 格式，Neon 一律回 400**（Supabase 那種 service_role 硬闖不適用）。

## 三、驗證（搬家當天實測）

| 項目 | 結果 |
|---|---|
| 搬完筆數 | 8 張表全部與備份一致（93 筆） |
| 本機（.env 指向 Neon） | 書架回 `S2`（1 單元／1 生字）；`/api/health` 容量 9.80 MB / 1024 MB |
| 正式站 | 四個網址都跟版；書架顯示真實內容；頁尾顯示 **Neon（PostgreSQL）** |
| 線上驗收 | `live-verify --ephemeral-teacher` 與 `check:live-browser` 全綠 |
| 延遲 | 暖機 0.14–0.22 秒；閒置 7 分鐘後第一個請求 1.29 秒（＝＋約 1 秒，與 Vercel 函式冷啟動同量級） |

## 四、怎麼回滾（Supabase 還在，資料沒有刪）

```bash
cd ~/Documents/hermes/GD-English-Dictionary
node scripts/switch-backend.js --status      # 看現在指向哪個後端（不顯示金鑰）
node scripts/switch-backend.js --to=supabase # 切回 Supabase（用 .env 存下的那一組）
node scripts/switch-backend.js --rollback    # 或直接還原最近一次切換前的 .env
node scripts/vercel-env.js --push-all --deploy   # 推上 Vercel 並重新部署
npm run uptime && node scripts/live-verify.js --ephemeral-teacher   # 確認回到舊後端也正常
```

**唯一的資料風險**：切換後若在 Neon 上新增／修改了資料，回滾到 Supabase 會看不到那些變更
（兩邊不會自動同步）。真要回滾，先 `npm run backup`（此時備份的是 Neon 的內容）再說。

## 五、金鑰輪替（2026-10-10 演練完成）

兩種「輪替」要分清楚，做法完全不同：

### A. 只換 token（同一個簽章金鑰）—— 已實測可行，零停機

```bash
node scripts/switch-backend.js --rotate-jwt      # 重新簽一張寫回 .env（會先備份 .env）
node scripts/vercel-env.js --push-all --deploy   # 推上 Vercel 並重新部署
npm run uptime                                    # 確認「資料庫金鑰效期」變成新的到期日
```

- 實測：輪替後正式站正常（`live-verify` 25/0/1、`uptime` 全綠）、**舊 token 到期前仍然有效**。
- ★ **換 token ≠ 撤銷舊 token**：同一個簽章金鑰簽出來的都有效到各自的 `exp`。
  演練證據：輪替後拿 .env.bak 裡的舊 token 打 Neon 仍回 **200**。
- 使用者感受：沒有停機、不用重新登入（網站用的是伺服器端的 token，跟使用者登入無關）。

### B. 換簽章金鑰（真撤銷）—— 需要 Neon Console 一步，程序如下

演練中發現的關鍵事實：**Neon 會快取 JWKS**。
把第二把公鑰加到 `public/keys/jwks.json` 並部署（線上確實有兩個 kid）之後，
用第二把金鑰簽的 token 打 Neon 仍然回 **400 `jwk not found`** —— 表示 Neon 不會因為 URL 內容變了就自動重抓。

因此程序是：

1. 產生新金鑰：`node scripts/neon-jwt.js --make-keys`
   （公鑰寫 `public/keys/jwks.json`、私鑰寫 `.env`；**舊私鑰要先備份**，否則舊 token 立刻簽不出來）。
2. **一次放兩把公鑰**（舊＋新）到 `public/keys/jwks.json`，commit ＋ push（部署，讓 Neon 抓得到）。
3. **到 Neon Console → Data API → Settings → 重新加一次 provider（同一條 JWKS URL）**，
   逼 Neon 重抓 —— 這一步不能省。
4. 驗證新金鑰可用（把新 token 放進環境變數、用下面這行打終點，回 200 才算成功）：
   ```bash
   T=$(node scripts/neon-jwt.js --quiet --aud="gary-dictionary")
   curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $T" \
     "$NEON_DATA_API_URL/rest/v1/dict_books?select=id"    # 200 = 通過
   ```
5. 換 `.env` 的私鑰與 token → `node scripts/vercel-env.js --push-all --deploy` → `npm run uptime`。
6. 確認沒問題後，把舊公鑰從 JWKS 移除 → 部署 → **再一次** 到 Console 重加 provider（此時舊 token 才真的失效）。

**沒做過的部分（要誠實說）**：第 3／6 步的 Console 重加 provider 我沒辦法代跑，
所以「換金鑰後 Neon 會立刻生效」還沒有實測過；上面第 4 步的驗證指令就是驗收標準。

### C. 到期提醒

`npm run uptime` 會解出 token 的 `exp`：**剩不到 30 天**這一項就算失敗（回非 0），
訊息裡直接寫「要重簽：`node scripts/neon-jwt.js` → 更新 `.env` → `vercel-env.js --push-all --deploy`」。
演練證據：拿一張只剩 20 天的 token 跑，得到「✖ 資料庫金鑰效期（Neon JWT）→ 還有 19 天到期」且**結束碼 1**；
非 JWT 的金鑰（例如舊的 Supabase service key）會跳過這一項，不會誤報。

## 六、要記得的事

- **JWT 一年到期**（`scripts/neon-jwt.js`）：`npm run uptime` 會在**剩不到 30 天**時回非 0 提醒；
  重簽 → 更新 `.env` → `node scripts/vercel-env.js --push-all --deploy`。
- **Neon Data API 目前是 Open Beta**：這是最大的外部風險。資料都有備份（v0.9.0），隨時可搬。
- 容量：實測 branch storage 上限 **1 GB**（配額常數已改成 1024 MB，門檻仍是 70%）。
- 併發與真實資料量還沒驗證過（現在是 1 本書、1 個單元、1 個生字）。
