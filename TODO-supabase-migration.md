# Self-Host Supabase Migration

## 1. VPS Setup
- [ ] Buy Hetzner VPS (4 vCPU, 8GB RAM, 40GB NVMe, Germany/Helsinki)
- [ ] SSH access, set up firewall (UFW: 22, 80, 443, 5432)
- [ ] Install Docker + Docker Compose
- [ ] Set up domain/subdomain (e.g. db.tokenkrafter.com)
- [ ] SSL via Caddy or Certbot

## 2. Install Supabase
- [ ] Clone supabase/supabase docker repo
- [ ] Configure `.env` (JWT secret, anon key, service role key, SMTP if needed)
- [ ] Start Supabase stack (postgres, postgrest, gotrue, realtime, storage)
- [ ] Verify dashboard accessible at subdomain
- [ ] Test auth, realtime, and storage endpoints

## 3. Migrate Data
- [ ] Export current Supabase Cloud DB (`pg_dump`)
- [ ] Import into self-hosted Postgres (`pg_restore`)
- [ ] Verify all tables, RLS policies, functions, triggers
- [ ] Migrate storage bucket (token-logos) — download all files, upload to self-hosted storage
- [ ] Migrate auth users (Google OAuth users + wallet vaults)

## 4. Migrate Config
- [ ] Re-create RLS policies
- [ ] Re-enable Realtime on tables (launches, comments, recent_transactions, withdrawal_requests, site_visitors)
- [ ] Set up pg_cron for exchange rate updates
- [ ] Verify platform_config table has all network configs

## 5. Update App
- [ ] Update `SUPABASE_URL` and `SUPABASE_ANON_KEY` in env
- [ ] Update `supabaseAdmin` service role key in server env
- [ ] Update Google OAuth redirect URLs in Google Console (new Supabase URL)
- [ ] Update Supabase Auth config (Google provider, site URL, redirect URLs)
- [ ] Test embedded wallet flow (Google login → vault → unlock)
- [ ] Test all API endpoints against new DB
- [ ] Test Realtime subscriptions (comments, launches)
- [ ] Test storage uploads (token logos)

## 6. Update Daemon
- [ ] Point daemon `API_BASE_URL` to production (no change if using same domain)
- [ ] Run daemon on the VPS itself (saves a server, lowest latency to DB)
- [ ] Test full indexing cycle

## 7. DNS Cutover
- [ ] Point API/DB subdomain to new VPS
- [ ] Keep Supabase Cloud running for 48h as fallback
- [ ] Monitor error rates, latency, IO
- [ ] Delete Supabase Cloud project after confirmed stable

## 8. Ongoing
- [ ] Set up automated Postgres backups (pg_dump cron → S3 or local)
- [ ] Monitor disk usage (30-50GB)
- [ ] Set up uptime monitoring (UptimeRobot or similar)
- [ ] Docker auto-restart on crash
