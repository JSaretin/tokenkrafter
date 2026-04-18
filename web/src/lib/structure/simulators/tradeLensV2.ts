import { ethers } from 'ethers';

/**
 * TradeLensV2 — constructor-only simulator (never deployed).
 * Multi-base liquidity check + multi-user balance query + tax simulation.
 *
 * Returns raw abi-encoded (weth, factory, UserInfo[], TokenInfo[], TaxInfo, taxToken).
 */

// ════════════════════════════════════════════════════════════════════════════
//  Raw types
// ════════════════════════════════════════════════════════════════════════════

export interface PoolInfoRaw {
	base: string;
	pairAddress: string;
	reserveToken: bigint;
	reserveBase: bigint;
	hasLiquidity: boolean;
}

export interface TokenInfoRaw {
	token: string;
	name: string;
	symbol: string;
	decimals: number;
	totalSupply: bigint;
	hasLiquidity: boolean;
	pools: PoolInfoRaw[];
	balances: bigint[];
}

export interface UserInfoRaw {
	user: string;
	nativeBalance: bigint;
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

export interface LensResultRaw {
	weth: string;
	factory: string;
	users: UserInfoRaw[];
	tokens: TokenInfoRaw[];
	taxInfo: TaxInfoRaw;
	taxToken: string;
}

// ════════════════════════════════════════════════════════════════════════════
//  View types
// ════════════════════════════════════════════════════════════════════════════

export interface PoolInfoView {
	base: string;
	pairAddress: string;
	reserveToken: string;
	reserveBase: string;
	hasLiquidity: boolean;
}

export interface TokenInfoView {
	token: string;
	name: string;
	symbol: string;
	decimals: number;
	totalSupply: string;
	hasLiquidity: boolean;
	pools: PoolInfoView[];
	balances: string[];
}

export interface UserInfoView {
	user: string;
	nativeBalance: string;
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

export interface LensResultView {
	weth: string;
	factory: string;
	users: UserInfoView[];
	tokens: TokenInfoView[];
	taxInfo: TaxInfoView;
	taxToken: string;
}

// ════════════════════════════════════════════════════════════════════════════
//  Write params (constructor args)
// ════════════════════════════════════════════════════════════════════════════

export interface ConstructorParams {
	router: string;
	tokens: string[];
	baseTokens: string[];
	users: string[];
	simulateTax: string;
	simBuyAmount: string;      // ETH human
}
export interface ConstructorParamsRaw {
	router: string;
	tokens: string[];
	baseTokens: string[];
	users: string[];
	simulateTax: string;
	simBuyAmount: bigint;
}

export function toConstructorParamsRaw(p: ConstructorParams): ConstructorParamsRaw {
	return { ...p, simBuyAmount: ethers.parseEther(p.simBuyAmount || '0') };
}

// ════════════════════════════════════════════════════════════════════════════
//  Converters
// ════════════════════════════════════════════════════════════════════════════

const bpsToPct = (b: bigint | number) => Number(b) / 100;

export function toPoolInfoView(raw: PoolInfoRaw, tokenDecimals: number, baseDecimals = 18): PoolInfoView {
	return {
		base: raw.base,
		pairAddress: raw.pairAddress,
		reserveToken: ethers.formatUnits(raw.reserveToken, tokenDecimals),
		reserveBase: ethers.formatUnits(raw.reserveBase, baseDecimals),
		hasLiquidity: raw.hasLiquidity,
	};
}

export function toTokenInfoView(raw: TokenInfoRaw): TokenInfoView {
	const dec = Number(raw.decimals);
	return {
		token: raw.token,
		name: raw.name,
		symbol: raw.symbol,
		decimals: dec,
		totalSupply: ethers.formatUnits(raw.totalSupply, dec),
		hasLiquidity: raw.hasLiquidity,
		pools: raw.pools.map(p => toPoolInfoView(p, dec)),
		balances: raw.balances.map(b => ethers.formatUnits(b, dec)),
	};
}

export function toUserInfoView(raw: UserInfoRaw): UserInfoView {
	return { user: raw.user, nativeBalance: ethers.formatEther(raw.nativeBalance) };
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

export function toLensResultView(raw: LensResultRaw): LensResultView {
	return {
		weth: raw.weth,
		factory: raw.factory,
		users: raw.users.map(toUserInfoView),
		tokens: raw.tokens.map(toTokenInfoView),
		taxInfo: toTaxInfoView(raw.taxInfo),
		taxToken: raw.taxToken,
	};
}
