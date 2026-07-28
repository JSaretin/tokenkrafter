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

`docker-compose.yml` references `.envs/prod/*.env` directly:

```yaml
ws-indexer:
  env_file: .envs/prod/indexer.env
```

If you ever want a dev daemon stack, copy `docker-compose.yml` to
`docker-compose.dev.yml` and swap the `env_file` paths to `.envs/dev/*.env`.

## What goes where

| File | Purpose |
| --- | --- |
| `web.env` | SvelteKit frontend + API routes (Supabase, Flutterwave, admin keys) |
| `contracts.env` | Hardhat deploy + verify (deployer key, Etherscan API) |
| `indexer.env` | ws-indexer, safu-indexer, rate-updater (RPC, sync auth) |
| `activity-bot.env` | Synthetic activity-generation bot |
| `launch-buy-bot.env` | Synthetic launchpad-buy bot |
| `payment.env` | Flutterwave payment proxy |
| `processor.env` | Withdrawal processor (off-ramp) |
| `onramp-delivery.env` | On-ramp delivery daemon |
| `SafuLens.json` | SafuLens bytecode artifact (referenced as a volume by the safu daemon) |
