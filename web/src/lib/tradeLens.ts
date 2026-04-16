/**
 * TradeLensV2 — constructor-only contract for batch token info + tax simulation.
 * No deployment needed. Uses eth_call with bytecode + encoded args.
 * Checks each token against ALL provided base tokens for liquidity.
 * Supports multiple users for balance queries.
 */
import { ethers } from 'ethers';
import { TRADE_LENS_BYTECODE } from './tradeLensV2Bytecode';

export interface PoolInfo {
	base: string;
	pairAddress: string;
	reserveToken: bigint;
	reserveBase: bigint;
	hasLiquidity: boolean;
}

export interface TokenInfo {
	token: string;
	name: string;
	symbol: string;
	decimals: number;
	totalSupply: bigint;
	hasLiquidity: boolean;
	pools: PoolInfo[];
	balances: bigint[];  // one per user (same order as users[] input)
	// Convenience: first user's balance (backwards compat)
	balance: bigint;
}

export interface UserInfo {
	user: string;
	nativeBalance: bigint;
}

export interface TaxInfo {
	success: boolean;
	canBuy: boolean;
	canSell: boolean;
	buyTaxBps: number;
	sellTaxBps: number;
	transferTaxBps: number;
	buyGas: number;
	sellGas: number;
	buyError: string;
	sellError: string;
}

export interface TradeLensResult {
	weth: string;
	factory: string;
	users: UserInfo[];
	nativeBalance: bigint;  // first user's native balance (backwards compat)
	tokens: TokenInfo[];
	taxInfo: TaxInfo;
	taxToken: string;
}

const RESULT_TYPES = [
	'address', // weth
	'address', // factory
	'tuple(address user, uint256 nativeBalance)[]', // userInfos
	'tuple(address token, string name, string symbol, uint8 decimals, uint256 totalSupply, bool hasLiquidity, tuple(address base, address pairAddress, uint256 reserveToken, uint256 reserveBase, bool hasLiquidity)[] pools, uint256[] balances)[]', // tokens
	'tuple(bool success, bool canBuy, bool canSell, uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps, uint256 buyGas, uint256 sellGas, string buyError, string sellError)', // taxInfo
	'address', // taxToken
];

// ── Cache ──────────────────────────────────────────
let _tokenCache: Map<string, TokenInfo> = new Map();
let _weth = '';
let _lastFetch = 0;
let _usersCache: UserInfo[] = [];

/**
 * Fetch all token info + balances + optionally simulate tax — one eth_call.
 *
 * @param provider JSON-RPC provider
 * @param dexRouter DEX router address
 * @param tokens Token addresses to query
 * @param simulateTax Token to simulate tax for (ZeroAddress to skip)
 * @param simBuyAmount ETH amount for tax simulation
 * @param users User addresses for balances (empty array to skip)
 * @param chainId Chain ID (unused — no deployed address)
 * @param baseTokens Base tokens to check pools against
 */
export async function queryTradeLens(
	provider: ethers.JsonRpcProvider,
	dexRouter: string,
	tokens: string[],
	simulateTax: string = ethers.ZeroAddress,
	simBuyAmount: bigint = ethers.parseEther('0.001'),
	users: string | string[] = [],
	chainId: number = 56,
	baseTokens: string[] = []
): Promise<TradeLensResult> {
	// Backwards compat: accept single address string
	const usersArr = typeof users === 'string'
		? (users === ethers.ZeroAddress ? [] : [users])
		: users.filter(u => u && u !== ethers.ZeroAddress);

	const abiCoder = ethers.AbiCoder.defaultAbiCoder();

	const args = abiCoder.encode(
		['address', 'address[]', 'address[]', 'address[]', 'address', 'uint256'],
		[dexRouter, tokens, baseTokens, usersArr, simulateTax, simBuyAmount]
	);

	const callData = TRADE_LENS_BYTECODE + args.slice(2);

	const raw = await provider.call({
		data: callData,
		value: simBuyAmount,
		gasLimit: 15_000_000,
	});

	if (!raw || raw === '0x') {
		throw new Error('TradeLens returned empty (constructor reverted)');
	}

	const decoded = abiCoder.decode(RESULT_TYPES, raw);

	const userInfos: UserInfo[] = (decoded[2] as any[]).map((u: any) => ({
		user: u.user,
		nativeBalance: u.nativeBalance,
	}));

	const tokenInfos: TokenInfo[] = (decoded[3] as any[]).map((t: any) => ({
		token: t.token,
		name: t.name,
		symbol: t.symbol,
		decimals: Number(t.decimals),
		totalSupply: t.totalSupply,
		hasLiquidity: t.hasLiquidity,
		pools: (t.pools as any[]).map((p: any) => ({
			base: p.base,
			pairAddress: p.pairAddress,
			reserveToken: p.reserveToken,
			reserveBase: p.reserveBase,
			hasLiquidity: p.hasLiquidity,
		})),
		balances: (t.balances as bigint[]).map(b => b),
		balance: t.balances.length > 0 ? t.balances[0] : 0n,
	}));

	const taxInfo: TaxInfo = {
		success: decoded[4].success,
		canBuy: decoded[4].canBuy,
		canSell: decoded[4].canSell,
		buyTaxBps: Number(decoded[4].buyTaxBps),
		sellTaxBps: Number(decoded[4].sellTaxBps),
		transferTaxBps: Number(decoded[4].transferTaxBps),
		buyGas: Number(decoded[4].buyGas),
		sellGas: Number(decoded[4].sellGas),
		buyError: decoded[4].buyError,
		sellError: decoded[4].sellError,
	};

	// Update cache
	_weth = decoded[0] as string;
	_usersCache = userInfos;
	for (const t of tokenInfos) {
		_tokenCache.set(t.token.toLowerCase(), t);
	}
	_lastFetch = Date.now();

	return {
		weth: decoded[0] as string,
		factory: decoded[1] as string,
		users: userInfos,
		nativeBalance: userInfos.length > 0 ? userInfos[0].nativeBalance : 0n,
		tokens: tokenInfos,
		taxInfo,
		taxToken: decoded[5] as string,
	};
}

/** Get cached WETH address */
export function getWeth(): string { return _weth; }

/** Get cached token info (includes pools + balances) */
export function getCachedToken(addr: string): TokenInfo | null {
	return _tokenCache.get(addr.toLowerCase()) || null;
}

/** Get cached user info by address */
export function getCachedUser(addr: string): UserInfo | null {
	return _usersCache.find(u => u.user.toLowerCase() === addr.toLowerCase()) || null;
}

/** Get USD value of a token amount using cached reserves */
export function getUsdValue(tokenAddr: string, amount: bigint, tokenDecimals: number, usdtAddr: string): number | null {
	if (amount === 0n || !_weth) return null;

	const weth = _weth.toLowerCase();
	const addr = tokenAddr.toLowerCase();
	const usdt = usdtAddr.toLowerCase();

	if (addr === usdt) {
		return parseFloat(ethers.formatUnits(amount, tokenDecimals));
	}

	const usdtInfo = _tokenCache.get(usdt);
	if (!usdtInfo) return null;
	const usdtWethPool = usdtInfo.pools.find(p => p.base.toLowerCase() === weth && p.hasLiquidity);
	if (!usdtWethPool || usdtWethPool.reserveBase === 0n) return null;
	const wethPriceUsdt = Number(usdtWethPool.reserveToken) / Number(usdtWethPool.reserveBase);

	if (addr === weth) {
		return parseFloat(ethers.formatUnits(amount, 18)) * wethPriceUsdt;
	}

	const tokenInfo = _tokenCache.get(addr);
	if (!tokenInfo) return null;
	const tokenWethPool = tokenInfo.pools.find(p => p.base.toLowerCase() === weth && p.hasLiquidity);
	if (!tokenWethPool || tokenWethPool.reserveToken === 0n) return null;
	const tokenPriceWeth = Number(tokenWethPool.reserveBase) / Number(tokenWethPool.reserveToken);

	return parseFloat(ethers.formatUnits(amount, tokenDecimals)) * tokenPriceWeth * wethPriceUsdt;
}

/** Check if cache is stale */
export function isCacheStale(maxAgeMs: number = 15000): boolean {
	return Date.now() - _lastFetch > maxAgeMs;
}

/** Check if cache has data */
export function isCacheLoaded(): boolean {
	return _lastFetch > 0 && _tokenCache.size > 0;
}

/** Get cached native balance for first user */
export function getNativeBalance(): bigint {
	return _usersCache.length > 0 ? _usersCache[0].nativeBalance : 0n;
}

/** Get cached token balance for first user */
export function getCachedBalance(addr: string): bigint {
	return _tokenCache.get(addr.toLowerCase())?.balance || 0n;
}

/** Route info returned by findBestRoute */
export interface SwapRoute {
	path: string[];        // [tokenIn, ...intermediaries, tokenOut]
	symbols: string[];     // human readable: ['RAVE', 'USDT', 'WBNB']
	amountOut: bigint;     // expected output amount
	hops: number;          // 1 = direct, 2 = through one intermediary
}

/**
 * Find the best swap route by trying all possible paths through cached pools.
 * Tries direct pairs first, then routes through each known base (WETH, USDT, USDC).
 * Returns the route with the highest output.
 */
export function findBestRoute(
	tokenIn: string,
	tokenOut: string,
	amountIn: bigint
): SwapRoute | null {
	if (!_weth || amountIn === 0n) return null;

	const inAddr = tokenIn.toLowerCase();
	const outAddr = tokenOut.toLowerCase();
	const weth = _weth.toLowerCase();

	const inInfo = _tokenCache.get(inAddr);
	const outInfo = _tokenCache.get(outAddr);

	const inIsWeth = inAddr === weth;
	const outIsWeth = outAddr === weth;

	const candidates: SwapRoute[] = [];

	const inSymbol = inIsWeth ? 'WBNB' : (inInfo?.symbol || '???');
	const outSymbol = outIsWeth ? 'WBNB' : (outInfo?.symbol || '???');

	// ── Direct: tokenIn → tokenOut (if they share a pool) ──
	if (outIsWeth && inInfo) {
		// Selling token for native: use any pool with WETH base
		const pool = inInfo.pools.find(p => p.base.toLowerCase() === weth && p.hasLiquidity);
		if (pool) {
			const out = _calcOut(amountIn, pool.reserveToken, pool.reserveBase);
			if (out > 0n) candidates.push({ path: [inAddr, weth], symbols: [inSymbol, 'WBNB'], amountOut: out, hops: 1 });
		}
	} else if (inIsWeth && outInfo) {
		// Buying token with native: use any pool with WETH base
		const pool = outInfo.pools.find(p => p.base.toLowerCase() === weth && p.hasLiquidity);
		if (pool) {
			const out = _calcOut(amountIn, pool.reserveBase, pool.reserveToken);
			if (out > 0n) candidates.push({ path: [weth, outAddr], symbols: ['WBNB', outSymbol], amountOut: out, hops: 1 });
		}
	}

	// ── Routes through each base token (WETH, USDT, USDC, etc.) ──
	// Collect all known bases from both tokens' pools
	const allBases = new Set<string>();
	if (inInfo?.pools) for (const p of inInfo.pools) if (p.hasLiquidity) allBases.add(p.base.toLowerCase());
	if (outInfo?.pools) for (const p of outInfo.pools) if (p.hasLiquidity) allBases.add(p.base.toLowerCase());

	for (const base of allBases) {
		const baseInfo = _tokenCache.get(base);
		const baseSymbol = base === weth ? 'WBNB' : (baseInfo?.symbol || base.slice(0, 6));

		if (inAddr === base || outAddr === base) continue; // skip if token IS the base (handled above)

		// tokenIn → base
		let amountAtBase = 0n;
		if (inIsWeth && base === weth) {
			amountAtBase = amountIn;
		} else if (inIsWeth) {
			// WETH → base (base is a token with WETH pool)
			const baseToken = _tokenCache.get(base);
			const baseWethPool = baseToken?.pools.find(p => p.base.toLowerCase() === weth && p.hasLiquidity);
			if (baseWethPool) amountAtBase = _calcOut(amountIn, baseWethPool.reserveBase, baseWethPool.reserveToken);
		} else if (inInfo) {
			const inPool = inInfo.pools.find(p => p.base.toLowerCase() === base && p.hasLiquidity);
			if (inPool) amountAtBase = _calcOut(amountIn, inPool.reserveToken, inPool.reserveBase);
		}

		if (amountAtBase === 0n) continue;

		// base → tokenOut
		let finalOut = 0n;
		if (outIsWeth && base === weth) {
			finalOut = amountAtBase;
		} else if (outIsWeth) {
			// base → WETH
			const baseToken = _tokenCache.get(base);
			const baseWethPool = baseToken?.pools.find(p => p.base.toLowerCase() === weth && p.hasLiquidity);
			if (baseWethPool) finalOut = _calcOut(amountAtBase, baseWethPool.reserveToken, baseWethPool.reserveBase);
		} else if (outInfo) {
			const outPool = outInfo.pools.find(p => p.base.toLowerCase() === base && p.hasLiquidity);
			if (outPool) finalOut = _calcOut(amountAtBase, outPool.reserveBase, outPool.reserveToken);
		}

		if (finalOut > 0n) {
			const path = [inAddr, base, outAddr].filter((v, i, a) => i === 0 || v !== a[i - 1]); // dedup adjacent
			const symbols = [inSymbol, baseSymbol, outSymbol].slice(0, path.length);
			candidates.push({ path, symbols, amountOut: finalOut, hops: path.length - 1 });
		}
	}

	if (candidates.length === 0) return null;

	// Return the route with the highest output
	candidates.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
	return candidates[0];
}

/** Backwards-compatible wrapper — returns just the amount */
export function getInstantQuote(
	tokenIn: string,
	tokenOut: string,
	amountIn: bigint
): bigint | null {
	const route = findBestRoute(tokenIn, tokenOut, amountIn);
	return route?.amountOut ?? null;
}

function _calcOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
	if (reserveIn === 0n || reserveOut === 0n) return 0n;
	const amtWithFee = amountIn * 9975n;
	return (amtWithFee * reserveOut) / (reserveIn * 10000n + amtWithFee);
}
