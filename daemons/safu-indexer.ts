/**
 * SAFU Indexer Daemon (standalone — no hardhat, no solc)
 *
 * Periodically sweeps ALL platform tokens via SafuLens eth_call and
 * writes badge data (is_safu, has_liquidity, lp_burned, etc.) to the
 * DB. The explore page reads these columns for instant SQL filtering
 * and sorting — no client-side RPC needed for the list view.
 *
 * Separate from the ws-indexer because the sweep is O(N) over
 * all tokens and can take minutes at scale. The main indexer stays fast
 * for real-time event capture (token creations, buys, withdrawals).
 *
 * Usage:
 *   bun scripts/daemon/safu-indexer.ts
 *
 * Environment:
 *   RPC_URL          — BSC RPC (default: https://bsc-dataseed.binance.org/)
 *   CHAIN_ID         — Chain ID (default: 56)
 *   API_BASE_URL     — Backend URL (e.g. https://tokenkrafter.com)
 *   SYNC_SECRET      — Auth token for backend API
 *   SWEEP_INTERVAL   — Seconds between full sweeps (default: 300 = 5 min)
 *   BATCH_SIZE       — Tokens per SafuLens eth_call (default: 100)
 *   SAFU_BYTECODE    — Path to SafuLens bytecode JSON (optional, embedded default)
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { createManagedProvider } from './lib/provider';

// ── Config ─────────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL || 'https://bsc-dataseed.binance.org/';
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '56');
const SWEEP_INTERVAL = parseInt(process.env.SWEEP_INTERVAL || '300') * 1000;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100');
const API_BASE = process.env.API_BASE_URL || 'http://localhost:5173';
const SYNC_SECRET = process.env.SYNC_SECRET || '';

if (!SYNC_SECRET) console.warn('⚠️  No SYNC_SECRET — API writes will be rejected');

// ── SafuLens bytecode ─────────────────────────────────────
let SAFU_BYTECODE = '';

async function loadSafuBytecode(): Promise<string> {
	if (SAFU_BYTECODE) return SAFU_BYTECODE;

	// Try explicit path from env
	const envPath = process.env.SAFU_BYTECODE;
	if (envPath && fs.existsSync(envPath)) {
		const json = JSON.parse(fs.readFileSync(envPath, 'utf-8'));
		SAFU_BYTECODE = json.bytecode || json;
		return SAFU_BYTECODE;
	}

	// Try relative to script location
	const candidates = [
		path.resolve(import.meta.dirname || __dirname, '../../artifacts/contracts/simulators/SafuLens.sol/SafuLens.json'),
		path.resolve(import.meta.dirname || __dirname, 'SafuLens.json'),
	];
	for (const p of candidates) {
		try {
			const json = JSON.parse(fs.readFileSync(p, 'utf-8'));
			SAFU_BYTECODE = json.bytecode;
			console.log(`   SafuLens bytecode loaded from: ${p}`);
			return SAFU_BYTECODE;
		} catch {}
	}

	throw new Error('SafuLens bytecode not found. Set SAFU_BYTECODE env or place SafuLens.json next to this script.');
}

// ── Network config ────────────────────────────────────────
interface NetworkConfig {
	platform_address: string;
	usdt_address: string;
	dex_router: string;
}

async function fetchNetworkConfig(chainId: number): Promise<NetworkConfig> {
	const headers: Record<string, string> = {};
	if (SYNC_SECRET) headers.Authorization = `Bearer ${SYNC_SECRET}`;
	const res = await fetch(`${API_BASE}/api/config?keys=networks`, { headers });
	if (!res.ok) throw new Error(`Config fetch failed: ${res.status}`);
	const data = await res.json();
	const networks = data.networks || [];
	const match = networks.find((n: any) => n.chain_id === chainId);
	if (!match) throw new Error(`No config for chain ${chainId}`);
	return match;
}

// ── Token list from DB ────────────────────────────────────
interface TokenRow {
	address: string;
	chain_id: number;
}

async function fetchAllTokenAddresses(chainId: number): Promise<string[]> {
	// Read from the backend API — it queries Supabase
	const res = await fetch(`${API_BASE}/api/created-tokens?chain_id=${chainId}&fields=address`, {
		headers: { Authorization: `Bearer ${SYNC_SECRET}` },
	});
	if (!res.ok) {
		console.warn(`   ⚠️ Token list fetch failed: ${res.status}`);
		return [];
	}
	const rows: TokenRow[] = await res.json();
	return rows.map(r => r.address);
}

// ── SafuLens batch call ───────────────────────────────────
interface SafuResult {
	token: string;
	isMintable: boolean;
	isTaxable: boolean;
	isPartner: boolean;
	ownerIsZero: boolean;
	taxCeilingLocked: boolean;
	tradingEnabled: boolean;
	hasLiquidity: boolean;
	lpBurned: boolean;
	lpBurnedPct: number;
	buyTaxBps: number;
	sellTaxBps: number;
	isSafu: boolean;
}

async function querySafuLensBatch(
	provider: ethers.Provider,
	bytecode: string,
	tokenFactory: string,
	dexFactory: string,
	weth: string,
	usdt: string,
	tokenAddrs: string[],
): Promise<SafuResult[]> {
	const abiCoder = ethers.AbiCoder.defaultAbiCoder();
	const args = abiCoder.encode(
		['address', 'address', 'address', 'address', 'address[]'],
		[tokenFactory, dexFactory, weth, usdt, tokenAddrs]
	);
	const callData = bytecode + args.slice(2);
	const raw = await provider.call({ data: callData, gasLimit: 50_000_000 });
	if (!raw || raw === '0x') return [];

	const decoded = abiCoder.decode(
		['tuple(address token, bool isMintable, bool isTaxable, bool isPartner, address owner, bool ownerIsZero, bool taxCeilingLocked, uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps, bool tradingEnabled, bool hasLiquidity, bool lpBurned, uint256 lpBurnedPct, bool isSafu)[]'],
		raw
	);

	return (decoded[0] as any[]).map((s: any) => ({
		token: s.token.toLowerCase(),
		isMintable: s.isMintable,
		isTaxable: s.isTaxable,
		isPartner: s.isPartner,
		ownerIsZero: s.ownerIsZero,
		taxCeilingLocked: s.taxCeilingLocked,
		tradingEnabled: s.tradingEnabled,
		hasLiquidity: s.hasLiquidity,
		lpBurned: s.lpBurned,
		lpBurnedPct: Number(s.lpBurnedPct),
		buyTaxBps: Number(s.buyTaxBps),
		sellTaxBps: Number(s.sellTaxBps),
		isSafu: s.isSafu,
	}));
}

// ── API write ─────────────────────────────────────────────
async function updateSafuBatch(chainId: number, results: SafuResult[]): Promise<number> {
	let updated = 0;
	// PATCH each token's SAFU columns. The backend API should accept
	// batch updates — if not, fall back to one-at-a-time.
	const batch = results.map(r => ({
		address: r.token,
		chain_id: chainId,
		is_safu: r.isSafu,
		has_liquidity: r.hasLiquidity,
		lp_burned: r.lpBurned,
		lp_burned_pct: r.lpBurnedPct,
		tax_ceiling_locked: r.taxCeilingLocked,
		owner_renounced: r.ownerIsZero,
		trading_enabled: r.tradingEnabled,
		buy_tax_bps: r.buyTaxBps,
		sell_tax_bps: r.sellTaxBps,
	}));

	try {
		const res = await fetch(`${API_BASE}/api/created-tokens/safu`, {
			method: 'PATCH',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${SYNC_SECRET}`,
			},
			body: JSON.stringify({ tokens: batch }),
		});
		if (res.ok) {
			updated = batch.length;
		} else {
			console.warn(`   ⚠️ Batch SAFU update failed: ${res.status}`);
			// Fallback: one at a time
			for (const t of batch) {
				try {
					const r2 = await fetch(`${API_BASE}/api/created-tokens`, {
						method: 'PATCH',
						headers: {
							'Content-Type': 'application/json',
							Authorization: `Bearer ${SYNC_SECRET}`,
						},
						body: JSON.stringify(t),
					});
					if (r2.ok) updated++;
				} catch {}
			}
		}
	} catch (e: any) {
		console.error(`   ✗ SAFU update error: ${e.message?.slice(0, 80)}`);
	}
	return updated;
}

// ── Main loop ────────────────────────────────────────────
async function main() {
	const bytecode = await loadSafuBytecode();

	console.log(`\n🛡️  SAFU Indexer starting on chain ${CHAIN_ID}`);
	console.log(`   API: ${API_BASE}`);
	console.log(`   Sweep interval: ${SWEEP_INTERVAL / 1000}s`);
	console.log(`   Batch size: ${BATCH_SIZE}`);

	const config = await fetchNetworkConfig(CHAIN_ID);
	const daemonRpc = (config as any).daemon_rpc || '';
	const isWs = daemonRpc.startsWith('wss://') || daemonRpc.startsWith('ws://');
	const rpcUrl = (!isWs && daemonRpc) || (config as any).rpc || RPC_URL;
	const wsRpc = (isWs ? daemonRpc : '') || (config as any).ws_rpc || '';
	console.log(`   RPC: ${rpcUrl}${wsRpc ? ` (ws: ${wsRpc})` : ''}`);
	const managed = createManagedProvider({ chainId: CHAIN_ID, httpRpc: rpcUrl, wsRpc });
	const provider = managed.getProvider();
	console.log(`   TokenFactory: ${config.platform_address}`);

	// Resolve DEX factory + WETH from the router
	const dexRouterContract = new ethers.Contract(config.dex_router, [
		'function factory() view returns (address)',
		'function WETH() view returns (address)',
	], provider);
	const [dexFactory, weth] = await Promise.all([
		dexRouterContract.factory(),
		dexRouterContract.WETH(),
	]);
	console.log(`   DEX Factory: ${dexFactory}`);
	console.log(`   WETH: ${weth}`);

	let sweepCount = 0;
	let running = true;
	process.on('SIGINT', () => { running = false; console.log('\n⏹  Shutting down...'); });
	process.on('SIGTERM', () => { running = false; });

	while (running) {
		try {
			sweepCount++;
			const ts = new Date().toLocaleTimeString();

			// 1. Get all token addresses from DB
			const allAddrs = await fetchAllTokenAddresses(CHAIN_ID);
			console.log(`[${ts}] Sweep #${sweepCount} — ${allAddrs.length} tokens`);

			if (allAddrs.length === 0) {
				console.log('   No tokens to sweep');
			} else {
				// 2. Batch through SafuLens
				let totalUpdated = 0;
				for (let offset = 0; offset < allAddrs.length; offset += BATCH_SIZE) {
					const batch = allAddrs.slice(offset, offset + BATCH_SIZE);
					try {
						const results = await querySafuLensBatch(
							provider, bytecode,
							config.platform_address, dexFactory, weth, config.usdt_address,
							batch
						);
						if (results.length > 0) {
							const n = await updateSafuBatch(CHAIN_ID, results);
							totalUpdated += n;
						}
						// Brief pause between batches to avoid RPC rate limits
						if (offset + BATCH_SIZE < allAddrs.length) {
							await new Promise(r => setTimeout(r, 200));
						}
					} catch (e: any) {
						console.error(`   ✗ Batch ${offset}-${offset + batch.length}: ${e.message?.slice(0, 80)}`);
					}
				}
				console.log(`   ✓ Updated ${totalUpdated}/${allAddrs.length} tokens`);
			}
		} catch (e: any) {
			console.error(`   ❌ Sweep error: ${e.message?.slice(0, 120)}`);
		}

		await new Promise(resolve => setTimeout(resolve, SWEEP_INTERVAL));
	}

	console.log('✅ SAFU Indexer stopped.');
}

main().catch((e) => { console.error('Fatal error:', e); process.exit(1); });
