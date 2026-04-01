/**
 * Chain Indexer Daemon
 *
 * Polls the blockchain for new tokens, launches, and transactions,
 * then syncs them to Supabase. Replaces public POST endpoints with
 * server-side indexing — the chain is the source of truth.
 *
 * Usage:
 *   npx hardhat run scripts/daemon/chain-indexer.ts --network localhost
 *
 * Environment:
 *   SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_KEY   — Supabase service role key
 *   POLL_INTERVAL          — Seconds between polls (default: 10)
 *   DEPLOYMENT_FILE        — Path to deployment JSON (default: auto-detect)
 */

import { ethers } from 'hardhat';
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

// ── Config ─────────────────────────────────────────────────
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '10') * 1000;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
	console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
	process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── ABIs ───────────────────────────────────────────────────
const TOKEN_FACTORY_ABI = [
	'function totalTokensCreated() view returns (uint256)',
	'function tokenInfo(address) view returns (address creator, bool isMintable, bool isTaxable, bool isPartnership)',
	'function tokensCreatedByType(uint8) view returns (uint256)',
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
	'function owner() view returns (address)',
];

const TRADE_ROUTER_ABI = [
	'function totalWithdrawals() view returns (uint256)',
	'function getWithdrawal(uint256 id) view returns (tuple(address user, address token, uint256 grossAmount, uint256 fee, uint256 netAmount, uint256 createdAt, uint8 status, bytes32 bankRef))',
];

// ── Events for transaction indexing ────────────────────────
const LAUNCH_EVENTS_ABI = [
	'event TokensPurchased(address indexed buyer, uint256 baseAmount, uint256 tokensReceived, uint256 fee)',
	'event Refunded(address indexed buyer, uint256 baseReturned, uint256 tokensReturned)',
	'event Graduated(address indexed trigger, uint256 totalRaised, address lpPair)',
];

const TRADE_EVENTS_ABI = [
	'event Swap(address indexed user, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)',
	'event WithdrawRequested(uint256 indexed id, address indexed user, address token, uint256 grossAmount, uint256 fee, uint256 netAmount, bytes32 bankRef)',
	'event WithdrawConfirmed(uint256 indexed id, address indexed admin)',
	'event WithdrawCancelled(uint256 indexed id, address indexed user)',
];

// ── State tracking ─────────────────────────────────────────
interface IndexerState {
	lastTokenCount: number;
	lastLaunchCount: number;
	lastWithdrawalCount: number;
	lastSyncedBlock: number;
}

const STATE_KEY = 'chain_indexer_state';

async function loadState(chainId: number): Promise<IndexerState> {
	const { data } = await supabase
		.from('platform_config')
		.select('value')
		.eq('key', `${STATE_KEY}_${chainId}`)
		.single();

	if (data?.value) {
		return data.value as IndexerState;
	}
	return { lastTokenCount: 0, lastLaunchCount: 0, lastWithdrawalCount: 0, lastSyncedBlock: 0 };
}

async function saveState(chainId: number, state: IndexerState) {
	await supabase
		.from('platform_config')
		.upsert({
			key: `${STATE_KEY}_${chainId}`,
			value: state
		}, { onConflict: 'key' });
}

// ── Load deployment addresses ──────────────────────────────
function loadDeployment(): Record<string, string> {
	const deployFile = process.env.DEPLOYMENT_FILE
		|| path.resolve(__dirname, '../../deployments/localhost.json');

	if (!fs.existsSync(deployFile)) {
		console.error(`❌ Deployment file not found: ${deployFile}`);
		process.exit(1);
	}

	return JSON.parse(fs.readFileSync(deployFile, 'utf-8'));
}

// ── Token indexer (event-based) ─────────────────────────────
// TokenFactory stores tokens per-creator, not in a global array.
// We use TokenCreated events to discover new tokens since last poll.
async function indexNewTokens(
	tokenFactory: any,
	provider: any,
	chainId: number,
	state: IndexerState
): Promise<number> {
	const currentCount = Number(await tokenFactory.totalTokensCreated());
	if (currentCount <= state.lastTokenCount) return 0;

	const newCount = currentCount - state.lastTokenCount;
	console.log(`  📦 ${newCount} new token(s) found`);

	// Scan TokenCreated events from recent blocks
	const currentBlock = await provider.getBlockNumber();
	const fromBlock = state.lastSyncedBlock > 0
		? Math.max(0, state.lastSyncedBlock - 10) // small overlap for safety
		: Math.max(0, currentBlock - 1000);

	const factoryAddress = await tokenFactory.getAddress();
	const iface = tokenFactory.interface;
	const topicHash = iface.getEvent('TokenCreated')!.topicHash;

	const logs = await provider.getLogs({
		address: factoryAddress,
		fromBlock,
		toBlock: currentBlock,
		topics: [topicHash],
	});

	let indexed = 0;
	for (const log of logs) {
		try {
			const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
			if (!parsed) continue;

			const creator = parsed.args[0].toLowerCase();
			const tokenAddress = parsed.args[1].toLowerCase();
			const tokenType = Number(parsed.args[2]);
			const name = parsed.args[3];
			const symbol = parsed.args[4];
			const totalSupply = parsed.args[5].toString();
			const decimals = Number(parsed.args[6]);

			const isMintable = (tokenType & 1) !== 0;
			const isTaxable = (tokenType & 2) !== 0;
			const isPartner = (tokenType & 4) !== 0;

			await supabase.from('created_tokens').upsert({
				address: tokenAddress,
				chain_id: chainId,
				creator,
				name,
				symbol,
				total_supply: totalSupply,
				decimals,
				is_mintable: isMintable,
				is_taxable: isTaxable,
				is_partner: isPartner,
				type_key: tokenType,
			}, { onConflict: 'address,chain_id' });

			console.log(`    ✓ Token: ${symbol} (${tokenAddress.slice(0, 10)}...)`);
			indexed++;
		} catch (e: any) {
			console.error(`    ✗ Token event: ${e.message?.slice(0, 80)}`);
		}
	}

	state.lastTokenCount = currentCount;
	return indexed;
}

// ── Launch indexer ─────────────────────────────────────────
async function indexNewLaunches(
	launchpadFactory: any,
	tokenFactory: any,
	chainId: number,
	usdtDecimals: number,
	state: IndexerState
): Promise<number> {
	const currentCount = Number(await launchpadFactory.totalLaunches());
	if (currentCount <= state.lastLaunchCount) return 0;

	const newCount = currentCount - state.lastLaunchCount;
	console.log(`  🚀 ${newCount} new launch(es) found`);

	const provider = launchpadFactory.runner?.provider as any;
	if (!provider) return 0;

	for (let i = state.lastLaunchCount; i < currentCount; i++) {
		try {
			const launchAddress = await launchpadFactory.launches(i);
			await syncLaunch(launchAddress, tokenFactory, provider, chainId, usdtDecimals);
			console.log(`    ✓ Launch #${i}: ${launchAddress.slice(0, 10)}...`);
		} catch (e: any) {
			console.error(`    ✗ Launch #${i}: ${e.message?.slice(0, 80)}`);
		}
	}

	state.lastLaunchCount = currentCount;
	return newCount;
}

// ── Sync a single launch (new or update) ───────────────────
async function syncLaunch(
	launchAddress: string,
	tokenFactory: any,
	provider: any,
	chainId: number,
	usdtDecimals: number
) {
	const addr = launchAddress.toLowerCase();
	const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, provider);

	const [info, totalTokensRequired, totalTokensDeposited] = await Promise.all([
		instance.getLaunchInfo(),
		instance.totalTokensRequired(),
		instance.totalTokensDeposited(),
	]);

	// Token metadata
	const tokenAddr = info.token_;
	const tokenContract = new ethers.Contract(tokenAddr, TOKEN_META_ABI, provider);
	const [name, symbol, decimals] = await Promise.all([
		tokenContract.name().catch(() => 'Unknown'),
		tokenContract.symbol().catch(() => '???'),
		tokenContract.decimals().catch(() => 18),
	]);

	// Token properties from factory
	let isPartner = false, isMintable = false, isTaxable = false, isRenounced = false;
	try {
		const tInfo = await tokenFactory.tokenInfo(tokenAddr);
		isMintable = tInfo[1];
		isTaxable = tInfo[2];
		isPartner = tInfo[3];
	} catch {}

	try {
		const owner = await tokenContract.owner();
		isRenounced = owner === ethers.ZeroAddress;
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

	await supabase
		.from('launches')
		.upsert(row, { onConflict: 'address,chain_id' });

	// Auto-detect badges
	const badges: { badge_type: string; granted_by: string }[] = [];
	if (isMintable) badges.push({ badge_type: 'mintable', granted_by: 'system' });
	if (isTaxable) badges.push({ badge_type: 'taxable', granted_by: 'system' });
	if (isPartner) badges.push({ badge_type: 'partner', granted_by: 'system' });
	if (isRenounced) badges.push({ badge_type: 'renounced', granted_by: 'system' });

	for (const b of badges) {
		await supabase.from('badges').upsert({
			launch_address: addr,
			chain_id: chainId,
			badge_type: b.badge_type,
			granted_by: b.granted_by,
		}, { onConflict: 'launch_address,chain_id,badge_type' });
	}

	if (!isRenounced) {
		await supabase.from('badges')
			.delete()
			.eq('launch_address', addr)
			.eq('chain_id', chainId)
			.eq('badge_type', 'renounced')
			.eq('granted_by', 'system');
	}
}

// ── Update existing launches (state changes, price, raised) ──
async function updateActiveLaunches(
	_launchpadFactory: any,
	tokenFactory: any,
	provider: any,
	chainId: number,
	usdtDecimals: number
) {
	// Get active launches from DB
	const { data: activeLaunches } = await supabase
		.from('launches')
		.select('address')
		.eq('chain_id', chainId)
		.in('state', [0, 1]); // Pending + Active

	if (!activeLaunches?.length) return;

	let updated = 0;
	for (const launch of activeLaunches) {
		try {
			await syncLaunch(launch.address, tokenFactory, provider, chainId, usdtDecimals);
			updated++;
		} catch {}
	}

	if (updated > 0) {
		console.log(`  🔄 Updated ${updated} active launch(es)`);
	}
}

// ── Index events (buys, swaps) from recent blocks ──────────
async function indexEvents(
	_launchpadFactory: any,
	tradeRouter: any | null,
	provider: any,
	chainId: number,
	state: IndexerState
) {
	const currentBlock = await provider.getBlockNumber();
	// On first run, only look back 100 blocks to avoid huge scans
	const fromBlock = state.lastSyncedBlock > 0
		? state.lastSyncedBlock + 1
		: Math.max(0, currentBlock - 100);

	if (fromBlock > currentBlock) return;

	// Index launch buy events from all known active launches
	const { data: launches } = await supabase
		.from('launches')
		.select('address, token_symbol, token_name, token_decimals, usdt_decimals')
		.eq('chain_id', chainId)
		.in('state', [1, 2]); // Active + Graduated

	const launchIface = new ethers.Interface(LAUNCH_EVENTS_ABI);
	let txCount = 0;

	for (const launch of launches || []) {
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

					const buyer = parsed.args[0].toLowerCase();
					const baseAmount = parsed.args[1].toString();
					const tokensReceived = parsed.args[2].toString();
					const txHash = log.transactionHash;

					// Check if tx already indexed
					const { count } = await supabase
						.from('launch_transactions')
						.select('id', { count: 'exact', head: true })
						.eq('tx_hash', txHash);
					if ((count ?? 0) > 0) continue; // already indexed

					// Insert into launch_transactions
					await supabase.from('launch_transactions').insert({
						launch_address: launch.address,
						chain_id: chainId,
						buyer,
						base_amount: baseAmount,
						tokens_received: tokensReceived,
						tx_hash: txHash,
					});

					// Insert into recent_transactions feed
					await supabase.from('recent_transactions').insert({
						chain_id: chainId,
						launch_address: launch.address,
						token_symbol: launch.token_symbol || '???',
						token_name: launch.token_name || 'Unknown',
						buyer,
						tokens_amount: ethers.formatUnits(tokensReceived, launch.token_decimals || 18),
						base_amount: ethers.formatUnits(baseAmount, launch.usdt_decimals || 6),
						base_symbol: 'USDT',
						base_decimals: launch.usdt_decimals || 6,
						token_decimals: launch.token_decimals || 18,
						tx_hash: txHash,
					});

					txCount++;
				} catch {}
			}
		} catch {}
	}

	// Index trade router swap events
	if (tradeRouter) {
		try {
			const tradeIface = new ethers.Interface(TRADE_EVENTS_ABI);
			const swapLogs = await provider.getLogs({
				address: await tradeRouter.getAddress(),
				fromBlock,
				toBlock: currentBlock,
				topics: [tradeIface.getEvent('Swap')!.topicHash],
			});

			for (const log of swapLogs) {
				try {
					const parsed = tradeIface.parseLog({ topics: [...log.topics], data: log.data });
					if (!parsed) continue;

					const { count: swapExists } = await supabase
						.from('recent_transactions')
						.select('id', { count: 'exact', head: true })
						.eq('tx_hash', log.transactionHash);
					if ((swapExists ?? 0) > 0) continue;

					await supabase.from('recent_transactions').insert({
						chain_id: chainId,
						launch_address: await tradeRouter.getAddress(),
						token_symbol: 'SWAP',
						token_name: 'Trade',
						buyer: parsed.args[0].toLowerCase(),
						tokens_amount: parsed.args[4].toString(),
						base_amount: parsed.args[3].toString(),
						base_symbol: 'TOKEN',
						base_decimals: 18,
						token_decimals: 18,
						tx_hash: log.transactionHash,
					});

					txCount++;
				} catch {}
			}
		} catch {}
	}

	if (txCount > 0) {
		console.log(`  📝 Indexed ${txCount} transaction(s) from blocks ${fromBlock}–${currentBlock}`);
	}

	state.lastSyncedBlock = currentBlock;
}

// ── Sync withdrawal statuses ───────────────────────────────
async function syncWithdrawals(
	tradeRouter: any | null,
	chainId: number,
	state: IndexerState
) {
	if (!tradeRouter) return;

	const totalOnChain = Number(await tradeRouter.totalWithdrawals());
	let synced = 0;
	let matched = 0;

	// ── Part 1: Match new on-chain withdrawals to orphaned awaiting_trade records ──
	// (handles browser crash after on-chain deposit but before verify API call)
	if (totalOnChain > state.lastWithdrawalCount) {
		const newCount = totalOnChain - state.lastWithdrawalCount;
		console.log(`  💰 ${newCount} new on-chain withdrawal(s) found`);

		// Get all awaiting_trade records for this chain
		const { data: orphans } = await supabase
			.from('withdrawal_requests')
			.select('id, wallet_address, payment_method, payment_details')
			.eq('chain_id', chainId)
			.eq('status', 'awaiting_trade');

		// Build bankRef map from orphaned records
		const orphanMap = new Map<string, any>();
		for (const record of orphans || []) {
			const details = record.payment_details || {};
			let bankRef: string;
			if (record.payment_method === 'bank') {
				bankRef = ethers.id(`bank:${details.bank_code}:${details.account}:${details.holder}`);
			} else if (record.payment_method === 'paypal') {
				bankRef = ethers.id(`paypal:${details.email}`);
			} else if (record.payment_method === 'wise') {
				bankRef = ethers.id(`wise:${details.email}:${details.currency || 'NGN'}`);
			} else {
				continue;
			}
			orphanMap.set(bankRef, record);
		}

		// Fetch each new on-chain withdrawal and try to match
		for (let i = state.lastWithdrawalCount; i < totalOnChain; i++) {
			try {
				const req = await tradeRouter.getWithdrawal(i);
				const onChainUser = req.user.toLowerCase();
				const onChainBankRef = req.bankRef;

				const matchedRecord = orphanMap.get(onChainBankRef);
				if (matchedRecord && matchedRecord.wallet_address === onChainUser) {
					// Match found — promote to pending with verified on-chain data
					await supabase
						.from('withdrawal_requests')
						.update({
							withdraw_id: i,
							gross_amount: req.grossAmount.toString(),
							fee: req.fee.toString(),
							net_amount: req.netAmount.toString(),
							token_in: req.token.toLowerCase(),
							status: Number(req.status) === 0 ? 'pending' : Number(req.status) === 1 ? 'confirmed' : 'cancelled',
							updated_at: new Date().toISOString(),
						})
						.eq('id', matchedRecord.id);

					orphanMap.delete(onChainBankRef);
					matched++;
					console.log(`    ✓ Matched withdrawal #${i} to DB record #${matchedRecord.id} (${onChainUser.slice(0, 8)}...)`);
				}
			} catch {}
		}

		state.lastWithdrawalCount = totalOnChain;
	}

	// ── Part 2: Sync status of known pending withdrawals ──
	const { data: pending } = await supabase
		.from('withdrawal_requests')
		.select('id, withdraw_id, status')
		.eq('chain_id', chainId)
		.eq('status', 'pending')
		.gt('withdraw_id', 0);

	for (const row of pending || []) {
		try {
			const req = await tradeRouter.getWithdrawal(row.withdraw_id);
			const onChainStatus = Number(req.status);

			// 0=Pending, 1=Confirmed, 2=Cancelled
			let newStatus: string | null = null;
			if (onChainStatus === 1) newStatus = 'confirmed';
			else if (onChainStatus === 2) newStatus = 'cancelled';

			if (newStatus) {
				await supabase
					.from('withdrawal_requests')
					.update({
						status: newStatus,
						updated_at: new Date().toISOString(),
						...(newStatus === 'confirmed' ? { confirmed_at: new Date().toISOString() } : {}),
					})
					.eq('id', row.id);
				synced++;
			}
		} catch {}
	}

	if (matched > 0) console.log(`  🔗 Matched ${matched} orphaned withdrawal(s) to on-chain trades`);
	if (synced > 0) console.log(`  💰 Synced ${synced} withdrawal status(es)`);
}

// ── Clean up stale awaiting_trade records ───────────────────
async function cleanupStaleRecords() {
	// Remove awaiting_trade records older than 30 minutes (user abandoned flow)
	const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();

	const { count } = await supabase
		.from('withdrawal_requests')
		.delete({ count: 'exact' })
		.eq('status', 'awaiting_trade')
		.lt('created_at', cutoff);

	if (count && count > 0) {
		console.log(`  🧹 Cleaned ${count} stale awaiting_trade record(s)`);
	}
}

// ── Main loop ──────────────────────────────────────────────
async function main() {
	const deployment = loadDeployment();
	const [signer] = await ethers.getSigners();
	const provider = signer.provider!;
	const network = await provider.getNetwork();
	const chainId = Number(network.chainId);

	console.log(`\n🔗 Chain Indexer starting on chain ${chainId}`);
	console.log(`   Poll interval: ${POLL_INTERVAL / 1000}s`);
	console.log(`   TokenFactory: ${deployment.TokenFactory}`);
	console.log(`   LaunchpadFactory: ${deployment.LaunchpadFactory}`);
	if (deployment.TradeRouter) console.log(`   TradeRouter: ${deployment.TradeRouter}`);

	const tokenFactory = new ethers.Contract(deployment.TokenFactory, TOKEN_FACTORY_ABI, provider);
	const launchpadFactory = new ethers.Contract(deployment.LaunchpadFactory, LAUNCHPAD_FACTORY_ABI, provider);
	const tradeRouter = deployment.TradeRouter
		? new ethers.Contract(deployment.TradeRouter, TRADE_ROUTER_ABI, provider)
		: null;

	// USDT decimals (6 for real USDT, check from deployment)
	const usdtDecimals = 6;

	let state = await loadState(chainId);
	console.log(`   Resuming from: tokens=${state.lastTokenCount}, launches=${state.lastLaunchCount}, block=${state.lastSyncedBlock}\n`);

	let pollCount = 0;

	// Graceful shutdown
	let running = true;
	process.on('SIGINT', () => { running = false; console.log('\n⏹  Shutting down...'); });
	process.on('SIGTERM', () => { running = false; });

	while (running) {
		try {
			pollCount++;
			const ts = new Date().toLocaleTimeString();
			console.log(`[${ts}] Poll #${pollCount}`);

			// 1. Index new tokens
			await indexNewTokens(tokenFactory, provider, chainId, state);

			// 2. Index new launches
			await indexNewLaunches(launchpadFactory, tokenFactory, chainId, usdtDecimals, state);

			// 3. Update active launches (state, price, raised amount)
			await updateActiveLaunches(launchpadFactory, tokenFactory, provider, chainId, usdtDecimals);

			// 4. Index events from recent blocks (buys, swaps)
			await indexEvents(launchpadFactory, tradeRouter, provider, chainId, state);

			// 5. Sync withdrawal statuses
			await syncWithdrawals(tradeRouter, chainId, state);

			// 6. Cleanup stale records (every 10th poll)
			if (pollCount % 10 === 0) {
				await cleanupStaleRecords();
			}

			// Save state
			await saveState(chainId, state);
		} catch (e: any) {
			console.error(`  ❌ Poll error: ${e.message?.slice(0, 120)}`);
		}

		// Wait for next poll
		await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
	}

	// Final save
	await saveState(chainId, state);
	console.log('✅ Indexer stopped. State saved.');
}

main().catch((e) => {
	console.error('Fatal error:', e);
	process.exit(1);
});
