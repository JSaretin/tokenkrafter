/**
 * Minimum surface revenue contracts need to integrate with the shared
 * Affiliate program. See /affiliate.ts for the full contract surface.
 */

export interface IAffiliateReportParams {
	user: string;
	ref: string;
	platformFee: bigint;
}

export interface IAffiliateSetAuthorizedParams {
	reporter: string;
	enabled: boolean;
}

export const I_AFFILIATE_METHODS = ['report', 'setAuthorized'] as const;
