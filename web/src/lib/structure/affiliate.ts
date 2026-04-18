import { ethers } from 'ethers';

// ════════════════════════════════════════════════════════════════════════════
//  Raw types
// ════════════════════════════════════════════════════════════════════════════

export interface AffiliateStatsRaw {
	pending: bigint;
	totalEarned: bigint;
	referredCount: number;      // uint32
	actionCount: number;        // uint32
	lastActionAt: bigint;       // uint64
}

/** getStats() return (tuple form with totalClaimed derived on-chain). */
export interface GetStatsRaw {
	pending: bigint;
	totalEarned: bigint;
	totalClaimed: bigint;
	referredCount: number;
	actionCount: number;
	lastActionAt: bigint;
}

// ════════════════════════════════════════════════════════════════════════════
//  View types
// ════════════════════════════════════════════════════════════════════════════

export interface AffiliateStatsView {
	pending: string;            // formatted USDT
	totalEarned: string;
	totalClaimed: string;
	referredCount: number;
	actionCount: number;
	lastActionAt: Date | null;  // null when 0 (never credited)
}

// ════════════════════════════════════════════════════════════════════════════
//  Write params
// ════════════════════════════════════════════════════════════════════════════

export interface RegisterReferrerParams { ref: string; }

export interface ReportParams {
	user: string;
	ref: string;
	platformFee: string;        // human-readable USDT
	usdtDecimals: number;
}
export interface ReportParamsRaw {
	user: string;
	ref: string;
	platformFee: bigint;
}

export interface SetAuthorizedParams { reporter: string; enabled: boolean; }
export interface SetAuthorizedFactoryParams { factory: string; enabled: boolean; }
export interface SetShareBpsParams { sharePct: number; }
export interface SetMinClaimParams { minClaim: string; usdtDecimals: number; }

export interface RescueParams {
	token: string;
	to: string;
	amount: string;
	tokenDecimals: number;
}
export interface RescueParamsRaw { token: string; to: string; amount: bigint; }

// ════════════════════════════════════════════════════════════════════════════
//  Events
// ════════════════════════════════════════════════════════════════════════════

export interface ReferrerSetEventRaw { user: string; referrer: string; }
export type ReferrerSetEventView = ReferrerSetEventRaw;

export interface ReportedEventRaw { user: string; referrer: string; platformFee: bigint; affiliateCut: bigint; }
export interface ReportedEventView { user: string; referrer: string; platformFee: string; affiliateCut: string; }

export interface ClaimedEventRaw { referrer: string; amount: bigint; }
export interface ClaimedEventView { referrer: string; amount: string; }

export interface AuthorizedReporterEventRaw { reporter: string; enabled: boolean; }
export type AuthorizedReporterEventView = AuthorizedReporterEventRaw;

export interface ShareUpdatedEventRaw { bps: bigint; }
export interface ShareUpdatedEventView { pct: number; }

export interface MinClaimUpdatedEventRaw { minClaim: bigint; }
export interface MinClaimUpdatedEventView { minClaim: string; }

export interface RescuedEventRaw { token: string; to: string; amount: bigint; }
export interface RescuedEventView { token: string; to: string; amount: string; }

// ════════════════════════════════════════════════════════════════════════════
//  Converters — writes
// ════════════════════════════════════════════════════════════════════════════

export function toReportParamsRaw(p: ReportParams): ReportParamsRaw {
	return {
		user: p.user,
		ref: p.ref,
		platformFee: ethers.parseUnits(p.platformFee || '0', p.usdtDecimals),
	};
}

export function toSetShareBpsRaw(p: SetShareBpsParams): bigint {
	return BigInt(Math.round(p.sharePct * 100));
}

export function toSetMinClaimRaw(p: SetMinClaimParams): bigint {
	return ethers.parseUnits(p.minClaim || '0', p.usdtDecimals);
}

export function toRescueParamsRaw(p: RescueParams): RescueParamsRaw {
	return { token: p.token, to: p.to, amount: ethers.parseUnits(p.amount || '0', p.tokenDecimals) };
}

// ════════════════════════════════════════════════════════════════════════════
//  Converters — reads
// ════════════════════════════════════════════════════════════════════════════

export function toAffiliateStatsView(raw: GetStatsRaw, usdtDecimals = 18): AffiliateStatsView {
	return {
		pending: ethers.formatUnits(raw.pending, usdtDecimals),
		totalEarned: ethers.formatUnits(raw.totalEarned, usdtDecimals),
		totalClaimed: ethers.formatUnits(raw.totalClaimed, usdtDecimals),
		referredCount: Number(raw.referredCount),
		actionCount: Number(raw.actionCount),
		lastActionAt: raw.lastActionAt === 0n ? null : new Date(Number(raw.lastActionAt) * 1000),
	};
}

// ════════════════════════════════════════════════════════════════════════════
//  Converters — events
// ════════════════════════════════════════════════════════════════════════════

export function toReportedEventView(raw: ReportedEventRaw, usdtDecimals = 18): ReportedEventView {
	return {
		user: raw.user,
		referrer: raw.referrer,
		platformFee: ethers.formatUnits(raw.platformFee, usdtDecimals),
		affiliateCut: ethers.formatUnits(raw.affiliateCut, usdtDecimals),
	};
}

export function toClaimedEventView(raw: ClaimedEventRaw, usdtDecimals = 18): ClaimedEventView {
	return { referrer: raw.referrer, amount: ethers.formatUnits(raw.amount, usdtDecimals) };
}

export function toShareUpdatedEventView(raw: ShareUpdatedEventRaw): ShareUpdatedEventView {
	return { pct: Number(raw.bps) / 100 };
}

export function toMinClaimUpdatedEventView(raw: MinClaimUpdatedEventRaw, usdtDecimals = 18): MinClaimUpdatedEventView {
	return { minClaim: ethers.formatUnits(raw.minClaim, usdtDecimals) };
}

export function toRescuedEventView(raw: RescuedEventRaw, tokenDecimals = 18): RescuedEventView {
	return { token: raw.token, to: raw.to, amount: ethers.formatUnits(raw.amount, tokenDecimals) };
}

// ════════════════════════════════════════════════════════════════════════════
//  Event signatures
// ════════════════════════════════════════════════════════════════════════════

export const AFFILIATE_EVENT_SIGNATURES = {
	ReferrerSet: 'ReferrerSet(address,address)',
	Reported: 'Reported(address,address,uint256,uint256)',
	Claimed: 'Claimed(address,uint256)',
	AuthorizedReporter: 'AuthorizedReporter(address,bool)',
	ShareUpdated: 'ShareUpdated(uint256)',
	MinClaimUpdated: 'MinClaimUpdated(uint256)',
	Rescued: 'Rescued(address,address,uint256)',
} as const;

export const AFFILIATE_ERRORS = [
	'NotAuthorized', 'SelfReferral', 'InvalidShare', 'BelowMinClaim',
	'NothingToClaim', 'ZeroReferrer', 'WouldUnderpayAffiliates', 'ZeroAddress',
] as const;
