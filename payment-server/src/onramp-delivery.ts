/**
 * On-ramp Delivery Daemon
 *
 * Mirror of withdrawal-processor.ts for the inverse direction:
 *   FLW webhook flips onramp_intents.status → 'payment_received'
 *   ↓
 *   This daemon polls /api/onramp/pending-deliveries every POLL_INTERVAL
 *   ↓
 *   For each row → POST /api/onramp/deliver { reference }
 *   ↓
 *   Backend signs IERC20(USDT).transfer using ADMIN_KEY and updates DB
 *
 * Why a daemon and not the webhook handler:
 *   - FLW webhook has a 60s timeout; on-chain confirms can blow past it.
 *   - Daemon retries naturally via the next poll cycle if anything fails.
 *   - Idempotency lives in the backend's CAS-lock on status='delivering'.
 *
 * Env (lives in .envs/onramp-delivery.env on the VPS):
 *   BACKEND_URL          — SvelteKit backend (e.g. https://tokenkrafter.com)
 *   SYNC_SECRET          — vault auth token shared with backend
 *   POLL_INTERVAL_MS     — default 30000 (30s)
 *   REDIS_URL            — for in-flight dedup locks (default redis://localhost:6379)
 */

import { createClient, type RedisClientType } from 'redis';

const {
	BACKEND_URL = 'https://tokenkrafter.com',
	SYNC_SECRET = '',
	POLL_INTERVAL_MS = '30000',
	REDIS_URL = 'redis://localhost:6379',
} = Bun.env;

if (!SYNC_SECRET) {
	console.error('SYNC_SECRET required (vault auth for /api/onramp/deliver)');
	process.exit(1);
}

const pollInterval = parseInt(POLL_INTERVAL_MS);

interface PendingDelivery {
	reference: string;
	chain_id: number;
	ngn_amount_kobo: number;
	usdt_amount_wei: string;
	receiver: string;
	paid_at: string | null;
}

// ── Redis (dedup locks) ──
let redis: RedisClientType;

async function initRedis() {
	redis = createClient({ url: REDIS_URL });
	redis.on('error', (err) => console.error('Redis error:', err.message));
	await redis.connect();
	console.log('[Redis] connected');
}

async function tryAcquireLock(reference: string): Promise<boolean> {
	// 5-minute TTL — long enough to cover a slow on-chain confirm but
	// short enough to release if this process dies mid-flight.
	const set = await redis.set(`onramp:processing:${reference}`, '1', {
		EX: 300,
		NX: true,
	});
	return set === 'OK';
}

async function releaseLock(reference: string) {
	await redis.del(`onramp:processing:${reference}`);
}

// ── Backend RPCs ──
async function fetchPending(): Promise<PendingDelivery[]> {
	const res = await fetch(`${BACKEND_URL}/api/onramp/pending-deliveries`, {
		headers: { Authorization: `Bearer ${SYNC_SECRET}` },
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`pending list ${res.status}: ${text.slice(0, 200)}`);
	}
	return await res.json();
}

interface DeliverResponse {
	success: boolean;
	skipped?: boolean;
	reason?: string;
	error?: string;
	detail?: {
		treasury_have_wei?: string;
		required_wei?: string;
		shortfall_wei?: string;
	};
	delivery_tx_hash?: string;
}

function fmtUsdtWei(wei: string | undefined): string {
	if (!wei) return '?';
	try {
		return (Number((BigInt(wei) * 10000n) / 10n ** 18n) / 10000).toFixed(4);
	} catch {
		return '?';
	}
}

async function deliverOne(reference: string): Promise<DeliverResponse> {
	const res = await fetch(`${BACKEND_URL}/api/onramp/deliver`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${SYNC_SECRET}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ reference }),
	});
	const data = await res.json().catch(async () => ({
		success: false,
		error: `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`,
	}));
	return data as DeliverResponse;
}

async function sendAlert(subject: string, message: string): Promise<void> {
	console.warn(`[ALERT] ${subject}: ${message}`);
	try {
		await fetch(`${BACKEND_URL}/api/alert`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${SYNC_SECRET}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ type: 'onramp', title: subject, message }),
		});
	} catch (e: any) {
		console.error('Alert API failed:', e.message?.slice(0, 80));
	}
}

// ── Main poll loop ──
async function processOne(p: PendingDelivery): Promise<'delivered' | 'skipped' | 'failed'> {
	const got = await tryAcquireLock(p.reference);
	if (!got) {
		console.log(`[POLL] ${p.reference}: already locked, skipping`);
		return 'skipped';
	}

	try {
		const usdt = Number((BigInt(p.usdt_amount_wei) * 10000n) / 10n ** 18n) / 10000;
		const ngn = (p.ngn_amount_kobo / 100).toLocaleString();
		console.log(`[DELIVER] ${p.reference} — ₦${ngn} → ${usdt} USDT → ${p.receiver}`);

		const res = await deliverOne(p.reference);
		if (res.success) {
			console.log(`[OK] ${p.reference} delivered: tx=${res.delivery_tx_hash}`);
			await sendAlert(
				'On-ramp delivered',
				`✅ ${p.reference}\n💰 ₦${ngn} → ${usdt} USDT\n👤 ${p.receiver}\n🔗 ${res.delivery_tx_hash ?? '?'}`,
			);
			return 'delivered';
		}
		if (res.skipped) {
			console.log(`[SKIP] ${p.reference}: ${res.reason}`);
			return 'skipped';
		}
		const err = res.error ?? 'unknown';
		console.error(`[FAIL] ${p.reference}: ${err}`);
		// Treasury-shortfall alerts get explicit numbers so the operator
		// knows exactly how much USDT to top up.
		if (err === 'Treasury insufficient' && res.detail) {
			const have = fmtUsdtWei(res.detail.treasury_have_wei);
			const need = fmtUsdtWei(res.detail.required_wei);
			const short = fmtUsdtWei(res.detail.shortfall_wei);
			await sendAlert(
				'On-ramp treasury low',
				`💸 ${p.reference} stuck — top up admin wallet\n• Need: ${need} USDT\n• Have: ${have} USDT\n• Short: ${short} USDT\nWill auto-retry on next poll once funded.`,
			);
		} else {
			await sendAlert('On-ramp delivery failed', `❌ ${p.reference}: ${err}`);
		}
		return 'failed';
	} catch (e: any) {
		console.error(`[ERROR] ${p.reference}:`, e.message?.slice(0, 200));
		return 'failed';
	} finally {
		await releaseLock(p.reference);
	}
}

async function poll() {
	let pending: PendingDelivery[];
	try {
		pending = await fetchPending();
	} catch (e: any) {
		console.error('[POLL ERROR]', e.message?.slice(0, 200));
		return;
	}

	if (pending.length === 0) {
		console.log('[POLL] 0 pending');
		return;
	}

	console.log(`[POLL] ${pending.length} pending delivery(ies)`);
	let delivered = 0;
	let skipped = 0;
	let failed = 0;

	for (const p of pending) {
		const r = await processOne(p);
		if (r === 'delivered') delivered++;
		else if (r === 'skipped') skipped++;
		else failed++;
		// Brief pause between deliveries to avoid hammering the RPC.
		if (pending.length > 1) await Bun.sleep(1000);
	}

	console.log(`[POLL] Delivered: ${delivered}, Skipped: ${skipped}, Failed: ${failed}`);
}

async function main() {
	console.log('On-ramp Delivery Daemon starting...');
	console.log(`  Backend: ${BACKEND_URL}`);
	console.log(`  Poll interval: ${pollInterval / 1000}s`);

	await initRedis();
	await poll();
	setInterval(poll, pollInterval);
}

main().catch((e) => {
	console.error('Fatal:', e);
	process.exit(1);
});
