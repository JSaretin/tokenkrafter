/**
 * Withdrawal Processor Daemon — multi-chain, hybrid WS + polling
 *
 * Loads every enabled network from /api/config?keys=networks at boot
 * and spawns a per-chain context (provider, WS subscription, poll
 * loop). Adding a chain in the DB picks it up on next restart.
 *
 * Hot path (WS, per chain):
 *   WithdrawRequested event → immediate processing attempt.
 *   WithdrawCancelled event → remove from processing queue.
 *
 * Safety net (polling, per chain):
 *   Every POLL_INTERVAL_MS, reads pending list to catch anything WS
 *   missed (reconnect gaps, etc.).
 *
 * Caches alerts in Redis so admins aren't spammed for the same issue.
 *
 * Env:
 *   API_BASE_URL          — SvelteKit backend (default https://tokenkrafter.com)
 *   TX_CONFIRM_SECRET     — auth for /api/config + /api/alert
 *   SYNC_SECRET           — vault auth for /api/withdrawals/process
 *   ADMIN_ADDRESS         — admin wallet (gas-balance check + USDT confirm-to)
 *   FLUTTERWAVE_SECRET_KEY — for direct NGN balance check
 *   REDIS_URL             — (default redis://localhost:6379)
 *   MIN_GAS_NATIVE        — minimum native-coin balance per chain (default 0.005)
 *   MIN_FLW_NGN           — minimum Flutterwave NGN balance (default 1000)
 *   POLL_INTERVAL_MS      — safety-net interval (default 300000)
 */

import { createClient, type RedisClientType } from 'redis';
import { ethers } from 'ethers';
import { loadNetworks, pickDaemonRpc, type Network } from './lib/chains';

const {
	API_BASE_URL = 'https://tokenkrafter.com',
	TX_CONFIRM_SECRET = '',
	SYNC_SECRET = '',
	ADMIN_ADDRESS = '',
	FLUTTERWAVE_SECRET_KEY = '',
	REDIS_URL = 'redis://localhost:6379',
	MIN_GAS_NATIVE = '0.005',
	MIN_FLW_NGN = '1000',
	POLL_INTERVAL_MS = '300000',
} = Bun.env;

if (!TX_CONFIRM_SECRET) { console.error('TX_CONFIRM_SECRET required'); process.exit(1); }
if (!SYNC_SECRET) { console.error('SYNC_SECRET required (vault auth for withdrawal processing)'); process.exit(1); }
if (!FLUTTERWAVE_SECRET_KEY) { console.error('FLUTTERWAVE_SECRET_KEY required'); process.exit(1); }
if (!ADMIN_ADDRESS) { console.error('ADMIN_ADDRESS required'); process.exit(1); }

const adminAddress = ADMIN_ADDRESS;
const pollInterval = parseInt(POLL_INTERVAL_MS);
const minGasNative = parseFloat(MIN_GAS_NATIVE);
const minFlwNgn = parseFloat(MIN_FLW_NGN);

// ── ABI ──
const ROUTER_ABI = [
	'event WithdrawRequested(uint256 indexed id, address indexed user, address token, uint256 grossAmount, uint256 fee, uint256 netAmount, bytes32 bankRef, address referrer, uint256 expiresAt)',
	'event WithdrawCancelled(uint256 indexed id, address indexed user, uint256 refundedAmount)',
	'function pendingCount() view returns (uint256)',
	'function pendingIds(uint256) view returns (uint256)',
	'function getPendingWithdrawals(uint256 offset, uint256 limit) view returns (tuple(address user, address token, uint256 grossAmount, uint256 fee, uint256 netAmount, uint256 createdAt, uint256 expiresAt, uint8 status, bytes32 bankRef, address referrer)[] result, uint256 total)',
];

// ── Redis ──
let redis: RedisClientType;
const ALERT_TTL = 86400;

async function initRedis() {
	redis = createClient({ url: REDIS_URL });
	redis.on('error', (err) => console.error('Redis error:', err.message));
	await redis.connect();
	console.log('[Redis] connected');
}

async function hasAlerted(key: string): Promise<boolean> { return (await redis.exists(key)) === 1; }
async function markAlerted(key: string): Promise<void> { await redis.set(key, '1', { EX: ALERT_TTL }); }
async function clearAlert(key: string): Promise<void> { await redis.del(key); }

// ── Alerts ──
async function sendAlert(subject: string, message: string, type: string = 'system'): Promise<void> {
	console.warn(`[ALERT] ${subject}: ${message}`);
	try {
		await fetch(`${API_BASE_URL}/api/alert`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TX_CONFIRM_SECRET}` },
			body: JSON.stringify({ type, title: subject, message }),
		});
	} catch (e: any) {
		console.error('Alert API failed:', e.message?.slice(0, 80));
	}
}

// ── FLW balance (chain-agnostic — fetched once per poll cycle) ──
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

// ── Per-chain context ──
type ChainCtx = {
	chainId: number;
	name: string;
	tradeRouter: string;
	httpProvider: ethers.JsonRpcProvider;
	wsProvider: ethers.WebSocketProvider | null;
	wsRpc: string;
	wsClosed: boolean;
	wsReconnectTimer: ReturnType<typeof setTimeout> | null;
	cancelledIds: Set<number>;
};

const chains = new Map<number, ChainCtx>();

function ctxProvider(c: ChainCtx): ethers.Provider {
	return c.wsProvider ?? c.httpProvider;
}

async function getNativeBalance(c: ChainCtx): Promise<number> {
	const bal = await ctxProvider(c).getBalance(adminAddress);
	return parseFloat(ethers.formatEther(bal));
}

// Pre-flight per chain. flwBal is shared — pass it in once per poll cycle.
async function checkChainGas(c: ChainCtx): Promise<boolean> {
	const bal = await getNativeBalance(c);
	if (bal < minGasNative) {
		const alertKey = `alert:low_gas:${c.chainId}:${adminAddress}`;
		if (!(await hasAlerted(alertKey))) {
			await sendAlert(
				'Low Admin Gas Balance',
				`[chain ${c.chainId} / ${c.name}] admin ${adminAddress} has ${bal.toFixed(6)} (min: ${minGasNative}). On-chain confirms will fail.`,
			);
			await markAlerted(alertKey);
		}
		return false;
	}
	return true;
}

// ── Process a single withdrawal on a given chain ──
async function processWithdrawal(c: ChainCtx, withdrawId: number): Promise<boolean> {
	const key = `processing:${c.chainId}:${withdrawId}`;
	if (await redis.exists(key)) return false;
	await redis.set(key, Date.now().toString(), { EX: 300 });

	try {
		// Confirm with `to = TradeRouter address` so the released USDT
		// stays in the contract (self-transfer is a no-op net move) and
		// remains as on-ramp reserve. Previously we routed to the admin
		// wallet, which forced a manual top-up cycle every time on-ramp
		// volume drained the reserve. Keeping it in-contract closes the
		// off-ramp ↔ on-ramp loop with no admin intervention.
		const res = await fetch(`${API_BASE_URL}/api/withdrawals/process`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SYNC_SECRET}` },
			body: JSON.stringify({
				withdraw_id: withdrawId,
				chain_id: c.chainId,
				confirm_to: c.tradeRouter,
			}),
		});

		let data: any;
		try { data = await res.json(); }
		catch {
			const text = await res.text().catch(() => '');
			console.error(`[FAIL] [c${c.chainId}] #${withdrawId}: HTTP ${res.status} — ${text.slice(0, 200)}`);
			await redis.del(key);
			return false;
		}

		if (data.success) {
			console.log(`[OK] [c${c.chainId}] #${withdrawId} processed: NGN ${data.ngn_amount}, tx: ${data.confirm_tx}`);
			await sendAlert('Payment Processed', [
				`✅ [c${c.chainId}] Withdrawal #${withdrawId}`,
				`💰 $${data.usdt_amount || '?'} → NGN ${Number(data.ngn_amount || 0).toLocaleString()}`,
				`🏦 ${data.bank_name || '?'} — ${data.account_name || '?'}`,
				data.confirm_tx ? `🔗 tx: ${data.confirm_tx}` : '',
			].filter(Boolean).join('\n'), 'payment');
			await clearAlert(`alert:low_flw:${c.chainId}:${withdrawId}`);
			await redis.del(key);
			return true;
		}

		const errMsg = data.error || data.message || JSON.stringify(data).slice(0, 200);
		console.error(`[FAIL] [c${c.chainId}] #${withdrawId}: ${errMsg}`);
		await sendAlert('Withdrawal Failed', `❌ [c${c.chainId}] #${withdrawId}: ${errMsg}`, 'payment');

		if (data.error?.includes('Insufficient Flutterwave')) {
			const alertKey = `alert:low_flw:${c.chainId}:${withdrawId}`;
			if (!(await hasAlerted(alertKey))) {
				await sendAlert('Low Flutterwave Balance', `[c${c.chainId}] Cannot process #${withdrawId}: ${data.error}`);
				await markAlerted(alertKey);
			}
		}

		await redis.del(key);
		return false;
	} catch (e: any) {
		console.error(`[ERROR] [c${c.chainId}] #${withdrawId}:`, e.message);
		await redis.del(key);
		return false;
	}
}

async function tryProcess(c: ChainCtx, id: number, netAmount: bigint, expiresAt: number, flwBal: number): Promise<{ ok: boolean; flwSpent: number }> {
	const now = Math.floor(Date.now() / 1000);
	if (expiresAt > 0 && now >= expiresAt) return { ok: false, flwSpent: 0 };

	const estNgn = parseFloat(ethers.formatUnits(netAmount, 18)) * 1600;
	if (flwBal < estNgn + 50) {
		const alertKey = `alert:low_flw:${c.chainId}:${id}`;
		if (!(await hasAlerted(alertKey))) {
			await sendAlert('Low Flutterwave Balance', `[c${c.chainId}] Cannot process #${id}: need ~₦${Math.ceil(estNgn).toLocaleString()}, have ₦${Math.floor(flwBal).toLocaleString()}`);
			await markAlerted(alertKey);
		}
		return { ok: false, flwSpent: 0 };
	}

	const ok = await processWithdrawal(c, id);
	return { ok, flwSpent: ok ? estNgn : 0 };
}

// ── WS subscription per chain ──
function connectChainWs(c: ChainCtx) {
	if (c.wsClosed || !c.wsRpc) return;
	try {
		c.wsProvider = new ethers.WebSocketProvider(
			() => new WebSocket(c.wsRpc) as any,
			c.chainId,
			{ staticNetwork: true },
		);
		c.wsProvider.websocket.addEventListener('close', () => {
			if (c.wsClosed) return;
			console.warn(`[WS c${c.chainId}] dropped — reconnecting in 3s`);
			c.wsProvider = null;
			scheduleChainWsReconnect(c);
		});
		c.wsProvider.websocket.addEventListener('error', (evt: any) => {
			console.warn(`[WS c${c.chainId}] error: ${(evt?.message || evt?.error?.message || 'unknown').toString().slice(0, 60)}`);
		});
		console.log(`[WS c${c.chainId}] connected: ${c.wsRpc.slice(0, 40)}…`);
		subscribeChainEvents(c);
	} catch (e: any) {
		console.warn(`[WS c${c.chainId}] connect failed: ${e.message?.slice(0, 80)} — using HTTP only`);
		c.wsProvider = null;
		scheduleChainWsReconnect(c);
	}
}

function scheduleChainWsReconnect(c: ChainCtx) {
	if (c.wsClosed || c.wsReconnectTimer) return;
	c.wsReconnectTimer = setTimeout(() => {
		c.wsReconnectTimer = null;
		connectChainWs(c);
	}, 3000);
}

function subscribeChainEvents(c: ChainCtx) {
	if (!c.wsProvider) return;
	const iface = new ethers.Interface(ROUTER_ABI);

	const requestedFilter = {
		address: c.tradeRouter,
		topics: [ethers.id('WithdrawRequested(uint256,address,address,uint256,uint256,uint256,bytes32,address,uint256)')],
	};
	const cancelledFilter = {
		address: c.tradeRouter,
		topics: [ethers.id('WithdrawCancelled(uint256,address,uint256)')],
	};

	c.wsProvider.on(requestedFilter, async (log: ethers.Log) => {
		try {
			const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
			if (!parsed || parsed.name !== 'WithdrawRequested') return;

			const id = Number(parsed.args.id);
			const netAmount = parsed.args.netAmount as bigint;
			const expiresAt = Number(parsed.args.expiresAt);

			console.log(`[WS c${c.chainId}] WithdrawRequested #${id} — ${ethers.formatUnits(netAmount, 18)} USDT`);

			const gasOk = await checkChainGas(c);
			if (!gasOk) {
				console.warn(`[WS c${c.chainId}] skipping #${id} — admin gas low`);
				return;
			}
			const flwBal = await getFlutterwaveBalance();
			const { ok } = await tryProcess(c, id, netAmount, expiresAt, flwBal);
			if (ok) console.log(`[WS c${c.chainId}] #${id} processed instantly`);
		} catch (e: any) {
			console.error(`[WS c${c.chainId}] WithdrawRequested handler: ${e.message?.slice(0, 80)}`);
		}
	});

	c.wsProvider.on(cancelledFilter, (log: ethers.Log) => {
		try {
			const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
			if (!parsed || parsed.name !== 'WithdrawCancelled') return;
			const id = Number(parsed.args.id);
			c.cancelledIds.add(id);
			if (c.cancelledIds.size > 500) c.cancelledIds.clear();
			console.log(`[WS c${c.chainId}] WithdrawCancelled #${id} — skipping in future polls`);
		} catch {}
	});

	console.log(`[WS c${c.chainId}] subscribed to WithdrawRequested + WithdrawCancelled on ${c.tradeRouter.slice(0, 10)}…`);
}

// ── Per-chain poll ──
async function pollChain(c: ChainCtx, flwBal: number) {
	try {
		const router = new ethers.Contract(c.tradeRouter, ROUTER_ABI, ctxProvider(c));
		const { result: pending, total } = await router.getPendingWithdrawals(0, 200);
		const count = Number(total);
		if (count === 0) {
			console.log(`[POLL c${c.chainId}] 0 pending`);
			return flwBal;
		}

		const ids = await Promise.all(
			Array.from({ length: count }, (_, i) => router.pendingIds(i).then(Number))
		);
		console.log(`[POLL c${c.chainId}] ${count} pending withdrawal(s)`);

		let processed = 0;
		let skipped = 0;
		let runningFlw = flwBal;

		for (let i = 0; i < count; i++) {
			const id = ids[i];
			const w = pending[i];

			if (c.cancelledIds.has(id)) { skipped++; continue; }

			const netAmount = w.netAmount as bigint;
			const expiresAt = Number(w.expiresAt);
			const { ok, flwSpent } = await tryProcess(c, id, netAmount, expiresAt, runningFlw);
			if (ok) { processed++; runningFlw -= flwSpent; }
			else { skipped++; }
			if (count > 1) await Bun.sleep(2000);
		}

		if (processed > 0 || skipped > 0) {
			console.log(`[POLL c${c.chainId}] Processed: ${processed}, Skipped: ${skipped}, Remaining: ${count - processed - skipped}`);
		}
		return runningFlw;
	} catch (e: any) {
		console.error(`[POLL c${c.chainId}] error:`, e.message);
		return flwBal;
	}
}

async function pollAllChains() {
	if (chains.size === 0) return;
	let flwBal = await getFlutterwaveBalance();

	for (const c of chains.values()) {
		const gasOk = await checkChainGas(c);
		if (!gasOk) {
			console.log(`[POLL c${c.chainId}] skipped — admin native balance too low`);
			continue;
		}
		flwBal = await pollChain(c, flwBal);
	}
}

// ── Boot ──
function buildChainCtx(net: Network): ChainCtx | null {
	const { http, ws } = pickDaemonRpc(net);
	if (!http) {
		console.warn(`[boot] chain ${net.chain_id}: no http rpc, skipping`);
		return null;
	}
	if (!net.trade_router_address) {
		console.warn(`[boot] chain ${net.chain_id}: no trade_router_address, skipping`);
		return null;
	}
	const httpProvider = new ethers.JsonRpcProvider(http, net.chain_id, { staticNetwork: true });
	return {
		chainId: net.chain_id,
		name: (net.name as string) || `chain-${net.chain_id}`,
		tradeRouter: net.trade_router_address,
		httpProvider,
		wsProvider: null,
		wsRpc: ws,
		wsClosed: false,
		wsReconnectTimer: null,
		cancelledIds: new Set<number>(),
	};
}

async function main() {
	console.log('Withdrawal Processor (multi-chain) starting...');
	console.log(`  Backend: ${API_BASE_URL}`);
	console.log(`  Admin: ${adminAddress}`);
	console.log(`  Min gas (native): ${minGasNative}`);
	console.log(`  Min FLW: ₦${minFlwNgn}`);
	console.log(`  Poll interval: ${pollInterval / 1000}s`);

	await initRedis();

	let networks: Network[];
	try {
		networks = await loadNetworks(API_BASE_URL, `Bearer ${TX_CONFIRM_SECRET}`);
	} catch (e: any) {
		console.error(`Failed to load networks: ${e.message}`);
		process.exit(1);
	}

	if (networks.length === 0) {
		console.error('No enabled networks in /api/config — nothing to do');
		process.exit(1);
	}

	console.log(`  Loaded ${networks.length} network(s): ${networks.map((n) => `${n.chain_id}/${n.name}`).join(', ')}`);

	for (const net of networks) {
		const c = buildChainCtx(net);
		if (!c) continue;
		chains.set(c.chainId, c);
		console.log(`  [c${c.chainId}] router ${c.tradeRouter} | ws=${c.wsRpc ? 'yes' : 'no'}`);
		if (c.wsRpc) connectChainWs(c);
	}

	if (chains.size === 0) {
		console.error('No usable chain contexts — every network was missing rpc/router_address');
		process.exit(1);
	}

	// Initial poll to catch anything already pending across all chains.
	await pollAllChains();

	// Safety-net recurring poll across all chains.
	setInterval(pollAllChains, pollInterval);
}

main().catch((e) => {
	console.error('Fatal:', e);
	process.exit(1);
});
