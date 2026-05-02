# Environment files

```
.envs/
├── prod/        # gitignored — real production values
├── dev/         # gitignored — local-development values
└── examples/    # tracked — template files, copy and fill in
```

## First-time setup

For each `.env.example` in this directory, copy it to `prod/` (and `dev/` if you
need a separate dev variant) and fill in real values:

```bash
cp .envs/examples/web.env.example .envs/prod/web.env
# edit .envs/prod/web.env with real values
```

The repo expects, at minimum, `.envs/prod/web.env` and `.envs/prod/contracts.env`
to be present and populated.

## Symlinks

The web app and Hardhat each look for a `.env` next to them, which is a symlink
into `.envs/prod/` by default:

```
web/.env                → ../.envs/prod/web.env
solidty-contracts/.env  → ../.envs/prod/contracts.env
```

To swap the web frontend to dev (e.g. local Supabase, local RPC):

```bash
ln -sf ../.envs/dev/web.env web/.env
# back to prod:
ln -sf ../.envs/prod/web.env web/.env
```

## Daemons (docker-compose)

Each service in `docker-compose.yml` chains a shared `global.env` and its
own per-service file. Compose merges in order — later wins on duplicates.

```yaml
ws-indexer:
  env_file:
    - .envs/prod/global.env
    - .envs/prod/indexer.env
```

`global.env` carries values that are identical across services (RPC, FLW
key, vault TX_CONFIRM_SECRET, etc) so rotating a key once updates every
daemon. Per-service files only carry deltas (poll interval, bot mnemonic,
service-specific SYNC_SECRET, etc).

If you ever want a dev daemon stack, copy `docker-compose.yml` to
`docker-compose.dev.yml` and swap the `env_file` paths to `.envs/dev/*.env`.

## What goes where

| File | Purpose |
| --- | --- |
| `global.env` | Shared across daemons: RPC, CHAIN_ID, FLW key, TX_CONFIRM_SECRET, REDIS_URL, API_BASE_URL |
| `web.env` | SvelteKit frontend + API routes (Supabase, admin keys, Telegram) — pushed to CF Pages with `bun scripts/sync-cf-env.mjs` |
| `contracts.env` | Hardhat deploy + verify (deployer key, Etherscan API) |
| `indexer.env` | ws-indexer, safu-indexer, rate-updater (poll interval, daemon SYNC_SECRET) |
| `activity-bot.env` | Synthetic activity-generation bot (mnemonic, wallet count, scatter ranges) |
| `launch-buy-bot.env` | Synthetic launchpad-buy bot |
| `payment.env` | Flutterwave proxy — really just `PORT` now (rest is in `global.env`) |
| `processor.env` | Withdrawal processor (TRADE_ROUTER, ADMIN_ADDRESS, vault SYNC_SECRET, Telegram) |
| `onramp-delivery.env` | On-ramp delivery daemon (vault SYNC_SECRET, poll interval) |
| `SafuLens.json` | SafuLens bytecode artifact (mounted as a volume by the safu daemon) |
