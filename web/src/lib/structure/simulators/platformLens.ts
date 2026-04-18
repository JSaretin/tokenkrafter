import { ethers } from 'ethers';
import type { DayStatsRaw, DayStatsView } from '../tokenFactory';
import { toDayStatsView } from '../tokenFactory';

/**
 * PlatformLens — deployed simulator with explicit view methods (not constructor-only).
 * Aggregates read paths across TokenFactory + LaunchpadFactory.
 */

// ════════════════════════════════════════════════════════════════════════════
//  Raw / View
// ════════════════════════════════════════════════════════════════════════════

export interface LaunchDayStatsRaw {
	created: bigint;
	graduated: bigint;
	totalFeeUsdt: bigint;
}
export interface LaunchDayStatsView {
	created: number;
	graduated: number;
	totalFeeUsdt: string;
}

export interface TokenStatsRaw { total: bigint; byType: bigint[]; /* length 8 */ }
export interface TokenStatsView { total: number; byType: number[]; }

export interface CreationFeeQuoteRaw { tokens: string[]; fees: bigint[]; }
export interface CreationFeeQuoteView { tokens: string[]; fees: string[]; /* each in its own token's decimals — caller supplies */ }

export interface ActiveLaunchesPageRaw { result: string[]; total: bigint; }
export interface ActiveLaunchesPageView { result: string[]; total: number; }

export interface ReferralStatsMultiRaw {
	referred: bigint;
	earned: bigint[];
	pending: bigint[];
}
export interface ReferralStatsMultiView {
	referred: number;
	earned: string[];
	pending: string[];
}

export interface PlatformStatsRaw {
	totalTokens: bigint;
	totalLaunches: bigint;
	totalTokenFeeUsdt: bigint;
	totalLaunchFeeUsdt: bigint;
}
export interface PlatformStatsView {
	totalTokens: number;
	totalLaunches: number;
	totalTokenFeeUsdt: string;
	totalLaunchFeeUsdt: string;
}

// ════════════════════════════════════════════════════════════════════════════
//  Write params (view calls)
// ════════════════════════════════════════════════════════════════════════════

export interface GetCreationFeeParams {
	isTaxable: boolean;
	isMintable: boolean;
	isPartner: boolean;
}

export interface GetActiveLaunchesParams {
	offset: number;
	limit: number;
}

export interface DayRangeParams { fromDay: number; toDay: number; }

export interface GetReferralStatsParams {
	referrer: string;
	paymentTokens: string[];
}

// ════════════════════════════════════════════════════════════════════════════
//  Converters
// ════════════════════════════════════════════════════════════════════════════

export function toTokenStatsView(raw: TokenStatsRaw): TokenStatsView {
	return {
		total: Number(raw.total),
		byType: raw.byType.map(b => Number(b)),
	};
}

export function toLaunchDayStatsView(raw: LaunchDayStatsRaw, usdtDecimals = 18): LaunchDayStatsView {
	return {
		created: Number(raw.created),
		graduated: Number(raw.graduated),
		totalFeeUsdt: ethers.formatUnits(raw.totalFeeUsdt, usdtDecimals),
	};
}

export function toCreationFeeQuoteView(
	raw: CreationFeeQuoteRaw,
	decimalsPerToken: number[]
): CreationFeeQuoteView {
	return {
		tokens: raw.tokens,
		fees: raw.fees.map((f, i) => ethers.formatUnits(f, decimalsPerToken[i] ?? 18)),
	};
}

export function toActiveLaunchesPageView(raw: ActiveLaunchesPageRaw): ActiveLaunchesPageView {
	return { result: raw.result, total: Number(raw.total) };
}

export function toReferralStatsMultiView(
	raw: ReferralStatsMultiRaw,
	decimalsPerToken: number[]
): ReferralStatsMultiView {
	return {
		referred: Number(raw.referred),
		earned: raw.earned.map((e, i) => ethers.formatUnits(e, decimalsPerToken[i] ?? 18)),
		pending: raw.pending.map((p, i) => ethers.formatUnits(p, decimalsPerToken[i] ?? 18)),
	};
}

export function toPlatformStatsView(raw: PlatformStatsRaw, usdtDecimals = 18): PlatformStatsView {
	return {
		totalTokens: Number(raw.totalTokens),
		totalLaunches: Number(raw.totalLaunches),
		totalTokenFeeUsdt: ethers.formatUnits(raw.totalTokenFeeUsdt, usdtDecimals),
		totalLaunchFeeUsdt: ethers.formatUnits(raw.totalLaunchFeeUsdt, usdtDecimals),
	};
}

export { toDayStatsView, type DayStatsRaw, type DayStatsView };
