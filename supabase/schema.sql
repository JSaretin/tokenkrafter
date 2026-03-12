-- TokenKrafter Launchpad Schema
-- Run this in your Supabase SQL editor

-- Launches table: indexes on-chain launch data + off-chain metadata
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
  total_tokens_required text not null default '0',
  total_tokens_deposited text not null default '0',

  -- Token metadata (cached from chain)
  token_name text,
  token_symbol text,
  token_decimals integer default 18,
  usdt_decimals integer default 18,

  -- Off-chain metadata (submitted by creator)
  description text,
  logo_url text,
  website text,
  twitter text,
  telegram text,
  discord text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (address, chain_id)
);

-- Index for fast queries
create index if not exists idx_launches_chain_id on launches (chain_id);
create index if not exists idx_launches_state on launches (state);
create index if not exists idx_launches_creator on launches (creator);
create index if not exists idx_launches_created_at on launches (created_at desc);

-- Auto-update updated_at
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create or replace trigger launches_updated_at
  before update on launches
  for each row execute function update_updated_at();

-- Allow public reads (anon key)
alter table launches enable row level security;

create policy "Public read access"
  on launches for select
  using (true);

-- Only service role can insert/update (server-side API)
create policy "Service role write access"
  on launches for insert
  with check (true);

create policy "Service role update access"
  on launches for update
  using (true);
