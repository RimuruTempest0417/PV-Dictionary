-- v0.11.0（D-11）：每個單元「有老師錄音的生字數」
--
-- 為什麼需要這個函式：
--   D-11 把單元頁改成「只抓一頁生字」，不能再靠「把整個單元的音檔載進記憶體再數」；
--   但單元頁要顯示 N 段錄音／上限（D-3），上傳錄音時也要檢查這個上限 → 改成在資料庫數。
--
-- 判準與 lib/store/*.js 的 findTeacherAudio() 一致：dict_audio.source = 'teacher'，
-- 而且數的是「有老師錄音的生字數」（每單元 60 段的上限是數這個，不是錄音檔總數）。
--
-- 套用方式：Neon → SQL Editor 貼上執行（v0.11.0 已由助手用 Neon MCP 執行並讀回驗證）。
-- 回滾：drop function if exists public.dict_unit_audio_counts(bigint[]);
--
-- 註：Supabase 那份 migrations/ 不再維護（v0.10.0 起線上資料庫是 Neon；Supabase 只當回滾備案）。

create or replace function public.dict_unit_audio_counts(unit_ids bigint[])
returns table (unit_id bigint, n integer)
language sql
stable
as $$
    select e.unit_id, count(distinct a.entry_id)::int as n
    from public.dict_entries e
    join public.dict_audio a on a.entry_id = e.id and a.source = 'teacher'
    where unit_ids is null or e.unit_id = any(unit_ids)
    group by e.unit_id;
$$;

revoke all on function public.dict_unit_audio_counts(bigint[]) from public;
grant execute on function public.dict_unit_audio_counts(bigint[]) to authenticated;

-- 讓 PostgREST 立刻看到新函式（不然要等它自己重載快取）
notify pgrst, 'reload schema';
