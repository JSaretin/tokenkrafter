/**
 * Withdrawal Processor Daemon
 *
 * Polls the TradeRouter contract for pending withdrawals and processes
 * them: confirms on-chain + sends fiat via the SvelteKit backend.
 *
 * Runs on the same VPS as the payment proxy so it calls the backend
 * locally (no external network hop for Flutterwave).
 *
 * Caches alerts in Redis so admins aren't spammed for the same issue.
 *
 * Env:
 *   CHAIN_RPC          — BSC RPC URL
 *   CHAIN_ID           — chain ID (56 for BSC)
 *   TRADE_ROUTER       — TradeRouter contract address
 *   ADMIN_KEY          — private key for on-chain confirm (gas payer)
 *   TX_CONFIRM_SECRET  — auth for the SvelteKit /api/withdrawals/process
 *   BACKEND_URL        — SvelteKit backend URL (e.g. https://tokenkrafter.com)
 *   FLUTTERWAVE_SECRET_KEY — for direct balance check
 *   REDIS_URL          — Redis connection (default redis://localhost:6379)
 *   MIN_GAS_BNB        — minimum admin BNB balance (default 0.005)
 *   MIN_FLW_NGN        — minimum Flutterwave NGN balance (default 1000)
 *   ALERT_WEBHOOK      — optional webhook URL for low-balance alerts
 *   POLL_INTERVAL_MS   — polling interval (default 30000)
 */

import { createClient, type RedisClientType } from 'redis';

const {
	CHAIN_RPC = 'https://bsc-rpc.publicnode.com',
	CHAIN_ID = '56',
	TRADE_ROUTER = '',
	ADMIN_KEY = '',
	TX_CONFIRM_SECRET = '',
	BACKEND_URL = 'https://tokenkrafter.com',
	FLUTTERWAVE_SECRET_KEY = '',
	REDIS_URL = 'redis://localhost:6379',
	MIN_GAS_BNB = '0.005',
	MIN_FLW_NGN = '1000',
	ALERT_WEBHOOK = '',
	POLL_INTERVAL_MS = '30000',
} = Bun.env;

if (!TRADE_ROUTER) { console.error('TRADE_ROUTER required'); process.exit(1); }
if (!ADMIN_KEY) { console.error('ADMIN_KEY required'); process.exit(1); }
if (!TX_CONFIRM_SECRET) { console.error('TX_CONFIRM_SECRET required'); process.exit(1); }
if (!FLUTTERWAVE_SECRET_KEY) { console.error('FLUTTERWAVE_SECRET_KEY required'); process.exit(1); }

const chainId = parseInt(CHAIN_ID);
const pollInterval = parseInt(POLL_INTERVAL_MS);
const minGasBnb = parseFloat(MIN_GAS_BNB);
const minFlwNgn = parseFloat(MIN_FLW_NGN);

// ── Minimal ethers (import only what we need) ──
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider(CHAIN_RPC, chainId, { staticNetwork: true });
const adminWallet = new ethers.Wallet(ADMIN_KEY, provider);

const ROUTER_ABI = [
	'function pendingCount() view returns (uint256)',
	'function pendingIds(uint256) view returns (uint256)',
	'function getWithdrawal(uint256 id) view returns (tuple(address user, address token, uint256 grossAmount, uint256 fee, uint256 netAmount, uint256 createdAt, uint256 expiresAt, uint8 status, bytes32 bankRef, address referrer))',
];

const router = new ethers.Contract(TRADE_ROUTER, ROUTER_ABI, provider);

// ── Redis ──
let redis: RedisClientType;

async function initRedis() {
	redis = createClient({ url: REDIS_URL });
	redis.on('error', (err) => console.error('Redis error:', err.message));
	await redis.connect();
	console.log('Redis connected');
}

// Alert cache keys expire after 24h — so alerts re-fire daily at most
const ALERT_TTL = 86400;

async function hasAlerted(key: string): Promise<boolean> {
	return (await redis.exists(key)) === 1;
}

async function markAlerted(key: string): Promise<void> {
	await redis.set(key, '1', { EX: ALERT_TTL });
}

async function clearAlert(key: string): Promise<void> {
	await redis.del(key);
}

// ── Alerts ──
async function sendAlert(subject: string, message: string): Promise<void> {
	console.warn(`[ALERT] ${subject}: ${message}`);

	if (!ALERT_WEBHOOK) return;

	try {
		await fetch(ALERT_WEBHOOK, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content: `**${subject}**\n${message}`,
				// Discord webhook format — also works for many other services
				text: `${subject}: ${message}`,
			}),
		});
	} catch (e: any) {
		console.error('Alert webhook failed:', e.message);
	}
}

// ── Balance checks ──
async function getAdminBnbBalance(): Promise<number> {
	const bal = await provider.getBalance(adminWallet.address);
	return parseFloat(ethers.formatEther(bal));
}

async function getFlutterwaveBalance(): Promise<number> {
	try {
		const res = await fetch('https://api.flutterwave.com/v3/balances/NGN', {
			headers: { Authorization: `Bearer ${FLUTTERWAVE_SECRET_KEY}` },
		});
		const data = await res.json();
		return data?.data?.available_balance || 0;
	} catch {
		return 0;
	}
}

// ── Process a single withdrawal ──
async function processWithdrawal(withdrawId: number): Promise<boolean> {
	const key = `processing:${chainId}:${withdrawId}`;

	// Check if already being processed
	if (await redis.exists(key)) {
		return false;
	}

	// Lock for 5 minutes (prevents duplicate processing)
	await redis.set(key, Date.now().toString(), { EX: 300 });

	try {
		const res = await fetch(`${BACKEND_URL}/api/withdrawals/process`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${TX_CONFIRM_SECRET}`,
			},
			body: JSON.stringify({
				withdraw_id: withdrawId,
				chain_id: chainId,
			}),
		});

		const data = await res.json();

		if (data.success) {
			console.log(`[OK] Withdrawal #${withdrawId} processed: NGN ${data.ngn_amount}, tx: ${data.confirm_tx}`);
			// Clear any previous low-balance alerts for this withdrawal
			await clearAlert(`alert:low_flw:${withdrawId}`);
			await redis.del(key);
			return true;
		} else {
			console.error(`[FAIL] Withdrawal #${withdrawId}: ${data.error}`);

			// If it's a balance issue, don't retry immediately
			if (data.error?.includes('Insufficient Flutterwave')) {
				const alertKey = `alert:low_flw:${withdrawId}`;
				if (!(await hasAlerted(alertKey))) {
					await sendAlert('Low Flutterwave Balance', `Cannot process withdrawal #${withdrawId}: ${data.error}`);
					await markAlerted(alertKey);
				}
			}

			await redis.del(key);
			return false;
		}
	} catch (e: any) {
		console.error(`[ERROR] Withdrawal #${withdrawId}:`, e.message);
		await redis.del(key);
		return false;
	}
}

// ── Main polling loop ──
async function poll() {
	try {
		// 1. Check admin gas balance
		const bnbBal = await getAdminBnbBalance();
		if (bnbBal < minGasBnb) {
			const alertKey = `alert:low_gas:${adminWallet.address}`;
			if (!(await hasAlerted(alertKey))) {
				await sendAlert(
					'Low Admin Gas Balance',
					`Admin wallet ${adminWallet.address} has ${bnbBal.toFixed(6)} BNB (min: ${minGasBnb} BNB). On-chain confirms will fail.`,
				);
				await markAlerted(alertKey);
			}
			console.warn(`[SKIP] Admin BNB balance too low: ${bnbBal.toFixed(6)}`);
			return;
		}

		// 2. Check Flutterwave balance
		const flwBal = await getFlutterwaveBalance();
		if (flwBal < minFlwNgn) {
			const alertKey = 'alert:low_flw:global';
			if (!(await hasAlerted(alertKey))) {
				await sendAlert(
					'Low Flutterwave Balance',
					`NGN wallet has ₦${flwBal.toLocaleString()}. Minimum: ₦${minFlwNgn.toLocaleString()}. Payouts paused.`,
				);
				await markAlerted(alertKey);
			}
			console.warn(`[SKIP] Flutterwave NGN balance too low: ₦${flwBal}`);
			return;
		}

		// 3. Read pending withdrawals from chain
		const count = Number(await router.pendingCount());
		if (count === 0) return;

		console.log(`[POLL] ${count} pending withdrawal(s)`);

		// Read all pending IDs
		const ids: number[] = [];
		for (let i = 0; i < count; i++) {
			const id = Number(await router.pendingIds(i));
			ids.push(id);
		}

		// Process each
		let processed = 0;
		let skipped = 0;

		for (const id of ids) {
			// Check if this withdrawal has expired (user can cancel, we shouldn't process)
			try {
				const w = await router.getWithdrawal(id);
				const expiresAt = Number(w.expiresAt);
				const now = Math.floor(Date.now() / 1000);

				if (expiresAt > 0 && now >= expiresAt) {
					// Expired — skip, user can cancel or admin can refund
					skipped++;
					continue;
				}
			} catch {
				continue;
			}

			const ok = await processWithdrawal(id);
			if (ok) processed++;

			// Small delay between processing to avoid rate limits
			if (ids.length > 1) await Bun.sleep(2000);
		}

		if (processed > 0 || skipped > 0) {
			console.log(`[DONE] Processed: ${processed}, Skipped (expired): ${skipped}, Remaining: ${count - processed - skipped}`);
		}
	} catch (e: any) {
		console.error('[POLL ERROR]', e.message);
	}
}

// ── Start ──
async function main() {
	console.log('Withdrawal Processor starting...');
	console.log(`  Chain: ${chainId} | Router: ${TRADE_ROUTER}`);
	console.log(`  Admin: ${adminWallet.address}`);
	console.log(`  Backend: ${BACKEND_URL}`);
	console.log(`  Poll interval: ${pollInterval}ms`);
	console.log(`  Min gas: ${minGasBnb} BNB | Min FLW: ₦${minFlwNgn}`);

	await initRedis();

	// Initial poll
	await poll();

	// Recurring poll
	setInterval(poll, pollInterval);
}

main().catch((e) => {
	console.error('Fatal:', e);
	process.exit(1);
});
