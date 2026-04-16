#!/usr/bin/env bash
# Rebuild daemons + payment server and ship to VPS, then restart services.
#
# Services:
#   tk-ws-indexer  — WS event subscriber + safety-net poller (replaces tk-indexer)
#   tk-activity    — activity bot
#   tk-rates       — fiat rate updater
#   tk-safu        — SAFU bulk sweep
#   tk-payment     — Flutterwave proxy
#   tk-processor   — withdrawal processor
#
# Prerequisites:
#   - VPS reachable as root@176.32.32.230 with SSH key at $SSH_KEY
#   - bun installed locally
#   - On VPS: systemd services with EnvironmentFile pointing at /root/.env.*
#
# Usage: bash scripts/redeploy-vps-daemons.sh

set -euo pipefail

VPS_USER=root
VPS_HOST=176.32.32.230
SSH_KEY="${SSH_KEY:-/mnt/external/home/john/.ssh/id_rsa}"
SSH="ssh -o ConnectTimeout=10 -i $SSH_KEY ${VPS_USER}@${VPS_HOST}"
SCP="scp -i $SSH_KEY"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DAEMONS="$ROOT/daemons"
PAYMENT="$ROOT/payment-server"

echo "═══════════════════════════════════════════════"
echo "  Rebuilding daemon bundles..."
echo "═══════════════════════════════════════════════"

cd "$DAEMONS"
bun build ws-indexer.ts \
	--outfile dist/tk-ws-indexer.mjs --target node --minify
bun build activity-bot.ts \
	--outfile dist/tk-activity.mjs --target node --minify
bun build rate-updater.ts \
	--outfile dist/rate-updater.mjs --target node --minify
bun build safu-indexer.ts \
	--outfile dist/tk-safu.mjs --target node --minify

echo
echo "  Rebuilding payment server..."
cd "$PAYMENT"
bun build index.ts \
	--outfile dist/tk-payment.mjs --target node --minify
bun build withdrawal-processor.ts \
	--outfile dist/tk-processor.mjs --target node --minify

echo
echo "═══════════════════════════════════════════════"
echo "  Uploading to VPS..."
echo "═══════════════════════════════════════════════"

$SCP "$DAEMONS/dist/tk-ws-indexer.mjs" "${VPS_USER}@${VPS_HOST}:~/tk-ws-indexer.mjs"
$SCP "$DAEMONS/dist/tk-activity.mjs" "${VPS_USER}@${VPS_HOST}:~/tk-activity.mjs"
$SCP "$DAEMONS/dist/rate-updater.mjs" "${VPS_USER}@${VPS_HOST}:~/rate-updater.mjs"
$SCP "$DAEMONS/dist/tk-safu.mjs" "${VPS_USER}@${VPS_HOST}:~/tk-safu.mjs"
$SCP "$PAYMENT/dist/tk-payment.mjs" "${VPS_USER}@${VPS_HOST}:~/tk-payment.mjs"
$SCP "$PAYMENT/dist/tk-processor.mjs" "${VPS_USER}@${VPS_HOST}:~/tk-processor.mjs"

echo
echo "═══════════════════════════════════════════════"
echo "  Stopping retired tk-indexer (replaced by ws-indexer)..."
echo "═══════════════════════════════════════════════"
$SSH "systemctl stop tk-indexer 2>/dev/null; systemctl disable tk-indexer 2>/dev/null || true"

echo
echo "═══════════════════════════════════════════════"
echo "  Restarting services..."
echo "═══════════════════════════════════════════════"

$SSH "systemctl restart tk-ws-indexer tk-activity tk-rates tk-safu tk-payment tk-processor 2>/dev/null || true"
sleep 3

echo
echo "  Status check:"
$SSH "for s in tk-ws-indexer tk-activity tk-rates tk-safu tk-payment tk-processor; do
	echo
	echo \"── \$s ──\"
	systemctl status \$s --no-pager 2>/dev/null | head -6 || echo '(service not configured)'
done"

echo
echo "✓ Done. Tail logs with:"
echo "  ssh ${VPS_USER}@${VPS_HOST} 'journalctl -u tk-ws-indexer -f'"
