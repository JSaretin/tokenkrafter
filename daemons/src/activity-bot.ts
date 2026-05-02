/**
 * TokenKrafter Activity Bot — Standalone Edition
 *
 * Clones real trending tokens from GeckoTerminal (all networks) and
 * creates them on BSC via the PlatformRouter. Multi-wallet rotation
 * for organic on-chain activity.
 *
 * Payment flow (USDT-only):
 *   1. You send BNB + USDT to wallet[0] (the "treasurer")
 *   2. Treasurer scatters BNB (gas) + USDT (fees) to wallets [1..N]
 *   3. Bot wallet approves USDT to PlatformRouter, calls createTokenOnly
 *      with FeePayment.path=[USDT, USDT] so no swap happens
 *   4. Factory collects USDT fee → platform wallet (you)
 *   5. You manually withdraw USDT earnings → send back to treasurer
 *
 * Env vars:
 *   RPC_URL              — BSC RPC (default bsc-dataseed)
 *   CHAIN_ID             — 56
 *   BOT_MNEMONIC         — 12/24-word mnemonic for derived bot wallets
 *                          Wallet[0] is the treasurer (scatterer)
 *   WALLET_COUNT         — Number of derived wallets (default 50)
 *   SPEED                — burst | normal | slow (default slow)
 *   MIN_BNB_BAL          — BNB refund threshold (default 0.003, ~$1.8)
 *   FUND_BNB             — BNB amount when topping up (default 0.01, ~$6)
 *   MIN_USDT_BAL         — USDT refund threshold (default 30)
 *   FUND_USDT            — USDT amount when topping up (default 75)
 *   API_BASE_URL         — https://tokenkrafter.com
 *   SYNC_SECRET          — Auth for /api/created-tokens
 *   STATE_FILE           — Path to persistence file
 *   TRENDING_REFRESH_HRS — Re-fetch trending every N hours (default 6)
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

// ── Config ──
const RPC_URL = process.env.RPC_URL || 'https://bsc-dataseed.binance.org/';
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '56');
const WALLET_COUNT = parseInt(process.env.WALLET_COUNT || '50', 10);
// RUN_ONCE=1 skips the inter-iteration delay and exits after the first
// successful (or unrecoverable) clone attempt. Used to verify the
// end-to-end flow during dev without waiting through the SPEED window.
const RUN_ONCE = process.env.RUN_ONCE === '1';
const MIN_BNB_BAL = ethers.parseEther(process.env.MIN_BNB_BAL || '0.003');
const FUND_BNB = ethers.parseEther(process.env.FUND_BNB || '0.01');
const MIN_USDT_BAL = ethers.parseUnits(process.env.MIN_USDT_BAL || '30', 18);
const FUND_USDT = ethers.parseUnits(process.env.FUND_USDT || '75', 18);
const API_BASE = process.env.API_BASE_URL || 'https://tokenkrafter.com';
const SYNC_SECRET = process.env.SYNC_SECRET || '';
const STATE_FILE = process.env.STATE_FILE || path.resolve(import.meta.dirname || __dirname, 'activity-bot-state.json');
const TRENDING_REFRESH_MS = parseInt(process.env.TRENDING_REFRESH_HRS || '6') * 3600 * 1000;
const SPEED = process.env.SPEED || 'slow';

const SPEEDS: Record<string, { tokenMin: number; tokenMax: number; desc: string }> = {
	burst: { tokenMin: 60, tokenMax: 300, desc: '1-5 min' },
	normal: { tokenMin: 600, tokenMax: 3600, desc: '10-60 min' },
	slow: { tokenMin: 3600, tokenMax: 14400, desc: '1-4 hours' },
};

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── ABIs ──
const PLATFORM_ROUTER_ABI = [
	'function createTokenOnly(tuple(string name, string symbol, uint256 totalSupply, uint8 decimals, bool isTaxable, bool isMintable, bool isPartner, address[] bases) p, tuple(uint256 maxWalletAmount, uint256 maxTransactionAmount, uint256 cooldownSeconds) protection, tuple(uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps, address[] taxWallets, uint16[] taxSharesBps) tax, tuple(address[] path, uint256 maxAmountIn) fee, address referral) external payable returns (address)',
	'event TokenCreated(address indexed creator, address indexed token)',
];

const TOKEN_FACTORY_ABI = [
	'function creationFee(uint8 tokenType) view returns (uint256)',
	'function owner() view returns (address)',
	'function withdrawFees(address token) external',
	'event TokenCreated(address indexed creator, address indexed tokenAddress, uint8 tokenType, string name, string symbol, uint256 totalSupply, uint8 decimals)',
];

const ERC20_ABI = [
	'function balanceOf(address) view returns (uint256)',
	'function approve(address spender, uint256 amount) returns (bool)',
	'function allowance(address owner, address spender) view returns (uint256)',
	'function transfer(address to, uint256 amount) returns (bool)',
	'function decimals() view returns (uint8)',
];

// ── State persistence ──
interface State {
	clonedTokens: string[];
	trendingCache: CachedToken[];
	trendingFetchedAt: number;
	tokensCreated: number;
}

interface CachedToken {
	key: string;
	network: string;
	address: string;
	name: string;
	symbol: string;
	decimals: number;
	totalSupplyRaw: string;
	image_url: string;
	description: string;
	twitter: string;
	telegram: string;
	website: string;
}

function loadState(): State {
	try {
		if (fs.existsSync(STATE_FILE)) {
			return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
		}
	} catch {}
	return { clonedTokens: [], trendingCache: [], trendingFetchedAt: 0, tokensCreated: 0 };
}

function saveState(s: State) {
	fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ── GeckoTerminal ──
const GCT_BASE = 'https://api.geckoterminal.com/api/v2';

async function gctGet(p: string, retries = 2): Promise<any> {
	for (let attempt = 0; attempt <= retries; attempt++) {
		const res = await fetch(`${GCT_BASE}${p}`, {
			headers: { Accept: 'application/json;version=20230203' },
		});
		if (res.status === 429) {
			const wait = Math.min(10_000, (attempt + 1) * 3000);
			console.warn(`  ⏳ GCT 429 on ${p} — backing off ${wait / 1000}s`);
			await Bun.sleep(wait);
			continue;
		}
		if (!res.ok) throw new Error(`GCT ${res.status} on ${p}`);
		return res.json();
	}
	throw new Error(`GCT 429 exhausted retries on ${p}`);
}

// Lightweight trending list — one GCT call, returns just enough fields
// (name, symbol, decimals from the included `token` relationships) so
// we can pick a candidate without enriching every pool. Heavy fields
// (total_supply, description, socials) are fetched lazily right before
// we actually clone a specific token, in enrichOne(). This caps GCT
// usage at 1 list refresh + 2 enrich calls per cloned token.
async function fetchTrending(): Promise<CachedToken[]> {
	console.log('  🔍 Fetching trending pools (list only)...');
	const trending = await gctGet('/networks/trending_pools?include=base_token');
	const pools = trending.data || [];
	const included = trending.included || [];

	const tokenMap = new Map<string, any>();
	for (const it of included) {
		if (it.type === 'token') tokenMap.set(`${it.id}`, it.attributes);
	}

	const results: CachedToken[] = [];
	for (const pool of pools) {
		const baseTokenId = pool.relationships?.base_token?.data?.id;
		if (!baseTokenId) continue;
		const network = baseTokenId.split('_')[0];
		const address = baseTokenId.split('_').slice(1).join('_');
		const basics = tokenMap.get(baseTokenId);
		if (!basics) continue;

		results.push({
			key: baseTokenId,
			network,
			address,
			name: basics.name || 'Unknown',
			symbol: (basics.symbol || 'TKN').toUpperCase().slice(0, 10),
			decimals: basics.decimals ?? 18,
			// Filled lazily on enrichOne() — empty is fine; createClone bails
			// out without it. Caching empties keeps the list portable across
			// runs even when GCT throttles enrich calls.
			totalSupplyRaw: '',
			image_url: basics.image_url || '',
			description: '',
			twitter: '',
			telegram: '',
			website: '',
		});
	}

	console.log(`  ✓ Cached ${results.length} trending tokens (list only — details fetched on demand)`);
	return results;
}

// Pull the heavy fields for one token, only when we're about to clone
// it. Two GCT calls (token + info), spaced to stay under rate limits.
// Returns null if the token is unusable (no total supply, throttled, etc).
async function enrichOne(c: CachedToken): Promise<CachedToken | null> {
	try {
		const base = await gctGet(`/networks/${c.network}/tokens/${c.address}`).catch(() => null);
		await sleep(2100);
		const info = await gctGet(`/networks/${c.network}/tokens/${c.address}/info`).catch(() => null);

		const baseAttrs = base?.data?.attributes || {};
		const infoAttrs = info?.data?.attributes || {};
		const totalSupplyRaw = baseAttrs.total_supply;
		if (!totalSupplyRaw || totalSupplyRaw === '0') return null;

		return {
			...c,
			name: baseAttrs.name || c.name,
			symbol: (baseAttrs.symbol || c.symbol).toUpperCase().slice(0, 10),
			decimals: baseAttrs.decimals ?? c.decimals,
			totalSupplyRaw: String(totalSupplyRaw).split('.')[0],
			image_url: baseAttrs.image_url || c.image_url,
			description: infoAttrs.description || '',
			twitter: infoAttrs.twitter_handle ? `https://x.com/${infoAttrs.twitter_handle}` : '',
			telegram: infoAttrs.telegram_handle ? `https://t.me/${infoAttrs.telegram_handle}` : '',
			website: (infoAttrs.websites && infoAttrs.websites[0]) || '',
		};
	} catch (e: any) {
		console.log(`    ⚠️  enrich ${c.symbol}: ${e.message?.slice(0, 60)}`);
		return null;
	}
}

// Auth helper. Mirrors the FE's apiFetch.autoSign so the bot's metadata
// PUT to /api/token-metadata uses a wallet-signed session — same auth
// path users go through. Returns the cookie jar string ('session=...').
// Cached per wallet for the bot's lifetime (sessions are 7d server-side).
const sessionByWallet = new Map<string, string>();
async function getWalletSession(wallet: ethers.Wallet): Promise<string | null> {
	const me = wallet.address.toLowerCase();
	const cached = sessionByWallet.get(me);
	if (cached) return cached;

	try {
		const timestamp = Date.now();
		const message = `TokenKrafter Auth\nAddress: ${wallet.address}\nOrigin: ${API_BASE}\nTimestamp: ${timestamp}`;
		const signature = await wallet.signMessage(message);

		const res = await fetch(`${API_BASE}/api/auth`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-wallet-address': me,
			},
			body: JSON.stringify({ signature, signed_message: message }),
		});
		if (!res.ok) return null;
		const setCookie = res.headers.get('set-cookie') || '';
		const match = setCookie.match(/session=[^;]+/);
		if (!match) return null;
		const cookie = match[0];
		sessionByWallet.set(me, cookie);
		return cookie;
	} catch {
		return null;
	}
}

// ── Type weighting (no partner — reserved for real users) ──
function pickTokenType(): number {
	// 0=basic, 1=mintable, 2=taxable, 3=tax+mint
	const weights = [90, 5, 5, 0];
	const total = weights.reduce((a, b) => a + b, 0);
	let roll = randInt(1, total);
	for (let i = 0; i < weights.length; i++) {
		roll -= weights[i];
		if (roll <= 0) return i;
	}
	return 0;
}

// ── Derive wallets ──
function deriveWallets(mnemonic: string, count: number, provider: ethers.Provider): ethers.Wallet[] {
	const hdNode = ethers.HDNodeWallet.fromMnemonic(
		ethers.Mnemonic.fromPhrase(mnemonic),
		"m/44'/60'/0'/0"
	);
	const wallets: ethers.Wallet[] = [];
	for (let i = 0; i < count; i++) {
		const child = hdNode.deriveChild(i);
		wallets.push(new ethers.Wallet(child.privateKey, provider));
	}
	return wallets;
}

// Walk the wallet pool and return the first one that already meets
// both BNB and USDT thresholds. Lets the bot keep working when the
// treasurer is empty — yesterday's scattered funds don't go to waste.
// Returns null when nothing fits.
async function findAlreadyFunded(
	wallets: ethers.Wallet[],
	usdt: ethers.Contract,
	provider: ethers.Provider,
	skipIdx: number = -1,
): Promise<{ wallet: ethers.Wallet; idx: number } | null> {
	for (let i = 1; i < wallets.length; i++) {  // skip 0 (treasurer)
		if (i === skipIdx) continue;
		const w = wallets[i];
		try {
			const [bnb, ust] = await Promise.all([
				provider.getBalance(w.address),
				usdt.balanceOf(w.address),
			]);
			if (bnb >= MIN_BNB_BAL && ust >= MIN_USDT_BAL) return { wallet: w, idx: i };
		} catch {}
	}
	return null;
}

// ── Fund wallet with BNB + USDT from treasurer (wallet[0]) ──
async function fundIfLow(
	treasurer: ethers.Wallet,
	wallet: ethers.Wallet,
	usdt: ethers.Contract,
	provider: ethers.Provider
): Promise<{ bnb: boolean; usdt: boolean }> {
	// Treasurer funding itself is a no-op
	if (wallet.address.toLowerCase() === treasurer.address.toLowerCase()) {
		return { bnb: true, usdt: true };
	}

	const [bnbBal, usdtBal] = await Promise.all([
		provider.getBalance(wallet.address),
		usdt.balanceOf(wallet.address),
	]);
	const needBnb = bnbBal < MIN_BNB_BAL;
	const needUsdt = usdtBal < MIN_USDT_BAL;

	if (needBnb) {
		const treasurerBnb = await provider.getBalance(treasurer.address);
		if (treasurerBnb < FUND_BNB + ethers.parseEther('0.002')) {
			console.log(`  ❌ Treasurer BNB low (${ethers.formatEther(treasurerBnb)}) — top up wallet[0] at ${treasurer.address}`);
			return { bnb: false, usdt: false };
		}
		try {
			const tx = await treasurer.sendTransaction({ to: wallet.address, value: FUND_BNB });
			await tx.wait();
			console.log(`  💧 Scattered ${ethers.formatEther(FUND_BNB)} BNB → ${wallet.address.slice(0, 10)}...`);
		} catch (e: any) {
			console.log(`  ❌ BNB scatter failed: ${e.shortMessage || e.message?.slice(0, 60)}`);
			return { bnb: false, usdt: false };
		}
	}

	if (needUsdt) {
		const usdtAsTreasurer = usdt.connect(treasurer) as ethers.Contract;
		const treasurerUsdt = await usdt.balanceOf(treasurer.address);
		if (treasurerUsdt < FUND_USDT) {
			console.log(`  ❌ Treasurer USDT low (${ethers.formatUnits(treasurerUsdt, 18)}) — top up wallet[0] at ${treasurer.address}`);
			return { bnb: true, usdt: false };
		}
		try {
			const tx = await usdtAsTreasurer.transfer(wallet.address, FUND_USDT);
			await tx.wait();
			console.log(`  💧 Scattered ${ethers.formatUnits(FUND_USDT, 18)} USDT → ${wallet.address.slice(0, 10)}...`);
		} catch (e: any) {
			console.log(`  ❌ USDT scatter failed: ${e.shortMessage || e.message?.slice(0, 60)}`);
			return { bnb: true, usdt: false };
		}
	}

	return { bnb: true, usdt: true };
}

// ── Create clone via PlatformRouter ──
async function createClone(
	wallet: ethers.Wallet,
	walletIdx: number,
	router: ethers.Contract,
	factory: ethers.Contract,
	usdt: ethers.Contract,
	usdtAddr: string,
	routerAddr: string,
	src: CachedToken
): Promise<string | null> {
	const typeKey = pickTokenType();
	const typeLabels = ['Basic', 'Mintable', 'Taxable', 'Tax+Mint'];
	const label = typeLabels[typeKey];

	console.log(`\n  [${new Date().toLocaleTimeString()}] Wallet [${walletIdx}] cloning ${src.network}:${src.name} ($${src.symbol})`);
	console.log(`    Type: ${label} | Decimals: ${src.decimals} | Supply: ${src.totalSupplyRaw}`);

	try {
		const feeUsdt = await factory.creationFee(typeKey);
		const maxAmountIn = (feeUsdt * 101n) / 100n; // 1% buffer

		// Approve USDT → router
		const usdtAsWallet = usdt.connect(wallet) as ethers.Contract;
		const allowance: bigint = await usdt.allowance(wallet.address, routerAddr);
		if (allowance < maxAmountIn) {
			// Approve max to avoid repeated approvals
			const approveTx = await usdtAsWallet.approve(routerAddr, ethers.MaxUint256);
			await approveTx.wait();
		}

		const routerAsWallet = router.connect(wallet) as ethers.Contract;

		const params = {
			name: src.name,
			symbol: src.symbol,
			totalSupply: BigInt(src.totalSupplyRaw),
			decimals: src.decimals,
			isTaxable: (typeKey & 2) !== 0,
			isMintable: (typeKey & 1) !== 0,
			isPartner: false,
			bases: [] as string[], // empty — accept factory defaults
		};

		// Empty protection + tax params (bot tokens stay plain)
		const protection = { maxWalletAmount: 0n, maxTransactionAmount: 0n, cooldownSeconds: 0n };
		const tax = {
			buyTaxBps: 0n,
			sellTaxBps: 0n,
			transferTaxBps: 0n,
			taxWallets: [] as string[],
			taxSharesBps: [] as number[],
		};
		// FeePayment: single-element path = direct USDT payment, no swap.
		// (PlatformRouter._payFee short-circuits on len == 1; len == 2 with
		// path[0]==path[1] hits Pancake's IDENTICAL_ADDRESSES check.)
		const fee = { path: [usdtAddr], maxAmountIn };

		const gasEstimate = await routerAsWallet.createTokenOnly.estimateGas(
			params, protection, tax, fee, ethers.ZeroAddress
		);
		const tx = await routerAsWallet.createTokenOnly(
			params, protection, tax, fee, ethers.ZeroAddress,
			{ gasLimit: (gasEstimate * 12n) / 10n }
		);
		const receipt = await tx.wait();

		// Both PlatformRouter and TokenFactory emit a TokenCreated event,
		// but with different shapes. Try the long-form (factory) first
		// since it carries the most data, then fall back to the short-
		// form (router). Without the fallback, when the router-emitted
		// log is the only one that matches our caller's perspective, the
		// parser throws and tokenAddr stays empty.
		let tokenAddr = '';
		const ifaceFactory = new ethers.Interface(TOKEN_FACTORY_ABI);
		const ifaceRouter = new ethers.Interface(PLATFORM_ROUTER_ABI);
		for (const log of receipt!.logs) {
			let parsed;
			try { parsed = ifaceFactory.parseLog({ topics: [...log.topics], data: log.data }); } catch {}
			if (!parsed) {
				try { parsed = ifaceRouter.parseLog({ topics: [...log.topics], data: log.data }); } catch {}
			}
			if (parsed?.name === 'TokenCreated') {
				// Long-form: args[1] is tokenAddress. Short-form: args[1] is token.
				tokenAddr = parsed.args[1];
				break;
			}
		}

		const gasCost = receipt!.gasUsed * receipt!.gasPrice;
		console.log(`    ✅ ${tokenAddr.slice(0, 10)}... | Gas: ${ethers.formatEther(gasCost)} BNB | Fee: ${ethers.formatUnits(feeUsdt, 18)} USDT`);

		// Save metadata via the same wallet-authed path users go through
		// in /create (PUT /api/token-metadata). The PUT verifies the
		// caller is the token's creator, then upserts the row with all
		// fields. Doing this BEFORE the indexer's WS handler races our
		// post-deploy callback isn't possible (we don't know the address
		// pre-deploy), but Supabase upsert only writes the columns we
		// send — so even if ws-indexer's POST lands first with the basic
		// fields, our PUT layers metadata on top without clobbering.
		if (tokenAddr) {
			try {
				const cookie = await getWalletSession(wallet);
				if (!cookie) {
					console.log('    ⚠️  Wallet session sign failed — falling back to daemon POST');
					await fetch(`${API_BASE}/api/created-tokens`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SYNC_SECRET}` },
						body: JSON.stringify({
							address: tokenAddr.toLowerCase(),
							chain_id: CHAIN_ID,
							creator: wallet.address.toLowerCase(),
							name: src.name,
							symbol: src.symbol,
							total_supply: params.totalSupply.toString(),
							decimals: src.decimals,
							is_mintable: params.isMintable,
							is_taxable: params.isTaxable,
							is_partner: false,
							description: src.description,
							logo_url: src.image_url,
							website: src.website,
							twitter: src.twitter,
							telegram: src.telegram,
						}),
					});
				} else {
					// Send everything the bot knows. The on-chain fields
					// also come through the indexer; upsert means the
					// later writer wins on those columns and they always
					// resolve to the same chain-derived values either way.
					const res = await fetch(`${API_BASE}/api/token-metadata`, {
						method: 'PUT',
						headers: {
							'Content-Type': 'application/json',
							'x-wallet-address': wallet.address.toLowerCase(),
							Cookie: cookie,
						},
						body: JSON.stringify({
							address: tokenAddr.toLowerCase(),
							chain_id: CHAIN_ID,
							name: src.name,
							symbol: src.symbol,
							decimals: src.decimals,
							is_taxable: params.isTaxable,
							is_mintable: params.isMintable,
							is_partner: false,
							logo_url: src.image_url || null,
							description: src.description || null,
							website: src.website || null,
							twitter: src.twitter || null,
							telegram: src.telegram || null,
						}),
					});
					if (!res.ok) console.log(`    ⚠️  Metadata PUT ${res.status}`);
				}
			} catch (e: any) {
				console.log(`    ⚠️  Metadata save error: ${e.message?.slice(0, 60)}`);
			}
		}

		return tokenAddr;
	} catch (e: any) {
		console.log(`    ❌ Failed: ${e.shortMessage || e.message?.slice(0, 100)}`);
		return null;
	}
}

// ── Main ──
async function main() {
	const mnemonic = process.env.BOT_MNEMONIC;
	if (!mnemonic) { console.error('❌ BOT_MNEMONIC required'); process.exit(1); }

	// Load config from backend (DB-managed addresses + RPC)
	let factoryAddr = '', routerAddr = '', usdtAddr = '', rpcUrl = RPC_URL;
	try {
		const cfgHeaders: Record<string, string> = {};
		if (SYNC_SECRET) cfgHeaders.Authorization = `Bearer ${SYNC_SECRET}`;
		const res = await fetch(`${API_BASE}/api/config?keys=networks`, { headers: cfgHeaders });
		const { networks } = await res.json();
		const net = (networks || []).find((n: any) => Number(n.chain_id) === CHAIN_ID);
		factoryAddr = net?.platform_address;
		routerAddr = net?.router_address;
		usdtAddr = net?.usdt_address;
		const daemonRpc = net?.daemon_rpc || '';
		const isWs = daemonRpc.startsWith('wss://') || daemonRpc.startsWith('ws://');
		// Pick an HTTP RPC only — see provider note below.
		if (!isWs && daemonRpc) rpcUrl = daemonRpc;
		else if (net?.rpc) rpcUrl = net.rpc;
	} catch (e: any) {
		console.error(`❌ Config fetch failed: ${e.message}`);
		process.exit(1);
	}
	if (!factoryAddr || !routerAddr || !usdtAddr) {
		console.error('❌ Missing factory/router/usdt address');
		process.exit(1);
	}

	// Activity bot only sends transactions — no event subscriptions —
	// so a plain HTTP JsonRpcProvider is enough. We previously routed
	// through createManagedProvider (which prefers WS when daemon_rpc
	// is wss://), but Infura's WS endpoints reject eth_sendRawTransaction
	// with a generic "could not coalesce error", killing every scatter.
	const provider = new ethers.JsonRpcProvider(rpcUrl, CHAIN_ID, { staticNetwork: true });
	const wallets = deriveWallets(mnemonic, WALLET_COUNT, provider);
	const treasurer = wallets[0]; // wallet[0] holds the pooled funds, scatters to others
	const speed = SPEEDS[SPEED] || SPEEDS.slow;

	const factory = new ethers.Contract(factoryAddr, TOKEN_FACTORY_ABI, provider);
	const router = new ethers.Contract(routerAddr, PLATFORM_ROUTER_ABI, provider);
	const usdt = new ethers.Contract(usdtAddr, ERC20_ABI, provider);

	const [treasurerBnb, treasurerUsdt] = await Promise.all([
		provider.getBalance(treasurer.address),
		usdt.balanceOf(treasurer.address),
	]);

	console.log(`
╔════════════════════════════════════════════════╗
║      TokenKrafter Activity Bot (Standalone)    ║
╚════════════════════════════════════════════════╝
  Chain:          ${CHAIN_ID}
  RPC:            ${rpcUrl}
  Factory:        ${factoryAddr}
  Router:         ${routerAddr}
  USDT:           ${usdtAddr}
  Treasurer[0]:   ${treasurer.address}
  Treasurer BNB:  ${ethers.formatEther(treasurerBnb)}
  Treasurer USDT: ${ethers.formatUnits(treasurerUsdt, 18)}
  Wallets:        ${WALLET_COUNT}
  Speed:          ${SPEED} (${speed.desc})
  State:          ${STATE_FILE}
`);

	const state = loadState();
	const clonedSet = new Set(state.clonedTokens);
	let running = true;
	process.on('SIGINT', () => { running = false; console.log('\n⏹  Stopping...'); });
	process.on('SIGTERM', () => { running = false; });

	while (running) {
		try {
			// Refresh trending
			if (Date.now() - state.trendingFetchedAt > TRENDING_REFRESH_MS || state.trendingCache.length === 0) {
				try {
					state.trendingCache = await fetchTrending();
					state.trendingFetchedAt = Date.now();
					saveState(state);
				} catch (e: any) {
					console.log(`  ⚠️  Trending fetch failed: ${e.message?.slice(0, 80)}`);
					if (state.trendingCache.length === 0) {
						console.log('  ❌ No cache, sleeping 10min...');
						await sleep(10 * 60 * 1000);
						continue;
					}
				}
			}

			const candidates = state.trendingCache.filter(t => !clonedSet.has(t.key));
			if (candidates.length === 0) {
				console.log('  ℹ️  All cached tokens cloned. Waiting 30min for refresh...');
				await sleep(30 * 60 * 1000);
				continue;
			}
			const stub = pick(candidates);

			// Lazy enrich — only the picked token, only right before we
			// actually need its supply/socials. Two GCT calls instead of
			// 2×N upfront, so trending refreshes don't hit 429 storms.
			console.log(`  🔎 Enriching ${stub.network}:${stub.symbol}…`);
			const source = await enrichOne(stub);
			if (!source) {
				// Mark as cloned so we don't repeatedly retry a bad pick.
				clonedSet.add(stub.key);
				state.clonedTokens = Array.from(clonedSet);
				saveState(state);
				console.log(`  ⚠️  ${stub.symbol} not enrichable — skipping`);
				continue;
			}

			// Pick random wallet, fund if low. If treasurer can't scatter
			// (low balance, RPC error, etc.) fall through to any wallet
			// already holding BNB+USDT from a prior fund — those funds
			// shouldn't sit idle just because the treasurer is empty.
			let walletIdx = randInt(1, wallets.length - 1); // skip 0 (treasurer)
			let wallet = wallets[walletIdx];
			let funded = await fundIfLow(treasurer, wallet, usdt, provider);
			if (!funded.bnb || !funded.usdt) {
				console.log(`  🔎 Treasurer can't fund [${walletIdx}] — looking for an already-funded wallet…`);
				const fallback = await findAlreadyFunded(wallets, usdt, provider, walletIdx);
				if (fallback) {
					console.log(`  ✅ Reusing wallet [${fallback.idx}] (already has BNB+USDT)`);
					wallet = fallback.wallet;
					walletIdx = fallback.idx;
					funded = { bnb: true, usdt: true };
				} else {
					console.log(`  ⚠️  No funded wallets either — sleeping 60s. Top up treasurer at ${treasurer.address}`);
					if (RUN_ONCE) {
						console.log('\n🏁 RUN_ONCE — exiting (no fundable wallet)');
						return;
					}
					await sleep(60 * 1000);
					continue;
				}
			}

			const tokenAddr = await createClone(wallet, walletIdx, router, factory, usdt, usdtAddr, routerAddr, source);
			if (tokenAddr) {
				clonedSet.add(source.key);
				state.clonedTokens = Array.from(clonedSet);
				state.tokensCreated++;
				saveState(state);
				console.log(`    Total: ${state.tokensCreated}`);
			}
			if (RUN_ONCE) {
				console.log(`\n🏁 RUN_ONCE — exiting after one iteration (token=${tokenAddr || 'failed'})`);
				return;
			}
		} catch (e: any) {
			console.error(`  ❌ Loop error: ${e.message?.slice(0, 100)}`);
			if (RUN_ONCE) {
				console.log('\n🏁 RUN_ONCE — exiting after error');
				return;
			}
		}

		const delaySec = randInt(speed.tokenMin, speed.tokenMax);
		console.log(`  ⏳ Next in ~${(delaySec / 60).toFixed(1)} min`);
		// Sleep the full delay in one shot — SIGINT sets running=false and
		// the loop condition catches it on the next iteration.
		await Bun.sleep(delaySec * 1000);
		if (!running) break;
	}

	console.log(`\n✅ Stopped. Total: ${state.tokensCreated} tokens cloned.`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
