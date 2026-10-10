# v0.9.0 — 備份與還原（A-2）

> 目標：**資料庫要有一份放在我們自己手上的備份**，不依賴 Supabase 免費方案；
> 而且**真的能還原**（不是只把檔案倒出來）。

## 新增

- `npm run backup`（`scripts/backup.js`）
  - 把 8 張表匯出成 `books.jsonl`／`units.jsonl`／…（一行一筆、含 id）、
    加上 `manifest.json`（每張表筆數、每個檔案的 **sha256**、來源網域、應用版本、資料庫大小）、
    `schema/*.sql`（重建用的 DDL）與 `README.md`。
  - 推到**私有** repo `RimuruTempest0417/gary-dictionary-backup` 的 `backups/YYYY-MM-DD/`；
    **只保留最近 30 份**（`--keep=N` 可調）。
  - **只讀**（GET ＋ 兩個唯讀 RPC），不會刪改正式站任何資料。
  - 全程在系統暫存資料夾完成，**跑完一定刪除**，你的電腦（包含 `~/Downloads`）不留檔案。
- `npm run restore`（`scripts/restore.js`）
  - 沒有 `--confirm` 就只做檢查（驗 sha256、列筆數），不會寫任何資料。
  - 還原前先核對 manifest 的 sha256，對不上就中止。
  - 預設先照外鍵反序清空目標、再照正序寫回；還原後自動核對每張表的筆數。
  - 目標由 `.env` 的 `SUPABASE_URL` 決定 → **同一支工具也能還原到 Neon**（配合 `scripts/neon-jwt.js` 簽的 token）。
- `lib/backup.js`（核心邏輯）＋ `tests/backup.test.js`（8 個單元測試：分頁、sha256 抓壞檔、保留策略、還原順序與分批、讀不到 `dict_db_size()` 時誠實留 null）。
- `docs/備份與還原.md`：怎麼跑、還原步驟、安全性（**這個 repo 必須私有**：內含密碼雜湊與 2FA 密鑰）。

## 驗證（2026-10-10，實測）

| 項目 | 結果 |
|---|---|
| 首次備份 | 93 筆、11 個檔案、commit `70bc597d` 推上私有 repo（`books.jsonl` 1.2 MB 含封面） |
| 檢查模式 | sha256 全部相符；沒有 `--confirm` 時**完全不寫入** |
| **還原演練** | 把這份備份還原到 **Neon 空庫**：8 張表筆數**全部吻合**（books 1／units 1／entries 1／users 2／audit_logs 54／error_logs 34） |
| 還原後的 App | 本機 server 指向 Neon：書架正確顯示 `S2`（1 單元／1 生字）、`/api/health` 顯示 9.79 MB；`live-verify` **25 通過 / 0 失敗 / 1 略過** |
| 收尾 | 演練後 Neon 清回 0 筆；暫存檔案刪除；`~/Downloads` 沒有新檔 |

> 這也順手證明了 v0.10.0（正式搬家）的資料搬遷路徑可行：同一份備份格式在 Supabase 與 Neon 兩邊通用。

## 沒有做（留待決定）

- **自動排程**：目前是手動 `npm run backup`（可改 Hermes 排程或 macOS `launchd`）。
- 每個月自動清理舊備份以外的細部策略（目前就是保留最近 30 份）。

## 版本同步

`package.json`／`index.html`（title、`#versionLabel`、所有資產 `?v=`）／README 都更新為 **0.9.0**。
