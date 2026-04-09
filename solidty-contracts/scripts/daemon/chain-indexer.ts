/**
 * Chain Indexer Daemon
 *
 * One-directional: Chain → DB. Never reads from DB.
 * On-chain is the source of truth.
 *
 * Polls the blockchain for new tokens, launches, and transactions.
 * Posts changes to the backend API via HTTP.
 * Stores state locally in a JSON file.
 *
 * Usage:
 *   npx hardhat run scripts/daemon/chain-indexer.ts --network localhost
 *
 * Environment:
 *   API_BASE_URL   — Backend URL (e.g. https://tokenkrafter.com)
 *   SYNC_SECRET    — Auth token for backend API
 *   POLL_INTERVAL  — Seconds between polls (default: 30)
 *   STATE_FILE     — Path to state JSON (default: ./daemon-state.json)
 */

import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

// ── Config ─────────────────────────────────────────────────
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '30') * 1000;
const API_BASE = process.env.API_BASE_URL || 'http://localhost:5173';
const SYNC_SECRET = process.env.SYNC_SECRET || '';
const STATE_FILE = process.env.STATE_FILE || path.resolve(__dirname, 'daemon-state.json');

if (!SYNC_SECRET) {
	console.warn('⚠️  No SYNC_SECRET set — API calls may be rejected');
}

// ── ABIs ───────────────────────────────────────────────────
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

const LAUNCH_EVENTS_ABI = [
	'event TokensPurchased(address indexed buyer, uint256 baseAmount, uint256 tokensReceived, uint256 fee)',
];

// ── State (local JSON file) ───────────────────────────────
interface LaunchCache {
	address: string;
	state: number;          // last known state (0=pending, 1=active, 2=graduated, 3=refunding)
	totalBaseRaised: string; // last known raised amount
}

interface ChainState {
	lastTokenCount: number;
	lastLaunchCount: number;
	lastWithdrawalCount: number;
	lastSyncedBlock: number;
	launches: LaunchCache[];  // tracked launches (only non-terminal)
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

// ── HTTP helper (POST only — daemon never GETs from DB) ───
async function apiPost(endpoint: string, body: any): Promise<boolean> {
	try {
		const res = await fetch(`${API_BASE}${endpoint}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${SYNC_SECRET}`
			},
			body: JSON.stringify(body)
		});
		return res.ok;
	} catch (e: any) {
		console.error(`    ✗ API ${endpoint}: ${e.message?.slice(0, 80)}`);
		return false;
	}
}

async function apiPatch(endpoint: string, body: any): Promise<boolean> {
	try {
		const res = await fetch(`${API_BASE}${endpoint}`, {
			method: 'PATCH',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${SYNC_SECRET}`
			},
			body: JSON.stringify(body)
		});
		return res.ok;
	} catch (e: any) {
		console.error(`    ✗ API ${endpoint}: ${e.message?.slice(0, 80)}`);
		return false;
	}
}

// ── Network config from backend ──────────────────────────────
interface NetworkConfig {
	chain_id: number;
	name: string;
	platform_address: string;
	launchpad_address: string;
	router_address: string;
	trade_router_address: string;
	dex_router: string;
	usdt_address: string;
	usdc_address?: string;
}

async function fetchNetworkConfig(chainId: number): Promise<NetworkConfig> {
	// Try backend first (this is config, not data — one-time read on startup)
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

	// Fall back to local deployment file
	const deployFile = process.env.DEPLOYMENT_FILE
		|| path.resolve(__dirname, '../../deployments/localhost.json');

	if (!fs.existsSync(deployFile)) {
		console.error(`❌ No backend config and no deployment file at: ${deployFile}`);
		process.exit(1);
	}

	console.log(`   Config loaded from file: ${deployFile}`);
	const d = JSON.parse(fs.readFileSync(deployFile, 'utf-8'));
	return {
		chain_id: chainId,
		name: 'Unknown',
		platform_address: d.TokenFactory,
		launchpad_address: d.LaunchpadFactory,
		router_address: d.PlatformRouter || '',
		trade_router_address: d.TradeRouter || '',
		dex_router: d.DEXRouter || '',
		usdt_address: d.USDT || '',
		usdc_address: d.USDC || '',
	};
}

// ── MultiCallLens — batch reads in one eth_call ──────────
const LENS_PATHS = [
	path.resolve(__dirname, '../../artifacts/contracts/MultiCallLens.sol/MultiCallLens.json'),
	path.resolve(__dirname, 'MultiCallLens.json'),
];
let MultiCallLensArtifact: any = null;
for (const p of LENS_PATHS) {
	try { MultiCallLensArtifact = JSON.parse(fs.readFileSync(p, 'utf-8')); break; } catch {}
}
if (!MultiCallLensArtifact) {
	console.warn('⚠️  MultiCallLens artifact not found — will use per-token fallback');
}

interface LensTokenData {
	addr: string;
	name: string;
	symbol: string;
	decimals: number;
	totalSupply: bigint;
	userBalance: bigint;
	creator: string;
	isMintable: boolean;
	isTaxable: boolean;
	isPartner: boolean;
}

async function batchTokenMeta(
	provider: any,
	tokenAddresses: string[],
	config: NetworkConfig,
): Promise<LensTokenData[]> {
	if (tokenAddresses.length === 0) return [];
	if (!MultiCallLensArtifact) throw new Error('MultiCallLens artifact not loaded');

	const abiCoder = ethers.AbiCoder.defaultAbiCoder();
	const constructorArgs = abiCoder.encode(
		['address', 'address', 'address', 'address', 'address', 'address', 'address[]', 'address[]'],
		[
			config.platform_address,
			config.launchpad_address,
			config.trade_router_address || ethers.ZeroAddress,
			config.usdt_address || ethers.ZeroAddress,
			config.dex_router || ethers.ZeroAddress,
			ethers.ZeroAddress,
			tokenAddresses,
			[]
		]
	);

	const callData = MultiCallLensArtifact.bytecode + constructorArgs.slice(2);
	const raw = await provider.call({ data: callData, gasLimit: 30_000_000 });

	if (!raw || raw === '0x') throw new Error('MultiCallLens returned empty (constructor reverted)');

	const decoded = abiCoder.decode(
		[
			'tuple(address,uint256,uint256,uint256[8],uint256[8],address,uint256,uint256,uint256,address,uint256,uint256,address,uint256,uint256,uint256,bool,bool,uint256)',
			'tuple(address addr,string name,string symbol,uint8 decimals,uint256 totalSupply,uint256 userBalance,address creator,bool isMintable,bool isTaxable,bool isPartner)[]',
			'tuple(address,uint256,uint8)[]'
		],
		raw
	);

	return (decoded[1] as any[]).map((t: any) => ({
		addr: t.addr.toLowerCase(),
		name: t.name || 'Unknown',
		symbol: t.symbol || '???',
		decimals: Number(t.decimals),
		totalSupply: t.totalSupply,
		userBalance: t.userBalance,
		creator: t.creator.toLowerCase(),
		isMintable: t.isMintable,
		isTaxable: t.isTaxable,
		isPartner: t.isPartner,
	}));
}

// ── Token indexer (batch via MultiCallLens) ──────────────
async function indexNewTokens(
	tokenFactory: any,
	provider: any,
	chainId: number,
	cs: ChainState,
	config: NetworkConfig
): Promise<number> {
	const currentCount = Number(await tokenFactory.totalTokensCreated());
	if (currentCount <= cs.lastTokenCount) return 0;

	const newCount = currentCount - cs.lastTokenCount;
	console.log(`  📦 ${newCount} new token(s) found`);

	const { tokens: addresses } = await tokenFactory.getTokens(cs.lastTokenCount, newCount);
	const tokenAddresses: string[] = addresses.map((a: string) => a.toLowerCase());

	let tokenDataBatch: LensTokenData[];
	try {
		tokenDataBatch = await batchTokenMeta(provider, tokenAddresses, config);
		console.log(`    MultiCallLens returned ${tokenDataBatch.length} tokens`);
	} catch (e: any) {
		console.error(`    ✗ MultiCallLens failed: ${e.message?.slice(0, 80)}`);
		console.log(`    Falling back to per-token queries...`);
		return await indexNewTokensFallback(tokenFactory, provider, chainId, cs);
	}

	const startIndex = cs.lastTokenCount;
	let indexed = 0;
	for (let i = 0; i < tokenDataBatch.length; i++) {
		const t = tokenDataBatch[i];
		const typeKey = (t.isTaxable ? 2 : 0) | (t.isMintable ? 1 : 0) | (t.isPartner ? 4 : 0);

		const ok = await apiPost('/api/created-tokens', {
			address: t.addr,
			chain_id: chainId,
			creator: t.creator,
			name: t.name,
			symbol: t.symbol,
			total_supply: t.totalSupply.toString(),
			decimals: t.decimals,
			is_mintable: t.isMintable,
			is_taxable: t.isTaxable,
			is_partner: t.isPartner,
			type_key: typeKey,
		});

		if (ok) {
			const absIndex = startIndex + i;
			console.log(`    ✓ [${absIndex}] ${t.symbol} (${t.addr.slice(0, 10)}...)`);
			indexed++;
			cs.lastTokenCount = absIndex + 1;
		}
	}

	return indexed;
}

async function indexNewTokensFallback(
	tokenFactory: any,
	provider: any,
	chainId: number,
	cs: ChainState
): Promise<number> {
	const currentCount = Number(await tokenFactory.totalTokensCreated());
	let indexed = 0;
	for (let i = cs.lastTokenCount; i < currentCount; i++) {
		try {
			const tokenAddress = (await tokenFactory.getTokenByIndex(i)).toLowerCase();
			const info = await tokenFactory.tokenInfo(tokenAddress);
			const token = new ethers.Contract(tokenAddress, TOKEN_META_ABI, provider);
			const [name, symbol, decimals, totalSupply] = await Promise.all([
				token.name(), token.symbol(), token.decimals(), token.totalSupply()
			]);

			const typeKey = (info.isTaxable ? 2 : 0) | (info.isMintable ? 1 : 0) | (info.isPartnership ? 4 : 0);
			const ok = await apiPost('/api/created-tokens', {
				address: tokenAddress, chain_id: chainId, creator: info.creator.toLowerCase(),
				name, symbol, total_supply: totalSupply.toString(), decimals: Number(decimals),
				is_mintable: info.isMintable, is_taxable: info.isTaxable, is_partner: info.isPartnership,
				type_key: typeKey,
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

// ── Launch sync (from chain only) ─────────────────────────
async function syncLaunchFromChain(
	launchAddress: string,
	tokenFactory: any,
	provider: any,
	chainId: number,
	usdtDecimals: number
): Promise<{ ok: boolean; state: number; totalBaseRaised: string }> {
	const addr = launchAddress.toLowerCase();
	const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, provider);

	const [info, totalTokensRequired, totalTokensDeposited] = await Promise.all([
		instance.getLaunchInfo(),
		instance.totalTokensRequired(),
		instance.totalTokensDeposited(),
	]);

	const tokenAddr = info.token_;
	const tokenContract = new ethers.Contract(tokenAddr, TOKEN_META_ABI, provider);
	const [name, symbol, decimals] = await Promise.all([
		tokenContract.name().catch(() => 'Unknown'),
		tokenContract.symbol().catch(() => '???'),
		tokenContract.decimals().catch(() => 18),
	]);

	let isPartner = false;
	try {
		const tInfo = await tokenFactory.tokenInfo(tokenAddr);
		isPartner = tInfo[3];
	} catch {}

	const row = {
		address: addr,
		chain_id: chainId,
		token_address: tokenAddr.toLowerCase(),
		creator: info.creator_.toLowerCase(),
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
		total_tokens_required: totalTokensRequired.toString(),
		total_tokens_deposited: totalTokensDeposited.toString(),
		token_name: name,
		token_symbol: symbol,
		token_decimals: Number(decimals),
		usdt_decimals: usdtDecimals,
		is_partner: isPartner,
	};

	const ok = await apiPost('/api/launches', row);
	return { ok, state: Number(info.state_), totalBaseRaised: info.totalBaseRaised_.toString() };
}

// ── Index new launches ────────────────────────────────────
async function indexNewLaunches(
	launchpadFactory: any,
	tokenFactory: any,
	provider: any,
	chainId: number,
	usdtDecimals: number,
	cs: ChainState
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
				// Track non-terminal launches for updates
				if (result.state <= 1) {
					cs.launches.push({ address: launchAddress, state: result.state, totalBaseRaised: result.totalBaseRaised });
				}
			}
		} catch (e: any) {
			console.error(`    ✗ Launch #${i}: ${e.message?.slice(0, 80)}`);
		}
	}

	cs.lastLaunchCount = currentCount;
	return newCount;
}

// ── Update tracked launches (from chain, no DB reads) ─────
async function updateTrackedLaunches(
	tokenFactory: any,
	provider: any,
	chainId: number,
	usdtDecimals: number,
	cs: ChainState
) {
	if (cs.launches.length === 0) return;

	let updated = 0;
	const stillActive: LaunchCache[] = [];

	for (const cached of cs.launches) {
		try {
			const instance = new ethers.Contract(cached.address, LAUNCH_INSTANCE_ABI, provider);
			const info = await instance.getLaunchInfo();
			const currentState = Number(info.state_);
			const currentRaised = info.totalBaseRaised_.toString();

			// Only sync to DB if something changed
			if (currentState !== cached.state || currentRaised !== cached.totalBaseRaised) {
				const result = await syncLaunchFromChain(cached.address, tokenFactory, provider, chainId, usdtDecimals);
				if (result.ok) updated++;
				cached.state = currentState;
				cached.totalBaseRaised = currentRaised;
			}

			// Keep tracking if still non-terminal (pending or active)
			if (currentState <= 1) {
				stillActive.push(cached);
			}
		} catch {}
	}

	cs.launches = stillActive;
	if (updated > 0) console.log(`  🔄 Updated ${updated} launch(es)`);
}

// ── Index buy events (uses tracked launches, no DB reads) ─
async function indexEvents(
	provider: any,
	chainId: number,
	cs: ChainState
) {
	const currentBlock = await provider.getBlockNumber();
	const fromBlock = cs.lastSyncedBlock > 0
		? cs.lastSyncedBlock + 1
		: Math.max(0, currentBlock - 100);

	if (fromBlock > currentBlock) return;

	const launchIface = new ethers.Interface(LAUNCH_EVENTS_ABI);
	let txCount = 0;

	// Only scan active launches from local state — no DB read
	for (const launch of cs.launches.filter(l => l.state === 1)) {
		try {
			const logs = await provider.getLogs({
				address: launch.address,
				fromBlock,
				toBlock: currentBlock,
				topics: [launchIface.getEvent('TokensPurchased')!.topicHash],
			});

			for (const log of logs) {
				try {
					const parsed = launchIface.parseLog({ topics: [...log.topics], data: log.data });
					if (!parsed) continue;

					const ok = await apiPost('/api/launches/transactions', {
						launch_address: launch.address,
						chain_id: chainId,
						buyer: parsed.args[0].toLowerCase(),
						base_amount: parsed.args[1].toString(),
						tokens_received: parsed.args[2].toString(),
						tx_hash: log.transactionHash,
					});

					if (ok) txCount++;
				} catch {}
			}
		} catch {}
	}

	if (txCount > 0) {
		console.log(`  📝 Indexed ${txCount} transaction(s) from blocks ${fromBlock}–${currentBlock}`);
	}

	cs.lastSyncedBlock = currentBlock;
}

// ── Sync withdrawals (from chain only) ────────────────────
async function syncWithdrawals(
	tradeRouter: any | null,
	chainId: number,
	cs: ChainState
) {
	if (!tradeRouter) return;

	const totalOnChain = Number(await tradeRouter.totalWithdrawals());
	if (totalOnChain <= cs.lastWithdrawalCount) return;

	const newCount = totalOnChain - cs.lastWithdrawalCount;
	console.log(`  💰 ${newCount} new on-chain withdrawal(s)`);

	for (let i = cs.lastWithdrawalCount; i < totalOnChain; i++) {
		try {
			const req = await tradeRouter.getWithdrawal(i);
			await apiPost('/api/withdrawals/verify', {
				withdraw_id: i,
				chain_id: chainId,
				wallet_address: req.user.toLowerCase(),
				gross_amount: req.grossAmount.toString(),
				fee: req.fee.toString(),
				net_amount: req.netAmount.toString(),
				status: Number(req.status),
				bank_ref: req.bankRef,
			});
		} catch {}
	}

	cs.lastWithdrawalCount = totalOnChain;
}

// ── Main loop ──────────────────────────────────────────────
async function main() {
	const [signer] = await ethers.getSigners();
	const provider = signer.provider!;
	const network = await provider.getNetwork();
	const chainId = Number(network.chainId);

	console.log(`\n🔗 Chain Indexer starting on chain ${chainId}`);
	console.log(`   API: ${API_BASE}`);
	console.log(`   Poll interval: ${POLL_INTERVAL / 1000}s`);
	console.log(`   State file: ${STATE_FILE}`);

	const config = await fetchNetworkConfig(chainId);
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
			const usdtContract = new ethers.Contract(config.usdt_address, ['function decimals() view returns (uint8)'], provider);
			usdtDecimals = Number(await usdtContract.decimals());
		} catch {}
	}
	console.log(`   USDT decimals: ${usdtDecimals}`);

	const allState = loadState();
	const cs = getChainState(allState, chainId);
	console.log(`   Resuming from: tokens=${cs.lastTokenCount}, launches=${cs.lastLaunchCount}, withdrawals=${cs.lastWithdrawalCount}, block=${cs.lastSyncedBlock}, tracked=${cs.launches.length}\n`);

	let pollCount = 0;
	let running = true;
	process.on('SIGINT', () => { running = false; console.log('\n⏹  Shutting down...'); });
	process.on('SIGTERM', () => { running = false; });

	while (running) {
		try {
			pollCount++;
			const ts = new Date().toLocaleTimeString();
			console.log(`[${ts}] Poll #${pollCount}`);

			// 1. Index new tokens (chain → DB)
			try { await indexNewTokens(tokenFactory, provider, chainId, cs, config); } catch (e: any) { console.error(`  ⚠️ Token indexing: ${e.message?.slice(0, 80)}`); }
			saveState(allState);

			// 2. Index new launches (chain → DB, adds to tracked list)
			try { await indexNewLaunches(launchpadFactory, tokenFactory, provider, chainId, usdtDecimals, cs); } catch (e: any) { console.error(`  ⚠️ Launch indexing: ${e.message?.slice(0, 80)}`); }
			saveState(allState);

			// 3. Update tracked launches (chain → compare → DB only if changed)
			try { await updateTrackedLaunches(tokenFactory, provider, chainId, usdtDecimals, cs); } catch (e: any) { console.error(`  ⚠️ Launch updates: ${e.message?.slice(0, 80)}`); }
			saveState(allState);

			// 4. Index buy events (uses tracked launches from local state)
			try { await indexEvents(provider, chainId, cs); } catch (e: any) { console.error(`  ⚠️ Event indexing: ${e.message?.slice(0, 80)}`); }
			saveState(allState);

			// 5. Sync new withdrawals (chain → DB, only new ones)
			try { await syncWithdrawals(tradeRouter, chainId, cs); } catch (e: any) { console.error(`  ⚠️ Withdrawal sync: ${e.message?.slice(0, 80)}`); }
			saveState(allState);
		} catch (e: any) {
			console.error(`  ❌ Poll error: ${e.message?.slice(0, 120)}`);
		}

		await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
	}

	saveState(allState);
	console.log('✅ Indexer stopped. State saved.');
}

main().catch((e) => {
	console.error('Fatal error:', e);
	process.exit(1);
});
