#!/usr/bin/env bash
# Rebuild the standalone daemons (chain-indexer, activity-bot, rate-updater)
# and ship them to the VPS, then restart the systemd services.
#
# Prerequisites:
#   - VPS reachable as root@176.32.32.230 with the SSH key at $SSH_KEY
#   - bun installed locally
#   - On the VPS: /etc/systemd/system/tk-{indexer,activity,rates}.service
#     already exist with their EnvironmentFile pointing at /root/.env.{indexer,activity,rates}
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

echo "═══════════════════════════════════════════════"
echo "  Rebuilding daemon bundles..."
echo "═══════════════════════════════════════════════"

cd "$DAEMONS"
bun build chain-indexer.ts \
	--outfile dist/tk-indexer.mjs --target node --minify
bun build ws-indexer.ts \
	--outfile dist/tk-ws-indexer.mjs --target node --minify
bun build activity-bot.ts \
	--outfile dist/tk-activity.mjs --target node --minify
bun build rate-updater.ts \
	--outfile dist/rate-updater.mjs --target node --minify
bun build safu-indexer.ts \
	--outfile dist/tk-safu.mjs --target node --minify

echo
echo "═══════════════════════════════════════════════"
echo "  Uploading to VPS..."
echo "═══════════════════════════════════════════════"

$SCP "$DAEMONS/dist/tk-indexer.mjs" "${VPS_USER}@${VPS_HOST}:~/tk-indexer.mjs"
$SCP "$DAEMONS/dist/tk-ws-indexer.mjs" "${VPS_USER}@${VPS_HOST}:~/tk-ws-indexer.mjs"
$SCP "$DAEMONS/dist/tk-activity.mjs" "${VPS_USER}@${VPS_HOST}:~/tk-activity.mjs"
$SCP "$DAEMONS/dist/rate-updater.mjs" "${VPS_USER}@${VPS_HOST}:~/rate-updater.mjs"
$SCP "$DAEMONS/dist/tk-safu.mjs" "${VPS_USER}@${VPS_HOST}:~/tk-safu.mjs"

echo
echo "═══════════════════════════════════════════════"
echo "  Restarting services..."
echo "═══════════════════════════════════════════════"

$SSH "systemctl restart tk-indexer tk-ws-indexer tk-activity tk-rates tk-safu 2>/dev/null || true"
sleep 3

echo
echo "  Status check:"
$SSH "for s in tk-indexer tk-ws-indexer tk-activity tk-rates tk-safu; do
	echo
	echo \"── \$s ──\"
	systemctl status \$s --no-pager 2>/dev/null | head -6 || echo '(service not configured)'
done"

echo
echo "✓ Done. Tail logs with:"
echo "  ssh ${VPS_USER}@${VPS_HOST} 'journalctl -u tk-indexer -f'"
