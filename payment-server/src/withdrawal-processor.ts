/**
 * Withdrawal Processor Daemon — hybrid WS + polling
 *
 * Processes pending withdrawals: confirms on-chain + sends fiat via
 * the SvelteKit backend.
 *
 * Hot path (WS):
 *   WithdrawRequested event → immediate processing attempt.
 *   WithdrawCancelled event → remove from processing queue.
 *   All data needed (id, netAmount, expiresAt) comes from the event
 *   payload — zero follow-up RPC calls.
 *
 * Safety net (polling):
 *   Every POLL_INTERVAL, reads pendingCount + getPendingWithdrawals
 *   to catch anything the WS missed (reconnect gaps, etc.).
 *   Interval is stretched from 30s to 300s since WS handles the hot path.
 *
 * Caches alerts in Redis so admins aren't spammed for the same issue.
 *
 * Env:
 *   CHAIN_RPC          — BSC HTTP RPC URL
 *   CHAIN_WS_RPC       — BSC WebSocket RPC URL (optional, enables WS mode)
 *   CHAIN_ID           — chain ID (56 for BSC)
 *   TRADE_ROUTER       — TradeRouter contract address
 *   ADMIN_ADDRESS      — admin wallet address (for gas balance check)
 *   TX_CONFIRM_SECRET  — auth for the SvelteKit /api/withdrawals/process
 *   BACKEND_URL        — SvelteKit backend URL (e.g. https://tokenkrafter.com)
 *   FLUTTERWAVE_SECRET_KEY — for direct balance check
 *   REDIS_URL          — Redis connection (default redis://localhost:6379)
 *   MIN_GAS_BNB        — minimum admin BNB balance (default 0.005)
 *   MIN_FLW_NGN        — minimum Flutterwave NGN balance (default 1000)
 *   ALERT_WEBHOOK      — optional webhook URL for low-balance alerts
 *   POLL_INTERVAL_MS   — safety-net polling interval (default 300000 = 5 min)
 */

import { createClient, type RedisClientType } from 'redis';
import { ethers } from 'ethers';
// Uses globalThis.WebSocket (bun native), not the ws npm package

const {
	CHAIN_RPC = 'https://bsc-rpc.publicnode.com',
	CHAIN_WS_RPC = '',
	CHAIN_ID = '56',
	TRADE_ROUTER = '',
	ADMIN_ADDRESS = '',
	TX_CONFIRM_SECRET = '',
	SYNC_SECRET = '',
	BACKEND_URL = 'https://tokenkrafter.com',
	FLUTTERWAVE_SECRET_KEY = '',
	REDIS_URL = 'redis://localhost:6379',
	MIN_GAS_BNB = '0.005',
	MIN_FLW_NGN = '1000',
	ALERT_WEBHOOK = '',
	POLL_INTERVAL_MS = '300000',
	TELEGRAM_BOT_TOKEN = '',
	TELEGRAM_CHANNEL_ID = '',
} = Bun.env;

// TRADE_ROUTER + ADMIN_ADDRESS can come from env OR DB config (resolved at boot).
// Only fatal-exit if neither source provides them after resolveFromConfig().

if (!TX_CONFIRM_SECRET) { console.error('TX_CONFIRM_SECRET required'); process.exit(1); }
if (!SYNC_SECRET) { console.error('SYNC_SECRET required (vault auth for withdrawal processing)'); process.exit(1); }
if (!FLUTTERWAVE_SECRET_KEY) { console.error('FLUTTERWAVE_SECRET_KEY required'); process.exit(1); }

// ── Fetch private daemon_rpc from backend config (MEV-protected writes) ──
let resolvedRpc = CHAIN_RPC;
let resolvedWsRpc = CHAIN_WS_RPC;
let resolvedTradeRouter = TRADE_ROUTER;
let resolvedAdminAddress = ADMIN_ADDRESS;

async function resolveFromConfig() {
	try {
		const res = await fetch(`${BACKEND_URL}/api/config?keys=networks`, {
			headers: { Authorization: `Bearer ${TX_CONFIRM_SECRET}` },
		});
		if (!res.ok) return;
		const { networks } = await res.json();
		const net = (networks || []).find((n: any) => Number(n.chain_id) === parseInt(CHAIN_ID));
		if (!net) return;

		// Contract addresses from DB — single source of truth
		if (net.trade_router_address) {
			resolvedTradeRouter = net.trade_router_address;
			console.log(`  TradeRouter: ${resolvedTradeRouter}`);
		}

		// RPC from DB
		const dr = net.daemon_rpc as string || '';
		if (dr.startsWith('wss://') || dr.startsWith('ws://')) {
			resolvedWsRpc = dr;
			console.log(`  Using daemon WS RPC: ${dr.slice(0, 40)}…`);
		} else if (dr) {
			resolvedRpc = dr;
			console.log(`  Using daemon HTTP RPC: ${dr.slice(0, 40)}…`);
		}
	} catch (e: any) {
		console.warn(`  ⚠️ Config fetch failed, using env RPC: ${e.message?.slice(0, 60)}`);
	}
}

const chainId = parseInt(CHAIN_ID);
const pollInterval = parseInt(POLL_INTERVAL_MS);
const minGasBnb = parseFloat(MIN_GAS_BNB);
const minFlwNgn = parseFloat(MIN_FLW_NGN);
// adminAddress can come from env or DB; resolveFromConfig may override.
let adminAddress = ADMIN_ADDRESS;

// ── ABI ──
const ROUTER_ABI = [
	'event WithdrawRequested(uint256 indexed id, address indexed user, address token, uint256 grossAmount, uint256 fee, uint256 netAmount, bytes32 bankRef, address referrer, uint256 expiresAt)',
	'event WithdrawCancelled(uint256 indexed id, address indexed user, uint256 refundedAmount)',
	'function pendingCount() view returns (uint256)',
	'function pendingIds(uint256) view returns (uint256)',
	'function getPendingWithdrawals(uint256 offset, uint256 limit) view returns (tuple(address user, address token, uint256 grossAmount, uint256 fee, uint256 netAmount, uint256 createdAt, uint256 expiresAt, uint8 status, bytes32 bankRef, address referrer)[] result, uint256 total)',
];

// ── Provider (WS primary, HTTP fallback) ──
let httpProvider: ethers.JsonRpcProvider;
let wsProvider: ethers.WebSocketProvider | null = null;
let wsClosed = false;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function initHttp() {
	httpProvider = new ethers.JsonRpcProvider(resolvedRpc, chainId, { staticNetwork: true });
}

function connectWs() {
	if (wsClosed || !resolvedWsRpc) return;
	try {
		wsProvider = new ethers.WebSocketProvider(
			() => new WebSocket(resolvedWsRpc) as any,
			chainId,
			{ staticNetwork: true },
		);
		wsProvider.websocket.addEventListener('close', () => {
			if (wsClosed) return;
			console.warn('[WS] dropped — reconnecting in 3s');
			wsProvider = null;
			scheduleWsReconnect();
		});
		wsProvider.websocket.addEventListener('error', (evt: any) => {
			console.warn(`[WS] error: ${(evt?.message || evt?.error?.message || 'unknown').toString().slice(0, 60)}`);
		});
		console.log(`[WS] connected: ${resolvedWsRpc?.slice(0, 40)}…`);
		subscribeEvents();
	} catch (e: any) {
		console.warn(`[WS] connect failed: ${e.message?.slice(0, 80)} — using HTTP only`);
		wsProvider = null;
		scheduleWsReconnect();
	}
}

function scheduleWsReconnect() {
	if (wsClosed || wsReconnectTimer) return;
	wsReconnectTimer = setTimeout(() => {
		wsReconnectTimer = null;
		connectWs();
	}, 3000);
}

function getProvider(): ethers.Provider {
	return wsProvider ?? httpProvider;
}

// ── Redis ──
let redis: RedisClientType;

async function initRedis() {
	redis = createClient({ url: REDIS_URL });
	redis.on('error', (err) => console.error('Redis error:', err.message));
	await redis.connect();
	console.log('[Redis] connected');
}

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
async function sendAlert(subject: string, message: string, type: string = 'system'): Promise<void> {
	console.warn(`[ALERT] ${subject}: ${message}`);

	// Route through /api/alert — centralized fanout to Telegram, email, etc.
	// This avoids direct Telegram calls from the VPS (which may be blocked).
	try {
		await fetch(`${BACKEND_URL}/api/alert`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${TX_CONFIRM_SECRET}`,
			},
			body: JSON.stringify({ type, title: subject, message }),
		});
	} catch (e: any) {
		console.error('Alert API failed:', e.message?.slice(0, 80));
	}
}

// ── Balance checks ──
async function getAdminBnbBalance(): Promise<number> {
	const bal = await getProvider().getBalance(adminAddress);
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

// ── Pre-flight checks (shared by WS handler + poll) ──
async function checkBalances(): Promise<{ bnbOk: boolean; flwBal: number }> {
	const bnbBal = await getAdminBnbBalance();
	if (bnbBal < minGasBnb) {
		const alertKey = `alert:low_gas:${adminAddress}`;
		if (!(await hasAlerted(alertKey))) {
			await sendAlert(
				'Low Admin Gas Balance',
				`Admin wallet ${adminAddress} has ${bnbBal.toFixed(6)} BNB (min: ${minGasBnb} BNB). On-chain confirms will fail.`,
			);
			await markAlerted(alertKey);
		}
		return { bnbOk: false, flwBal: 0 };
	}
	const flwBal = await getFlutterwaveBalance();
	return { bnbOk: true, flwBal };
}

// ── Process a single withdrawal ──
async function processWithdrawal(withdrawId: number): Promise<boolean> {
	const key = `processing:${chainId}:${withdrawId}`;

	if (await redis.exists(key)) {
		return false;
	}

	await redis.set(key, Date.now().toString(), { EX: 300 });

	try {
		const res = await fetch(`${BACKEND_URL}/api/withdrawals/process`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${SYNC_SECRET}`,
			},
			body: JSON.stringify({
				withdraw_id: withdrawId,
				chain_id: chainId,
			}),
		});

		let data: any;
		try {
			data = await res.json();
		} catch {
			// SvelteKit error() returns non-JSON (HTML error page)
			const text = await res.text().catch(() => '');
			console.error(`[FAIL] Withdrawal #${withdrawId}: HTTP ${res.status} — ${text.slice(0, 200)}`);
			await redis.del(key);
			return false;
		}

		if (data.success) {
			console.log(`[OK] Withdrawal #${withdrawId} processed: NGN ${data.ngn_amount}, tx: ${data.confirm_tx}`);
			await sendAlert('Payment Processed', [
				`✅ Withdrawal #${withdrawId}`,
				`💰 $${data.usdt_amount || '?'} → NGN ${Number(data.ngn_amount || 0).toLocaleString()}`,
				`🏦 ${data.bank_name || '?'} — ${data.account_name || '?'}`,
				data.confirm_tx ? `🔗 tx: ${data.confirm_tx}` : '',
			].filter(Boolean).join('\n'), 'payment');
			await clearAlert(`alert:low_flw:${withdrawId}`);
			await redis.del(key);
			return true;
		} else {
			const errMsg = data.error || data.message || JSON.stringify(data).slice(0, 200);
			console.error(`[FAIL] Withdrawal #${withdrawId}: ${errMsg}`);

			// Alert on all failures, not just low balance
			await sendAlert('Withdrawal Failed', `❌ #${withdrawId}: ${errMsg}`, 'payment');

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

// ── Process with balance + expiry checks ──
async function tryProcess(id: number, netAmount: bigint, expiresAt: number, flwBal: number): Promise<{ ok: boolean; flwSpent: number }> {
	const now = Math.floor(Date.now() / 1000);
	if (expiresAt > 0 && now >= expiresAt) {
		return { ok: false, flwSpent: 0 };
	}

	const estNgn = parseFloat(ethers.formatUnits(netAmount, 18)) * 1600;
	if (flwBal < estNgn + 50) {
		const alertKey = `alert:low_flw:${id}`;
		if (!(await hasAlerted(alertKey))) {
			await sendAlert('Low Flutterwave Balance', `Cannot process withdrawal #${id}: need ~₦${Math.ceil(estNgn).toLocaleString()}, have ₦${Math.floor(flwBal).toLocaleString()}`);
			await markAlerted(alertKey);
		}
		return { ok: false, flwSpent: 0 };
	}

	const ok = await processWithdrawal(id);
	return { ok, flwSpent: ok ? estNgn : 0 };
}

// ── WS event handlers ──
const cancelledIds = new Set<number>();

function subscribeEvents() {
	if (!wsProvider) return;

	const iface = new ethers.Interface(ROUTER_ABI);

	const requestedFilter = {
		address: resolvedTradeRouter,
		topics: [ethers.id('WithdrawRequested(uint256,address,address,uint256,uint256,uint256,bytes32,address,uint256)')],
	};
	const cancelledFilter = {
		address: resolvedTradeRouter,
		topics: [ethers.id('WithdrawCancelled(uint256,address,uint256)')],
	};

	wsProvider.on(requestedFilter, async (log: ethers.Log) => {
		try {
			const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
			if (!parsed || parsed.name !== 'WithdrawRequested') return;

			const id = Number(parsed.args.id);
			const netAmount = parsed.args.netAmount as bigint;
			const expiresAt = Number(parsed.args.expiresAt);

			console.log(`[WS] WithdrawRequested #${id} — ${ethers.formatUnits(netAmount, 18)} USDT`);

			const { bnbOk, flwBal } = await checkBalances();
			if (!bnbOk) {
				console.warn(`[WS] skipping #${id} — admin gas low`);
				return;
			}

			const { ok } = await tryProcess(id, netAmount, expiresAt, flwBal);
			if (ok) console.log(`[WS] #${id} processed instantly`);
		} catch (e: any) {
			console.error(`[WS] WithdrawRequested handler: ${e.message?.slice(0, 80)}`);
		}
	});

	wsProvider.on(cancelledFilter, (log: ethers.Log) => {
		try {
			const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
			if (!parsed || parsed.name !== 'WithdrawCancelled') return;

			const id = Number(parsed.args.id);
			cancelledIds.add(id);
			// Clear the entire set periodically — the poll loop catches
			// cancellations via on-chain status anyway, this is just a
			// fast-path skip for the current poll cycle.
			if (cancelledIds.size > 500) cancelledIds.clear();
			console.log(`[WS] WithdrawCancelled #${id} — skipping in future polls`);
		} catch {}
	});

	console.log(`[WS] subscribed to WithdrawRequested + WithdrawCancelled on ${resolvedTradeRouter.slice(0, 10)}…`);
}

// ── Safety-net polling loop ──
async function poll() {
	try {
		const { bnbOk, flwBal } = await checkBalances();
		if (!bnbOk) {
			console.log('[POLL] skipped — admin BNB too low');
			return;
		}

		const router = new ethers.Contract(resolvedTradeRouter, ROUTER_ABI, getProvider());
		const { result: pending, total } = await router.getPendingWithdrawals(0, 200);
		const count = Number(total);
		if (count === 0) {
			console.log('[POLL] 0 pending');
			return;
		}

		// Resolve IDs (getPendingWithdrawals returns structs, need pendingIds for the actual ID)
		const ids = await Promise.all(
			Array.from({ length: count }, (_, i) => router.pendingIds(i).then(Number))
		);

		console.log(`[POLL] ${count} pending withdrawal(s)`);

		let processed = 0;
		let skipped = 0;
		let runningFlw = flwBal;

		for (let i = 0; i < count; i++) {
			const id = ids[i];
			const w = pending[i];

			// Skip if WS already told us this was cancelled
			if (cancelledIds.has(id)) {
				skipped++;
				continue;
			}

			const netAmount = w.netAmount as bigint;
			const expiresAt = Number(w.expiresAt);

			const { ok, flwSpent } = await tryProcess(id, netAmount, expiresAt, runningFlw);
			if (ok) {
				processed++;
				runningFlw -= flwSpent;
			} else {
				skipped++;
			}

			if (count > 1) await Bun.sleep(2000);
		}

		if (processed > 0 || skipped > 0) {
			console.log(`[POLL] Processed: ${processed}, Skipped: ${skipped}, Remaining: ${count - processed - skipped}`);
		}
	} catch (e: any) {
		console.error('[POLL ERROR]', e.message);
	}
}

// ── Start ──
async function main() {
	console.log('Withdrawal Processor starting...');
	console.log(`  Chain: ${chainId} | Router: ${resolvedTradeRouter}`);
	console.log(`  Admin: ${adminAddress}`);
	console.log(`  Backend: ${BACKEND_URL}`);

	// Fetch daemon_rpc + contract addresses from DB config
	await resolveFromConfig();

	if (!resolvedTradeRouter) { console.error('TRADE_ROUTER not set (env or DB)'); process.exit(1); }

	console.log(`  RPC: ${resolvedRpc}${resolvedWsRpc ? ` (ws: ${resolvedWsRpc.slice(0, 40)}…)` : ''}`);
	console.log(`  Poll interval: ${pollInterval / 1000}s`);
	console.log(`  Min gas: ${minGasBnb} BNB | Min FLW: ₦${minFlwNgn}`);

	initHttp();
	await initRedis();

	if (resolvedWsRpc) {
		connectWs();
	}

	// Initial poll to catch anything already pending
	await poll();

	// Safety-net recurring poll
	setInterval(poll, pollInterval);
}

main().catch((e) => {
	console.error('Fatal:', e);
	process.exit(1);
});
