# On-Ramp Implementation (Fiat → Crypto)

User flow: insufficient balance → "Buy Crypto" → pay with bank/card → crypto arrives in wallet → continue.

## Phase 1: Backend

### Flutterwave Charge API
- [ ] `POST /api/onramp` — create charge request
  - Input: `amount` (fiat), `currency` (NGN), `target_coin` (BNB/USDT), `wallet_address`, `chain_id`
  - Calls Flutterwave v4 charge API (bank transfer or card)
  - Returns: payment instructions (bank name, account number, amount, reference)
  - Stores pending order in `onramp_orders` table (status: `pending`)
- [ ] Create `onramp_orders` table in Supabase:
  - `id`, `wallet_address`, `chain_id`, `fiat_amount`, `fiat_currency`, `target_coin`, `target_amount`
  - `flw_reference`, `flw_charge_id`, `status` (pending/paid/sending/completed/failed)
  - `tx_hash` (crypto send), `created_at`, `completed_at`

### Webhook Handler
- [ ] `POST /api/webhooks/flutterwave/charge` — receive payment confirmation
  - Verify Flutterwave webhook signature
  - Update order status to `paid`
  - Trigger crypto send

### Crypto Send
- [ ] Server-side send function:
  - Option A: platform hot wallet holds reserve BNB/USDT, sends directly
  - Option B: server buys on DEX with platform USDT reserve, sends to user
  - Use platform signer (env `PLATFORM_PRIVATE_KEY`)
  - Send exact amount minus spread to user's `wallet_address`
  - Update order: `status = completed`, `tx_hash = ...`
- [ ] Rate calculation: fetch live BNB/USDT price, apply spread (e.g. 1.5%)
- [ ] Reserve monitoring: alert if hot wallet balance is low

### Real-time Updates
- [ ] Enable Supabase Realtime on `onramp_orders`
- [ ] Frontend subscribes to order status changes
- [ ] Alternative: poll `GET /api/onramp/:id` every 5s

## Phase 2: Frontend

### On-Ramp Modal Component (`$lib/OnRampModal.svelte`)
- [ ] Step 1: **Amount** — enter fiat amount (NGN), show estimated crypto amount
  - Pre-fill with exact deficit (e.g. user needs 0.05 BNB, show NGN equivalent)
  - Live rate display with spread disclosure
- [ ] Step 2: **Payment** — show bank transfer details from Flutterwave
  - Bank name, account number, amount to send, reference
  - Copy buttons for each field
  - "I've sent the money" button (or auto-detect via webhook)
- [ ] Step 3: **Processing** — waiting for confirmation
  - Show spinner + "Waiting for payment confirmation..."
  - Subscribe to Realtime for status updates
  - Show "Payment received, sending crypto..." when status = `paid`
  - Show tx hash link when status = `sending`
- [ ] Step 4: **Done** — crypto received
  - Show success checkmark + amount received
  - "Continue" button closes modal
  - Balance poller picks up new balance automatically

### Integration Points
- [ ] Create page deposit screen: add "Buy Crypto" button next to QR
  - Pre-fill exact amount needed for token creation
  - On completion, auto-resume `confirmAndDeploy()`
- [ ] Trade page: add "Buy Crypto" option when balance insufficient
- [ ] Account panel: add "Buy" button in wallet view
- [ ] Launchpad buy: add "Buy Crypto" when insufficient for launch contribution

### UX Details
- [ ] Modal contained within page (not full-screen on desktop)
- [ ] Show countdown timer for bank transfer expiry (Flutterwave has ~30min window)
- [ ] Handle edge cases: payment timeout, partial payment, duplicate payment
- [ ] Show clear fee breakdown: fiat amount → platform spread → crypto received

## Phase 3: Admin

### Dashboard
- [ ] On-ramp orders list in admin panel (/_)
  - Filter by status, date, wallet
  - Manual retry for failed sends
  - Manual confirmation for stuck orders
- [ ] Reserve wallet balance display
- [ ] Daily on-ramp volume stats

### Configuration
- [ ] Admin-configurable spread percentage (platform_config)
- [ ] Min/max fiat amount limits
- [ ] Supported coins toggle (BNB, USDT, USDC)
- [ ] Kill switch to disable on-ramp

## Security Considerations
- [ ] Rate-limit charge creation per wallet (max 3 pending per hour)
- [ ] Verify Flutterwave webhook HMAC signature
- [ ] Platform hot wallet key in env, never exposed to frontend
- [ ] Amount validation: server recalculates crypto amount at send time (not from client)
- [ ] Idempotency: webhook may fire multiple times, only send crypto once
- [ ] Reserve alerts: notify admin when hot wallet drops below threshold
