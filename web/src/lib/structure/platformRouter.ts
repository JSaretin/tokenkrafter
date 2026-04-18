import { ethers } from 'ethers';

// ---------------------------------------------------------------------------
// CreateTokenParams — the `p` tuple passed to all PlatformRouter create fns
// ---------------------------------------------------------------------------

/** Frontend-friendly token creation params (supply as string, decimals as number). */
export interface CreateTokenParams {
	name: string;
	symbol: string;
	totalSupply: string;   // human-readable (e.g. "1000000")
	decimals: number;
	isTaxable: boolean;
	isMintable: boolean;
	isPartner: boolean;
	bases: string[];       // base-token addresses for pool pre-registration
}

/** Contract-level CreateTokenParams tuple (totalSupply as bigint). */
export interface CreateTokenParamsRaw {
	name: string;
	symbol: string;
	totalSupply: bigint;
	decimals: number;
	isTaxable: boolean;
	isMintable: boolean;
	isPartner: boolean;
	bases: string[];
}

export function toCreateTokenParamsRaw(p: CreateTokenParams): CreateTokenParamsRaw {
	return {
		name: p.name,
		symbol: p.symbol,
		totalSupply: ethers.parseUnits(p.totalSupply, p.decimals),
		decimals: p.decimals,
		isTaxable: p.isTaxable,
		isMintable: p.isMintable,
		isPartner: p.isPartner,
		bases: p.bases,
	};
}

export function toCreateTokenParams(raw: CreateTokenParamsRaw): CreateTokenParams {
	return {
		name: raw.name,
		symbol: raw.symbol,
		totalSupply: ethers.formatUnits(raw.totalSupply, raw.decimals),
		decimals: raw.decimals,
		isTaxable: raw.isTaxable,
		isMintable: raw.isMintable,
		isPartner: raw.isPartner,
		bases: raw.bases,
	};
}

// ---------------------------------------------------------------------------
// ProtectionParams — the `protection` tuple
// ---------------------------------------------------------------------------

/** Frontend protection config (human-readable amounts). */
export interface ProtectionParams {
	maxWalletAmount: string;
	maxTransactionAmount: string;
	cooldownSeconds: number;
}

/** Contract-level protection params (bigint amounts). */
export interface ProtectionParamsRaw {
	maxWalletAmount: bigint;
	maxTransactionAmount: bigint;
	cooldownSeconds: bigint;
}

export function toProtectionParamsRaw(p: ProtectionParams, decimals: number): ProtectionParamsRaw {
	return {
		maxWalletAmount: ethers.parseUnits(p.maxWalletAmount, decimals),
		maxTransactionAmount: ethers.parseUnits(p.maxTransactionAmount, decimals),
		cooldownSeconds: BigInt(p.cooldownSeconds),
	};
}

export function toProtectionParams(raw: ProtectionParamsRaw, decimals: number): ProtectionParams {
	return {
		maxWalletAmount: ethers.formatUnits(raw.maxWalletAmount, decimals),
		maxTransactionAmount: ethers.formatUnits(raw.maxTransactionAmount, decimals),
		cooldownSeconds: Number(raw.cooldownSeconds),
	};
}

// ---------------------------------------------------------------------------
// TaxParams — the `tax` tuple
// ---------------------------------------------------------------------------

/** Frontend tax config (percentages as numbers, 0-100 scale with 2 decimal bps). */
export interface TaxParams {
	buyTaxBps: number;
	sellTaxBps: number;
	transferTaxBps: number;
	taxWallets: string[];
	taxSharesBps: number[];
}

/** Contract-level tax params (bps as bigint / uint16). */
export interface TaxParamsRaw {
	buyTaxBps: bigint;
	sellTaxBps: bigint;
	transferTaxBps: bigint;
	taxWallets: string[];
	taxSharesBps: number[];  // uint16[] on-chain, fits in number
}

export function toTaxParamsRaw(p: TaxParams): TaxParamsRaw {
	return {
		buyTaxBps: BigInt(p.buyTaxBps),
		sellTaxBps: BigInt(p.sellTaxBps),
		transferTaxBps: BigInt(p.transferTaxBps),
		taxWallets: p.taxWallets,
		taxSharesBps: p.taxSharesBps,
	};
}

export function toTaxParams(raw: TaxParamsRaw): TaxParams {
	return {
		buyTaxBps: Number(raw.buyTaxBps),
		sellTaxBps: Number(raw.sellTaxBps),
		transferTaxBps: Number(raw.transferTaxBps),
		taxWallets: raw.taxWallets,
		taxSharesBps: raw.taxSharesBps,
	};
}

// ---------------------------------------------------------------------------
// FeePayment — the `fee` tuple
// ---------------------------------------------------------------------------

/** Fee payment path and max input. */
export interface FeePayment {
	path: string[];      // [usdt] direct, [address(0), usdt] native, [erc20, ..., usdt] swap
	maxAmountIn: bigint;
}

// ---------------------------------------------------------------------------
// LaunchParams — the `launch` tuple for createTokenAndLaunch / launchCreatedToken
// ---------------------------------------------------------------------------

/** Frontend launch config (amounts as strings). */
export interface LaunchParams {
	tokensForLaunch: string;
	curveType: number;
	softCap: string;
	hardCap: string;
	durationDays: number;
	maxBuyBps: number;
	creatorAllocationBps: number;
	vestingDays: number;
	startTimestamp: number;
	lockDurationAfterListing: number;
	minBuyUsdt: string;
}

/** Contract-level launch params. */
export interface LaunchParamsRaw {
	tokensForLaunch: bigint;
	curveType: number;
	softCap: bigint;
	hardCap: bigint;
	durationDays: bigint;
	maxBuyBps: bigint;
	creatorAllocationBps: bigint;
	vestingDays: bigint;
	startTimestamp: bigint;
	lockDurationAfterListing: bigint;
	minBuyUsdt: bigint;
}

export function toLaunchParamsRaw(p: LaunchParams, tokenDecimals: number, usdtDecimals = 18): LaunchParamsRaw {
	return {
		tokensForLaunch: ethers.parseUnits(p.tokensForLaunch, tokenDecimals),
		curveType: p.curveType,
		softCap: ethers.parseUnits(p.softCap, usdtDecimals),
		hardCap: ethers.parseUnits(p.hardCap, usdtDecimals),
		durationDays: BigInt(p.durationDays),
		maxBuyBps: BigInt(p.maxBuyBps),
		creatorAllocationBps: BigInt(p.creatorAllocationBps),
		vestingDays: BigInt(p.vestingDays),
		startTimestamp: BigInt(p.startTimestamp),
		lockDurationAfterListing: BigInt(p.lockDurationAfterListing),
		minBuyUsdt: ethers.parseUnits(p.minBuyUsdt, usdtDecimals),
	};
}

export function toLaunchParams(raw: LaunchParamsRaw, tokenDecimals: number, usdtDecimals = 18): LaunchParams {
	return {
		tokensForLaunch: ethers.formatUnits(raw.tokensForLaunch, tokenDecimals),
		curveType: raw.curveType,
		softCap: ethers.formatUnits(raw.softCap, usdtDecimals),
		hardCap: ethers.formatUnits(raw.hardCap, usdtDecimals),
		durationDays: Number(raw.durationDays),
		maxBuyBps: Number(raw.maxBuyBps),
		creatorAllocationBps: Number(raw.creatorAllocationBps),
		vestingDays: Number(raw.vestingDays),
		startTimestamp: Number(raw.startTimestamp),
		lockDurationAfterListing: Number(raw.lockDurationAfterListing),
		minBuyUsdt: ethers.formatUnits(raw.minBuyUsdt, usdtDecimals),
	};
}

// ---------------------------------------------------------------------------
// ListParams — the `list` tuple for createAndList / addLiquidityToExisting
// ---------------------------------------------------------------------------

/** Frontend listing config (amounts as strings). */
export interface ListParams {
	bases: string[];
	baseAmounts: string[];
	tokenAmounts: string[];
	burnLP: boolean;
	tradingDelay: number;
}

/** Contract-level listing params. */
export interface ListParamsRaw {
	bases: string[];
	baseAmounts: bigint[];
	tokenAmounts: bigint[];
	burnLP: boolean;
	tradingDelay: bigint;
}

export function toListParamsRaw(
	p: ListParams,
	baseDecimals: number[],
	tokenDecimals: number,
): ListParamsRaw {
	return {
		bases: p.bases,
		baseAmounts: p.baseAmounts.map((a, i) => ethers.parseUnits(a, baseDecimals[i])),
		tokenAmounts: p.tokenAmounts.map((a) => ethers.parseUnits(a, tokenDecimals)),
		burnLP: p.burnLP,
		tradingDelay: BigInt(p.tradingDelay),
	};
}

export function toListParams(
	raw: ListParamsRaw,
	baseDecimals: number[],
	tokenDecimals: number,
): ListParams {
	return {
		bases: raw.bases,
		baseAmounts: raw.baseAmounts.map((a, i) => ethers.formatUnits(a, baseDecimals[i])),
		tokenAmounts: raw.tokenAmounts.map((a) => ethers.formatUnits(a, tokenDecimals)),
		burnLP: raw.burnLP,
		tradingDelay: Number(raw.tradingDelay),
	};
}

// ---------------------------------------------------------------------------
// QuoteFee — quoteFee(typeKey, withLaunch, path)
// ---------------------------------------------------------------------------

/** Raw return from router.quoteFee — USDT wei values. */
export interface QuoteFeeRaw {
	usdtFee: bigint;
	amountIn: bigint;
}

/** Human-readable fee quote. */
export interface QuoteFeeView {
	usdtFee: string;
	amountIn: string;
}

export function toQuoteFeeView(raw: QuoteFeeRaw, usdtDecimals = 18, inputDecimals = 18): QuoteFeeView {
	return {
		usdtFee: ethers.formatUnits(raw.usdtFee, usdtDecimals),
		amountIn: ethers.formatUnits(raw.amountIn, inputDecimals),
	};
}

export function toQuoteFeeRaw(view: QuoteFeeView, usdtDecimals = 18, inputDecimals = 18): QuoteFeeRaw {
	return {
		usdtFee: ethers.parseUnits(view.usdtFee, usdtDecimals),
		amountIn: ethers.parseUnits(view.amountIn, inputDecimals),
	};
}
