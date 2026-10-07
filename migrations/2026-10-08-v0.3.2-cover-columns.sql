-- PV_Dictionary v0.3.2 — 補上「書本封面」的欄位
--
-- 為什麼需要這支：封面是 v0.2.0 加的功能，資料層靠 JSON 檔時不在乎欄位，
-- 所以本機測試全綠；一上線 Supabase，PATCH dict_books 帶著不存在的 cover_* 欄位
-- 就會被 PostgREST 拒絕 → 前端看到「上傳封面失敗（500）」。
--
-- 執行方式：Supabase → SQL Editor 貼上執行（idempotent，可重複跑）。
-- 這支只加欄位，不動既有資料。

alter table public.dict_books add column if not exists cover_mime       text;                                  -- image/jpeg | image/png | image/webp
alter table public.dict_books add column if not exists cover_data       text;                                  -- base64（單張上限 2MB）
alter table public.dict_books add column if not exists cover_bytes      int not null default 0;
alter table public.dict_books add column if not exists cover_updated_at timestamptz;
alter table public.dict_books add column if not exists cover_by         text;                                  -- 上傳者 username

-- 回滾（出事時貼上執行；會一併清掉已上傳的封面）
-- alter table public.dict_books drop column if exists cover_by, drop column if exists cover_updated_at,
--     drop column if exists cover_bytes, drop column if exists cover_data, drop column if exists cover_mime;
