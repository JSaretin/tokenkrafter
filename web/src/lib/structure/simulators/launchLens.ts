import { ethers } from 'ethers';
import { CurveType, curveLabel, LaunchState, launchStateLabel } from '../launchInstance';

/**
 * LaunchLens — constructor-only. Returns ALL launch detail + optional user
 * position in a single eth_call.
 *
 * Constructor args: (launch, user) — user == ZeroAddress to skip UserPosition.
 * Returns: (LaunchData, UserPosition) abi-encoded tuple.
 */

// ════════════════════════════════════════════════════════════════════════════
//  Raw types
// ════════════════════════════════════════════════════════════════════════════

export interface LaunchDataRaw {
	token: string;
	creator: string;
	curveType: number;
	state: number;
	effectiveState: number;
	softCap: bigint;
	hardCap: bigint;
	deadline: bigint;
	totalBaseRaised: bigint;
	tokensSold: bigint;
	tokensForCurve: bigint;
	tokensForLP: bigint;
	creatorAllocationBps: bigint;
	currentPrice: bigint;
	usdt: string;
	startTimestamp: bigint;
	totalTokensRequired: bigint;
	totalTokensDeposited: bigint;
	totalBuyers: bigint;
	totalPurchases: bigint;
	maxBuyPerWallet: bigint;
	vestingCliff: bigint;
	vestingDuration: bigint;
	lockDurationAfterListing: bigint;
	minBuyUsdt: bigint;
	softCapBps: bigint;
	hardCapBps: bigint;
	refundStartTimestamp: bigint;
	vestingTotal: bigint;
	vestingClaimed: bigint;
	vestingClaimable: bigint;
	vestingNextClaim: bigint;
	tokenName: string;
	tokenSymbol: string;
	tokenDecimals: number;
	tokenTotalSupply: bigint;
}

export interface UserPositionRaw {
	basePaid: bigint;
	tokensBought: bigint;
	tokenBalance: bigint;
}

export interface LaunchLensResultRaw {
	data: LaunchDataRaw;
	user: UserPositionRaw;
}

// ════════════════════════════════════════════════════════════════════════════
//  View types
// ════════════════════════════════════════════════════════════════════════════

export interface LaunchDataView {
	token: string;
	creator: string;
	curveType: CurveType;
	curveLabel: string;
	state: LaunchState;
	stateLabel: string;
	effectiveState: LaunchState;
	effectiveStateLabel: string;
	softCap: string;
	hardCap: string;
	deadline: Date;
	totalBaseRaised: string;
	tokensSold: string;
	tokensForCurve: string;
	tokensForLP: string;
	creatorAllocationPct: number;
	currentPrice: string;
	usdt: string;
	startTimestamp: Date | null;
	totalTokensRequired: string;
	totalTokensDeposited: string;
	totalBuyers: number;
	totalPurchases: number;
	maxBuyPerWallet: string;
	vestingCliffSec: number;
	vestingDurationSec: number;
	lockDurationAfterListingSec: number;
	minBuyUsdt: string;
	softCapPct: number;
	hardCapPct: number;
	refundStartTimestamp: Date | null;
	vestingTotal: string;
	vestingClaimed: string;
	vestingClaimable: string;
	vestingNextClaim: Date | null;
	tokenName: string;
	tokenSymbol: string;
	tokenDecimals: number;
	tokenTotalSupply: string;
}

export interface UserPositionView {
	basePaid: string;
	tokensBought: string;
	tokenBalance: string;
}

export interface LaunchLensResultView {
	data: LaunchDataView;
	user: UserPositionView;
}

// ════════════════════════════════════════════════════════════════════════════
//  Constructor params
// ════════════════════════════════════════════════════════════════════════════

export interface ConstructorParams { launch: string; user: string; }
export type ConstructorParamsRaw = ConstructorParams;

// ════════════════════════════════════════════════════════════════════════════
//  Converters
// ════════════════════════════════════════════════════════════════════════════

const bpsToPct = (b: bigint | number) => Number(b) / 100;
const tsToDate = (ts: bigint) => new Date(Number(ts) * 1000);
const tsToDateOrNull = (ts: bigint) => (ts === 0n ? null : tsToDate(ts));

export function toLaunchDataView(raw: LaunchDataRaw, usdtDecimals = 18): LaunchDataView {
	const td = Number(raw.tokenDecimals) || 18;
	const curve = Number(raw.curveType) as CurveType;
	const state = Number(raw.state) as LaunchState;
	const effState = Number(raw.effectiveState) as LaunchState;
	return {
		token: raw.token,
		creator: raw.creator,
		curveType: curve,
		curveLabel: curveLabel(curve),
		state,
		stateLabel: launchStateLabel(state),
		effectiveState: effState,
		effectiveStateLabel: launchStateLabel(effState),
		softCap: ethers.formatUnits(raw.softCap, usdtDecimals),
		hardCap: ethers.formatUnits(raw.hardCap, usdtDecimals),
		deadline: tsToDate(raw.deadline),
		totalBaseRaised: ethers.formatUnits(raw.totalBaseRaised, usdtDecimals),
		tokensSold: ethers.formatUnits(raw.tokensSold, td),
		tokensForCurve: ethers.formatUnits(raw.tokensForCurve, td),
		tokensForLP: ethers.formatUnits(raw.tokensForLP, td),
		creatorAllocationPct: bpsToPct(raw.creatorAllocationBps),
		currentPrice: ethers.formatUnits(raw.currentPrice, usdtDecimals),
		usdt: raw.usdt,
		startTimestamp: tsToDateOrNull(raw.startTimestamp),
		totalTokensRequired: ethers.formatUnits(raw.totalTokensRequired, td),
		totalTokensDeposited: ethers.formatUnits(raw.totalTokensDeposited, td),
		totalBuyers: Number(raw.totalBuyers),
		totalPurchases: Number(raw.totalPurchases),
		maxBuyPerWallet: ethers.formatUnits(raw.maxBuyPerWallet, usdtDecimals),
		vestingCliffSec: Number(raw.vestingCliff),
		vestingDurationSec: Number(raw.vestingDuration),
		lockDurationAfterListingSec: Number(raw.lockDurationAfterListing),
		minBuyUsdt: ethers.formatUnits(raw.minBuyUsdt, usdtDecimals),
		softCapPct: bpsToPct(raw.softCapBps),
		hardCapPct: bpsToPct(raw.hardCapBps),
		refundStartTimestamp: tsToDateOrNull(raw.refundStartTimestamp),
		vestingTotal: ethers.formatUnits(raw.vestingTotal, td),
		vestingClaimed: ethers.formatUnits(raw.vestingClaimed, td),
		vestingClaimable: ethers.formatUnits(raw.vestingClaimable, td),
		vestingNextClaim: tsToDateOrNull(raw.vestingNextClaim),
		tokenName: raw.tokenName,
		tokenSymbol: raw.tokenSymbol,
		tokenDecimals: td,
		tokenTotalSupply: ethers.formatUnits(raw.tokenTotalSupply, td),
	};
}

export function toUserPositionView(
	raw: UserPositionRaw,
	opts: { tokenDecimals?: number; usdtDecimals?: number } = {}
): UserPositionView {
	return {
		basePaid: ethers.formatUnits(raw.basePaid, opts.usdtDecimals ?? 18),
		tokensBought: ethers.formatUnits(raw.tokensBought, opts.tokenDecimals ?? 18),
		tokenBalance: ethers.formatUnits(raw.tokenBalance, opts.tokenDecimals ?? 18),
	};
}

export function toLaunchLensResultView(raw: LaunchLensResultRaw, usdtDecimals = 18): LaunchLensResultView {
	const data = toLaunchDataView(raw.data, usdtDecimals);
	return {
		data,
		user: toUserPositionView(raw.user, { tokenDecimals: data.tokenDecimals, usdtDecimals }),
	};
}
