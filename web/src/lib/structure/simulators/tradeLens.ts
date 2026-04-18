import { ethers } from 'ethers';

/**
 * TradeLens — stateful simulator contract. Batch price fetch + tax detection.
 * Deployed once per chain, called via standard eth_call.
 *
 * query(router, tokens, user, simulateTax, simBuyAmount) → FullResult
 */

// ════════════════════════════════════════════════════════════════════════════
//  Raw types
// ════════════════════════════════════════════════════════════════════════════

export interface TokenInfoRaw {
	token: string;
	symbol: string;
	name: string;
	decimals: number;          // uint8
	reserveToken: bigint;
	reserveBase: bigint;
	pairAddress: string;
	hasLiquidity: boolean;
	balance: bigint;
}

export interface TaxInfoRaw {
	success: boolean;
	canBuy: boolean;
	canSell: boolean;
	buyTaxBps: bigint;
	sellTaxBps: bigint;
	transferTaxBps: bigint;
	buyGas: bigint;
	sellGas: bigint;
	buyError: string;
	sellError: string;
}

export interface FullResultRaw {
	weth: string;
	factory: string;
	nativeBalance: bigint;
	tokens: TokenInfoRaw[];
	taxInfo: TaxInfoRaw;
	taxToken: string;
}

// ════════════════════════════════════════════════════════════════════════════
//  View types
// ════════════════════════════════════════════════════════════════════════════

export interface TokenInfoView {
	token: string;
	symbol: string;
	name: string;
	decimals: number;
	reserveToken: string;      // formatted with token decimals
	reserveBase: string;       // formatted with base decimals (18 assumed)
	pairAddress: string;
	hasLiquidity: boolean;
	balance: string;           // formatted with token decimals
}

export interface TaxInfoView {
	success: boolean;
	canBuy: boolean;
	canSell: boolean;
	buyTaxPct: number;
	sellTaxPct: number;
	transferTaxPct: number;
	buyGas: number;
	sellGas: number;
	buyError: string;
	sellError: string;
}

export interface FullResultView {
	weth: string;
	factory: string;
	nativeBalance: string;
	tokens: TokenInfoView[];
	taxInfo: TaxInfoView;
	taxToken: string;
}

// ════════════════════════════════════════════════════════════════════════════
//  Write params (read-only call, but named for symmetry)
// ════════════════════════════════════════════════════════════════════════════

export interface QueryParams {
	router: string;
	tokens: string[];
	user: string;              // ethers.ZeroAddress to skip balances
	simulateTax: string;       // ethers.ZeroAddress to skip
	simBuyAmount: string;      // human ETH — msg.value for the simulation
}
export interface QueryParamsRaw {
	router: string;
	tokens: string[];
	user: string;
	simulateTax: string;
	simBuyAmount: bigint;
}

export function toQueryParamsRaw(p: QueryParams): QueryParamsRaw {
	return {
		router: p.router,
		tokens: p.tokens,
		user: p.user,
		simulateTax: p.simulateTax,
		simBuyAmount: ethers.parseEther(p.simBuyAmount || '0'),
	};
}

// ════════════════════════════════════════════════════════════════════════════
//  Converters — reads
// ════════════════════════════════════════════════════════════════════════════

const bpsToPct = (b: bigint | number) => Number(b) / 100;

export function toTokenInfoView(raw: TokenInfoRaw, baseDecimals = 18): TokenInfoView {
	const dec = Number(raw.decimals);
	return {
		token: raw.token,
		symbol: raw.symbol,
		name: raw.name,
		decimals: dec,
		reserveToken: ethers.formatUnits(raw.reserveToken, dec),
		reserveBase: ethers.formatUnits(raw.reserveBase, baseDecimals),
		pairAddress: raw.pairAddress,
		hasLiquidity: raw.hasLiquidity,
		balance: ethers.formatUnits(raw.balance, dec),
	};
}

export function toTaxInfoView(raw: TaxInfoRaw): TaxInfoView {
	return {
		success: raw.success,
		canBuy: raw.canBuy,
		canSell: raw.canSell,
		buyTaxPct: bpsToPct(raw.buyTaxBps),
		sellTaxPct: bpsToPct(raw.sellTaxBps),
		transferTaxPct: bpsToPct(raw.transferTaxBps),
		buyGas: Number(raw.buyGas),
		sellGas: Number(raw.sellGas),
		buyError: raw.buyError,
		sellError: raw.sellError,
	};
}

export function toFullResultView(raw: FullResultRaw, baseDecimals = 18): FullResultView {
	return {
		weth: raw.weth,
		factory: raw.factory,
		nativeBalance: ethers.formatEther(raw.nativeBalance),
		tokens: raw.tokens.map(t => toTokenInfoView(t, baseDecimals)),
		taxInfo: toTaxInfoView(raw.taxInfo),
		taxToken: raw.taxToken,
	};
}
