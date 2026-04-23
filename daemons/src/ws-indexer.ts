/**
 * TokenKrafter WS Indexer — hybrid event watcher + getter poller
 *
 * Single process, one WS connection for live events, background pollers
 * using contract getters for backfill + safety net.
 *
 * Responsibilities:
 *   - Token creations    (TokenFactory.TokenCreated + getTokensInfo)
 *   - Launch creations   (LaunchpadFactory.LaunchCreated + getLaunches)
 *   - Launch state       (per-instance Graduated/RefundingEnabled/etc.)
 *   - SAFU signals       (TradingEnabled, TaxesUpdated, TaxCeiling*)
 *
 * NOT handled (separate processes):
 *   - Withdrawal processing   → payment-server/withdrawal-processor.ts
 *   - SAFU bulk sweep         → safu-indexer.ts
 *   - Purchase history        → frontend reads on-chain getPurchases()
 *
 * Cache: bun:sqlite (ACID, no full-JSON rewrite per event). Tracks
 * counters + known token set + watched launches. Canonical data is
 * POSTed to the Next.js API endpoints.
 *
 * Boot behaviour:
 *   - Empty DB → pollers do a full sweep via getters in background
 *     while WS subscribes from current block forward. Both can overlap
 *     safely (API endpoints are idempotent upserts).
 *   - Existing DB → WS subscribes, pollers run on long interval (5 min)
 *     as safety net.
 *
 * Reconnect:
 *   - On WS drop → removeAllListeners, re-subscribe. Pollers fill any
 *     gap on their next tick.
 *
 * Usage:
 *   bun scripts/daemon/ws-indexer.ts
 *
 * Env:
 *   RPC_URL              HTTP fallback (default bsc-dataseed)
 *   CHAIN_ID             default 56
 *   API_BASE_URL         backend (default http://localhost:5173)
 *   SYNC_SECRET          bearer for /api writes
 *   DB_PATH              sqlite path (default ./ws-indexer.db)
 *   POLL_INTERVAL_MS     safety-net poll (default 300000 = 5 min)
 *   BACKFILL_BATCH       tokens/launches per getter call (default 50)
 *   SAFU_RECHECK_PATH    endpoint for single-token rechecks
 */

import { ethers } from 'ethers';
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { createManagedProvider, type ManagedProvider } from '../lib/provider';

// ── Config ─────────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL || 'https://bsc-dataseed.binance.org/';
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '56');
const API_BASE = process.env.API_BASE_URL || 'http://localhost:5173';
const SYNC_SECRET = process.env.SYNC_SECRET || '';
const DB_PATH = process.env.DB_PATH || path.resolve(import.meta.dirname || __dirname, 'ws-indexer.db');
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '300000', 10);
const BACKFILL_BATCH = parseInt(process.env.BACKFILL_BATCH || '50', 10);
const SAFU_RECHECK_PATH = process.env.SAFU_RECHECK_PATH || '/api/created-tokens/safu/recheck';

if (!SYNC_SECRET) console.warn('⚠️  No SYNC_SECRET — API writes may be rejected');

// ── ABIs ──────────────────────────────────────────────────
const TOKEN_FACTORY_ABI = [
	'event TokenCreated(address indexed creator, address indexed tokenAddress, uint8 tokenType, string name, string symbol, uint256 totalSupply, uint8 decimals, uint256 fee, address referrer)',
	'function totalTokensCreated() view returns (uint256)',
	'function getTokensInfo(uint256 offset, uint256 limit) view returns (tuple(address tokenAddress, string name, string symbol, uint8 decimals, uint256 totalSupply, address creator, bool isMintable, bool isTaxable, bool isPartnership)[] views, uint256 total)',
];

const LAUNCHPAD_FACTORY_ABI = [
	'event LaunchCreated(address indexed launch, address indexed token, address indexed creator, uint8 curveType, uint256 softCap, uint256 hardCap, uint256 totalTokens, uint256 param1, uint256 param2)',
	'function totalLaunches() view returns (uint256)',
	'function getLaunches(uint256 offset, uint256 limit) view returns (address[] r, uint256 total)',
];

const LAUNCH_INSTANCE_ABI = [
	'event TokenBought(address indexed buyer, uint256 tokenAmount, uint256 basePaid, uint256 fee, uint256 newPrice, uint256 totalBaseRaised, uint256 totalTokensSold, uint256 remainingTokens, uint256 buyerCount)',
	'event Graduated(address indexed dexPair, uint256 baseToLP, uint256 tokensToLP, uint256 platformBaseFee, uint256 platformTokenFee, uint256 finalTotalRaised, uint256 finalTokensSold, uint256 totalBuyers)',
	'event Refunded(address indexed buyer, uint256 baseAmount, uint256 tokensReturned)',
	'event CreatorClaimed(address indexed creator, uint256 amount, uint256 totalClaimed, uint256 totalVested)',
	'event RefundingEnabled(address indexed token, uint256 totalRaised, uint256 softCap)',
	'event LaunchActivated(address indexed token, uint256 deadline, uint256 softCap, uint256 hardCap, uint256 tokensForCurve)',
	'event TokensDeposited(address indexed creator, uint256 amount, uint256 totalDeposited, uint256 totalRequired)',
	'function getLaunchInfo() view returns (address token_, address creator_, uint8 curveType_, uint8 state_, uint256 softCap_, uint256 hardCap_, uint256 deadline_, uint256 totalBaseRaised_, uint256 tokensSold_, uint256 tokensForCurve_, uint256 tokensForLP_, uint256 creatorAllocationBps_, uint256 currentPrice_, address usdt_, uint256 startTimestamp_)',
	'function totalTokensRequired() view returns (uint256)',
	'function totalTokensDeposited() view returns (uint256)',
];

const TRADE_ROUTER_ABI = [
	'event WithdrawRequested(uint256 indexed id, address indexed user, address token, uint256 grossAmount, uint256 fee, uint256 netAmount, bytes32 bankRef, address referrer, uint256 expiresAt)',
	'event WithdrawConfirmed(uint256 indexed id, address indexed admin, address indexed to, uint256 netAmount, uint256 grossAmount, uint256 fee, address token)',
	'event WithdrawCancelled(uint256 indexed id, address indexed user, uint256 refundedAmount)',
];

const TAXABLE_TOKEN_EVENT_ABI = [
	'event TaxesUpdated(uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps)',
	'event TaxCeilingLocked(uint256 buyCeiling, uint256 sellCeiling, uint256 transferCeiling)',
	'event TaxCeilingRelaxed(uint256 buyCeiling, uint256 sellCeiling, uint256 transferCeiling)',
	'event TaxCeilingUnlocked()',
];

const BASIC_TOKEN_EVENT_ABI = [
	'event TradingEnabled(uint256 startsAt)',
	'event PoolRegistered(address indexed pool, address indexed base)',
];

const TOKEN_META_ABI = [
	'function name() view returns (string)',
	'function symbol() view returns (string)',
	'function decimals() view returns (uint8)',
	'function totalSupply() view returns (uint256)',
];

// ── SQLite cache ──────────────────────────────────────────
function initDb(dbPath: string): Database {
	const db = new Database(dbPath);
	db.exec('PRAGMA journal_mode=WAL');
	db.exec(`CREATE TABLE IF NOT EXISTS chain_state (
		chain_id INTEGER PRIMARY KEY,
		last_token_count INTEGER DEFAULT 0,
		last_launch_count INTEGER DEFAULT 0
	)`);
	db.exec(`CREATE TABLE IF NOT EXISTS known_tokens (
		address TEXT PRIMARY KEY
	)`);
	db.exec(`CREATE TABLE IF NOT EXISTS watched_launches (
		address TEXT PRIMARY KEY
	)`);
	return db;
}

interface ChainState {
	lastTokenCount: number;
	lastLaunchCount: number;
}

function getChainState(db: Database, chainId: number): ChainState {
	const row = db.query<{ last_token_count: number; last_launch_count: number }, [number]>(
		'SELECT last_token_count, last_launch_count FROM chain_state WHERE chain_id = ?'
	).get(chainId);
	if (!row) {
		db.run('INSERT INTO chain_state (chain_id) VALUES (?)', [chainId]);
		return { lastTokenCount: 0, lastLaunchCount: 0 };
	}
	return { lastTokenCount: row.last_token_count, lastLaunchCount: row.last_launch_count };
}

function setTokenCount(db: Database, chainId: number, count: number) {
	db.run('UPDATE chain_state SET last_token_count = ? WHERE chain_id = ?', [count, chainId]);
}

function setLaunchCount(db: Database, chainId: number, count: number) {
	db.run('UPDATE chain_state SET last_launch_count = ? WHERE chain_id = ?', [count, chainId]);
}

function addKnownToken(db: Database, address: string) {
	db.run('INSERT OR IGNORE INTO known_tokens (address) VALUES (?)', [address.toLowerCase()]);
}

function loadAllKnownTokens(db: Database): Set<string> {
	const rows: Array<{ address: string }> = db.query('SELECT address FROM known_tokens').all() as any;
	return new Set(rows.map((r: { address: string }) => r.address));
}

function addWatchedLaunch(db: Database, address: string) {
	db.run('INSERT OR IGNORE INTO watched_launches (address) VALUES (?)', [address.toLowerCase()]);
}

function removeWatchedLaunch(db: Database, address: string) {
	db.run('DELETE FROM watched_launches WHERE address = ?', [address.toLowerCase()]);
}

function loadWatchedLaunches(db: Database): Set<string> {
	const rows: Array<{ address: string }> = db.query('SELECT address FROM watched_launches').all() as any;
	return new Set(rows.map((r: { address: string }) => r.address));
}

// ── HTTP ──────────────────────────────────────────────────
async function apiPost(endpoint: string, body: any): Promise<boolean> {
	try {
		const res = await fetch(`${API_BASE}${endpoint}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SYNC_SECRET}` },
			body: JSON.stringify(body),
		});
		if (!res.ok) console.warn(`    ⚠️  ${endpoint} → ${res.status}`);
		return res.ok;
	} catch (e: any) {
		console.error(`    ✗ ${endpoint}: ${e.message?.slice(0, 80)}`);
		return false;
	}
}

interface NetworkConfig {
	chain_id: number;
	name: string;
	platform_address: string;
	launchpad_address: string;
	trade_router_address?: string;
	usdt_address: string;
	dex_router: string;
	rpc?: string;
	ws_rpc?: string;
}

async function fetchNetworkConfig(chainId: number): Promise<NetworkConfig> {
	const headers: Record<string, string> = {};
	if (SYNC_SECRET) headers.Authorization = `Bearer ${SYNC_SECRET}`;
	const res = await fetch(`${API_BASE}/api/config?keys=networks`, { headers });
	if (!res.ok) throw new Error(`config ${res.status}`);
	const { networks } = await res.json();
	const match = (networks || []).find((n: any) => Number(n.chain_id) === chainId);
	if (!match) throw new Error(`no config for chain ${chainId}`);
	return match;
}

// ── SafuLens single-token check ───────────────────────────
// Reuses the same bytecode + eth_call pattern as safu-indexer but
// for one token at a time, triggered on creation/graduation events.

let safuBytecode = '';

function loadSafuBytecode(): string {
	if (safuBytecode) return safuBytecode;

	const envPath = process.env.SAFU_BYTECODE;
	if (envPath && fs.existsSync(envPath)) {
		const json = JSON.parse(fs.readFileSync(envPath, 'utf-8'));
		safuBytecode = json.bytecode || json;
		return safuBytecode;
	}

	const candidates = [
		path.resolve(import.meta.dirname || __dirname, '../solidty-contracts/artifacts/contracts/simulators/SafuLens.sol/SafuLens.json'),
		path.resolve(import.meta.dirname || __dirname, 'SafuLens.json'),
	];
	for (const p of candidates) {
		try {
			const json = JSON.parse(fs.readFileSync(p, 'utf-8'));
			safuBytecode = json.bytecode;
			console.log(`   SafuLens loaded from: ${p}`);
			return safuBytecode;
		} catch {}
	}

	console.warn('   ⚠️  SafuLens bytecode not found — on-create SAFU checks disabled');
	return '';
}

async function recheckSafu(
	provider: ethers.Provider,
	bytecode: string,
	tokenFactory: string,
	dexFactory: string,
	weth: string,
	usdt: string,
	chainId: number,
	tokenAddr: string,
): Promise<void> {
	if (!bytecode) return;

	try {
		const abiCoder = ethers.AbiCoder.defaultAbiCoder();
		const args = abiCoder.encode(
			['address', 'address', 'address', 'address', 'address[]'],
			[tokenFactory, dexFactory, weth, usdt, [tokenAddr]],
		);
		const raw = await provider.call({ data: bytecode + args.slice(2), gasLimit: 50_000_000 });
		if (!raw || raw === '0x') return;

		const decoded = abiCoder.decode(
			['tuple(address token, bool isMintable, bool isTaxable, bool isPartner, address owner, bool ownerIsZero, bool taxCeilingLocked, uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps, bool tradingEnabled, bool hasLiquidity, bool lpBurned, uint256 lpBurnedPct, bool isSafu)[]'],
			raw,
		);
		const s = (decoded[0] as any[])[0];
		if (!s) return;

		await apiPost('/api/created-tokens/safu', {
			tokens: [{
				address: s.token.toLowerCase(),
				chain_id: chainId,
				is_safu: s.isSafu,
				has_liquidity: s.hasLiquidity,
				lp_burned: s.lpBurned,
				lp_burned_pct: Number(s.lpBurnedPct),
				tax_ceiling_locked: s.taxCeilingLocked,
				owner_renounced: s.ownerIsZero,
				trading_enabled: s.tradingEnabled,
				buy_tax_bps: Number(s.buyTaxBps),
				sell_tax_bps: Number(s.sellTaxBps),
			}],
		});
		console.log(`  🛡️  safu set ${tokenAddr.slice(0, 10)}… → ${s.isSafu ? 'SAFU' : 'not safu'}`);
	} catch (e: any) {
		console.error(`    ✗ safu recheck ${tokenAddr.slice(0, 10)}: ${e.message?.slice(0, 80)}`);
	}
}

// ── Shared context ────────────────────────────────────────
interface Ctx {
	chainId: number;
	db: Database;
	knownTokens: Set<string>;
	watchedLaunches: Set<string>;
	provider: () => ethers.Provider;
	config: NetworkConfig;
	usdtDecimals: number;
	dexFactory: string;
	weth: string;
	safuBytecode: string;
	subscribeLaunch: (addr: string) => void;
}

// ── Enrichment ────────────────────────────────────────────
async function enrichLaunch(provider: ethers.Provider, addr: string, chainId: number, usdtDecimals: number) {
	const inst = new ethers.Contract(addr, LAUNCH_INSTANCE_ABI, provider);
	const [info, req, dep] = await Promise.all([
		inst.getLaunchInfo(), inst.totalTokensRequired(), inst.totalTokensDeposited(),
	]);
	const tokenAddr = (info.token_ as string).toLowerCase();
	const tokenC = new ethers.Contract(tokenAddr, TOKEN_META_ABI, provider);
	const [name, symbol, decimals] = await Promise.all([
		tokenC.name().catch(() => 'Unknown'),
		tokenC.symbol().catch(() => '???'),
		tokenC.decimals().catch(() => 18),
	]);
	return {
		address: addr.toLowerCase(),
		chain_id: chainId,
		token_address: tokenAddr,
		creator: (info.creator_ as string).toLowerCase(),
		curve_type: Number(info.curveType_),
		state: Number(info.state_),
		soft_cap: info.softCap_.toString(),
		hard_cap: info.hardCap_.toString(),
		total_base_raised: info.totalBaseRaised_.toString(),
		tokens_sold: info.tokensSold_.toString(),
		tokens_for_curve: info.tokensForCurve_.toString(),
		tokens_for_lp: info.tokensForLP_.toString(),
		creator_allocation_bps: Number(info.creatorAllocationBps_),
		current_price: info.currentPrice_.toString(),
		deadline: Number(info.deadline_),
		start_timestamp: Number(info.startTimestamp_),
		total_tokens_required: req.toString(),
		total_tokens_deposited: dep.toString(),
		token_name: name,
		token_symbol: symbol,
		token_decimals: Number(decimals),
		usdt_decimals: usdtDecimals,
	};
}

// ── Polling workers ───────────────────────────────────────
// Each worker is a self-scheduling async loop. On empty DB it runs
// immediately with short pauses between batches; in steady state it
// sleeps POLL_INTERVAL between ticks.

async function pollTokens(ctx: Ctx, running: () => boolean) {
	const factory = new ethers.Contract(ctx.config.platform_address, TOKEN_FACTORY_ABI, ctx.provider());

	while (running()) {
		try {
			const total = Number(await factory.totalTokensCreated());
			const state = getChainState(ctx.db, ctx.chainId);
			if (total > state.lastTokenCount) {
				const gap = total - state.lastTokenCount;
				console.log(`  [poll] ${gap} new token(s) to index`);

				for (let off = state.lastTokenCount; off < total; off += BACKFILL_BATCH) {
					const limit = Math.min(BACKFILL_BATCH, total - off);
					const { views } = await factory.getTokensInfo(off, limit);

					let batchOk = true;
					for (const v of views) {
						const addr = (v.tokenAddress as string).toLowerCase();
						const ok = await apiPost('/api/created-tokens', {
							address: addr,
							chain_id: ctx.chainId,
							creator: (v.creator as string).toLowerCase(),
							name: v.name,
							symbol: v.symbol,
							decimals: Number(v.decimals),
							total_supply: (v.totalSupply as bigint).toString(),
							is_mintable: v.isMintable,
							is_taxable: v.isTaxable,
							is_partner: v.isPartnership,
						});
						if (ok) {
							ctx.knownTokens.add(addr);
							addKnownToken(ctx.db, addr);
						} else {
							batchOk = false;
						}
					}

					// Only advance counter if entire batch succeeded — failed
					// tokens will be retried on the next poll cycle.
					if (batchOk) setTokenCount(ctx.db, ctx.chainId, off + views.length);
					if (!running()) return;
					await Bun.sleep(500);
				}
				console.log(`  [poll] tokens synced to ${total}`);
			}
		} catch (e: any) {
			console.error(`  [poll] token error: ${e.message?.slice(0, 80)}`);
		}
		await Bun.sleep(POLL_INTERVAL);
	}
}

async function pollLaunches(ctx: Ctx, running: () => boolean) {
	const factory = new ethers.Contract(ctx.config.launchpad_address, LAUNCHPAD_FACTORY_ABI, ctx.provider());

	while (running()) {
		try {
			const total = Number(await factory.totalLaunches());
			const state = getChainState(ctx.db, ctx.chainId);
			if (total > state.lastLaunchCount) {
				const gap = total - state.lastLaunchCount;
				console.log(`  [poll] ${gap} new launch(es) to index`);

				for (let off = state.lastLaunchCount; off < total; off += BACKFILL_BATCH) {
					const limit = Math.min(BACKFILL_BATCH, total - off);
					const { r: addresses } = await factory.getLaunches(off, limit);

					let launchBatchOk = true;
					for (const rawAddr of addresses) {
						const addr = (rawAddr as string).toLowerCase();
						try {
							const data = await enrichLaunch(ctx.provider(), addr, ctx.chainId, ctx.usdtDecimals);
							data.chain_id = ctx.chainId;
							const ok = await apiPost('/api/launches', data);

							if (ok && data.state <= 1) {
								ctx.watchedLaunches.add(addr);
								addWatchedLaunch(ctx.db, addr);
								ctx.subscribeLaunch(addr);
							}
							if (!ok) launchBatchOk = false;
						} catch (e: any) {
							console.error(`    ✗ poll launch ${addr.slice(0, 10)}: ${e.message?.slice(0, 80)}`);
							launchBatchOk = false;
						}
					}

					if (launchBatchOk) setLaunchCount(ctx.db, ctx.chainId, off + addresses.length);
					if (!running()) return;
					await Bun.sleep(500);
				}
				console.log(`  [poll] launches synced to ${total}`);
			}
		} catch (e: any) {
			console.error(`  [poll] launch error: ${e.message?.slice(0, 80)}`);
		}
		await Bun.sleep(POLL_INTERVAL);
	}
}

async function pollLaunchStates(ctx: Ctx, running: () => boolean) {
	while (running()) {
		if (ctx.watchedLaunches.size === 0) {
			await Bun.sleep(POLL_INTERVAL);
			continue;
		}

		const addrs = [...ctx.watchedLaunches];
		for (const addr of addrs) {
			if (!running()) return;
			try {
				const data = await enrichLaunch(ctx.provider(), addr, ctx.chainId, ctx.usdtDecimals);
				data.chain_id = ctx.chainId;
				await apiPost('/api/launches', data);

				if (data.state > 1) {
					ctx.watchedLaunches.delete(addr);
					removeWatchedLaunch(ctx.db, addr);
				}
			} catch (e: any) {
				console.error(`  [poll] launch state ${addr.slice(0, 10)}: ${e.message?.slice(0, 80)}`);
			}
			await Bun.sleep(200);
		}
		await Bun.sleep(POLL_INTERVAL);
	}
}

// ── WS event handlers ─────────────────────────────────────
const dedupeSet = new Set<string>();
const DEDUPE_MAX = 4096;

function dedupeKey(log: ethers.Log): string {
	return `${log.blockNumber}:${log.index}`;
}

function isDupe(log: ethers.Log): boolean {
	const k = dedupeKey(log);
	if (dedupeSet.has(k)) return true;
	dedupeSet.add(k);
	if (dedupeSet.size > DEDUPE_MAX) {
		const first = dedupeSet.values().next().value;
		if (first) dedupeSet.delete(first);
	}
	return false;
}

function makeDispatcher(ctx: Ctx) {
	const tfIface = new ethers.Interface(TOKEN_FACTORY_ABI);
	const lpIface = new ethers.Interface(LAUNCHPAD_FACTORY_ABI);
	const liIface = new ethers.Interface(LAUNCH_INSTANCE_ABI);
	const trIface = new ethers.Interface(TRADE_ROUTER_ABI);
	const taxIface = new ethers.Interface(TAXABLE_TOKEN_EVENT_ABI);
	const basicIface = new ethers.Interface(BASIC_TOKEN_EVENT_ABI);

	const addr = {
		factory: ctx.config.platform_address.toLowerCase(),
		launchpad: ctx.config.launchpad_address.toLowerCase(),
		tradeRouter: (ctx.config.trade_router_address || '').toLowerCase(),
	};

	return async (log: ethers.Log) => {
		if (isDupe(log)) return;
		const src = log.address.toLowerCase();

		try {
			if (src === addr.factory) {
				const p = tfIface.parseLog({ topics: [...log.topics], data: log.data });
				if (p?.name !== 'TokenCreated') return;

				const token = (p.args.tokenAddress as string).toLowerCase();
				const tokenType = Number(p.args.tokenType);

				ctx.knownTokens.add(token);
				addKnownToken(ctx.db, token);

				await apiPost('/api/created-tokens', {
					address: token,
					chain_id: ctx.chainId,
					creator: (p.args.creator as string).toLowerCase(),
					name: p.args.name,
					symbol: p.args.symbol,
					decimals: Number(p.args.decimals),
					total_supply: (p.args.totalSupply as bigint).toString(),
					is_mintable: (tokenType & 1) !== 0,
					is_taxable: (tokenType & 2) !== 0,
					is_partner: (tokenType & 4) !== 0,
					block_number: log.blockNumber,
					tx_hash: log.transactionHash,
				});
				console.log(`  🪙  ${p.args.symbol} (${token.slice(0, 10)}…) block ${log.blockNumber}`);

				// Immediate SAFU check — sets baseline badges on creation
				recheckSafu(ctx.provider(), ctx.safuBytecode, ctx.config.platform_address, ctx.dexFactory, ctx.weth, ctx.config.usdt_address, ctx.chainId, token);

			} else if (src === addr.launchpad) {
				const p = lpIface.parseLog({ topics: [...log.topics], data: log.data });
				if (p?.name !== 'LaunchCreated') return;

				const launch = (p.args.launch as string).toLowerCase();
				try {
					const data = await enrichLaunch(ctx.provider(), launch, ctx.chainId, ctx.usdtDecimals);
					await apiPost('/api/launches', { ...data, block_number: log.blockNumber, tx_hash: log.transactionHash });

					if (data.state <= 1) {
						ctx.watchedLaunches.add(launch);
						addWatchedLaunch(ctx.db, launch);
						ctx.subscribeLaunch(launch);
					}
				} catch (e: any) {
					console.error(`    ✗ launch enrich ${launch.slice(0, 10)}: ${e.message?.slice(0, 80)}`);
				}
				// SAFU check for the launched token
				const launchToken = (p.args.token as string).toLowerCase();
				recheckSafu(ctx.provider(), ctx.safuBytecode, ctx.config.platform_address, ctx.dexFactory, ctx.weth, ctx.config.usdt_address, ctx.chainId, launchToken);
				console.log(`  🚀 Launch ${launch.slice(0, 10)}…`);

			} else if (ctx.watchedLaunches.has(src)) {
				const p = liIface.parseLog({ topics: [...log.topics], data: log.data });
				if (!p) return;

				// TokenBought carries full state inline — patch directly without
				// an eth_call. For terminal events (Graduated, RefundingEnabled)
				// do a full enrichLaunch to get the final snapshot.
				if (p.name === 'TokenBought') {
					await apiPost('/api/launches', {
						address: src,
						chain_id: ctx.chainId,
						total_base_raised: p.args.totalBaseRaised.toString(),
						tokens_sold: p.args.totalTokensSold.toString(),
						current_price: p.args.newPrice.toString(),
					});
				} else {
					try {
						const data = await enrichLaunch(ctx.provider(), src, ctx.chainId, ctx.usdtDecimals);
						await apiPost('/api/launches', data);

						if (data.state > 1) {
							ctx.watchedLaunches.delete(src);
							removeWatchedLaunch(ctx.db, src);
						}

						// Graduated = token just got DEX liquidity + LP burned.
						// SAFU status changes meaningfully at this point.
						if (p.name === 'Graduated') {
							recheckSafu(ctx.provider(), ctx.safuBytecode, ctx.config.platform_address, ctx.dexFactory, ctx.weth, ctx.config.usdt_address, ctx.chainId, data.token_address);
						}
					} catch (e: any) {
						console.error(`    ✗ launch refresh ${src.slice(0, 10)}: ${e.message?.slice(0, 80)}`);
					}
				}
				console.log(`    📈 ${p.name} on ${src.slice(0, 10)}…`);

			} else if (addr.tradeRouter && src === addr.tradeRouter) {
				const p = trIface.parseLog({ topics: [...log.topics], data: log.data });
				if (!p) return;

				if (p.name === 'WithdrawRequested') {
					await apiPost('/api/withdrawals/verify', {
						withdraw_id: Number(p.args.id),
						chain_id: ctx.chainId,
						wallet_address: (p.args.user as string).toLowerCase(),
						gross_amount: p.args.grossAmount.toString(),
						fee: p.args.fee.toString(),
						net_amount: p.args.netAmount.toString(),
						bank_ref: p.args.bankRef,
						referrer: (p.args.referrer as string).toLowerCase(),
						expires_at: Number(p.args.expiresAt),
						status: 0,
					});
					console.log(`  💰 Withdrawal #${p.args.id} from ${(p.args.user as string).slice(0, 10)}…`);
				} else if (p.name === 'WithdrawConfirmed') {
					await apiPost('/api/withdrawals/sync-status', {
						withdraw_id: Number(p.args.id),
						chain_id: ctx.chainId,
						status: 'confirmed',
					});
					console.log(`  ✅ Withdrawal #${p.args.id} confirmed`);
				} else if (p.name === 'WithdrawCancelled') {
					await apiPost('/api/withdrawals/sync-status', {
						withdraw_id: Number(p.args.id),
						chain_id: ctx.chainId,
						status: 'cancelled',
					});
					console.log(`  ❌ Withdrawal #${p.args.id} cancelled`);
				}

			} else if (ctx.knownTokens.has(src)) {
				let p = taxIface.parseLog({ topics: [...log.topics], data: log.data });
				if (!p) p = basicIface.parseLog({ topics: [...log.topics], data: log.data });
				if (!p) return;

				await apiPost(SAFU_RECHECK_PATH, {
					chain_id: ctx.chainId,
					address: src,
					reason: p.name,
					block_number: log.blockNumber,
					tx_hash: log.transactionHash,
				});
				console.log(`  🛡️  safu ${src.slice(0, 10)}… (${p.name})`);
			}
		} catch (e: any) {
			console.error(`    ✗ dispatch: ${e.message?.slice(0, 80)}`);
		}
	};
}

// ── WS subscriptions ──────────────────────────────────────
function subscribeAll(ctx: Ctx, managed: ManagedProvider, dispatch: (log: ethers.Log) => Promise<void>) {
	const p = managed.getProvider();

	const filters: ethers.EventFilter[] = [
		{ address: ctx.config.platform_address, topics: [ethers.id('TokenCreated(address,address,uint8,string,string,uint256,uint8,uint256,address)')] },
		{ address: ctx.config.launchpad_address, topics: [ethers.id('LaunchCreated(address,address,address,uint8,uint256,uint256,uint256,uint256,uint256)')] },
	];

	// TradeRouter withdrawal events
	if (ctx.config.trade_router_address) {
		filters.push(
			{ address: ctx.config.trade_router_address, topics: [ethers.id('WithdrawRequested(uint256,address,address,uint256,uint256,uint256,bytes32,address,uint256)')] },
			{ address: ctx.config.trade_router_address, topics: [ethers.id('WithdrawConfirmed(uint256,address,address,uint256,uint256,uint256,address)')] },
			{ address: ctx.config.trade_router_address, topics: [ethers.id('WithdrawCancelled(uint256,address,uint256)')] },
		);
	}

	for (const addr of ctx.watchedLaunches) {
		filters.push({ address: addr });
	}

	const safuTopics = [
		ethers.id('TradingEnabled(uint256)'),
		ethers.id('PoolRegistered(address,address)'),
		ethers.id('TaxesUpdated(uint256,uint256,uint256)'),
		ethers.id('TaxCeilingLocked(uint256,uint256,uint256)'),
		ethers.id('TaxCeilingRelaxed(uint256,uint256,uint256)'),
		ethers.id('TaxCeilingUnlocked()'),
	];
	for (const t of safuTopics) filters.push({ topics: [t] } as any);

	for (const f of filters) {
		p.on(f as any, (log: ethers.Log) => { dispatch(log); });
	}

	console.log(`  🔔 ${filters.length} WS filters active`);
}

// ── Main ──────────────────────────────────────────────────
async function main() {
	console.log(`\n📡 WS Indexer starting (chain ${CHAIN_ID})`);
	console.log(`   API:  ${API_BASE}`);
	console.log(`   DB:   ${DB_PATH}`);

	const config = await fetchNetworkConfig(CHAIN_ID);
	// daemon_rpc: private endpoint, never exposed to browsers.
	const daemonRpc = (config as any).daemon_rpc || '';
	const isWs = daemonRpc.startsWith('wss://') || daemonRpc.startsWith('ws://');
	const rpcUrl = (!isWs && daemonRpc) || config.rpc || RPC_URL;
	const wsRpc = (isWs ? daemonRpc : '') || config.ws_rpc || '';
	console.log(`   RPC:  ${rpcUrl}${wsRpc ? ` (ws: ${wsRpc})` : ''}`);

	const db = initDb(DB_PATH);
	const state = getChainState(db, CHAIN_ID);
	const knownTokens = loadAllKnownTokens(db);
	const watchedLaunches = loadWatchedLaunches(db);
	const isFreshBoot = state.lastTokenCount === 0 && state.lastLaunchCount === 0;

	let managed!: ManagedProvider;
	let dispatch: (log: ethers.Log) => Promise<void>;

	managed = createManagedProvider({
		chainId: CHAIN_ID,
		httpRpc: rpcUrl,
		wsRpc,
		onReconnect: () => {
			if (!dispatch) return; // not ready yet
			console.log('  🔁 WS reconnected — resubscribing');
			try { managed.getProvider().removeAllListeners(); } catch {}
			subscribeAll(ctx, managed, dispatch);
		},
	});

	// Resolve DEX factory + WETH (needed for SafuLens)
	let dexFactory = '', weth = '';
	if (config.dex_router) {
		try {
			const dexRouterC = new ethers.Contract(config.dex_router, [
				'function factory() view returns (address)',
				'function WETH() view returns (address)',
			], managed.getProvider());
			[dexFactory, weth] = await Promise.all([dexRouterC.factory(), dexRouterC.WETH()]);
			console.log(`   DEX Factory: ${dexFactory}`);
		} catch (e: any) {
			console.warn(`   ⚠️  DEX resolve failed: ${e.message?.slice(0, 60)}`);
		}
	}

	// Load SafuLens bytecode for on-create SAFU checks
	const safuBc = loadSafuBytecode();

	let usdtDecimals = 18;
	try {
		const c = new ethers.Contract(config.usdt_address, ['function decimals() view returns (uint8)'], managed.getProvider());
		usdtDecimals = Number(await c.decimals());
	} catch {}

	const ctx: Ctx = {
		chainId: CHAIN_ID,
		db,
		knownTokens,
		watchedLaunches,
		provider: () => managed.getProvider(),
		config,
		usdtDecimals,
		dexFactory,
		weth,
		safuBytecode: safuBc,
		subscribeLaunch: (addr: string) => {
			try {
				managed.getProvider().on({ address: addr } as any, (log: ethers.Log) => {
					if (dispatch) dispatch(log);
				});
			} catch (e: any) {
				console.error(`    ✗ sub launch ${addr.slice(0, 10)}: ${e.message?.slice(0, 60)}`);
			}
		},
	};

	dispatch = makeDispatcher(ctx);

	// WS goes live immediately
	subscribeAll(ctx, managed, dispatch);

	console.log(`   tokens=${knownTokens.size} launches=${watchedLaunches.size} (${isFreshBoot ? 'fresh boot — full backfill' : 'resuming'})`);
	console.log(`   poll interval: ${POLL_INTERVAL / 1000}s\n`);

	// Background pollers
	let alive = true;
	const isAlive = () => alive;
	process.on('SIGINT', () => { alive = false; console.log('\n⏹  stopping…'); });
	process.on('SIGTERM', () => { alive = false; });

	const pollers = [
		pollTokens(ctx, isAlive),
		pollLaunches(ctx, isAlive),
		pollLaunchStates(ctx, isAlive),
	];

	await Promise.all(pollers);

	db.close();
	await managed.close();
	console.log('✅ Stopped.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
