/**
 * TradeLensV2 — constructor-only contract for batch token info + tax simulation.
 * No deployment needed. Uses eth_call with bytecode + encoded args.
 * Checks each token against ALL provided base tokens for liquidity.
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
	balance: bigint;
	hasLiquidity: boolean;  // true if ANY pool has liquidity
	pools: PoolInfo[];
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
	nativeBalance: bigint;
	tokens: TokenInfo[];
	taxInfo: TaxInfo;
	taxToken: string;
}

// ABI types for decoding constructor return
const RESULT_TYPES = [
	'address', // weth
	'address', // factory
	'uint256', // nativeBalance
	// TokenInfo[] with nested PoolInfo[]
	'tuple(address token, string name, string symbol, uint8 decimals, uint256 totalSupply, uint256 balance, bool hasLiquidity, tuple(address base, address pairAddress, uint256 reserveToken, uint256 reserveBase, bool hasLiquidity)[] pools)[]',
	// TaxInfo
	'tuple(bool success, bool canBuy, bool canSell, uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps, uint256 buyGas, uint256 sellGas, string buyError, string sellError)',
	'address', // taxToken
];

// ── Cache ──────────────────────────────────────────
let _tokenCache: Map<string, TokenInfo> = new Map();
let _weth = '';
let _lastFetch = 0;
let _nativeBalance = 0n;

/**
 * Fetch all token info + balances + optionally simulate tax — one eth_call.
 * Checks each token against all provided base tokens for liquidity.
 *
 * @param provider JSON-RPC provider
 * @param dexRouter DEX router address (e.g. PancakeSwap)
 * @param tokens Token addresses to query
 * @param simulateTax Token to simulate tax for (ZeroAddress to skip)
 * @param simBuyAmount ETH amount for tax simulation
 * @param user User address for balances (ZeroAddress to skip)
 * @param chainId Chain ID (unused now — no deployed address needed)
 * @param baseTokens Base tokens to check pools against (default: just WETH via router)
 */
export async function queryTradeLens(
	provider: ethers.JsonRpcProvider,
	dexRouter: string,
	tokens: string[],
	simulateTax: string = ethers.ZeroAddress,
	simBuyAmount: bigint = ethers.parseEther('0.001'),
	user: string = ethers.ZeroAddress,
	chainId: number = 56,
	baseTokens: string[] = []
): Promise<TradeLensResult> {
	const abiCoder = ethers.AbiCoder.defaultAbiCoder();

	const args = abiCoder.encode(
		['address', 'address[]', 'address[]', 'address', 'address', 'uint256'],
		[dexRouter, tokens, baseTokens, user, simulateTax, simBuyAmount]
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

	const tokenInfos: TokenInfo[] = (decoded[3] as any[]).map((t: any) => ({
		token: t.token,
		name: t.name,
		symbol: t.symbol,
		decimals: Number(t.decimals),
		totalSupply: t.totalSupply,
		balance: t.balance,
		hasLiquidity: t.hasLiquidity,
		pools: (t.pools as any[]).map((p: any) => ({
			base: p.base,
			pairAddress: p.pairAddress,
			reserveToken: p.reserveToken,
			reserveBase: p.reserveBase,
			hasLiquidity: p.hasLiquidity,
		})),
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
	_nativeBalance = decoded[2] as bigint;
	for (const t of tokenInfos) {
		_tokenCache.set(t.token.toLowerCase(), t);
	}
	_lastFetch = Date.now();

	return {
		weth: decoded[0] as string,
		factory: decoded[1] as string,
		nativeBalance: decoded[2] as bigint,
		tokens: tokenInfos,
		taxInfo,
		taxToken: decoded[5] as string,
	};
}

/** Get cached WETH address */
export function getWeth(): string { return _weth; }

/** Get cached token info (includes pools) */
export function getCachedToken(addr: string): TokenInfo | null {
	return _tokenCache.get(addr.toLowerCase()) || null;
}

/** Get USD value of a token amount using cached reserves (WETH as intermediary) */
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
	// Find USDT's WETH pool
	const usdtWethPool = usdtInfo.pools.find(p => p.base.toLowerCase() === weth && p.hasLiquidity);
	if (!usdtWethPool || usdtWethPool.reserveBase === 0n) return null;
	const wethPriceUsdt = Number(usdtWethPool.reserveToken) / Number(usdtWethPool.reserveBase);

	if (addr === weth) {
		return parseFloat(ethers.formatUnits(amount, 18)) * wethPriceUsdt;
	}

	const tokenInfo = _tokenCache.get(addr);
	if (!tokenInfo) return null;
	// Find token's WETH pool
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

/** Get cached native balance */
export function getNativeBalance(): bigint { return _nativeBalance; }

/** Get cached token balance */
export function getCachedBalance(addr: string): bigint {
	return _tokenCache.get(addr.toLowerCase())?.balance || 0n;
}

/**
 * Instant swap quote from cached reserves (pure math, 0ms).
 * Tries WETH pair first, falls back to any liquid pool.
 * Uses constant product formula: dy = (dx * 9975 * ry) / (rx * 10000 + dx * 9975)
 */
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

	// Find best liquid pool for each token (prefer WETH)
	const inPool = _findPool(inInfo, weth);
	const outPool = _findPool(outInfo, weth);

	const inIsWeth = inAddr === weth;
	const outIsWeth = outAddr === weth;

	// token → WETH
	if (outIsWeth && inPool) {
		return _calcOut(amountIn, inPool.reserveToken, inPool.reserveBase);
	}

	// WETH → token
	if (inIsWeth && outPool) {
		return _calcOut(amountIn, outPool.reserveBase, outPool.reserveToken);
	}

	// token → WETH → token (two hops via WETH pools)
	if (inPool && outPool) {
		const wethOut = _calcOut(amountIn, inPool.reserveToken, inPool.reserveBase);
		if (wethOut === 0n) return null;
		return _calcOut(wethOut, outPool.reserveBase, outPool.reserveToken);
	}

	return null;
}

/** Find the best liquid pool (prefer WETH base) */
function _findPool(info: TokenInfo | undefined, weth: string): PoolInfo | null {
	if (!info?.pools?.length) return null;
	// Prefer WETH pool
	const wethPool = info.pools.find(p => p.base.toLowerCase() === weth && p.hasLiquidity);
	if (wethPool) return wethPool;
	// Fall back to any liquid pool
	return info.pools.find(p => p.hasLiquidity) || null;
}

function _calcOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
	if (reserveIn === 0n || reserveOut === 0n) return 0n;
	const amtWithFee = amountIn * 9975n;
	const num = amtWithFee * reserveOut;
	const den = reserveIn * 10000n + amtWithFee;
	return num / den;
}
