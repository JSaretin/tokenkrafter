-- TokenKrafter Schema (fully idempotent — safe to run multiple times)
-- Run this in your Supabase SQL editor
--
-- Security model:
--   Anon key (frontend) = READ ONLY on a small allowlist of tables
--   Service-role key (backend) = bypasses RLS for writes
--   All writes go through server-side API with wallet signature verification
--
-- IMPORTANT: There must be **no** INSERT/UPDATE/DELETE policy on any table
-- in the public schema. Adding one (e.g. via Supabase Studio with the default
-- `to public` role) opens a write hole for anon. The cleanup block below
-- drops any such policy on every re-run as defense-in-depth.

-- ============================================================
-- Helper: create policy only if it doesn't exist
-- ============================================================
create or replace function create_policy_if_not_exists(
  _table text, _name text, _command text, _qual text default 'true', _check text default null
) returns void as $$
begin
  if not exists (
    select 1 from pg_policies where tablename = _table and policyname = _name
  ) then
    if _check is not null then
      execute format('create policy %I on %I for %s with check (%s)', _name, _table, _command, _check);
    else
      execute format('create policy %I on %I for %s using (%s)', _name, _table, _command, _qual);
    end if;
  end if;
end;
$$ language plpgsql;

-- ============================================================
-- Defense-in-depth: revert any drift introduced via Studio.
--   1. Drop any non-SELECT (write) policy — service_role bypasses RLS.
--   2. Drop any SELECT policy not named "Anon read". The migration
--      creates exactly one "Anon read" policy per readable table;
--      anything else (typically Studio's "Public read X" or scoped
--      duplicates) is drift. Re-run to flatten.
-- Note: legitimate row-scoped SELECT policies (e.g. "Owner can read
-- own X" with a real qual) would be dropped by this block — when we
-- add one we should give it a name that distinguishes it from drift
-- and add it to the migration so the rebuild stays idempotent.
-- ============================================================
do $$ declare r record; begin
  for r in
    select tablename, policyname, cmd
    from pg_policies
    where schemaname = 'public'
      and (
        cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
        or (cmd = 'SELECT' and policyname <> 'Anon read')
      )
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
    raise notice 'dropped drift policy: %.% (cmd=%)', r.tablename, r.policyname, r.cmd;
  end loop;
end $$;

-- ============================================================
-- Disable GraphQL surface (we don't use it).
-- pg_graphql auto-publishes anything anon can SELECT, so every
-- public table is otherwise discoverable via /graphql/v1. Revoke
-- USAGE on the graphql schemas to lock that down. Wrapped in DO
-- so it's idempotent across re-runs.
-- ============================================================
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'graphql_public') then
    revoke usage on schema graphql_public from anon, authenticated, public;
  end if;
  if exists (select 1 from pg_namespace where nspname = 'graphql') then
    revoke usage on schema graphql from anon, authenticated, public;
  end if;
end $$;

-- ============================================================
-- Drop rls_auto_enable: a SECURITY DEFINER event-trigger handler
-- Supabase Studio sometimes installs in public. PostgREST exposes
-- anything in public as /rest/v1/rpc/<name>, and SECURITY DEFINER
-- runs with the definer's (postgres) privileges — a privilege-
-- escalation shape if anyone modifies the body. We don't use it.
-- ============================================================
drop function if exists public.rls_auto_enable();

-- ============================================================
-- Table-grant lockdown.
-- Supabase default-grants ALL (SELECT/INSERT/UPDATE/DELETE/...) on every
-- public table to anon + authenticated. RLS denies most of it at runtime,
-- but linters (Supabase Advisor / GraphQL Advisor) still flag the grants
-- because they make tables visible to introspection (GraphQL schema, etc).
--
-- Strategy: revoke all from anon + authenticated on every public table,
-- then re-grant SELECT only on the read-allowlist. service_role retains
-- full access — it's how the backend (supabaseAdmin) writes everything.
--
-- The allowlist is the set of tables with an "Anon read" SELECT policy.
-- ============================================================
do $$ declare r record; begin
  for r in
    select c.relname as tbl
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('revoke all on public.%I from anon, authenticated', r.tbl);
  end loop;
end $$;

-- Re-grant SELECT only on tables that are intentionally public-readable.
-- (Matches the "Anon read" policies created later in this migration.)
do $$ declare r record; begin
  for r in
    select unnest(array[
      'launches', 'badges', 'launch_transactions', 'comments',
      'platform_stats', 'created_tokens', 'recent_transactions',
      'token_aliases', 'ng_banks', 'referral_aliases', 'platform_config'
    ]) as tbl
  loop
    if exists (select 1 from pg_class c
               join pg_namespace n on n.oid=c.relnamespace
               where n.nspname='public' and c.relname=r.tbl)
    then
      execute format('grant select on public.%I to anon, authenticated', r.tbl);
    end if;
  end loop;
end $$;

-- ============================================================
-- Launches table
-- ============================================================
create table if not exists launches (
  id bigint generated always as identity primary key,
  address text not null,
  chain_id integer not null,
  token_address text not null,
  creator text not null,
  curve_type smallint not null default 0,
  state smallint not null default 0,
  soft_cap text not null default '0',
  hard_cap text not null default '0',
  total_base_raised text not null default '0',
  tokens_sold text not null default '0',
  tokens_for_curve text not null default '0',
  tokens_for_lp text not null default '0',
  creator_allocation_bps integer not null default 0,
  current_price text not null default '0',
  deadline bigint not null default 0,
  start_timestamp bigint not null default 0,
  total_tokens_required text not null default '0',
  total_tokens_deposited text not null default '0',
  is_partner boolean not null default false,
  token_name text,
  token_symbol text,
  token_decimals integer default 18,
  usdt_decimals integer default 18,
  description text,
  logo_url text,
  website text,
  twitter text,
  telegram text,
  discord text,
  video_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (address, chain_id)
);

create index if not exists idx_launches_chain_id on launches (chain_id);
create index if not exists idx_launches_state on launches (state);
create index if not exists idx_launches_creator on launches (creator);
create index if not exists idx_launches_created_at on launches (created_at desc);

create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists launches_updated_at on launches;
create trigger launches_updated_at
  before update on launches
  for each row execute function update_updated_at();

alter table launches enable row level security;
select create_policy_if_not_exists('launches', 'Anon read', 'select');

-- ============================================================
-- Badges table
-- ============================================================
create table if not exists badges (
  id bigint generated always as identity primary key,
  launch_address text not null,
  chain_id integer not null,
  badge_type text not null,
  granted_at timestamptz not null default now(),
  granted_by text,
  proof_url text,
  unique (launch_address, chain_id, badge_type)
);

create index if not exists idx_badges_launch on badges (launch_address, chain_id);
alter table badges enable row level security;
select create_policy_if_not_exists('badges', 'Anon read', 'select');

-- ============================================================
-- Launch transactions
-- ============================================================
create table if not exists launch_transactions (
  id bigint generated always as identity primary key,
  launch_address text not null,
  chain_id integer not null,
  buyer text not null,
  base_amount text not null default '0',
  tokens_received text not null default '0',
  tx_hash text,
  created_at timestamptz not null default now()
);

create index if not exists idx_launch_tx_address on launch_transactions (launch_address, chain_id);
alter table launch_transactions enable row level security;
select create_policy_if_not_exists('launch_transactions', 'Anon read', 'select');

-- ============================================================
-- Comments
-- ============================================================
create table if not exists comments (
  id bigint generated always as identity primary key,
  launch_address text not null,
  chain_id integer not null,
  wallet_address text not null,
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_comments_launch on comments (launch_address, chain_id);
alter table comments enable row level security;
select create_policy_if_not_exists('comments', 'Anon read', 'select');

-- ============================================================
-- Platform stats
-- ============================================================
create table if not exists platform_stats (
  id bigint generated always as identity primary key,
  chain_id integer not null,
  stat_date date not null default current_date,
  tokens_created integer not null default 0,
  partner_tokens_created integer not null default 0,
  creation_fees_usdt numeric(20,6) not null default 0,
  launches_created integer not null default 0,
  launches_graduated integer not null default 0,
  total_raised_usdt numeric(20,6) not null default 0,
  launch_fees_usdt numeric(20,6) not null default 0,
  tax_revenue_usdt numeric(20,6) not null default 0,
  created_at timestamptz not null default now(),
  unique (chain_id, stat_date)
);

create index if not exists idx_platform_stats_date on platform_stats (stat_date desc);
alter table platform_stats enable row level security;
select create_policy_if_not_exists('platform_stats', 'Anon read', 'select');

-- ============================================================
-- Created tokens
-- ============================================================
create table if not exists created_tokens (
  id bigint generated always as identity primary key,
  address text not null,
  chain_id integer not null,
  creator text not null,
  name text not null,
  symbol text not null,
  decimals integer not null default 18,
  is_taxable boolean not null default false,
  is_mintable boolean not null default false,
  is_partner boolean not null default false,
  -- Snapshot of totalSupply at daemon index time. Not kept live — for
  -- burn-on-trade or mintable tokens this drifts. Detail page fetches
  -- live from chain, list views use this snapshot for fast rendering.
  total_supply text not null default '0',
  created_at timestamptz not null default now(),
  unique (address, chain_id)
);

-- Re-add total_supply for databases where a previous migration dropped it.
alter table created_tokens add column if not exists total_supply text not null default '0';

-- Drop legacy columns from older deployments (idempotent).
alter table created_tokens drop column if exists type_key;
alter table created_tokens drop column if exists creation_fee_usdt;
alter table created_tokens drop column if exists tx_hash;

create index if not exists idx_created_tokens_chain on created_tokens (chain_id);
create index if not exists idx_created_tokens_creator on created_tokens (creator);
create index if not exists idx_created_tokens_created_at on created_tokens (created_at desc);
alter table created_tokens enable row level security;
select create_policy_if_not_exists('created_tokens', 'Anon read', 'select');

-- ============================================================
-- Recent transactions (social proof feed)
-- ============================================================
create table if not exists recent_transactions (
  id bigint generated always as identity primary key,
  chain_id integer not null,
  launch_address text not null,
  token_symbol text not null,
  token_name text not null,
  buyer text not null,
  tokens_amount text not null default '0',
  base_amount text not null default '0',
  base_symbol text not null default 'USDT',
  base_decimals integer not null default 6,
  token_decimals integer not null default 18,
  tx_hash text,
  created_at timestamptz not null default now()
);

create index if not exists idx_recent_tx_created on recent_transactions (created_at desc);
create index if not exists idx_recent_tx_chain on recent_transactions (chain_id);
create index if not exists idx_recent_tx_launch on recent_transactions (launch_address);
alter table recent_transactions enable row level security;
select create_policy_if_not_exists('recent_transactions', 'Anon read', 'select');

-- ============================================================
-- Withdrawal requests (off-ramp: crypto → fiat)
-- ============================================================
create table if not exists withdrawal_requests (
  id bigint generated always as identity primary key,
  withdraw_id integer,                    -- on-chain withdrawal ID (set after trade)
  chain_id integer not null,
  wallet_address text not null,
  token_in text not null,
  token_in_symbol text,
  gross_amount text not null default '0',
  fee text not null default '0',
  net_amount text not null default '0',
  payment_method text not null default 'bank',
  payment_details jsonb not null default '{}', -- encrypted
  status text not null default 'pending',
  admin_note text,
  tx_hash text,
  locked_naira_rate numeric(20,4),         -- rate shown to user at trade time
  locked_ngn_amount numeric(20,2),         -- exact NGN amount user was promised
  expires_at timestamptz,                 -- on-chain expiresAt (set by verify endpoint)
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Backfill: add expires_at column if table already exists
alter table withdrawal_requests add column if not exists expires_at timestamptz;

create index if not exists idx_withdrawals_wallet on withdrawal_requests (wallet_address);
create index if not exists idx_withdrawals_status on withdrawal_requests (status);
create index if not exists idx_withdrawals_created on withdrawal_requests (created_at desc);

-- Prevent duplicate on-chain withdrawal IDs (awaiting_trade records have withdraw_id=0 or null, so excluded)
create unique index if not exists idx_withdrawals_unique_onchain
  on withdrawal_requests (withdraw_id, chain_id)
  where withdraw_id is not null and withdraw_id > 0;
alter table withdrawal_requests enable row level security;
-- No anon read — withdrawal data only accessible via service role (server API)
-- Drop the old permissive policy if it exists.
do $$ begin
  if exists (select 1 from pg_policies where tablename = 'withdrawal_requests' and policyname = 'Anon read') then
    drop policy "Anon read" on withdrawal_requests;
  end if;
end $$;

create or replace trigger withdrawal_requests_updated_at
  before update on withdrawal_requests
  for each row execute function update_updated_at();

-- ============================================================
-- onramp_intents — NGN → USDT on-ramp via Flutterwave v4 virtual
-- accounts. The receiver is bound by an EIP-712 signature so even
-- a compromised backend can't redirect USDT to an attacker.
-- ============================================================
create table if not exists onramp_intents (
  id uuid primary key default gen_random_uuid(),
  reference text unique not null,            -- TKO-XXXXXX, server-issued
  nonce text not null,                       -- 0x-hex bytes32, single-use
  receiver text,                             -- set after sig submitted
  chain_id integer not null default 56,
  ngn_amount_kobo bigint not null,           -- ₦ × 100
  usdt_amount_wei text not null,             -- bigint as string
  rate_x100 integer not null,                -- ₦/$ × 100 at quote time
  expires_at timestamptz not null,           -- 15 min after quote

  signature text,                            -- 65-byte hex from signTypedData
  signed_at timestamptz,

  status text not null default 'quoted',
    -- quoted → pending_payment → payment_received → delivering → delivered
    -- forks: expired | failed | refunded | cancelled

  flutterwave_customer_id text,
  flutterwave_va_account_number text,
  flutterwave_va_bank_name text,
  flutterwave_tx_id text,
  flutterwave_payer_account text,
  flutterwave_payer_name text,

  delivery_tx_hash text,
  failure_reason text,

  created_at timestamptz not null default now(),
  paid_at timestamptz,
  delivered_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists idx_onramp_status on onramp_intents (status, created_at);
create index if not exists idx_onramp_receiver on onramp_intents (lower(receiver));
create unique index if not exists idx_onramp_nonce on onramp_intents (nonce);
alter table onramp_intents enable row level security;
-- No anon — service-role only (writes from server endpoints).

create or replace trigger onramp_intents_updated_at
  before update on onramp_intents
  for each row execute function update_updated_at();

-- ============================================================
-- Token aliases (vanity names for tokens, e.g. MAMA -> 0x...)
-- ============================================================
create table if not exists token_aliases (
  id bigint generated always as identity primary key,
  alias text not null unique,
  token_address text not null,
  chain_id integer not null,
  creator text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_token_alias on token_aliases (alias);
alter table token_aliases enable row level security;
select create_policy_if_not_exists('token_aliases', 'Anon read', 'select');

-- ============================================================
-- Nigerian banks reference (local cache)
-- ============================================================
create table if not exists ng_banks (
  id bigint generated always as identity primary key,
  code text not null unique,
  name text not null,
  slug text not null,
  ussd text not null default '',
  logo text not null default '',
  active boolean not null default true
);

alter table ng_banks enable row level security;
select create_policy_if_not_exists('ng_banks', 'Anon read', 'select');

-- ============================================================
-- Referral aliases
-- ============================================================
create table if not exists referral_aliases (
  id bigint generated always as identity primary key,
  alias text not null unique,
  wallet_address text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_referral_alias on referral_aliases (alias);
create index if not exists idx_referral_wallet on referral_aliases (wallet_address);
alter table referral_aliases enable row level security;
select create_policy_if_not_exists('referral_aliases', 'Anon read', 'select');

-- ============================================================
-- Platform config (unified key-value store for all settings)
-- Stores: networks, site info, social links, exchange rates, etc.
--
-- Expected shape for the 'networks' key (JSONB array, one entry per chain):
--   [
--     {
--       "name": "BSC",
--       "symbol": "bsc",                    // lowercase chain slug, also used as the GeckoTerminal network slug
--       "chain_id": 56,
--       "native_coin": "BNB",
--       "usdt_address": "0x55d398...",
--       "usdc_address": "0x8AC76a...",
--       "platform_address":     "0x...",    // TokenFactory
--       "launchpad_address":    "0x...",    // LaunchpadFactory
--       "router_address":       "0x...",    // PlatformRouter
--       "trade_router_address": "0x...",    // TradeRouter
--       "dex_router": "0x10ED43...",        // PancakeSwap V2 router (BSC)
--       "rpc": "https://...",
--       "explorer_url": "https://bscscan.com",
--       "default_bases": [                  // Pre-selected pool bases shown
--         { "address": "0x55d398...", "symbol": "USDT", "name": "Tether USD" },
--         { "address": "0xbb4CdB...", "symbol": "WBNB", "name": "Wrapped BNB" },
--         { "address": "0x8AC76a...", "symbol": "USDC", "name": "USD Coin" }
--       ]                                   // in the create wizard's pool-base
--                                           // multi-select. The wizard auto-
--                                           // resolves any custom address the
--                                           // creator adds via GeckoTerminal
--                                           // (uses `symbol` as the network
--                                           // slug) with on-chain ERC20 fallback.
--     }
--   ]
-- ============================================================
create table if not exists platform_config (
  key text primary key,
  value jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

alter table platform_config enable row level security;
select create_policy_if_not_exists('platform_config', 'Anon read', 'select');

drop trigger if exists platform_config_updated_at on platform_config;
create trigger platform_config_updated_at
  before update on platform_config
  for each row execute function update_updated_at();

-- Seed defaults
insert into platform_config (key, value) values
  ('networks', '[]'::jsonb),
  ('site', '{"name":"TokenKrafter","description":"Deploy custom ERC-20 tokens across multiple chains. No coding required.","support_email":"support@tokenkrafter.com"}'::jsonb),
  ('social_links', '{"twitter":"https://x.com/TokenKrafter","telegram_group":"","telegram_channel":"","discord":"","facebook":"","youtube":""}'::jsonb),
  ('exchange_rates', '{"base":"USD","rates":{"NGN":1385,"GBP":0.76,"EUR":0.87,"GHS":15.5,"KES":129},"source":"fallback"}'::jsonb),
  ('rate_override', '{"NGN":null,"spread_bps":30}'::jsonb)
on conflict (key) do nothing;

-- ============================================================
-- Enable Realtime for live updates (idempotent)
-- ============================================================
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'recent_transactions') then
    alter publication supabase_realtime add table recent_transactions;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'launches') then
    alter publication supabase_realtime add table launches;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'launch_transactions') then
    alter publication supabase_realtime add table launch_transactions;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'withdrawal_requests') then
    alter publication supabase_realtime add table withdrawal_requests;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'platform_config') then
    alter publication supabase_realtime add table platform_config;
  end if;
end $$;

-- ============================================================
-- Cleanup: remove old in-DB rate updater. The exchange-rate refresh
-- now runs from a daemon that writes platform_config directly.
-- Idempotent: skip silently if pg_cron isn't installed.
-- ============================================================
do $$ declare j record; begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- unschedule by jobid: name-based unschedule errors when the
    -- caller is not the job's owning role.
    for j in select jobid from cron.job where jobname = 'update-exchange-rates'
    loop
      perform cron.unschedule(j.jobid);
    end loop;
  end if;
end $$;
drop function if exists update_exchange_rates();
drop function if exists process_exchange_rate_response();

-- ============================================================
-- Wallets (embedded wallet — encrypted seed storage, multi-wallet)
-- ============================================================
-- One user can have multiple wallets. Each wallet has its own encrypted
-- seed, account count, and label. Imported wallets (user brought their
-- own mnemonic) skip the platform-generated recovery blobs and rely on
-- the user's external backup — `is_imported = true` marks those.
--
-- `is_primary` picks the default wallet on unlock; partial unique index
-- below enforces "at most one primary per user".
create table if not exists wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Wallet', -- user label e.g. "Personal", "Trading"
  primary_blob text not null,          -- AES(seed, PBKDF2(pin, salt))
  recovery_blob_1 text,                -- null for imported wallets
  recovery_blob_2 text,
  recovery_blob_3 text,
  account_count integer not null default 1,
  default_address text,
  is_imported boolean not null default false,
  is_primary boolean not null default false,
  preferences jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_wallets_user on wallets(user_id);
create unique index if not exists idx_wallets_one_primary_per_user
  on wallets(user_id) where is_primary = true;

alter table wallets enable row level security;
-- No anon read — wallet data only accessible via service role (server API)

drop trigger if exists wallets_updated_at on wallets;
create trigger wallets_updated_at
  before update on wallets
  for each row execute function update_updated_at();

-- Atomically switch the primary wallet for a user (prevents race conditions).
create or replace function set_primary_wallet(_user_id uuid, _wallet_id uuid)
returns void as $$
begin
  update wallets set is_primary = false
    where user_id = _user_id and is_primary = true;
  update wallets set is_primary = true
    where id = _wallet_id and user_id = _user_id;
end;
$$ language plpgsql;

-- ============================================================
-- Migrate legacy wallet_vaults rows → wallets, then drop the old table.
--
-- Idempotent + defensive:
--   - `to_regclass` returns NULL if `wallet_vaults` was already dropped,
--     so the whole block is a no-op on subsequent runs.
--   - The INSERT is guarded by `NOT EXISTS` on user_id so re-running
--     the schema after a partial migration won't create duplicates.
--   - Every row from the old table becomes the user's `is_primary` wallet
--     with `name = 'Primary'` — users can rename afterwards.
--   - `EXCEPTION WHEN OTHERS` swallows any unexpected errors as a notice
--     so a broken migration can't crash the rest of the schema run.
-- ============================================================
do $$
begin
  if to_regclass('public.wallet_vaults') is not null then
    -- Copy vault rows into the new wallets table. Skip users who
    -- already have at least one wallets row (re-run safety).
    insert into wallets (
      user_id, name, primary_blob,
      recovery_blob_1, recovery_blob_2, recovery_blob_3,
      account_count, default_address,
      is_imported, is_primary, preferences,
      created_at, updated_at
    )
    select
      v.user_id,
      'Primary',
      v.primary_blob,
      v.recovery_blob_1,
      v.recovery_blob_2,
      v.recovery_blob_3,
      coalesce(v.account_count, 1),
      v.default_address,
      false,
      true,
      coalesce(v.preferences, '{}'::jsonb),
      v.created_at,
      v.updated_at
    from wallet_vaults v
    where not exists (
      select 1 from wallets w where w.user_id = v.user_id
    );

    raise notice 'wallet_vaults migration complete, dropping legacy table';
    drop table wallet_vaults cascade;
  end if;
exception when others then
  raise notice 'wallet_vaults migration skipped: %', sqlerrm;
end $$;

-- Backfill for existing databases: make `name` default-able so batch
-- upserts that only carry id + primary_blob can succeed at the insert
-- path (Postgres checks NOT NULL before ON CONFLICT DO UPDATE fires).
alter table wallets alter column name set default 'Wallet';

-- ============================================================
-- Token metadata (logo, description, socials)
-- ============================================================
-- Add columns to existing created_tokens table
alter table created_tokens add column if not exists logo_url text;
alter table created_tokens add column if not exists description text;
alter table created_tokens add column if not exists website text;
alter table created_tokens add column if not exists twitter text;
alter table created_tokens add column if not exists telegram text;

-- SAFU badge data — populated by the chain indexer daemon via SafuLens
-- eth_call sweeps. The explore page uses these for instant SQL filtering
-- and sorting (is_safu DESC, has_liquidity DESC). Client-side SafuLens
-- still runs lazily on visible cards for real-time freshness.
alter table created_tokens add column if not exists is_safu boolean not null default false;
alter table created_tokens add column if not exists has_liquidity boolean not null default false;
alter table created_tokens add column if not exists lp_burned boolean not null default false;
alter table created_tokens add column if not exists lp_burned_pct integer not null default 0;
alter table created_tokens add column if not exists tax_ceiling_locked boolean not null default false;
alter table created_tokens add column if not exists owner_renounced boolean not null default false;
alter table created_tokens add column if not exists trading_enabled boolean not null default false;
alter table created_tokens add column if not exists buy_tax_bps integer not null default 0;
alter table created_tokens add column if not exists sell_tax_bps integer not null default 0;
alter table created_tokens add column if not exists safu_checked_at timestamptz;
alter table created_tokens add column if not exists is_kyc boolean not null default false;
alter table created_tokens add column if not exists kyc_note text; -- e.g. "AMA verified 2026-04-16"

create index if not exists idx_created_tokens_safu on created_tokens (is_safu, has_liquidity);

-- ============================================================
-- Enable Realtime for wallet vaults (for multi-device sync)
-- ============================================================
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'created_tokens') then
    alter publication supabase_realtime add table created_tokens;
  end if;
end $$;

-- Backfill: add locked rate/amount columns
alter table withdrawal_requests add column if not exists locked_naira_rate numeric(20,4);
alter table withdrawal_requests add column if not exists locked_ngn_amount numeric(20,2);
