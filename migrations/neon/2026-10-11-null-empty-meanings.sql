-- v0.13.0（F-5）：「只看沒有中文解釋的字」要能直接靠資料庫過濾。
--
-- 為什麼要動資料：PostgREST 不接受 or=(zh_meaning.is.null,zh_meaning.eq.) 這種寫法
-- （or= 裡面出現空字串條件的值會直接 400，已實測），所以統一用 NULL 代表「沒有中文解釋」。
-- 這樣過濾只需要 zh_meaning=is.null 一個條件，還能跟搜尋的 or= 用 AND 疊起來。
--
-- 程式端（server.js 的 applyEntryInput）已改成把空的 zh_meaning 存成 NULL；這裡把既有的空字串補成 NULL。
-- 讀取端不受影響：API 一律回 ''（publicEntry 有 `|| ''`），前端拿到的東西完全一樣。

update public.dict_entries set zh_meaning = null where zh_meaning = '';
