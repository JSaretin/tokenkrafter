/**
 * Chain Indexer Daemon (standalone — no hardhat, no solc)
 *
 * Self-contained ethers.js script. Runs with bun or node directly.
 * Zero compilation step — all ABIs are inline.
 *
 * Usage:
 *   bun scripts/daemon/chain-indexer.ts
 *
 * Environment:
 *   RPC_URL        — BSC RPC endpoint (default: https://bsc-dataseed.binance.org/)
 *   CHAIN_ID       — Chain ID (default: 56)
 *   API_BASE_URL   — Backend URL (e.g. https://tokenkrafter.com)
 *   SYNC_SECRET    — Auth token for backend API
 *   POLL_INTERVAL  — Seconds between polls (default: 30)
 *   STATE_FILE     — Path to state JSON (default: ./daemon-state.json)
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

// ── Config ─────────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL || 'https://bsc-dataseed.binance.org/';
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '56');
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '30') * 1000;
const API_BASE = process.env.API_BASE_URL || 'http://localhost:5173';
const SYNC_SECRET = process.env.SYNC_SECRET || '';
const STATE_FILE = process.env.STATE_FILE || path.resolve(import.meta.dirname || __dirname, 'daemon-state.json');

if (!SYNC_SECRET) {
	console.warn('⚠️  No SYNC_SECRET set — API calls may be rejected');
}

// ── ABIs (inline — no artifacts needed) ──────────────────
const TOKEN_FACTORY_ABI = [
	'function totalTokensCreated() view returns (uint256)',
	'function getTokenByIndex(uint256 index) view returns (address)',
	'function getTokens(uint256 offset, uint256 limit) view returns (address[] tokens, uint256 total)',
	'function tokenInfo(address) view returns (address creator, bool isMintable, bool isTaxable, bool isPartnership)',
	'event TokenCreated(address indexed creator, address indexed tokenAddress, uint8 tokenType, string name, string symbol, uint256 totalSupply, uint8 decimals)',
];

const LAUNCHPAD_FACTORY_ABI = [
	'function totalLaunches() view returns (uint256)',
	'function launches(uint256) view returns (address)',
];

const LAUNCH_INSTANCE_ABI = [
	'function getLaunchInfo() view returns (address token_, address creator_, uint8 curveType_, uint8 state_, uint256 softCap_, uint256 hardCap_, uint256 deadline_, uint256 totalBaseRaised_, uint256 tokensSold_, uint256 tokensForCurve_, uint256 tokensForLP_, uint256 creatorAllocationBps_, uint256 currentPrice_, address usdt_, uint256 startTimestamp_)',
	'function totalTokensRequired() view returns (uint256)',
	'function totalTokensDeposited() view returns (uint256)',
	'function stateHash() view returns (bytes32)',
	'function totalPurchases() view returns (uint256)',
	'function totalBuyers() view returns (uint256)',
	'function getPurchases(uint256 offset, uint256 limit) view returns (tuple(address buyer, uint256 baseAmount, uint256 tokensReceived, uint256 fee, uint256 price, uint256 timestamp)[] purchases, uint256 total)',
];

const TOKEN_META_ABI = [
	'function name() view returns (string)',
	'function symbol() view returns (string)',
	'function decimals() view returns (uint8)',
	'function totalSupply() view returns (uint256)',
	'function owner() view returns (address)',
];

const TRADE_ROUTER_ABI = [
	'function totalWithdrawals() view returns (uint256)',
	'function getWithdrawal(uint256 id) view returns (tuple(address user, address token, uint256 grossAmount, uint256 fee, uint256 netAmount, uint256 createdAt, uint8 status, bytes32 bankRef, address referrer))',
];

// ── State (local JSON file) ───────────────────────────────
interface LaunchCache {
	address: string;
	state: number;
	totalBaseRaised: string;
	stateHash: string;
	lastPurchaseCount: number;
}

interface ChainState {
	lastTokenCount: number;
	lastLaunchCount: number;
	lastWithdrawalCount: number;
	lastSyncedBlock: number;
	launches: LaunchCache[];
}

type DaemonState = Record<string, ChainState>;

function loadState(): DaemonState {
	try {
		if (fs.existsSync(STATE_FILE)) {
			return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
		}
	} catch {}
	return {};
}

function saveState(state: DaemonState) {
	fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getChainState(state: DaemonState, chainId: number): ChainState {
	const key = String(chainId);
	if (!state[key]) {
		state[key] = { lastTokenCount: 0, lastLaunchCount: 0, lastWithdrawalCount: 0, lastSyncedBlock: 0, launches: [] };
	}
	if (!state[key].launches) state[key].launches = [];
	return state[key];
}

// ── HTTP helpers ──────────────────────────────────────────
async function apiPost(endpoint: string, body: any): Promise<boolean> {
	try {
		const res = await fetch(`${API_BASE}${endpoint}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SYNC_SECRET}` },
			body: JSON.stringify(body)
		});
		return res.ok;
	} catch (e: any) {
		console.error(`    ✗ API ${endpoint}: ${e.message?.slice(0, 80)}`);
		return false;
	}
}

// ── Network config from backend ───────────────────────────
interface NetworkConfig {
	chain_id: number;
	name: string;
	platform_address: string;
	launchpad_address: string;
	trade_router_address: string;
	usdt_address: string;
	rpc?: string;
}

async function fetchNetworkConfig(chainId: number): Promise<NetworkConfig> {
	try {
		const res = await fetch(`${API_BASE}/api/config?keys=networks`);
		if (res.ok) {
			const data = await res.json();
			const networks: NetworkConfig[] = data.networks || [];
			const match = networks.find(n => n.chain_id === chainId);
			if (match) {
				console.log(`   Config loaded from backend for chain ${chainId}`);
				return match;
			}
		}
	} catch (e: any) {
		console.warn(`   ⚠️ Backend config fetch failed: ${e.message?.slice(0, 60)}`);
	}
	console.error('❌ Could not load network config from backend');
	process.exit(1);
}

// ── Token indexer ─────────────────────────────────────────
async function indexNewTokens(
	tokenFactory: ethers.Contract,
	provider: ethers.Provider,
	chainId: number,
	cs: ChainState
): Promise<number> {
	const currentCount = Number(await tokenFactory.totalTokensCreated());
	if (currentCount <= cs.lastTokenCount) return 0;

	const newCount = currentCount - cs.lastTokenCount;
	console.log(`  📦 ${newCount} new token(s) found`);

	let indexed = 0;
	for (let i = cs.lastTokenCount; i < currentCount; i++) {
		try {
			const tokenAddress = (await tokenFactory.getTokenByIndex(i)).toLowerCase();
			const info = await tokenFactory.tokenInfo(tokenAddress);
			const token = new ethers.Contract(tokenAddress, TOKEN_META_ABI, provider);
			const [name, symbol, decimals, totalSupply] = await Promise.all([
				token.name(), token.symbol(), token.decimals(), token.totalSupply()
			]);

			const ok = await apiPost('/api/created-tokens', {
				address: tokenAddress, chain_id: chainId, creator: info.creator.toLowerCase(),
				name, symbol, decimals: Number(decimals), total_supply: totalSupply.toString(),
				is_mintable: info.isMintable, is_taxable: info.isTaxable, is_partner: info.isPartnership,
			});

			if (ok) {
				console.log(`    ✓ [${i}] ${symbol} (${tokenAddress.slice(0, 10)}...)`);
				indexed++;
				cs.lastTokenCount = i + 1;
			}
		} catch (e: any) {
			console.error(`    ✗ Token #${i}: ${e.message?.slice(0, 80)}`);
			break;
		}
	}
	return indexed;
}

// ── Launch sync ───────────────────────────────────────────
async function syncLaunchFromChain(
	launchAddress: string,
	tokenFactory: ethers.Contract,
	provider: ethers.Provider,
	chainId: number,
	usdtDecimals: number
): Promise<{ ok: boolean; state: number; totalBaseRaised: string }> {
	const addr = launchAddress.toLowerCase();
	const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, provider);

	const [info, totalTokensRequired, totalTokensDeposited] = await Promise.all([
		instance.getLaunchInfo(), instance.totalTokensRequired(), instance.totalTokensDeposited(),
	]);

	const tokenAddr = info.token_;
	const tokenContract = new ethers.Contract(tokenAddr, TOKEN_META_ABI, provider);
	const [name, symbol, decimals] = await Promise.all([
		tokenContract.name().catch(() => 'Unknown'),
		tokenContract.symbol().catch(() => '???'),
		tokenContract.decimals().catch(() => 18),
	]);

	let isPartner = false;
	try { const tInfo = await tokenFactory.tokenInfo(tokenAddr); isPartner = tInfo[3]; } catch {}

	const ok = await apiPost('/api/launches', {
		address: addr, chain_id: chainId, token_address: tokenAddr.toLowerCase(),
		creator: info.creator_.toLowerCase(), curve_type: Number(info.curveType_),
		state: Number(info.state_), soft_cap: info.softCap_.toString(),
		hard_cap: info.hardCap_.toString(), total_base_raised: info.totalBaseRaised_.toString(),
		tokens_sold: info.tokensSold_.toString(), tokens_for_curve: info.tokensForCurve_.toString(),
		tokens_for_lp: info.tokensForLP_.toString(), creator_allocation_bps: Number(info.creatorAllocationBps_),
		current_price: info.currentPrice_.toString(), deadline: Number(info.deadline_),
		start_timestamp: Number(info.startTimestamp_), total_tokens_required: totalTokensRequired.toString(),
		total_tokens_deposited: totalTokensDeposited.toString(), token_name: name,
		token_symbol: symbol, token_decimals: Number(decimals), usdt_decimals: usdtDecimals,
		is_partner: isPartner,
	});
	return { ok, state: Number(info.state_), totalBaseRaised: info.totalBaseRaised_.toString() };
}

async function indexNewLaunches(
	launchpadFactory: ethers.Contract, tokenFactory: ethers.Contract,
	provider: ethers.Provider, chainId: number, usdtDecimals: number, cs: ChainState
): Promise<number> {
	const currentCount = Number(await launchpadFactory.totalLaunches());
	if (currentCount <= cs.lastLaunchCount) return 0;
	const newCount = currentCount - cs.lastLaunchCount;
	console.log(`  🚀 ${newCount} new launch(es) found`);

	for (let i = cs.lastLaunchCount; i < currentCount; i++) {
		try {
			const launchAddress = (await launchpadFactory.launches(i)).toLowerCase();
			const result = await syncLaunchFromChain(launchAddress, tokenFactory, provider, chainId, usdtDecimals);
			if (result.ok) {
				console.log(`    ✓ Launch #${i}: ${launchAddress.slice(0, 10)}...`);
				if (result.state <= 1) {
					let hash = '', purchaseCount = 0;
					try {
						const inst = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, provider);
						hash = await inst.stateHash();
						purchaseCount = Number(await inst.totalPurchases());
					} catch {}
					cs.launches.push({ address: launchAddress, state: result.state, totalBaseRaised: result.totalBaseRaised, stateHash: hash, lastPurchaseCount: purchaseCount });
				}
			}
		} catch (e: any) { console.error(`    ✗ Launch #${i}: ${e.message?.slice(0, 80)}`); }
	}
	cs.lastLaunchCount = currentCount;
	return newCount;
}

async function updateTrackedLaunches(
	tokenFactory: ethers.Contract, provider: ethers.Provider,
	chainId: number, usdtDecimals: number, cs: ChainState
) {
	if (cs.launches.length === 0) return;
	let updated = 0, txSynced = 0;
	const stillActive: LaunchCache[] = [];

	for (const cached of cs.launches) {
		try {
			const instance = new ethers.Contract(cached.address, LAUNCH_INSTANCE_ABI, provider);
			let hash: string;
			try { hash = await instance.stateHash(); }
			catch { const info = await instance.getLaunchInfo(); hash = info.totalBaseRaised_.toString() + '-' + info.state_.toString(); }

			if (hash === cached.stateHash) { if (cached.state <= 1) stillActive.push(cached); continue; }

			const result = await syncLaunchFromChain(cached.address, tokenFactory, provider, chainId, usdtDecimals);
			if (result.ok) updated++;
			cached.state = result.state;
			cached.totalBaseRaised = result.totalBaseRaised;
			cached.stateHash = hash;

			try {
				const totalPurchases = Number(await instance.totalPurchases());
				const newCount = totalPurchases - (cached.lastPurchaseCount || 0);
				if (newCount > 0) {
					const { purchases } = await instance.getPurchases(cached.lastPurchaseCount || 0, newCount);
					for (const p of purchases) {
						await apiPost('/api/launches/transactions', {
							launch_address: cached.address, chain_id: chainId,
							buyer: p.buyer.toLowerCase(), base_amount: p.baseAmount.toString(),
							tokens_received: p.tokensReceived.toString(), fee: p.fee.toString(),
							price: p.price.toString(), timestamp: Number(p.timestamp),
						});
						txSynced++;
					}
					cached.lastPurchaseCount = totalPurchases;
				}
			} catch {}

			if (cached.state <= 1) stillActive.push(cached);
		} catch {}
	}
	cs.launches = stillActive;
	if (updated > 0) console.log(`  🔄 Updated ${updated} launch(es)${txSynced > 0 ? `, ${txSynced} tx(s)` : ''}`);
}

// ── Withdrawal sync ──────────────────────────────────────
async function syncWithdrawals(tradeRouter: ethers.Contract | null, chainId: number, cs: ChainState) {
	if (!tradeRouter) return;
	const totalOnChain = Number(await tradeRouter.totalWithdrawals());
	if (totalOnChain <= cs.lastWithdrawalCount) return;
	const newCount = totalOnChain - cs.lastWithdrawalCount;
	console.log(`  💰 ${newCount} new on-chain withdrawal(s)`);

	for (let i = cs.lastWithdrawalCount; i < totalOnChain; i++) {
		try {
			const req = await tradeRouter.getWithdrawal(i);
			await apiPost('/api/withdrawals/verify', {
				withdraw_id: i, chain_id: chainId, wallet_address: req.user.toLowerCase(),
				gross_amount: req.grossAmount.toString(), fee: req.fee.toString(),
				net_amount: req.netAmount.toString(), status: Number(req.status), bank_ref: req.bankRef,
			});
		} catch {}
	}
	cs.lastWithdrawalCount = totalOnChain;
}

// ── Main loop ────────────────────────────────────────────
async function main() {
	console.log(`\n🔗 Chain Indexer starting on chain ${CHAIN_ID}`);
	console.log(`   API: ${API_BASE}`);
	console.log(`   Poll interval: ${POLL_INTERVAL / 1000}s`);
	console.log(`   State file: ${STATE_FILE}`);

	// Load network config (RPC, addresses) from backend FIRST so the provider
	// uses the DB-managed RPC endpoint. Env RPC_URL is a last-resort fallback.
	const config = await fetchNetworkConfig(CHAIN_ID);
	const rpcUrl = config.rpc || RPC_URL;
	console.log(`   RPC: ${rpcUrl}`);
	const provider = new ethers.JsonRpcProvider(rpcUrl, CHAIN_ID, { staticNetwork: true });

	console.log(`   Network: ${config.name}`);
	console.log(`   TokenFactory: ${config.platform_address}`);
	console.log(`   LaunchpadFactory: ${config.launchpad_address}`);
	if (config.trade_router_address) console.log(`   TradeRouter: ${config.trade_router_address}`);

	const tokenFactory = new ethers.Contract(config.platform_address, TOKEN_FACTORY_ABI, provider);
	const launchpadFactory = new ethers.Contract(config.launchpad_address, LAUNCHPAD_FACTORY_ABI, provider);
	const tradeRouter = config.trade_router_address
		? new ethers.Contract(config.trade_router_address, TRADE_ROUTER_ABI, provider)
		: null;

	let usdtDecimals = 18;
	if (config.usdt_address) {
		try {
			const c = new ethers.Contract(config.usdt_address, ['function decimals() view returns (uint8)'], provider);
			usdtDecimals = Number(await c.decimals());
		} catch {}
	}
	console.log(`   USDT decimals: ${usdtDecimals}`);

	const allState = loadState();
	const cs = getChainState(allState, CHAIN_ID);
	console.log(`   Resuming: tokens=${cs.lastTokenCount}, launches=${cs.lastLaunchCount}, withdrawals=${cs.lastWithdrawalCount}, tracked=${cs.launches.length}\n`);

	let pollCount = 0;
	let running = true;
	process.on('SIGINT', () => { running = false; console.log('\n⏹  Shutting down...'); });
	process.on('SIGTERM', () => { running = false; });

	while (running) {
		try {
			pollCount++;
			const ts = new Date().toLocaleTimeString();
			console.log(`[${ts}] Poll #${pollCount}`);

			try { await indexNewTokens(tokenFactory, provider, CHAIN_ID, cs); } catch (e: any) { console.error(`  ⚠️ Token indexing: ${e.message?.slice(0, 80)}`); }
			saveState(allState);

			try { await indexNewLaunches(launchpadFactory, tokenFactory, provider, CHAIN_ID, usdtDecimals, cs); } catch (e: any) { console.error(`  ⚠️ Launch indexing: ${e.message?.slice(0, 80)}`); }
			saveState(allState);

			try { await updateTrackedLaunches(tokenFactory, provider, CHAIN_ID, usdtDecimals, cs); } catch (e: any) { console.error(`  ⚠️ Launch updates: ${e.message?.slice(0, 80)}`); }
			saveState(allState);

			try { await syncWithdrawals(tradeRouter, CHAIN_ID, cs); } catch (e: any) { console.error(`  ⚠️ Withdrawal sync: ${e.message?.slice(0, 80)}`); }
			saveState(allState);
		} catch (e: any) {
			console.error(`  ❌ Poll error: ${e.message?.slice(0, 120)}`);
		}
		await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
	}

	saveState(allState);
	console.log('✅ Indexer stopped. State saved.');
}

main().catch((e) => { console.error('Fatal error:', e); process.exit(1); });
