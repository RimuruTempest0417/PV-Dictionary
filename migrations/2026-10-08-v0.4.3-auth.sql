-- v0.4.3：帳號安全與工作階段（A-1／A-8／A-10／C-3）
--
-- token_version：讓「這張權杖還算不算數」可以主動失效（A-10）。
--   一般登出只清掉自己的 cookie（使用者指定：只登出自己那一台）；
--   改密碼、被停用、或 web_manager 按「登出所有裝置」時 +1 → 所有舊權杖立即失效。
--
-- totp_secret / backup_codes：兩步驟驗證（A-1，可選，不強制）。
--   secret 以 JWT_SECRET 衍生的金鑰加密後才存（見 lib/totp.js）；備援碼只存雜湊。
--
-- last_login_ip / last_login_agent：登入時比對，來源不同就留一筆 LOGIN_NEW_DEVICE（A-8）。

alter table public.dict_users add column if not exists token_version integer not null default 1;
alter table public.dict_users add column if not exists totp_secret text not null default '';
alter table public.dict_users add column if not exists totp_enabled_at timestamptz;
alter table public.dict_users add column if not exists backup_codes jsonb;
alter table public.dict_users add column if not exists last_login_ip text not null default '';
alter table public.dict_users add column if not exists last_login_agent text not null default '';

-- ---------- 回滾（出事時貼上執行） ----------
-- alter table public.dict_users drop column if exists token_version;
-- alter table public.dict_users drop column if exists totp_secret;
-- alter table public.dict_users drop column if exists totp_enabled_at;
-- alter table public.dict_users drop column if exists backup_codes;
-- alter table public.dict_users drop column if exists last_login_ip;
-- alter table public.dict_users drop column if exists last_login_agent;
