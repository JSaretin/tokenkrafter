-- TokenKrafter Schema (fully idempotent — safe to run multiple times)
-- Run this in your Supabase SQL editor

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
select create_policy_if_not_exists('launches', 'Public read access', 'select');
select create_policy_if_not_exists('launches', 'Service role write access', 'insert', null, 'true');
select create_policy_if_not_exists('launches', 'Service role update access', 'update');

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
select create_policy_if_not_exists('badges', 'Public read badges', 'select');
select create_policy_if_not_exists('badges', 'Service role insert badges', 'insert', null, 'true');
select create_policy_if_not_exists('badges', 'Service role delete badges', 'delete');

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
select create_policy_if_not_exists('launch_transactions', 'Public read', 'select');
select create_policy_if_not_exists('launch_transactions', 'Service write', 'insert', null, 'true');

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
select create_policy_if_not_exists('comments', 'Public read comments', 'select');
select create_policy_if_not_exists('comments', 'Service write comments', 'insert', null, 'true');

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
select create_policy_if_not_exists('platform_stats', 'Public read stats', 'select');
select create_policy_if_not_exists('platform_stats', 'Service write stats', 'insert', null, 'true');
select create_policy_if_not_exists('platform_stats', 'Service update stats', 'update');

-- ============================================================
-- Site visitors
-- ============================================================
create table if not exists site_visitors (
  id bigint generated always as identity primary key,
  total_visitors integer not null default 0,
  browsing integer not null default 0,
  creating integer not null default 0,
  investing integer not null default 0,
  updated_at timestamptz not null default now()
);

-- Seed initial row if empty
insert into site_visitors (total_visitors, browsing, creating, investing)
select 0, 0, 0, 0
where not exists (select 1 from site_visitors limit 1);

alter table site_visitors enable row level security;
select create_policy_if_not_exists('site_visitors', 'Public read visitors', 'select');
select create_policy_if_not_exists('site_visitors', 'Service write visitors', 'update');

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
  total_supply text not null,
  decimals integer not null default 18,
  is_taxable boolean not null default false,
  is_mintable boolean not null default false,
  is_partner boolean not null default false,
  type_key smallint not null default 0,
  creation_fee_usdt numeric(20,6) not null default 0,
  tx_hash text,
  created_at timestamptz not null default now(),
  unique (address, chain_id)
);

create index if not exists idx_created_tokens_chain on created_tokens (chain_id);
create index if not exists idx_created_tokens_creator on created_tokens (creator);
create index if not exists idx_created_tokens_created_at on created_tokens (created_at desc);
alter table created_tokens enable row level security;
select create_policy_if_not_exists('created_tokens', 'Public read tokens', 'select');
select create_policy_if_not_exists('created_tokens', 'Service write tokens', 'insert', null, 'true');

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
select create_policy_if_not_exists('recent_transactions', 'Public read recent_tx', 'select');
select create_policy_if_not_exists('recent_transactions', 'Service write recent_tx', 'insert', null, 'true');

-- ============================================================
-- Withdrawal requests (off-ramp: crypto → fiat)
-- ============================================================
create table if not exists withdrawal_requests (
  id bigint generated always as identity primary key,
  withdraw_id integer not null,           -- on-chain withdrawal ID
  chain_id integer not null,
  wallet_address text not null,
  token_in text not null,                 -- token user deposited
  token_in_symbol text,
  gross_amount text not null default '0', -- before fee (USDT)
  fee text not null default '0',
  net_amount text not null default '0',   -- after fee
  payment_method text not null default 'bank', -- 'bank', 'paypal', 'wise', etc.
  payment_details jsonb not null default '{}', -- encrypted/hashed details
  status text not null default 'pending', -- 'pending', 'confirmed', 'cancelled'
  admin_note text,
  tx_hash text,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (withdraw_id, chain_id)
);

create index if not exists idx_withdrawals_wallet on withdrawal_requests (wallet_address);
create index if not exists idx_withdrawals_status on withdrawal_requests (status);
create index if not exists idx_withdrawals_created on withdrawal_requests (created_at desc);
alter table withdrawal_requests enable row level security;
select create_policy_if_not_exists('withdrawal_requests', 'Public read withdrawals', 'select');
select create_policy_if_not_exists('withdrawal_requests', 'Service write withdrawals', 'insert', null, 'true');
select create_policy_if_not_exists('withdrawal_requests', 'Service update withdrawals', 'update');

-- Trigger updated_at
create or replace trigger withdrawal_requests_updated_at
  before update on withdrawal_requests
  for each row execute function update_updated_at();

-- (realtime added in idempotent block below)

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

-- Banks are populated via Flutterwave API on first app load
-- Call GET /api/bank?refresh=true to fetch all 597 Nigerian banks

alter table ng_banks enable row level security;
select create_policy_if_not_exists('ng_banks', 'Public read banks', 'select');

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
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'site_visitors') then
    alter publication supabase_realtime add table site_visitors;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'launch_transactions') then
    alter publication supabase_realtime add table launch_transactions;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'withdrawal_requests') then
    alter publication supabase_realtime add table withdrawal_requests;
  end if;
end $$;

-- ============================================================
-- Platform settings (exchange rates, admin overrides)
-- ============================================================
create table if not exists platform_settings (
  key text primary key,
  value jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

alter table platform_settings enable row level security;
select create_policy_if_not_exists('platform_settings', 'Public read settings', 'select');
select create_policy_if_not_exists('platform_settings', 'Service write settings', 'insert', null, 'true');
select create_policy_if_not_exists('platform_settings', 'Service update settings', 'update');

-- Seed exchange rates row
insert into platform_settings (key, value) values
  ('exchange_rates', '{"base":"USD","rates":{"NGN":1385,"GBP":0.76,"EUR":0.87,"GHS":15.5,"KES":129},"source":"fallback"}')
on conflict (key) do nothing;

-- Seed admin rate override (null = use live rate)
insert into platform_settings (key, value) values
  ('rate_override', '{"NGN":null,"spread_bps":30}')
on conflict (key) do nothing;

-- ============================================================
-- pg_cron: auto-update exchange rates every hour
-- Requires pg_net extension (enabled by default on Supabase)
-- ============================================================

-- Enable extensions (idempotent)
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema extensions;

-- Function to fetch and store exchange rates
create or replace function update_exchange_rates()
returns void as $$
declare
  response_id bigint;
  response_body jsonb;
  rates jsonb;
begin
  -- Make HTTP request to exchange rate API
  select net.http_get(
    url := 'https://open.er-api.com/v6/latest/USD'
  ) into response_id;

  -- Wait briefly for response (pg_net is async)
  -- The actual update happens in the callback below
end;
$$ language plpgsql;

-- Callback function that processes the HTTP response
create or replace function process_exchange_rate_response()
returns trigger as $$
declare
  body jsonb;
  rates jsonb;
begin
  -- Only process successful responses
  if NEW.status_code = 200 then
    body := NEW.content::jsonb;
    if body->>'result' = 'success' and body->'rates' is not null then
      rates := body->'rates';

      update platform_settings
      set value = jsonb_build_object(
        'base', 'USD',
        'rates', jsonb_build_object(
          'NGN', (rates->>'NGN')::numeric,
          'GBP', (rates->>'GBP')::numeric,
          'EUR', (rates->>'EUR')::numeric,
          'GHS', (rates->>'GHS')::numeric,
          'KES', (rates->>'KES')::numeric
        ),
        'source', 'open.er-api.com',
        'fetched_at', now()
      ),
      updated_at = now()
      where key = 'exchange_rates';
    end if;
  end if;
  return NEW;
end;
$$ language plpgsql;

-- Schedule: update rates every hour
select cron.schedule(
  'update-exchange-rates',
  '0 * * * *',  -- every hour at minute 0
  $$select update_exchange_rates()$$
);

-- ============================================================
-- Cleanup helper function (optional — drop after migration)
-- ============================================================
-- drop function if exists create_policy_if_not_exists;
