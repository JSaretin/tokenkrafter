import { ethers } from 'ethers';
import { CurveType, curveLabel, LaunchState } from './launchInstance';

// ════════════════════════════════════════════════════════════════════════════
//  Raw types
// ════════════════════════════════════════════════════════════════════════════

export interface CurveDefaultsRaw {
	linearSlope: bigint;
	linearIntercept: bigint;
	sqrtCoefficient: bigint;
	quadraticCoefficient: bigint;
	expBase: bigint;
	expKFactor: bigint;
}

export interface LaunchDayStatsRaw {
	created: bigint;
	graduated: bigint;
	totalFeeUsdt: bigint;
}

export interface FactoryStateRaw {
	factoryOwner: string;
	totalLaunchCount: bigint;
	totalFeeUsdt: bigint;
	fee: bigint;
}

export interface LaunchesPageRaw { r: string[]; total: bigint; }

// ════════════════════════════════════════════════════════════════════════════
//  View types
// ════════════════════════════════════════════════════════════════════════════

/** Curve defaults are raw 18-decimal curve-math units — rendered as strings. */
export interface CurveDefaultsView {
	linearSlope: string;
	linearIntercept: string;
	sqrtCoefficient: string;
	quadraticCoefficient: string;
	expBase: string;
	expKFactor: string;
}

export interface LaunchDayStatsView {
	created: number;
	graduated: number;
	totalFeeUsdt: string;
}

export interface FactoryStateView {
	factoryOwner: string;
	totalLaunchCount: number;
	totalFeeUsdt: string;       // formatted USDT
	launchFee: string;          // formatted USDT
}

export interface LaunchesPageView { launches: string[]; total: number; }

// ════════════════════════════════════════════════════════════════════════════
//  Write params
// ════════════════════════════════════════════════════════════════════════════

export interface CreateLaunchParams {
	token: string;
	totalTokens: string;
	curveType: CurveType;
	softCap: string;
	hardCap: string;
	durationDays: number;
	maxBuyBps: number;
	creatorAllocationBps: number;
	vestingDays: number;
	startTimestamp: number;
	lockDurationAfterListing: number;
	minBuyUsdt: string;
	tokenDecimals: number;
	usdtDecimals: number;
}
export interface CreateLaunchParamsRaw {
	token: string;
	totalTokens: bigint;
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

export interface CreateLaunchCustomCurveParams extends CreateLaunchParams {
	curveParam1: string;        // 18-decimal virtual curve units
	curveParam2: string;
}
export interface CreateLaunchCustomCurveParamsRaw extends CreateLaunchParamsRaw {
	curveParam1: bigint;
	curveParam2: bigint;
}

export interface RouterCreateLaunchParams extends CreateLaunchParams { creator: string; }
export interface RouterCreateLaunchParamsRaw extends CreateLaunchParamsRaw { creator: string; }

export interface NotifyDepositParams { launch: string; amount: string; tokenDecimals: number; }

export interface SetCurveDefaultsParams {
	linearSlope: string;
	linearIntercept: string;
	sqrtCoefficient: string;
	quadraticCoefficient: string;
	expBase: string;
	expKFactor: string;
}
export type SetCurveDefaultsParamsRaw = CurveDefaultsRaw;

export interface SetLaunchFeeParams { launchFee: string; usdtDecimals: number; }

// ════════════════════════════════════════════════════════════════════════════
//  Events
// ════════════════════════════════════════════════════════════════════════════

export interface LaunchCreatedEventRaw {
	launch: string;
	token: string;
	creator: string;
	curveType: bigint;
	softCap: bigint;
	hardCap: bigint;
	totalTokens: bigint;
	param1: bigint;
	param2: bigint;
	durationDays: bigint;
	maxBuyBps: bigint;
	creatorAllocationBps: bigint;
	vestingDays: bigint;
	minBuyUsdt: bigint;
}
export interface LaunchCreatedEventView {
	launch: string;
	token: string;
	creator: string;
	curveType: CurveType;
	curveLabel: string;
	softCap: string;
	hardCap: string;
	totalTokens: string;
	param1: string;
	param2: string;
	durationDays: number;
	maxBuyBps: number;
	creatorAllocationBps: number;
	vestingDays: number;
	minBuyUsdt: string;
}

export interface PlatformWalletUpdatedEventRaw { newWallet: string; }
export type PlatformWalletUpdatedEventView = PlatformWalletUpdatedEventRaw;

export interface DexRouterUpdatedEventRaw { newRouter: string; }
export type DexRouterUpdatedEventView = DexRouterUpdatedEventRaw;

export interface CurveDefaultsUpdatedEventRaw {}
export type CurveDefaultsUpdatedEventView = CurveDefaultsUpdatedEventRaw;

export interface LaunchFeeUpdatedEventRaw { newFee: bigint; }
export interface LaunchFeeUpdatedEventView { newFee: string; }

/** `payer` is the attributed creator; `source` is the actual `msg.sender` that the
 *  USDT was pulled from (router on routerCreateLaunch, creator on direct calls). */
export interface LaunchFeePaidEventRaw { payer: string; source: string; amount: bigint; }
export interface LaunchFeePaidEventView { payer: string; source: string; amount: string; }

export interface AuthorizedRouterUpdatedEventRaw { newRouter: string; }
export type AuthorizedRouterUpdatedEventView = AuthorizedRouterUpdatedEventRaw;

export interface AffiliateUpdatedEventRaw { previous: string; current: string; }
export type AffiliateUpdatedEventView = AffiliateUpdatedEventRaw;

export interface GlobalPauseChangedEventRaw { paused: boolean; }
export type GlobalPauseChangedEventView = GlobalPauseChangedEventRaw;

export interface LaunchPausedEventRaw { launch: string; paused: boolean; }
export type LaunchPausedEventView = LaunchPausedEventRaw;

export interface LaunchesPausedEventRaw { fromIndex: bigint; toIndex: bigint; paused: boolean; }
export interface LaunchesPausedEventView { fromIndex: number; toIndex: number; paused: boolean; }

// ════════════════════════════════════════════════════════════════════════════
//  Converters — writes
// ════════════════════════════════════════════════════════════════════════════

function toBaseCreateLaunchRaw(p: CreateLaunchParams) {
	return {
		token: p.token,
		totalTokens: ethers.parseUnits(p.totalTokens || '0', p.tokenDecimals),
		curveType: Number(p.curveType),
		softCap: ethers.parseUnits(p.softCap || '0', p.usdtDecimals),
		hardCap: ethers.parseUnits(p.hardCap || '0', p.usdtDecimals),
		durationDays: BigInt(p.durationDays),
		maxBuyBps: BigInt(p.maxBuyBps),
		creatorAllocationBps: BigInt(p.creatorAllocationBps),
		vestingDays: BigInt(p.vestingDays),
		startTimestamp: BigInt(p.startTimestamp),
		lockDurationAfterListing: BigInt(p.lockDurationAfterListing),
		minBuyUsdt: ethers.parseUnits(p.minBuyUsdt || '0', p.usdtDecimals),
	};
}

export function toCreateLaunchRaw(p: CreateLaunchParams): CreateLaunchParamsRaw {
	return toBaseCreateLaunchRaw(p);
}

export function toCreateLaunchCustomCurveRaw(p: CreateLaunchCustomCurveParams): CreateLaunchCustomCurveParamsRaw {
	return {
		...toBaseCreateLaunchRaw(p),
		curveParam1: ethers.parseUnits(p.curveParam1 || '0', 18),
		curveParam2: ethers.parseUnits(p.curveParam2 || '0', 18),
	};
}

export function toRouterCreateLaunchRaw(p: RouterCreateLaunchParams): RouterCreateLaunchParamsRaw {
	return { creator: p.creator, ...toBaseCreateLaunchRaw(p) };
}

export function toNotifyDepositRaw(p: NotifyDepositParams): { launch: string; amount: bigint } {
	return { launch: p.launch, amount: ethers.parseUnits(p.amount || '0', p.tokenDecimals) };
}

export function toSetCurveDefaultsRaw(p: SetCurveDefaultsParams): SetCurveDefaultsParamsRaw {
	return {
		linearSlope: ethers.parseUnits(p.linearSlope || '0', 18),
		linearIntercept: ethers.parseUnits(p.linearIntercept || '0', 18),
		sqrtCoefficient: ethers.parseUnits(p.sqrtCoefficient || '0', 18),
		quadraticCoefficient: ethers.parseUnits(p.quadraticCoefficient || '0', 18),
		expBase: ethers.parseUnits(p.expBase || '0', 18),
		expKFactor: ethers.parseUnits(p.expKFactor || '0', 18),
	};
}

export function toSetLaunchFeeRaw(p: SetLaunchFeeParams): bigint {
	return ethers.parseUnits(p.launchFee || '0', p.usdtDecimals);
}

// ════════════════════════════════════════════════════════════════════════════
//  Converters — reads
// ════════════════════════════════════════════════════════════════════════════

export function toCurveDefaultsView(raw: CurveDefaultsRaw): CurveDefaultsView {
	return {
		linearSlope: ethers.formatUnits(raw.linearSlope, 18),
		linearIntercept: ethers.formatUnits(raw.linearIntercept, 18),
		sqrtCoefficient: ethers.formatUnits(raw.sqrtCoefficient, 18),
		quadraticCoefficient: ethers.formatUnits(raw.quadraticCoefficient, 18),
		expBase: ethers.formatUnits(raw.expBase, 18),
		expKFactor: ethers.formatUnits(raw.expKFactor, 18),
	};
}

export function toLaunchDayStatsView(raw: LaunchDayStatsRaw, usdtDecimals = 18): LaunchDayStatsView {
	return {
		created: Number(raw.created),
		graduated: Number(raw.graduated),
		totalFeeUsdt: ethers.formatUnits(raw.totalFeeUsdt, usdtDecimals),
	};
}

export function toFactoryStateView(raw: FactoryStateRaw, usdtDecimals = 18): FactoryStateView {
	return {
		factoryOwner: raw.factoryOwner,
		totalLaunchCount: Number(raw.totalLaunchCount),
		totalFeeUsdt: ethers.formatUnits(raw.totalFeeUsdt, usdtDecimals),
		launchFee: ethers.formatUnits(raw.fee, usdtDecimals),
	};
}

export function toLaunchesPageView(raw: LaunchesPageRaw): LaunchesPageView {
	return { launches: raw.r, total: Number(raw.total) };
}

// ════════════════════════════════════════════════════════════════════════════
//  Converters — events
// ════════════════════════════════════════════════════════════════════════════

export interface LaunchCreatedEventOpts { tokenDecimals?: number; usdtDecimals?: number; }

export function toLaunchCreatedEventView(
	raw: LaunchCreatedEventRaw,
	opts: LaunchCreatedEventOpts = {}
): LaunchCreatedEventView {
	const td = opts.tokenDecimals ?? 18;
	const ud = opts.usdtDecimals ?? 18;
	const curve = Number(raw.curveType) as CurveType;
	return {
		launch: raw.launch,
		token: raw.token,
		creator: raw.creator,
		curveType: curve,
		curveLabel: curveLabel(curve),
		softCap: ethers.formatUnits(raw.softCap, ud),
		hardCap: ethers.formatUnits(raw.hardCap, ud),
		totalTokens: ethers.formatUnits(raw.totalTokens, td),
		param1: ethers.formatUnits(raw.param1, 18),
		param2: ethers.formatUnits(raw.param2, 18),
		durationDays: Number(raw.durationDays),
		maxBuyBps: Number(raw.maxBuyBps),
		creatorAllocationBps: Number(raw.creatorAllocationBps),
		vestingDays: Number(raw.vestingDays),
		minBuyUsdt: ethers.formatUnits(raw.minBuyUsdt, ud),
	};
}

export function toLaunchFeeUpdatedEventView(raw: LaunchFeeUpdatedEventRaw, usdtDecimals = 18): LaunchFeeUpdatedEventView {
	return { newFee: ethers.formatUnits(raw.newFee, usdtDecimals) };
}

export function toLaunchFeePaidEventView(raw: LaunchFeePaidEventRaw, usdtDecimals = 18): LaunchFeePaidEventView {
	return { payer: raw.payer, source: raw.source, amount: ethers.formatUnits(raw.amount, usdtDecimals) };
}

export function toLaunchesPausedEventView(raw: LaunchesPausedEventRaw): LaunchesPausedEventView {
	return { fromIndex: Number(raw.fromIndex), toIndex: Number(raw.toIndex), paused: raw.paused };
}

// ════════════════════════════════════════════════════════════════════════════
//  Event signatures + errors + re-exports
// ════════════════════════════════════════════════════════════════════════════

export const LAUNCHPAD_FACTORY_EVENT_SIGNATURES = {
	LaunchCreated: 'LaunchCreated(address,address,address,uint8,uint256,uint256,uint256,uint256,uint256)',
	PlatformWalletUpdated: 'PlatformWalletUpdated(address)',
	DexRouterUpdated: 'DexRouterUpdated(address)',
	CurveDefaultsUpdated: 'CurveDefaultsUpdated()',
	LaunchFeeUpdated: 'LaunchFeeUpdated(uint256)',
	LaunchFeePaid: 'LaunchFeePaid(address,uint256)',
	AuthorizedRouterUpdated: 'AuthorizedRouterUpdated(address)',
	AffiliateUpdated: 'AffiliateUpdated(address,address)',
	GlobalPauseChanged: 'GlobalPauseChanged(bool)',
	LaunchPaused: 'LaunchPaused(address,bool)',
	LaunchesPaused: 'LaunchesPaused(uint256,uint256,bool)',
} as const;

export const LAUNCHPAD_FACTORY_ERRORS = [
	'InvalidAddress', 'InvalidToken', 'InvalidUsdt', 'InvalidCurveParam',
	'InvalidRange', 'ZeroTokens', 'MaxDaysExceeded', 'NotLaunchCreator',
	'NotRegisteredLaunch', 'NotGraduated', 'NotRefunding', 'TokenAlreadyHasLaunch',
	'WithdrawFailed', 'NoBalance', 'OnlyLaunch', 'OnlyAuthorizedRouter',
] as const;

export { CurveType, LaunchState };
