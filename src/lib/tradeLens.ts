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

/** Instant swap quote from cached reserves */
export function getInstantQuote(
	tokenIn: string,
	tokenOut: string,
	amountIn: bigint
): bigint | null {
	if (!_weth || amountIn === 0n) return null;

	const inAddr = tokenIn.toLowerCase();
	const outAddr = tokenOut.toLowerCase();
	const weth = _weth.toLowerCase();

	const inInfo = _tokenCache.get(inAddr);
	const outInfo = _tokenCache.get(outAddr);

	const inPool = _findPool(inInfo, weth);
	const outPool = _findPool(outInfo, weth);

	const inIsWeth = inAddr === weth;
	const outIsWeth = outAddr === weth;

	if (outIsWeth && inPool) return _calcOut(amountIn, inPool.reserveToken, inPool.reserveBase);
	if (inIsWeth && outPool) return _calcOut(amountIn, outPool.reserveBase, outPool.reserveToken);
	if (inPool && outPool) {
		const wethOut = _calcOut(amountIn, inPool.reserveToken, inPool.reserveBase);
		if (wethOut === 0n) return null;
		return _calcOut(wethOut, outPool.reserveBase, outPool.reserveToken);
	}
	return null;
}

function _findPool(info: TokenInfo | undefined, weth: string): PoolInfo | null {
	if (!info?.pools?.length) return null;
	const wethPool = info.pools.find(p => p.base.toLowerCase() === weth && p.hasLiquidity);
	if (wethPool) return wethPool;
	return info.pools.find(p => p.hasLiquidity) || null;
}

function _calcOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
	if (reserveIn === 0n || reserveOut === 0n) return 0n;
	const amtWithFee = amountIn * 9975n;
	return (amtWithFee * reserveOut) / (reserveIn * 10000n + amtWithFee);
}
