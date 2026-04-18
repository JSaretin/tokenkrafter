import { ethers } from 'ethers';
import { CurveType, curveLabel, LaunchState, launchStateLabel } from '../launchInstance';

/**
 * AdminLens — constructor-only batch reader. One eth_call returns every
 * figure the admin dashboard needs. Returns: (FactoryState, LaunchpadState,
 * TradeRouterState, TokenInfo[], LaunchInfo[]).
 */

// ════════════════════════════════════════════════════════════════════════════
//  Raw types
// ════════════════════════════════════════════════════════════════════════════

export interface FactoryStateRaw {
	owner: string;
	totalTokens: bigint;
	totalFeeUsdt: bigint;
	feesPerType: bigint[];       // length 8
	countPerType: bigint[];
	taxToStable: boolean;
	taxSlippage: bigint;
	refLevels: number;
	autoDistribute: boolean;
	dexRouter: string;
	usdt: string;
	usdtDecimals: number;
	authorizedRouter: string;
	platformWallet: string;
	partnerBases: string[];
	maxPartnerBases: bigint;
}

export interface LaunchpadStateRaw {
	owner: string;
	totalLaunches: bigint;
	totalFeeUsdt: bigint;
	launchFee: bigint;
	platformWallet: string;
	dexRouter: string;
	usdt: string;
	authorizedRouter: string;
	launchImplementation: string;
}

export interface TradeRouterStateRaw {
	owner: string;
	feeBps: bigint;
	payoutTimeout: bigint;
	platformWallet: string;
	totalEscrow: bigint;
	pendingCount: bigint;
	totalWithdrawals: bigint;
	paused: boolean;
	maxSlippageBps: bigint;
	affiliateEnabled: boolean;
	affiliateShareBps: bigint;
	minWithdrawUsdt: bigint;
	platformEarningsUsdt: bigint;
}

export interface TokenInfoRaw {
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

export interface LaunchInfoRaw {
	launch: string;
	token: string;
	tokenName: string;
	tokenSymbol: string;
	tokenDecimals: number;
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
	tokensForLP: bigint;
	currentPrice: bigint;
	totalPurchases: bigint;
	totalBuyers: bigint;
}

export interface AdminLensResultRaw {
	factory: FactoryStateRaw;
	launchpad: LaunchpadStateRaw;
	tradeRouter: TradeRouterStateRaw;
	tokens: TokenInfoRaw[];
	launches: LaunchInfoRaw[];
}

// ════════════════════════════════════════════════════════════════════════════
//  View types
// ════════════════════════════════════════════════════════════════════════════

export interface FactoryStateView {
	owner: string;
	totalTokens: number;
	totalFeeUsdt: string;
	feesPerType: string[];       // formatted USDT
	countPerType: number[];
	taxToStable: boolean;
	taxSlippagePct: number;
	refLevels: number;
	autoDistribute: boolean;
	dexRouter: string;
	usdt: string;
	usdtDecimals: number;
	authorizedRouter: string;
	platformWallet: string;
	partnerBases: string[];
	maxPartnerBases: number;
}

export interface LaunchpadStateView {
	owner: string;
	totalLaunches: number;
	totalFeeUsdt: string;
	launchFee: string;
	platformWallet: string;
	dexRouter: string;
	usdt: string;
	authorizedRouter: string;
	launchImplementation: string;
}

export interface TradeRouterStateView {
	owner: string;
	feePct: number;
	payoutTimeoutSec: number;
	platformWallet: string;
	totalEscrow: string;
	pendingCount: number;
	totalWithdrawals: number;
	paused: boolean;
	maxSlippagePct: number;
	affiliateEnabled: boolean;
	affiliateSharePct: number;
	minWithdrawUsdt: string;
	platformEarningsUsdt: string;
}

export interface TokenInfoView {
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

export interface LaunchInfoView {
	launch: string;
	token: string;
	tokenName: string;
	tokenSymbol: string;
	tokenDecimals: number;
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
	tokensForLP: string;
	currentPrice: string;
	totalPurchases: number;
	totalBuyers: number;
}

export interface AdminLensResultView {
	factory: FactoryStateView;
	launchpad: LaunchpadStateView;
	tradeRouter: TradeRouterStateView;
	tokens: TokenInfoView[];
	launches: LaunchInfoView[];
}

// ════════════════════════════════════════════════════════════════════════════
//  Constructor params
// ════════════════════════════════════════════════════════════════════════════

export interface ConstructorParams {
	tokenFactory: string;
	launchpadFactory: string;
	tradeRouter: string;
	recentTokenCount: number;
	recentLaunchCount: number;
}
export interface ConstructorParamsRaw {
	tokenFactory: string;
	launchpadFactory: string;
	tradeRouter: string;
	recentTokenCount: bigint;
	recentLaunchCount: bigint;
}

export function toConstructorParamsRaw(p: ConstructorParams): ConstructorParamsRaw {
	return {
		tokenFactory: p.tokenFactory,
		launchpadFactory: p.launchpadFactory,
		tradeRouter: p.tradeRouter,
		recentTokenCount: BigInt(p.recentTokenCount),
		recentLaunchCount: BigInt(p.recentLaunchCount),
	};
}

// ════════════════════════════════════════════════════════════════════════════
//  Converters
// ════════════════════════════════════════════════════════════════════════════

const bpsToPct = (b: bigint | number) => Number(b) / 100;

export function toFactoryStateView(raw: FactoryStateRaw): FactoryStateView {
	const ud = raw.usdtDecimals || 18;
	return {
		owner: raw.owner,
		totalTokens: Number(raw.totalTokens),
		totalFeeUsdt: ethers.formatUnits(raw.totalFeeUsdt, ud),
		feesPerType: raw.feesPerType.map(f => ethers.formatUnits(f, ud)),
		countPerType: raw.countPerType.map(c => Number(c)),
		taxToStable: raw.taxToStable,
		taxSlippagePct: bpsToPct(raw.taxSlippage),
		refLevels: Number(raw.refLevels),
		autoDistribute: raw.autoDistribute,
		dexRouter: raw.dexRouter,
		usdt: raw.usdt,
		usdtDecimals: ud,
		authorizedRouter: raw.authorizedRouter,
		platformWallet: raw.platformWallet,
		partnerBases: raw.partnerBases,
		maxPartnerBases: Number(raw.maxPartnerBases),
	};
}

export function toLaunchpadStateView(raw: LaunchpadStateRaw, usdtDecimals = 18): LaunchpadStateView {
	return {
		owner: raw.owner,
		totalLaunches: Number(raw.totalLaunches),
		totalFeeUsdt: ethers.formatUnits(raw.totalFeeUsdt, usdtDecimals),
		launchFee: ethers.formatUnits(raw.launchFee, usdtDecimals),
		platformWallet: raw.platformWallet,
		dexRouter: raw.dexRouter,
		usdt: raw.usdt,
		authorizedRouter: raw.authorizedRouter,
		launchImplementation: raw.launchImplementation,
	};
}

export function toTradeRouterStateView(raw: TradeRouterStateRaw, usdtDecimals = 18): TradeRouterStateView {
	return {
		owner: raw.owner,
		feePct: bpsToPct(raw.feeBps),
		payoutTimeoutSec: Number(raw.payoutTimeout),
		platformWallet: raw.platformWallet,
		totalEscrow: ethers.formatUnits(raw.totalEscrow, usdtDecimals),
		pendingCount: Number(raw.pendingCount),
		totalWithdrawals: Number(raw.totalWithdrawals),
		paused: raw.paused,
		maxSlippagePct: bpsToPct(raw.maxSlippageBps),
		affiliateEnabled: raw.affiliateEnabled,
		affiliateSharePct: bpsToPct(raw.affiliateShareBps),
		minWithdrawUsdt: ethers.formatUnits(raw.minWithdrawUsdt, usdtDecimals),
		platformEarningsUsdt: ethers.formatUnits(raw.platformEarningsUsdt, usdtDecimals),
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
		creator: raw.creator,
		owner: raw.owner,
		isMintable: raw.isMintable,
		isTaxable: raw.isTaxable,
		isPartner: raw.isPartner,
	};
}

export function toLaunchInfoView(raw: LaunchInfoRaw, usdtDecimals = 18): LaunchInfoView {
	const td = Number(raw.tokenDecimals) || 18;
	const curve = Number(raw.curveType) as CurveType;
	const state = Number(raw.state) as LaunchState;
	return {
		launch: raw.launch,
		token: raw.token,
		tokenName: raw.tokenName,
		tokenSymbol: raw.tokenSymbol,
		tokenDecimals: td,
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
		tokensForLP: ethers.formatUnits(raw.tokensForLP, td),
		currentPrice: ethers.formatUnits(raw.currentPrice, usdtDecimals),
		totalPurchases: Number(raw.totalPurchases),
		totalBuyers: Number(raw.totalBuyers),
	};
}

export function toAdminLensResultView(raw: AdminLensResultRaw): AdminLensResultView {
	const usdtDec = raw.factory.usdtDecimals || 18;
	return {
		factory: toFactoryStateView(raw.factory),
		launchpad: toLaunchpadStateView(raw.launchpad, usdtDec),
		tradeRouter: toTradeRouterStateView(raw.tradeRouter, usdtDec),
		tokens: raw.tokens.map(toTokenInfoView),
		launches: raw.launches.map(l => toLaunchInfoView(l, usdtDec)),
	};
}
