/**
 * TokenKrafter Launch Buy Bot
 *
 * Drives synthetic buy activity on a single LaunchInstance. Derives N wallets
 * from a mnemonic; wallet[0] (the "treasurer") holds the pooled BNB + USDT
 * the operator deposits, scatters equal shares to wallets [1..N-1], then all
 * N wallets randomly buy from the launch in a loop.
 *
 * Operator flow:
 *   1. Derive wallet[0] from BOT_MNEMONIC and send it BNB (gas) + USDT (buy budget)
 *   2. Run the daemon. On first start (or any time other wallets are below
 *      target), wallet[0] scatters equal shares of its balance to the rest.
 *   3. Bot loops: pick a random wallet → pick a random USDT amount → approve
 *      USDT to the LaunchInstance → buy with path=[USDT, USDT] (no swap).
 *   4. Sleep a random duration in [MIN_WAIT_SEC, MAX_WAIT_SEC] and repeat.
 *
 * Env vars:
 *   RPC_URL          — BSC RPC (default bsc-dataseed)
 *   CHAIN_ID         — 56
 *   BOT_MNEMONIC     — 12/24-word mnemonic; wallet[0] is the treasurer
 *   WALLET_COUNT     — Total derived wallets including treasurer (default 10)
 *   LAUNCH_ADDRESS   — LaunchInstance address to buy from (required)
 *   USDT_ADDRESS     — Override; otherwise read from launch.usdt()
 *   MIN_WAIT_SEC     — Lower bound on inter-buy delay (default 60)
 *   MAX_WAIT_SEC     — Upper bound on inter-buy delay (default 600)
 *   MIN_BUY_USDT     — Lower bound on per-buy USDT amount (default 5)
 *   MAX_BUY_USDT     — Upper bound on per-buy USDT amount (default 25)
 *   SLIPPAGE_BPS     — Slippage tolerance for minTokensOut (default 500 = 5%)
 *   GAS_RESERVE_BNB  — BNB held back from scatter for treasurer's tx fees (default 0.005)
 *   API_BASE_URL     — Used to fetch chain config when USDT_ADDRESS isn't set
 *   SYNC_SECRET      — Auth header for /api/config
 *   STATE_FILE       — Persistence path (default ./launch-buy-bot-state.json)
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { createManagedProvider } from '../lib/provider';

// ── Config ──
const WALLET_COUNT = Math.max(1, parseInt(process.env.WALLET_COUNT || '10', 10));
const LAUNCH_ADDRESS = (process.env.LAUNCH_ADDRESS || '').trim();
const USDT_ADDRESS_ENV = (process.env.USDT_ADDRESS || '').trim();
const MIN_WAIT_SEC = Math.max(1, parseInt(process.env.MIN_WAIT_SEC || '60', 10));
const MAX_WAIT_SEC = Math.max(MIN_WAIT_SEC, parseInt(process.env.MAX_WAIT_SEC || '600', 10));
const MIN_BUY_USDT = ethers.parseUnits(process.env.MIN_BUY_USDT || '5', 18);
const MAX_BUY_USDT = ethers.parseUnits(process.env.MAX_BUY_USDT || '25', 18);
const SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS || '500');
const GAS_RESERVE_BNB = ethers.parseEther(process.env.GAS_RESERVE_BNB || '0.005');
const API_BASE = process.env.API_BASE_URL || 'https://tokenkrafter.com';
const SYNC_SECRET = process.env.SYNC_SECRET || '';
const STATE_FILE = process.env.STATE_FILE
	|| path.resolve(import.meta.dirname || __dirname, 'launch-buy-bot-state.json');

const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const randBigInt = (min: bigint, max: bigint): bigint => {
	if (max <= min) return min;
	const span = max - min + 1n;
	// 64 bits of randomness is plenty for USDT ranges in 1e18 units.
	const r = BigInt(Math.floor(Math.random() * Number(1n << 53n)));
	return min + (r % span);
};

// ── ABIs ──
const LAUNCH_ABI = [
	'function buy(address[] path, uint256 amountIn, uint256 minUsdtOut, uint256 minTokensOut) payable',
	'function previewBuy(uint256 baseAmount) view returns (uint256 tokensOut, uint256 fee, uint256 priceImpactBps)',
	'function previewBuyFor(address buyer, uint256 baseAmount) view returns (uint256 tokensOut, uint256 fee, uint256 priceImpactBps)',
	'function minBuyUsdt() view returns (uint256)',
	'function maxBuyPerWallet() view returns (uint256)',
	'function basePaid(address) view returns (uint256)',
	'function usdt() view returns (address)',
	'function token() view returns (address)',
	'function getCurrentState() view returns (uint8)',
];

const ERC20_ABI = [
	'function balanceOf(address) view returns (uint256)',
	'function approve(address spender, uint256 amount) returns (bool)',
	'function allowance(address owner, address spender) view returns (uint256)',
	'function transfer(address to, uint256 amount) returns (bool)',
	'function decimals() view returns (uint8)',
	'function symbol() view returns (string)',
];

// ── State ──
interface State {
	scatterDone: boolean;
	totalBuys: number;
	totalUsdtSpent: string; // bigint as decimal string
	lastError: string;
}

function loadState(): State {
	try {
		if (fs.existsSync(STATE_FILE)) {
			const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
			return {
				scatterDone: !!raw.scatterDone,
				totalBuys: raw.totalBuys || 0,
				totalUsdtSpent: raw.totalUsdtSpent || '0',
				lastError: raw.lastError || '',
			};
		}
	} catch {}
	return { scatterDone: false, totalBuys: 0, totalUsdtSpent: '0', lastError: '' };
}

function saveState(s: State) {
	fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ── Wallet derivation ──
function deriveWallets(mnemonic: string, count: number, provider: ethers.Provider): ethers.Wallet[] {
	const hdNode = ethers.HDNodeWallet.fromMnemonic(
		ethers.Mnemonic.fromPhrase(mnemonic),
		"m/44'/60'/0'/0",
	);
	const wallets: ethers.Wallet[] = [];
	for (let i = 0; i < count; i++) {
		const child = hdNode.deriveChild(i);
		wallets.push(new ethers.Wallet(child.privateKey, provider));
	}
	return wallets;
}

// ── Scatter logic ──
//
// Idempotent equal split. On first run wallet[0] holds everything, so each of
// the N-1 peers gets `(total - reserve) / N`. On restart with funds already
// distributed, the existing balances satisfy the target and we skip.
//
// USDT target is floored at `max(launch.minBuyUsdt, MIN_BUY_USDT)` — the
// effective per-buy minimum. Splitting evenly without this floor means a
// thinly-funded treasurer would dust every peer below the launch's anti-dust
// threshold, causing every buy attempt to skip. Re-scatter triggers when a
// peer falls below the floor (USDT) or below 50% of target (BNB, where any
// positive amount is still useful for gas).
async function scatterIfNeeded(
	wallets: ethers.Wallet[],
	usdt: ethers.Contract,
	provider: ethers.Provider,
	launchMinBuyUsdt: bigint,
): Promise<boolean> {
	const treasurer = wallets[0];
	if (wallets.length < 2) return true;

	const balances = await Promise.all(wallets.map(async w => ({
		addr: w.address,
		bnb: await provider.getBalance(w.address),
		usdt: (await usdt.balanceOf(w.address)) as bigint,
	})));

	const totalBnb = balances.reduce((a, b) => a + b.bnb, 0n);
	const totalUsdt = balances.reduce((a, b) => a + b.usdt, 0n);
	const n = BigInt(wallets.length);

	const distributableBnb = totalBnb > GAS_RESERVE_BNB ? totalBnb - GAS_RESERVE_BNB : 0n;
	const targetBnb = distributableBnb / n;
	const lowMarkBnb = targetBnb / 2n;

	// USDT scatter is randomised per-peer. Each below-floor peer gets topped
	// up to a fresh random target in [floor, MAX_BUY_USDT], so the per-buy
	// amount variance comes from this pass — at buy time each wallet just
	// spends balanceOf(self).
	const usdtFloor = launchMinBuyUsdt > MIN_BUY_USDT ? launchMinBuyUsdt : MIN_BUY_USDT;
	const usdtCeiling = MAX_BUY_USDT > usdtFloor ? MAX_BUY_USDT : usdtFloor;

	let anySent = false;
	for (let i = 1; i < wallets.length; i++) {
		const b = balances[i];

		if (targetBnb > 0n && b.bnb < lowMarkBnb) {
			const need = targetBnb - b.bnb;
			const treasurerBnb = await provider.getBalance(treasurer.address);
			if (treasurerBnb > need + GAS_RESERVE_BNB) {
				try {
					const tx = await treasurer.sendTransaction({ to: b.addr, value: need });
					await tx.wait();
					console.log(`  💧 BNB ${ethers.formatEther(need)} → wallet[${i}] ${b.addr.slice(0, 10)}…`);
					anySent = true;
				} catch (e: any) {
					console.log(`  ❌ BNB scatter to wallet[${i}] failed: ${e.shortMessage || e.message?.slice(0, 80)}`);
				}
			} else {
				console.log(`  ⚠️  Treasurer BNB low (${ethers.formatEther(treasurerBnb)}); cannot top up wallet[${i}]`);
			}
		}

		if (b.usdt < usdtFloor) {
			const target = randBigInt(usdtFloor, usdtCeiling);
			const need = target > b.usdt ? target - b.usdt : 0n;
			const treasurerUsdt: bigint = await usdt.balanceOf(treasurer.address);
			// Reserve the floor for the treasurer so wallet[0] can also buy.
			// If we can't push this peer above floor after the reserve, skip;
			// sending dust just wastes gas.
			const treasurerSpendable = treasurerUsdt > usdtFloor ? treasurerUsdt - usdtFloor : 0n;
			const send = need < treasurerSpendable ? need : treasurerSpendable;
			if (send > 0n && b.usdt + send >= usdtFloor) {
				try {
					const usdtAsT = usdt.connect(treasurer) as ethers.Contract;
					const tx = await usdtAsT.transfer(b.addr, send);
					await tx.wait();
					console.log(`  💧 USDT ${ethers.formatUnits(send, 18)} → wallet[${i}] ${b.addr.slice(0, 10)}… (target ${ethers.formatUnits(target, 18)})`);
					anySent = true;
				} catch (e: any) {
					console.log(`  ❌ USDT scatter to wallet[${i}] failed: ${e.shortMessage || e.message?.slice(0, 80)}`);
				}
			} else {
				console.log(`  ⚠️  Treasurer USDT ${ethers.formatUnits(treasurerUsdt, 18)} can't push wallet[${i}] above min buy floor ${ethers.formatUnits(usdtFloor, 18)}`);
			}
		}
	}

	return anySent;
}

// ── Buy ──
async function attemptBuy(
	wallet: ethers.Wallet,
	walletIdx: number,
	launch: ethers.Contract,
	launchAddr: string,
	usdt: ethers.Contract,
	usdtAddr: string,
	minBuyUsdt: bigint,
	provider: ethers.Provider,
): Promise<{ ok: boolean; spent: bigint }> {
	const [bnbBal, usdtBal] = await Promise.all([
		provider.getBalance(wallet.address),
		usdt.balanceOf(wallet.address) as Promise<bigint>,
	]);

	if (bnbBal < ethers.parseEther('0.0005')) {
		console.log(`  ⏭  wallet[${walletIdx}] BNB too low for gas (${ethers.formatEther(bnbBal)})`);
		return { ok: false, spent: 0n };
	}

	const floor = minBuyUsdt > MIN_BUY_USDT ? minBuyUsdt : MIN_BUY_USDT;
	if (usdtBal < floor) {
		console.log(`  ⏭  wallet[${walletIdx}] USDT below buy floor (${ethers.formatUnits(usdtBal, 18)} < ${ethers.formatUnits(floor, 18)})`);
		return { ok: false, spent: 0n };
	}

	// Spend the wallet's full balance — the per-buy variance comes from the
	// scatter pass, not from re-sampling here. Cap at MAX_BUY_USDT so the
	// treasurer (which holds a much larger pot than peers) doesn't whale-buy
	// in a single tx.
	const amountIn = usdtBal < MAX_BUY_USDT ? usdtBal : MAX_BUY_USDT;

	// previewBuyFor accounts for the wallet's per-wallet cap; if that returns 0
	// the wallet has hit its limit on this launch.
	let tokensOut: bigint;
	try {
		const preview = await launch.previewBuyFor(wallet.address, amountIn);
		tokensOut = preview[0] as bigint;
	} catch (e: any) {
		console.log(`  ⏭  wallet[${walletIdx}] preview failed: ${e.shortMessage || e.message?.slice(0, 80)}`);
		return { ok: false, spent: 0n };
	}
	if (tokensOut === 0n) {
		console.log(`  ⏭  wallet[${walletIdx}] preview tokensOut=0 (cap reached or curve exhausted)`);
		return { ok: false, spent: 0n };
	}
	const minTokensOut = (tokensOut * (10000n - SLIPPAGE_BPS)) / 10000n;

	// Approve once-up-to-max so subsequent buys skip the approval round-trip.
	try {
		const allowance: bigint = await usdt.allowance(wallet.address, launchAddr);
		if (allowance < amountIn) {
			const usdtAsW = usdt.connect(wallet) as ethers.Contract;
			const ax = await usdtAsW.approve(launchAddr, ethers.MaxUint256);
			await ax.wait();
		}
	} catch (e: any) {
		console.log(`  ❌ wallet[${walletIdx}] approve failed: ${e.shortMessage || e.message?.slice(0, 80)}`);
		return { ok: false, spent: 0n };
	}

	try {
		const launchAsW = launch.connect(wallet) as ethers.Contract;
		// path=[USDT, USDT] is the no-swap signal. minUsdtOut is unused by the
		// USDT-pay branch in LaunchInstance but the function still requires it.
		const path = [usdtAddr, usdtAddr];
		const gas = await launchAsW['buy(address[],uint256,uint256,uint256)'].estimateGas(
			path, amountIn, amountIn, minTokensOut,
		);
		const tx = await launchAsW['buy(address[],uint256,uint256,uint256)'](
			path, amountIn, amountIn, minTokensOut,
			{ gasLimit: (gas * 12n) / 10n },
		);
		const receipt = await tx.wait();
		const cost = receipt!.gasUsed * receipt!.gasPrice;
		console.log(`  ✅ wallet[${walletIdx}] bought ~${ethers.formatUnits(tokensOut, 18)} tokens for ${ethers.formatUnits(amountIn, 18)} USDT | gas ${ethers.formatEther(cost)} BNB`);
		return { ok: true, spent: amountIn };
	} catch (e: any) {
		console.log(`  ❌ wallet[${walletIdx}] buy failed: ${e.shortMessage || e.message?.slice(0, 100)}`);
		return { ok: false, spent: 0n };
	}
}

// ── Main ──
async function main() {
	const mnemonic = process.env.BOT_MNEMONIC;
	if (!mnemonic) { console.error('❌ BOT_MNEMONIC required'); process.exit(1); }
	if (!LAUNCH_ADDRESS) { console.error('❌ LAUNCH_ADDRESS required'); process.exit(1); }
	if (!ethers.isAddress(LAUNCH_ADDRESS)) { console.error('❌ LAUNCH_ADDRESS invalid'); process.exit(1); }

	// Look up the launch's chain in the DB — no CHAIN_ID env needed.
	// One launch lives on exactly one chain, so we read it from
	// /api/launches and use that chain's network config.
	let chainId = 0;
	let usdtAddr = USDT_ADDRESS_ENV;
	let rpcUrl = '';
	let wsRpc: string | undefined;
	try {
		const headers: Record<string, string> = {};
		if (SYNC_SECRET) headers.Authorization = `Bearer ${SYNC_SECRET}`;
		const launchRes = await fetch(
			`${API_BASE}/api/launches?address=${LAUNCH_ADDRESS.toLowerCase()}`,
			{ headers },
		);
		const launchRows = (await launchRes.json()) as any[];
		const launchRow = Array.isArray(launchRows) ? launchRows[0] : null;
		if (!launchRow?.chain_id) {
			console.error(`❌ Launch ${LAUNCH_ADDRESS} not found in DB — can't resolve chain`);
			process.exit(1);
		}
		chainId = Number(launchRow.chain_id);

		const cfgRes = await fetch(`${API_BASE}/api/config?keys=networks`, { headers });
		const { networks } = await cfgRes.json();
		const net = (networks || []).find((n: any) => Number(n.chain_id) === chainId);
		if (!net) {
			console.error(`❌ No network config for chain ${chainId}`);
			process.exit(1);
		}
		if (!usdtAddr) usdtAddr = net.usdt_address || usdtAddr;
		const daemonRpc = net.daemon_rpc || '';
		const isWs = daemonRpc.startsWith('wss://') || daemonRpc.startsWith('ws://');
		if (!isWs && daemonRpc) rpcUrl = daemonRpc;
		else if (net.rpc) rpcUrl = net.rpc;
		wsRpc = (isWs ? daemonRpc : '') || net.ws_rpc;
	} catch (e: any) {
		console.error(`❌ Config fetch failed: ${e.message?.slice(0, 100)}`);
		process.exit(1);
	}

	if (!rpcUrl) {
		console.error('❌ Could not resolve RPC URL from DB config');
		process.exit(1);
	}

	const managed = createManagedProvider({ chainId, httpRpc: rpcUrl, wsRpc });
	const provider = managed.getProvider();

	const launch = new ethers.Contract(LAUNCH_ADDRESS, LAUNCH_ABI, provider);
	if (!usdtAddr) {
		usdtAddr = await launch.usdt();
	}
	if (!ethers.isAddress(usdtAddr)) {
		console.error('❌ Could not resolve USDT address');
		process.exit(1);
	}

	const wallets = deriveWallets(mnemonic, WALLET_COUNT, provider);
	const treasurer = wallets[0];
	const usdt = new ethers.Contract(usdtAddr, ERC20_ABI, provider);

	const [tBnb, tUsdt, minBuyUsdt, tokenAddr] = await Promise.all([
		provider.getBalance(treasurer.address),
		usdt.balanceOf(treasurer.address),
		launch.minBuyUsdt() as Promise<bigint>,
		launch.token() as Promise<string>,
	]);

	console.log(`
╔════════════════════════════════════════════════╗
║         TokenKrafter Launch Buy Bot            ║
╚════════════════════════════════════════════════╝
  Chain:          ${chainId}
  RPC:            ${rpcUrl}${wsRpc ? '  (ws: ' + wsRpc + ')' : ''}
  Launch:         ${LAUNCH_ADDRESS}
  Token:          ${tokenAddr}
  USDT:           ${usdtAddr}
  Treasurer[0]:   ${treasurer.address}
  Treasurer BNB:  ${ethers.formatEther(tBnb)}
  Treasurer USDT: ${ethers.formatUnits(tUsdt, 18)}
  Wallets:        ${WALLET_COUNT}
  Buy range:      ${ethers.formatUnits(MIN_BUY_USDT, 18)} – ${ethers.formatUnits(MAX_BUY_USDT, 18)} USDT
  Wait range:     ${MIN_WAIT_SEC}s – ${MAX_WAIT_SEC}s
  Slippage:       ${Number(SLIPPAGE_BPS) / 100}%
  Launch min buy: ${ethers.formatUnits(minBuyUsdt, 18)} USDT
  State:          ${STATE_FILE}
`);

	const state = loadState();
	let running = true;
	process.on('SIGINT', () => { running = false; console.log('\n⏹  Stopping...'); });
	process.on('SIGTERM', () => { running = false; });

	console.log('  ▸ Scattering funds across wallets…');
	try {
		const moved = await scatterIfNeeded(wallets, usdt, provider, minBuyUsdt);
		if (!state.scatterDone || moved) {
			state.scatterDone = true;
			saveState(state);
		}
	} catch (e: any) {
		console.log(`  ⚠️  Scatter pass error: ${e.message?.slice(0, 80)}`);
	}

	while (running) {
		try {
			const idx = randInt(0, wallets.length - 1);
			const wallet = wallets[idx];
			const result = await attemptBuy(
				wallet, idx, launch, LAUNCH_ADDRESS, usdt, usdtAddr, minBuyUsdt, provider,
			);
			if (result.ok) {
				state.totalBuys++;
				state.totalUsdtSpent = (BigInt(state.totalUsdtSpent || '0') + result.spent).toString();
				saveState(state);
			} else {
				// Opportunistic re-scatter on failure: if the picked wallet
				// couldn't act because it ran dry, this gives the treasurer a
				// chance to top it up before the next iteration.
				try { await scatterIfNeeded(wallets, usdt, provider, minBuyUsdt); } catch {}
			}
		} catch (e: any) {
			state.lastError = e.message?.slice(0, 200) || String(e);
			saveState(state);
			console.error(`  ❌ Loop error: ${state.lastError}`);
		}

		const delay = randInt(MIN_WAIT_SEC, MAX_WAIT_SEC);
		console.log(`  ⏳ Next buy in ${delay}s | total ${state.totalBuys} buys, ${ethers.formatUnits(BigInt(state.totalUsdtSpent || '0'), 18)} USDT spent`);
		await Bun.sleep(delay * 1000);
		if (!running) break;
	}

	console.log(`\n✅ Stopped. ${state.totalBuys} buys, ${ethers.formatUnits(BigInt(state.totalUsdtSpent || '0'), 18)} USDT spent.`);
	await managed.close();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
