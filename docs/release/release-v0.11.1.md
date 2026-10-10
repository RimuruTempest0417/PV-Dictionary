# v0.11.1 — 修好 v0.11.0 的分頁改動造成的 500（正式站）

> 這是 v0.11.0 的**熱修**。功能面（D-11／D-8／D-10）看 `docs/release/release-v0.11.0.md`。

## 症狀（線上實際發生）

`GET /api/units/:id` **一律 500**（`{"error":"Something went wrong on the server","code":"SERVER"}`），
錯誤日誌是 `STORE_WINDOW_MISSING`：

```
Supabase 資料層：這次請求沒有載入「生字 1 的音檔」的資料（視窗化資料層的安全機制）…
  at requireAudioOf (lib/store/supabase.js)
  at findTeacherAudio (lib/store/supabase.js)
```

## 根因

D-11 把單元頁改成「只抓一頁生字」（`store.listEntriesPage()`）。該函式會把這一頁的生字
標記成「音檔已載入」，讓 `publicEntry()` → `findTeacherAudio()` 可以安全查詢 ——
但我只標記了**真的有老師錄音的那些生字**（標記寫在「讀回音檔列」的迴圈裡）。
於是**沒有錄音的生字**從沒被標記 → `findTeacherAudio()` 依「大聲失敗，不靜默回空」的設計
直接拋 `STORE_WINDOW_MISSING` → 整條路由 500。

正式站只有 1 個生字、而它**沒有**錄音 → 也就是「每開一次單元頁就 500」。

## 修法

`lib/store/supabase.js` 的 `listEntriesPage()`：把標記移到「這一頁的每一筆生字」迴圈裡
（不管有沒有音檔都標記），與原本 `prefetch()` 的做法一致。

## 為什麼本機測試沒抓到（以及補了什麼）

- 單元測試用的是假 PostgREST，`publicEntry()` 在路由層 —— store 的測試沒走到那裡。
- 本機 Demo 是 JSON 模式（全部在記憶體），沒有「視窗」概念，不可能重現。
- **補的回歸測試**（`tests/supabase.test.js`，D-11 那個測試裡）：
  抓一頁之後，對「沒有錄音的生字」呼叫 `findTeacherAudio()` 必須回 `null`（不是拋錯），
  對「有錄音的生字」必須查得到。這正是線上壞掉的那一行。

## 這次的教訓（已寫進技能）

1. **視窗化資料層的「已載入」標記要涵蓋整個範圍，不能只涵蓋有子資料的那些** ——
   它的安全機制（拋錯）對「沒有子資料」是正常情況，不是缺漏。
2. **單元測試綠不等於線上綠**：凡是動到資料層視窗／路由互動的改動，
   一定要跑 `live-verify`（它會真的寫入、讀回、再清掉），本機 JSON 模式測不到這一類。
3. 線上驗收入口就是為了這個：`node scripts/live-verify.js --ephemeral-teacher` 一跑就現形。

## 驗證（2026-10-10）

| 項目 | 結果 |
|---|---|
| 語法／單元測試 | 84/84、`npm test` **186/0**（含新增回歸測試） |
| 線上 schema | 通過（8 張表＋3 個函式） |
| 線上端到端 `live-verify` | **25 通過 / 0 失敗 / 1 略過**（修前 16/4/1） |
| 正式站訪客視角 | **23/0** |
| 監控 `npm run monitor` | 6/6 通過 |
| 正式庫筆數 | 回到 **1 書／1 單元／1 生字**（順手清掉先前驗收失敗留下的殘留測試資料） |
