/**
 * TradeLens — batch token prices + tax simulation in one eth_call.
 * No deployment needed — uses state override.
 */
import { ethers } from 'ethers';

const TRADE_LENS_ABI = [
	`function query(address router, address[] tokens, address user, address simulateTax, uint256 simBuyAmount) external returns (
		tuple(
			address weth,
			address factory,
			uint256 nativeBalance,
			tuple(address token, string symbol, string name, uint8 decimals, uint256 reserveToken, uint256 reserveBase, address pairAddress, bool hasLiquidity, uint256 balance)[] tokens,
			tuple(bool success, bool canBuy, bool canSell, uint256 buyTaxBps, uint256 sellTaxBps, uint256 buyGas, uint256 sellGas, string buyError, string sellError) taxInfo,
			address taxToken
		)
	)`
];

export interface TokenInfo {
	token: string;
	symbol: string;
	name: string;
	decimals: number;
	reserveToken: bigint;
	reserveBase: bigint;
	pairAddress: string;
	hasLiquidity: boolean;
	balance: bigint;
}

export interface TaxInfo {
	success: boolean;
	canBuy: boolean;
	canSell: boolean;
	buyTaxBps: number;
	sellTaxBps: number;
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

// Deployed TradeLens contracts per chain
const TRADE_LENS_ADDRESSES: Record<number, string> = {
	56: '0x510E93b0d3928980bb9A72795b7948ad1e0800f1', // BSC
};

// ── Price cache ──────────────────────────────────────────
let _tokenCache: Map<string, TokenInfo> = new Map();
let _weth = '';
let _lastFetch = 0;

/**
 * Fetch all token info + balances + optionally simulate tax — one call.
 * @param user User address for balances (ZeroAddress to skip)
 * @param simulateTax Token to simulate tax for (ZeroAddress to skip)
 */
export async function queryTradeLens(
	provider: ethers.JsonRpcProvider,
	dexRouter: string,
	tokens: string[],
	simulateTax: string = ethers.ZeroAddress,
	simBuyAmount: bigint = ethers.parseEther('0.001'),
	user: string = ethers.ZeroAddress,
	chainId: number = 56
): Promise<TradeLensResult> {
	const addr = TRADE_LENS_ADDRESSES[chainId];
	if (!addr) throw new Error(`No TradeLens on chain ${chainId}`);

	const contract = new ethers.Contract(addr, TRADE_LENS_ABI, provider);
	const r = await contract.query.staticCall(dexRouter, tokens, user, simulateTax, simBuyAmount, { gasLimit: 15000000 });

	const tokenInfos: TokenInfo[] = r.tokens.map((t: any) => ({
		token: t.token,
		symbol: t.symbol,
		name: t.name,
		decimals: Number(t.decimals),
		reserveToken: t.reserveToken,
		reserveBase: t.reserveBase,
		pairAddress: t.pairAddress,
		hasLiquidity: t.hasLiquidity,
		balance: t.balance,
	}));

	// Update cache
	_weth = r.weth;
	_nativeBalance = r.nativeBalance;
	for (const t of tokenInfos) {
		_tokenCache.set(t.token.toLowerCase(), t);
	}
	_lastFetch = Date.now();

	return {
		weth: r.weth,
		factory: r.factory,
		nativeBalance: r.nativeBalance,
		tokens: tokenInfos,
		taxInfo: {
			success: r.taxInfo.success,
			canBuy: r.taxInfo.canBuy,
			canSell: r.taxInfo.canSell,
			buyTaxBps: Number(r.taxInfo.buyTaxBps),
			sellTaxBps: Number(r.taxInfo.sellTaxBps),
			buyGas: Number(r.taxInfo.buyGas),
			sellGas: Number(r.taxInfo.sellGas),
			buyError: r.taxInfo.buyError,
			sellError: r.taxInfo.sellError,
		},
		taxToken: r.taxToken,
	};
}

/** Get cached WETH address */
export function getWeth(): string { return _weth; }

/** Get cached token info */
export function getCachedToken(addr: string): TokenInfo | null {
	return _tokenCache.get(addr.toLowerCase()) || null;
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
let _nativeBalance = 0n;
export function getNativeBalance(): bigint { return _nativeBalance; }

/** Get cached token balance */
export function getCachedBalance(addr: string): bigint {
	return _tokenCache.get(addr.toLowerCase())?.balance || 0n;
}

/**
 * Instant swap quote from cached reserves (pure math, 0ms).
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

	const inIsWeth = inAddr === weth;
	const outIsWeth = outAddr === weth;

	// token → WETH
	if (outIsWeth && inInfo?.hasLiquidity) {
		return _calcOut(amountIn, inInfo.reserveToken, inInfo.reserveBase);
	}

	// WETH → token
	if (inIsWeth && outInfo?.hasLiquidity) {
		return _calcOut(amountIn, outInfo.reserveBase, outInfo.reserveToken);
	}

	// token → WETH → token (two hops)
	if (inInfo?.hasLiquidity && outInfo?.hasLiquidity) {
		const wethOut = _calcOut(amountIn, inInfo.reserveToken, inInfo.reserveBase);
		if (wethOut === 0n) return null;
		return _calcOut(wethOut, outInfo.reserveBase, outInfo.reserveToken);
	}

	return null;
}

function _calcOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
	if (reserveIn === 0n || reserveOut === 0n) return 0n;
	const amtWithFee = amountIn * 9975n;
	const num = amtWithFee * reserveOut;
	const den = reserveIn * 10000n + amtWithFee;
	return num / den;
}
