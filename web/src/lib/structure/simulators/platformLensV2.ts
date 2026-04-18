import { ethers } from 'ethers';
import { CurveType, curveLabel, LaunchState, launchStateLabel } from '../launchInstance';

/**
 * PlatformLensV2 — constructor-only. Query-type-dispatched reader.
 *
 * queryType:
 *   0 = getTokensByCreator(creator, offset, limit) → (TokenData[], total)
 *   1 = getActiveLaunches(offset, limit)           → (LaunchData[], total)
 *   3 = getTokenInfo(token)                        → TokenData
 *   4 = platformStats()                            → PlatformStats
 */

// ════════════════════════════════════════════════════════════════════════════
//  Enums
// ════════════════════════════════════════════════════════════════════════════

export enum QueryType {
	TokensByCreator = 0,
	ActiveLaunches = 1,
	BatchLaunchInfo = 2,        // reserved — not implemented in current contract
	TokenInfo = 3,
	PlatformStats = 4,
}

// ════════════════════════════════════════════════════════════════════════════
//  Raw types
// ════════════════════════════════════════════════════════════════════════════

export interface TokenDataRaw {
	token: string;
	name: string;
	symbol: string;
	decimals: number;
	totalSupply: bigint;
	creator: string;
	owner: string;
	isMintable: boolean;
	isTaxable: boolean;
	isPartner: boolean;
}

export interface LaunchDataRaw {
	launch: string;
	token: string;
	creator: string;
	curveType: number;
	state: number;
	softCap: bigint;
	hardCap: bigint;
	deadline: bigint;
	startTimestamp: bigint;
	totalBaseRaised: bigint;
	tokensSold: bigint;
	tokensForCurve: bigint;
	currentPrice: bigint;
	totalPurchases: bigint;
	totalBuyers: bigint;
	stateHash: string;           // bytes32 hex
	tokenName: string;
	tokenSymbol: string;
	tokenDecimals: number;
}

export interface PlatformStatsRaw {
	totalTokens: bigint;
	totalTokenFeeUsdt: bigint;
	feesPerType: bigint[];       // length 8
	countPerType: bigint[];
	totalLaunches: bigint;
	totalLaunchFeeUsdt: bigint;
	launchFee: bigint;
}

export interface TokensPageRaw { results: TokenDataRaw[]; total: bigint; }
export interface LaunchesPageRaw { results: LaunchDataRaw[]; total: bigint; }

// ════════════════════════════════════════════════════════════════════════════
//  View types
// ════════════════════════════════════════════════════════════════════════════

export interface TokenDataView {
	token: string;
	name: string;
	symbol: string;
	decimals: number;
	totalSupply: string;
	creator: string;
	owner: string;
	isMintable: boolean;
	isTaxable: boolean;
	isPartner: boolean;
}

export interface LaunchDataView {
	launch: string;
	token: string;
	creator: string;
	curveType: CurveType;
	curveLabel: string;
	state: LaunchState;
	stateLabel: string;
	softCap: string;
	hardCap: string;
	deadline: Date;
	startTimestamp: Date | null;
	totalBaseRaised: string;
	tokensSold: string;
	tokensForCurve: string;
	currentPrice: string;
	totalPurchases: number;
	totalBuyers: number;
	stateHash: string;
	tokenName: string;
	tokenSymbol: string;
	tokenDecimals: number;
}

export interface PlatformStatsView {
	totalTokens: number;
	totalTokenFeeUsdt: string;
	feesPerType: string[];
	countPerType: number[];
	totalLaunches: number;
	totalLaunchFeeUsdt: string;
	launchFee: string;
}

export interface TokensPageView { results: TokenDataView[]; total: number; }
export interface LaunchesPageView { results: LaunchDataView[]; total: number; }

// ════════════════════════════════════════════════════════════════════════════
//  Constructor params
// ════════════════════════════════════════════════════════════════════════════

export interface ConstructorParams {
	tokenFactory: string;
	launchpadFactory: string;
	queryType: QueryType;
	/** Creator address (type 0) or token address (type 3); any address otherwise. */
	param: string;
	offset: number;
	limit: number;
}
export interface ConstructorParamsRaw {
	tokenFactory: string;
	launchpadFactory: string;
	queryType: number;
	param: string;
	offset: bigint;
	limit: bigint;
}

export function toConstructorParamsRaw(p: ConstructorParams): ConstructorParamsRaw {
	return {
		tokenFactory: p.tokenFactory,
		launchpadFactory: p.launchpadFactory,
		queryType: Number(p.queryType),
		param: p.param,
		offset: BigInt(p.offset),
		limit: BigInt(p.limit),
	};
}

// ════════════════════════════════════════════════════════════════════════════
//  Converters
// ════════════════════════════════════════════════════════════════════════════

export function toTokenDataView(raw: TokenDataRaw): TokenDataView {
	const dec = Number(raw.decimals) || 18;
	return {
		token: raw.token,
		name: raw.name,
		symbol: raw.symbol,
		decimals: dec,
		totalSupply: ethers.formatUnits(raw.totalSupply, dec),
		creator: raw.creator,
		owner: raw.owner,
		isMintable: raw.isMintable,
		isTaxable: raw.isTaxable,
		isPartner: raw.isPartner,
	};
}

export function toLaunchDataView(raw: LaunchDataRaw, usdtDecimals = 18): LaunchDataView {
	const td = Number(raw.tokenDecimals) || 18;
	const curve = Number(raw.curveType) as CurveType;
	const state = Number(raw.state) as LaunchState;
	return {
		launch: raw.launch,
		token: raw.token,
		creator: raw.creator,
		curveType: curve,
		curveLabel: curveLabel(curve),
		state,
		stateLabel: launchStateLabel(state),
		softCap: ethers.formatUnits(raw.softCap, usdtDecimals),
		hardCap: ethers.formatUnits(raw.hardCap, usdtDecimals),
		deadline: new Date(Number(raw.deadline) * 1000),
		startTimestamp: raw.startTimestamp === 0n ? null : new Date(Number(raw.startTimestamp) * 1000),
		totalBaseRaised: ethers.formatUnits(raw.totalBaseRaised, usdtDecimals),
		tokensSold: ethers.formatUnits(raw.tokensSold, td),
		tokensForCurve: ethers.formatUnits(raw.tokensForCurve, td),
		currentPrice: ethers.formatUnits(raw.currentPrice, usdtDecimals),
		totalPurchases: Number(raw.totalPurchases),
		totalBuyers: Number(raw.totalBuyers),
		stateHash: raw.stateHash,
		tokenName: raw.tokenName,
		tokenSymbol: raw.tokenSymbol,
		tokenDecimals: td,
	};
}

export function toPlatformStatsView(raw: PlatformStatsRaw, usdtDecimals = 18): PlatformStatsView {
	return {
		totalTokens: Number(raw.totalTokens),
		totalTokenFeeUsdt: ethers.formatUnits(raw.totalTokenFeeUsdt, usdtDecimals),
		feesPerType: raw.feesPerType.map(f => ethers.formatUnits(f, usdtDecimals)),
		countPerType: raw.countPerType.map(c => Number(c)),
		totalLaunches: Number(raw.totalLaunches),
		totalLaunchFeeUsdt: ethers.formatUnits(raw.totalLaunchFeeUsdt, usdtDecimals),
		launchFee: ethers.formatUnits(raw.launchFee, usdtDecimals),
	};
}

export function toTokensPageView(raw: TokensPageRaw): TokensPageView {
	return { results: raw.results.map(toTokenDataView), total: Number(raw.total) };
}

export function toLaunchesPageView(raw: LaunchesPageRaw, usdtDecimals = 18): LaunchesPageView {
	return {
		results: raw.results.map(r => toLaunchDataView(r, usdtDecimals)),
		total: Number(raw.total),
	};
}
