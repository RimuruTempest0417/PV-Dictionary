## PV_Dictionary v0.0.3（Demo）— 介面預設英文 + 語言切換

使用者 2026-10-07 指定：**整個網頁以英文為使用語言，除非使用者自己切換成中文**。這一版做完 i18n，
順便把上一版實測回報的三件事全部收尾。**帳號管理介面與連上網（Supabase）是下一版**。

### 這一版有什麼

- **預設語言：英文**。右上角 `EN / 中文` 即時切換，選擇記在 `localStorage`，重新載入仍保留；
  `<html lang>` 也跟著切換（`en` / `zh-Hant`）。
- **兩種語言的來源各只有一份**：
  - 介面文字 → `public/js/i18n.js`（靜態 HTML 用 `data-i18n` 標記，動態字串用 `t('key')`）。
  - 後端錯誤 → `lib/messages.js` 的**英文訊息 + `code`**；前端用 `errors.<code>` 翻成中文。
    API 對外（curl／腳本）維持英文，前端不論哪種語言都會顯示對的語言。
- 角色名稱、稽核動作名稱都由前端依 `role.*` / `auditAction.*` 翻譯（不再直接顯示後端的中文標籤）。

### 守門（新增）

`tests/i18n.test.js`（8 項）擋住四種不會報錯、只會在某個語言下「少一句話」的問題：
兩種語言的鍵不一致、程式用了不存在的鍵、兩邊插值變數不一致、後端新的 error code 沒有翻譯。
`tests/guards.test.js` 另外新增「前端用到的元素 id 真的存在」——這一版就是靠它（與瀏覽器檢查）
抓到 `unitFormBook` 已被改名卻還在 JS 裡被引用的靜默錯誤。

### 測試（實跑）

| 項目 | 指令 | 結果 |
|---|---|---|
| 語法 + 模組載入 | `npm run check:syntax` | 29/29 通過 |
| 單元／API／i18n 測試 | `npm test` | **45 通過 / 0 失敗** |
| 真實瀏覽器驗收 | `npm run check:browser` | **94 通過 / 0 失敗** |

- `demo-check.js` 39 項：12 步 Demo 劇本（英文介面下重跑）。
- `empty-start-check.js` 30 項：資料全空時的學生視角、彈窗開關、管理員建立第一本書與單元。
- `lang-check.js` 25 項（新增）：預設英文 → 切中文（靜態＋動態＋角色＋錯誤訊息）→ 重新載入記得選擇
  → 切回英文 → 手機版不溢出 → 無 CSP 違規、無前端例外、不下載、不寫截圖。

### 怎麼跑

```bash
npm install
node server.js      # http://localhost:3000（資料檔已清空，內容由你自己加入）
grep SEED_ .env     # manager / webmanager / teacher / classrep 的密碼
```

### 仍然是 Demo 的限制

**JSON 資料層不能上 Vercel**（serverless 沒有持久磁碟），線上版要等下一版的 Supabase adapter
（schema 已在 `migrations/2026-10-08-v0.0.1-init.sql`）；帳號管理（使用者／授權）目前只有 API，介面也在下一版。
